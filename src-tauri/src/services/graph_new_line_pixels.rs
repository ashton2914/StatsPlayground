//! Complete statistical polylines, indexed in data space and rasterized per viewport.
use super::{
    graph_new_layers::{LineOptions, Summary},
    graph_new_lod::{GraphDomain, SourcePoint},
    graph_new_overlay::{EnabledOverlayMask, OverlayCatalog},
    graph_new_raw::QueryWork,
    graph_new_ticks::normalized,
};
use crate::error::AppError;
use bytemuck::Zeroable;
use std::{
    fs::File,
    io::{BufReader, BufWriter, Read, Seek, Write},
    sync::{Arc, Mutex},
};
const BLOCK: usize = 4096;
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Sample {
    x: f64,
    y: f64,
    low: f64,
    high: f64,
    row: i64,
    group: u64,
}
impl Sample {
    fn summary(self) -> Summary {
        Summary {
            point: SourcePoint::with_group(self.row, self.x, self.y, self.group as u16),
            low: self.low,
            high: self.high,
        }
    }
}
#[derive(Debug)]
struct Node {
    start: usize,
    end: usize,
    bounds: [f64; 4],
    group: Option<u16>,
    compact: bool,
    children: Option<[usize; 2]>,
}
#[derive(Debug)]
pub(crate) struct LineStore {
    map: Option<memmap2::Mmap>,
    nodes: Vec<Node>,
    pub options: LineOptions,
    pub layer_key: String,
    pub count: usize,
    pub extent: Option<[f64; 4]>,
}
pub(crate) struct LineWriter {
    file: BufWriter<File>,
    count: usize,
    limit: u64,
    options: LineOptions,
    key: String,
}
fn pressure() -> AppError {
    AppError::Stats("graph_new_cache_pressure".into())
}
impl LineWriter {
    pub fn new(options: LineOptions, key: String, limit: u64) -> Result<Self, AppError> {
        Ok(Self {
            file: BufWriter::new(tempfile::tempfile()?),
            count: 0,
            limit,
            options,
            key,
        })
    }
    #[cfg(test)]
    pub fn push(&mut self, s: Summary) -> Result<(), AppError> {
        let ordinal = s.point.row_id as u64;
        self.push_ordered(s, ordinal)
    }
    pub fn push_ordered(&mut self, s: Summary, ordinal: u64) -> Result<(), AppError> {
        if !s.point.y.is_finite() && self.options.missing_values == "connect" {
            return Ok(());
        }
        if (self.count as u64 + 1)
            .checked_mul(48)
            .is_none_or(|n| n > self.limit)
        {
            return Err(pressure());
        }
        let row = Sample {
            x: s.point.x,
            y: s.point.y,
            low: s.low,
            high: s.high,
            row: ordinal as i64,
            group: u64::from(s.point.group_code),
        };
        self.file.write_all(bytemuck::bytes_of(&row))?;
        self.count += 1;
        Ok(())
    }
    pub fn finish(
        mut self,
        control: &dyn Fn() -> Result<(), AppError>,
    ) -> Result<LineStore, AppError> {
        self.file.flush()?;
        let file = self
            .file
            .into_inner()
            .map_err(|e| AppError::FileIO(e.into_error().to_string()))?;
        let file = if self.options.row_order && self.options.summary_stat != "none" {
            order_by_row(file, self.count, self.limit, control)?
        } else {
            file
        };
        let map = if self.count > 0 {
            Some(unsafe { memmap2::MmapOptions::new().map(&file)? })
        } else {
            None
        };
        let mut store = LineStore {
            map,
            nodes: Vec::new(),
            options: self.options,
            layer_key: self.key,
            count: self.count,
            extent: None,
        };
        if self.count > 0 {
            let capacity = self
                .count
                .div_ceil(BLOCK)
                .checked_mul(4)
                .ok_or_else(pressure)?;
            if capacity
                .checked_mul(std::mem::size_of::<Node>())
                .is_none_or(|bytes| bytes > super::graph_new_layers::MAX_LAYER_BYTES)
            {
                return Err(pressure());
            }
            store
                .nodes
                .try_reserve_exact(capacity)
                .map_err(|_| pressure())?;
            store.node(0, self.count, control)?;
            let bounds = store.nodes[0].bounds;
            if bounds.iter().all(|v| v.is_finite()) {
                store.extent = Some(bounds);
            }
        }
        control()?;
        Ok(store)
    }
}
impl LineStore {
    fn samples(&self) -> &[Sample] {
        self.map.as_ref().map_or(&[], |m| bytemuck::cast_slice(m))
    }
    pub fn resident_bytes(&self) -> usize {
        self.nodes.capacity() * std::mem::size_of::<Node>()
    }
    pub fn disk_bytes(&self) -> u64 {
        self.map.as_ref().map_or(0, |m| m.len() as u64)
    }
    fn node(
        &mut self,
        start: usize,
        end: usize,
        control: &dyn Fn() -> Result<(), AppError>,
    ) -> Result<usize, AppError> {
        control()?;
        let index = self.nodes.len();
        self.nodes.push(Node {
            start,
            end,
            bounds: [
                f64::INFINITY,
                f64::NEG_INFINITY,
                f64::INFINITY,
                f64::NEG_INFINITY,
            ],
            group: None,
            compact: false,
            children: None,
        });
        if end - start > BLOCK {
            let middle = start + (end - start) / 2;
            let a = self.node(start, middle, control)?;
            let b = self.node(middle, end, control)?;
            let left = &self.nodes[a];
            let right = &self.nodes[b];
            self.nodes[index] = Node {
                start,
                end,
                bounds: [
                    left.bounds[0].min(right.bounds[0]),
                    left.bounds[1].max(right.bounds[1]),
                    left.bounds[2].min(right.bounds[2]),
                    left.bounds[3].max(right.bounds[3]),
                ],
                group: left.group.filter(|g| Some(*g) == right.group),
                compact: left.compact && right.compact && left.group == right.group,
                children: Some([a, b]),
            };
        } else {
            let samples = self.samples();
            let mut bounds = [
                f64::INFINITY,
                f64::NEG_INFINITY,
                f64::INFINITY,
                f64::NEG_INFINITY,
            ];
            let group = samples[start].group as u16;
            let mut compact = true;
            let mut same_group = true;
            for s in &samples[start.saturating_sub(2)..(end + 1).min(samples.len())] {
                if s.y.is_finite() {
                    bounds[0] = bounds[0].min(s.x);
                    bounds[1] = bounds[1].max(s.x);
                    bounds[2] = bounds[2].min(s.low.min(s.y));
                    bounds[3] = bounds[3].max(s.high.max(s.y));
                }
                same_group &= s.group == u64::from(group);
                compact &= s.y.is_finite() && s.group == u64::from(group) && s.low == s.high;
            }
            if self.options.connection == "spline" {
                for i in start..end {
                    if i % 1024 == 0 {
                        control()?;
                    }
                    if i == 0 {
                        continue;
                    }
                    let current = samples[i];
                    let previous = samples[i - 1];
                    if current.group != previous.group
                        || !current.y.is_finite()
                        || !previous.y.is_finite()
                    {
                        continue;
                    }
                    let before = i
                        .checked_sub(2)
                        .and_then(|j| samples.get(j))
                        .filter(|s| s.group == current.group && s.y.is_finite())
                        .copied()
                        .unwrap_or(previous);
                    let after = samples
                        .get(i + 1)
                        .filter(|s| s.group == current.group && s.y.is_finite())
                        .copied()
                        .unwrap_or(current);
                    let levels = if current.low != current.high || previous.low != previous.high {
                        3
                    } else {
                        1
                    };
                    for level in 0..levels {
                        let point = |s: Sample| {
                            [
                                s.x,
                                match level {
                                    1 => s.low,
                                    2 => s.high,
                                    _ => s.y,
                                },
                            ]
                        };
                        for (a, b) in super::graph_new_layers::connection_segments(
                            "spline",
                            point(before),
                            point(previous),
                            point(current),
                            point(after),
                        )? {
                            for p in [a, b] {
                                bounds[0] = bounds[0].min(p[0]);
                                bounds[1] = bounds[1].max(p[0]);
                                bounds[2] = bounds[2].min(p[1]);
                                bounds[3] = bounds[3].max(p[1]);
                            }
                        }
                    }
                }
            }
            if self.options.fill == "toZero" {
                bounds[2] = bounds[2].min(0.);
                bounds[3] = bounds[3].max(0.);
            }
            self.nodes[index] = Node {
                start,
                end,
                bounds,
                group: same_group.then_some(group),
                compact,
                children: None,
            };
        }
        Ok(index)
    }
}
#[derive(Debug)]
pub(crate) struct RasterLayers {
    pub fill: Vec<u8>,
    pub lines: Vec<u8>,
    pub work: QueryWork,
}
#[derive(Debug)]
pub(crate) struct CachedRaster {
    domain: GraphDomain,
    frame: [u32; 2],
    plot: [u32; 4],
    mask: u64,
    ratio: u64,
    raster: Arc<RasterLayers>,
}
pub(crate) type RasterCache = Mutex<Option<CachedRaster>>;
pub(crate) fn rasterize(
    stores: &[Arc<LineStore>],
    cache: &RasterCache,
    domain: GraphDomain,
    frame: [u32; 2],
    plot: [u32; 4],
    ratio: f64,
    overlay: &OverlayCatalog,
    enabled: EnabledOverlayMask,
    control: &dyn Fn() -> Result<(), AppError>,
) -> Result<(Arc<RasterLayers>, bool), AppError> {
    let mut last = cache.lock().map_err(|_| pressure())?;
    if let Some(c) = &*last {
        if c.domain == domain
            && c.frame == frame
            && c.plot == plot
            && c.mask == enabled.bits()
            && c.ratio == ratio.to_bits()
        {
            control()?;
            return Ok((c.raster.clone(), true));
        }
    }
    let (w, h) = (plot[2] as usize, plot[3] as usize);
    let mut canvas = Canvas {
        w,
        h,
        domain,
        line: vec![0; w * h],
        fill: vec![0; w * h],
        work: QueryWork::default(),
    };
    for store in stores {
        if !store.nodes.is_empty() {
            canvas.visit(store, 0, enabled, control)?;
        }
    }
    let mut fill = vec![0; (frame[0] * frame[1] * 4) as usize];
    let mut lines = vec![0; fill.len()];
    let radius = (ratio.ceil() as isize - 1).max(0);
    let colors: Vec<_> = (0..64)
        .map(|g| overlay.rgba_bytes(g).unwrap_or([31, 111, 235, 255]))
        .collect();
    for y in 0..h {
        if y % 32 == 0 {
            control()?;
        }
        for x in 0..w {
            let mut line = 0;
            for dy in -radius..=radius {
                for dx in -radius..=radius {
                    if dx * dx + dy * dy > radius * radius {
                        continue;
                    }
                    let (a, b) = (x as isize + dx, y as isize + dy);
                    if a >= 0 && b >= 0 && a < w as isize && b < h as isize {
                        line |= canvas.line[b as usize * w + a as usize];
                    }
                }
            }
            let i =
                (((plot[1] as usize + h - 1 - y) * frame[0] as usize) + plot[0] as usize + x) * 4;
            for (bits, out, alpha) in [
                (canvas.fill[y * w + x], &mut fill, 48u8),
                (line, &mut lines, 255u8),
            ] {
                if bits != 0 {
                    let group = 63 - bits.leading_zeros() as usize;
                    out[i..i + 4].copy_from_slice(&colors[group]);
                    out[i + 3] = if alpha == 48 { 48 } else { colors[group][3] };
                }
            }
        }
    }
    let raster = Arc::new(RasterLayers {
        fill,
        lines,
        work: canvas.work,
    });
    *last = Some(CachedRaster {
        domain,
        frame,
        plot,
        mask: enabled.bits(),
        ratio: ratio.to_bits(),
        raster: raster.clone(),
    });
    Ok((raster, false))
}
struct Canvas {
    w: usize,
    h: usize,
    domain: GraphDomain,
    line: Vec<u64>,
    fill: Vec<u64>,
    work: QueryWork,
}
impl Canvas {
    fn project(&self, p: [f64; 2]) -> [f64; 2] {
        [
            normalized(p[0], self.domain.x_min, self.domain.x_max) * self.w as f64,
            normalized(p[1], self.domain.y_min, self.domain.y_max) * self.h as f64,
        ]
    }
    fn segment(&mut self, a: [f64; 2], b: [f64; 2], group: u16) {
        let Some([a, b]) = super::graph_new_renderer::clip_mean_segment(a, b, self.domain) else {
            return;
        };
        let (mut a, mut b) = (self.project(a), self.project(b));
        if a[0] > b[0] {
            std::mem::swap(&mut a, &mut b);
        }
        let first = (a[0].floor() as usize).min(self.w - 1);
        let last = (b[0].floor() as usize).min(self.w - 1);
        for x in first..=last {
            let (lo, hi) = if b[0] == a[0] {
                (a[1].min(b[1]), a[1].max(b[1]))
            } else {
                let left = (x as f64).max(a[0]);
                let right = ((x + 1) as f64).min(b[0]);
                let y1 = a[1] + (b[1] - a[1]) * ((left - a[0]) / (b[0] - a[0]));
                let y2 = a[1] + (b[1] - a[1]) * ((right - a[0]) / (b[0] - a[0]));
                (y1.min(y2), y1.max(y2))
            };
            self.vertical(x, lo, hi, group);
        }
    }
    fn vertical(&mut self, x: usize, lo: f64, hi: f64, group: u16) {
        if hi < 0. || lo > self.h as f64 {
            return;
        }
        let low = (lo.max(0.).floor() as usize).min(self.h - 1);
        let high = (hi.max(0.).floor() as usize).min(self.h - 1);
        for y in low..=high {
            self.line[y * self.w + x] |= 1u64 << group;
        }
    }
    fn polygon(
        &mut self,
        quad: [[f64; 2]; 4],
        group: u16,
        control: &dyn Fn() -> Result<(), AppError>,
    ) -> Result<(), AppError> {
        control()?;
        let mut points = quad.to_vec();
        for (axis, boundary, lower) in [
            (0, self.domain.x_min, true),
            (0, self.domain.x_max, false),
            (1, self.domain.y_min, true),
            (1, self.domain.y_max, false),
        ] {
            let inside = |p: [f64; 2]| {
                if lower {
                    p[axis] >= boundary
                } else {
                    p[axis] <= boundary
                }
            };
            let mut next = Vec::new();
            if let Some(mut previous) = points.last().copied() {
                for &current in &points {
                    if inside(previous) != inside(current) {
                        let t = normalized(boundary, previous[axis], current[axis]);
                        let mut p = [
                            previous[0] * (1. - t) + current[0] * t,
                            previous[1] * (1. - t) + current[1] * t,
                        ];
                        p[axis] = boundary;
                        if p.iter().all(|v| v.is_finite()) {
                            next.push(p);
                        }
                    }
                    if inside(current) {
                        next.push(current);
                    }
                    previous = current;
                }
            }
            points = next;
        }
        let p: Vec<_> = points.into_iter().map(|v| self.project(v)).collect();
        let low = p
            .iter()
            .map(|v| v[1])
            .fold(f64::INFINITY, f64::min)
            .floor()
            .max(0.) as usize;
        let high = (p
            .iter()
            .map(|v| v[1])
            .fold(f64::NEG_INFINITY, f64::max)
            .ceil()
            .max(0.) as usize)
            .min(self.h);
        for y in low.min(self.h)..high {
            if y % 32 == 0 {
                control()?;
            }
            let scan = y as f64 + 0.5;
            let mut xs = [0.; 12];
            let mut count = 0;
            for i in 0..p.len() {
                let (a, b) = (p[i], p[(i + 1) % p.len()]);
                if (a[1] <= scan && b[1] > scan) || (b[1] <= scan && a[1] > scan) {
                    xs[count] = a[0] + (b[0] - a[0]) * ((scan - a[1]) / (b[1] - a[1]));
                    count += 1;
                }
            }
            xs[..count].sort_by(f64::total_cmp);
            for pair in xs[..count].chunks_exact(2) {
                let left = (pair[0].floor().max(0.) as usize).min(self.w);
                let right = (pair[1].ceil().max(0.) as usize).min(self.w);
                for x in left..right {
                    self.fill[y * self.w + x] |= 1u64 << group;
                }
            }
        }
        Ok(())
    }
    fn visit(
        &mut self,
        store: &LineStore,
        index: usize,
        enabled: EnabledOverlayMask,
        control: &dyn Fn() -> Result<(), AppError>,
    ) -> Result<(), AppError> {
        control()?;
        self.work.index_entries_inspected += 1;
        let node = &store.nodes[index];
        let b = node.bounds;
        if b[0] > b[1] {
            return Ok(());
        }
        if node.group.is_some_and(|g| !enabled.is_enabled(g)) {
            return Ok(());
        }
        let mut lo = self.project([b[0], b[2]]);
        let mut hi = self.project([b[1], b[3]]);
        if store.options.connection == "spline" {
            for axis in 0..2 {
                let d = (hi[axis] - lo[axis]) * 0.5;
                lo[axis] -= d;
                hi[axis] += d;
            }
        }
        let cap = if !node.compact
            && store.options.error_interval != "none"
            && store.options.interval_style == "errorBar"
        {
            4.
        } else {
            0.
        };
        if hi[0] + cap < 0. || lo[0] - cap > self.w as f64 || hi[1] < 0. || lo[1] > self.h as f64 {
            return Ok(());
        }
        if store.count > 1
            && node.compact
            && store.options.connection == "line"
            && store.options.fill == "none"
            && lo[0] >= 0.
            && hi[0] < self.w as f64
            && lo[0].floor() == hi[0].floor()
        {
            if let Some(group) = node.group {
                self.vertical(lo[0] as usize, lo[1], hi[1], group);
                return Ok(());
            }
        }
        if let Some([left, right]) = node.children {
            self.visit(store, left, enabled, control)?;
            self.visit(store, right, enabled, control)?;
            return Ok(());
        }
        self.work.raw_blocks_inspected += 1;
        let samples = store.samples();
        for i in node.start..node.end {
            if i % 1024 == 0 {
                control()?;
            }
            self.work.raw_points_inspected += 1;
            let s = samples[i];
            let group = s.group as u16;
            if !enabled.is_enabled(group) || !s.y.is_finite() {
                continue;
            }
            let p = [s.x, s.y];
            if store.options.error_interval != "none"
                && store.options.interval_style == "errorBar"
                && s.low != s.high
            {
                self.segment([s.x, s.low], [s.x, s.high], group);
                for y in [s.low, s.high] {
                    let p = self.project([s.x, y]);
                    if p[0].is_finite() && p[1] >= 0. && p[1] < self.h as f64 {
                        let first = ((p[0] - 4.).floor().max(0.) as usize).min(self.w);
                        let last = ((p[0] + 4.).ceil().max(0.) as usize).min(self.w);
                        for x in first..last {
                            self.line[p[1].floor() as usize * self.w + x] |= 1u64 << group;
                        }
                    }
                }
            }
            if i == 0 {
                continue;
            }
            let prev = samples[i - 1];
            if prev.group != s.group || !prev.y.is_finite() {
                continue;
            }
            let a = [prev.x, prev.y];
            let before = i
                .checked_sub(2)
                .and_then(|j| samples.get(j))
                .filter(|v| v.group == s.group && v.y.is_finite())
                .map(|v| [v.x, v.y])
                .unwrap_or(a);
            let after = samples
                .get(i + 1)
                .filter(|v| v.group == s.group && v.y.is_finite())
                .map(|v| [v.x, v.y])
                .unwrap_or(p);
            if store.options.connection == "line" {
                self.segment(a, p, group);
                if store.options.fill == "toZero" {
                    self.polygon([a, p, [p[0], 0.], [a[0], 0.]], group, control)?;
                }
            } else {
                for (a, b) in super::graph_new_layers::connection_segments(
                    &store.options.connection,
                    before,
                    a,
                    p,
                    after,
                )? {
                    self.segment(a, b, group);
                    if store.options.fill == "toZero" {
                        self.polygon([a, b, [b[0], 0.], [a[0], 0.]], group, control)?;
                    }
                }
            }
            if store.options.error_interval != "none"
                && (store.options.interval_style == "band" || store.options.fill == "between")
                && (s.high != s.low || prev.high != prev.low)
            {
                let mut geometry = super::graph_new_layers::PreparedLayers::default();
                super::graph_new_layers::band_fill(
                    &mut geometry,
                    prev.summary(),
                    s.summary(),
                    &store.options.connection,
                    i.checked_sub(2)
                        .and_then(|j| samples.get(j))
                        .map(|v| v.summary()),
                    samples.get(i + 1).map(|v| v.summary()),
                )?;
                for (quad, g) in geometry.fills {
                    self.polygon(quad, g, control)?;
                }
            }
        }
        Ok(())
    }
}
/// Source-over composition, bounded by frame resolution.
pub(crate) fn composite(base: &mut [u8], overlay: &[u8]) {
    for (dst, src) in base.chunks_exact_mut(4).zip(overlay.chunks_exact(4)) {
        let alpha = u32::from(src[3]);
        if alpha == 0 {
            continue;
        }
        let da = u32::from(dst[3]);
        let out = alpha * 255 + da * (255 - alpha);
        for c in 0..3 {
            dst[c] = ((u32::from(src[c]) * alpha * 255 + u32::from(dst[c]) * da * (255 - alpha))
                / out) as u8;
        }
        dst[3] = (out / 255) as u8;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    pub(super) fn source(rows: &[(f64, f64, u16)], options: LineOptions) -> LineStore {
        let mut writer = LineWriter::new(options, "test".into(), 64 * 1024 * 1024).unwrap();
        for (i, &(x, y, g)) in rows.iter().enumerate() {
            writer
                .push(Summary {
                    point: SourcePoint::with_group(i as i64 + 1, x, y, g),
                    low: y,
                    high: y,
                })
                .unwrap();
        }
        writer.finish(&|| Ok(())).unwrap()
    }
    pub(super) fn canvas() -> Canvas {
        Canvas {
            w: 100,
            h: 220,
            domain: GraphDomain {
                x_min: 0.,
                x_max: 100.,
                y_min: 0.,
                y_max: 220.,
            },
            line: vec![0; 22000],
            fill: vec![0; 22000],
            work: QueryWork::default(),
        }
    }
    #[test]
    fn same_column_spike_preserves_every_crossed_pixel() {
        let store = source(
            &[(50.01, 200., 0), (50.02, 20., 0), (50.03, 200., 0)],
            LineOptions::default(),
        );
        let mut c = canvas();
        let enabled = EnabledOverlayMask::from_hidden(&OverlayCatalog::default(), &[]).unwrap();
        c.visit(&store, 0, enabled, &|| Ok(())).unwrap();
        for y in 20..=200 {
            assert_eq!(c.line[y * 100 + 50], 1, "missing spike pixel at {y}");
        }
        assert_eq!(
            c.work.raw_points_inspected, 0,
            "a connected same-column node is resolved by its exact extent"
        );
    }
    #[test]
    fn missing_values_and_groups_never_create_bridges() {
        let mut options = LineOptions::default();
        options.missing_values = "break".into();
        let store = source(
            &[(50.01, 20., 0), (50.02, f64::NAN, 0), (50.03, 200., 0)],
            options,
        );
        let mut c = canvas();
        let enabled = EnabledOverlayMask::from_hidden(&OverlayCatalog::default(), &[]).unwrap();
        c.visit(&store, 0, enabled, &|| Ok(())).unwrap();
        assert!(c.line.iter().all(|b| *b == 0));
        let store = source(&[(50.01, 20., 0), (50.02, 200., 1)], LineOptions::default());
        let mut c = canvas();
        c.visit(&store, 0, enabled, &|| Ok(())).unwrap();
        assert!(c.line.iter().all(|b| *b == 0));
    }
    #[test]
    fn connect_through_missing_and_offscreen_endpoints_are_preserved() {
        let store = source(
            &[(-100., 110., 0), (50., f64::NAN, 0), (200., 110., 0)],
            LineOptions::default(),
        );
        let mut c = canvas();
        let enabled = EnabledOverlayMask::from_hidden(&OverlayCatalog::default(), &[]).unwrap();
        c.visit(&store, 0, enabled, &|| Ok(())).unwrap();
        for x in 0..100 {
            assert_eq!(c.line[110 * 100 + x], 1);
        }
    }
    #[test]
    fn isolated_summary_has_no_connection() {
        let store = source(&[(50., 100., 0)], LineOptions::default());
        let mut c = canvas();
        let enabled = EnabledOverlayMask::from_hidden(&OverlayCatalog::default(), &[]).unwrap();
        c.visit(&store, 0, enabled, &|| Ok(())).unwrap();
        assert!(c.line.iter().all(|v| *v == 0));
    }
    #[test]
    fn dense_monotonic_line_uses_index_and_view_cache() {
        let rows: Vec<_> = (0..100_000)
            .map(|i| (50. + i as f64 * 1e-8, 20. + (i % 181) as f64, 0))
            .collect();
        let store = Arc::new(source(&rows, LineOptions::default()));
        assert!(store.resident_bytes() < 100_000);
        let enabled = EnabledOverlayMask::from_hidden(&OverlayCatalog::default(), &[]).unwrap();
        let cache = Mutex::new(None);
        let d = canvas().domain;
        let (a, hit) = rasterize(
            &[store.clone()],
            &cache,
            d,
            [100, 220],
            [0, 0, 100, 220],
            1.,
            &OverlayCatalog::default(),
            enabled,
            &|| Ok(()),
        )
        .unwrap();
        assert!(!hit);
        assert_eq!(a.work.raw_points_inspected, 0);
        let (b, hit) = rasterize(
            &[store],
            &cache,
            d,
            [100, 220],
            [0, 0, 100, 220],
            1.,
            &OverlayCatalog::default(),
            enabled,
            &|| Ok(()),
        )
        .unwrap();
        assert!(hit && Arc::ptr_eq(&a, &b));
    }
    #[test]
    fn cancellation_and_disk_budget_fail_before_unbounded_work() {
        let mut writer = LineWriter::new(LineOptions::default(), "test".into(), 0).unwrap();
        assert!(writer
            .push(Summary {
                point: SourcePoint::new(1, 0., 0.),
                low: 0.,
                high: 0.
            })
            .is_err());
        let store = source(&[(0., 0., 0), (1., 1., 0)], LineOptions::default());
        let mut c = canvas();
        let enabled = EnabledOverlayMask::from_hidden(&OverlayCatalog::default(), &[]).unwrap();
        assert!(c
            .visit(&store, 0, enabled, &|| Err(AppError::Cancelled(
                "graph_new_cancelled".into()
            )))
            .is_err());
    }
    #[test]
    fn step_connection_and_fill_use_the_statistical_results() {
        let mut options = LineOptions::default();
        options.connection = "step".into();
        options.fill = "toZero".into();
        let store = source(&[(20., 20., 0), (80., 200., 0)], options);
        let mut c = canvas();
        let enabled = EnabledOverlayMask::from_hidden(&OverlayCatalog::default(), &[]).unwrap();
        c.visit(&store, 0, enabled, &|| Ok(())).unwrap();
        assert_eq!(c.line[100 * 100 + 50], 1);
        assert_eq!(c.line[100 * 100 + 30], 0);
        assert_eq!(c.fill[10 * 100 + 30], 1);
        assert_eq!(c.fill[100 * 100 + 30], 0);
    }
}

#[cfg(test)]
#[test]
fn indexed_coverage_matches_every_original_segment_across_zoom_and_breaks() {
    use tests::*;
    let mut rows: Vec<_> = (0..20000)
        .map(|i| (i as f64 / 200., ((i * 48271 % 2147483647) % 210) as f64, 0))
        .collect();
    rows[5000].1 = f64::NAN;
    let mut options = LineOptions::default();
    options.missing_values = "break".into();
    let store = source(&rows, options);
    let enabled = EnabledOverlayMask::from_hidden(&OverlayCatalog::default(), &[]).unwrap();
    for domain in [
        canvas().domain,
        GraphDomain {
            x_min: 40.,
            x_max: 40.1,
            y_min: 50.,
            y_max: 100.,
        },
        GraphDomain {
            x_min: 0.,
            x_max: 10000.,
            y_min: 0.,
            y_max: 220.,
        },
    ] {
        let mut indexed = canvas();
        indexed.domain = domain;
        indexed.visit(&store, 0, enabled, &|| Ok(())).unwrap();
        let mut brute = canvas();
        brute.domain = domain;
        for pair in store.samples().windows(2) {
            if pair[0].y.is_finite() && pair[1].y.is_finite() {
                brute.segment([pair[0].x, pair[0].y], [pair[1].x, pair[1].y], 0);
            }
        }
        assert_eq!(
            indexed.line, brute.line,
            "pixel coverage changed with indexing at {domain:?}"
        );
    }
}

fn order_by_row(
    file: File,
    count: usize,
    limit: u64,
    control: &dyn Fn() -> Result<(), AppError>,
) -> Result<File, AppError> {
    if (count as u64)
        .checked_mul(144)
        .is_none_or(|bytes| bytes > limit)
    {
        return Err(pressure());
    }
    let dir = tempfile::tempdir()?;
    let mut file = file;
    file.rewind()?;
    let mut input = BufReader::new(file);
    let mut runs = Vec::new();
    let mut left = count;
    let mut serial = 0usize;
    while left > 0 {
        control()?;
        let n = left.min(16384);
        let mut samples = vec![Sample::zeroed(); n];
        input.read_exact(bytemuck::cast_slice_mut(&mut samples))?;
        samples.sort_unstable_by_key(|s| (s.group, s.row as u64));
        let path = dir.path().join(format!("row-{serial}"));
        serial += 1;
        let mut output = BufWriter::new(File::create(&path)?);
        output.write_all(bytemuck::cast_slice(&samples))?;
        output.flush()?;
        runs.push(path);
        left -= n;
    }
    fn next(reader: &mut BufReader<File>) -> Result<Option<Sample>, AppError> {
        let mut bytes = [0u8; 48];
        let n = reader.read(&mut bytes[..1])?;
        if n == 0 {
            return Ok(None);
        }
        reader.read_exact(&mut bytes[1..])?;
        Ok(Some(bytemuck::pod_read_unaligned(&bytes)))
    }
    while runs.len() > 1 {
        let mut merged = Vec::new();
        for pair in runs.chunks(2) {
            control()?;
            if pair.len() == 1 {
                merged.push(pair[0].clone());
                continue;
            }
            let path = dir.path().join(format!("row-{serial}"));
            serial += 1;
            let mut a = BufReader::new(File::open(&pair[0])?);
            let mut b = BufReader::new(File::open(&pair[1])?);
            let mut first = next(&mut a)?;
            let mut second = next(&mut b)?;
            let mut out = BufWriter::new(File::create(&path)?);
            let mut visited = 0;
            while first.is_some() || second.is_some() {
                if visited % 4096 == 0 {
                    control()?;
                }
                visited += 1;
                let take_first = match (first, second) {
                    (Some(a), Some(b)) => (a.group, a.row as u64) <= (b.group, b.row as u64),
                    (Some(_), None) => true,
                    _ => false,
                };
                let row = if take_first {
                    let row = first.take().ok_or_else(pressure)?;
                    first = next(&mut a)?;
                    row
                } else {
                    let row = second.take().ok_or_else(pressure)?;
                    second = next(&mut b)?;
                    row
                };
                out.write_all(bytemuck::bytes_of(&row))?;
            }
            out.flush()?;
            drop(out);
            drop(a);
            drop(b);
            std::fs::remove_file(&pair[0])?;
            std::fs::remove_file(&pair[1])?;
            merged.push(path);
        }
        runs = merged;
    }
    let mut output = tempfile::tempfile()?;
    if let Some(path) = runs.first() {
        std::io::copy(&mut File::open(path)?, &mut output)?;
    }
    control()?;
    Ok(output)
}

#[cfg(test)]
#[test]
fn statistical_row_order_uses_first_source_ordinal_after_external_grouping() {
    let mut options = LineOptions::default();
    options.row_order = true;
    let mut writer = LineWriter::new(options, "row".into(), 1024 * 1024).unwrap();
    for (x, y, ordinal) in [(20., 20., 2), (50., 200., 0), (80., 20., 1)] {
        writer
            .push_ordered(
                Summary {
                    point: SourcePoint::new(1, x, y),
                    low: y,
                    high: y,
                },
                ordinal,
            )
            .unwrap();
    }
    let store = writer.finish(&|| Ok(())).unwrap();
    assert_eq!(
        store.samples().iter().map(|s| s.x).collect::<Vec<_>>(),
        vec![50., 80., 20.]
    );
    let mut c = tests::canvas();
    let enabled = EnabledOverlayMask::from_hidden(&OverlayCatalog::default(), &[]).unwrap();
    c.visit(&store, 0, enabled, &|| Ok(())).unwrap();
    assert_eq!(
        c.line[80 * 100 + 30],
        0,
        "row order must not draw the X-sorted left leg"
    );
    assert_eq!(c.line[20 * 100 + 30], 1);
}
#[cfg(test)]
#[test]
fn error_cap_outside_view_still_covers_visible_pixels() {
    let mut writer = LineWriter::new(LineOptions::default(), "cap".into(), 1024 * 1024).unwrap();
    writer
        .push(Summary {
            point: SourcePoint::new(1, -1., 100.),
            low: 20.,
            high: 200.,
        })
        .unwrap();
    let store = writer.finish(&|| Ok(())).unwrap();
    let mut c = tests::canvas();
    let enabled = EnabledOverlayMask::from_hidden(&OverlayCatalog::default(), &[]).unwrap();
    c.visit(&store, 0, enabled, &|| Ok(())).unwrap();
    assert_eq!(c.line[20 * 100], 1);
    assert_eq!(c.line[200 * 100 + 2], 1);
}

#[cfg(test)]
#[test]
fn row_order_external_merge_crosses_chunk_boundary() {
    let mut options = LineOptions::default();
    options.row_order = true;
    let mut writer = LineWriter::new(options, "rows".into(), 8 * 1024 * 1024).unwrap();
    for i in 0..17003 {
        writer
            .push_ordered(
                Summary {
                    point: SourcePoint::new(i + 1, i as f64, 1.),
                    low: 1.,
                    high: 1.,
                },
                (17002 - i) as u64,
            )
            .unwrap();
    }
    let store = writer.finish(&|| Ok(())).unwrap();
    assert_eq!(store.samples().first().unwrap().x, 17002.);
    assert_eq!(store.samples().last().unwrap().x, 0.);
    assert!(store.samples().windows(2).all(|p| p[0].row < p[1].row));
}

#[cfg(test)]
#[test]
fn spline_domain_contains_its_actual_overshoot() {
    let mut options = LineOptions::default();
    options.connection = "spline".into();
    let store = tests::source(
        &[(0., 0., 0), (1., 1., 0), (2., 1., 0), (3., 0., 0)],
        options,
    );
    assert!(store.extent.unwrap()[3] >= 1.125);
}
#[cfg(test)]
#[test]
fn broad_fill_checks_cancellation_inside_scan_conversion() {
    let mut c = tests::canvas();
    let checks = std::cell::Cell::new(0);
    let result = c.polygon([[0., 0.], [100., 0.], [100., 220.], [0., 220.]], 0, &|| {
        checks.set(checks.get() + 1);
        if checks.get() > 2 {
            Err(AppError::Cancelled("graph_new_cancelled".into()))
        } else {
            Ok(())
        }
    });
    assert!(result.is_err());
    assert!(c.fill.iter().any(|b| *b != 0) && c.fill.iter().any(|b| *b == 0));
}
#[cfg(test)]
#[test]
fn extreme_fill_clips_in_data_space_before_projecting() {
    let mut c = tests::canvas();
    c.domain = GraphDomain {
        x_min: -1.,
        x_max: 1.,
        y_min: -1.,
        y_max: 1.,
    };
    c.polygon(
        [
            [-1e308, -1e308],
            [1e308, -1e308],
            [1e308, 1e308],
            [-1e308, 1e308],
        ],
        0,
        &|| Ok(()),
    )
    .unwrap();
    assert!(c.fill.iter().all(|b| *b == 1));
}
