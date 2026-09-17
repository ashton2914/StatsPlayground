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

pub(crate) fn numeric_ticks(minimum: f64, maximum: f64) -> Result<Vec<NumericTick>, AppError> {
    validate_domain(minimum, maximum)?;
    let mut ticks: Vec<NumericTick> = Vec::with_capacity(5);
    let span = maximum - minimum;
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
    let spacing = ticks.windows(2).map(|pair| pair[1].value - pair[0].value)
        .fold(f64::INFINITY, f64::min);
    let tolerance = if spacing.is_finite() { spacing * 0.01 } else { 0.0 };
    for tick in &mut ticks {
        let value = tick.value;
        let mut label = format!("{value:.16e}");
        for precision in 0..=16 {
            for candidate in [format!("{value:.precision$}"), format!("{value:.precision$e}")] {
                if candidate.len() < label.len()
                    && candidate.parse::<f64>().is_ok_and(|parsed| (parsed - value).abs() <= tolerance)
                {
                    label = candidate;
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
        assert_eq!(ticks.len(), 5);
        assert!(ticks.iter().all(|tick| tick.label.len() <= 6), "{ticks:?}");
        assert!(ticks.windows(2).all(|pair| pair[0].label != pair[1].label));
        assert_eq!(ticks[0].label, "1.0001");
        assert_eq!(ticks[4].label, "1.0009");
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
            assert!(!ticks.is_empty() && ticks.len() <= 5);
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
