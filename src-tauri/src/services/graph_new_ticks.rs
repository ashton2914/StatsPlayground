use crate::error::AppError;

#[derive(Debug, PartialEq)]
pub(crate) struct NumericTick {
    pub(crate) value: f64,
    pub(crate) position: f64,
    pub(crate) label: String,
}

pub(crate) fn validate_domain(minimum: f64, maximum: f64) -> Result<(), AppError> {
    if !minimum.is_finite() || !maximum.is_finite() || minimum > maximum {
        return Err(AppError::InvalidParam(
            "graph-new invalid numeric domain".into(),
        ));
    }
    Ok(())
}

pub(crate) fn normalized(value: f64, minimum: f64, maximum: f64) -> f64 {
    if minimum == maximum {
        return if value == minimum {
            0.5
        } else if value < minimum {
            -1.0
        } else {
            2.0
        };
    }
    let span = maximum - minimum;
    if span.is_finite() {
        (value - minimum) / span
    } else {
        (value * 0.5 - minimum * 0.5) / (maximum * 0.5 - minimum * 0.5)
    }
}

fn nice_step(span: f64) -> Option<f64> {
    if !span.is_finite() || span <= 0.0 {
        return None;
    }
    let raw = span / 4.0;
    if !raw.is_finite() || raw <= 0.0 {
        return None;
    }
    let exponent = raw.log10().floor();
    let magnitude = 10.0_f64.powf(exponent);
    if !magnitude.is_finite() || magnitude <= 0.0 {
        return None;
    }
    let normalized_raw = raw / magnitude;
    let nice_factor = if normalized_raw <= 1.25 {
        1.0
    } else if normalized_raw <= 2.25 {
        2.0
    } else if normalized_raw <= 3.5 {
        2.5
    } else if normalized_raw <= 7.5 {
        5.0
    } else {
        10.0
    };
    let step = nice_factor * magnitude;
    (step.is_finite() && step > 0.0).then_some(step)
}

pub(crate) fn numeric_ticks(minimum: f64, maximum: f64) -> Result<Vec<NumericTick>, AppError> {
    validate_domain(minimum, maximum)?;
    let mut ticks: Vec<NumericTick> = Vec::with_capacity(8);
    let span = maximum - minimum;
    if let Some(step) = nice_step(span) {
        let start = (minimum / step - 1e-9).ceil();
        let end = (maximum / step + 1e-9).floor();
        if start.is_finite()
            && end.is_finite()
            && start >= (i64::MIN / 2) as f64
            && end <= (i64::MAX / 2) as f64
            && end >= start
            && (end - start) <= 10.0
        {
            for index in (start as i64)..=(end as i64) {
                let raw_value = (index as f64) * step;
                let value = if raw_value.abs() <= step * 1e-12 { 0.0 } else { raw_value };
                let position = normalized(value, minimum, maximum);
                if position < -1e-9 || position > 1.0 + 1e-9 {
                    continue;
                }
                if ticks.last().is_some_and(|last| last.value >= value) {
                    continue;
                }
                ticks.push(NumericTick {
                    value,
                    position: position.clamp(0.0, 1.0),
                    label: String::new(),
                });
            }
        }
    }
    if ticks.is_empty() {
        for index in 0..5 {
            let fraction = index as f64 / 4.0;
            let value = if index == 0 {
                minimum
            } else if index == 4 {
                maximum
            } else if span.is_finite() {
                minimum + span * fraction
            } else {
                minimum * (1.0 - fraction) + maximum * fraction
            };
            if ticks.last().is_some_and(|last| last.value >= value) {
                continue;
            }
            ticks.push(NumericTick {
                value,
                position: normalized(value, minimum, maximum),
                label: String::new(),
            });
        }
    }
    let spacing = ticks.windows(2).map(|pair| pair[1].value - pair[0].value)
        .fold(f64::INFINITY, f64::min);
    let tolerance = if spacing.is_finite() { spacing * 0.01 } else { 0.0 };
    for tick in &mut ticks {
        let value = if tick.value == 0.0 { 0.0 } else { tick.value };
        let mut label = format!("{value:.16e}");
        for precision in 0..=16 {
            for candidate in [format!("{value:.precision$}"), format!("{value:.precision$e}")] {
                let cleaned = if candidate == "-0" { "0".to_string() } else { candidate };
                if cleaned.len() < label.len()
                    && cleaned.parse::<f64>().is_ok_and(|parsed| (parsed - value).abs() <= tolerance)
                {
                    label = cleaned;
                }
            }
        }
        tick.label = label;
    }
    Ok(ticks)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn close_decimal_ticks_use_compact_distinct_precision() {
        let ticks = numeric_ticks(1.0001, 1.0009).unwrap();
        assert_eq!(ticks.len(), 4);
        assert!(ticks.iter().all(|tick| tick.label.len() <= 6), "{ticks:?}");
        assert!(ticks.windows(2).all(|pair| pair[0].label != pair[1].label));
        assert_eq!(ticks[0].label, "1.0002");
        assert_eq!(ticks[3].label, "1.0008");
    }

    #[test]
    fn panning_preserves_world_anchored_tick_values() {
        let before = numeric_ticks(3.12, 4.48).unwrap();
        let after = numeric_ticks(3.01, 4.37).unwrap();
        let before_labels: Vec<&str> = before.iter().map(|t| t.label.as_str()).collect();
        let after_labels: Vec<&str> = after.iter().map(|t| t.label.as_str()).collect();
        assert_eq!(before_labels, vec!["3.25", "3.5", "3.75", "4", "4.25"]);
        assert_eq!(after_labels, vec!["3.25", "3.5", "3.75", "4", "4.25"]);
    }

    #[test]
    fn bounded_ticks_cover_constant_tiny_subnormal_and_large_domains() {
        for (minimum, maximum) in [
            (7.0, 7.0),
            (1e-200, 3e-200),
            (0.0, f64::from_bits(4)),
            (-f64::MAX, f64::MAX),
            (1e100, 1e100 + 1e85),
        ] {
            let ticks = numeric_ticks(minimum, maximum).expect("valid ticks");
            assert!(!ticks.is_empty() && ticks.len() <= 12);
            assert_eq!(ticks, numeric_ticks(minimum, maximum).unwrap());
            assert!(ticks.iter().all(|tick| tick.value.is_finite()
                && tick.position.is_finite()
                && (0.0..=1.0).contains(&tick.position)
                && tick.label.len() <= 24
                && tick
                    .label
                    .chars()
                    .all(|glyph| "-+.0123456789e".contains(glyph))));
            assert!(ticks
                .windows(2)
                .all(|pair| pair[0].value < pair[1].value && pair[0].label != pair[1].label));
            if minimum == maximum {
                assert_eq!(ticks[0].position, 0.5);
            }
        }
        assert!(numeric_ticks(f64::NAN, 1.0).is_err());
        assert!(numeric_ticks(2.0, 1.0).is_err());
        assert!(numeric_ticks(0.0, f64::INFINITY).is_err());
    }
}
