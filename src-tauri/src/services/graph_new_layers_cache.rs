use super::{
    graph_new_layers::{
        prepare_layers_with_missing, prepare_summaries, GraphNewLayer, PreparedLayers, Summary,
        MAX_LAYER_BYTES,
    },
    graph_new_lod::TilePyramid,
    graph_new_raw::{encode, read_record, SourceRecord, RECORD_BYTES},
};
use crate::error::AppError;
use std::{
    cmp::Ordering,
    fs::File,
    io::{BufReader, BufWriter, Read, Seek, SeekFrom, Write},
    path::PathBuf,
    sync::{Arc, Mutex},
};
pub type LayerCache = Arc<Mutex<Option<(String, Arc<PreparedLayers>)>>>;
fn pressure() -> AppError {
    AppError::Stats("graph_new_cache_pressure".into())
}

pub fn prepare(
    pyramid: &TilePyramid,
    cache: &LayerCache,
    layers: &[GraphNewLayer],
    disk_limit: u64,
    control: &dyn Fn() -> Result<(), AppError>,
) -> Result<Arc<PreparedLayers>, AppError> {
    let key = serde_json::to_string(layers)
        .map_err(|_| AppError::InvalidParam("graph_new_invalid_layers".into()))?;
    let mut cached = cache
        .lock()
        .map_err(|_| AppError::Stats("graph_new_invalid_cache".into()))?;
    if let Some((old_key, prepared)) = &*cached {
        if old_key == &key {
            control()?;
            return Ok(prepared.clone());
        }
    }
    control()?;
    let missing_category = (pyramid.x_axis.kind
        == crate::models::graph_new::GraphNewXMode::Category)
        .then_some(pyramid.x_axis.categories.len() as f64);
    let missing_overlay = pyramid
        .overlay
        .groups
        .iter()
        .find(|g| g.missing)
        .map(|g| g.code);
    let mut prepared = PreparedLayers {
        jitter_domain: Some(pyramid.domain),
        ..Default::default()
    };
    for (layer_index, layer) in layers.iter().enumerate() {
        control()?;
        if let GraphNewLayer::Points { options, .. } = layer {
            if options.summary_stat == "none" {
                prepared
                    .raw_points
                    .push((layer_index as u16, options.clone()));
                prepared
                    .layer_marks
                    .push(pyramid.total_finite_rows as usize);
                continue;
            }
        }
        if let GraphNewLayer::Line {
            options,
            legacy_source_runs: false,
            ..
        }
        | GraphNewLayer::TimeSeries {
            options,
            legacy_source_runs: false,
            ..
        } = layer
        {
            let layer_key = serde_json::to_string(layer).map_err(|_| pressure())?;
            let previous = cached
                .as_ref()
                .and_then(|(_, p)| {
                    p.line_sources
                        .iter()
                        .find(|source| source.layer_key == layer_key)
                })
                .cloned();
            let source = if let Some(source) = previous {
                source
            } else {
                let remaining = disk_limit.saturating_sub(
                    prepared
                        .line_sources
                        .iter()
                        .map(|source| source.disk_bytes())
                        .sum::<u64>(),
                );
                let mut writer = super::graph_new_line_pixels::LineWriter::new(
                    options.clone(),
                    layer_key,
                    remaining,
                )?;
                external_summary_each(
                    pyramid,
                    layer,
                    missing_category,
                    missing_overlay,
                    remaining,
                    control,
                    &mut |sample, ordinal| writer.push_ordered(sample, ordinal),
                )?;
                Arc::new(writer.finish(control)?)
            };
            if prepared.bytes().saturating_add(source.resident_bytes()) > MAX_LAYER_BYTES {
                return Err(pressure());
            }
            prepared.layer_marks.push(source.count);
            prepared.line_sources.push(source);
            continue;
        }
        let stat = match layer {
            GraphNewLayer::Points { options, .. } => options.summary_stat.as_str(),
            GraphNewLayer::Line { options, .. } | GraphNewLayer::TimeSeries { options, .. } => {
                options.summary_stat.as_str()
            }
        };
        let mut part = if pyramid.total_processed_rows <= 2_100_000 {
            let mut source: Vec<SourceRecord> = Vec::new();
            source
                .try_reserve_exact(pyramid.total_processed_rows as usize)
                .map_err(|_| pressure())?;
            pyramid
                .raw_store
                .as_ref()
                .ok_or_else(|| AppError::Stats("graph_new_missing_cache".into()))?
                .visit_source(control, &mut |row| {
                    if source.len() >= pyramid.total_processed_rows as usize {
                        return Err(AppError::Stats("graph_new_invalid_cache".into()));
                    }
                    source.push(row);
                    Ok(())
                })?;
            prepare_layers_with_missing(
                &source,
                std::slice::from_ref(layer),
                missing_category,
                missing_overlay,
                control,
            )?
        } else if stat != "none" {
            let samples = external_summary(
                pyramid,
                layer,
                missing_category,
                missing_overlay,
                disk_limit,
                control,
            )?;
            prepare_summaries(&samples, layer, control)?
        } else {
            return Err(pressure());
        };
        for point in &mut part.points {
            point.layer_index = layer_index as u16;
        }
        if prepared.bytes().saturating_add(part.bytes()) > MAX_LAYER_BYTES {
            return Err(pressure());
        }
        prepared
            .points
            .try_reserve_exact(part.points.len())
            .map_err(|_| pressure())?;
        prepared
            .lines
            .try_reserve_exact(part.lines.len())
            .map_err(|_| pressure())?;
        prepared
            .intervals
            .try_reserve_exact(part.intervals.len())
            .map_err(|_| pressure())?;
        prepared
            .fills
            .try_reserve_exact(part.fills.len())
            .map_err(|_| pressure())?;
        prepared.points.append(&mut part.points);
        prepared.lines.append(&mut part.lines);
        prepared.intervals.append(&mut part.intervals);
        prepared.fills.append(&mut part.fills);
        prepared.layer_marks.append(&mut part.layer_marks);
    }
    if let Some(source) = &pyramid.pixel_store {
        if let Some((_, options)) = prepared
            .raw_points
            .first()
            .filter(|(_, options)| options.jitter_limit > 0.)
        {
            let previous = cached.as_ref().map(|(_, old)| old);
            if previous.is_some_and(|old| {
                old.pixel_options.as_ref().is_some_and(|saved| {
                    serde_json::to_string(saved).ok() == serde_json::to_string(options).ok()
                })
            }) {
                prepared.pixel_source = previous.and_then(|old| old.pixel_source.clone());
                prepared.jitter_limited = previous.is_some_and(|old| old.jitter_limited);
            } else {
                match super::graph_new_pixel_jitter::prepare(
                    source,
                    options,
                    pyramid.domain,
                    missing_category.is_some(),
                    disk_limit.saturating_sub(
                        prepared
                            .line_sources
                            .iter()
                            .map(|source| source.disk_bytes())
                            .sum::<u64>(),
                    ),
                    control,
                ) {
                    Ok(source) => prepared.pixel_source = Some(Arc::new(source)),
                    Err(AppError::Stats(reason)) if reason == "graph_new_cache_pressure" => {
                        prepared.jitter_limited = true
                    }
                    Err(error) => return Err(error),
                }
            }
            prepared.pixel_options = Some(options.clone());
        }
    }
    control()?;
    let prepared = Arc::new(prepared);
    *cached = Some((key, prepared.clone()));
    Ok(prepared)
}

// Sort runs live only inside this owned directory. Two copies are the disk upper bound;
// every merge uses two bounded readers and deletes inputs after the output is complete.
fn external_summary(
    pyramid: &TilePyramid,
    layer: &GraphNewLayer,
    missing_category: Option<f64>,
    missing_overlay: Option<u16>,
    disk_limit: u64,
    control: &dyn Fn() -> Result<(), AppError>,
) -> Result<Vec<Summary>, AppError> {
    let mut samples = Vec::new();
    external_summary_each(
        pyramid,
        layer,
        missing_category,
        missing_overlay,
        disk_limit,
        control,
        &mut |sample, _| {
            if samples.len() >= 2_100_000 {
                return Err(pressure());
            }
            samples.push(sample);
            Ok(())
        },
    )?;
    Ok(samples)
}
fn external_summary_each(
    pyramid: &TilePyramid,
    layer: &GraphNewLayer,
    missing_category: Option<f64>,
    missing_overlay: Option<u16>,
    disk_limit: u64,
    control: &dyn Fn() -> Result<(), AppError>,
    emit: &mut dyn FnMut(Summary, u64) -> Result<(), AppError>,
) -> Result<(), AppError> {
    if fast_summaries(
        pyramid,
        layer,
        missing_category,
        missing_overlay,
        control,
        emit,
    )? {
        return Ok(());
    }
    let required = pyramid
        .total_processed_rows
        .checked_mul(
            RECORD_BYTES * 2
                + if matches!(layer, GraphNewLayer::Points { .. }) {
                    0
                } else {
                    48
                },
        )
        .ok_or_else(pressure)?;
    if required > disk_limit {
        return Err(pressure());
    }
    let directory = tempfile::tempdir()?;
    let mut runs = Vec::<PathBuf>::new();
    let mut buffer = Vec::with_capacity(16384);
    let line = match layer {
        GraphNewLayer::Points { .. } => None,
        GraphNewLayer::Line { options, .. } | GraphNewLayer::TimeSeries { options, .. } => {
            Some(options)
        }
    };
    let compare = |a: &SourceRecord, b: &SourceRecord| {
        if line.is_some_and(|o| o.summary_stat == "none" && o.row_order) {
            return a
                .point
                .group_code
                .cmp(&b.point.group_code)
                .then(a.scan_ordinal.cmp(&b.scan_ordinal));
        }
        if line.is_some_and(|o| o.summary_stat == "none") {
            return a
                .point
                .group_code
                .cmp(&b.point.group_code)
                .then(a.point.x.total_cmp(&b.point.x))
                .then(a.scan_ordinal.cmp(&b.scan_ordinal));
        }
        a.point
            .group_code
            .cmp(&b.point.group_code)
            .then_with(|| a.point.x.total_cmp(&b.point.x))
            .then_with(|| (!a.point.y.is_finite()).cmp(&(!b.point.y.is_finite())))
            .then_with(|| a.point.y.total_cmp(&b.point.y))
            .then(a.scan_ordinal.cmp(&b.scan_ordinal))
    };
    let mut serial = 0usize;
    let mut flush =
        |buffer: &mut Vec<SourceRecord>, runs: &mut Vec<PathBuf>| -> Result<(), AppError> {
            control()?;
            buffer.sort_unstable_by(compare);
            let path = directory.path().join(format!("run-{serial}"));
            serial += 1;
            let mut writer = BufWriter::new(File::create(&path)?);
            for record in buffer.iter() {
                writer.write_all(&encode(*record))?;
            }
            writer.flush()?;
            runs.push(path);
            buffer.clear();
            Ok(())
        };
    pyramid
        .raw_store
        .as_ref()
        .ok_or_else(pressure)?
        .visit_source(control, &mut |mut row| {
            if line.is_some_and(|o| o.missing_factors == "skip")
                && missing_overlay == Some(row.point.group_code)
            {
                return Ok(());
            }
            if !row.point.x.is_finite() {
                if line.is_some_and(|o| o.missing_factors == "include") {
                    if let Some(x) = missing_category {
                        row.point.x = x;
                    } else {
                        return Ok(());
                    }
                } else {
                    return Ok(());
                }
            }
            buffer.push(row);
            if buffer.len() == 16384 {
                flush(&mut buffer, &mut runs)?;
            }
            Ok(())
        })?;
    if !buffer.is_empty() {
        flush(&mut buffer, &mut runs)?;
    }
    drop(flush);
    drop(buffer);
    let mut serial = serial;
    while runs.len() > 1 {
        let mut next = Vec::new();
        for pair in runs.chunks(2) {
            control()?;
            if pair.len() == 1 {
                next.push(pair[0].clone());
                continue;
            }
            let path = directory.path().join(format!("merge-{serial}"));
            serial += 1;
            let mut a = BufReader::new(File::open(&pair[0])?);
            let mut b = BufReader::new(File::open(&pair[1])?);
            let mut output = BufWriter::new(File::create(&path)?);
            let mut left = next_record(&mut a)?;
            let mut right = next_record(&mut b)?;
            let mut count = 0;
            while left.is_some() || right.is_some() {
                if count % 4096 == 0 {
                    control()?;
                }
                count += 1;
                let use_left = match (left, right) {
                    (Some(a), Some(b)) => compare(&a, &b) != Ordering::Greater,
                    (Some(_), None) => true,
                    _ => false,
                };
                let row = if use_left {
                    let row = left.take().unwrap();
                    left = next_record(&mut a)?;
                    row
                } else {
                    let row = right.take().unwrap();
                    right = next_record(&mut b)?;
                    row
                };
                output.write_all(&encode(row))?;
            }
            output.flush()?;
            drop(output);
            drop(a);
            drop(b);
            std::fs::remove_file(&pair[0])?;
            std::fs::remove_file(&pair[1])?;
            next.push(path);
        }
        runs = next;
    }
    let Some(path) = runs.first() else {
        return Ok(());
    };
    let mut file = BufReader::new(File::open(path)?);
    let mut row = next_record(&mut file)?;
    let (stat, interval) = match layer {
        GraphNewLayer::Points { options, .. } => (&options.summary_stat, &options.error_interval),
        GraphNewLayer::Line { options, .. } | GraphNewLayer::TimeSeries { options, .. } => {
            (&options.summary_stat, &options.error_interval)
        }
    };
    while let Some(first) = row {
        control()?;
        if stat == "none" {
            emit(
                Summary {
                    point: first.point,
                    low: first.point.y,
                    high: first.point.y,
                },
                first.scan_ordinal,
            )?;
            row = next_record(&mut file)?;
            continue;
        }
        let start = if stat == "median" {
            file.stream_position()? - RECORD_BYTES
        } else {
            0
        };
        let group = first.point.group_code;
        let x = first.point.x;
        let mut count = 0u64;
        let mut scale = 0_f64;
        let mut mean = 0_f64;
        let mut m2 = 0_f64;
        let mut identity = first;
        loop {
            let current = row.take().unwrap();
            if current.scan_ordinal < identity.scan_ordinal {
                identity = current;
            }
            if current.point.y.is_finite() {
                let y = current.point.y;
                let next_scale = scale.max(y.abs()).max(f64::MIN_POSITIVE);
                let ratio = scale / next_scale;
                mean *= ratio;
                m2 *= ratio * ratio;
                scale = next_scale;
                count += 1;
                let delta = y / scale - mean;
                mean += delta / count as f64;
                m2 += delta * (y / scale - mean);
            }
            if count % 4096 == 0 {
                control()?;
            }
            row = next_record(&mut file)?;
            if row.is_none_or(|r| r.point.group_code != group || r.point.x != x) {
                break;
            }
        }
        let next_position = if stat == "median" {
            file.stream_position()?
        } else {
            0
        };
        let y = if count == 0 {
            f64::NAN
        } else if stat == "median" {
            let middle = count / 2;
            file.seek(SeekFrom::Start(start + middle * RECORD_BYTES))?;
            let upper = read_record(&mut file)?.point.y;
            if count % 2 == 1 {
                upper
            } else {
                file.seek(SeekFrom::Start(start + (middle - 1) * RECORD_BYTES))?;
                read_record(&mut file)?.point.y / 2. + upper / 2.
            }
        } else if stat == "sum" {
            mean * count as f64 * scale
        } else {
            mean * scale
        };
        if stat == "median" {
            file.seek(SeekFrom::Start(next_position))?;
        }
        let sd = if count > 1 {
            (m2.max(0.) / (count - 1) as f64).sqrt() * scale
        } else {
            0.
        };
        let half = if interval == "none" {
            0.
        } else if interval == "stdDev" {
            sd
        } else {
            sd / (count.max(1) as f64).sqrt() * if interval == "ci95" { 1.96 } else { 1. }
        };
        if count > 0 && ![y, y - half, y + half].iter().all(|v| v.is_finite()) {
            return Err(AppError::Stats("graph_new_layer_overflow".into()));
        }
        identity.point.y = y;
        emit(
            Summary {
                point: identity.point,
                low: y - half,
                high: y + half,
            },
            identity.scan_ordinal,
        )?;
    }
    control()?;
    Ok(())
}
fn next_record(reader: &mut impl Read) -> Result<Option<SourceRecord>, AppError> {
    let mut bytes = [0u8; 40];
    let mut got = 0;
    while got < bytes.len() {
        let n = reader.read(&mut bytes[got..])?;
        if n == 0 {
            return if got == 0 {
                Ok(None)
            } else {
                Err(AppError::Stats("graph_new_invalid_cache".into()))
            };
        }
        got += n;
    }
    Ok(Some(read_record(&mut &bytes[..])?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::graph_new_lod::{SourcePoint, TilePyramidBuilder};
    fn fixture() -> TilePyramid {
        let mut builder = TilePyramidBuilder::new(2, 16, 1.5).unwrap();
        builder.retain_layer_source().unwrap();
        let rows: Vec<_> = (0..17000)
            .map(|i| SourcePoint::with_group(i + 1, 0., (i % 3 + 1) as f64, (i % 2) as u16))
            .collect();
        builder.push_batch(&rows).unwrap();
        builder.finish().unwrap()
    }
    #[test]
    fn graph_new_layers_cache_external_exact_median_and_cancellation() {
        let pyramid = fixture();
        let layer:GraphNewLayer=serde_json::from_value(serde_json::json!({"id":"p","kind":"points","options":{"summaryStat":"median","errorInterval":"stdDev"}})).unwrap();
        let samples =
            external_summary(&pyramid, &layer, None, None, 10 * 1024 * 1024, &|| Ok(())).unwrap();
        assert_eq!(samples.len(), 2);
        assert_eq!(samples[0].point.y, 2.);
        assert_eq!(samples[1].point.y, 2.);
        assert!(samples[0].high > 2.8 && samples[0].high < 2.9);
        assert!(external_summary(&pyramid, &layer, None, None, 1, &|| Ok(())).is_err());
        let cache: LayerCache = Arc::new(Mutex::new(None));
        let calls = std::cell::Cell::new(0);
        assert!(prepare(
            &pyramid,
            &cache,
            &[layer.clone()],
            10 * 1024 * 1024,
            &|| {
                calls.set(calls.get() + 1);
                if calls.get() > 2 {
                    Err(AppError::Cancelled("test".into()))
                } else {
                    Ok(())
                }
            }
        )
        .is_err());
        assert!(cache.lock().unwrap().is_none());
        let first = prepare(
            &pyramid,
            &cache,
            &[layer.clone()],
            10 * 1024 * 1024,
            &|| Ok(()),
        )
        .unwrap();
        let next = prepare(&pyramid, &cache, &[layer], 0, &|| Ok(())).unwrap();
        assert!(Arc::ptr_eq(&first, &next));
        assert_eq!(first.points.len(), 2);
    }
    #[test]
    fn graph_new_layers_cache_raw_scatter_keeps_lod_and_layer_options() {
        let pyramid = fixture();
        let layer: GraphNewLayer = serde_json::from_value(
            serde_json::json!({"id":"p","kind":"points","options":{"jitter":"normal"}}),
        )
        .unwrap();
        let p = prepare(&pyramid, &Arc::new(Mutex::new(None)), &[layer], 0, &|| {
            Ok(())
        })
        .unwrap();
        assert!(p.points.is_empty());
        assert_eq!(p.raw_points[0].1.jitter, "normal");
        assert_eq!(p.layer_marks, vec![17000]);
    }
    #[test]
    fn graph_new_layers_cache_two_million_unique_x_lines_and_camera_hits() {
        let started = std::time::Instant::now();
        let mut builder = TilePyramidBuilder::new(3, 128, 1.5).unwrap();
        builder.retain_layer_source().unwrap();
        for batch in 0..200 {
            let rows: Vec<_> = (batch * 10000..(batch + 1) * 10000)
                .map(|i| SourcePoint::new(i + 1, i as f64, (i % 1000) as f64))
                .collect();
            builder.push_batch(&rows).unwrap();
        }
        let pyramid = builder.finish().unwrap();
        let cache: LayerCache = Arc::new(Mutex::new(None));
        for kind in ["line", "timeSeries"] {
            let layers: Vec<GraphNewLayer> = serde_json::from_value(serde_json::json!([
                {"id":"scatter","kind":"points","options":{}},
                {"id":"line","kind":kind,"options":{}}
            ]))
            .unwrap();
            let prepare_started = std::time::Instant::now();
            let full = prepare(&pyramid, &cache, &layers, 400 * 1024 * 1024, &|| Ok(())).unwrap();
            assert!(full.lines.is_empty(), "no per-segment geometry allocation");
            assert_eq!(full.line_sources.len(), 1);
            assert_eq!(full.line_sources[0].count, 2_000_000);
            assert_eq!(full.raw_points.len(), 1);
            assert!(full.bytes() <= super::super::graph_new_layers::MAX_LAYER_BYTES);
            for _ in 0..20 {
                let next = prepare(&pyramid, &cache, &layers, 0, &|| Ok(())).unwrap();
                assert!(Arc::ptr_eq(&full, &next));
            }
            eprintln!(
                "2M unique X {kind} preparation + 20 cached cameras: {:.3}s",
                prepare_started.elapsed().as_secs_f64()
            );
            let mut scene = super::super::graph_new_renderer::GraphNewScene {
                width: 640,
                height: 480,
                device_pixel_ratio: 1.0,
                domain: pyramid.domain,
                points: vec![SourcePoint::new(1, 0.0, 0.0)],
                overlay: pyramid.overlay.clone(),
                enabled_groups: super::super::graph_new_overlay::EnabledOverlayMask::from_hidden(
                    &pyramid.overlay,
                    &[],
                )
                .unwrap(),
                mean: None,
                presentation: super::super::graph_new_renderer::ScenePresentation {
                    layer_geometry: Some(full),
                    ..Default::default()
                },
            };
            let prepared = scene.presentation.layer_geometry.as_ref().unwrap();
            let (pixels, _) = super::super::graph_new_line_pixels::rasterize(
                &prepared.line_sources,
                &prepared.line_raster,
                scene.domain,
                [640, 480],
                super::super::graph_new_renderer::pixel_plot(640, 480, 1.),
                1.,
                &scene.overlay,
                scene.enabled_groups,
                &|| Ok(()),
            )
            .unwrap();
            scene.presentation.raster =
                Some(Arc::new(super::super::graph_new_pixels::PixelRaster {
                    width: 640,
                    height: 480,
                    rgba: pixels.lines.clone(),
                    visible: 2_000_000,
                    occupied: 0,
                    work: Default::default(),
                }));
            let render_started = std::time::Instant::now();
            let frame = super::super::graph_new_renderer::GraphNewRenderer::render(&scene).unwrap();
            assert_eq!(frame.rgba.len(), 640 * 480 * 4);
            let blue_pixels = frame
                .rgba
                .chunks_exact(4)
                .filter(|pixel| i32::from(pixel[2]) - i32::from(pixel[0]) > 20)
                .count();
            assert!(
                blue_pixels > 1000,
                "expected a rendered line, got {blue_pixels} blue pixels"
            );
            eprintln!(
                "2M {kind} native GPU render/readback: {:.3}s",
                render_started.elapsed().as_secs_f64()
            );
        }
        eprintln!(
            "2M source construction + both configurations: {:.3}s",
            started.elapsed().as_secs_f64()
        );
    }
    #[test]
    fn graph_new_layers_cache_million_source_statistics_and_camera_hits() {
        use std::time::Instant;
        let started = Instant::now();
        let mut builder = TilePyramidBuilder::new(3, 128, 1.5).unwrap();
        builder.retain_layer_source().unwrap();
        for batch in 0..100 {
            let rows: Vec<_> = (batch * 10000..(batch + 1) * 10000)
                .map(|i| SourcePoint::new(i + 1, (i % 4) as f64, (i % 1000) as f64))
                .collect();
            builder.push_batch(&rows).unwrap();
        }
        let pyramid = builder.finish().unwrap();
        let cache: LayerCache = Arc::new(Mutex::new(None));
        let layer:GraphNewLayer=serde_json::from_value(serde_json::json!({"id":"p","kind":"points","options":{"summaryStat":"median","errorInterval":"none"}})).unwrap();
        let full = prepare(
            &pyramid,
            &cache,
            &[layer.clone()],
            200 * 1024 * 1024,
            &|| Ok(()),
        )
        .unwrap();
        assert_eq!(full.points.len(), 4);
        assert_eq!(full.points[0].point.y, 498.);
        assert!(full.bytes() < 4096);
        let checks = std::cell::Cell::new(0);
        for _ in 0..20 {
            let next = prepare(&pyramid, &cache, &[layer.clone()], 0, &|| {
                checks.set(checks.get() + 1);
                Ok(())
            })
            .unwrap();
            assert!(Arc::ptr_eq(&full, &next));
        }
        assert_eq!(checks.get(), 20);
        eprintln!(
            "1M source, exact median and 20 cached camera preparations: {:.3}s",
            started.elapsed().as_secs_f64()
        );
    }
}

#[cfg(test)]
#[test]
fn mean_line_groups_original_x_once_before_pixel_coverage() {
    use super::graph_new_lod::{GraphDomain, SourcePoint, TilePyramidBuilder};
    let mut builder = TilePyramidBuilder::new(2, 16, 1.5).unwrap();
    builder.retain_layer_source().unwrap();
    builder
        .push_batch(&[
            SourcePoint::new(1, 100.01, 200.),
            SourcePoint::new(2, 100.02, 20.),
            SourcePoint::new(3, 100.02, 40.),
            SourcePoint::new(4, 100.03, 200.),
        ])
        .unwrap();
    let pyramid = builder.finish().unwrap();
    let layer:GraphNewLayer=serde_json::from_value(serde_json::json!({"id":"line","kind":"line","options":{"summaryStat":"mean","errorInterval":"none"}})).unwrap();
    let prepared = prepare(
        &pyramid,
        &Arc::new(Mutex::new(None)),
        &[layer],
        1024 * 1024,
        &|| Ok(()),
    )
    .unwrap();
    assert_eq!(
        prepared.line_sources[0].count, 3,
        "three true X groups, never one screen bin"
    );
    assert_eq!(prepared.line_sources[0].extent.unwrap()[2], 30.);
    let enabled =
        super::graph_new_overlay::EnabledOverlayMask::from_hidden(&pyramid.overlay, &[]).unwrap();
    let (raster, _) = super::graph_new_line_pixels::rasterize(
        &prepared.line_sources,
        &prepared.line_raster,
        GraphDomain {
            x_min: 0.,
            x_max: 1000.,
            y_min: 0.,
            y_max: 220.,
        },
        [1000, 220],
        [0, 0, 1000, 220],
        1.,
        &pyramid.overlay,
        enabled,
        &|| Ok(()),
    )
    .unwrap();
    for y in 30..=200 {
        let offset = ((219 - y) * 1000 + 100) * 4;
        assert_eq!(&raster.lines[offset..offset + 4], &[31, 111, 235, 255]);
    }
}

/// Ordered unique X needs no aggregation; small grouped means need bounded accumulators only.
fn fast_summaries(
    pyramid: &TilePyramid,
    layer: &GraphNewLayer,
    missing_category: Option<f64>,
    missing_overlay: Option<u16>,
    control: &dyn Fn() -> Result<(), AppError>,
    emit: &mut dyn FnMut(Summary, u64) -> Result<(), AppError>,
) -> Result<bool, AppError> {
    let (stat, interval, line) = match layer {
        GraphNewLayer::Points { options, .. } => (
            options.summary_stat.as_str(),
            options.error_interval.as_str(),
            None,
        ),
        GraphNewLayer::Line { options, .. } | GraphNewLayer::TimeSeries { options, .. } => (
            options.summary_stat.as_str(),
            options.error_interval.as_str(),
            Some(options),
        ),
    };
    if stat == "none" {
        return Ok(false);
    }
    let raw = pyramid.raw_store.as_ref().ok_or_else(pressure)?;
    let normalize_row = |mut row: SourceRecord| -> Option<SourceRecord> {
        if line.is_some_and(|o| o.missing_factors == "skip")
            && missing_overlay == Some(row.point.group_code)
        {
            return None;
        }
        if !row.point.x.is_finite() {
            if line.is_some_and(|o| o.missing_factors == "include") {
                row.point.x = missing_category?;
            } else {
                return None;
            }
        }
        Some(row)
    };
    const FALLBACK: &str = "graph_new_internal_group_fallback";
    let mut previous: Option<(u16, f64)> = None;
    let ordered = raw.visit_source(control, &mut |row| {
        let Some(row) = normalize_row(row) else {
            return Ok(());
        };
        let key = (row.point.group_code, row.point.x);
        if previous.is_some_and(|p| p.0 > key.0 || (p.0 == key.0 && p.1 >= key.1)) {
            return Err(AppError::Stats(FALLBACK.into()));
        }
        previous = Some(key);
        Ok(())
    });
    match ordered {
        Ok(()) => {
            raw.visit_source(control, &mut |row| {
                if let Some(row) = normalize_row(row) {
                    emit(
                        Summary {
                            point: row.point,
                            low: row.point.y,
                            high: row.point.y,
                        },
                        row.scan_ordinal,
                    )?;
                }
                Ok(())
            })?;
            return Ok(true);
        }
        Err(AppError::Stats(code)) if code == FALLBACK => {}
        Err(error) => return Err(error),
    }
    if stat != "mean" && stat != "sum" {
        return Ok(false);
    }
    struct Acc {
        identity: SourceRecord,
        count: u64,
        scale: f64,
        mean: f64,
        m2: f64,
    }
    let mut groups = std::collections::HashMap::<(u16, u64), Acc>::new();
    let grouped = raw.visit_source(control, &mut |row| {
        let Some(row) = normalize_row(row) else {
            return Ok(());
        };
        let key = (
            row.point.group_code,
            if row.point.x == 0. {
                0
            } else {
                row.point.x.to_bits()
            },
        );
        if !groups.contains_key(&key) && groups.len() >= 65536 {
            return Err(AppError::Stats(FALLBACK.into()));
        }
        let acc = groups.entry(key).or_insert(Acc {
            identity: row,
            count: 0,
            scale: 0.,
            mean: 0.,
            m2: 0.,
        });
        if row.scan_ordinal < acc.identity.scan_ordinal {
            acc.identity = row;
        }
        if row.point.y.is_finite() {
            let scale = acc.scale.max(row.point.y.abs()).max(f64::MIN_POSITIVE);
            let ratio = acc.scale / scale;
            acc.mean *= ratio;
            acc.m2 *= ratio * ratio;
            acc.scale = scale;
            acc.count += 1;
            let delta = row.point.y / scale - acc.mean;
            acc.mean += delta / acc.count as f64;
            acc.m2 += delta * (row.point.y / scale - acc.mean);
        }
        Ok(())
    });
    match grouped {
        Ok(()) => {}
        Err(AppError::Stats(code)) if code == FALLBACK => return Ok(false),
        Err(error) => return Err(error),
    }
    let mut groups: Vec<_> = groups.into_values().collect();
    groups.sort_unstable_by(|a, b| {
        a.identity
            .point
            .group_code
            .cmp(&b.identity.point.group_code)
            .then(a.identity.point.x.total_cmp(&b.identity.point.x))
    });
    for (i, acc) in groups.into_iter().enumerate() {
        if i % 1024 == 0 {
            control()?;
        }
        let n = acc.count;
        let y = if n == 0 {
            f64::NAN
        } else {
            acc.mean * if stat == "sum" { n as f64 } else { 1. } * acc.scale
        };
        let sd = if n > 1 {
            (acc.m2.max(0.) / (n - 1) as f64).sqrt() * acc.scale
        } else {
            0.
        };
        let half = if interval == "none" {
            0.
        } else if interval == "stdDev" {
            sd
        } else {
            sd / (n.max(1) as f64).sqrt() * if interval == "ci95" { 1.96 } else { 1. }
        };
        if n > 0 && ![y, y - half, y + half].iter().all(|v| v.is_finite()) {
            return Err(AppError::Stats("graph_new_layer_overflow".into()));
        }
        let mut point = acc.identity.point;
        point.y = y;
        emit(
            Summary {
                point,
                low: y - half,
                high: y + half,
            },
            acc.identity.scan_ordinal,
        )?;
    }
    control()?;
    Ok(true)
}

#[cfg(test)]
#[test]
fn multiple_line_files_and_jitter_share_one_disk_budget() {
    use super::graph_new_lod::{SourcePoint, TilePyramidBuilder};
    let mut builder = TilePyramidBuilder::new(2, 16, 1.5).unwrap();
    builder.enable_pixel_mode();
    builder.retain_layer_source().unwrap();
    let rows: Vec<_> = (0..70000)
        .map(|i| SourcePoint::new(i + 1, (i ^ 1) as f64, (i % 100) as f64))
        .collect();
    builder.push_batch(&rows).unwrap();
    let pyramid = builder.finish().unwrap();
    let layers: Vec<GraphNewLayer> = serde_json::from_value(serde_json::json!([
     {"id":"first","kind":"line","options":{"summaryStat":"median"}},
     {"id":"second","kind":"line","options":{"summaryStat":"median"}}
    ]))
    .unwrap();
    let cache = Arc::new(Mutex::new(None));
    assert!(prepare(&pyramid, &cache, &layers, 12_000_000, &|| Ok(())).is_err());
    assert!(cache.lock().unwrap().is_none());
    let layers: Vec<GraphNewLayer> = serde_json::from_value(serde_json::json!([
     {"id":"points","kind":"points","options":{}},
     {"id":"line","kind":"line","options":{"summaryStat":"median"}}
    ]))
    .unwrap();
    let prepared = prepare(&pyramid, &cache, &layers, 12_000_000, &|| Ok(())).unwrap();
    assert_eq!(prepared.line_sources[0].count, 70000);
    assert!(prepared.jitter_limited && prepared.pixel_source.is_none());
}
