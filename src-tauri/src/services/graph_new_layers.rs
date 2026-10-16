use super::graph_new_lod::SourcePoint;
use super::graph_new_raw::SourceRecord;
use crate::error::AppError;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};

pub const MAX_LAYER_BYTES: usize = 128 * 1024 * 1024;
pub const LAYER_SCRATCH_BYTES: u64 = 512 * 1024 * 1024;
fn invalid() -> AppError {
    AppError::InvalidParam("graph_new_invalid_layers".into())
}
fn pressure() -> AppError {
    AppError::Stats("graph_new_cache_pressure".into())
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct PointOptions {
    pub summary_stat: String,
    pub error_interval: String,
    pub interval_style: String,
    pub jitter: String,
    pub jitter_limit: f64,
}
impl Default for PointOptions {
    fn default() -> Self {
        Self {
            summary_stat: "none".into(),
            error_interval: "auto".into(),
            interval_style: "errorBar".into(),
            jitter: "stacked".into(),
            jitter_limit: 0.5,
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct LineOptions {
    pub row_order: bool,
    pub connection: String,
    pub summary_stat: String,
    pub fill: String,
    pub error_interval: String,
    pub interval_style: String,
    pub missing_factors: String,
    pub missing_values: String,
}
impl Default for LineOptions {
    fn default() -> Self {
        Self {
            row_order: false,
            connection: "line".into(),
            summary_stat: "mean".into(),
            fill: "none".into(),
            error_interval: "auto".into(),
            interval_style: "errorBar".into(),
            missing_factors: "skip".into(),
            missing_values: "connect".into(),
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", deny_unknown_fields)]
pub enum GraphNewLayer {
    #[serde(rename = "points")]
    Points { id: String, options: PointOptions },
    #[serde(rename = "line")]
    Line {
        id: String,
        options: LineOptions,
        #[serde(
            default,
            rename = "legacySourceRuns",
            skip_serializing_if = "std::ops::Not::not"
        )]
        legacy_source_runs: bool,
    },
    #[serde(rename = "timeSeries")]
    TimeSeries {
        id: String,
        options: LineOptions,
        #[serde(
            default,
            rename = "legacySourceRuns",
            skip_serializing_if = "std::ops::Not::not"
        )]
        legacy_source_runs: bool,
    },
}
impl GraphNewLayer {
    pub fn id(&self) -> &str {
        match self {
            Self::Points { id, .. } | Self::Line { id, .. } | Self::TimeSeries { id, .. } => id,
        }
    }
    pub fn validate(&self) -> Result<(), AppError> {
        let (stat, interval, style) = match self {
            Self::Points { options: o, .. } => {
                if !["stacked", "uniform", "normal"].contains(&o.jitter.as_str())
                    || !o.jitter_limit.is_finite()
                    || !(0.0..=1.0).contains(&o.jitter_limit)
                {
                    return Err(invalid());
                }
                (&o.summary_stat, &o.error_interval, &o.interval_style)
            }
            Self::Line { options: o, .. } | Self::TimeSeries { options: o, .. } => {
                if !["line", "step", "spline"].contains(&o.connection.as_str())
                    || !["none", "toZero", "between"].contains(&o.fill.as_str())
                    || !["skip", "include"].contains(&o.missing_factors.as_str())
                    || !["connect", "break"].contains(&o.missing_values.as_str())
                {
                    return Err(invalid());
                }
                (&o.summary_stat, &o.error_interval, &o.interval_style)
            }
        };
        if self.id().trim().is_empty()
            || self.id() != self.id().trim()
            || self.id().len() > 256
            || !["none", "mean", "median", "sum"].contains(&stat.as_str())
            || !["auto", "none", "stdErr", "stdDev", "ci95"].contains(&interval.as_str())
            || !["errorBar", "band"].contains(&style.as_str())
        {
            return Err(invalid());
        }
        Ok(())
    }
}
pub fn validate_layers(layers: &[GraphNewLayer]) -> Result<(), AppError> {
    if layers.len() > 64
        || layers
            .iter()
            .filter(|layer| matches!(layer, GraphNewLayer::Points { .. }))
            .count()
            > 1
    {
        return Err(invalid());
    }
    let mut ids = HashSet::new();
    for layer in layers {
        layer.validate()?;
        if !ids.insert(layer.id()) {
            return Err(invalid());
        }
    }
    Ok(())
}
#[cfg(test)]
#[test]
fn graph_new_layers_reject_multiple_scatter_sources() {
    let layers = vec![
        GraphNewLayer::Points {
            id: "a".into(),
            options: PointOptions::default(),
        },
        GraphNewLayer::Points {
            id: "b".into(),
            options: PointOptions::default(),
        },
    ];
    assert!(validate_layers(&layers).is_err());
}
#[derive(Debug, Clone, Copy)]
pub struct LayerPoint {
    pub point: SourcePoint,
    pub layer_index: u16,
    pub jitter: u8,
    pub limit: f64,
}
pub type LayerSegment = ([f64; 2], [f64; 2], u16);
pub type LayerFill = ([[f64; 2]; 4], u16);
#[derive(Debug, Default)]
pub struct PreparedLayers {
    pub line_sources: Vec<std::sync::Arc<super::graph_new_line_pixels::LineStore>>,
    pub line_raster: super::graph_new_line_pixels::RasterCache,
    pub pixel_source: Option<std::sync::Arc<super::graph_new_pixels::PixelStore>>,
    pub pixel_options: Option<PointOptions>,
    pub jitter_limited: bool,
    pub jitter_domain: Option<super::graph_new_lod::GraphDomain>,
    pub raw_points: Vec<(u16, PointOptions)>,
    pub layer_marks: Vec<usize>,
    pub points: Vec<LayerPoint>,
    pub lines: Vec<LayerSegment>,
    pub intervals: Vec<LayerSegment>,
    pub fills: Vec<LayerFill>,
}
impl PreparedLayers {
    fn reserve_capacity(
        &self,
        len: usize,
        capacity: usize,
        size: usize,
    ) -> Result<usize, AppError> {
        if len < capacity {
            return Ok(0);
        }
        let available = MAX_LAYER_BYTES.saturating_sub(self.bytes()) / size;
        if available == 0 {
            return Err(pressure());
        }
        Ok(available.min(capacity.max(256)))
    }
    fn push_line(&mut self, p: LayerSegment) -> Result<(), AppError> {
        let n = self.reserve_capacity(
            self.lines.len(),
            self.lines.capacity(),
            std::mem::size_of::<LayerSegment>(),
        )?;
        if n > 0 {
            self.lines.try_reserve_exact(n).map_err(|_| pressure())?;
        }
        self.lines.push(p);
        Ok(())
    }
    fn push_interval(&mut self, p: LayerSegment) -> Result<(), AppError> {
        let n = self.reserve_capacity(
            self.intervals.len(),
            self.intervals.capacity(),
            std::mem::size_of::<LayerSegment>(),
        )?;
        if n > 0 {
            self.intervals
                .try_reserve_exact(n)
                .map_err(|_| pressure())?;
        }
        self.intervals.push(p);
        Ok(())
    }
    fn push_fill(&mut self, p: LayerFill) -> Result<(), AppError> {
        let n = self.reserve_capacity(
            self.fills.len(),
            self.fills.capacity(),
            std::mem::size_of::<LayerFill>(),
        )?;
        if n > 0 {
            self.fills.try_reserve_exact(n).map_err(|_| pressure())?;
        }
        self.fills.push(p);
        Ok(())
    }
    fn push_point(&mut self, p: LayerPoint) -> Result<(), AppError> {
        let n = self.reserve_capacity(
            self.points.len(),
            self.points.capacity(),
            std::mem::size_of::<LayerPoint>(),
        )?;
        if n > 0 {
            self.points.try_reserve_exact(n).map_err(|_| pressure())?;
        }
        self.points.push(p);
        Ok(())
    }
    pub fn bytes(&self) -> usize {
        let pixel_bytes = self
            .pixel_source
            .as_ref()
            .map_or(0, |source| source.resident_bytes() as usize);
        pixel_bytes
            + self
                .line_sources
                .iter()
                .map(|store| store.resident_bytes())
                .sum::<usize>()
            + self.points.capacity() * std::mem::size_of::<LayerPoint>()
            + (self.lines.capacity() + self.intervals.capacity())
                * std::mem::size_of::<LayerSegment>()
            + self.fills.capacity() * std::mem::size_of::<LayerFill>()
    }
    fn check(&self) -> Result<(), AppError> {
        if self.bytes() > MAX_LAYER_BYTES {
            Err(pressure())
        } else {
            Ok(())
        }
    }
    pub fn extent(&self) -> Option<[f64; 4]> {
        let mut b = [
            f64::INFINITY,
            f64::NEG_INFINITY,
            f64::INFINITY,
            f64::NEG_INFINITY,
        ];
        let mut add = |p: [f64; 2]| {
            if p.iter().all(|v| v.is_finite()) {
                b[0] = b[0].min(p[0]);
                b[1] = b[1].max(p[0]);
                b[2] = b[2].min(p[1]);
                b[3] = b[3].max(p[1]);
            }
        };
        for source in &self.line_sources {
            if let Some(extent) = source.extent {
                add([extent[0], extent[2]]);
                add([extent[1], extent[3]]);
            }
        }
        for p in &self.points {
            add([p.point.x, p.point.y]);
        }
        for (a, z, _) in self.lines.iter().chain(&self.intervals) {
            add(*a);
            add(*z);
        }
        for (q, _) in &self.fills {
            for p in q {
                add(*p);
            }
        }
        b.iter().all(|v| v.is_finite()).then_some(b)
    }
}
#[derive(Clone, Copy)]
pub(crate) struct Summary {
    pub point: SourcePoint,
    pub low: f64,
    pub high: f64,
}
fn summarize(rows: &[SourceRecord], stat: &str, interval: &str) -> Result<Summary, AppError> {
    let scale = rows
        .iter()
        .map(|r| r.point.y.abs())
        .fold(0_f64, f64::max)
        .max(f64::MIN_POSITIVE);
    let n = rows.len() as f64;
    let mean = rows.iter().map(|r| r.point.y / scale / n).sum::<f64>() * scale;
    let y = match stat {
        "median" => {
            let mut ys: Vec<f64> = rows.iter().map(|r| r.point.y).collect();
            ys.sort_by(f64::total_cmp);
            let mid = ys.len() / 2;
            if ys.len() % 2 == 1 {
                ys[mid]
            } else {
                ys[mid - 1] / 2. + ys[mid] / 2.
            }
        }
        "sum" => mean * n,
        _ => mean,
    };
    let sd = if rows.len() > 1 {
        let normalized_mean = mean / scale;
        (rows
            .iter()
            .map(|r| (r.point.y / scale - normalized_mean).powi(2))
            .sum::<f64>()
            / (n - 1.))
            .sqrt()
            * scale
    } else {
        0.
    };
    let half = if interval == "none" {
        0.
    } else if interval == "stdDev" {
        sd
    } else {
        sd / n.sqrt() * if interval == "ci95" { 1.96 } else { 1. }
    };
    if ![y, y - half, y + half].iter().all(|v| v.is_finite()) {
        return Err(AppError::Stats("graph_new_layer_overflow".into()));
    }
    let mut point = rows[0].point;
    point.y = y;
    Ok(Summary {
        point,
        low: y - half,
        high: y + half,
    })
}
pub fn prepare_layers(
    source: &[SourceRecord],
    layers: &[GraphNewLayer],
    missing_category: Option<f64>,
    control: &dyn Fn() -> Result<(), AppError>,
) -> Result<PreparedLayers, AppError> {
    prepare_layers_with_missing(source, layers, missing_category, None, control)
}
pub fn prepare_layers_with_missing(
    source: &[SourceRecord],
    layers: &[GraphNewLayer],
    missing_category: Option<f64>,
    missing_overlay: Option<u16>,
    control: &dyn Fn() -> Result<(), AppError>,
) -> Result<PreparedLayers, AppError> {
    validate_layers(layers)?;
    let mut out = PreparedLayers::default();
    for layer in layers {
        let previous_marks =
            out.points.len() + out.lines.len() + out.intervals.len() + out.fills.len();
        control()?;
        if source.len() > 2_100_000 {
            return Err(pressure());
        }
        if matches!(layer, GraphNewLayer::Points { .. }) {
            let reserve = if stat_for(layer) == "none" {
                source.len()
            } else {
                0
            };
            if out
                .bytes()
                .saturating_add(reserve.saturating_mul(std::mem::size_of::<LayerPoint>()))
                > MAX_LAYER_BYTES
            {
                return Err(pressure());
            }
            out.points
                .try_reserve_exact(reserve)
                .map_err(|_| pressure())?;
        }
        let (stat, interval, style, line) = match layer {
            GraphNewLayer::Points { options: o, .. } => {
                (&o.summary_stat, &o.error_interval, &o.interval_style, None)
            }
            GraphNewLayer::Line { options: o, .. }
            | GraphNewLayer::TimeSeries { options: o, .. } => (
                &o.summary_stat,
                &o.error_interval,
                &o.interval_style,
                Some(o),
            ),
        };
        let legacy_runs = stat == "none"
            && line.is_some_and(|o| o.missing_values == "break")
            && matches!(
                layer,
                GraphNewLayer::Line {
                    legacy_source_runs: true,
                    ..
                } | GraphNewLayer::TimeSeries {
                    legacy_source_runs: true,
                    ..
                }
            );
        let mut run = 0u64;
        let mut previous_finite_id: Option<i64> = None;
        let mut groups: BTreeMap<(u64, u16), Vec<SourceRecord>> = BTreeMap::new();
        for (i, row) in source.iter().enumerate() {
            if i % 4096 == 0 {
                control()?;
                out.check()?;
            }
            let mut row = *row;
            if legacy_runs {
                if !row.point.x.is_finite() || !row.point.y.is_finite() {
                    continue;
                }
                if previous_finite_id.is_some_and(|id| id.checked_add(1) != Some(row.point.row_id))
                {
                    run += 1;
                }
                previous_finite_id = Some(row.point.row_id);
            }
            if line.is_some_and(|o| o.missing_factors == "skip")
                && missing_overlay == Some(row.point.group_code)
            {
                continue;
            }
            if !row.point.x.is_finite() {
                if line.is_some_and(|o| o.missing_factors == "include") {
                    if let Some(x) = missing_category {
                        row.point.x = x;
                    } else {
                        continue;
                    }
                } else {
                    continue;
                }
            }
            groups
                .entry((run, row.point.group_code))
                .or_default()
                .push(row);
        }
        for ((_, group), mut rows) in groups {
            control()?;
            let mut samples: Vec<Summary> = Vec::with_capacity(rows.len());
            if stat != "none" {
                rows.sort_by(|a, b| {
                    a.point
                        .x
                        .total_cmp(&b.point.x)
                        .then(a.scan_ordinal.cmp(&b.scan_ordinal))
                });
                let mut start = 0;
                while start < rows.len() {
                    control()?;
                    let mut end = start + 1;
                    while end < rows.len() && rows[end].point.x == rows[start].point.x {
                        end += 1;
                    }
                    let finite: Vec<_> = rows[start..end]
                        .iter()
                        .filter(|r| r.point.y.is_finite())
                        .copied()
                        .collect();
                    samples.push(if finite.is_empty() {
                        Summary {
                            point: rows[start].point,
                            low: f64::NAN,
                            high: f64::NAN,
                        }
                    } else {
                        summarize(&finite, stat, interval)?
                    });
                    start = end;
                }
            } else {
                rows.sort_by(|a, b| {
                    if line.is_some_and(|o| o.row_order) {
                        a.scan_ordinal.cmp(&b.scan_ordinal)
                    } else {
                        a.point
                            .x
                            .total_cmp(&b.point.x)
                            .then(a.scan_ordinal.cmp(&b.scan_ordinal))
                    }
                });
                for row in &rows {
                    samples.push(Summary {
                        point: row.point,
                        low: row.point.y,
                        high: row.point.y,
                    });
                }
            }
            let mut previous: Option<Summary> = None;
            for (i, sample) in samples.iter().enumerate() {
                if i % 1024 == 0 {
                    control()?;
                    out.check()?;
                }
                if !sample.point.y.is_finite() {
                    if line.is_some_and(|o| o.missing_values == "break") {
                        previous = None;
                    }
                    continue;
                }
                let p = [sample.point.x, sample.point.y];
                if let GraphNewLayer::Points { options: o, .. } = layer {
                    out.push_point(LayerPoint {
                        point: sample.point,
                        layer_index: 0,
                        jitter: if stat != "none" {
                            0
                        } else {
                            match o.jitter.as_str() {
                                "uniform" => 2,
                                "normal" => 3,
                                _ => 1,
                            }
                        },
                        limit: o.jitter_limit,
                    })?;
                }
                if stat != "none"
                    && interval != "none"
                    && sample.high != sample.low
                    && style == "errorBar"
                {
                    out.push_interval(([p[0], sample.low], [p[0], sample.high], group))?;
                }
                if let Some(prev) = previous {
                    let a = [prev.point.x, prev.point.y];
                    if let Some(o) = line {
                        let line_start = out.lines.len();
                        let before = if i >= 2 && samples[i - 2].point.y.is_finite() {
                            [samples[i - 2].point.x, samples[i - 2].point.y]
                        } else {
                            a
                        };
                        let after = samples
                            .get(i + 1)
                            .filter(|s| s.point.y.is_finite())
                            .map(|s| [s.point.x, s.point.y])
                            .unwrap_or(p);
                        for (start, end) in connection_segments(&o.connection, before, a, p, after)?
                        {
                            out.push_line((start, end, group))?;
                        }
                        if o.fill == "toZero" {
                            for j in line_start..out.lines.len() {
                                let (a, p, _) = out.lines[j];
                                zero_fill(&mut out, a, p, group)?;
                            }
                        }
                    }
                    if stat != "none"
                        && interval != "none"
                        && (style == "band" || line.is_some_and(|o| o.fill == "between"))
                        && (sample.high != sample.low || prev.high != prev.low)
                    {
                        band_fill(
                            &mut out,
                            prev,
                            *sample,
                            line.map(|o| o.connection.as_str()).unwrap_or("line"),
                            i.checked_sub(2).and_then(|j| samples.get(j)).copied(),
                            samples.get(i + 1).copied(),
                        )?;
                    }
                }
                previous = Some(*sample);
            }
        }
        out.layer_marks.push(
            out.points.len() + out.lines.len() + out.intervals.len() + out.fills.len()
                - previous_marks,
        );
    }
    out.check()?;
    control()?;
    Ok(out)
}
pub(crate) fn prepare_summaries(
    samples: &[Summary],
    layer: &GraphNewLayer,
    control: &dyn Fn() -> Result<(), AppError>,
) -> Result<PreparedLayers, AppError> {
    let (interval, style, line) = match layer {
        GraphNewLayer::Points { options, .. } => {
            (&options.error_interval, &options.interval_style, None)
        }
        GraphNewLayer::Line { options, .. } | GraphNewLayer::TimeSeries { options, .. } => (
            &options.error_interval,
            &options.interval_style,
            Some(options),
        ),
    };
    let mut raw_layer = layer.clone();
    match &mut raw_layer {
        GraphNewLayer::Points { options, .. } => {
            options.summary_stat = "none".into();
            options.jitter_limit = 0.;
            options.error_interval = "none".into();
        }
        GraphNewLayer::Line { options, .. } | GraphNewLayer::TimeSeries { options, .. } => {
            options.summary_stat = "none".into();
            options.row_order = false;
            options.error_interval = "none".into();
        }
    }
    let source: Vec<_> = samples
        .iter()
        .enumerate()
        .map(|(i, s)| SourceRecord {
            scan_ordinal: i as u64,
            point: s.point,
        })
        .collect();
    let mut out = prepare_layers(&source, &[raw_layer], None, control)?;
    let mut previous: Option<Summary> = None;
    let mut before: Option<Summary> = None;
    for (i, s) in samples.iter().enumerate() {
        if i % 4096 == 0 {
            control()?;
            out.check()?;
        }
        if previous.is_some_and(|p| p.point.group_code != s.point.group_code) {
            previous = None;
            before = None;
        }
        if !s.point.y.is_finite() {
            if line.is_some_and(|l| l.missing_values == "break") {
                previous = None;
                before = None;
            }
            continue;
        }
        if interval != "none" && style == "errorBar" && s.high != s.low {
            out.push_interval(([s.point.x, s.low], [s.point.x, s.high], s.point.group_code))?;
        }
        if let Some(prev) = previous {
            if interval != "none"
                && (style == "band" || line.is_some_and(|l| l.fill == "between"))
                && (s.high != s.low || prev.high != prev.low)
            {
                band_fill(
                    &mut out,
                    prev,
                    *s,
                    line.map(|l| l.connection.as_str()).unwrap_or("line"),
                    before,
                    samples.get(i + 1).copied(),
                )?;
            }
        }
        before = previous;
        previous = Some(*s);
    }

    out.check()?;
    out.layer_marks =
        vec![out.points.len() + out.lines.len() + out.intervals.len() + out.fills.len()];
    Ok(out)
}
pub(crate) fn connection_segments(
    connection: &str,
    before: [f64; 2],
    a: [f64; 2],
    p: [f64; 2],
    after: [f64; 2],
) -> Result<Vec<([f64; 2], [f64; 2])>, AppError> {
    let mut segments = Vec::with_capacity(12);
    match connection {
        "step" => {
            let mid = a[0] / 2. + p[0] / 2.;
            segments.extend([
                (a, [mid, a[1]]),
                ([mid, a[1]], [mid, p[1]]),
                ([mid, p[1]], p),
            ]);
        }
        "spline" => {
            let mut last = a;
            for step in 1..=12 {
                let t = step as f64 / 12.;
                let mut next = [0.; 2];
                for axis in 0..2 {
                    let scale = [before[axis], a[axis], p[axis], after[axis]]
                        .iter()
                        .map(|v| v.abs())
                        .fold(1_f64, f64::max);
                    let (b, c, d, e) = (
                        before[axis] / scale,
                        a[axis] / scale,
                        p[axis] / scale,
                        after[axis] / scale,
                    );
                    next[axis] = (0.5
                        * ((2. * c)
                            + (-b + d) * t
                            + (2. * b - 5. * c + 4. * d - e) * t * t
                            + (-b + 3. * c - 3. * d + e) * t * t * t))
                        * scale;
                }
                if !next.iter().all(|v| v.is_finite()) {
                    return Err(AppError::Stats("graph_new_layer_overflow".into()));
                }
                segments.push((last, next));
                last = next;
            }
        }
        _ => segments.push((a, p)),
    }
    Ok(segments)
}
fn zero_fill(
    out: &mut PreparedLayers,
    a: [f64; 2],
    p: [f64; 2],
    group: u16,
) -> Result<(), AppError> {
    if (a[1] < 0. && p[1] > 0.) || (a[1] > 0. && p[1] < 0.) {
        let scale = a[1].abs().max(p[1].abs());
        let t = (a[1] / scale).abs() / ((a[1] / scale).abs() + (p[1] / scale).abs());
        let crossing = [a[0] * (1. - t) + p[0] * t, 0.];
        out.push_fill(([a, crossing, crossing, [a[0], 0.]], group))?;
        out.push_fill(([crossing, p, [p[0], 0.], crossing], group))?;
    } else {
        out.push_fill(([a, p, [p[0], 0.], [a[0], 0.]], group))?;
    }
    Ok(())
}
pub(crate) fn band_fill(
    out: &mut PreparedLayers,
    a: Summary,
    p: Summary,
    connection: &str,
    before: Option<Summary>,
    after: Option<Summary>,
) -> Result<(), AppError> {
    let valid = |s: &Summary| s.point.group_code == a.point.group_code && s.point.y.is_finite();
    let before = before.filter(valid).unwrap_or(a);
    let after = after.filter(valid).unwrap_or(p);
    let lower = connection_segments(
        connection,
        [before.point.x, before.low],
        [a.point.x, a.low],
        [p.point.x, p.low],
        [after.point.x, after.low],
    )?;
    let upper = connection_segments(
        connection,
        [before.point.x, before.high],
        [a.point.x, a.high],
        [p.point.x, p.high],
        [after.point.x, after.high],
    )?;
    for ((lo_a, lo_p), (hi_a, hi_p)) in lower.into_iter().zip(upper) {
        out.push_fill(([lo_a, lo_p, hi_p, hi_a], a.point.group_code))?;
    }
    Ok(())
}
fn stat_for(layer: &GraphNewLayer) -> &str {
    match layer {
        GraphNewLayer::Points { options, .. } => &options.summary_stat,
        GraphNewLayer::Line { options, .. } | GraphNewLayer::TimeSeries { options, .. } => {
            &options.summary_stat
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::graph_new_lod::SourcePoint;
    use crate::services::graph_new_raw::SourceRecord;
    fn rows() -> Vec<SourceRecord> {
        [1., 2., 3.]
            .iter()
            .enumerate()
            .map(|(i, y)| SourceRecord {
                scan_ordinal: i as u64,
                point: SourcePoint::new(i as i64 + 1, 0., *y),
            })
            .collect()
    }
    #[test]
    fn graph_new_layers_summary_exact() {
        let layer: GraphNewLayer = serde_json::from_value(
            serde_json::json!({"id":"a","kind":"points","options":{"summaryStat":"mean"}}),
        )
        .unwrap();
        let p = prepare_layers(&rows(), &[layer], None, &|| Ok(())).unwrap();
        assert_eq!(p.points.len(), 1);
        assert_eq!(p.points[0].point.y, 2.);
        assert!((p.intervals[0].1[1] - (2. + 1. / 3_f64.sqrt())).abs() < 1e-12);
    }
    #[test]
    fn graph_new_layers_summary_median_and_sum() {
        for (stat, y) in [("median", 2.), ("sum", 6.)] {
            let layer=serde_json::from_value(serde_json::json!({"id":"a","kind":"points","options":{"summaryStat":stat,"errorInterval":"none"}})).unwrap();
            let p = prepare_layers(&rows(), &[layer], None, &|| Ok(())).unwrap();
            assert_eq!(p.points[0].point.y, y);
        }
    }
    #[test]
    fn graph_new_layers_geometry_missing_and_step() {
        let rows = vec![
            SourceRecord {
                scan_ordinal: 0,
                point: SourcePoint::new(1, 0., 1.),
            },
            SourceRecord {
                scan_ordinal: 1,
                point: SourcePoint::new(2, 1., f64::NAN),
            },
            SourceRecord {
                scan_ordinal: 2,
                point: SourcePoint::new(3, 2., 3.),
            },
        ];
        for (missing, n) in [("break", 0), ("connect", 1)] {
            let layer=serde_json::from_value(serde_json::json!({"id":"a","kind":"line","options":{"summaryStat":"none","missingValues":missing}})).unwrap();
            assert_eq!(
                prepare_layers(&rows, &[layer], None, &|| Ok(()))
                    .unwrap()
                    .lines
                    .len(),
                n
            );
        }
        let layer=serde_json::from_value(serde_json::json!({"id":"a","kind":"line","options":{"summaryStat":"none","missingValues":"connect","connection":"step"}})).unwrap();
        assert_eq!(
            prepare_layers(&rows, &[layer], None, &|| Ok(()))
                .unwrap()
                .lines
                .len(),
            3
        );
    }
    #[test]
    fn graph_new_layers_geometry_fill() {
        let layer=serde_json::from_value(serde_json::json!({"id":"a","kind":"line","options":{"summaryStat":"none","fill":"toZero"}})).unwrap();
        let rows = vec![
            SourceRecord {
                scan_ordinal: 0,
                point: SourcePoint::new(1, 0., 1.),
            },
            SourceRecord {
                scan_ordinal: 1,
                point: SourcePoint::new(2, 2., 3.),
            },
        ];
        assert_eq!(
            prepare_layers(&rows, &[layer], None, &|| Ok(()))
                .unwrap()
                .fills
                .len(),
            1
        );
    }
    #[test]
    fn graph_new_layers_summary_intervals_extreme_and_singleton() {
        for (interval, half) in [
            ("none", 0.),
            ("stdDev", 1.),
            ("stdErr", 1. / 3_f64.sqrt()),
            ("ci95", 1.96 / 3_f64.sqrt()),
            ("auto", 1. / 3_f64.sqrt()),
        ] {
            let s = summarize(&rows(), "mean", interval).unwrap();
            assert!((s.high - 2. - half).abs() < 1e-12);
        }
        let extreme = vec![
            SourceRecord {
                scan_ordinal: 0,
                point: SourcePoint::new(1, 0., 1e308),
            },
            SourceRecord {
                scan_ordinal: 1,
                point: SourcePoint::new(2, 0., -1e308),
            },
        ];
        assert_eq!(summarize(&extreme, "sum", "none").unwrap().point.y, 0.);
        let overflow = vec![
            SourceRecord {
                scan_ordinal: 0,
                point: SourcePoint::new(1, 0., 1e308)
            };
            2
        ];
        assert!(summarize(&overflow, "sum", "none").is_err());
        let one = summarize(&rows()[..1], "mean", "ci95").unwrap();
        assert_eq!(one.low, one.high);
    }
    #[test]
    fn graph_new_layers_geometry_row_order_and_missing_factors() {
        let source = vec![
            SourceRecord {
                scan_ordinal: 0,
                point: SourcePoint::with_group(1, 2., 1., 5),
            },
            SourceRecord {
                scan_ordinal: 1,
                point: SourcePoint::with_group(2, 0., 3., 5),
            },
        ];
        for (order, x) in [(false, 0.), (true, 2.)] {
            let layer=serde_json::from_value(serde_json::json!({"id":"l","kind":"line","options":{"summaryStat":"none","rowOrder":order}})).unwrap();
            let p = prepare_layers(&source, &[layer], None, &|| Ok(())).unwrap();
            assert_eq!(p.lines[0].0[0], x);
        }
        let layer=serde_json::from_value(serde_json::json!({"id":"l","kind":"line","options":{"summaryStat":"none","missingFactors":"skip"}})).unwrap();
        assert!(
            prepare_layers_with_missing(&source, &[layer], None, Some(5), &|| Ok(()))
                .unwrap()
                .lines
                .is_empty()
        );
    }
    #[test]
    fn graph_new_layers_geometry_step_fill_follows_connection() {
        let source = vec![
            SourceRecord {
                scan_ordinal: 0,
                point: SourcePoint::new(1, 0., 1.),
            },
            SourceRecord {
                scan_ordinal: 1,
                point: SourcePoint::new(2, 2., 3.),
            },
        ];
        let layer=serde_json::from_value(serde_json::json!({"id":"l","kind":"line","options":{"summaryStat":"none","connection":"step","fill":"toZero"}})).unwrap();
        let p = prepare_layers(&source, &[layer], None, &|| Ok(())).unwrap();
        assert_eq!(p.fills.len(), p.lines.len());
    }
    #[test]
    fn graph_new_layers_summary_break_retains_empty_x_group() {
        let source = vec![
            SourceRecord {
                scan_ordinal: 0,
                point: SourcePoint::new(1, 0., 1.),
            },
            SourceRecord {
                scan_ordinal: 1,
                point: SourcePoint::new(2, 1., f64::NAN),
            },
            SourceRecord {
                scan_ordinal: 2,
                point: SourcePoint::new(3, 2., 3.),
            },
        ];
        let layer = serde_json::from_value(
            serde_json::json!({"id":"l","kind":"line","options":{"missingValues":"break"}}),
        )
        .unwrap();
        assert!(prepare_layers(&source, &[layer], None, &|| Ok(()))
            .unwrap()
            .lines
            .is_empty());
    }

    #[test]
    fn graph_new_layers_geometry_zero_crossing_fill_and_external_band_gaps() {
        let source = vec![
            SourceRecord {
                scan_ordinal: 0,
                point: SourcePoint::new(1, 0., -1.),
            },
            SourceRecord {
                scan_ordinal: 1,
                point: SourcePoint::new(2, 2., 1.),
            },
        ];
        let layer:GraphNewLayer=serde_json::from_value(serde_json::json!({"id":"l","kind":"line","options":{"summaryStat":"none","fill":"toZero"}})).unwrap();
        let p = prepare_layers(&source, &[layer], None, &|| Ok(())).unwrap();
        assert_eq!(p.fills.len(), 2);
        assert_eq!(p.fills[0].0[1], [1., 0.]);
        let samples = [
            Summary {
                point: SourcePoint::new(1, 0., 1.),
                low: 0.,
                high: 2.,
            },
            Summary {
                point: SourcePoint::new(2, 1., f64::NAN),
                low: f64::NAN,
                high: f64::NAN,
            },
            Summary {
                point: SourcePoint::new(3, 2., 3.),
                low: 2.,
                high: 4.,
            },
        ];
        let layer:GraphNewLayer=serde_json::from_value(serde_json::json!({"id":"l","kind":"line","options":{"connection":"step","intervalStyle":"band","missingValues":"connect"}})).unwrap();
        let p = prepare_summaries(&samples, &layer, &|| Ok(())).unwrap();
        assert_eq!(p.fills.len(), 3);
        assert_eq!(p.fills[0].0[1], [1., 0.]);
    }
    #[test]
    fn graph_new_layers_review_migrated_runs_and_summary_order() {
        let rows = vec![
            SourceRecord {
                scan_ordinal: 0,
                point: SourcePoint::new(1, 0., 1.),
            },
            SourceRecord {
                scan_ordinal: 1,
                point: SourcePoint::new(2, f64::NAN, 2.),
            },
            SourceRecord {
                scan_ordinal: 2,
                point: SourcePoint::new(3, 2., 3.),
            },
        ];
        let layer:GraphNewLayer=serde_json::from_value(serde_json::json!({"id":"old","kind":"line","legacySourceRuns":true,"options":{"summaryStat":"none","missingValues":"break"}})).unwrap();
        assert!(prepare_layers(&rows, &[layer], None, &|| Ok(()))
            .unwrap()
            .lines
            .is_empty());
        let rows: Vec<_> = [2., 0., 1.]
            .into_iter()
            .enumerate()
            .map(|(i, x)| SourceRecord {
                scan_ordinal: i as u64,
                point: SourcePoint::new(i as i64 + 1, x, x),
            })
            .collect();
        let layer:GraphNewLayer=serde_json::from_value(serde_json::json!({"id":"s","kind":"line","options":{"rowOrder":true,"errorInterval":"none"}})).unwrap();
        let p = prepare_layers(&rows, &[layer.clone()], None, &|| Ok(())).unwrap();
        assert_eq!(p.lines[0].0[0], 0.);
        assert_eq!(p.lines[1].1[0], 2.);
        let summaries: Vec<_> = rows
            .iter()
            .rev()
            .map(|r| Summary {
                point: r.point,
                low: r.point.y,
                high: r.point.y,
            })
            .collect();
        let p = prepare_summaries(&summaries, &layer, &|| Ok(())).unwrap();
        assert_eq!(p.lines[0].0[0], 0.);
        assert_eq!(p.lines[1].1[0], 2.);
    }
    #[test]
    fn graph_new_layers_geometry_allocation_growth_is_bounded_and_geometric() {
        let p = PreparedLayers::default();
        assert_eq!(
            p.reserve_capacity(1024, 1024, std::mem::size_of::<LayerSegment>())
                .unwrap(),
            1024
        );
    }
}
