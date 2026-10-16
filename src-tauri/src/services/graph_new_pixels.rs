//! Complete-source, physical-pixel scatter aggregation.
use super::graph_new_lod::GraphDomain;
#[cfg(test)]
use super::graph_new_lod::SourcePoint;
use super::graph_new_overlay::{EnabledOverlayMask, OverlayCatalog};
use super::graph_new_raw::QueryWork;
use super::graph_new_ticks::normalized;
use crate::error::AppError;
use std::{
    fs::File,
    io::{BufReader, BufWriter, Read, Write},
    sync::Mutex,
};

const BATCH: usize = 65_536;
const LEAF: usize = 1_024;
const BORDER: usize = 8;
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Record {
    x: f64,
    y: f64,
    group: u64,
}
#[derive(Debug)]
struct Block {
    start: usize,
    len: usize,
    bounds: [f64; 4],
}
#[derive(Debug)]
struct Centers {
    domain: GraphDomain,
    frame: [u32; 2],
    plot: [u32; 4],
    bits: Vec<u64>,
    counts: [u64; 64],
}
#[derive(Debug)]
pub(crate) struct PixelStore {
    map: Option<memmap2::Mmap>,
    blocks: Vec<Block>,
    last: Mutex<Option<Centers>>,
}
pub(crate) struct PixelRaster {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
    pub visible: u64,
    pub occupied: usize,
    pub work: QueryWork,
}
fn pressure() -> AppError {
    AppError::Stats("graph_new_cache_pressure".into())
}
fn invalid() -> AppError {
    AppError::Stats("graph_new_render_failed".into())
}
fn bounds(p: &[Record]) -> [f64; 4] {
    let mut b = [
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::INFINITY,
        f64::NEG_INFINITY,
    ];
    for p in p {
        b[0] = b[0].min(p.x);
        b[1] = b[1].max(p.x);
        b[2] = b[2].min(p.y);
        b[3] = b[3].max(p.y);
    }
    b
}
fn partition(p: &mut [Record]) {
    if p.len() <= LEAF {
        return;
    }
    let b = bounds(p);
    let x = (b[1] / 2. - b[0] / 2.) >= (b[3] / 2. - b[2] / 2.);
    let mid = (p.len().div_ceil(LEAF) / 2) * LEAF;
    p.select_nth_unstable_by(mid, |a, b| {
        if x {
            a.x.total_cmp(&b.x)
        } else {
            a.y.total_cmp(&b.y)
        }
    });
    let (a, b) = p.split_at_mut(mid);
    partition(a);
    partition(b);
}
fn project(x: f64, y: f64, d: GraphDomain, w: usize, h: usize) -> Option<(usize, usize)> {
    let nx = normalized(x, d.x_min, d.x_max);
    let ny = normalized(y, d.y_min, d.y_max);
    if !nx.is_finite() || !ny.is_finite() {
        return None;
    }
    let axis = |n: f64, size: usize| {
        let v = if (0.0..=1.0).contains(&n) {
            (n * size as f64).floor().min((size - 1) as f64)
        } else {
            (n * size as f64).floor()
        };
        if v < -(BORDER as f64) || v >= (size + BORDER) as f64 {
            None
        } else {
            Some((v as isize + BORDER as isize) as usize)
        }
    };
    Some((axis(nx, w)?, axis(ny, h)?))
}
impl PixelStore {
    pub(crate) fn record_count(&self) -> u64 { self.map.as_ref().map_or(0, |map| map.len() as u64 / 24) }
    pub(crate) fn visit_source(&self, control: &dyn Fn() -> Result<(), AppError>, visitor: &mut dyn FnMut(super::graph_new_raw::SourceRecord) -> Result<(), AppError>) -> Result<(), AppError> {
        let Some(map) = &self.map else {return Ok(())};
        for (i, bytes) in map.chunks_exact(24).enumerate() {
            if i % 4096 == 0 {control()?;}
            let record: Record = bytemuck::pod_read_unaligned(bytes);
            visitor(super::graph_new_raw::SourceRecord {scan_ordinal:i as u64, point:super::graph_new_lod::SourcePoint::with_group(i as i64+1,record.x,record.y,record.group as u16)})?;
        }
        Ok(())
    }
    pub fn from_spool(
        mut reader: BufReader<File>,
        count: u64,
        memory: u64,
        control: &dyn Fn() -> Result<(), AppError>,
    ) -> Result<Self, AppError> {
        control()?;
        let index_bytes = count
            .div_ceil(LEAF as u64)
            .checked_mul(std::mem::size_of::<Block>() as u64)
            .ok_or_else(pressure)?;
        if index_bytes + 8 * 1024 * 1024 > memory {
            return Err(pressure());
        }
        let mut blocks = Vec::new();
        blocks
            .try_reserve_exact(count.div_ceil(LEAF as u64) as usize)
            .map_err(|_| pressure())?;
        let mut output = BufWriter::with_capacity(1024 * 1024, tempfile::tempfile()?);
        let mut left = count;
        let mut start = 0;
        while left > 0 {
            control()?;
            let n = left.min(BATCH as u64) as usize;
            let mut bytes = vec![0; n * 26];
            reader.read_exact(&mut bytes)?;
            let mut records = Vec::with_capacity(n);
            for b in bytes.chunks_exact(26) {
                let x = f64::from_le_bytes(b[8..16].try_into().map_err(|_| invalid())?);
                let y = f64::from_le_bytes(b[16..24].try_into().map_err(|_| invalid())?);
                let group = u16::from_le_bytes(b[24..26].try_into().map_err(|_| invalid())?) as u64;
                if !x.is_finite() || !y.is_finite() || group >= 64 {
                    return Err(invalid());
                }
                records.push(Record { x, y, group });
            }
            partition(&mut records);
            for page in records.chunks(LEAF) {
                blocks.push(Block {
                    start,
                    len: page.len(),
                    bounds: bounds(page),
                });
                start += page.len();
            }
            output.write_all(bytemuck::cast_slice(&records))?;
            left -= n as u64;
        }
        output.flush()?;
        let file = output
            .into_inner()
            .map_err(|e| AppError::FileIO(e.to_string()))?;
        // Anonymous, exclusively owned temporary file. No writer escapes; mapping is read-only.
        let map = if count == 0 {
            None
        } else {
            Some(unsafe { memmap2::MmapOptions::new().map(&file)? })
        };
        control()?;
        Ok(Self {
            map,
            blocks,
            last: Mutex::new(None),
        })
    }
    pub fn resident_bytes(&self) -> u64 {
        // Reserve one maximum validated frame's centers and bounded raster scratch.
        self.blocks.capacity() as u64 * std::mem::size_of::<Block>() as u64 + 128 * 1024 * 1024
    }
    pub fn disk_bytes(&self) -> u64 {
        self.map.as_ref().map_or(0, |m| m.len() as u64)
    }
    pub fn raster(
        &self,
        domain: GraphDomain,
        frame: [u32; 2],
        plot: [u32; 4],
        radius: u32,
        overlay: &OverlayCatalog,
        enabled: EnabledOverlayMask,
        control: &dyn Fn() -> Result<(), AppError>,
    ) -> Result<PixelRaster, AppError> {
        control()?;
        if frame[0] == 0
            || frame[1] == 0
            || frame[0] > 3840
            || frame[1] > 2160
            || plot[2] == 0
            || plot[3] == 0
            || radius > 8
            || plot[0].checked_add(plot[2]).is_none_or(|n| n > frame[0])
            || plot[1].checked_add(plot[3]).is_none_or(|n| n > frame[1])
            || ![domain.x_min, domain.x_max, domain.y_min, domain.y_max]
                .iter()
                .all(|n| n.is_finite())
            || domain.x_min >= domain.x_max
            || domain.y_min >= domain.y_max
        {
            return Err(invalid());
        }
        let w = plot[2] as usize;
        let h = plot[3] as usize;
        let stride = w + 2 * BORDER;
        let mut last = self.last.lock().map_err(|_| invalid())?;
        let mut work = QueryWork::default();
        if !last
            .as_ref()
            .is_some_and(|c| c.domain == domain && c.frame == frame && c.plot == plot)
        {
            *last = None;
            let mut c = Centers {
                domain,
                frame,
                plot,
                bits: vec![0; stride * (h + 2 * BORDER)],
                counts: [0; 64],
            };
            let records: &[Record] = match &self.map {
                Some(m) => bytemuck::try_cast_slice(m).map_err(|_| invalid())?,
                None => &[],
            };
            for b in &self.blocks {
                control()?;
                work.index_entries_inspected += 1;
                let [x0, x1, y0, y1] = b.bounds;
                if normalized(x1, domain.x_min, domain.x_max) < -(BORDER as f64) / w as f64
                    || normalized(x0, domain.x_min, domain.x_max) >= 1. + BORDER as f64 / w as f64
                    || normalized(y1, domain.y_min, domain.y_max) < -(BORDER as f64) / h as f64
                    || normalized(y0, domain.y_min, domain.y_max) >= 1. + BORDER as f64 / h as f64
                {
                    continue;
                }
                work.raw_blocks_inspected += 1;
                work.raw_points_inspected += b.len as u64;
                for p in &records[b.start..b.start + b.len] {
                    if let Some((x, y)) = project(p.x, p.y, domain, w, h) {
                        c.bits[y * stride + x] |= 1 << p.group;
                    }
                    if p.x >= domain.x_min
                        && p.x <= domain.x_max
                        && p.y >= domain.y_min
                        && p.y <= domain.y_max
                    {
                        c.counts[p.group as usize] += 1;
                    }
                }
            }
            control()?;
            *last = Some(c);
        }
        let c = last.as_ref().ok_or_else(invalid)?;
        let mask = enabled.bits();
        let mut rgba = vec![0; (frame[0] * frame[1] * 4) as usize];
        let mut occupied = 0;
        let offsets: Vec<_> = (-(radius as isize)..=radius as isize)
            .flat_map(|y| {
                (-(radius as isize)..=radius as isize).filter_map(move |x| {
                    (x * x + y * y <= (radius * radius) as isize).then_some((x, y))
                })
            })
            .collect();
        let colors: Vec<_> = (0..64)
            .map(|g| overlay.rgba_bytes(g).unwrap_or([31, 111, 235, 255]))
            .collect();
        for y in 0..h {
            if y % 32 == 0 {
                control()?;
            }
            for x in 0..w {
                let mut bits = 0;
                for &(dx, dy) in &offsets {
                    let cx = (x + BORDER) as isize + dx;
                    let cy = (y + BORDER) as isize + dy;
                    bits |= c.bits[cy as usize * stride + cx as usize];
                }
                bits &= mask;
                if bits == 0 {
                    continue;
                }
                occupied += 1;
                let code = 63 - bits.leading_zeros() as usize;
                let i =
                    (((plot[1] as usize + h - 1 - y) * frame[0] as usize) + plot[0] as usize + x)
                        * 4;
                rgba[i..i + 4].copy_from_slice(&colors[code]);
            }
        }
        let visible = c
            .counts
            .iter()
            .enumerate()
            .filter(|(g, _)| mask & (1 << g) != 0)
            .map(|(_, n)| *n)
            .sum();
        control()?;
        Ok(PixelRaster {
            width: frame[0],
            height: frame[1],
            rgba,
            visible,
            occupied,
            work,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Seek, SeekFrom, Write};
    fn store(points: &[SourcePoint]) -> PixelStore {
        let mut f = tempfile::tempfile().unwrap();
        for p in points {
            f.write_all(&p.row_id.to_le_bytes()).unwrap();
            f.write_all(&p.x.to_le_bytes()).unwrap();
            f.write_all(&p.y.to_le_bytes()).unwrap();
            f.write_all(&p.group_code.to_le_bytes()).unwrap();
        }
        f.seek(SeekFrom::Start(0)).unwrap();
        PixelStore::from_spool(
            BufReader::new(f),
            points.len() as u64,
            64 * 1024 * 1024,
            &|| Ok(()),
        )
        .unwrap()
    }
    fn domain() -> GraphDomain {
        GraphDomain {
            x_min: 0.,
            x_max: 1.,
            y_min: 0.,
            y_max: 1.,
        }
    }
    fn enabled() -> EnabledOverlayMask {
        EnabledOverlayMask::from_hidden(&OverlayCatalog::default(), &[]).unwrap()
    }
    #[test]
    fn pixel_source_keeps_isolated_point_and_closed_boundaries() {
        let s = store(&[
            SourcePoint::new(1, 0., 0.),
            SourcePoint::new(2, 1., 1.),
            SourcePoint::new(3, 0.5, 0.5),
        ]);
        let r = s
            .raster(
                domain(),
                [20, 20],
                [5, 5, 10, 10],
                0,
                &OverlayCatalog::default(),
                enabled(),
                &|| Ok(()),
            )
            .unwrap();
        assert_eq!(r.visible, 3);
        assert_eq!(r.occupied, 3);
        for (x, y) in [(5, 14), (14, 5), (10, 9)] {
            assert_eq!(r.rgba[(y * 20 + x) * 4 + 3], 255);
        }
    }
    #[test]
    fn pixel_radius_reuses_centers_and_includes_offscreen_footprints() {
        let s = store(&[
            SourcePoint::new(1, -0.05, 0.5),
            SourcePoint::new(2, 0.5, 0.5),
        ]);
        let a = s
            .raster(
                domain(),
                [20, 20],
                [5, 5, 10, 10],
                0,
                &OverlayCatalog::default(),
                enabled(),
                &|| Ok(()),
            )
            .unwrap();
        let b = s
            .raster(
                domain(),
                [20, 20],
                [5, 5, 10, 10],
                2,
                &OverlayCatalog::default(),
                enabled(),
                &|| Ok(()),
            )
            .unwrap();
        assert_eq!(a.visible, 1);
        assert_eq!(b.work.raw_points_inspected, 0);
        assert!(b.occupied > a.occupied);
        assert_eq!(b.rgba[(9 * 20 + 5) * 4 + 3], 255);
    }
    #[test]
    fn pixel_groups_can_be_hidden_without_losing_underlying_points() {
        use super::super::graph_new_overlay::OverlayDictionary;
        let mut dictionary = OverlayDictionary::new("VARCHAR");
        let a = dictionary.observe(Some("A")).unwrap();
        let b = dictionary.observe(Some("B")).unwrap();
        let catalog = dictionary.finish();
        let s = store(&[
            SourcePoint::with_group(1, 0.5, 0.5, a),
            SourcePoint::with_group(2, 0.5, 0.5, b),
        ]);
        let all = EnabledOverlayMask::from_hidden(&catalog, &[]).unwrap();
        let r = s
            .raster(
                domain(),
                [20, 20],
                [5, 5, 10, 10],
                0,
                &catalog,
                all,
                &|| Ok(()),
            )
            .unwrap();
        assert_eq!(r.visible, 2);
        assert_eq!(r.occupied, 1);
        let id = catalog
            .groups
            .iter()
            .find(|g| g.code == b)
            .unwrap()
            .id
            .clone();
        let hidden = EnabledOverlayMask::from_hidden(&catalog, &[id]).unwrap();
        let r = s
            .raster(
                domain(),
                [20, 20],
                [5, 5, 10, 10],
                0,
                &catalog,
                hidden,
                &|| Ok(()),
            )
            .unwrap();
        assert_eq!(r.visible, 1);
        assert_eq!(r.work.raw_points_inspected, 0);
        assert_eq!(
            &r.rgba[(9 * 20 + 10) * 4..(9 * 20 + 10) * 4 + 4],
            &catalog.rgba_bytes(a).unwrap()
        );
    }

    #[test]
    fn pixel_cancel_and_memory_budget_are_enforced() {
        let s = store(&[SourcePoint::new(1, 0.5, 0.5)]);
        assert!(s
            .raster(
                domain(),
                [20, 20],
                [5, 5, 10, 10],
                1,
                &OverlayCatalog::default(),
                enabled(),
                &|| Err(AppError::Cancelled("graph_new_cancelled".into()))
            )
            .is_err());
        let f = tempfile::tempfile().unwrap();
        assert!(PixelStore::from_spool(BufReader::new(f), 100, 1, &|| Ok(())).is_err());
    }
}
