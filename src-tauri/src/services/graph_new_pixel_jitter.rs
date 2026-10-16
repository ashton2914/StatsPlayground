//! Build a complete, deterministic jittered source once; cameras reuse its pixel index.
use super::{
    graph_new_layers::PointOptions,
    graph_new_lod::GraphDomain,
    graph_new_pixels::PixelStore,
    graph_new_raw::{encode, read_record, SourceRecord, RECORD_BYTES},
    graph_new_ticks::normalized,
};
use crate::error::AppError;
use std::{
    fs::File,
    io::{BufReader, BufWriter, Write},
    path::PathBuf,
};
fn pressure() -> AppError {
    AppError::Stats("graph_new_cache_pressure".into())
}
fn bucket(row: &SourceRecord, domain: GraphDomain) -> (u64, u16, i64) {
    (
        if row.point.x == 0. {
            0
        } else {
            row.point.x.to_bits()
        },
        row.point.group_code,
        (normalized(row.point.y, domain.y_min, domain.y_max) * 128.).round() as i64,
    )
}
fn unit(id: u64, salt: u64) -> f64 {
    let mut n = id.wrapping_add(salt);
    n = (n ^ (n >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
    n = (n ^ (n >> 27)).wrapping_mul(0x94d049bb133111eb);
    ((n ^ (n >> 31)) >> 11) as f64 / (1u64 << 53) as f64
}
fn random(row: &SourceRecord, normal: bool) -> f64 {
    if normal {
        ((-2. * unit(row.scan_ordinal, 0x13198a2e03707344).max(1e-12).ln()).sqrt()
            * (std::f64::consts::TAU * unit(row.scan_ordinal, 0xa4093822299f31d0)).cos()
            / 3.)
            .clamp(-1., 1.)
    } else {
        unit(row.scan_ordinal, 0x243f6a8885a308d3) * 2. - 1.
    }
}
fn next(reader: &mut BufReader<File>, left: &mut u64) -> Result<Option<SourceRecord>, AppError> {
    if *left == 0 {
        return Ok(None);
    }
    *left -= 1;
    read_record(reader).map(Some)
}
pub fn prepare(
    source: &PixelStore,
    options: &PointOptions,
    domain: GraphDomain,
    categorical: bool,
    disk_limit: u64,
    control: &dyn Fn() -> Result<(), AppError>,
) -> Result<PixelStore, AppError> {
    let count = source.record_count();
    // Two merge copies plus the output spool/index coexist. No unbounded heap source.
    if count
        .checked_mul(RECORD_BYTES * 2 + 26 + 24)
        .is_none_or(|n| n > disk_limit)
    {
        return Err(pressure());
    }
    let dir = tempfile::tempdir()?;
    let mut runs = Vec::<PathBuf>::new();
    let mut buffer = Vec::with_capacity(16384);
    let mut serial = 0;
    let compare = |a: &SourceRecord, b: &SourceRecord| {
        a.point
            .x
            .total_cmp(&b.point.x)
            .then(a.point.group_code.cmp(&b.point.group_code))
            .then(bucket(a, domain).2.cmp(&bucket(b, domain).2))
            .then(a.scan_ordinal.cmp(&b.scan_ordinal))
    };
    let mut flush = |buffer: &mut Vec<SourceRecord>| -> Result<(), AppError> {
        control()?;
        buffer.sort_unstable_by(compare);
        let path = dir.path().join(format!("run-{serial}"));
        serial += 1;
        let mut out = BufWriter::new(File::create(&path)?);
        for row in buffer.iter() {
            out.write_all(&encode(*row))?;
        }
        out.flush()?;
        runs.push(path);
        buffer.clear();
        Ok(())
    };
    source.visit_source(control, &mut |row| {
        buffer.push(row);
        if buffer.len() == 16384 {
            flush(&mut buffer)?;
        }
        Ok(())
    })?;
    if !buffer.is_empty() {
        flush(&mut buffer)?;
    }
    drop(flush);
    drop(buffer);
    while runs.len() > 1 {
        let mut merged = Vec::new();
        for pair in runs.chunks(2) {
            control()?;
            if pair.len() == 1 {
                merged.push(pair[0].clone());
                continue;
            }
            let path = dir.path().join(format!("merge-{serial}"));
            serial += 1;
            let mut a = BufReader::new(File::open(&pair[0])?);
            let mut b = BufReader::new(File::open(&pair[1])?);
            let mut al = std::fs::metadata(&pair[0])?.len() / RECORD_BYTES;
            let mut bl = std::fs::metadata(&pair[1])?.len() / RECORD_BYTES;
            let mut ar = next(&mut a, &mut al)?;
            let mut br = next(&mut b, &mut bl)?;
            let mut out = BufWriter::new(File::create(&path)?);
            let mut processed = 0;
            while ar.is_some() || br.is_some() {
                if processed % 4096 == 0 {
                    control()?;
                }
                processed += 1;
                let left = match (&ar, &br) {
                    (Some(a), Some(b)) => compare(a, b).is_le(),
                    (Some(_), None) => true,
                    _ => false,
                };
                if left {
                    out.write_all(&encode(ar.take().ok_or_else(pressure)?))?;
                    ar = next(&mut a, &mut al)?;
                } else {
                    out.write_all(&encode(br.take().ok_or_else(pressure)?))?;
                    br = next(&mut b, &mut bl)?;
                }
            }
            out.flush()?;
            drop(out);
            std::fs::remove_file(&pair[0])?;
            std::fs::remove_file(&pair[1])?;
            merged.push(path);
        }
        runs = merged;
    }
    let Some(sorted) = runs.first() else {
        let file = tempfile::tempfile()?;
        return PixelStore::from_spool(BufReader::new(file), 0, 176 * 1024 * 1024, control);
    };
    let mut input = BufReader::new(File::open(sorted)?);
    let mut remaining = count;
    let mut previous: Option<f64> = None;
    let mut gap = f64::INFINITY;
    let mut sums = [0.; 64];
    let mut groups = [0u64; 64];
    let normal = options.jitter == "normal";
    for i in 0..count {
        if i % 4096 == 0 {
            control()?;
        }
        let row = next(&mut input, &mut remaining)?.ok_or_else(pressure)?;
        if let Some(x) = previous {
            let dx = row.point.x - x;
            if dx > 0. && dx.is_finite() {
                gap = gap.min(dx);
            }
        }
        previous = Some(row.point.x);
        sums[row.point.group_code as usize] += random(&row, normal);
        groups[row.point.group_code as usize] += 1;
    }
    for i in 0..64 {
        if groups[i] > 0 {
            sums[i] /= groups[i] as f64;
        }
    }
    let band = if categorical || !gap.is_finite() {
        1.
    } else {
        gap
    };
    let mut input = BufReader::new(File::open(sorted)?);
    let mut remaining = count;
    let mut maxima = [1_f64; 64];
    for i in 0..count {
        if i % 4096 == 0 {
            control()?;
        }
        let row = next(&mut input, &mut remaining)?.ok_or_else(pressure)?;
        let g = row.point.group_code as usize;
        maxima[g] = maxima[g].max((random(&row, normal) - sums[g]).abs());
    }
    let mut look = BufReader::new(File::open(sorted)?);
    let mut read = BufReader::new(File::open(sorted)?);
    let mut look_left = count;
    let mut read_left = count;
    let mut head = next(&mut look, &mut look_left)?;
    let mut spool = BufWriter::new(tempfile::tempfile()?);
    let mut emitted = 0;
    while let Some(first) = head {
        control()?;
        let key = bucket(&first, domain);
        let mut n = 1u64;
        loop {
            head = next(&mut look, &mut look_left)?;
            if head.as_ref().is_some_and(|row| bucket(row, domain) == key) {
                n += 1;
                if n % 4096 == 0 {
                    control()?;
                }
            } else {
                break;
            }
        }
        let spacing = if n > 1 {
            (band * 0.04 * options.jitter_limit).min(band * options.jitter_limit / (n - 1) as f64)
        } else {
            0.
        };
        for rank in 0..n {
            if emitted % 4096 == 0 {
                control()?;
            }
            let row = next(&mut read, &mut read_left)?.ok_or_else(pressure)?;
            let g = row.point.group_code as usize;
            let dx = if options.jitter == "stacked" {
                (rank as f64 - (n - 1) as f64 / 2.) * spacing
            } else {
                (random(&row, normal) - sums[g]) / maxima[g] * band * options.jitter_limit / 2.
            };
            let x = row.point.x + dx;
            if !x.is_finite() {
                return Err(AppError::Stats("graph_new_layer_overflow".into()));
            }
            spool.write_all(&row.point.row_id.to_le_bytes())?;
            spool.write_all(&x.to_le_bytes())?;
            spool.write_all(&row.point.y.to_le_bytes())?;
            spool.write_all(&row.point.group_code.to_le_bytes())?;
            emitted += 1;
        }
    }
    spool.flush()?;
    let mut file = spool
        .into_inner()
        .map_err(|e| AppError::FileIO(e.to_string()))?;
    use std::io::{Seek, SeekFrom};
    file.seek(SeekFrom::Start(0))?;
    PixelStore::from_spool(BufReader::new(file), count, 176 * 1024 * 1024, control)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::graph_new_overlay::{EnabledOverlayMask, OverlayCatalog};
    fn source(count: u64) -> PixelStore {
        let mut spool = BufWriter::new(tempfile::tempfile().unwrap());
        for i in 0..count {
            let x: f64 = if i + 1 == count { 3. } else { 1. };
            let y: f64 = if i + 1 == count { 9. } else { 2. };
            spool.write_all(&(i as i64 + 1).to_le_bytes()).unwrap();
            spool.write_all(&x.to_le_bytes()).unwrap();
            spool.write_all(&y.to_le_bytes()).unwrap();
            spool.write_all(&0u16.to_le_bytes()).unwrap();
        }
        spool.flush().unwrap();
        let mut file = spool.into_inner().unwrap();
        use std::io::{Seek, SeekFrom};
        file.seek(SeekFrom::Start(0)).unwrap();
        PixelStore::from_spool(BufReader::new(file), count, 176 * 1024 * 1024, &|| Ok(())).unwrap()
    }
    #[test]
    fn graph_new_pixel_jitter_merge_preserves_every_source_and_outlier_and_reuses_centers() {
        let count = 20_007;
        let source = source(count);
        let domain = GraphDomain {
            x_min: 0.,
            x_max: 4.,
            y_min: 0.,
            y_max: 10.,
        };
        let overlay = OverlayCatalog::default();
        let enabled = EnabledOverlayMask::from_hidden(&overlay, &[]).unwrap();
        for mode in ["stacked", "uniform", "normal"] {
            let options = PointOptions {
                jitter: mode.into(),
                ..Default::default()
            };
            let jittered = prepare(&source, &options, domain, true, u64::MAX, &|| Ok(())).unwrap();
            assert_eq!(jittered.record_count(), count);
            let mut left = false;
            let mut right = false;
            let mut outliers = 0;
            jittered
                .visit_source(&|| Ok(()), &mut |row| {
                    if row.point.y == 9. {
                        outliers += 1;
                        if mode == "stacked" {
                            assert_eq!(row.point.x, 3.);
                        } else {
                            assert!((row.point.x - 3.).abs() <= 0.5);
                        }
                    } else {
                        left |= row.point.x < 1.;
                        right |= row.point.x > 1.;
                    }
                    Ok(())
                })
                .unwrap();
            assert!(left && right, "{mode} must spread repeated X");
            assert_eq!(outliers, 1);
            let frame = jittered
                .raster(
                    domain,
                    [96, 64],
                    [64, 16, 16, 16],
                    1,
                    &overlay,
                    enabled,
                    &|| Ok(()),
                )
                .unwrap();
            assert_eq!(frame.visible, count);
            let cached = jittered
                .raster(
                    domain,
                    [96, 64],
                    [64, 16, 16, 16],
                    4,
                    &overlay,
                    enabled,
                    &|| Ok(()),
                )
                .unwrap();
            assert_eq!(cached.visible, count);
            assert_eq!(cached.work.raw_points_inspected, 0);
            let again = prepare(&source, &options, domain, true, u64::MAX, &|| Ok(())).unwrap();
            assert_eq!(
                again
                    .raster(
                        domain,
                        [96, 64],
                        [64, 16, 16, 16],
                        1,
                        &overlay,
                        enabled,
                        &|| Ok(())
                    )
                    .unwrap()
                    .rgba,
                frame.rgba
            );
        }
    }
    #[test]
    fn graph_new_pixel_jitter_checks_budget_and_cancellation_before_sorting() {
        let source = source(4);
        let domain = GraphDomain {
            x_min: 0.,
            x_max: 4.,
            y_min: 0.,
            y_max: 10.,
        };
        assert!(
            matches!(prepare(&source,&PointOptions::default(),domain,true,0,&||Ok(())),Err(AppError::Stats(s)) if s=="graph_new_cache_pressure")
        );
        assert!(matches!(
            prepare(
                &source,
                &PointOptions::default(),
                domain,
                true,
                u64::MAX,
                &|| Err(AppError::Cancelled("graph_new_cancelled".into()))
            ),
            Err(AppError::Cancelled(_))
        ));
    }
}
