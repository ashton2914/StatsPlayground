use std::fs::File;
use std::io::{BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::sync::{Arc, Mutex};

use sha2::{Digest, Sha256};
use tempfile::tempfile;

use super::graph_new_lod::{GraphCamera, SourcePoint};
use crate::error::AppError;

const RECORD_BYTES: u64 = 32;
const BLOCK_BYTES: u64 = 80;
const PAGE_POINTS: usize = 128;
const BUFFER_POINTS: usize = 4096;
const MAGIC: &[u8; 8] = b"GNRAW002";
pub const QUERY_SCRATCH_BYTES: u64 = 64 * 1024 * 1024;

#[derive(PartialEq)]
struct FileStamp {
    bytes: u64,
    modified: std::time::SystemTime,
}

fn file_stamp(file: &File) -> Result<FileStamp, AppError> {
    let metadata = file.metadata()?;
    Ok(FileStamp { bytes: metadata.len(), modified: metadata.modified()? })
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SourceRecord {
    pub scan_ordinal: u64,
    pub point: SourcePoint,
}

#[derive(Debug, Clone)]
struct Block {
    offset: u64,
    count: u64,
    bounds: [f64; 4],
    checksum: [u8; 32],
}

#[derive(Debug, Clone, Copy, Default)]
pub struct QueryWork {
    pub index_entries_inspected: u64,
    pub raw_blocks_inspected: u64,
    pub raw_points_inspected: u64,
}

pub struct RawQuery {
    pub records: Vec<SourceRecord>,
    pub visible_count: u64,
    pub exact: bool,
    pub work: QueryWork,
}

pub struct RawStore {
    file_stamp: FileStamp,
    gaps_stamp: FileStamp,
    file: Arc<Mutex<File>>,
    gaps: Arc<Mutex<File>>,
    data_start: u64,
    gaps_start: u64,
    blocks: Vec<Block>,
    pub finite_count: u64,
    pub gap_count: u64,
}

pub struct RawWriter {
    file: BufWriter<File>,
    gaps: BufWriter<File>,
    buffer: Vec<SourceRecord>,
    blocks: Vec<Block>,
    finite_count: u64,
    gap_count: u64,
    written: u64,
    memory_limit: u64,
}

impl RawWriter {
    pub fn new(memory_limit: u64) -> Result<Self, AppError> {
        if memory_limit < 2 * 8192 + BUFFER_POINTS as u64 * RECORD_BYTES {
            return Err(pressure());
        }
        Ok(Self {
            file: BufWriter::with_capacity(8192, tempfile()?),
            gaps: BufWriter::with_capacity(8192, tempfile()?),
            buffer: Vec::with_capacity(BUFFER_POINTS), blocks: Vec::new(),
            finite_count: 0, gap_count: 0, written: 0, memory_limit,
        })
    }

    pub fn memory_bytes(&self) -> u64 {
        2 * 8192 + self.buffer.capacity() as u64 * RECORD_BYTES
            + self.blocks.capacity() as u64 * std::mem::size_of::<Block>() as u64
            + 8192
    }

    pub fn disk_bytes(&self) -> u64 {
        (self.finite_count + self.gap_count) * RECORD_BYTES
    }

    pub fn push(&mut self, point: SourcePoint, scan_ordinal: u64) -> Result<(), AppError> {
        let record = SourceRecord { scan_ordinal, point };
        if point.x.is_finite() && point.y.is_finite() {
            self.finite_count += 1;
            self.buffer.push(record);
            if self.buffer.len() == BUFFER_POINTS { self.flush_pages()?; }
        } else {
            self.gap_count += 1;
            self.gaps.write_all(&encode(record))?;
        }
        Ok(())
    }

    fn flush_pages(&mut self) -> Result<(), AppError> {
        let additional = self.buffer.len().div_ceil(PAGE_POINTS);
        if self.memory_bytes() + additional as u64 * BLOCK_BYTES > self.memory_limit {
            return Err(pressure());
        }
        self.blocks.try_reserve_exact(additional).map_err(|_| pressure())?;
        if self.memory_bytes() > self.memory_limit { return Err(pressure()); }
        spatial_partition(&mut self.buffer);
        for page in self.buffer.chunks(PAGE_POINTS) {
            let mut bytes = Vec::with_capacity(page.len() * RECORD_BYTES as usize);
            for record in page { bytes.extend_from_slice(&encode(*record)); }
            let checksum = Sha256::digest(&bytes).into();
            self.blocks.push(Block { offset: self.written, count: page.len() as u64,
                bounds: bounds(page), checksum });
            self.file.write_all(&bytes)?;
            self.written += bytes.len() as u64;
        }
        self.buffer.clear();
        Ok(())
    }

    pub fn finish(mut self) -> Result<RawStore, AppError> {
        self.flush_pages()?;
        let file = self.file.into_inner().map_err(|error| AppError::FileIO(error.to_string()))?;
        let gaps = self.gaps.into_inner().map_err(|error| AppError::FileIO(error.to_string()))?;
        Ok(RawStore { file_stamp: file_stamp(&file)?, gaps_stamp: file_stamp(&gaps)?,
            file: Arc::new(Mutex::new(file)), gaps: Arc::new(Mutex::new(gaps)),
            data_start: 0, gaps_start: 0, blocks: self.blocks,
            finite_count: self.finite_count, gap_count: self.gap_count })
    }
}

impl RawStore {
    pub fn validate_domain(&self, domain: super::graph_new_lod::GraphDomain) -> Result<(), AppError> {
        if self.blocks.iter().any(|block| block.bounds[0] < domain.x_min || block.bounds[1] > domain.x_max
            || block.bounds[2] < domain.y_min || block.bounds[3] > domain.y_max) { return Err(invalid()); }
        Ok(())
    }

    pub fn resident_bytes(&self) -> u64 {
        std::mem::size_of::<Self>() as u64
            + self.blocks.capacity() as u64 * std::mem::size_of::<Block>() as u64
    }

    pub fn disk_bytes(&self) -> u64 { (self.finite_count + self.gap_count) * RECORD_BYTES }

    pub fn persisted_bytes(&self) -> u64 {
        32 + self.blocks.len() as u64 * BLOCK_BYTES + self.disk_bytes()
    }

    pub fn query(&self, camera: &GraphCamera, budget: usize,
        control: &dyn Fn() -> Result<(), AppError>) -> Result<RawQuery, AppError> {
        control()?;
        if budget > super::graph_new_renderer::MAX_SCENE_POINTS { return Err(pressure()); }
        self.validate_files()?;
        let mut result = RawQuery { records: Vec::new(), visible_count: 0, exact: true,
            work: QueryWork::default() };
        let mut file = self.file.lock().map_err(|_| invalid())?;
        for block in &self.blocks {
            if result.work.index_entries_inspected % 256 == 0 { control()?; }
            result.work.index_entries_inspected += 1;
            if !intersects(block.bounds, camera) { continue; }
            let fully_inside = contains_bounds(camera, block.bounds);
            if fully_inside && result.visible_count + block.count > budget as u64 {
                result.visible_count += block.count;
                result.exact = false;
                result.records.clear();
                continue;
            }
            control()?;
            let records = read_block(&mut file, self.data_start, block)?;
            result.work.raw_blocks_inspected += 1;
            result.work.raw_points_inspected += block.count;
            for record in records {
                if contains(camera, record.point) {
                    result.visible_count += 1;
                    if result.visible_count <= budget as u64 {
                        result.records.push(record);
                    } else {
                        result.exact = false;
                        result.records.clear();
                    }
                }
            }
        }
        control()?;
        result.records.sort_unstable_by_key(|record| record.scan_ordinal);
        Ok(result)
    }

    pub fn visit_source(&self, control: &dyn Fn() -> Result<(), AppError>,
        visitor: &mut dyn FnMut(SourceRecord) -> Result<(), AppError>) -> Result<(), AppError> {
        self.validate_files()?;
        {
            let mut file = self.file.lock().map_err(|_| invalid())?;
            for block in &self.blocks {
                control()?;
                for record in read_block(&mut file, self.data_start, block)? { visitor(record)?; }
            }
        }
        let mut file = self.gaps.lock().map_err(|_| invalid())?;
        file.seek(SeekFrom::Start(self.gaps_start))?;
        let mut reader = BufReader::with_capacity(8192, &mut *file);
        let mut previous = None;
        for ordinal in 0..self.gap_count {
            if ordinal % 128 == 0 { control()?; }
            let record = read_record(&mut reader)?;
            if record.point.row_id <= 0 || (record.point.x.is_finite() && record.point.y.is_finite())
                || previous.is_some_and(|previous| previous >= record.scan_ordinal) { return Err(invalid()); }
            previous = Some(record.scan_ordinal);
            visitor(record)?;
        }
        Ok(())
    }

    pub fn write_cache(&self, output: &mut impl Write) -> Result<(), AppError> {
        self.validate_files()?;
        let mut index = BufWriter::with_capacity(1024, &mut *output);
        index.write_all(MAGIC)?;
        for value in [self.blocks.len() as u64, self.finite_count, self.gap_count] {
            index.write_all(&value.to_le_bytes())?;
        }
        for block in &self.blocks {
            for value in [block.offset, block.count] { index.write_all(&value.to_le_bytes())?; }
            for value in block.bounds { index.write_all(&value.to_le_bytes())?; }
            index.write_all(&block.checksum)?;
        }
        index.flush()?;
        drop(index);
        copy_section(&self.file, self.data_start, self.finite_count * RECORD_BYTES, output)?;
        copy_section(&self.gaps, self.gaps_start, self.gap_count * RECORD_BYTES, output)
    }

    pub fn read_cache(file: Arc<Mutex<File>>, end: u64, finite: u64, gaps: u64,
        memory_limit: u64) -> Result<Self, AppError> {
        let mut source = file.lock().map_err(|_| invalid())?;
        let mut magic = [0; 8]; source.read_exact(&mut magic)?;
        let block_count = read_u64(&mut *source)?;
        if &magic != MAGIC || read_u64(&mut *source)? != finite || read_u64(&mut *source)? != gaps {
            return Err(invalid());
        }
        let rows = finite.checked_add(gaps).ok_or_else(invalid)?;
        let data_bytes = rows.checked_mul(RECORD_BYTES).ok_or_else(invalid)?;
        let index_bytes = block_count.checked_mul(BLOCK_BYTES).ok_or_else(invalid)?;
        if source.stream_position()?.checked_add(index_bytes).and_then(|offset| offset.checked_add(data_bytes)) != Some(end)
            || block_count > finite || (finite > 0 && block_count == 0) { return Err(invalid()); }
        let bitmap_bytes = rows.div_ceil(8);
        if index_bytes.saturating_add(bitmap_bytes).saturating_add(QUERY_SCRATCH_BYTES) > memory_limit {
            return Err(pressure());
        }
        let mut blocks = Vec::new();
        blocks.try_reserve_exact(usize::try_from(block_count).map_err(|_| pressure())?).map_err(|_| pressure())?;
        let mut offset = 0;
        for _ in 0..block_count {
            let stored_offset = read_u64(&mut *source)?;
            let count = read_u64(&mut *source)?;
            let mut bounds = [0.0; 4];
            for value in &mut bounds { *value = f64::from_bits(read_u64(&mut *source)?); }
            let mut checksum = [0; 32]; source.read_exact(&mut checksum)?;
            if stored_offset != offset || count == 0 || count > PAGE_POINTS as u64
                || !bounds.iter().all(|value| value.is_finite()) || bounds[0] > bounds[1] || bounds[2] > bounds[3] {
                return Err(invalid());
            }
            offset = offset.checked_add(count * RECORD_BYTES).ok_or_else(invalid)?;
            blocks.push(Block { offset: stored_offset, count, bounds, checksum });
        }
        if offset != finite.checked_mul(RECORD_BYTES).ok_or_else(invalid)? { return Err(invalid()); }
        let data_start = source.stream_position()?;
        let gaps_start = data_start + offset;
        let stored_stamp = file_stamp(&source)?;
        let gaps_stamp = file_stamp(&source)?;
        drop(source);
        let result = Self { file_stamp: stored_stamp, gaps_stamp,
            file: file.clone(), gaps: file, data_start, gaps_start, blocks,
            finite_count: finite, gap_count: gaps };
        let mut seen = vec![0u8; usize::try_from(bitmap_bytes).map_err(|_| pressure())?];
        result.visit_source(&|| Ok(()), &mut |record| {
            if record.scan_ordinal >= rows { return Err(invalid()); }
            let slot = &mut seen[(record.scan_ordinal / 8) as usize];
            let mask = 1 << (record.scan_ordinal % 8);
            if *slot & mask != 0 { return Err(invalid()); }
            *slot |= mask;
            Ok(())
        })?;
        result.file.lock().map_err(|_| invalid())?.seek(SeekFrom::Start(end))?;
        Ok(result)
    }

    fn validate_files(&self) -> Result<(), AppError> {
        if file_stamp(&*self.file.lock().map_err(|_| invalid())?)? != self.file_stamp {
            return Err(invalid());
        }
        if file_stamp(&*self.gaps.lock().map_err(|_| invalid())?)? != self.gaps_stamp {
            return Err(invalid());
        }
        Ok(())
    }
}

fn spatial_partition(records: &mut [SourceRecord]) {
    if records.len() <= PAGE_POINTS { return; }
    let bounds = bounds(records);
    let use_x = bounds[1] / 2.0 - bounds[0] / 2.0 >= bounds[3] / 2.0 - bounds[2] / 2.0;
    let middle = (records.len().div_ceil(PAGE_POINTS) / 2) * PAGE_POINTS;
    records.select_nth_unstable_by(middle, |left, right| {
        let (left_value, right_value) = if use_x { (left.point.x, right.point.x) } else { (left.point.y, right.point.y) };
        left_value.total_cmp(&right_value).then(left.scan_ordinal.cmp(&right.scan_ordinal))
    });
    let (left, right) = records.split_at_mut(middle);
    spatial_partition(left);
    spatial_partition(right);
}

fn bounds(records: &[SourceRecord]) -> [f64; 4] {
    let mut bounds = [f64::INFINITY, f64::NEG_INFINITY, f64::INFINITY, f64::NEG_INFINITY];
    for record in records {
        bounds[0] = bounds[0].min(record.point.x); bounds[1] = bounds[1].max(record.point.x);
        bounds[2] = bounds[2].min(record.point.y); bounds[3] = bounds[3].max(record.point.y);
    }
    bounds
}

fn intersects(bounds: [f64; 4], camera: &GraphCamera) -> bool {
    bounds[1] >= camera.x_min && bounds[0] <= camera.x_max
        && bounds[3] >= camera.y_min && bounds[2] <= camera.y_max
}

fn contains_bounds(camera: &GraphCamera, bounds: [f64; 4]) -> bool {
    bounds[0] >= camera.x_min && bounds[1] <= camera.x_max
        && bounds[2] >= camera.y_min && bounds[3] <= camera.y_max
}

pub fn contains(camera: &GraphCamera, point: SourcePoint) -> bool {
    point.x >= camera.x_min && point.x <= camera.x_max
        && point.y >= camera.y_min && point.y <= camera.y_max
}

fn read_block(file: &mut File, start: u64, block: &Block) -> Result<Vec<SourceRecord>, AppError> {
    file.seek(SeekFrom::Start(start + block.offset))?;
    let mut bytes = [0u8; PAGE_POINTS * RECORD_BYTES as usize];
    let bytes = &mut bytes[..(block.count * RECORD_BYTES) as usize];
    file.read_exact(bytes)?;
    if Sha256::digest(&*bytes).as_slice() != block.checksum { return Err(invalid()); }
    let records = bytes.chunks_exact(RECORD_BYTES as usize).map(|mut bytes| read_record(&mut bytes)).collect::<Result<Vec<_>, _>>()?;
    if records.iter().any(|record| record.point.row_id <= 0 || !record.point.x.is_finite() || !record.point.y.is_finite())
        || bounds(&records) != block.bounds { return Err(invalid()); }
    Ok(records)
}

fn encode(record: SourceRecord) -> [u8; 32] {
    let mut bytes = [0; 32];
    bytes[..8].copy_from_slice(&record.scan_ordinal.to_le_bytes());
    bytes[8..16].copy_from_slice(&record.point.row_id.to_le_bytes());
    bytes[16..24].copy_from_slice(&record.point.x.to_le_bytes());
    bytes[24..].copy_from_slice(&record.point.y.to_le_bytes());
    bytes
}

fn read_record(reader: &mut impl Read) -> Result<SourceRecord, AppError> {
    Ok(SourceRecord { scan_ordinal: read_u64(reader)?, point: SourcePoint::new(
        read_u64(reader)? as i64, f64::from_bits(read_u64(reader)?), f64::from_bits(read_u64(reader)?)) })
}

fn read_u64(reader: &mut impl Read) -> Result<u64, AppError> {
    let mut bytes = [0; 8]; reader.read_exact(&mut bytes)?; Ok(u64::from_le_bytes(bytes))
}

fn copy_section(source: &Arc<Mutex<File>>, offset: u64, length: u64, output: &mut impl Write) -> Result<(), AppError> {
    let mut source = source.lock().map_err(|_| invalid())?;
    source.seek(SeekFrom::Start(offset))?;
    if std::io::copy(&mut (&mut *source).take(length), output)? != length { return Err(invalid()); }
    Ok(())
}

fn invalid() -> AppError { AppError::Stats("graph_new_invalid_cache".into()) }
fn pressure() -> AppError { AppError::Stats("graph_new_cache_pressure".into()) }

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> RawStore {
        let mut writer = RawWriter::new(1024 * 1024).expect("writer");
        for (ordinal, point) in [SourcePoint::new(8, 2.0, -0.0),
            SourcePoint::new(2, f64::from_bits(0x7ff8000000000001), 7.0),
            SourcePoint::new(9, -3.5, 6.25), SourcePoint::new(4, 2.0, f64::INFINITY)]
            .into_iter().enumerate() {
            writer.push(point, ordinal as u64).expect("point");
        }
        writer.finish().expect("finish")
    }

    fn bytes(store: &RawStore) -> Vec<u8> {
        let mut file = tempfile().expect("file");
        store.write_cache(&mut file).expect("write");
        file.seek(SeekFrom::Start(0)).expect("rewind");
        let mut bytes = Vec::new(); file.read_to_end(&mut bytes).expect("bytes"); bytes
    }

    fn restore(bytes: &[u8], memory: u64) -> Result<RawStore, AppError> {
        let mut file = tempfile()?;
        file.write_all(bytes)?; file.seek(SeekFrom::Start(0))?;
        RawStore::read_cache(Arc::new(Mutex::new(file)), bytes.len() as u64, 2, 2, memory)
    }

    #[test]
    fn graph_new_raw_cache_writes_are_batched_and_lossless() {
        struct CountedFile {
            file: File,
            writes: usize,
        }
        impl Write for CountedFile {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                self.writes += 1;
                self.file.write(bytes)
            }
            fn flush(&mut self) -> std::io::Result<()> { self.file.flush() }
        }

        let mut writer = RawWriter::new(1024 * 1024).expect("writer");
        for ordinal in 0..8193u64 {
            let x = if ordinal == 4096 { f64::from_bits(0x7ff8000000000001) }
                else { f64::from_bits(1.0f64.to_bits() + ordinal) };
            writer.push(SourcePoint::new((ordinal + 1) as i64, x, -0.0), ordinal).expect("point");
        }
        let store = writer.finish().expect("store");
        let mut output = CountedFile { file: tempfile().expect("file"), writes: 0 };
        store.write_cache(&mut output).expect("write cache");
        let length = output.file.stream_position().expect("length");
        assert_eq!(length, 267328);
        output.file.seek(SeekFrom::Start(0)).expect("rewind");
        let restored = RawStore::read_cache(Arc::new(Mutex::new(output.file)), length,
            8192, 1, 128 * 1024 * 1024).expect("restore");
        let mut visited = 0;
        restored.visit_source(&|| Ok(()), &mut |record| {
            assert_eq!(record.point.row_id, (record.scan_ordinal + 1) as i64);
            let expected_x = if record.scan_ordinal == 4096 { 0x7ff8000000000001 }
                else { 1.0f64.to_bits() + record.scan_ordinal };
            assert_eq!(record.point.x.to_bits(), expected_x);
            assert_eq!(record.point.y.to_bits(), (-0.0f64).to_bits());
            visited += 1;
            Ok(())
        }).expect("visit");
        assert_eq!(visited, 8193);
        let max_writes = (32 + 64 * 80usize).div_ceil(1024)
            + (8192 * 32usize).div_ceil(8192) + 1;
        eprintln!("raw cache: {} writes for {length} bytes", output.writes);
        assert!(output.writes <= max_writes,
            "raw cache used {} writes, bounded batched maximum is {max_writes}", output.writes);
    }

    #[test]
    fn graph_new_raw_cache_propagates_buffered_index_write_failure() {
        struct FailFirstWrite(bool);
        impl Write for FailFirstWrite {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                if std::mem::replace(&mut self.0, false) {
                    Err(std::io::Error::other("index write failed"))
                } else {
                    Ok(bytes.len())
                }
            }
            fn flush(&mut self) -> std::io::Result<()> { Ok(()) }
        }
        assert!(matches!(fixture().write_cache(&mut FailFirstWrite(true)), Err(AppError::FileIO(_))));
    }

    #[test]
    fn graph_new_raw_roundtrip_retains_scan_ordinal_identity_and_gap_bits() {
        let store = fixture();
        let restored = restore(&bytes(&store), 128 * 1024 * 1024).expect("restore");
        let mut records = Vec::new();
        restored.visit_source(&|| Ok(()), &mut |record| { records.push(record); Ok(()) }).expect("visit");
        records.sort_unstable_by_key(|record| record.scan_ordinal);
        assert_eq!(records.iter().map(|record| (record.scan_ordinal, record.point.row_id)).collect::<Vec<_>>(),
            vec![(0, 8), (1, 2), (2, 9), (3, 4)]);
        assert_eq!(records[0].point.y.to_bits(), (-0.0f64).to_bits());
        assert_eq!(records[1].point.x.to_bits(), 0x7ff8000000000001);
        assert_eq!(records[1].point.y, 7.0);
        assert_eq!(records[2].point, SourcePoint::new(9, -3.5, 6.25));
        assert_eq!(records[3].point.y, f64::INFINITY);
        assert_eq!(store.disk_bytes(), 128);
        assert_eq!(store.persisted_bytes(), bytes(&store).len() as u64);
    }

    #[test]
    fn graph_new_raw_rejects_lengths_schema_offsets_counts_bounds_order_and_coordinates() {
        for corruption in ["version", "offset", "count", "bounds", "nan", "row_id", "duplicate_ordinal", "gap_order", "truncated", "trailing"] {
            let mut data = bytes(&fixture());
            match corruption {
                "version" => data[7] = b'1',
                "offset" => data[32..40].copy_from_slice(&32u64.to_le_bytes()),
                "count" => data[40..48].copy_from_slice(&u64::MAX.to_le_bytes()),
                "bounds" => data[48..56].copy_from_slice(&(-4.0f64).to_le_bytes()),
                "nan" => data[128..136].copy_from_slice(&f64::NAN.to_le_bytes()),
                "row_id" => data[120..128].copy_from_slice(&0u64.to_le_bytes()),
                "duplicate_ordinal" => data[144..152].copy_from_slice(&0u64.to_le_bytes()),
                "gap_order" => data[208..216].copy_from_slice(&1u64.to_le_bytes()),
                "truncated" => { data.pop(); },
                _ => data.push(0),
            }
            if matches!(corruption, "nan" | "row_id" | "duplicate_ordinal") {
                let checksum = Sha256::digest(&data[112..176]);
                data[80..112].copy_from_slice(&checksum);
            }
            assert!(restore(&data, 128 * 1024 * 1024).is_err(), "{corruption}");
        }
        assert!(restore(&bytes(&fixture()), 1).is_err());
    }

    #[test]
    fn graph_new_raw_query_cancels_before_more_than_one_page_of_work() {
        let mut writer = RawWriter::new(1024 * 1024).expect("writer");
        for ordinal in 0..4096 {
            writer.push(SourcePoint::new(ordinal + 1, ordinal as f64, 1.0), ordinal as u64).expect("point");
        }
        let store = writer.finish().expect("store");
        let checks = std::cell::Cell::new(0);
        let result = store.query(&GraphCamera { x_min: 0.0, x_max: 4096.0, y_min: 0.0, y_max: 2.0,
            viewport_width: 640, viewport_height: 360, device_pixel_ratio: 1.0 }, 4096, &|| {
            checks.set(checks.get() + 1);
            if checks.get() >= 4 { Err(AppError::Cancelled("cancelled".into())) } else { Ok(()) }
        });
        assert!(matches!(result, Err(AppError::Cancelled(_))));
        assert_eq!(checks.get(), 4);
    }
}