use std::cmp::Ordering;
use std::collections::BTreeMap;
use std::fmt;
use std::fs::File;
use std::io::{BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::sync::{Arc, Mutex};

use tempfile::tempfile;
use sha2::{Digest, Sha256};

use crate::error::AppError;
use crate::models::graph_new_data::{
    GRAPH_NEW_DEFAULT_CONSTRUCTION_MEMORY_LIMIT_BYTES, GRAPH_NEW_MAX_LEVELS,
    GRAPH_NEW_MAX_TILE_POINTS,
};
use crate::services::graph_new_key::{RetentionPolicy, GRAPH_NEW_TILE_FORMAT_VERSION};
use crate::services::graph_new_overlay::{OverlayCatalog, ALL_ROWS_GROUP_CODE};
use super::graph_new_raw::{RawStore, RawWriter, QueryWork, QUERY_SCRATCH_BYTES};
use crate::services::graph_new_tile::{minimum_encoded_tile_bytes, GraphNewTile, GraphNewTileHeader};

const CAMERA_MAX_VIEWPORT_DIMENSION: u32 = 16_384;
const CAMERA_MAX_DEVICE_PIXEL_RATIO: f64 = 8.0;
const LEVEL_ENTRY_BYTES_ESTIMATE: u64 = 128;
const FINE_TILE_ENTRY_BYTES_ESTIMATE: u64 = 96;
const OUTPUT_TILE_ENTRY_BYTES_ESTIMATE: u64 = 128;
const TILE_INDEX_ENTRY_BYTES_ESTIMATE: u64 = 128;
const TILE_LEVEL_BYTES_ESTIMATE: u64 = 64;
const TILE_ENCODE_FIXED_BYTES_ESTIMATE: u64 = 128;
const SPOOL_WRITE_BUFFER_BYTES: usize = 64 * 1024;
const SPOOL_READ_BUFFER_BYTES: usize = 8 * 1024;
const CONTROL_CHECK_BATCH_POINTS: usize = 4_096;
const DECODED_CACHE_BYTES: u64 = 8 * 1024 * 1024;
const PYRAMID_MAGIC: &[u8; 8] = b"GNPC0004";
const LOSSLESS_PYRAMID_MAGIC: &[u8; 8] = b"GNPL0003";

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SourcePoint {
    pub row_id: i64,
    pub x: f64,
    pub y: f64,
    pub group_code: u16,
}

impl SourcePoint {
    pub fn new(row_id: i64, x: f64, y: f64) -> Self {
        Self::with_group(row_id, x, y, ALL_ROWS_GROUP_CODE)
    }

    pub fn with_group(row_id: i64, x: f64, y: f64, group_code: u16) -> Self {
        Self {
            row_id,
            x,
            y,
            group_code,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GraphCamera {
    pub x_min: f64,
    pub x_max: f64,
    pub y_min: f64,
    pub y_max: f64,
    pub viewport_width: u32,
    pub viewport_height: u32,
    pub device_pixel_ratio: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GraphDomain {
    pub x_min: f64,
    pub x_max: f64,
    pub y_min: f64,
    pub y_max: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct TileAddress {
    pub level: u8,
    pub tile_x: u32,
    pub tile_y: u32,
}

#[derive(Debug, Clone)]
pub struct TileEntry {
    pub address: TileAddress,
    pub representative_row_ids: Vec<i64>,
    pub total_source_count: u64,
    pub retained_mark_count: u32,
    pub x_min: f64,
    pub x_max: f64,
    pub y_min: f64,
    pub y_max: f64,
}

#[derive(Debug, Clone)]
pub struct SelectedTile {
    pub entry: TileEntry,
    pub tile: GraphNewTile,
}

#[derive(Debug, Clone)]
pub struct TileLevel {
    pub level: u8,
    pub tiles: Vec<TileEntry>,
    pub tile_bytes: u64,
    pub retained_marks: u64,
    pub total_source_count: u64,
}

#[derive(Debug, Clone)]
pub struct TileSelection {
    pub exact: bool,
    pub visible_rows: Option<u64>,
    pub query_work: QueryWork,
    pub level: u8,
    pub selected_mark_count: usize,
    pub total_source_count: u64,
    pub visible_tiles: usize,
    pub tiles: Vec<SelectedTile>,
}

#[derive(Clone)]
pub struct TilePyramid {
    pub x_axis: crate::models::graph_new::GraphNewAxisData,
    pub overlay: OverlayCatalog,
    pub domain: GraphDomain,
    pub levels: Vec<TileLevel>,
    pub total_processed_rows: u64,
    pub total_finite_rows: u64,
    pub total_excluded_non_finite_rows: u64,
    pub max_tile_points: u32,
    pub overdraw_factor: f64,
    pub spool_bytes: u64,
    pub accounted_memory_bytes: u64,
    pub raw_store: Option<Arc<RawStore>>,
    tile_store: Arc<TileStore>,
}

impl fmt::Debug for TilePyramid {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TilePyramid")
            .field("domain", &self.domain)
            .field("levels", &self.levels)
            .field("total_processed_rows", &self.total_processed_rows)
            .field("total_finite_rows", &self.total_finite_rows)
            .field(
                "total_excluded_non_finite_rows",
                &self.total_excluded_non_finite_rows,
            )
            .field("max_tile_points", &self.max_tile_points)
            .field("overdraw_factor", &self.overdraw_factor)
            .field("spool_bytes", &self.spool_bytes)
            .field("accounted_memory_bytes", &self.accounted_memory_bytes)
            .finish()
    }
}

impl TilePyramid {
    pub fn cache_reservation_bytes(&self) -> u64 {
        self.resident_bytes() - self.mean_bytes() - self.raw_line_bytes() + self.tile_store.decoded_limit()
            + if self.is_compact_exact() { self.total_finite_rows * 100 + 4096 } else { 0 }
            + if self.raw_store.is_some() { QUERY_SCRATCH_BYTES } else { 0 }
    }

    pub(crate) fn mean_available(&self) -> bool {
        self.total_finite_rows == 0 || self.is_compact_exact()
    }

    fn mean_bytes(&self) -> u64 {
        self.tile_store.mean.lock().map_or(0, |mean|
            mean.as_ref().map_or(0, |points| points.capacity() as u64 * 16))
    }

    fn raw_line_bytes(&self) -> u64 {
        self.tile_store.raw_line.lock().map_or(0, |indices| indices.as_ref().map_or(0, |indices| indices.capacity() as u64 * 8))
    }

    pub(crate) fn raw_line(&self, points: &[SourcePoint], control: &dyn Fn() -> Result<(), AppError>) -> Result<Option<Arc<Vec<[u32; 2]>>>, AppError> {
        if !self.mean_available() { return Ok(None); }
        let mut cached = self.tile_store.raw_line.lock().map_err(|_| cache_format_error())?;
        if cached.is_none() { *cached = Some(Arc::new(super::graph_new_service::raw_line_indices(points, control)?)); }
        Ok(cached.clone())
    }

    pub(crate) fn mean_line(&self, control: &dyn Fn() -> Result<(), AppError>) -> Result<Option<Arc<Vec<[f64; 2]>>>, AppError> {
        if !self.mean_available() { return Ok(None); }
        let mut cached = self.tile_store.mean.lock().map_err(|_| cache_format_error())?;
        if let Some(mean) = cached.as_ref() { return Ok(Some(mean.clone())); }
        control()?;
        let mut points = Vec::with_capacity(self.total_finite_rows as usize);
        if let Some(level) = self.levels.first() {
            for entry in &level.tiles {
                let tile = self.tile_store.decode(&entry.address)?;
                for (position, (&x, &y)) in tile.xs.iter().zip(&tile.ys).enumerate() {
                    if position % CONTROL_CHECK_BATCH_POINTS == 0 { control()?; }
                    points.push([if x == 0.0 { 0.0 } else { x }, y]);
                }
            }
        }
        points.sort_unstable_by(|left, right| left[0].total_cmp(&right[0]));
        control()?;
        let mut start = 0;
        let mut groups = 0;
        while start < points.len() {
            control()?;
            let mut end = start + 1;
            while end < points.len() && points[end][0] == points[start][0] { end += 1; }
            let mean = finite_group_mean(&points[start..end], control)?;
            points[groups] = [points[start][0], mean];
            groups += 1;
            start = end;
        }
        points.truncate(groups);
        control()?;
        let mean = Arc::new(points);
        *cached = Some(mean.clone());
        Ok(Some(mean))
    }

    fn is_compact_exact(&self) -> bool {
        self.raw_store.is_none() && self.levels.len() == 1 && self.levels[0].level == 0
            && self.levels[0].retained_marks == self.total_finite_rows
            && self.total_finite_rows <= super::graph_new_renderer::MAX_SCENE_POINTS as u64
    }

    pub fn decoded_bytes(&self) -> u64 {
        self.tile_store.decoded.lock().map_or(DECODED_CACHE_BYTES, |cache| cache.bytes)
    }

    pub fn encoded_bytes(&self) -> u64 {
        self.levels.iter().map(|level| level.tile_bytes).sum::<u64>() + self.raw_store.as_ref().map_or(0, |raw| raw.disk_bytes())
    }

    pub fn persisted_bytes(&self) -> u64 {
        let axis_bytes = serde_json::to_vec(&self.x_axis).map_or(0, |bytes| bytes.len() as u64);
        let overlay_bytes = if self.raw_store.is_some() {
            0
        } else {
            serde_json::to_vec(&self.overlay).map_or(0, |bytes| bytes.len() as u64)
        };
        let header_bytes = if self.raw_store.is_some() { 200 } else { 208 };
        header_bytes + axis_bytes + overlay_bytes + self.tile_store.index.len() as u64 * 8
            + self.levels.iter().map(|level| level.tile_bytes).sum::<u64>()
            + self.raw_store.as_ref().map_or(0, |raw| raw.persisted_bytes())
    }

    pub fn resident_bytes(&self) -> u64 {
        std::mem::size_of::<Self>() as u64
            + self.x_axis.categories.capacity() as u64 * 24 + self.x_axis.categories.iter().map(|label| label.capacity() as u64).sum::<u64>()
            + self.overlay.resident_bytes()
            + self.mean_bytes()
            + self.raw_line_bytes()
            + self.raw_store.as_ref().map_or(0, |raw| raw.resident_bytes())
            + self.levels.capacity() as u64 * std::mem::size_of::<TileLevel>() as u64
            + self.levels.iter().map(|level| level.tiles.capacity() as u64 * std::mem::size_of::<TileEntry>() as u64
                + level.tiles.iter().map(|tile| tile.representative_row_ids.capacity() as u64 * 8
                    + 512).sum::<u64>()).sum::<u64>()
    }

    pub fn write_cache(&self, file: &mut File, key: &str) -> Result<(), AppError> {
        if key.len() != 64 || !key.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(cache_format_error());
        }
        file.seek(SeekFrom::Start(0))?;
        file.write_all(if self.raw_store.is_some() { LOSSLESS_PYRAMID_MAGIC } else { PYRAMID_MAGIC })?;
        file.write_all(key.as_bytes())?;
        for value in [self.domain.x_min.to_bits(), self.domain.x_max.to_bits(),
            self.domain.y_min.to_bits(), self.domain.y_max.to_bits(), self.total_processed_rows,
            self.total_finite_rows, self.total_excluded_non_finite_rows, u64::from(self.max_tile_points),
            self.overdraw_factor.to_bits(), self.levels.len() as u64, self.tile_store.index.len() as u64] {
            file.write_all(&value.to_le_bytes())?;
        }
        let mut source = self.tile_store.file.lock().map_err(|_| cache_format_error())?;
        let axis = serde_json::to_vec(&self.x_axis).map_err(|_| cache_format_error())?;
        file.write_all(&(axis.len() as u64).to_le_bytes())?;
        file.write_all(&axis)?;
        if self.raw_store.is_none() {
            let overlay = serde_json::to_vec(&self.overlay).map_err(|_| cache_format_error())?;
            file.write_all(&(overlay.len() as u64).to_le_bytes())?;
            file.write_all(&overlay)?;
        }
        for stored in self.tile_store.index.values() {
            file.write_all(&stored.encoded_bytes.to_le_bytes())?;
            source.seek(SeekFrom::Start(stored.offset))?;
            if std::io::copy(&mut (&mut *source).take(stored.encoded_bytes), file)? != stored.encoded_bytes {
                return Err(cache_format_error());
            }
        }
        drop(source);
        if let Some(raw) = &self.raw_store { raw.write_cache(file)?; }
        let length = file.stream_position()?;
        let checksum = cache_checksum(file, length)?;
        file.seek(SeekFrom::Start(length))?;
        file.write_all(&checksum)?;
        file.flush()?;
        Ok(())
    }

    pub fn read_cache(file: File, key: &str, memory_limit: u64, disk_limit: u64) -> Result<Self, AppError> {
        Self::read_cache_with_policy(file, key, memory_limit, disk_limit, RetentionPolicy::Bounded)
    }

    pub(crate) fn read_cache_with_policy(mut file: File, key: &str, memory_limit: u64, disk_limit: u64, policy: RetentionPolicy) -> Result<Self, AppError> {
        let length = file.metadata()?.len();
        let minimum_length = match policy {
            RetentionPolicy::Bounded => 200,
            RetentionPolicy::Lossless => 192,
        };
        if length < minimum_length || length > disk_limit { return Err(cache_format_error()); }
        let checksum = cache_checksum(&mut file, length - 32)?;
        let mut expected = [0; 32]; file.read_exact(&mut expected)?;
        if checksum != expected { return Err(cache_format_error()); }
        file.seek(SeekFrom::Start(0))?;
        let mut magic = [0; 8]; file.read_exact(&mut magic)?;
        let mut stored_key = [0; 64]; file.read_exact(&mut stored_key)?;
        let expected_magic = match policy { RetentionPolicy::Bounded => PYRAMID_MAGIC, RetentionPolicy::Lossless => LOSSLESS_PYRAMID_MAGIC };
        if policy == RetentionPolicy::Bounded && &magic == b"GNPC0003" {
            return Err(AppError::Stats("graph_new_overlay_cache_incompatible".into()));
        }
        if &magic != expected_magic || stored_key.as_slice() != key.as_bytes() { return Err(cache_format_error()); }
        let mut values = [0u64; 11];
        for value in &mut values { *value = read_cache_u64(&mut file)?; }
        let domain = GraphDomain { x_min: f64::from_bits(values[0]), x_max: f64::from_bits(values[1]),
            y_min: f64::from_bits(values[2]), y_max: f64::from_bits(values[3]) };
        let overdraw_factor = f64::from_bits(values[8]);
        let min_tile_entry_bytes = 8u64
            .checked_add(minimum_encoded_tile_bytes(1)?)
            .ok_or_else(cache_format_error)?;
        if ![domain.x_min, domain.x_max, domain.y_min, domain.y_max].iter().all(|value| value.is_finite())
            || domain.x_min >= domain.x_max || domain.y_min >= domain.y_max
            || values[5].checked_add(values[6]) != Some(values[4])
            || values[7] == 0 || values[7] > super::graph_new_renderer::MAX_SCENE_POINTS as u64
            || !overdraw_factor.is_finite() || !(0.0..=4.0).contains(&overdraw_factor) || overdraw_factor == 0.0
            || values[9] > u64::from(GRAPH_NEW_MAX_LEVELS)
            || values[10] > (length - minimum_length) / min_tile_entry_bytes {
            return Err(cache_format_error());
        }
        if values[10] > memory_limit.saturating_sub(DECODED_CACHE_BYTES + 4096) / 1024 {
            return Err(AppError::Stats("graph_new_cache_pressure".into()));
        }
        if values[7] > u64::from(GRAPH_NEW_MAX_TILE_POINTS)
            && (values[9] != 1 || values[10] != 1 || values[5] != values[7]
                || exact_tile_restore_memory(values[7])? > memory_limit) {
            return Err(AppError::Stats("graph_new_cache_pressure".into()));
        }
        let mut levels: Vec<TileLevel> = (0..values[9]).map(|level| TileLevel {
            level: level as u8, tiles: Vec::new(), tile_bytes: 0, retained_marks: 0, total_source_count: 0,
        }).collect();
        let axis_length = read_cache_u64(&mut file)?;
        if axis_length > 2 * 1024 * 1024 || axis_length > memory_limit / 4 { return Err(cache_format_error()); }
        let mut axis_bytes = vec![0; axis_length as usize];
        file.read_exact(&mut axis_bytes)?;
        let x_axis: crate::models::graph_new::GraphNewAxisData = serde_json::from_slice(&axis_bytes).map_err(|_| cache_format_error())?;
        if x_axis.categories.len() > 16384 || x_axis.categories.iter().any(|label| label.len() > 512) { return Err(cache_format_error()); }
        let overlay = if policy == RetentionPolicy::Bounded {
            let overlay_length = read_cache_u64(&mut file)?;
            if overlay_length > 2 * 1024 * 1024 || overlay_length > memory_limit / 4 {
                return Err(cache_format_error());
            }
            let mut overlay_bytes = vec![0; overlay_length as usize];
            file.read_exact(&mut overlay_bytes)?;
            let overlay: OverlayCatalog =
                serde_json::from_slice(&overlay_bytes).map_err(|_| cache_format_error())?;
            overlay
        } else {
            OverlayCatalog::default()
        };
        let mut index = BTreeMap::new();
        for _ in 0..values[10] {
            let encoded_bytes = read_cache_u64(&mut file)?;
            let offset = file.stream_position()?;
            let max_encoded = estimate_encoded_tile_bytes(values[7] as usize)?;
            if encoded_bytes < 100 || encoded_bytes > max_encoded
                || offset.checked_add(encoded_bytes).is_none_or(|end| end > length - 32) {
                return Err(cache_format_error());
            }
            let mut bytes = vec![0; encoded_bytes as usize]; file.read_exact(&mut bytes)?;
            let tile = GraphNewTileHeader::decode(&bytes)?;
            if tile.header.point_count == 0 || u64::from(tile.header.point_count) > values[7] {
                return Err(cache_format_error());
            }
            if tile.group_codes.iter().any(|code| !overlay.contains_code(*code)) {
                return Err(cache_format_error());
            }
            let address = TileAddress { level: tile.header.level as u8, tile_x: tile.header.tile_x, tile_y: tile.header.tile_y };
            let bounds = tile_bounds(&domain, address.level, address.tile_x, address.tile_y);
            if bounds != (tile.header.x_min, tile.header.x_max, tile.header.y_min, tile.header.y_max) {
                return Err(cache_format_error());
            }
            let entry = TileEntry { address, representative_row_ids: vec![tile.row_ids[0]],
                total_source_count: tile.header.total_source_count, retained_mark_count: tile.header.point_count,
                x_min: bounds.0, x_max: bounds.1, y_min: bounds.2, y_max: bounds.3 };
            let level = levels.get_mut(address.level as usize).ok_or_else(cache_format_error)?;
            level.tile_bytes = level.tile_bytes.checked_add(encoded_bytes).ok_or_else(cache_format_error)?;
            level.retained_marks = level.retained_marks.checked_add(u64::from(entry.retained_mark_count)).ok_or_else(cache_format_error)?;
            level.total_source_count = level.total_source_count.checked_add(entry.total_source_count).ok_or_else(cache_format_error)?;
            level.tiles.push(entry.clone());
            if index.insert(address, StoredTile { entry, offset, encoded_bytes }).is_some() { return Err(cache_format_error()); }
        }
        if levels.iter().any(|level| level.total_source_count != values[5])
            || (values[5] > 0 && levels.is_empty()) { return Err(cache_format_error()); }
        if &magic == PYRAMID_MAGIC && file.stream_position()? != length - 32 { return Err(cache_format_error()); }
        let tile_store = Arc::new(TileStore::new(file, index));
        let tile_memory = levels.iter().map(|level| level.tiles.capacity() as u64 * 1024).sum::<u64>();
        let raw_store = if &magic == LOSSLESS_PYRAMID_MAGIC {
            let raw = Arc::new(RawStore::read_cache(tile_store.file.clone(), length - 32, values[5], values[6],
                memory_limit.saturating_sub(tile_memory + DECODED_CACHE_BYTES + 4096))?);
            raw.validate_domain(domain)?;
            Some(raw)
        } else { None };
        let result = Self { x_axis, overlay, domain, levels, total_processed_rows: values[4], total_finite_rows: values[5],
            total_excluded_non_finite_rows: values[6], max_tile_points: values[7] as u32, overdraw_factor,
            spool_bytes: 0, accounted_memory_bytes: 0, tile_store, raw_store };
        if result.cache_reservation_bytes() > memory_limit { return Err(AppError::Stats("graph_new_cache_pressure".into())); }
        Ok(result)
    }

    pub fn select(&self, camera: &GraphCamera) -> Result<TileSelection, AppError> {
        self.select_with_control(camera, &|| Ok(()))
    }

    pub fn select_with_control(&self, camera: &GraphCamera, control: &dyn Fn() -> Result<(), AppError>) -> Result<TileSelection, AppError> {
        validate_camera(camera)?;
        control()?;
        if self.is_compact_exact() {
            let level = &self.levels[0];
            let mut selection = self.decode_selection(0, level.tiles.iter().collect(), level.retained_marks, self.total_finite_rows)?;
            let mut visible = 0;
            for selected in &selection.tiles {
                for (position, (&x, &y)) in selected.tile.xs.iter().zip(&selected.tile.ys).enumerate() {
                    if position % CONTROL_CHECK_BATCH_POINTS == 0 { control()?; }
                    if super::graph_new_raw::contains(camera, SourcePoint::new(1, x, y)) { visible += 1; }
                }
            }
            selection.exact = true;
            selection.visible_rows = Some(visible);
            return Ok(selection);
        }
        let budget = selection_budget(camera, self.max_tile_points, self.overdraw_factor)?
            .min(super::graph_new_renderer::MAX_SCENE_POINTS);
        let raw = self.raw_store.as_ref().map(|store| store.query(camera, budget, control)).transpose()?;
        if let Some(raw) = &raw {
        if raw.exact {
            let mut tiles = Vec::new();
            for page in raw.records.chunks(self.max_tile_points as usize) {
                let count = page.len() as u32;
                let tile = GraphNewTile { header: build_tile_header(&self.domain, 0, 0, 0, count, count as u64),
                    row_ids: page.iter().map(|record| record.point.row_id).collect(),
                    xs: page.iter().map(|record| record.point.x).collect(),
                    ys: page.iter().map(|record| record.point.y).collect(),
                    group_codes: page.iter().map(|record| record.point.group_code).collect(),
                    counts: vec![1; page.len()] };
                tiles.push(SelectedTile { entry: TileEntry { address: TileAddress { level: 0, tile_x: 0, tile_y: 0 },
                    representative_row_ids: Vec::new(), total_source_count: count as u64, retained_mark_count: count,
                    x_min: self.domain.x_min, x_max: self.domain.x_max, y_min: self.domain.y_min, y_max: self.domain.y_max }, tile });
            }
            return Ok(TileSelection { exact: true, visible_rows: Some(raw.visible_count), query_work: raw.work, level: 0,
                selected_mark_count: raw.records.len(), total_source_count: raw.visible_count, visible_tiles: tiles.len(), tiles });
        }
        }
        let mut selection = self.select_lod(camera)?;
        let exact = selection.selected_mark_count as u64 == selection.total_source_count
            && selection.tiles.iter().all(|selected| selected.tile.counts.iter().all(|count| *count == 1));
        control()?;
        for selected in &mut selection.tiles {
            let tile = &mut selected.tile;
            let mut retained = 0;
            for position in 0..tile.row_ids.len() {
                if super::graph_new_raw::contains(camera, SourcePoint::new(tile.row_ids[position], tile.xs[position], tile.ys[position])) {
                    tile.row_ids[retained] = tile.row_ids[position];
                    tile.xs[retained] = tile.xs[position];
                    tile.ys[retained] = tile.ys[position];
                    tile.group_codes[retained] = tile.group_codes[position];
                    tile.counts[retained] = tile.counts[position];
                    retained += 1;
                }
            }
            tile.row_ids.truncate(retained);
            tile.xs.truncate(retained);
            tile.ys.truncate(retained);
            tile.group_codes.truncate(retained);
            tile.counts.truncate(retained);
            tile.header.point_count = retained as u32;
            tile.header.total_source_count = tile.counts.iter().map(|count| u64::from(*count)).sum();
            tile.header.payload_bytes = 0;
            selected.entry.retained_mark_count = retained as u32;
            selected.entry.total_source_count = tile.header.total_source_count;
            selected.entry.representative_row_ids = tile.row_ids.first().copied().into_iter().collect();
        }
        selection.tiles.retain(|selected| !selected.tile.row_ids.is_empty());
        selection.selected_mark_count = selection.tiles.iter().map(|selected| selected.tile.row_ids.len()).sum();
        selection.visible_tiles = selection.tiles.len();
        selection.exact = raw.is_none() && exact;
        selection.visible_rows = if selection.exact {
            Some(selection.selected_mark_count as u64)
        } else if camera.x_min <= self.domain.x_min && camera.x_max >= self.domain.x_max
            && camera.y_min <= self.domain.y_min && camera.y_max >= self.domain.y_max {
            Some(self.total_finite_rows)
        } else { None };
        if let Some(raw) = raw {
            selection.query_work = raw.work;
            selection.total_source_count = raw.visible_count;
            selection.visible_rows = Some(raw.visible_count);
        }
        Ok(selection)
    }

    fn select_lod(&self, camera: &GraphCamera) -> Result<TileSelection, AppError> {
        validate_camera(camera)?;
        if self.levels.is_empty() {
            return Ok(TileSelection {
                exact: false, visible_rows: None, query_work: QueryWork::default(),
                level: 0,
                selected_mark_count: 0,
                total_source_count: 0,
                visible_tiles: 0,
                tiles: Vec::new(),
            });
        }

        let budget = selection_budget(camera, self.max_tile_points, self.overdraw_factor)?
            .min(super::graph_new_renderer::MAX_SCENE_POINTS) as u64;
        let mut fallback: Option<(u8, usize, u64)> = None;

        for level in self.levels.iter().rev() {
            let mut visible_tiles = 0usize;
            let mut selected_marks = 0u64;
            for tile in &level.tiles {
                if tile_intersects_camera(tile, camera) {
                    visible_tiles += 1;
                    selected_marks = selected_marks
                        .checked_add(u64::from(tile.retained_mark_count))
                        .ok_or_else(|| {
                            AppError::InvalidParam(
                                "graph-new selected mark count overflow".to_string(),
                            )
                        })?;
                }
            }
            if visible_tiles == 0 {
                continue;
            }
            fallback = Some((level.level, visible_tiles, selected_marks));
            if selected_marks <= budget {
                return self.decode_level_selection(level, camera, visible_tiles, None);
            }
        }

        let Some((level, visible_tiles, _selected_marks)) = fallback else {
            return Ok(TileSelection {
                exact: false, visible_rows: None, query_work: QueryWork::default(),
                level: 0,
                selected_mark_count: 0,
                total_source_count: 0,
                visible_tiles: 0,
                tiles: Vec::new(),
            });
        };

        let level = self.level(level)?;
        self.decode_level_selection(level, camera, visible_tiles, Some(budget))
    }

    fn level(&self, level: u8) -> Result<&TileLevel, AppError> {
        self.levels
            .iter()
            .find(|candidate| candidate.level == level)
            .ok_or_else(|| {
                AppError::Stats("graph-new selected level is missing from the pyramid".to_string())
            })
    }

    fn decode_level_selection(
        &self,
        level: &TileLevel,
        camera: &GraphCamera,
        visible_tiles: usize,
        budget: Option<u64>,
    ) -> Result<TileSelection, AppError> {
        let mut visible = Vec::with_capacity(visible_tiles);
        let mut selected_marks = 0u64;
        let mut total_source_count = 0u64;
        for entry in &level.tiles {
            if !tile_intersects_camera(entry, camera) {
                continue;
            }
            selected_marks = selected_marks
                .checked_add(u64::from(entry.retained_mark_count))
                .ok_or_else(|| {
                    AppError::InvalidParam("graph-new selected mark count overflow".to_string())
                })?;
            total_source_count = total_source_count
                .checked_add(entry.total_source_count)
                .ok_or_else(|| {
                    AppError::InvalidParam("graph-new selected source count overflow".to_string())
                })?;
            visible.push(entry);
        }

        if budget.is_none() || selected_marks <= budget.unwrap_or(selected_marks) {
            return self.decode_selection(level.level, visible, selected_marks, total_source_count);
        }

        let quotas = compute_tile_quotas(&visible, budget.unwrap_or(0) as usize, selected_marks)?;
        let mut tiles = Vec::with_capacity(visible.len());
        let mut reduced_marks = 0usize;
        for (entry, quota) in visible.into_iter().zip(quotas.into_iter()) {
            if quota == 0 {
                continue;
            }
            let tile = downsample_tile(&self.tile_store.decode(&entry.address)?, quota)?;
            reduced_marks = reduced_marks
                .checked_add(tile.row_ids.len())
                .ok_or_else(|| {
                    AppError::InvalidParam("graph-new selected mark count overflow".to_string())
                })?;
            let mut selected_entry = entry.clone();
            selected_entry.representative_row_ids = tile.row_ids.clone();
            selected_entry.retained_mark_count =
                u32::try_from(tile.row_ids.len()).map_err(|_| {
                    AppError::InvalidParam(
                        "graph-new selected mark count does not fit u32".to_string(),
                    )
                })?;
            tiles.push(SelectedTile {
                entry: selected_entry,
                tile,
            });
        }

        Ok(TileSelection {
            exact: false, visible_rows: None, query_work: QueryWork::default(),
            level: level.level,
            selected_mark_count: reduced_marks,
            total_source_count,
            visible_tiles: tiles.len(),
            tiles,
        })
    }

    fn decode_selection(
        &self,
        level: u8,
        visible: Vec<&TileEntry>,
        selected_marks: u64,
        total_source_count: u64,
    ) -> Result<TileSelection, AppError> {
        let mut tiles = Vec::with_capacity(visible.len());
        for entry in visible {
            tiles.push(SelectedTile {
                entry: entry.clone(),
                tile: self.tile_store.decode(&entry.address)?,
            });
        }

        Ok(TileSelection {
            exact: false, visible_rows: None, query_work: QueryWork::default(),
            level,
            selected_mark_count: usize::try_from(selected_marks).map_err(|_| {
                AppError::InvalidParam(
                    "graph-new selected mark count does not fit usize".to_string(),
                )
            })?,
            total_source_count,
            visible_tiles: tiles.len(),
            tiles,
        })
    }
}

pub struct TilePyramidBuilder {
    raw_writer: Option<RawWriter>,
    disk_limit: u64,
    levels: u8,
    max_tile_points: u32,
    overdraw_factor: f64,
    construction_memory_limit_bytes: u64,
    overlay: OverlayCatalog,
    raw_spool: BufWriter<File>,
    raw_spool_bytes: u64,
    total_processed_rows: u64,
    total_finite_rows: u64,
    total_excluded_non_finite_rows: u64,
    domain: Option<GraphDomain>,
    peak_accounted_memory_bytes: u64,
}

impl TilePyramidBuilder {
    #[cfg(test)]
    pub(crate) fn lossless(levels: u8, max_tile_points: u32, overdraw_factor: f64) -> Result<Self, AppError> {
        let mut builder = Self::new(levels, max_tile_points, overdraw_factor)?;
        builder.raw_writer = Some(RawWriter::new(builder.construction_memory_limit_bytes)?);
        Ok(builder)
    }

    pub fn new(levels: u8, max_tile_points: u32, overdraw_factor: f64) -> Result<Self, AppError> {
        Self::with_memory_limit(
            levels,
            max_tile_points,
            overdraw_factor,
            GRAPH_NEW_DEFAULT_CONSTRUCTION_MEMORY_LIMIT_BYTES,
        )
    }

    pub fn with_memory_limit(
        levels: u8,
        max_tile_points: u32,
        overdraw_factor: f64,
        construction_memory_limit_bytes: u64,
    ) -> Result<Self, AppError> {
        if levels == 0 || levels > GRAPH_NEW_MAX_LEVELS {
            return Err(AppError::InvalidParam(format!(
                "graph-new pyramid levels must be between 1 and {GRAPH_NEW_MAX_LEVELS}"
            )));
        }
        if max_tile_points == 0 {
            return Err(AppError::InvalidParam(
                "graph-new max tile points must be positive".to_string(),
            ));
        }
        if max_tile_points > GRAPH_NEW_MAX_TILE_POINTS {
            return Err(AppError::InvalidParam(format!(
                "graph-new max tile points must be between 1 and {GRAPH_NEW_MAX_TILE_POINTS}"
            )));
        }
        if !overdraw_factor.is_finite() || overdraw_factor <= 0.0 {
            return Err(AppError::InvalidParam(
                "graph-new overdraw factor must be positive and finite".to_string(),
            ));
        }
        if construction_memory_limit_bytes == 0 {
            return Err(AppError::InvalidParam(
                "graph-new construction memory limit must be positive".to_string(),
            ));
        }
        if construction_memory_limit_bytes < SPOOL_WRITE_BUFFER_BYTES as u64 + std::mem::size_of::<Self>() as u64 {
            return Err(AppError::Busy("graph-new construction memory cap exceeded".into()));
        }
        Ok(Self {
            raw_writer: None,
            disk_limit: super::graph_new_cache::DEFAULT_DISK_BYTES,
            levels,
            max_tile_points,
            overdraw_factor,
            construction_memory_limit_bytes,
            overlay: OverlayCatalog::default(),
            raw_spool: BufWriter::with_capacity(SPOOL_WRITE_BUFFER_BYTES, tempfile()?),
            raw_spool_bytes: 0,
            total_processed_rows: 0,
            total_finite_rows: 0,
            total_excluded_non_finite_rows: 0,
            domain: None,
            peak_accounted_memory_bytes: 0,
        })
    }

    pub fn total_processed_rows(&self) -> u64 {
        self.total_processed_rows
    }

    pub(crate) fn limit_disk_to(&mut self, bytes: u64) {
        self.disk_limit = bytes.min(super::graph_new_cache::DEFAULT_DISK_BYTES);
    }

    pub(crate) fn set_overlay(&mut self, overlay: OverlayCatalog) {
        self.overlay = overlay;
    }

    fn check_disk_budget(&self, buckets: u64, tiles: u64) -> Result<(), AppError> {
        if self.raw_writer.as_ref().map_or(0, RawWriter::disk_bytes).saturating_add(self.raw_spool_bytes)
            .saturating_add(buckets).saturating_add(tiles) > self.disk_limit {
            return Err(AppError::Stats("graph_new_cache_pressure".into()));
        }
        Ok(())
    }

    pub fn total_finite_rows(&self) -> u64 {
        self.total_finite_rows
    }

    pub fn total_excluded_non_finite_rows(&self) -> u64 {
        self.total_excluded_non_finite_rows
    }

    pub fn spool_bytes(&self) -> u64 {
        self.raw_spool_bytes
    }

    pub fn push_batch(&mut self, batch: &[SourcePoint]) -> Result<(), AppError> {
        self.account_input_capacity(batch.len())?;
        for point in batch {
            self.total_processed_rows =
                self.total_processed_rows.checked_add(1).ok_or_else(|| {
                    AppError::InvalidParam("graph-new processed row overflow".to_string())
                })?;
            if point.row_id <= 0 {
                return Err(AppError::InvalidParam(
                    "graph-new row IDs must be positive".to_string(),
                ));
            }
            self.check_disk_budget(0, source_point_spool_bytes())?;
            if let Some(raw) = &mut self.raw_writer { raw.push(*point, self.total_processed_rows - 1)?; }
            if point.x.is_finite() && point.y.is_finite() {
                self.total_finite_rows =
                    self.total_finite_rows.checked_add(1).ok_or_else(|| {
                        AppError::InvalidParam("graph-new finite row overflow".to_string())
                    })?;
                self.expand_domain(point.x, point.y);
                self.write_raw_point(point)?;
            } else {
                self.total_excluded_non_finite_rows = self
                    .total_excluded_non_finite_rows
                    .checked_add(1)
                    .ok_or_else(|| {
                        AppError::InvalidParam("graph-new excluded row overflow".to_string())
                    })?;
            }
        }
        Ok(())
    }

    pub(crate) fn account_input_capacity(&mut self, capacity: usize) -> Result<(), AppError> {
        let bytes = (capacity as u64)
            .checked_mul(std::mem::size_of::<SourcePoint>() as u64)
            .and_then(|bytes| bytes.checked_add(SPOOL_WRITE_BUFFER_BYTES as u64))
            .ok_or_else(|| AppError::InvalidParam("graph-new scan capacity overflow".into()))?;
        self.update_peak_memory(bytes)
    }

    pub fn finish(self) -> Result<TilePyramid, AppError> {
        self.finish_with_control(&|| Ok(()))
    }

    pub fn finish_with_control(
        mut self,
        control: &dyn Fn() -> Result<(), AppError>,
    ) -> Result<TilePyramid, AppError> {
        control()?;
        let domain = match self.domain {
            Some(domain) => normalized_domain(domain),
            None => {
                return Ok(TilePyramid {
                    x_axis: Default::default(),
                    overlay: self.overlay,
                    domain: GraphDomain {
                        x_min: 0.0,
                        x_max: 1.0,
                        y_min: 0.0,
                        y_max: 1.0,
                    },
                    levels: Vec::new(),
                    total_processed_rows: self.total_processed_rows,
                    total_finite_rows: 0,
                    total_excluded_non_finite_rows: self.total_excluded_non_finite_rows,
                    max_tile_points: self.max_tile_points,
                    overdraw_factor: self.overdraw_factor,
                    spool_bytes: self.raw_spool_bytes,
                    accounted_memory_bytes: self.peak_accounted_memory_bytes,
                    raw_store: self.raw_writer.map(RawWriter::finish).transpose()?.map(Arc::new),
                    tile_store: Arc::new(TileStore::empty()?),
                })
            }
        };

        let exact_memory = exact_tile_restore_memory(self.total_finite_rows)?;
        let exact_disk = self
            .raw_spool_bytes
            .checked_add(estimate_encoded_tile_bytes(self.total_finite_rows as usize)?)
            .ok_or_else(|| {
                AppError::InvalidParam("graph-new exact disk estimate overflow".to_string())
            })?;
        if self.raw_writer.is_none()
            && self.total_finite_rows <= super::graph_new_renderer::MAX_SCENE_POINTS as u64
            && exact_memory <= self.construction_memory_limit_bytes
            && exact_disk <= self.disk_limit {
            return self.finish_compact_exact(domain, exact_memory, control);
        }

        let finest_level = self.levels - 1;
        let bucket_count = bucket_count_for(self.levels);
        self.update_peak_memory(estimate_construction_memory(bucket_count, 0, 0, 0, 0, 0))?;
        let mut bucket_files = (0..bucket_count)
            .map(|_| {
                Ok(BufWriter::with_capacity(
                    SPOOL_WRITE_BUFFER_BYTES,
                    tempfile()?,
                ))
            })
            .collect::<Result<Vec<_>, AppError>>()?;
        let mut bucket_bytes = 0u64;
        let mut level_maps =
            vec![BTreeMap::<(u32, u32), TileAccumulator>::new(); self.levels as usize];
        let mut level_entry_count = 0u64;
        let mut output_tile_count = 0u64;
        let mut output_level_count = 0u64;
        let mut replay_points_since_control = 0usize;

        self.raw_spool.flush()?;
        let mut raw_spool = self.raw_spool.get_ref().try_clone()?;
        raw_spool.seek(SeekFrom::Start(0))?;
        let mut reader = BufReader::with_capacity(SPOOL_READ_BUFFER_BYTES, raw_spool);
        while let Some(point) = read_raw_point(&mut reader)? {
            replay_points_since_control += 1;
            if replay_points_since_control >= CONTROL_CHECK_BATCH_POINTS {
                control()?;
                replay_points_since_control = 0;
            }
            for level in 0..self.levels {
                let (tile_x, tile_y) = tile_index(&domain, level, &point)?;
                let key = (tile_x, tile_y);
                if !level_maps[level as usize].contains_key(&key) {
                    self.update_peak_memory(estimate_construction_memory(
                        bucket_count,
                        level_entry_count + 1,
                        0,
                        output_tile_count,
                        output_level_count,
                        0,
                    ))?;
                    level_entry_count += 1;
                }
                let entry = level_maps[level as usize].entry(key).or_default();
                entry.total_source_count =
                    entry.total_source_count.checked_add(1).ok_or_else(|| {
                        AppError::InvalidParam("graph-new tile count overflow".to_string())
                    })?;
                let group = entry.groups.entry(point.group_code).or_default();
                group.total_source_count = group.total_source_count.checked_add(1).ok_or_else(|| {
                    AppError::InvalidParam("graph-new group tile count overflow".to_string())
                })?;
                match group.representative {
                    Some(current) if current.row_id <= point.row_id => {}
                    _ => group.representative = Some(point),
                }
            }

            let (fine_tile_x, fine_tile_y) = tile_index(&domain, finest_level, &point)?;
            let bucket_index = bucket_index(fine_tile_x, fine_tile_y, bucket_count);
            self.check_disk_budget(bucket_bytes.saturating_add(bucket_record_bytes()), 0)?;
            write_bucket_point(
                &mut bucket_files[bucket_index],
                fine_tile_x,
                fine_tile_y,
                &point,
            )?;
            bucket_bytes = bucket_bytes
                .checked_add(bucket_record_bytes())
                .ok_or_else(|| {
                    AppError::InvalidParam("graph-new bucket byte overflow".to_string())
                })?;
            self.update_peak_memory(estimate_construction_memory(
                bucket_count,
                level_entry_count,
                0,
                output_tile_count,
                output_level_count,
                0,
            ))?;
        }
        control()?;

        let mut tile_file = tempfile()?;
        let mut tile_index = BTreeMap::<TileAddress, StoredTile>::new();
        let mut levels = Vec::with_capacity(self.levels as usize);

        for level in 0..finest_level {
            control()?;
            let map = &level_maps[level as usize];
            let mut tiles = Vec::with_capacity(map.len());
            let mut tile_bytes = 0u64;
            let mut retained_marks = 0u64;
            let mut emitted_tiles_since_control = 0usize;
            for (&(tile_x, tile_y), accumulator) in map {
                emitted_tiles_since_control += 1;
                if emitted_tiles_since_control >= CONTROL_CHECK_BATCH_POINTS {
                    control()?;
                    emitted_tiles_since_control = 0;
                }
                if accumulator.groups.is_empty() {
                    return Err(AppError::Stats(
                        "graph-new tile representative missing".to_string(),
                    ));
                }
                let mut row_ids = Vec::with_capacity(accumulator.groups.len());
                let mut xs = Vec::with_capacity(accumulator.groups.len());
                let mut ys = Vec::with_capacity(accumulator.groups.len());
                let mut group_codes = Vec::with_capacity(accumulator.groups.len());
                let mut counts = Vec::with_capacity(accumulator.groups.len());
                for (&group_code, group) in &accumulator.groups {
                    let representative = group.representative.ok_or_else(|| {
                        AppError::Stats("graph-new group representative missing".to_string())
                    })?;
                    row_ids.push(representative.row_id);
                    xs.push(representative.x);
                    ys.push(representative.y);
                    group_codes.push(group_code);
                    counts.push(u32::try_from(group.total_source_count).map_err(|_| {
                        AppError::InvalidParam(
                            "graph-new per-group source count exceeds u32 storage".to_string(),
                        )
                    })?);
                }
                let tile = GraphNewTile {
                    header: build_tile_header(
                        &domain,
                        level,
                        tile_x,
                        tile_y,
                        u32::try_from(row_ids.len()).map_err(|_| {
                            AppError::InvalidParam(
                                "graph-new coarse tile point count overflow".to_string(),
                            )
                        })?,
                        accumulator.total_source_count,
                    ),
                    row_ids,
                    xs,
                    ys,
                    group_codes,
                    counts,
                };
                self.update_peak_memory(estimate_construction_memory(
                    bucket_count,
                    level_entry_count,
                    0,
                    output_tile_count + 1,
                    output_level_count,
                    estimate_encoded_tile_bytes(1)?,
                ))?;
                self.check_disk_budget(
                    bucket_bytes,
                    tile_file.stream_position()? + estimate_encoded_tile_bytes(tile.row_ids.len())?,
                )?;
                let stored = append_tile(&mut tile_file, &mut tile_index, tile)?;
                output_tile_count += 1;
                tile_bytes = tile_bytes
                    .checked_add(stored.encoded_bytes)
                    .ok_or_else(|| {
                        AppError::InvalidParam("graph-new tile byte overflow".to_string())
                    })?;
                retained_marks += 1;
                tiles.push(stored.entry);
            }
            self.update_peak_memory(estimate_construction_memory(
                bucket_count,
                level_entry_count,
                0,
                output_tile_count,
                output_level_count + 1,
                0,
            ))?;
            output_level_count += 1;
            levels.push(TileLevel {
                level,
                total_source_count: map.values().map(|tile| tile.total_source_count).sum(),
                retained_marks,
                tile_bytes,
                tiles,
            });
        }

        let fine_tile_capacity = level_maps[finest_level as usize].len();
        let fine_mark_limit = (self.max_tile_points as usize).min(if self.raw_writer.is_some() { 128 } else { 4096 });
        let fine_output_bytes = fine_tile_capacity as u64 * std::mem::size_of::<TileEntry>() as u64;
        self.update_peak_memory(estimate_construction_memory(
            bucket_count,
            level_entry_count,
            fine_output_bytes,
            output_tile_count,
            output_level_count,
            0,
        ))?;
        let mut fine_tiles = Vec::with_capacity(fine_tile_capacity);
        let mut fine_tile_bytes = 0u64;
        let mut fine_retained_marks = 0u64;
        for bucket_file in bucket_files {
            control()?;
            let mut bucket_file = into_file(bucket_file)?;
            bucket_file.seek(SeekFrom::Start(0))?;
            let mut bucket_reader = BufReader::with_capacity(SPOOL_READ_BUFFER_BYTES, bucket_file);
            let mut bucket_tiles = BTreeMap::<(u32, u32), FineTileAccumulator>::new();
            let mut bucket_tile_count = 0u64;
            let mut bucket_retained_bytes = fine_output_bytes;
            let mut bucket_points_since_control = 0usize;
            while let Some((tile_x, tile_y, point)) = read_bucket_point(&mut bucket_reader)? {
                bucket_points_since_control += 1;
                if bucket_points_since_control >= CONTROL_CHECK_BATCH_POINTS {
                    control()?;
                    bucket_points_since_control = 0;
                }

                let key = (tile_x, tile_y);
                if !bucket_tiles.contains_key(&key) {
                    self.update_peak_memory(
                        estimate_construction_memory(
                            bucket_count,
                            level_entry_count,
                            bucket_retained_bytes,
                            output_tile_count,
                            output_level_count,
                            0,
                        ) + (bucket_tile_count + 1) * FINE_TILE_ENTRY_BYTES_ESTIMATE,
                    )?;
                    bucket_tile_count += 1;
                }
                let entry = bucket_tiles.entry(key).or_default();
                if entry.retained_points.len() < fine_mark_limit {
                    if entry.retained_points.len() == entry.retained_points.capacity() {
                        let old_capacity = entry.retained_points.capacity();
                        let point_bytes = std::mem::size_of::<RowIdPoint>() as u64;
                        let next_capacity =
                            next_point_capacity(old_capacity, fine_mark_limit);
                        self.update_peak_memory(
                            estimate_construction_memory(
                                bucket_count,
                                level_entry_count,
                                bucket_retained_bytes + next_capacity as u64 * point_bytes,
                                output_tile_count,
                                output_level_count,
                                0,
                            ) + bucket_tile_count * FINE_TILE_ENTRY_BYTES_ESTIMATE,
                        )?;
                        entry
                            .retained_points
                            .try_reserve_exact(next_capacity - entry.retained_points.len())
                            .map_err(|error| {
                                AppError::Busy(format!(
                                    "graph-new retained point allocation failed: {error}"
                                ))
                            })?;
                        let actual_capacity = entry.retained_points.capacity();
                        if actual_capacity > fine_mark_limit {
                            return Err(AppError::Busy(
                                "graph-new retained point capacity exceeds tile limit".to_string(),
                            ));
                        }
                        self.update_peak_memory(
                            estimate_construction_memory(
                                bucket_count,
                                level_entry_count,
                                bucket_retained_bytes + actual_capacity as u64 * point_bytes,
                                output_tile_count,
                                output_level_count,
                                0,
                            ) + bucket_tile_count * FINE_TILE_ENTRY_BYTES_ESTIMATE,
                        )?;
                        bucket_retained_bytes = bucket_retained_bytes
                            .checked_add((actual_capacity - old_capacity) as u64 * point_bytes)
                            .ok_or_else(|| {
                                AppError::InvalidParam(
                                    "graph-new retained bucket byte overflow".to_string(),
                                )
                            })?;
                    }
                    entry.retained_points.push(RowIdPoint(point));
                    #[cfg(test)]
                    assert!(entry.retained_points.capacity() <= fine_mark_limit);
                } else {
                    let should_replace = entry
                        .retained_points
                        .peek()
                        .map(|current| point.row_id < current.0.row_id)
                        .unwrap_or(false);
                    if should_replace {
                        entry.retained_points.pop();
                        entry.retained_points.push(RowIdPoint(point));
                    }
                    entry.overflow_count =
                        entry.overflow_count.checked_add(1).ok_or_else(|| {
                            AppError::InvalidParam(
                                "graph-new fine tile overflow count overflow".to_string(),
                            )
                        })?;
                }
            }
            control()?;

            for ((tile_x, tile_y), accumulator) in bucket_tiles {
                control()?;
                let point_count = accumulator.retained_points.len();
                let retained_bytes = accumulator.retained_points.capacity() as u64
                    * std::mem::size_of::<RowIdPoint>() as u64;
                self.update_peak_memory(
                    estimate_construction_memory(
                        bucket_count,
                        level_entry_count,
                        bucket_retained_bytes,
                        output_tile_count + 1,
                        output_level_count,
                        checked_mul_u64(
                            point_count as u64,
                            tile_payload_point_bytes(),
                            "tile encode scratch",
                        )?
                            + estimate_encoded_tile_bytes(point_count)?,
                    ) + bucket_tile_count * FINE_TILE_ENTRY_BYTES_ESTIMATE,
                )?;
                let retained_points = accumulator.retained_points.into_sorted_vec();
                let meta = level_maps[finest_level as usize]
                    .get(&(tile_x, tile_y))
                    .ok_or_else(|| {
                        AppError::Stats("graph-new fine tile metadata missing".to_string())
                    })?;
                let mut counts = vec![1u32; retained_points.len()];
                if let Some(first) = counts.first_mut() {
                    let overflow = u32::try_from(accumulator.overflow_count).map_err(|_| {
                        AppError::InvalidParam(
                            "graph-new fine tile overflow exceeds u32 counts".to_string(),
                        )
                    })?;
                    *first = first.checked_add(overflow).ok_or_else(|| {
                        AppError::InvalidParam("graph-new fine tile count overflow".to_string())
                    })?;
                }
                let tile = GraphNewTile {
                    header: build_tile_header(
                        &domain,
                        finest_level,
                        tile_x,
                        tile_y,
                        u32::try_from(retained_points.len()).map_err(|_| {
                            AppError::InvalidParam(
                                "graph-new fine point count overflow".to_string(),
                            )
                        })?,
                        meta.total_source_count,
                    ),
                    row_ids: retained_points.iter().map(|point| point.0.row_id).collect(),
                    xs: retained_points.iter().map(|point| point.0.x).collect(),
                    ys: retained_points.iter().map(|point| point.0.y).collect(),
                    group_codes: retained_points.iter().map(|point| point.0.group_code).collect(),
                    counts,
                };
                self.check_disk_budget(
                    bucket_bytes,
                    tile_file.stream_position()? + estimate_encoded_tile_bytes(tile.row_ids.len())?,
                )?;
                let stored = append_tile(&mut tile_file, &mut tile_index, tile)?;
                drop(retained_points);
                bucket_retained_bytes -= retained_bytes;
                output_tile_count += 1;
                fine_tile_bytes = fine_tile_bytes
                    .checked_add(stored.encoded_bytes)
                    .ok_or_else(|| {
                        AppError::InvalidParam("graph-new fine tile byte overflow".to_string())
                    })?;
                fine_retained_marks = fine_retained_marks
                    .checked_add(u64::from(stored.entry.retained_mark_count))
                    .ok_or_else(|| {
                        AppError::InvalidParam("graph-new retained mark overflow".to_string())
                    })?;
                fine_tiles.push(stored.entry);
            }
        }
        fine_tiles.sort_unstable_by_key(|entry| entry.address);
        let fine_total_source_count = level_maps[finest_level as usize]
            .values()
            .map(|tile| tile.total_source_count)
            .sum();
        self.update_peak_memory(estimate_construction_memory(
            bucket_count,
            level_entry_count,
            0,
            output_tile_count,
            output_level_count + 1,
            0,
        ))?;
        output_level_count += 1;
        levels.push(TileLevel {
            level: finest_level,
            total_source_count: fine_total_source_count,
            retained_marks: fine_retained_marks,
            tile_bytes: fine_tile_bytes,
            tiles: fine_tiles,
        });

        self.update_peak_memory(estimate_construction_memory(
            bucket_count,
            level_entry_count,
            0,
            output_tile_count,
            output_level_count,
            0,
        ))?;

        control()?;
        Ok(TilePyramid {
            x_axis: Default::default(),
            overlay: self.overlay,
            domain,
            levels,
            total_processed_rows: self.total_processed_rows,
            total_finite_rows: self.total_finite_rows,
            total_excluded_non_finite_rows: self.total_excluded_non_finite_rows,
            max_tile_points: self.max_tile_points,
            overdraw_factor: self.overdraw_factor,
            spool_bytes: self
                .raw_spool_bytes
                .checked_add(bucket_bytes)
                .and_then(|bytes| bytes.checked_add(self.raw_writer.as_ref().map_or(0, RawWriter::disk_bytes)))
                .ok_or_else(|| {
                    AppError::InvalidParam("graph-new spool byte overflow".to_string())
                })?,
            accounted_memory_bytes: self.peak_accounted_memory_bytes,
            raw_store: self.raw_writer.map(RawWriter::finish).transpose()?.map(Arc::new),
            tile_store: Arc::new(TileStore::new(tile_file, tile_index)),
        })
    }

    fn expand_domain(&mut self, x: f64, y: f64) {
        match &mut self.domain {
            Some(domain) => {
                domain.x_min = domain.x_min.min(x);
                domain.x_max = domain.x_max.max(x);
                domain.y_min = domain.y_min.min(y);
                domain.y_max = domain.y_max.max(y);
            }
            None => {
                self.domain = Some(GraphDomain {
                    x_min: x,
                    x_max: x,
                    y_min: y,
                    y_max: y,
                });
            }
        }
    }

    fn finish_compact_exact(
        mut self, domain: GraphDomain, memory: u64, control: &dyn Fn() -> Result<(), AppError>,
    ) -> Result<TilePyramid, AppError> {
        self.update_peak_memory(memory)?;
        self.raw_spool.flush()?;
        let mut spool = self.raw_spool.get_ref().try_clone()?;
        spool.seek(SeekFrom::Start(0))?;
        let mut reader = BufReader::with_capacity(SPOOL_READ_BUFFER_BYTES, spool);
        let count = self.total_finite_rows as usize;
        let mut tile = GraphNewTile {
            header: build_tile_header(&domain, 0, 0, 0, count as u32, count as u64),
            row_ids: Vec::with_capacity(count), xs: Vec::with_capacity(count),
            ys: Vec::with_capacity(count), group_codes: Vec::with_capacity(count), counts: vec![1; count],
        };
        for position in 0..count {
            if position % CONTROL_CHECK_BATCH_POINTS == 0 { control()?; }
            let point = read_raw_point(&mut reader)?.ok_or_else(cache_format_error)?;
            tile.row_ids.push(point.row_id);
            tile.xs.push(point.x);
            tile.ys.push(point.y);
            tile.group_codes.push(point.group_code);
        }
        control()?;
        let mut file = tempfile()?;
        let mut index = BTreeMap::new();
        let stored = append_tile(&mut file, &mut index, tile)?;
        control()?;
        Ok(TilePyramid {
            x_axis: Default::default(),
            overlay: self.overlay,
            domain, levels: vec![TileLevel { level: 0, tiles: vec![stored.entry],
                tile_bytes: stored.encoded_bytes, retained_marks: count as u64, total_source_count: count as u64 }],
            total_processed_rows: self.total_processed_rows, total_finite_rows: self.total_finite_rows,
            total_excluded_non_finite_rows: self.total_excluded_non_finite_rows,
            max_tile_points: self.max_tile_points.max(count as u32), overdraw_factor: self.overdraw_factor,
            spool_bytes: self.raw_spool_bytes, accounted_memory_bytes: self.peak_accounted_memory_bytes,
            raw_store: None, tile_store: Arc::new(TileStore::new(file, index)),
        })
    }

    fn write_raw_point(&mut self, point: &SourcePoint) -> Result<(), AppError> {
        self.raw_spool.write_all(&point.row_id.to_le_bytes())?;
        self.raw_spool.write_all(&point.x.to_le_bytes())?;
        self.raw_spool.write_all(&point.y.to_le_bytes())?;
        self.raw_spool.write_all(&point.group_code.to_le_bytes())?;
        self.raw_spool_bytes = self
            .raw_spool_bytes
            .checked_add(source_point_spool_bytes())
            .ok_or_else(|| {
                AppError::InvalidParam("graph-new raw spool byte overflow".to_string())
            })?;
        Ok(())
    }

    fn update_peak_memory(&mut self, current_bytes: u64) -> Result<(), AppError> {
        let current_bytes = current_bytes.saturating_add(self.raw_writer.as_ref().map_or(0, RawWriter::memory_bytes));
        self.peak_accounted_memory_bytes = self.peak_accounted_memory_bytes.max(current_bytes);
        if self.peak_accounted_memory_bytes > self.construction_memory_limit_bytes {
            return Err(AppError::Busy(
                "graph-new construction memory cap exceeded".to_string(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Default)]
struct TileAccumulator {
    total_source_count: u64,
    groups: BTreeMap<u16, GroupTileAccumulator>,
}

#[derive(Debug, Clone, Copy, Default)]
struct GroupTileAccumulator {
    total_source_count: u64,
    representative: Option<SourcePoint>,
}

#[derive(Debug, Default)]
struct FineTileAccumulator {
    retained_points: std::collections::BinaryHeap<RowIdPoint>,
    overflow_count: u64,
}

#[derive(Debug, Clone, Copy)]
struct RowIdPoint(SourcePoint);

impl PartialEq for RowIdPoint {
    fn eq(&self, other: &Self) -> bool {
        self.0.row_id == other.0.row_id
    }
}

impl Eq for RowIdPoint {}

impl PartialOrd for RowIdPoint {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for RowIdPoint {
    fn cmp(&self, other: &Self) -> Ordering {
        self.0.row_id.cmp(&other.0.row_id)
    }
}

#[derive(Debug, Clone)]
struct StoredTile {
    entry: TileEntry,
    offset: u64,
    encoded_bytes: u64,
}

#[derive(Clone)]
struct TileStore {
    file: Arc<Mutex<File>>,
    index: Arc<BTreeMap<TileAddress, StoredTile>>,
    decoded: Arc<Mutex<DecodedTiles>>,
    mean: Arc<Mutex<Option<Arc<Vec<[f64; 2]>>>>>,
    raw_line: Arc<Mutex<Option<Arc<Vec<[u32; 2]>>>>>,
}

#[derive(Default)]
struct DecodedTiles {
    entries: BTreeMap<TileAddress, (GraphNewTile, u64, u64)>,
    clock: u64,
    bytes: u64,
}

fn cache_format_error() -> AppError { AppError::Stats("graph_new_invalid_cache".into()) }

fn checked_usize_as_u64(value: usize, label: &str) -> Result<u64, AppError> {
    u64::try_from(value)
        .map_err(|_| AppError::InvalidParam(format!("graph-new {label} overflow")))
}

fn checked_mul_u64(left: u64, right: u64, label: &str) -> Result<u64, AppError> {
    left.checked_mul(right)
        .ok_or_else(|| AppError::InvalidParam(format!("graph-new {label} overflow")))
}

fn source_point_spool_bytes() -> u64 {
    (std::mem::size_of::<i64>()
        + std::mem::size_of::<f64>()
        + std::mem::size_of::<f64>()
        + std::mem::size_of::<u16>()) as u64
}

fn bucket_record_bytes() -> u64 {
    (std::mem::size_of::<u32>()
        + std::mem::size_of::<u32>()) as u64
        + source_point_spool_bytes()
}

fn tile_payload_point_bytes() -> u64 {
    (std::mem::size_of::<i64>()
        + std::mem::size_of::<f64>()
        + std::mem::size_of::<f64>()
        + std::mem::size_of::<u16>()
        + std::mem::size_of::<u32>()) as u64
}

fn decoded_tile_capacity_bytes(point_capacity: usize) -> Result<u64, AppError> {
    checked_mul_u64(
        checked_usize_as_u64(point_capacity, "decoded tile capacity")?,
        tile_payload_point_bytes(),
        "decoded tile capacity bytes",
    )?
    .checked_add(512)
    .ok_or_else(|| AppError::InvalidParam("graph-new decoded tile capacity overflow".to_string()))
}

fn exact_tile_restore_memory(point_count: u64) -> Result<u64, AppError> {
    let payload = checked_mul_u64(point_count, tile_payload_point_bytes(), "exact tile memory")?;
    payload
        .checked_mul(4)
        .and_then(|bytes| bytes.checked_add(DECODED_CACHE_BYTES))
        .and_then(|bytes| bytes.checked_add(SPOOL_WRITE_BUFFER_BYTES as u64))
        .and_then(|bytes| bytes.checked_add(8192))
        .ok_or_else(|| AppError::InvalidParam("graph-new exact tile restore overflow".to_string()))
}

fn read_cache_u64(file: &mut File) -> Result<u64, AppError> {
    let mut bytes = [0; 8]; file.read_exact(&mut bytes)?; Ok(u64::from_le_bytes(bytes))
}

fn cache_checksum(file: &mut File, length: u64) -> Result<[u8; 32], AppError> {
    file.seek(SeekFrom::Start(0))?;
    let mut remaining = length;
    let mut buffer = [0; 64 * 1024];
    let mut digest = Sha256::new();
    while remaining > 0 {
        let count = remaining.min(buffer.len() as u64) as usize;
        file.read_exact(&mut buffer[..count])?;
        digest.update(&buffer[..count]); remaining -= count as u64;
    }
    Ok(digest.finalize().into())
}

impl TileStore {
    fn decoded_limit(&self) -> u64 {
        self.index
            .values()
            .map(|stored| {
                decoded_tile_capacity_bytes(stored.entry.retained_mark_count as usize)
                    .unwrap_or(u64::MAX)
            })
            .max()
            .unwrap_or(0)
            .max(DECODED_CACHE_BYTES)
    }

    fn new(file: File, index: BTreeMap<TileAddress, StoredTile>) -> Self {
        Self {
            file: Arc::new(Mutex::new(file)),
            index: Arc::new(index),
            decoded: Arc::new(Mutex::new(DecodedTiles::default())),
            mean: Arc::new(Mutex::new(None)),
            raw_line: Arc::new(Mutex::new(None)),
        }
    }

    fn empty() -> Result<Self, AppError> {
        Ok(Self::new(tempfile()?, BTreeMap::new()))
    }

    fn decode(&self, address: &TileAddress) -> Result<GraphNewTile, AppError> {
        let mut cache = self.decoded.lock().map_err(|_| cache_format_error())?;
        cache.clock += 1;
        let clock = cache.clock;
        if let Some((tile, _, touched)) = cache.entries.get_mut(address) {
            *touched = clock;
            return Ok(tile.clone());
        }
        let stored = self.index.get(address).ok_or_else(|| {
            AppError::Stats("graph-new selected tile is missing from the store".to_string())
        })?;
        let mut file = self
            .file
            .lock()
            .map_err(|error| AppError::FileIO(error.to_string()))?;
        file.seek(SeekFrom::Start(stored.offset))?;
        let mut bytes = vec![
            0u8;
            usize::try_from(stored.encoded_bytes).map_err(|_| {
                AppError::InvalidParam("graph-new stored tile length overflow".to_string())
            })?
        ];
        file.read_exact(&mut bytes)?;
        let tile = GraphNewTileHeader::decode(&bytes)?;
        let retained = decoded_tile_capacity_bytes(tile.row_ids.capacity())?;
        let limit = self.decoded_limit();
        if retained <= limit {
            while cache.bytes + retained > limit {
                let victim = cache.entries.iter().min_by_key(|(key, (_, _, touched))| (*touched, **key))
                    .map(|(key, _)| *key);
                if let Some(victim) = victim {
                    if let Some((_, bytes, _)) = cache.entries.remove(&victim) { cache.bytes -= bytes; }
                } else { break; }
            }
            cache.bytes += retained;
            cache.entries.insert(*address, (tile.clone(), retained, clock));
        }
        Ok(tile)
    }
}

fn append_tile(
    file: &mut File,
    index: &mut BTreeMap<TileAddress, StoredTile>,
    tile: GraphNewTile,
) -> Result<StoredTile, AppError> {
    let encoded = tile.encode()?;
    let offset = file.seek(SeekFrom::End(0))?;
    file.write_all(&encoded)?;
    let encoded_bytes = u64::try_from(encoded.len())
        .map_err(|_| AppError::InvalidParam("graph-new tile length overflow".to_string()))?;
    let entry = TileEntry {
        address: TileAddress {
            level: u8::try_from(tile.header.level).map_err(|_| {
                AppError::InvalidParam("graph-new tile level conversion failed".to_string())
            })?,
            tile_x: tile.header.tile_x,
            tile_y: tile.header.tile_y,
        },
        representative_row_ids: vec![tile.row_ids[0]],
        total_source_count: tile.header.total_source_count,
        retained_mark_count: tile.header.point_count,
        x_min: tile.header.x_min,
        x_max: tile.header.x_max,
        y_min: tile.header.y_min,
        y_max: tile.header.y_max,
    };
    let stored = StoredTile {
        entry: entry.clone(),
        offset,
        encoded_bytes,
    };
    index.insert(entry.address, stored.clone());
    Ok(stored)
}

fn build_tile_header(
    domain: &GraphDomain,
    level: u8,
    tile_x: u32,
    tile_y: u32,
    point_count: u32,
    total_source_count: u64,
) -> GraphNewTileHeader {
    let (x_min, x_max, y_min, y_max) = tile_bounds(domain, level, tile_x, tile_y);
    GraphNewTileHeader {
        magic: *b"GNTL",
        format_version: GRAPH_NEW_TILE_FORMAT_VERSION,
        level: u16::from(level),
        tile_x,
        tile_y,
        point_count,
        total_source_count,
        x_min,
        x_max,
        y_min,
        y_max,
        payload_bytes: 0,
    }
}

fn validate_camera(camera: &GraphCamera) -> Result<(), AppError> {
    if !camera.x_min.is_finite()
        || !camera.x_max.is_finite()
        || !camera.y_min.is_finite()
        || !camera.y_max.is_finite()
        || camera.x_min > camera.x_max
        || camera.y_min > camera.y_max
    {
        return Err(AppError::InvalidParam(
            "graph-new camera domain must be finite and ordered".to_string(),
        ));
    }
    if camera.viewport_width == 0
        || camera.viewport_height == 0
        || camera.viewport_width > CAMERA_MAX_VIEWPORT_DIMENSION
        || camera.viewport_height > CAMERA_MAX_VIEWPORT_DIMENSION
    {
        return Err(AppError::InvalidParam(
            "graph-new viewport bounds are invalid".to_string(),
        ));
    }
    if !camera.device_pixel_ratio.is_finite()
        || camera.device_pixel_ratio <= 0.0
        || camera.device_pixel_ratio > CAMERA_MAX_DEVICE_PIXEL_RATIO
    {
        return Err(AppError::InvalidParam(
            "graph-new devicePixelRatio must be finite and bounded".to_string(),
        ));
    }
    Ok(())
}

fn normalized_domain(domain: GraphDomain) -> GraphDomain {
    let (x_min, x_max) = normalize_axis(domain.x_min, domain.x_max);
    let (y_min, y_max) = normalize_axis(domain.y_min, domain.y_max);
    GraphDomain {
        x_min,
        x_max,
        y_min,
        y_max,
    }
}

fn normalize_axis(min: f64, max: f64) -> (f64, f64) {
    if !min.is_finite() || !max.is_finite() {
        return (0.0, 1.0);
    }
    let lower = min.min(max);
    let upper = min.max(max);
    if lower < upper {
        return (lower, upper);
    }
    expand_constant_axis(lower)
}

fn expand_constant_axis(value: f64) -> (f64, f64) {
    let lower = value.next_down();
    let upper = value.next_up();
    if lower.is_finite() && upper.is_finite() && lower < upper {
        return (lower, upper);
    }
    if lower.is_finite() && lower < value {
        return (lower, value);
    }
    if upper.is_finite() && value < upper {
        return (value, upper);
    }
    (-0.5, 0.5)
}

fn read_raw_point(reader: &mut BufReader<File>) -> Result<Option<SourcePoint>, AppError> {
    let mut row_id = [0u8; 8];
    match reader.read_exact(&mut row_id) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(AppError::from(error)),
    }
    let mut x = [0u8; 8];
    let mut y = [0u8; 8];
    let mut group_code = [0u8; 2];
    reader.read_exact(&mut x)?;
    reader.read_exact(&mut y)?;
    reader.read_exact(&mut group_code)?;
    Ok(Some(SourcePoint {
        row_id: i64::from_le_bytes(row_id),
        x: f64::from_le_bytes(x),
        y: f64::from_le_bytes(y),
        group_code: u16::from_le_bytes(group_code),
    }))
}

fn write_bucket_point(
    file: &mut BufWriter<File>,
    tile_x: u32,
    tile_y: u32,
    point: &SourcePoint,
) -> Result<(), AppError> {
    file.write_all(&tile_x.to_le_bytes())?;
    file.write_all(&tile_y.to_le_bytes())?;
    file.write_all(&point.row_id.to_le_bytes())?;
    file.write_all(&point.x.to_le_bytes())?;
    file.write_all(&point.y.to_le_bytes())?;
    file.write_all(&point.group_code.to_le_bytes())?;
    Ok(())
}

fn read_bucket_point(
    reader: &mut BufReader<File>,
) -> Result<Option<(u32, u32, SourcePoint)>, AppError> {
    let mut tile_x = [0u8; 4];
    match reader.read_exact(&mut tile_x) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(AppError::from(error)),
    }
    let mut tile_y = [0u8; 4];
    let mut row_id = [0u8; 8];
    let mut x = [0u8; 8];
    let mut y = [0u8; 8];
    let mut group_code = [0u8; 2];
    reader.read_exact(&mut tile_y)?;
    reader.read_exact(&mut row_id)?;
    reader.read_exact(&mut x)?;
    reader.read_exact(&mut y)?;
    reader.read_exact(&mut group_code)?;
    Ok(Some((
        u32::from_le_bytes(tile_x),
        u32::from_le_bytes(tile_y),
        SourcePoint {
            row_id: i64::from_le_bytes(row_id),
            x: f64::from_le_bytes(x),
            y: f64::from_le_bytes(y),
            group_code: u16::from_le_bytes(group_code),
        },
    )))
}

fn tile_index(
    domain: &GraphDomain,
    level: u8,
    point: &SourcePoint,
) -> Result<(u32, u32), AppError> {
    let tiles_per_axis = 1u32
        .checked_shl(u32::from(level))
        .ok_or_else(|| AppError::InvalidParam("graph-new tile level overflow".to_string()))?;
    Ok((
        axis_tile_index(point.x, domain.x_min, domain.x_max, tiles_per_axis),
        axis_tile_index(point.y, domain.y_min, domain.y_max, tiles_per_axis),
    ))
}

fn axis_tile_index(value: f64, min: f64, max: f64, tiles_per_axis: u32) -> u32 {
    if value <= min { return 0; }
    if value >= max { return tiles_per_axis - 1; }
    let normalized = normalized_position(value, min, max);
    let mut index = ((normalized * f64::from(tiles_per_axis)).floor() as u32).min(tiles_per_axis - 1);
    while index > 0 && value < axis_tile_bounds(min, max, index, tiles_per_axis).0 {
        index -= 1;
    }
    while index + 1 < tiles_per_axis && value >= axis_tile_bounds(min, max, index, tiles_per_axis).1 {
        index += 1;
    }
    index
}

fn normalized_position(value: f64, min: f64, max: f64) -> f64 {
    if min == max {
        return 0.5;
    }
    if value <= min {
        return 0.0;
    }
    if value >= max {
        return 1.0 - f64::EPSILON;
    }
    let span = max - min;
    let normalized = if span.is_finite() {
        (value - min) / span
    } else {
        (value * 0.5 - min * 0.5) / (max * 0.5 - min * 0.5)
    };
    normalized.clamp(0.0, 1.0 - f64::EPSILON)
}

fn tile_bounds(domain: &GraphDomain, level: u8, tile_x: u32, tile_y: u32) -> (f64, f64, f64, f64) {
    let tiles_per_axis = 1u32 << level;
    let (x_min, x_max) = axis_tile_bounds(domain.x_min, domain.x_max, tile_x, tiles_per_axis);
    let (y_min, y_max) = axis_tile_bounds(domain.y_min, domain.y_max, tile_y, tiles_per_axis);
    (x_min, x_max, y_min, y_max)
}

fn axis_tile_bounds(min: f64, max: f64, tile_index: u32, tiles_per_axis: u32) -> (f64, f64) {
    let interpolate = |fraction: f64| {
        let span = max - min;
        if span.is_finite() {
            min + span * fraction
        } else {
            min * (1.0 - fraction) + max * fraction
        }
    };
    let start = f64::from(tile_index) / f64::from(tiles_per_axis);
    let end = f64::from(tile_index + 1) / f64::from(tiles_per_axis);
    let lower = if tile_index == 0 {
        min
    } else {
        interpolate(start)
    };
    let upper = if tile_index + 1 == tiles_per_axis {
        max
    } else {
        interpolate(end)
    };
    (lower, upper)
}

fn tile_intersects_camera(tile: &TileEntry, camera: &GraphCamera) -> bool {
    tile.x_max >= camera.x_min
        && tile.x_min <= camera.x_max
        && tile.y_max >= camera.y_min
        && tile.y_min <= camera.y_max
}

fn selection_budget(
    camera: &GraphCamera,
    max_tile_points: u32,
    overdraw_factor: f64,
) -> Result<usize, AppError> {
    let viewport_area = f64::from(camera.viewport_width) * f64::from(camera.viewport_height);
    let baseline_area = 1_920.0 * 1_080.0;
    let area_scale = (viewport_area / baseline_area).clamp(0.25, 1.0);
    let budget = (f64::from(max_tile_points)
        * camera.device_pixel_ratio.max(1.0)
        * overdraw_factor
        * area_scale)
        .ceil();
    usize::try_from(budget as u64)
        .map_err(|_| AppError::InvalidParam("graph-new selection budget overflow".to_string()))
}

fn estimate_level_map_bytes(level_maps: &[BTreeMap<(u32, u32), TileAccumulator>]) -> u64 {
    level_maps
        .iter()
        .map(|map| map.len() as u64 * LEVEL_ENTRY_BYTES_ESTIMATE)
        .sum()
}

fn estimate_construction_memory(
    bucket_count: usize,
    level_entry_bytes: u64,
    bucket_retained_bytes: u64,
    output_tile_count: u64,
    output_level_count: u64,
    encode_scratch_bytes: u64,
) -> u64 {
    (SPOOL_WRITE_BUFFER_BYTES as u64)
        .checked_mul((bucket_count as u64).checked_add(1).unwrap_or(u64::MAX))
        .unwrap_or(u64::MAX)
        .saturating_add(2 * SPOOL_READ_BUFFER_BYTES as u64)
        .saturating_add(level_entry_bytes * LEVEL_ENTRY_BYTES_ESTIMATE)
        .saturating_add(bucket_retained_bytes)
        .saturating_add(output_tile_count * OUTPUT_TILE_ENTRY_BYTES_ESTIMATE)
        .saturating_add(output_tile_count * TILE_INDEX_ENTRY_BYTES_ESTIMATE)
        .saturating_add(output_level_count * TILE_LEVEL_BYTES_ESTIMATE)
        .saturating_add(encode_scratch_bytes)
}

fn estimate_encoded_tile_bytes(point_count: usize) -> Result<u64, AppError> {
    let point_count = checked_usize_as_u64(point_count, "encoded tile points")?;
    checked_mul_u64(
        point_count,
        tile_payload_point_bytes(),
        "encoded tile payload",
    )?
    .checked_add(TILE_ENCODE_FIXED_BYTES_ESTIMATE)
    .ok_or_else(|| AppError::InvalidParam("graph-new encoded tile bytes overflow".to_string()))
}

fn next_point_capacity(current_capacity: usize, max_tile_points: usize) -> usize {
    let next = if current_capacity == 0 {
        4
    } else {
        current_capacity.saturating_mul(2)
    };
    next.min(max_tile_points.max(1))
}

fn into_file(writer: BufWriter<File>) -> Result<File, AppError> {
    writer
        .into_inner()
        .map_err(|error| AppError::from(error.into_error()))
}

fn compute_tile_quotas(
    visible: &[&TileEntry],
    budget: usize,
    total_marks: u64,
) -> Result<Vec<usize>, AppError> {
    let budget_u64 = u64::try_from(budget)
        .map_err(|_| AppError::InvalidParam("graph-new budget overflow".to_string()))?;
    let mut quotas = Vec::with_capacity(visible.len());
    let mut remainders = Vec::with_capacity(visible.len());
    let mut used = 0usize;

    for (index, entry) in visible.iter().enumerate() {
        let marks = u64::from(entry.retained_mark_count);
        let scaled = marks.checked_mul(budget_u64).ok_or_else(|| {
            AppError::InvalidParam("graph-new quota scaling overflow".to_string())
        })?;
        let base = usize::try_from(scaled / total_marks).map_err(|_| {
            AppError::InvalidParam("graph-new quota conversion overflow".to_string())
        })?;
        used = used.checked_add(base).ok_or_else(|| {
            AppError::InvalidParam("graph-new quota accumulation overflow".to_string())
        })?;
        quotas.push(base);
        remainders.push((index, scaled % total_marks));
    }

    remainders.sort_by(
        |(left_index, left_remainder), (right_index, right_remainder)| {
            right_remainder.cmp(left_remainder).then_with(|| {
                visible[*left_index]
                    .address
                    .cmp(&visible[*right_index].address)
            })
        },
    );

    for (index, _) in remainders.into_iter().take(budget.saturating_sub(used)) {
        quotas[index] = quotas[index].saturating_add(1);
    }

    Ok(quotas)
}

fn downsample_tile(tile: &GraphNewTile, quota: usize) -> Result<GraphNewTile, AppError> {
    if quota >= tile.row_ids.len() {
        return Ok(tile.clone());
    }

    let distinct_groups = tile.group_codes.iter().copied().collect::<std::collections::BTreeSet<_>>();
    if distinct_groups.len() > 1 {
        let mut grouped = Vec::<(u16, i64, f64, f64, u32)>::new();
        let mut by_group = BTreeMap::<u16, usize>::new();
        for index in 0..tile.row_ids.len() {
            if let Some(existing) = by_group.get(&tile.group_codes[index]).copied() {
                grouped[existing].4 = grouped[existing].4.checked_add(tile.counts[index]).ok_or_else(|| {
                    AppError::InvalidParam("graph-new grouped fallback count overflow".to_string())
                })?;
            } else {
                by_group.insert(tile.group_codes[index], grouped.len());
                grouped.push((
                    tile.group_codes[index],
                    tile.row_ids[index],
                    tile.xs[index],
                    tile.ys[index],
                    tile.counts[index],
                ));
            }
        }
        if grouped.len() > quota {
            return Err(AppError::Stats("graph_new_cache_pressure".into()));
        }
        grouped.sort_unstable_by_key(|(_, row_id, _, _, _)| *row_id);
        let total_source_count = grouped.iter().try_fold(0u64, |acc, (_, _, _, _, count)| {
            acc.checked_add(u64::from(*count)).ok_or_else(|| {
                AppError::InvalidParam("graph-new grouped fallback source count overflow".to_string())
            })
        })?;
        if total_source_count != tile.header.total_source_count {
            return Err(AppError::Stats(
                "graph-new fallback failed to preserve total source count".to_string(),
            ));
        }
        let mut header = tile.header.clone();
        header.point_count = u32::try_from(grouped.len()).map_err(|_| {
            AppError::InvalidParam("graph-new grouped fallback point count overflow".to_string())
        })?;
        header.payload_bytes = 0;
        return Ok(GraphNewTile {
            header,
            row_ids: grouped.iter().map(|(_, row_id, _, _, _)| *row_id).collect(),
            xs: grouped.iter().map(|(_, _, x, _, _)| *x).collect(),
            ys: grouped.iter().map(|(_, _, _, y, _)| *y).collect(),
            group_codes: grouped.iter().map(|(group_code, _, _, _, _)| *group_code).collect(),
            counts: grouped.iter().map(|(_, _, _, _, count)| *count).collect(),
        });
    }

    let point_count = tile.row_ids.len();
    let mut row_ids = Vec::with_capacity(quota);
    let mut xs = Vec::with_capacity(quota);
    let mut ys = Vec::with_capacity(quota);
    let mut group_codes = Vec::with_capacity(quota);
    let mut counts = Vec::with_capacity(quota);
    let mut total_source_count = 0u64;

    for sample_index in 0..quota {
        let start = sample_index * point_count / quota;
        let mut end = (sample_index + 1) * point_count / quota;
        if end <= start {
            end = start + 1;
        }
        let count = tile.counts[start..end]
            .iter()
            .try_fold(0u32, |acc, value| {
                acc.checked_add(*value).ok_or_else(|| {
                    AppError::InvalidParam("graph-new fallback count overflow".to_string())
                })
            })?;
        total_source_count = total_source_count
            .checked_add(u64::from(count))
            .ok_or_else(|| {
                AppError::InvalidParam("graph-new fallback source count overflow".to_string())
            })?;
        row_ids.push(tile.row_ids[start]);
        xs.push(tile.xs[start]);
        ys.push(tile.ys[start]);
        group_codes.push(tile.group_codes[start]);
        counts.push(count);
    }

    if total_source_count != tile.header.total_source_count {
        return Err(AppError::Stats(
            "graph-new fallback failed to preserve total source count".to_string(),
        ));
    }

    let mut header = tile.header.clone();
    header.point_count = u32::try_from(quota).map_err(|_| {
        AppError::InvalidParam("graph-new fallback point count overflow".to_string())
    })?;
    header.payload_bytes = 0;
    Ok(GraphNewTile {
        header,
        row_ids,
        xs,
        ys,
        group_codes,
        counts,
    })
}

const MEAN_SUM_LIMBS: usize = 34;

fn finite_group_mean(points: &[[f64; 2]], control: &dyn Fn() -> Result<(), AppError>) -> Result<f64, AppError> {
    if points.len() == 1 {
        return Ok(if points[0][1] == 0.0 { 0.0 } else { points[0][1] });
    }
    let mut positive = [0u64; MEAN_SUM_LIMBS];
    let mut negative = [0u64; MEAN_SUM_LIMBS];
    for (position, point) in points.iter().enumerate() {
        if position % CONTROL_CHECK_BATCH_POINTS == 0 { control()?; }
        let bits = point[1].to_bits();
        let exponent = ((bits >> 52) & 0x7ff) as usize;
        let significand = (bits & ((1u64 << 52) - 1)) | if exponent > 0 { 1u64 << 52 } else { 0 };
        let shift = exponent.saturating_sub(1);
        let limbs = if bits >> 63 == 0 { &mut positive } else { &mut negative };
        let mut carry = u128::from(significand) << (shift % 64);
        let mut index = shift / 64;
        while carry != 0 {
            let sum = u128::from(limbs[index]) + (carry & u128::from(u64::MAX));
            limbs[index] = sum as u64;
            carry = (carry >> 64) + (sum >> 64);
            index += 1;
        }
    }
    let sign = if positive.iter().rev().cmp(negative.iter().rev()) == Ordering::Less {
        std::mem::swap(&mut positive, &mut negative);
        1u64 << 63
    } else { 0 };
    let mut borrow = false;
    for (magnitude, subtraction) in positive.iter_mut().zip(negative) {
        let (difference, first_borrow) = magnitude.overflowing_sub(subtraction);
        let (difference, second_borrow) = difference.overflowing_sub(u64::from(borrow));
        *magnitude = difference;
        borrow = first_borrow || second_borrow;
    }
    let Some(highest) = positive.iter().rposition(|limb| *limb != 0) else { return Ok(0.0); };
    let divisor = points.len() as u128;
    let mut remainder = 0u128;
    for limb in positive[..=highest].iter_mut().rev() {
        let dividend = (remainder << 64) | u128::from(*limb);
        *limb = (dividend / divisor) as u64;
        remainder = dividend % divisor;
    }
    let highest_bit = positive.iter().rposition(|limb| *limb != 0)
        .map_or(0, |index| index * 64 + 63 - positive[index].leading_zeros() as usize);
    let mut shift = highest_bit.saturating_sub(52);
    let mut significand = positive[shift / 64] >> (shift % 64);
    if shift % 64 != 0 && shift / 64 + 1 < MEAN_SUM_LIMBS {
        significand |= positive[shift / 64 + 1] << (64 - shift % 64);
    }
    let round_up = if shift == 0 {
        remainder * 2 > divisor || (remainder * 2 == divisor && significand & 1 != 0)
    } else {
        let halfway = shift - 1;
        let half_set = positive[halfway / 64] & (1u64 << (halfway % 64)) != 0;
        let sticky = remainder != 0 || positive[..halfway / 64].iter().any(|limb| *limb != 0)
            || positive[halfway / 64] & ((1u64 << (halfway % 64)) - 1) != 0;
        half_set && (sticky || significand & 1 != 0)
    };
    significand += u64::from(round_up);
    if significand == 1u64 << 53 {
        significand >>= 1;
        shift += 1;
    }
    let magnitude = if significand < 1u64 << 52 { significand }
        else { ((shift as u64 + 1) << 52) | (significand - (1u64 << 52)) };
    Ok(f64::from_bits(sign | magnitude))
}

fn estimate_bucket_bytes(bucket_tiles: &BTreeMap<(u32, u32), FineTileAccumulator>) -> u64 {
    bucket_tiles
        .values()
        .map(|tile| {
            FINE_TILE_ENTRY_BYTES_ESTIMATE
                + (tile.retained_points.len() as u64 * std::mem::size_of::<SourcePoint>() as u64)
        })
        .sum()
}

fn estimate_final_index_bytes(levels: &[TileLevel]) -> u64 {
    levels
        .iter()
        .map(|level| level.tiles.len() as u64 * LEVEL_ENTRY_BYTES_ESTIMATE)
        .sum()
}

fn bucket_count_for(levels: u8) -> usize {
    if levels >= 8 {
        64
    } else {
        16
    }
}

fn bucket_index(tile_x: u32, tile_y: u32, bucket_count: usize) -> usize {
    ((tile_x as usize).wrapping_mul(31) ^ (tile_y as usize).wrapping_mul(17)) % bucket_count
}

#[cfg(test)]
mod tests {
    use crate::models::graph_new_data::GRAPH_NEW_MAX_TILE_POINTS;

    use super::{GraphCamera, SourcePoint, TilePyramidBuilder};

    fn bounded_builder(levels: u8, cap: u32, overdraw: f64) -> TilePyramidBuilder {
        TilePyramidBuilder::with_memory_limit(levels, cap, overdraw, 8 * 1024 * 1024).expect("bounded builder")
    }

    #[test]
    fn graph_new_mean_groups_all_finite_pairs_once_in_numeric_x_order() {
        let mut builder = TilePyramidBuilder::new(8, 4096, 1.5).unwrap();
        builder.push_batch(&[
            SourcePoint::new(1, 2.0, 10.0), SourcePoint::new(2, -0.0, 2.0),
            SourcePoint::new(3, 1.0, 7.0), SourcePoint::new(4, 2.0, 20.0),
            SourcePoint::new(5, 0.0, 4.0), SourcePoint::new(6, f64::NAN, 8.0),
            SourcePoint::new(7, 1.0, f64::INFINITY),
        ]).unwrap();
        let pyramid = builder.finish().unwrap();
        let reserved = pyramid.cache_reservation_bytes();
        let mean = pyramid.mean_line(&|| Ok(())).unwrap().unwrap();
        assert_eq!(mean.as_slice(), &[[0.0, 3.0], [1.0, 7.0], [2.0, 15.0]]);
        assert_eq!(mean[0][0].to_bits(), 0.0f64.to_bits());
        let repeated = pyramid.mean_line(&|| panic!("cached mean must not aggregate again")).unwrap().unwrap();
        assert!(std::sync::Arc::ptr_eq(&mean, &repeated));
        assert!(pyramid.resident_bytes() >= mean.capacity() as u64 * 16);
        assert_eq!(pyramid.cache_reservation_bytes(), reserved);
        assert!(pyramid.resident_bytes() + pyramid.decoded_bytes() + pyramid.total_finite_rows * (24 + 40) <= reserved);
    }

    #[test]
    fn graph_new_mean_full_exponent_cancellation_permutations() {
        for values in [
            [1e300, 1e-24, -1e300], [1e300, -1e300, 1e-24],
            [1e-24, 1e300, -1e300], [1e-24, -1e300, 1e300],
            [-1e300, 1e300, 1e-24], [-1e300, 1e-24, 1e300],
        ] {
            let mut builder = TilePyramidBuilder::new(1, 4096, 1.5).unwrap();
            builder.push_batch(&values.iter().enumerate().map(|(index, value)|
                SourcePoint::new(index as i64 + 1, 0.0, *value)).collect::<Vec<_>>()).unwrap();
            let pyramid = builder.finish().unwrap();
            let mean = pyramid.mean_line(&|| Ok(())).unwrap().unwrap();
            assert_eq!(mean[0][1], 3.333333333333333e-25, "{values:?}");
        }
    }

    #[test]
    fn graph_new_mean_full_exponent_rounding_and_overflow() {
        let tiny = f64::from_bits(1);
        for (values, expected) in [
            (vec![f64::MAX; 17], f64::MAX),
            (vec![-f64::MAX; 17], -f64::MAX),
            (vec![f64::MAX, f64::MAX, -f64::MAX], f64::MAX / 3.0),
            (vec![f64::MAX, f64::MIN, tiny, tiny, tiny], tiny),
            (vec![f64::MAX, f64::MIN, -tiny, -tiny, -tiny], -tiny),
            (vec![f64::MAX, f64::MIN, f64::MIN_POSITIVE], f64::MIN_POSITIVE / 3.0),
            (vec![tiny; 17], tiny),
            (vec![tiny, 0.0], 0.0),
            (vec![-tiny, 0.0], -0.0),
            (vec![tiny, tiny, 0.0], tiny),
            (vec![tiny, tiny * 2.0], tiny * 2.0),
            (vec![tiny * 2.0, tiny * 3.0], tiny * 2.0),
            (vec![1.0, f64::from_bits(1.0f64.to_bits() + 1)], 1.0),
            (vec![1.0, f64::from_bits(1.0f64.to_bits() + 1), tiny], f64::from_bits(0x3fe5555555555556)),
            (vec![f64::MAX, f64::MIN, 0.0, -0.0], 0.0),
            (vec![0.0, -0.0], 0.0),
            (vec![-0.0], 0.0),
        ] {
            let mut builder = TilePyramidBuilder::new(1, 4096, 1.5).unwrap();
            builder.push_batch(&values.iter().enumerate().map(|(index, value)|
                SourcePoint::new(index as i64 + 1, 0.0, *value)).collect::<Vec<_>>()).unwrap();
            let pyramid = builder.finish().unwrap();
            let reserved = pyramid.cache_reservation_bytes();
            let mean = pyramid.mean_line(&|| Ok(())).unwrap().unwrap();
            assert_eq!(mean[0][1].to_bits(), expected.to_bits(), "{values:?}");
            assert!(mean[0][1].is_finite());
            assert_eq!(pyramid.cache_reservation_bytes(), reserved);
            assert!(pyramid.resident_bytes() + pyramid.decoded_bytes() + pyramid.total_finite_rows * 64 <= reserved);
        }
    }

    #[test]
    fn graph_new_mean_full_exponent_sweep_and_carry() {
        for exponent in 0..2047u64 {
            for fraction in [0, 1, (1u64 << 52) - 1] {
                let value = f64::from_bits((exponent << 52) | fraction);
                for sign in [1.0, -1.0] {
                    let residue = value * sign;
                    for values in [
                        [f64::MAX, residue, -f64::MAX],
                        [f64::MAX, -f64::MAX, residue],
                        [residue, f64::MAX, -f64::MAX],
                        [residue, -f64::MAX, f64::MAX],
                        [-f64::MAX, f64::MAX, residue],
                        [-f64::MAX, residue, f64::MAX],
                    ] {
                        let points = values.map(|value| [0.0, value]);
                        let result = super::finite_group_mean(&points, &|| Ok(())).unwrap();
                        let expected = if residue == 0.0 { 0.0 } else { residue / 3.0 };
                        assert_eq!(result.to_bits(), expected.to_bits(), "{values:?}");
                    }
                    let points = [[0.0, residue]; 17];
                    let expected = if residue == 0.0 { 0.0 } else { residue };
                    assert_eq!(super::finite_group_mean(&points, &|| Ok(())).unwrap().to_bits(), expected.to_bits());
                }
            }
        }
        let mut points = vec![[0.0, f64::MAX]; 4097];
        points.extend(vec![[0.0, -f64::MAX]; 4096]);
        assert_eq!(super::finite_group_mean(&points, &|| Ok(())).unwrap(), f64::MAX / 8193.0);
        let calls = std::cell::Cell::new(0);
        assert!(super::finite_group_mean(&points, &|| {
            calls.set(calls.get() + 1);
            if calls.get() == 2 { Err(crate::error::AppError::Stats("cancelled".into())) } else { Ok(()) }
        }).is_err());
        assert_eq!(calls.get(), 2);
    }

    #[test]
    fn graph_new_mean_handles_overflow_cancellation_empty_singleton_and_incomplete_cache() {
        for (values, expected) in [
            (vec![f64::MAX, f64::MAX], f64::MAX),
            (vec![f64::MAX, 1.0, -f64::MAX], 1.0 / 3.0),
            (vec![1e16, 1.0, -1e16], 1.0 / 3.0),
            (vec![f64::from_bits(1); 3], f64::from_bits(1)),
        ] {
            let mut builder = TilePyramidBuilder::new(1, 4096, 1.5).unwrap();
            builder.push_batch(&values.iter().enumerate().map(|(index, value)|
                SourcePoint::new(index as i64 + 1, 0.0, *value)).collect::<Vec<_>>()).unwrap();
            let pyramid = builder.finish().unwrap();
            let mean = pyramid.mean_line(&|| Ok(())).unwrap().unwrap();
            assert_eq!(mean.len(), 1);
            assert!((mean[0][1] - expected).abs() <= expected.abs() * 1e-14);
            assert!(mean[0][1].is_finite());
        }
        let empty = TilePyramidBuilder::new(1, 4096, 1.5).unwrap().finish().unwrap();
        assert!(empty.mean_line(&|| Ok(())).unwrap().unwrap().is_empty());
        let mut builder = bounded_builder(1, 2, 1.5);
        builder.push_batch(&[SourcePoint::new(1, 0.0, 2.0), SourcePoint::new(2, 1.0, 3.0),
            SourcePoint::new(3, 0.0, 100.0)]).unwrap();
        let incomplete = builder.finish().unwrap();
        assert!(incomplete.mean_line(&|| Ok(())).unwrap().is_none(), "no mean of representatives");
    }

    #[test]
    fn graph_new_large_exact_decode_retains_actual_allocations_without_warm_io() {
        use std::io::{Seek, SeekFrom, Write};

        for count in [2_032_293usize, 2_100_000] {
            let tile = super::GraphNewTile {
                header: super::GraphNewTileHeader::new_for_test(0, 0, 0, count as u32, count as u64),
                row_ids: (1..=count as i64).collect(),
                xs: vec![0.5; count],
                ys: vec![0.5; count],
                group_codes: vec![0; count],
                counts: vec![1; count],
            };
            let mut file = tempfile::tempfile().expect("temporary tile file");
            let mut index = std::collections::BTreeMap::new();
            let stored = super::append_tile(&mut file, &mut index, tile).expect("encode exact tile");
            let store = super::TileStore::new(file, index);
            let decoded = store.decode(&stored.entry.address).expect("cold decode");
            let allocated = super::decoded_tile_capacity_bytes(decoded.row_ids.capacity()).expect("allocated");
            assert!(allocated <= store.decoded_limit(), "{count}: actual allocation {allocated} exceeds cache limit {}", store.decoded_limit());
            assert_eq!(store.decoded.lock().expect("cache").bytes, allocated);
            drop(decoded);
            {
                let mut file = store.file.lock().expect("file");
                file.seek(SeekFrom::End(-1)).expect("checksum position");
                file.write_all(&[0xff]).expect("invalidate checksum");
            }
            assert_eq!(store.decode(&stored.entry.address).expect("warm decode must not checksum").row_ids.len(), count);
            store.file.lock().expect("file").set_len(0).expect("empty temporary backing file");
            assert_eq!(store.decode(&stored.entry.address).expect("camera decode must not reread").row_ids.len(), count);
            store.decoded.lock().expect("cache").entries.clear();
            assert!(store.decode(&stored.entry.address).is_err(), "a cache miss still validates its backing file");
        }
    }

    #[test]
    fn graph_new_fallback_midpoint_round_trips_below_and_above_exact_cap() {
        for count in [3usize, super::super::graph_new_renderer::MAX_SCENE_POINTS + 1] {
            let mut builder = bounded_builder(2, 4096, 1.5);
            builder.push_batch(&[SourcePoint::new(1, -6.0, -6.0), SourcePoint::new(2, 7.0, 7.0)]).expect("outer bounds");
            for start in (2..count).step_by(4096) {
                let batch: Vec<_> = (start..(start + 4096).min(count))
                    .map(|index| SourcePoint::new(index as i64 + 1, 0.5, 0.5)).collect();
                builder.push_batch(&batch).expect("midpoint batch");
            }
            let pyramid = builder.finish().expect("midpoint must encode within its classified tile");
            assert_eq!((pyramid.domain.x_min, pyramid.domain.x_max), (-6.0, 7.0));
            assert_eq!(pyramid.total_finite_rows, count as u64);
            assert_eq!(pyramid.levels.len(), 2);
            let mut file = tempfile::tempfile().expect("cache");
            let key = "c".repeat(64);
            pyramid.write_cache(&mut file, &key).expect("persist fallback");
            let restored = super::TilePyramid::read_cache(file, &key, 32 * 1024 * 1024, 32 * 1024 * 1024).expect("restore fallback");
            let selection = restored.select(&GraphCamera {
                x_min: -6.0, x_max: 7.0, y_min: -6.0, y_max: 7.0,
                viewport_width: 1920, viewport_height: 1080, device_pixel_ratio: 1.0,
            }).expect("select fallback");
            assert_eq!(selection.total_source_count, count as u64);
            assert_eq!(selection.exact, count == 3);
        }
    }

    #[test]
    fn graph_new_tile_classification_agrees_with_extreme_and_adjacent_bounds() {
        for (min, max) in [(-6.0, 7.0), (-f64::MAX, f64::MAX), (1e-300, 2e-300), (1.0, 1.0f64.next_up())] {
            let domain = super::GraphDomain { x_min: min, x_max: max, y_min: min, y_max: max };
            for level in 1..=8 {
                let tiles = 1 << level;
                assert_eq!(super::axis_tile_bounds(min, max, 0, tiles).0, min);
                assert_eq!(super::axis_tile_bounds(min, max, tiles - 1, tiles).1, max);
                for tile in 0..tiles {
                    let (lower, upper) = super::axis_tile_bounds(min, max, tile, tiles);
                    for value in [lower.next_down(), lower, lower.next_up(), upper, min, max] {
                        if !value.is_finite() || value < min || value > max { continue; }
                        let (tile_x, tile_y) = super::tile_index(&domain, level, &SourcePoint::new(1, value, value)).expect("classify");
                        let (x_min, x_max, y_min, y_max) = super::tile_bounds(&domain, level, tile_x, tile_y);
                        assert!(value >= x_min && value <= x_max && value >= y_min && value <= y_max,
                            "{min}..{max} level {level}: {value} outside {x_min}..{x_max}");
                    }
                }
            }
        }
    }

    #[test]
    fn graph_new_compact_exact_waveform_preserves_every_finite_point() {
        let mut points: Vec<_> = (1..=8192).map(|row_id| {
            SourcePoint::new(row_id, row_id as f64, (row_id as f64 * 1.731).sin())
        }).collect();
        points.push(SourcePoint::new(8193, 4096.5, 4.0));
        let mut builder = TilePyramidBuilder::new(8, 4096, 1.5).expect("builder");
        builder.push_batch(&points).expect("waveform");
        builder.push_batch(&[SourcePoint::new(8194, f64::NAN, 0.0)]).expect("nonfinite");
        let pyramid = builder.finish().expect("pyramid");
        let camera = GraphCamera { x_min: 0.0, x_max: 8194.0, y_min: -1.1, y_max: 4.1,
            viewport_width: 160, viewport_height: 120, device_pixel_ratio: 1.0 };
        let selected = pyramid.select(&camera).expect("select");
        assert_eq!(selected.selected_mark_count, points.len(), "screen LOD must not erase a source that fits");
        assert!(selected.exact);
        assert_eq!(selected.visible_rows, Some(8193));
        let mut actual: Vec<_> = selected.tiles.iter().flat_map(|selected| {
            selected.tile.row_ids.iter().zip(&selected.tile.xs).zip(&selected.tile.ys)
                .map(|((&row_id, &x), &y)| (row_id, x.to_bits(), y.to_bits()))
        }).collect();
        actual.sort_unstable_by_key(|point| point.0);
        assert_eq!(actual, points.iter().map(|point| (point.row_id, point.x.to_bits(), point.y.to_bits())).collect::<Vec<_>>());
        assert_eq!(pyramid.levels.len(), 1, "no deep pyramid for an exact scene");
        assert!(pyramid.raw_store.is_none(), "research raw index stays opt-in");
        assert_eq!(pyramid.spool_bytes, 8193 * super::source_point_spool_bytes(), "no bucket replay spool");
        let key = "e".repeat(64);
        let mut file = tempfile::tempfile().expect("cache file");
        pyramid.write_cache(&mut file, &key).expect("persist");
        assert_eq!(file.metadata().expect("metadata").len(), pyramid.persisted_bytes());
        assert!(super::TilePyramid::read_cache(file.try_clone().expect("clone"), &"f".repeat(64), 32 * 1024 * 1024, 1024 * 1024).is_err());
        let restored = super::TilePyramid::read_cache(file, &key, 32 * 1024 * 1024, 1024 * 1024).expect("restore");
        let zoom = GraphCamera { x_min: 4096.25, x_max: 4096.75, y_min: 3.9, y_max: 4.1, ..camera };
        let selected = restored.select(&zoom).expect("zoom");
        assert!(selected.exact);
        assert_eq!(selected.visible_rows, Some(1));
        assert_eq!(selected.selected_mark_count, 8193, "camera retains source slots for GPU reuse");
        assert_eq!(selected.query_work.raw_points_inspected, 0);
        assert!(restored.select_with_control(&camera, &|| Err(crate::error::AppError::Cancelled("test".into()))).is_err());
    }

    #[test]
    fn graph_new_compact_exact_cap_and_memory_fallback() {
        let cap = super::super::graph_new_renderer::MAX_SCENE_POINTS;
        for count in [cap, cap + 1] {
            let mut builder = TilePyramidBuilder::new(1, 4096, 1.5).expect("builder");
            for start in (0..count).step_by(4096) {
                let batch: Vec<_> = (start..(start + 4096).min(count))
                    .map(|index| SourcePoint::new(index as i64 + 1, index as f64, 0.5)).collect();
                builder.push_batch(&batch).expect("batch");
            }
            let pyramid = builder.finish().expect("finish");
            let selected = pyramid.select(&GraphCamera { x_min: 0.0, x_max: count as f64,
                y_min: 0.0, y_max: 1.0, viewport_width: 320, viewport_height: 200, device_pixel_ratio: 1.0 }).expect("select");
            assert_eq!(selected.exact, count == cap);
            assert_eq!(pyramid.total_finite_rows, count as u64);
            assert!(selected.selected_mark_count <= cap);
            if count == cap {
                assert_eq!(selected.selected_mark_count, cap);
                let mut file = tempfile::tempfile().expect("file");
                let key = "a".repeat(64);
                pyramid.write_cache(&mut file, &key).expect("write large exact tile");
                assert!(super::TilePyramid::read_cache(file.try_clone().expect("clone"), &key, 16 * 1024 * 1024, 64 * 1024 * 1024).is_err());
                let restored = super::TilePyramid::read_cache(file, &key, 320 * 1024 * 1024, 64 * 1024 * 1024).expect("restore large exact tile with raw-index scratch reservation");
                assert!(restored.is_compact_exact());
            } else {
                assert!(selected.selected_mark_count < count);
                assert!(pyramid.raw_line(&[], &|| Ok(())).expect("raw availability").is_none(), "never connect sampled geometry as a raw line");
            }
        }
        let mut builder = TilePyramidBuilder::new(8, 4096, 1.5).expect("builder");
        builder.push_batch(&[SourcePoint::new(1, 0.0, 1.0)]).expect("point");
        let calls = std::cell::Cell::new(0);
        assert!(builder.finish_with_control(&|| {
            calls.set(calls.get() + 1);
            if calls.get() == 4 { Err(crate::error::AppError::Cancelled("final exact check".into())) } else { Ok(()) }
        }).is_err());
    }

    #[test]
    fn graph_new_performance_first_default_retains_only_bounded_lod() {
        let mut builder = bounded_builder(1, 4096, 1.5);
        assert!(builder.raw_writer.is_none(), "no raw files or index buffers are constructed");
        for row_id in 1..=8192 {
            builder.push_batch(&[SourcePoint::new(row_id, 0.0, 0.0)]).expect("point");
        }
        builder.push_batch(&[SourcePoint::new(8193, f64::NAN, 1.0)]).expect("excluded");
        let pyramid = builder.finish().expect("pyramid");
        assert_eq!(pyramid.encoded_bytes(), pyramid.levels.iter().map(|level| level.tile_bytes).sum::<u64>(), "default must not retain raw/index/gap bytes");
        assert_eq!(pyramid.total_processed_rows, 8193);
        assert_eq!(pyramid.total_finite_rows, 8192);
        assert_eq!(pyramid.total_excluded_non_finite_rows, 1);
        assert_eq!(pyramid.levels[0].retained_marks, 4096);
        assert!(pyramid.cache_reservation_bytes() < 16 * 1024 * 1024);
        let selection = pyramid.select(&GraphCamera {
            x_min: -1.0, x_max: 1.0, y_min: -1.0, y_max: 1.0,
            viewport_width: 640, viewport_height: 360, device_pixel_ratio: 1.0,
        }).expect("selection");
        assert!(!selection.exact);
        assert!(selection.selected_mark_count <= 1536);
        assert_eq!(selection.query_work.index_entries_inspected, 0);
        assert_eq!(selection.query_work.raw_blocks_inspected, 0);
        assert_eq!(selection.query_work.raw_points_inspected, 0);
        assert_eq!(selection.visible_rows, Some(8192));
        let mut file = tempfile::tempfile().expect("cache");
        let key = "b".repeat(64);
        pyramid.write_cache(&mut file, &key).expect("write bounded cache");
        assert_eq!(file.metadata().expect("metadata").len(), pyramid.persisted_bytes());
        let restored = super::TilePyramid::read_cache(file, &key, 16 * 1024 * 1024, 1024 * 1024).expect("bounded restore without raw scratch");
        assert!(restored.raw_store.is_none());
        assert_eq!(restored.total_processed_rows, 8193);
        assert_eq!(restored.total_finite_rows, 8192);
        assert_eq!(restored.total_excluded_non_finite_rows, 1);
        assert_eq!(restored.levels[0].retained_marks, 4096);
        let partial = restored.select(&GraphCamera {
            x_min: restored.domain.x_min, x_max: (restored.domain.x_min + restored.domain.x_max) / 2.0,
            y_min: restored.domain.y_min, y_max: restored.domain.y_max,
            viewport_width: 640, viewport_height: 360, device_pixel_ratio: 1.0,
        }).expect("partial");
        assert!(!partial.exact);
        assert_eq!(partial.visible_rows, None);
        assert_eq!(partial.query_work.index_entries_inspected, 0);
        let mut legacy = tempfile::tempfile().expect("legacy fixture");
        restored.write_cache(&mut legacy, &key).expect("fixture");
        use std::io::{Seek, SeekFrom, Write};
        legacy.seek(SeekFrom::Start(0)).expect("start");
        legacy.write_all(b"GNPC0002").expect("legacy schema");
        let payload_length = legacy.metadata().expect("length").len() - 32;
        let checksum = super::cache_checksum(&mut legacy, payload_length).expect("checksum");
        legacy.seek(SeekFrom::Start(payload_length)).expect("checksum offset");
        legacy.write_all(&checksum).expect("valid checksum");
        assert!(super::TilePyramid::read_cache(legacy, &key, 16 * 1024 * 1024, 1024 * 1024).is_err());
    }

    #[test]
    fn coarse_overlay_aggregation_preserves_group_totals_per_group() {
        let mut builder = bounded_builder(2, 16, 1.0);
        builder.push_batch(&[
            SourcePoint::with_group(1, 0.10, 0.10, 1),
            SourcePoint::with_group(2, 0.20, 0.20, 1),
            SourcePoint::with_group(3, 0.30, 0.30, 2),
            SourcePoint::with_group(4, 0.40, 0.40, 2),
            SourcePoint::with_group(5, 0.50, 0.50, 2),
        ]).expect("points");
        let pyramid = builder.finish().expect("pyramid");
        let coarse = pyramid.levels.first().expect("coarse");
        let tile = pyramid.tile_store.decode(&coarse.tiles[0].address).expect("decode coarse tile");
        let mut totals = std::collections::BTreeMap::<u16, u32>::new();
        for (&group_code, &count) in tile.group_codes.iter().zip(&tile.counts) {
            *totals.entry(group_code).or_default() += count;
        }
        assert_eq!(totals.get(&1), Some(&2));
        assert_eq!(totals.get(&2), Some(&3));
        assert_eq!(tile.counts.iter().copied().map(u64::from).sum::<u64>(), tile.header.total_source_count);
    }

    #[test]
    fn downsample_tile_preserves_group_totals_without_cross_group_counts() {
        let tile = super::GraphNewTile {
            header: super::GraphNewTileHeader::new_for_test(0, 0, 0, 4, 100),
            row_ids: vec![1, 2, 3, 4],
            xs: vec![0.1, 0.2, 0.3, 0.4],
            ys: vec![0.1, 0.2, 0.3, 0.4],
            group_codes: vec![1, 2, 1, 2],
            counts: vec![10, 20, 30, 40],
        };

        let downsampled = super::downsample_tile(&tile, 2).expect("downsample");
        let mut totals = std::collections::BTreeMap::<u16, u32>::new();
        for (&group_code, &count) in downsampled.group_codes.iter().zip(&downsampled.counts) {
            *totals.entry(group_code).or_default() += count;
        }
        assert_eq!(totals.get(&1), Some(&40));
        assert_eq!(totals.get(&2), Some(&60));
        assert_eq!(downsampled.counts.iter().copied().map(u64::from).sum::<u64>(), tile.header.total_source_count);
    }

    #[test]
    fn bounded_restore_accepts_many_valid_one_point_tiles_below_old_floor_estimate() {
        let mut builder = bounded_builder(3, 1, 1.0);
        let mut row_id = 1i64;
        for tile_y in 0..4 {
            for tile_x in 0..4 {
                builder.push_batch(&[SourcePoint::new(
                    row_id,
                    (f64::from(tile_x) + 0.5) / 4.0,
                    (f64::from(tile_y) + 0.5) / 4.0,
                )]).expect("point");
                row_id += 1;
            }
        }
        let pyramid = builder.finish().expect("pyramid");
        let key = "1".repeat(64);
        let mut file = tempfile::tempfile().expect("cache");
        pyramid.write_cache(&mut file, &key).expect("persist");
        let file_len = file.metadata().expect("metadata").len();
        let tile_count = pyramid.tile_store.index.len() as u64;
        let old_min_tile_entry_bytes = 166u64;
        assert!(
            tile_count > (file_len - 200) / old_min_tile_entry_bytes,
            "fixture must be smaller than the previous floor estimate"
        );
        let restored = super::TilePyramid::read_cache(file, &key, 16 * 1024 * 1024, 1024 * 1024)
            .expect("restore valid one-point tiles");
        assert_eq!(restored.levels.iter().map(|level| level.tiles.len()).sum::<usize>(), 21);
        assert_eq!(restored.levels[0].retained_marks, 1);
        assert_eq!(restored.levels[0].total_source_count, 16);
        let partial = restored.select(&GraphCamera {
            x_min: restored.domain.x_min, x_max: (restored.domain.x_min + restored.domain.x_max) / 2.0,
            y_min: restored.domain.y_min, y_max: restored.domain.y_max,
            viewport_width: 640, viewport_height: 360, device_pixel_ratio: 1.0,
        }).expect("partial");
        assert!(!partial.exact);
        assert_eq!(partial.visible_rows, None);
        assert_eq!(partial.query_work.index_entries_inspected, 0);
        let mut legacy = tempfile::tempfile().expect("legacy fixture");
        restored.write_cache(&mut legacy, &key).expect("fixture");
        use std::io::{Seek, SeekFrom, Write};
        legacy.seek(SeekFrom::Start(0)).expect("start");
        legacy.write_all(b"GNPC0002").expect("legacy schema");
        let payload_length = legacy.metadata().expect("length").len() - 32;
        let checksum = super::cache_checksum(&mut legacy, payload_length).expect("checksum");
        legacy.seek(SeekFrom::Start(payload_length)).expect("checksum offset");
        legacy.write_all(&checksum).expect("valid checksum");
        assert!(super::TilePyramid::read_cache(legacy, &key, 16 * 1024 * 1024, 1024 * 1024).is_err());
    }

    #[test]
    fn select_rejects_mixed_group_tile_when_quota_cannot_fit_all_groups() {
        let mut builder = bounded_builder(2, 4, 1.0);
        builder.push_batch(&[
            SourcePoint::with_group(1, 0.10, 0.10, 1),
            SourcePoint::with_group(2, 0.20, 0.20, 2),
            SourcePoint::with_group(3, 0.30, 0.30, 3),
        ]).expect("points");

        let pyramid = builder.finish().expect("pyramid");
        let error = pyramid.select_lod(&GraphCamera {
            x_min: 0.0, x_max: 1.0, y_min: 0.0, y_max: 1.0,
            viewport_width: 1, viewport_height: 1, device_pixel_ratio: 1.0,
        }).expect_err("mixed-group quota overflow must fail");

        assert!(matches!(
            error,
            crate::error::AppError::Stats(message) if message == "graph_new_cache_pressure"
        ));
    }

    #[test]
    fn graph_new_performance_first_exact_requires_complete_retained_tiles() {
        let mut builder = TilePyramidBuilder::new(2, 16, 1.5).expect("builder");
        builder.push_batch(&[SourcePoint::new(1, 0.0, 0.0), SourcePoint::new(2, 0.1, 0.1), SourcePoint::new(3, 100.0, 100.0)]).expect("points");
        let selection = builder.finish().expect("pyramid").select(&GraphCamera {
            x_min: 0.09, x_max: 0.11, y_min: 0.09, y_max: 0.11,
            viewport_width: 640, viewport_height: 360, device_pixel_ratio: 1.0,
        }).expect("exact retained viewport");
        assert!(selection.exact);
        assert_eq!(selection.visible_rows, Some(1));
        assert_eq!(selection.tiles[0].tile.row_ids, vec![1, 2, 3]);
        assert_eq!(selection.query_work.raw_points_inspected, 0);
    }

    #[test]
    fn graph_new_lossless_approximate_status_counts_only_visible_representatives() {
        let mut builder = TilePyramidBuilder::lossless(2, 16, 1.5).expect("builder");
        for row_id in 1..=256 {
            builder.push_batch(&[SourcePoint::new(row_id, if row_id <= 128 { 0.0 } else { 0.1 }, 0.0)]).expect("point");
        }
        builder.push_batch(&[SourcePoint::new(257, 1000.0, 1000.0)]).expect("domain");
        let selection = builder.finish().expect("pyramid").select(&GraphCamera {
            x_min: 0.09, x_max: 0.11, y_min: -0.01, y_max: 0.01,
            viewport_width: 640, viewport_height: 360, device_pixel_ratio: 1.0,
        }).expect("approximate selection");
        assert!(!selection.exact);
        assert_eq!(selection.total_source_count, 128);
        assert_eq!(selection.selected_mark_count, 0, "out-of-view LOD representatives are not displayed marks");
    }

    #[test]
    fn graph_new_lossless_cache_rejects_raw_coordinates_outside_axis_domain() {
        let mut builder = TilePyramidBuilder::lossless(2, 16, 1.5).expect("builder");
        builder.push_batch(&[SourcePoint::new(1, 1.0, 1.0)]).expect("point");
        let mut pyramid = builder.finish().expect("pyramid");
        let mut raw = super::RawWriter::new(1024 * 1024).expect("raw writer");
        raw.push(SourcePoint::new(1, 500.0, 500.0), 0).expect("foreign coordinates");
        pyramid.raw_store = Some(std::sync::Arc::new(raw.finish().expect("raw")));
        let key = "a".repeat(64);
        let mut file = tempfile::tempfile().expect("file");
        pyramid.write_cache(&mut file, &key).expect("cache fixture with valid checksums");
        assert!(super::TilePyramid::read_cache_with_policy(file, &key, 256 * 1024 * 1024, 1024 * 1024 * 1024, super::RetentionPolicy::Lossless).is_err());
    }

    #[test]
    fn graph_new_lossless_narrow_camera_recovers_late_dense_cell_anomaly() {
        let mut builder = TilePyramidBuilder::lossless(4, 4096, 1.5).expect("builder");
        for row_id in 1..=8192 {
            builder.push_batch(&[SourcePoint::new(row_id, 0.0, 0.0)]).expect("dense point");
        }
        builder.push_batch(&[
            SourcePoint::new(9001, 0.1, 0.1),
            SourcePoint::new(9002, 1000.0, 1000.0),
        ]).expect("anomaly and domain endpoint");
        let pyramid = builder.finish().expect("pyramid");
        let selection = pyramid.select(&GraphCamera {
            x_min: 0.09, x_max: 0.11, y_min: 0.09, y_max: 0.11,
            viewport_width: 640, viewport_height: 360, device_pixel_ratio: 1.0,
        }).expect("narrow selection");
        let points = selection.tiles.iter().flat_map(|selected| {
            selected.tile.row_ids.iter().zip(&selected.tile.xs).zip(&selected.tile.ys)
                .map(|((&row_id, &x), &y)| SourcePoint::new(row_id, x, y))
        }).collect::<Vec<_>>();
        assert_eq!(points, vec![SourcePoint::new(9001, 0.1, 0.1)]);
        assert_eq!(selection.selected_mark_count, 1);
        assert_eq!(selection.total_source_count, 1);
        assert!(selection.exact);
        assert!(selection.query_work.raw_blocks_inspected > 0);
        assert!(selection.query_work.raw_points_inspected < 256);
        let key = "a".repeat(64);
        let mut file = tempfile::tempfile().expect("cache file");
        pyramid.write_cache(&mut file, &key).expect("persist raw and LOD");
        assert!(super::TilePyramid::read_cache(file.try_clone().expect("clone"), &key, 256 * 1024 * 1024, 1024 * 1024 * 1024).is_err(), "default reader rejects research payload");
        let restored = super::TilePyramid::read_cache_with_policy(file, &key, 256 * 1024 * 1024, 1024 * 1024 * 1024, super::RetentionPolicy::Lossless).expect("restore");
        let selection = restored.select(&GraphCamera {
            x_min: 0.09, x_max: 0.11, y_min: 0.09, y_max: 0.11,
            viewport_width: 640, viewport_height: 360, device_pixel_ratio: 1.0,
        }).expect("restored exact selection");
        assert!(selection.exact);
        assert_eq!(selection.tiles[0].tile.row_ids, vec![9001]);
        assert_eq!(selection.tiles[0].tile.xs, vec![0.1]);
        assert_eq!(selection.tiles[0].tile.ys, vec![0.1]);
        let overview = restored.select(&GraphCamera {
            x_min: 0.0, x_max: 1000.0, y_min: 0.0, y_max: 1000.0,
            viewport_width: 640, viewport_height: 360, device_pixel_ratio: 1.0,
        }).expect("approximate overview");
        assert!(!overview.exact);
        assert_eq!(overview.total_source_count, 8194);
        assert!(overview.selected_mark_count <= 1536);
    }

    #[test]
    fn asymmetric_cross_zero_bounds_keep_positive_endpoint_visible() {
        let mut builder = TilePyramidBuilder::new(4, 8, 1.5).expect("builder");
        builder
            .push_batch(&[
                SourcePoint::new(1, -1.0, -1.0),
                SourcePoint::new(2, 1e-20, 1e-20),
            ])
            .expect("points");
        let pyramid = builder.finish().expect("pyramid");
        let selection = pyramid
            .select(&GraphCamera {
                x_min: 5e-21,
                x_max: 1.5e-20,
                y_min: 5e-21,
                y_max: 1.5e-20,
                viewport_width: 640,
                viewport_height: 360,
                device_pixel_ratio: 1.0,
            })
            .expect("selection");
        assert!(selection.selected_mark_count > 0);
    }

    fn source_points() -> Vec<SourcePoint> {
        vec![
            SourcePoint::new(1, 0.0, 0.0),
            SourcePoint::new(2, 0.25, 0.25),
            SourcePoint::new(3, 0.5, 0.5),
            SourcePoint::new(4, 0.75, 0.75),
            SourcePoint::new(5, 1.0, 1.0),
            SourcePoint::new(6, f64::NAN, 2.0),
        ]
    }

    #[test]
    fn pyramid_is_deterministic_across_batch_sizes_and_preserves_all_source_counts() {
        let points = source_points();

        let mut one = bounded_builder(4, 8, 2.0);
        one.push_batch(&points[..2]).expect("batch one");
        one.push_batch(&points[2..4]).expect("batch two");
        one.push_batch(&points[4..]).expect("batch three");
        let one = one.finish().expect("pyramid one");

        let mut two = bounded_builder(4, 8, 2.0);
        let mut reversed = points.clone();
        reversed.reverse();
        two.push_batch(&reversed).expect("batch four");
        let two = two.finish().expect("pyramid two");

        assert_eq!(one.total_processed_rows, 6);
        assert_eq!(one.total_excluded_non_finite_rows, 1);
        assert_eq!(one.total_finite_rows, 5);
        assert_eq!(one.levels.len(), two.levels.len());
        for (left, right) in one.levels.iter().zip(two.levels.iter()) {
            assert_eq!(left.total_source_count, one.total_finite_rows);
            assert_eq!(right.total_source_count, two.total_finite_rows);
            assert_eq!(left.tiles.len(), right.tiles.len());
            assert_eq!(
                left.tiles[0].representative_row_ids,
                right.tiles[0].representative_row_ids
            );
        }
    }

    #[test]
    fn selection_is_bounded_for_a_fixed_viewport() {
        let mut builder = bounded_builder(5, 4, 1.5);
        builder.push_batch(&source_points()).expect("push points");
        let pyramid = builder.finish().expect("finish pyramid");

        let selection = pyramid
            .select(&GraphCamera {
                x_min: 0.0,
                x_max: 1.0,
                y_min: 0.0,
                y_max: 1.0,
                viewport_width: 640,
                viewport_height: 360,
                device_pixel_ratio: 1.0,
            })
            .expect("selection");

        assert!(selection.selected_mark_count <= 4);
        assert_eq!(selection.total_source_count, 5);
    }

    #[test]
    fn builder_rejects_max_tile_points_above_contract_limit() {
        let error = match TilePyramidBuilder::new(4, GRAPH_NEW_MAX_TILE_POINTS + 1, 1.5) {
            Ok(_) => panic!("builder must reject max tile points above the request contract"),
            Err(error) => error,
        };

        assert!(error.to_string().contains("max tile points"));
    }

    #[test]
    fn deep_zoom_retains_exact_points_when_visible_fine_tile_is_bounded() {
        let points = vec![
            SourcePoint::new(10, 0.10, 0.10),
            SourcePoint::new(11, 0.12, 0.11),
            SourcePoint::new(12, 0.14, 0.13),
            SourcePoint::new(13, 0.16, 0.14),
            SourcePoint::new(14, 0.85, 0.85),
        ];
        let mut builder = bounded_builder(4, 4, 1.5);
        builder.push_batch(&points).expect("push points");
        let pyramid = builder.finish().expect("finish pyramid");

        let selection = pyramid
            .select(&GraphCamera {
                x_min: 0.0,
                x_max: 0.2,
                y_min: 0.0,
                y_max: 0.2,
                viewport_width: 1920,
                viewport_height: 1080,
                device_pixel_ratio: 1.0,
            })
            .expect("selection");

        assert!(selection.exact);
        assert_eq!(selection.total_source_count, 4);
        assert_eq!(selection.tiles.len(), 1);
        assert_eq!(selection.tiles[0].tile.row_ids, vec![10, 11, 12, 13]);
        assert_eq!(selection.tiles[0].tile.counts, vec![1, 1, 1, 1]);
    }

    #[test]
    fn fine_tile_overflow_keeps_lowest_row_ids_deterministically() {
        let points = vec![
            SourcePoint::new(1, 0.100, 0.100),
            SourcePoint::new(2, 0.100, 0.100),
            SourcePoint::new(3, 0.100, 0.100),
            SourcePoint::new(4, 0.100, 0.100),
            SourcePoint::new(5, 0.100, 0.100),
            SourcePoint::new(6, 0.100, 0.100),
            SourcePoint::new(7, 0.100, 0.100),
            SourcePoint::new(8, 0.100, 0.100),
        ];

        let mut ascending = bounded_builder(3, 4, 2.0);
        ascending.push_batch(&points).expect("ascending points");
        let ascending = ascending.finish().expect("ascending pyramid");

        let mut descending = bounded_builder(3, 4, 2.0);
        let mut reversed = points.clone();
        reversed.reverse();
        descending.push_batch(&reversed).expect("descending points");
        let descending = descending.finish().expect("descending pyramid");

        assert_eq!(ascending.levels.len(), descending.levels.len());
        for (left, right) in ascending.levels.iter().zip(descending.levels.iter()) {
            assert_eq!(left.tiles.len(), right.tiles.len());
            assert_eq!(left.total_source_count, right.total_source_count);
            assert_eq!(left.retained_marks, right.retained_marks);
            assert_eq!(
                left.tiles[0].representative_row_ids,
                right.tiles[0].representative_row_ids
            );
        }

        let camera = GraphCamera {
            x_min: 0.095,
            x_max: 0.110,
            y_min: 0.095,
            y_max: 0.110,
            viewport_width: 1920,
            viewport_height: 1080,
            device_pixel_ratio: 1.0,
        };
        let ascending_selection = ascending.select_lod(&camera).expect("ascending LOD selection");
        let descending_selection = descending.select_lod(&camera).expect("descending LOD selection");

        assert_eq!(ascending_selection.level, 2);
        assert_eq!(descending_selection.level, 2);
        assert_eq!(ascending_selection.tiles.len(), 1);
        assert_eq!(descending_selection.tiles.len(), 1);
        assert_eq!(ascending_selection.tiles[0].tile.row_ids, vec![1, 2, 3, 4]);
        assert_eq!(descending_selection.tiles[0].tile.row_ids, vec![1, 2, 3, 4]);
        assert_eq!(
            ascending_selection.tiles[0].tile.xs,
            vec![0.100, 0.100, 0.100, 0.100]
        );
        assert_eq!(
            descending_selection.tiles[0].tile.xs,
            vec![0.100, 0.100, 0.100, 0.100]
        );
        assert_eq!(
            ascending_selection.tiles[0].tile.ys,
            vec![0.100, 0.100, 0.100, 0.100]
        );
        assert_eq!(
            descending_selection.tiles[0].tile.ys,
            vec![0.100, 0.100, 0.100, 0.100]
        );
        assert_eq!(ascending_selection.tiles[0].tile.counts, vec![5, 1, 1, 1]);
        assert_eq!(descending_selection.tiles[0].tile.counts, vec![5, 1, 1, 1]);
    }

    #[test]
    fn one_level_selection_fallback_stays_within_budget_and_preserves_total_count() {
        let points = (1..=20)
            .map(|row_id| SourcePoint::new(row_id, 0.25 + f64::from(row_id as i32) * 0.0001, 0.5))
            .collect::<Vec<_>>();
        let mut builder = bounded_builder(1, 16, 1.0);
        builder.push_batch(&points).expect("push points");
        let pyramid = builder.finish().expect("finish pyramid");

        let selection = pyramid
            .select(&GraphCamera {
                x_min: 0.0,
                x_max: 1.0,
                y_min: 0.0,
                y_max: 1.0,
                viewport_width: 640,
                viewport_height: 360,
                device_pixel_ratio: 1.0,
            })
            .expect("selection");

        assert_eq!(selection.level, 0);
        assert_eq!(selection.visible_tiles, 1);
        assert!(selection.selected_mark_count <= 4);
        assert_eq!(selection.total_source_count, 20);
        assert_eq!(selection.tiles.len(), 1);
        assert_eq!(
            selection.tiles[0].tile.row_ids.len(),
            selection.selected_mark_count
        );
        assert_eq!(
            selection.tiles[0].tile.counts.iter().copied().sum::<u32>(),
            20
        );
    }

    #[test]
    fn selection_rejects_invalid_camera_and_zero_finite_rows_stay_empty() {
        let builder = TilePyramidBuilder::new(4, 4, 1.5).expect("builder");
        let pyramid = builder.finish().expect("empty pyramid");
        let empty = pyramid
            .select(&GraphCamera {
                x_min: 0.0,
                x_max: 1.0,
                y_min: 0.0,
                y_max: 1.0,
                viewport_width: 100,
                viewport_height: 100,
                device_pixel_ratio: 1.0,
            })
            .expect("empty selection");
        assert_eq!(empty.selected_mark_count, 0);

        let mut filled = TilePyramidBuilder::new(4, 4, 1.5).expect("filled builder");
        filled.push_batch(&source_points()).expect("push points");
        let pyramid = filled.finish().expect("filled pyramid");
        let error = pyramid
            .select(&GraphCamera {
                x_min: f64::NAN,
                x_max: 1.0,
                y_min: 0.0,
                y_max: 1.0,
                viewport_width: 100,
                viewport_height: 100,
                device_pixel_ratio: 1.0,
            })
            .expect_err("invalid camera must fail");
        assert!(error.to_string().contains("camera domain"));
    }

    #[test]
    fn heap_capacity_stays_bounded_for_non_power_of_two_limits() {
        for cap in [1, 5, 4097] {
            let points = (1..=cap + 2)
                .rev()
                .map(|row_id| SourcePoint::new(i64::from(row_id), 0.5, 0.5))
                .collect::<Vec<_>>();
            let mut builder = TilePyramidBuilder::lossless(1, cap, 1.0).expect("builder");
            builder.push_batch(&points).expect("push");
            let pyramid = builder.finish().expect("bounded heap");
            let entry = &pyramid.levels[0].tiles[0];
            assert_eq!(entry.representative_row_ids, vec![1]);
            let tile = pyramid.tile_store.decode(&entry.address).expect("decode");
            assert_eq!(tile.row_ids, (1..=i64::from(cap.min(128))).collect::<Vec<_>>());
            assert_eq!(pyramid.raw_store.as_ref().expect("lossless store").finite_count, u64::from(cap + 2));
            assert_eq!(
                tile.counts
                    .iter()
                    .map(|count| u64::from(*count))
                    .sum::<u64>(),
                u64::from(cap + 2)
            );
        }
    }

    fn colliding_fine_points(cap: u32) -> Vec<SourcePoint> {
        let mut points = (1..=cap)
            .map(|row_id| SourcePoint::new(i64::from(row_id), 0.0, 0.0))
            .collect::<Vec<_>>();
        points.extend(
            (cap + 1..=2 * cap).map(|row_id| SourcePoint::new(i64::from(row_id), 0.5, 0.5)),
        );
        points.push(SourcePoint::new(i64::from(2 * cap + 1), 1.0, 1.0));
        assert_eq!(super::bucket_index(0, 0, 16), 0);
        assert_eq!(super::bucket_index(8, 8, 16), 0);
        points
    }

    fn fine_emission_minimum(pyramid: &super::TilePyramid, cap: u32) -> u64 {
        let coarse_tiles = pyramid.levels[..4]
            .iter()
            .map(|level| level.tiles.len() as u64)
            .sum::<u64>();
        let level_entries = coarse_tiles + pyramid.levels[4].tiles.len() as u64;
        super::estimate_construction_memory(
            16,
            level_entries,
            2 * u64::from(cap) * std::mem::size_of::<super::RowIdPoint>() as u64,
            coarse_tiles + 1,
            4,
            u64::from(cap) * super::tile_payload_point_bytes()
                + super::estimate_encoded_tile_bytes(cap as usize).expect("encoded bytes"),
        ) + 2 * super::FINE_TILE_ENTRY_BYTES_ESTIMATE
    }

    #[test]
    fn fine_emission_accounts_remaining_heaps_and_overlapping_buffers() {
        let cap = 1024;
        let mut builder = bounded_builder(5, cap, 1.0);
        builder
            .push_batch(&colliding_fine_points(cap))
            .expect("push");
        let pyramid = builder.finish().expect("finish");
        assert!(pyramid.accounted_memory_bytes >= fine_emission_minimum(&pyramid, cap));
        assert!(pyramid
            .levels
            .iter()
            .flat_map(|level| &level.tiles)
            .all(|tile| tile.representative_row_ids.len() == 1));
    }

    #[test]
    fn fine_emission_rejects_cap_before_overlapping_allocations() {
        let cap = 1024;
        let points = colliding_fine_points(cap);
        let mut reference = bounded_builder(5, cap, 1.0);
        reference.push_batch(&points).expect("push");
        let reference = reference.finish().expect("reference finish");
        let limit = fine_emission_minimum(&reference, cap) - 1;
        let mut builder =
            TilePyramidBuilder::with_memory_limit(5, cap, 1.0, limit).expect("builder");
        builder.push_batch(&points).expect("push below cap");
        let error = builder.finish().expect_err("emission must exceed cap");
        assert!(matches!(error, crate::error::AppError::Busy(_)));
    }

    #[test]
    fn cancellation_is_checked_between_fine_tile_emissions() {
        let mut points = Vec::new();
        for tile_x in 0..64 {
            for tile_y in 0..64 {
                if super::bucket_index(tile_x, tile_y, 16) == 0 {
                    points.push(SourcePoint::new(
                        points.len() as i64 + 1,
                        f64::from(tile_x) / 63.0,
                        f64::from(tile_y) / 63.0,
                    ));
                }
            }
        }
        assert_eq!(points.len(), 256);
        let mut builder = bounded_builder(7, 1, 1.0);
        builder.push_batch(&points).expect("push");
        let calls = std::cell::Cell::new(0);
        let cancel_checkpoint = 2 + 6 + 2 * super::bucket_count_for(7) + 2;
        let error = builder
            .finish_with_control(&|| {
                calls.set(calls.get() + 1);
                if calls.get() == cancel_checkpoint {
                    Err(crate::error::AppError::InvalidParam(
                        "cancel during fine emission".to_string(),
                    ))
                } else {
                    Ok(())
                }
            })
            .err()
            .expect("cancel between emissions");
        assert!(
            error.to_string().contains("cancel during fine emission"),
            "{error}"
        );
        assert_eq!(calls.get(), cancel_checkpoint);
    }

    #[test]
    fn cancellation_is_checked_before_returning_finished_pyramid() {
        let mut builder = bounded_builder(1, 4, 1.0);
        builder
            .push_batch(&[SourcePoint::new(1, 0.0, 0.0)])
            .expect("push");
        let calls = std::cell::Cell::new(0);
        let result = builder.finish_with_control(&|| {
            calls.set(calls.get() + 1);
            if calls.get() == 36 {
                Err(crate::error::AppError::InvalidParam(
                    "cancel before finish".to_string(),
                ))
            } else {
                Ok(())
            }
        });
        assert!(result
            .expect_err("final cancellation")
            .to_string()
            .contains("cancel before finish"));
    }

    #[test]
    fn distinct_finite_domains_preserve_endpoints() {
        for (min, max) in [
            (0.0, 1e-20),
            (0.0, f64::from_bits(1)),
            (-f64::from_bits(2), f64::from_bits(2)),
            (f64::MAX.next_down(), f64::MAX),
        ] {
            assert_eq!(super::normalize_axis(min, max), (min, max));
            assert_eq!(super::normalized_position(min, min, max), 0.0);
            assert!(super::normalized_position(max, min, max) > 0.99);
        }
    }

    #[test]
    fn tiny_and_subnormal_positions_keep_interior_spacing() {
        for (min, middle, max) in [
            (0.0, 5e-21, 1e-20),
            (0.0, f64::from_bits(1), f64::from_bits(2)),
            (-f64::from_bits(2), 0.0, f64::from_bits(2)),
            (
                f64::MAX.next_down().next_down(),
                f64::MAX.next_down(),
                f64::MAX,
            ),
        ] {
            assert_eq!(super::normalized_position(min, min, max), 0.0);
            assert_eq!(super::normalized_position(middle, min, max), 0.5);
            assert!(super::normalized_position(max, min, max) > 0.99);
        }
    }

    #[test]
    fn tiny_subnormal_and_adjacent_large_tiles_round_trip() {
        for (min, max) in [
            (0.0, 1e-20),
            (0.0, f64::from_bits(1)),
            (-f64::from_bits(2), f64::from_bits(2)),
            (f64::MAX.next_down(), f64::MAX),
        ] {
            let mut builder = bounded_builder(4, 4, 1.0);
            builder
                .push_batch(&[SourcePoint::new(1, min, min), SourcePoint::new(2, max, max)])
                .expect("endpoints");
            let pyramid = builder.finish().expect("finite endpoint pyramid");
            assert_eq!((pyramid.domain.x_min, pyramid.domain.x_max), (min, max));
            let fine = pyramid.levels.last().expect("fine level");
            assert_eq!(fine.tiles.len(), 2);
            assert_eq!(fine.tiles[0].address.tile_x, 0);
            assert_eq!(fine.tiles[1].address.tile_x, 7);
            for entry in &fine.tiles {
                let tile = pyramid.tile_store.decode(&entry.address).expect("decode");
                assert_eq!(entry.representative_row_ids.len(), 1);
                assert_eq!(tile.row_ids.len(), 1);
            }
        }
    }

    #[test]
    fn builder_enforces_memory_cap_and_handles_extreme_domains() {
        assert!(TilePyramidBuilder::with_memory_limit(4, 4, 1.5, 1).is_err(),
            "reject before allocating construction buffers beyond the cap");

        let mut builder = TilePyramidBuilder::new(4, 8, 1.5).expect("builder");
        builder
            .push_batch(&[
                SourcePoint::new(1, -f64::MAX, -f64::MAX),
                SourcePoint::new(2, f64::MAX, f64::MAX),
                SourcePoint::new(3, f64::MIN_POSITIVE, f64::MIN_POSITIVE),
            ])
            .expect("push extremes");
        let pyramid = builder.finish().expect("extreme pyramid");
        assert_eq!(pyramid.total_finite_rows, 3);
        assert!(pyramid.domain.x_min < pyramid.domain.x_max);
        assert!(pyramid.domain.y_min < pyramid.domain.y_max);
    }
}
