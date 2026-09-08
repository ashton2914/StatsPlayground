use std::collections::{BTreeMap, BTreeSet};

use statrs::distribution::{Continuous, ContinuousCDF, Normal, StudentsT};

use crate::engine::distribution_executor::{PreparedGroupV1, PreparedObservationV1};
use crate::error::AppError;
use crate::models::distribution::{DistributionHistogramDiagnosticsConfigV1, HistogramMethodV1};

const POSITION_EPSILON_FACTOR: f64 = 8.0 * f64::EPSILON;

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ContinuousSummaryV1 {
    pub n: u64,
    pub n_missing: u64,
    pub weight_sum: f64,
    pub n_eff: f64,
    pub mean: f64,
    pub std_dev: Option<f64>,
    pub std_dev_reason: Option<String>,
    pub std_error: Option<f64>,
    pub std_error_reason: Option<String>,
    pub mean_ci_lower: Option<f64>,
    pub mean_ci_upper: Option<f64>,
    pub mean_ci_reason: Option<String>,
    pub minimum: f64,
    pub maximum: f64,
    pub median: f64,
    pub primary_mode: f64,
    pub mode_is_unique: bool,
    pub modes: Vec<f64>,
    pub range: f64,
    pub iqr: f64,
    pub mad: f64,
}

pub(crate) fn weighted_type6(
    observations: &[PreparedObservationV1],
    probability: f64,
) -> Result<f64, AppError> {
    if !probability.is_finite() || !(0.0..=1.0).contains(&probability) {
        return Err(AppError::InvalidParam(
            "distribution.quantile.probabilityInvalid".to_string(),
        ));
    }
    if observations.is_empty() {
        return Err(AppError::Stats(
            "distribution.method.emptyGroup".to_string(),
        ));
    }
    let mut sorted = observations.to_vec();
    for observation in &mut sorted {
        if observation.y == 0.0 {
            observation.y = 0.0;
        }
    }
    sorted.sort_by(|left, right| {
        left.y
            .total_cmp(&right.y)
            .then(left.row_id.cmp(&right.row_id))
    });
    let frequency_total = sorted
        .iter()
        .try_fold(0_u64, |total, value| total.checked_add(value.frequency))
        .ok_or_else(|| {
            AppError::InvalidParam("distribution.method.frequencyOverflow".to_string())
        })?;
    let weight_total = compensated_sum(sorted.iter().map(|value| value.contribution));
    if frequency_total == 0 || !weight_total.is_finite() || weight_total <= 0.0 {
        return Err(AppError::Stats(
            "distribution.method.groupUnavailable".to_string(),
        ));
    }
    if probability == 0.0 {
        return Ok(sorted[0].y);
    }
    if probability == 1.0 {
        return Ok(sorted[sorted.len() - 1].y);
    }

    let logical_n = frequency_total as f64;
    let target = ((logical_n + 1.0) * probability).clamp(1.0, logical_n);
    let mut knots = Vec::<(f64, f64)>::with_capacity(sorted.len() + 1);
    let mut cumulative = 0.0;
    for observation in &sorted {
        cumulative += observation.contribution * logical_n / weight_total;
        let position = cumulative.max(1.0);
        let epsilon = position_epsilon(target, position);
        if let Some(previous) = knots.last_mut() {
            if (position - previous.0).abs() <= epsilon {
                *previous = (position, observation.y);
                continue;
            }
        }
        knots.push((position, observation.y));
    }
    if knots[0].0 > 1.0 {
        knots.insert(0, (1.0, sorted[0].y));
    }
    for &(position, value) in &knots {
        if (target - position).abs() <= position_epsilon(target, position) {
            return Ok(value);
        }
    }
    for pair in knots.windows(2) {
        let (left_position, left_value) = pair[0];
        let (right_position, right_value) = pair[1];
        if target < right_position {
            let denominator = right_position - left_position;
            if denominator <= position_epsilon(target, right_position) {
                return Ok(right_value);
            }
            let fraction = ((target - left_position) / denominator).clamp(0.0, 1.0);
            return Ok(left_value + fraction * (right_value - left_value));
        }
    }
    Ok(knots[knots.len() - 1].1)
}

pub(crate) fn continuous_summary(
    prepared: &PreparedGroupV1,
    confidence_level: f64,
) -> Result<ContinuousSummaryV1, AppError> {
    if !confidence_level.is_finite() || confidence_level <= 0.0 || confidence_level >= 1.0 {
        return Err(AppError::InvalidParam(
            "distribution.config.confidenceOutOfRange".to_string(),
        ));
    }
    if prepared.observations.is_empty() {
        return Err(AppError::Stats(
            "distribution.method.emptyGroup".to_string(),
        ));
    }
    let weight_sum = compensated_sum(prepared.observations.iter().map(|value| value.contribution));
    let weight_scale = prepared
        .observations
        .iter()
        .map(|value| value.weight)
        .max_by(f64::total_cmp)
        .ok_or_else(|| AppError::Stats("distribution.method.emptyGroup".to_string()))?;
    if !weight_scale.is_finite() || weight_scale <= 0.0 {
        return Err(AppError::Stats(
            "distribution.method.groupUnavailable".to_string(),
        ));
    }
    let normalized_weight_sum = compensated_sum(
        prepared
            .observations
            .iter()
            .map(|value| value.frequency as f64 * (value.weight / weight_scale)),
    );
    let normalized_weight_square_sum = compensated_sum(prepared.observations.iter().map(|value| {
        let weight = value.weight / weight_scale;
        value.frequency as f64 * weight * weight
    }));
    let n = prepared
        .observations
        .iter()
        .try_fold(0_u64, |total, value| total.checked_add(value.frequency))
        .ok_or_else(|| {
            AppError::InvalidParam("distribution.method.frequencyOverflow".to_string())
        })?;
    if weight_sum <= 0.0 || n == 0 {
        return Err(AppError::Stats(
            "distribution.method.groupUnavailable".to_string(),
        ));
    }
    let n_eff = normalized_weight_sum * normalized_weight_sum / normalized_weight_square_sum;
    if !n_eff.is_finite() || n_eff < 1.0 {
        return Err(AppError::Stats(
            "distribution.method.groupUnavailable".to_string(),
        ));
    }
    let mean = compensated_sum(
        prepared
            .observations
            .iter()
            .map(|value| value.frequency as f64 * (value.weight / weight_scale) * value.y),
    ) / normalized_weight_sum;
    let variance_numerator = compensated_sum(prepared.observations.iter().map(|value| {
        let deviation = value.y - mean;
        value.frequency as f64 * (value.weight / weight_scale) * deviation * deviation
    }));
    let denominator = normalized_weight_sum - normalized_weight_square_sum / normalized_weight_sum;
    let variance = (denominator > 0.0).then(|| variance_numerator / denominator);
    let std_dev = variance.map(|value| value.max(0.0).sqrt());
    let std_dev_reason = std_dev
        .is_none()
        .then(|| "summary.stdDevUnavailable.v1".to_string());
    let std_error = std_dev.map(|value| value / n_eff.sqrt());
    let std_error_reason = std_error
        .is_none()
        .then(|| "summary.stdErrorUnavailable.v1".to_string());
    let (mean_ci_lower, mean_ci_upper, mean_ci_reason) =
        mean_ci(mean, std_error, denominator, n_eff, confidence_level);
    let minimum = prepared
        .observations
        .iter()
        .map(|value| value.y)
        .min_by(f64::total_cmp)
        .ok_or_else(|| AppError::Stats("distribution.method.emptyGroup".to_string()))?;
    let maximum = prepared
        .observations
        .iter()
        .map(|value| value.y)
        .max_by(f64::total_cmp)
        .ok_or_else(|| AppError::Stats("distribution.method.emptyGroup".to_string()))?;
    let median = weighted_type6(&prepared.observations, 0.5)?;
    let q1 = weighted_type6(&prepared.observations, 0.25)?;
    let q3 = weighted_type6(&prepared.observations, 0.75)?;
    let deviations = prepared
        .observations
        .iter()
        .map(|value| PreparedObservationV1 {
            y: (value.y - median).abs(),
            ..value.clone()
        })
        .collect::<Vec<_>>();
    let mad = weighted_type6(&deviations, 0.5)?;
    let mut mode_mass = BTreeMap::<u64, (f64, f64)>::new();
    for value in &prepared.observations {
        let normalized = if value.y == 0.0 { 0.0 } else { value.y };
        let entry = mode_mass
            .entry(normalized.to_bits())
            .or_insert((normalized, 0.0));
        entry.1 += value.contribution;
    }
    let maximum_mass = mode_mass
        .values()
        .map(|(_, mass)| *mass)
        .max_by(f64::total_cmp)
        .ok_or_else(|| AppError::Stats("distribution.method.emptyGroup".to_string()))?;
    let mut modes = mode_mass
        .into_values()
        .filter_map(|(value, mass)| (mass == maximum_mass).then_some(value))
        .collect::<Vec<_>>();
    modes.sort_by(f64::total_cmp);
    let primary_mode = modes[0];
    let mode_is_unique = modes.len() == 1;

    Ok(ContinuousSummaryV1 {
        n,
        n_missing: prepared.n_missing,
        weight_sum,
        n_eff,
        mean,
        std_dev,
        std_dev_reason,
        std_error,
        std_error_reason,
        mean_ci_lower,
        mean_ci_upper,
        mean_ci_reason,
        minimum,
        maximum,
        median,
        primary_mode,
        mode_is_unique,
        modes,
        range: maximum - minimum,
        iqr: q3 - q1,
        mad,
    })
}

fn mean_ci(
    mean: f64,
    std_error: Option<f64>,
    denominator: f64,
    n_eff: f64,
    confidence_level: f64,
) -> (Option<f64>, Option<f64>, Option<String>) {
    let Some(std_error) = std_error else {
        return unavailable_mean_ci();
    };
    if denominator <= 0.0 || n_eff <= 1.0 {
        return unavailable_mean_ci();
    }
    let degrees_of_freedom = n_eff - 1.0;
    let Ok(distribution) = StudentsT::new(0.0, 1.0, degrees_of_freedom) else {
        return unavailable_mean_ci();
    };
    let alpha = 1.0 - confidence_level;
    let critical = distribution.inverse_cdf(1.0 - alpha / 2.0);
    if !critical.is_finite() {
        return unavailable_mean_ci();
    }
    let margin = critical * std_error;
    (Some(mean - margin), Some(mean + margin), None)
}

fn unavailable_mean_ci() -> (Option<f64>, Option<f64>, Option<String>) {
    (None, None, Some("summary.meanCiUnavailable.v1".to_string()))
}

fn compensated_sum(values: impl IntoIterator<Item = f64>) -> f64 {
    let mut sum = 0.0;
    let mut correction = 0.0;
    for value in values {
        let next = sum + value;
        correction += if sum.abs() >= value.abs() {
            (sum - next) + value
        } else {
            (value - next) + sum
        };
        sum = next;
    }
    sum + correction
}

fn position_epsilon(target: f64, position: f64) -> f64 {
    POSITION_EPSILON_FACTOR * target.abs().max(position.abs()).max(1.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::distribution_executor::{PreparedGroupV1, PreparedObservationV1};

    fn observation(row_id: i64, y: f64, weight: f64, frequency: u64) -> PreparedObservationV1 {
        PreparedObservationV1 {
            row_id,
            y,
            weight,
            frequency,
            contribution: weight * frequency as f64,
        }
    }

    fn group(observations: Vec<PreparedObservationV1>, n_missing: u64) -> PreparedGroupV1 {
        PreparedGroupV1 {
            key: Vec::new(),
            source_rows: observations.len() as u64 + n_missing,
            observations,
            n_missing,
            excluded_rows: 0,
        }
    }

    #[test]
    fn unweighted_type6_matches_exact_small_samples() {
        let sample = vec![
            observation(1, 1.0, 1.0, 1),
            observation(2, 2.0, 1.0, 1),
            observation(3, 3.0, 1.0, 1),
            observation(4, 4.0, 1.0, 1),
            observation(5, 5.0, 1.0, 1),
        ];
        assert_eq!(weighted_type6(&sample, 0.0).expect("p0"), 1.0);
        assert_eq!(weighted_type6(&sample, 0.25).expect("q1"), 1.5);
        assert_eq!(weighted_type6(&sample, 0.5).expect("median"), 3.0);
        assert_eq!(weighted_type6(&sample, 0.75).expect("q3"), 4.5);
        assert_eq!(weighted_type6(&sample, 1.0).expect("p1"), 5.0);
    }

    #[test]
    fn integer_frequency_matches_logical_expansion() {
        let weighted = vec![observation(1, 1.0, 1.0, 2), observation(2, 5.0, 1.0, 1)];
        let expanded = vec![
            observation(1, 1.0, 1.0, 1),
            observation(2, 1.0, 1.0, 1),
            observation(3, 5.0, 1.0, 1),
        ];
        for probability in [0.25, 0.5, 0.75] {
            assert_eq!(
                weighted_type6(&weighted, probability).expect("weighted"),
                weighted_type6(&expanded, probability).expect("expanded"),
            );
        }
    }

    #[test]
    fn weight_scaling_preserves_quantiles_and_mean() {
        let sample = group(
            vec![
                observation(1, 1.0, 1.0, 1),
                observation(2, 4.0, 2.0, 1),
                observation(3, 9.0, 3.0, 1),
            ],
            0,
        );
        let scaled = group(
            sample
                .observations
                .iter()
                .map(|value| {
                    observation(value.row_id, value.y, value.weight * 10.0, value.frequency)
                })
                .collect(),
            0,
        );
        assert_eq!(
            weighted_type6(&sample.observations, 0.5).expect("median"),
            weighted_type6(&scaled.observations, 0.5).expect("scaled median"),
        );
        assert_eq!(
            continuous_summary(&sample, 0.95).expect("summary").mean,
            continuous_summary(&scaled, 0.95)
                .expect("scaled summary")
                .mean,
        );
    }

    #[test]
    fn summary_marks_a_single_highest_contribution_as_unique_mode() {
        let summary = continuous_summary(
            &group(
                vec![
                    observation(1, 1.0, 1.0, 1),
                    observation(2, 2.0, 1.0, 3),
                    observation(3, 3.0, 1.0, 1),
                ],
                0,
            ),
            0.95,
        )
        .expect("summary");

        assert_eq!(summary.primary_mode, 2.0);
        assert_eq!(summary.modes, vec![2.0]);
        assert!(summary.mode_is_unique);
    }

    #[test]
    fn summary_marks_tied_highest_contributions_as_no_unique_mode() {
        let tied = group(
            vec![
                observation(1, 1.0, 1.0, 2),
                observation(2, 2.0, 1.0, 1),
                observation(3, 3.0, 1.0, 2),
            ],
            1,
        );
        let summary = continuous_summary(&tied, 0.95).expect("summary");
        assert_eq!(summary.n, 5);
        assert_eq!(summary.n_missing, 1);
        assert_eq!(summary.modes, vec![1.0, 3.0]);
        assert_eq!(summary.primary_mode, 1.0);
        assert!(!summary.mode_is_unique);
    }

    #[test]
    fn summary_marks_all_unique_values_as_no_unique_mode() {
        let summary = continuous_summary(
            &group(
                vec![
                    observation(1, 1.0, 1.0, 1),
                    observation(2, 2.0, 1.0, 1),
                    observation(3, 3.0, 1.0, 1),
                ],
                0,
            ),
            0.95,
        )
        .expect("summary");

        assert_eq!(summary.modes, vec![1.0, 2.0, 3.0]);
        assert!(!summary.mode_is_unique);
    }

    #[test]
    fn summary_reports_n1_unavailable_variance() {
        let singleton = continuous_summary(&group(vec![observation(1, 7.0, 1.0, 1)], 0), 0.95)
            .expect("singleton summary");
        assert_eq!(singleton.mean, 7.0);
        assert!(singleton.std_dev.is_none());
        assert_eq!(
            singleton.std_dev_reason.as_deref(),
            Some("summary.stdDevUnavailable.v1")
        );
        assert_eq!(
            singleton.mean_ci_reason.as_deref(),
            Some("summary.meanCiUnavailable.v1")
        );
    }

    #[test]
    fn summary_rejects_invalid_confidence() {
        assert!(continuous_summary(&group(vec![observation(1, 1.0, 1.0, 1)], 0), 1.0,).is_err());
    }

    #[test]
    fn extreme_positive_weight_scaling_preserves_summary() {
        let base = group(
            vec![observation(1, 1.0, 1.0, 1), observation(2, 5.0, 2.0, 1)],
            0,
        );
        let scaled = group(
            vec![
                observation(1, 1.0, 1.0e154, 1),
                observation(2, 5.0, 2.0e154, 1),
            ],
            0,
        );
        let base_summary = continuous_summary(&base, 0.95).expect("base summary");
        let scaled_summary = continuous_summary(&scaled, 0.95).expect("scaled summary");
        assert!((base_summary.mean - scaled_summary.mean).abs() <= 1e-12);
        assert!((base_summary.n_eff - scaled_summary.n_eff).abs() <= 1e-12);
        assert!((base_summary.std_dev.unwrap() - scaled_summary.std_dev.unwrap()).abs() <= 1e-12);
    }

    #[test]
    fn constant_sample_has_zero_width_mean_ci_when_defined() {
        let summary = continuous_summary(
            &group(
                vec![observation(1, 4.0, 1.0, 1), observation(2, 4.0, 1.0, 1)],
                0,
            ),
            0.95,
        )
        .expect("constant summary");
        assert_eq!(summary.std_dev, Some(0.0));
        assert_eq!(summary.mean_ci_lower, Some(4.0));
        assert_eq!(summary.mean_ci_upper, Some(4.0));
    }

    #[test]
    fn quantiles_normalize_negative_zero() {
        let sample = vec![observation(1, -0.0, 1.0, 1), observation(2, 0.0, 1.0, 1)];
        assert_eq!(
            weighted_type6(&sample, 0.0).expect("minimum").to_bits(),
            0.0_f64.to_bits()
        );
        assert_eq!(
            weighted_type6(&sample, 0.5).expect("median").to_bits(),
            0.0_f64.to_bits()
        );
    }

    #[test]
    fn histogram_probabilities_and_density_are_normalized() {
        let sample = group(
            (1..=8)
                .map(|value| observation(value, value as f64, 1.0, 1))
                .collect(),
            0,
        );
        let histogram = histogram(
            &sample,
            &DistributionHistogramDiagnosticsConfigV1 {
                method: HistogramMethodV1::FreedmanDiaconis,
                fixed_count: None,
                fixed_width: None,
            },
        )
        .expect("histogram");
        assert!(!histogram.bins.is_empty());
        assert!(
            (histogram
                .bins
                .iter()
                .map(|bin| bin.probability)
                .sum::<f64>()
                - 1.0)
                .abs()
                < 1e-12
        );
        assert!(
            (histogram
                .bins
                .iter()
                .map(|bin| bin.density * (bin.upper - bin.lower))
                .sum::<f64>()
                - 1.0)
                .abs()
                < 1e-12
        );
        assert_eq!(histogram.bins.iter().map(|bin| bin.count).sum::<f64>(), 8.0);
    }

    #[test]
    fn histogram_dispatch_supports_all_documented_methods() {
        let sample = group(
            (1..=32)
                .map(|value| observation(value, value as f64, 1.0, 1))
                .collect(),
            0,
        );

        for method in [
            HistogramMethodV1::FreedmanDiaconis,
            HistogramMethodV1::Scott,
            HistogramMethodV1::Sturges,
            HistogramMethodV1::FixedCount,
            HistogramMethodV1::FixedWidth,
        ] {
            let config = DistributionHistogramDiagnosticsConfigV1 {
                method,
                fixed_count: Some(8),
                fixed_width: Some(2.0),
            };
            let result = histogram(&sample, &config).expect("histogram method");
            assert!(!result.bins.is_empty());
            assert!((result.bins.iter().map(|bin| bin.count).sum::<f64>() - 32.0).abs() < 1e-12);
            assert!(
                (result.bins.iter().map(|bin| bin.probability).sum::<f64>() - 1.0).abs() < 1e-12
            );
        }
    }

    #[test]
    fn histogram_fixed_width_and_count_reject_invalid_bounds() {
        let sample = group(
            (1..=8)
                .map(|value| observation(value, value as f64, 1.0, 1))
                .collect(),
            0,
        );

        let bad_count = histogram(
            &sample,
            &DistributionHistogramDiagnosticsConfigV1 {
                method: HistogramMethodV1::FixedCount,
                fixed_count: Some(0),
                fixed_width: None,
            },
        )
        .expect_err("fixedCount=0 must fail");
        assert!(matches!(
            bad_count,
            AppError::InvalidParam(code) if code == "distribution.config.histogramFixedCountOutOfRange"
        ));

        let bad_width = histogram(
            &sample,
            &DistributionHistogramDiagnosticsConfigV1 {
                method: HistogramMethodV1::FixedWidth,
                fixed_count: None,
                fixed_width: Some(0.0),
            },
        )
        .expect_err("fixedWidth<=0 must fail");
        assert!(matches!(
            bad_width,
            AppError::InvalidParam(code) if code == "distribution.config.histogramFixedWidthInvalid"
        ));
    }

    #[test]
    fn histogram_jmp_auto_is_not_reported_as_validated_compatibility() {
        let sample = group(
            vec![
                observation(1, 1.0, 1.0, 1),
                observation(2, 1.5, 1.0, 1),
                observation(3, 2.0, 1.0, 1),
            ],
            0,
        );
        let result = histogram(
            &sample,
            &DistributionHistogramDiagnosticsConfigV1 {
                method: HistogramMethodV1::JmpAuto,
                fixed_count: None,
                fixed_width: None,
            },
        )
        .expect("jmpAuto fallback histogram");
        assert!(!result.bins.is_empty());
    }

    #[test]
    fn fixed_count_uses_exact_requested_bins_and_covers_min_max_with_last_bin_right_closed() {
        let sample = group(
            vec![
                observation(1, 0.3, 1.0, 1),
                observation(2, 0.6, 1.0, 1),
                observation(3, 1.0, 1.0, 1),
            ],
            0,
        );
        let histogram = histogram(
            &sample,
            &DistributionHistogramDiagnosticsConfigV1 {
                method: HistogramMethodV1::FixedCount,
                fixed_count: Some(3),
                fixed_width: None,
            },
        )
        .expect("fixed count histogram");
        assert_eq!(histogram.bins.len(), 3, "must keep requested bin count");
        assert!((histogram.bins[0].lower - 0.3).abs() <= 1e-12);
        assert!((histogram.bins[2].upper - 1.0).abs() <= 1e-12);
        assert_eq!(histogram.bins.iter().map(|bin| bin.count).sum::<f64>(), 3.0);
        assert_eq!(
            histogram.bins[2].count, 1.0,
            "max value must fall into final bin"
        );
    }

    #[test]
    fn constant_sample_produces_single_finite_positive_width_bin_for_fixed_count() {
        let sample = group(
            vec![
                observation(1, -2.0, 1.0, 1),
                observation(2, -2.0, 1.0, 1),
                observation(3, -2.0, 1.0, 1),
            ],
            0,
        );
        let histogram = histogram(
            &sample,
            &DistributionHistogramDiagnosticsConfigV1 {
                method: HistogramMethodV1::FixedCount,
                fixed_count: Some(10),
                fixed_width: None,
            },
        )
        .expect("constant fixed count histogram");
        assert_eq!(histogram.bins.len(), 1);
        let bin = &histogram.bins[0];
        assert!(bin.lower.is_finite() && bin.upper.is_finite());
        assert!(bin.upper > bin.lower, "constant bin width must be positive");
        assert!(bin.lower <= -2.0 && -2.0 <= bin.upper);
    }

    #[test]
    fn weighted_and_frequency_contributions_are_preserved_and_normalized() {
        let sample = group(
            vec![
                observation(1, 1.0, 2.0, 3),
                observation(2, 2.0, 1.5, 2),
                observation(3, 3.0, 0.5, 4),
            ],
            0,
        );
        let histogram = histogram(
            &sample,
            &DistributionHistogramDiagnosticsConfigV1 {
                method: HistogramMethodV1::FixedCount,
                fixed_count: Some(2),
                fixed_width: None,
            },
        )
        .expect("weighted+freq histogram");
        assert_eq!(
            histogram.bins.iter().map(|bin| bin.count).sum::<f64>(),
            11.0
        );
        assert!(
            (histogram
                .bins
                .iter()
                .map(|bin| bin.probability)
                .sum::<f64>()
                - 1.0)
                .abs()
                < 1e-12
        );
        assert!(
            (histogram
                .bins
                .iter()
                .map(|bin| bin.density * (bin.upper - bin.lower))
                .sum::<f64>()
                - 1.0)
                .abs()
                < 1e-12
        );
        assert!((histogram.bins[0].count - 6.0).abs() < 1e-12);
        assert!((histogram.bins[1].count - 5.0).abs() < 1e-12);
    }

    #[test]
    fn freedman_diaconis_scott_and_sturges_produce_expected_width_or_bin_count() {
        let sample = group(
            (1..=8)
                .map(|value| observation(value, value as f64, 1.0, 1))
                .collect(),
            0,
        );

        let fd = histogram(
            &sample,
            &DistributionHistogramDiagnosticsConfigV1 {
                method: HistogramMethodV1::FreedmanDiaconis,
                fixed_count: None,
                fixed_width: None,
            },
        )
        .expect("fd");
        assert_eq!(fd.bins.len(), 2);
        assert!(((fd.bins[0].upper - fd.bins[0].lower) - 4.5).abs() < 1e-12);

        let scott = histogram(
            &sample,
            &DistributionHistogramDiagnosticsConfigV1 {
                method: HistogramMethodV1::Scott,
                fixed_count: None,
                fixed_width: None,
            },
        )
        .expect("scott");
        assert_eq!(scott.bins.len(), 2);
        assert!(((scott.bins[0].upper - scott.bins[0].lower) - 4.286607049870562).abs() < 1e-9);

        let sturges = histogram(
            &sample,
            &DistributionHistogramDiagnosticsConfigV1 {
                method: HistogramMethodV1::Sturges,
                fixed_count: None,
                fixed_width: None,
            },
        )
        .expect("sturges");
        assert_eq!(sturges.bins.len(), 4);
    }

    #[test]
    fn fixed_width_uses_floor_anchor_and_boundary_assignment() {
        let sample = group(
            vec![
                observation(1, 0.3, 1.0, 1),
                observation(2, 0.5, 1.0, 1),
                observation(3, 0.8, 1.0, 1),
                observation(4, 1.0, 1.0, 1),
            ],
            0,
        );
        let histogram = histogram(
            &sample,
            &DistributionHistogramDiagnosticsConfigV1 {
                method: HistogramMethodV1::FixedWidth,
                fixed_count: None,
                fixed_width: Some(0.5),
            },
        )
        .expect("fixed width histogram");
        assert!(
            (histogram.bins[0].lower - 0.0).abs() <= 1e-12,
            "anchor must be floor(min/width)*width"
        );
        assert_eq!(histogram.bins.len(), 3);
        assert!((histogram.bins[0].count - 1.0).abs() <= 1e-12);
        assert!(
            (histogram.bins[1].count - 2.0).abs() <= 1e-12,
            "interior right boundary belongs to next bin"
        );
        assert!(
            (histogram.bins[2].count - 1.0).abs() <= 1e-12,
            "final bin must include max boundary"
        );
    }

    #[test]
    fn tukey_box_uses_observed_whiskers_and_aggregates_outliers() {
        let sample = group(
            (1..=9)
                .map(|value| observation(value, value as f64, 1.0, 1))
                .chain(std::iter::once(observation(10, 100.0, 1.0, 2)))
                .collect(),
            0,
        );
        let box_plot = tukey_box(&sample, 0.95).expect("box plot");
        assert_eq!(box_plot.lower_whisker, 1.0);
        assert_eq!(box_plot.upper_whisker, 9.0);
        assert_eq!(box_plot.outliers.len(), 1);
        assert_eq!(box_plot.outliers[0].value, 100.0);
        assert_eq!(box_plot.outliers[0].contribution, 2.0);
    }

    #[test]
    fn weighted_ecdf_aggregates_ties_and_finishes_at_one() {
        let sample = group(
            vec![
                observation(1, 1.0, 1.0, 1),
                observation(2, 1.0, 2.0, 1),
                observation(3, 4.0, 1.0, 1),
            ],
            0,
        );
        let ecdf = weighted_ecdf(&sample).expect("ecdf");
        assert_eq!(
            ecdf.points.first().map(|point| point.probability),
            Some(0.0)
        );
        assert_eq!(ecdf.jumps.len(), 2);
        assert_eq!(ecdf.jumps[0].contribution, 3.0);
        assert_eq!(ecdf.points.last().map(|point| point.probability), Some(1.0));
    }

    #[test]
    fn normal_quantile_matches_documented_rank_over_n_plus_one_for_unique_unweighted_values() {
        let sample = group(
            vec![
                observation(1, 3.0, 1.0, 1),
                observation(2, -2.0, 1.0, 1),
                observation(3, 0.0, 1.0, 1),
            ],
            0,
        );
        let kernel = normal_quantile_plot(&sample, false, 0.95, 2_000).expect("normal quantile");
        assert_eq!(kernel.status, NormalQuantileKernelStatusV1::Available);
        assert_eq!(kernel.reason_code.as_deref(), None);
        assert_eq!(kernel.points.len(), 3);
        assert_eq!(kernel.points[0].observed_value, -2.0);
        assert!((kernel.points[0].probability - 0.25).abs() <= 1e-12);
        assert!((kernel.points[0].normal_score - -0.6744897501960817).abs() <= 1e-12);
        assert_eq!(kernel.points[1].observed_value, 0.0);
        assert!((kernel.points[1].probability - 0.5).abs() <= 1e-12);
        assert!(kernel.points[1].normal_score.abs() <= 1e-12);
        assert_eq!(kernel.points[2].observed_value, 3.0);
        assert!((kernel.points[2].probability - 0.75).abs() <= 1e-12);
        assert!((kernel.points[2].normal_score - 0.6744897501960817).abs() <= 1e-12);
        assert!(!kernel.reference_line.is_empty());
        assert!(!kernel.confidence_band.is_empty());
        assert!(!kernel.has_ties);
    }

    #[test]
    fn normal_quantile_marks_ties_as_pending_evidence_without_failing() {
        let sample = group(
            vec![
                observation(1, -2.0, 1.0, 1),
                observation(2, -2.0, 1.0, 1),
                observation(3, 0.0, 1.0, 1),
                observation(4, 3.0, 1.0, 1),
                observation(5, 3.0, 1.0, 1),
            ],
            0,
        );
        let kernel =
            normal_quantile_plot(&sample, false, 0.95, 2_000).expect("normal quantile with ties");
        assert_eq!(kernel.status, NormalQuantileKernelStatusV1::Available);
        assert!(kernel.has_ties);
        assert_eq!(kernel.points.len(), 5);
    }

    #[test]
    fn normal_quantile_supports_frequency_without_unbounded_materialization() {
        let sample = group(
            vec![
                observation(1, -3.0, 1.0, 1),
                observation(2, -1.0, 1.0, 1),
                observation(3, 0.0, 1.0, 1),
                observation(4, 2.0, 1.0, 1),
                observation(5, 5.0, 1.0, 1),
            ],
            0,
        );
        let documented =
            normal_quantile_plot(&sample, false, 0.95, 2_000).expect("documented freq=1");
        assert_eq!(documented.points.len(), 5);
        assert!((documented.points[0].normal_score - -0.967421566101701).abs() <= 1e-12);
        assert!((documented.points[4].normal_score - 0.967421566101701).abs() <= 1e-12);

        let logical_large = group(vec![observation(1, 42.0, 1.0, 20_001)], 0);
        let sampled =
            normal_quantile_plot(&logical_large, false, 0.95, 2_000).expect("downsampled");
        assert!(sampled.points.len() <= 2_000);
        assert_eq!(sampled.points.first().map(|point| point.rank), Some(1));
        assert_eq!(sampled.points.last().map(|point| point.rank), Some(20_001));
    }

    #[test]
    fn normal_quantile_compact_mixed_frequency_matches_expanded_points_when_bounded() {
        let compact = group(
            vec![
                observation(1, -4.0, 1.0, 701),
                observation(2, -1.0, 1.0, 803),
                observation(3, 0.5, 1.0, 907),
                observation(4, 2.0, 1.0, 809),
            ],
            0,
        );

        let mut expanded_rows = Vec::new();
        let mut row_id = 1_i64;
        for (value, frequency) in [
            (-4.0, 701_u64),
            (-1.0, 803_u64),
            (0.5, 907_u64),
            (2.0, 809_u64),
        ] {
            for _ in 0..frequency {
                expanded_rows.push(observation(row_id, value, 1.0, 1));
                row_id += 1;
            }
        }
        let expanded = group(expanded_rows, 0);

        let compact_kernel =
            normal_quantile_plot(&compact, false, 0.95, 2_000).expect("compact kernel");
        let expanded_kernel =
            normal_quantile_plot(&expanded, false, 0.95, 2_000).expect("expanded kernel");

        assert_eq!(
            compact_kernel.status,
            NormalQuantileKernelStatusV1::Available
        );
        assert_eq!(
            expanded_kernel.status,
            NormalQuantileKernelStatusV1::Available
        );
        assert_eq!(compact_kernel.points.len(), expanded_kernel.points.len());
        assert!(compact_kernel.points.len() <= 2_000);

        for (compact_point, expanded_point) in compact_kernel
            .points
            .iter()
            .zip(expanded_kernel.points.iter())
        {
            assert_eq!(compact_point.rank, expanded_point.rank);
            assert!((compact_point.probability - expanded_point.probability).abs() <= 1e-12);
            assert!((compact_point.normal_score - expanded_point.normal_score).abs() <= 1e-12);
            assert!((compact_point.observed_value - expanded_point.observed_value).abs() <= 1e-12);
        }
    }

    #[test]
    fn normal_quantile_rank_grid_above_two_thousand_keeps_first_center_and_last_rank() {
        let logical_n = 5_001_u64;
        let sample = group(vec![observation(1, 42.0, 1.0, logical_n)], 0);
        let kernel = normal_quantile_plot(&sample, false, 0.95, 2_000).expect("large logical n");

        let center = (logical_n + 1) / 2;
        let ranks = kernel
            .points
            .iter()
            .map(|point| point.rank)
            .collect::<Vec<_>>();
        assert_eq!(ranks.first().copied(), Some(1));
        assert!(ranks.contains(&center));
        assert_eq!(ranks.last().copied(), Some(logical_n));
        assert!(ranks.len() <= 2_000);
    }

    #[test]
    fn deterministic_rank_grid_preserves_priority_rank_neighborhoods_under_cap() {
        let logical_n = 5_001_u64;
        let ranks = deterministic_rank_grid(logical_n, 2_000, &[2, 2_500, 5_000]);
        assert!(ranks.len() <= 2_000);

        for required in [1_u64, 2, 3, 2_499, 2_500, 2_501, 4_999, 5_000, 5_001] {
            assert!(ranks.contains(&required), "missing required priority neighborhood rank {required}");
        }
    }

    #[test]
    fn normal_quantile_priority_values_force_spec_neighborhood_ranks_into_points() {
        let logical_n = 5_001_u64;
        let observations = (1..=logical_n)
            .map(|rank| observation(rank as i64, rank as f64, 1.0, 1))
            .collect::<Vec<_>>();
        let sample = group(observations, 0);
        let kernel = normal_quantile_plot_with_priorities(
            &sample,
            false,
            0.95,
            2_000,
            &[2.1, 2_500.49, 4_999.6],
            &[],
        )
        .expect("priority values");

        let ranks = kernel
            .points
            .iter()
            .map(|point| point.rank)
            .collect::<Vec<_>>();
        for required in [1_u64, 2, 3, 2_499, 2_500, 2_501, 4_999, 5_000, 5_001] {
            assert!(
                ranks.contains(&required),
                "missing required mapped neighborhood rank {required}"
            );
        }
        assert!(ranks.len() <= 2_000);
    }

    #[test]
    fn normal_quantile_without_priority_values_matches_legacy_api_output() {
        let sample = group(
            vec![
                observation(1, -2.0, 1.0, 1),
                observation(2, 0.0, 1.0, 1),
                observation(3, 3.0, 1.0, 1),
            ],
            0,
        );
        let legacy = normal_quantile_plot(&sample, false, 0.95, 2_000).expect("legacy");
        let explicit = normal_quantile_plot_with_priorities(
            &sample,
            false,
            0.95,
            2_000,
            &[],
            &[],
        )
        .expect("explicit empty priorities");
        assert_eq!(legacy, explicit);
    }

    #[test]
    fn normal_quantile_n1_n2_and_constant_emit_finite_available_payloads() {
        let singleton = normal_quantile_plot(
            &group(vec![observation(1, 7.0, 1.0, 1)], 0),
            false,
            0.95,
            2_000,
        )
        .expect("n=1");
        let pair = normal_quantile_plot(
            &group(
                vec![observation(1, 1.0, 1.0, 1), observation(2, 2.0, 1.0, 1)],
                0,
            ),
            false,
            0.95,
            2_000,
        )
        .expect("n=2");
        let constant = normal_quantile_plot(
            &group(
                vec![
                    observation(1, 5.0, 1.0, 1),
                    observation(2, 5.0, 1.0, 1),
                    observation(3, 5.0, 1.0, 1),
                ],
                0,
            ),
            false,
            0.95,
            2_000,
        )
        .expect("constant");

        for kernel in [singleton, pair, constant] {
            assert_eq!(kernel.status, NormalQuantileKernelStatusV1::Available);
            assert_eq!(kernel.reason_code, None);
            assert!(!kernel.points.is_empty());
            assert!(!kernel.reference_line.is_empty());
            assert!(!kernel.confidence_band.is_empty());

            for point in &kernel.points {
                assert!(point.rank >= 1);
                assert!(point.probability.is_finite());
                assert!(point.normal_score.is_finite());
                assert!(point.observed_value.is_finite());
            }
            for point in &kernel.reference_line {
                assert!(point.x.is_finite());
                assert!(point.probability.is_finite());
            }
            for band in &kernel.confidence_band {
                assert!(band.x.is_finite());
                assert!(band.lower.is_finite());
                assert!(band.upper.is_finite());
            }
        }
    }

    #[test]
    fn normal_quantile_weight_returns_typed_unavailable_reason() {
        let sample = group(
            vec![observation(1, 1.0, 2.0, 1), observation(2, 4.0, 1.0, 1)],
            0,
        );
        let kernel = normal_quantile_plot(&sample, true, 0.95, 2_000).expect("weight unavailable");
        assert_eq!(kernel.status, NormalQuantileKernelStatusV1::Unavailable);
        assert_eq!(
            kernel.reason_code.as_deref(),
            Some("normalQuantile.weightUnsupported.v1")
        );
        assert!(kernel.points.is_empty());
    }


}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct HistogramBinDataV1 {
    pub lower: f64,
    pub upper: f64,
    pub count: f64,
    pub probability: f64,
    pub density: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct HistogramKernelV1 {
    pub bins: Vec<HistogramBinDataV1>,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct BoxOutlierV1 {
    pub value: f64,
    pub contribution: f64,
    pub source_row_count: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct BoxKernelV1 {
    pub lower_quartile: f64,
    pub median: f64,
    pub upper_quartile: f64,
    pub lower_whisker: f64,
    pub upper_whisker: f64,
    pub outliers: Vec<BoxOutlierV1>,
    pub mean_ci_lower: Option<f64>,
    pub mean_ci_upper: Option<f64>,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct EcdfPointV1 {
    pub x: f64,
    pub probability: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct EcdfJumpV1 {
    pub value: f64,
    pub contribution: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct EcdfKernelV1 {
    pub points: Vec<EcdfPointV1>,
    pub jumps: Vec<EcdfJumpV1>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum NormalQuantileKernelStatusV1 {
    Available,
    Unavailable,
    Failed,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct NormalQuantilePointDataV1 {
    pub rank: u64,
    pub probability: f64,
    pub normal_score: f64,
    pub observed_value: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct NormalQuantileBandDataV1 {
    pub x: f64,
    pub lower: f64,
    pub upper: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct NormalQuantileKernelV1 {
    pub points: Vec<NormalQuantilePointDataV1>,
    pub reference_line: Vec<EcdfPointV1>,
    pub confidence_band: Vec<NormalQuantileBandDataV1>,
    pub status: NormalQuantileKernelStatusV1,
    pub reason_code: Option<String>,
    pub has_ties: bool,
}

pub(crate) fn freedman_diaconis_histogram(
    sample: &PreparedGroupV1,
) -> Result<HistogramKernelV1, AppError> {
    let summary = continuous_summary(sample, 0.95)?;
    let n_eff_factor = summary.n_eff.powf(-1.0 / 3.0);
    let mut width = 2.0 * summary.iqr * n_eff_factor;
    if !width.is_finite() || width <= 0.0 {
        width = summary.std_dev.unwrap_or(0.0) * 3.5 * n_eff_factor;
    }
    if !width.is_finite() || width <= 0.0 {
        if summary.minimum < summary.maximum {
            let bins = (summary.n_eff.log2() + 1.0).ceil().max(1.0);
            width = (summary.maximum - summary.minimum) / bins;
        } else {
            width = summary.minimum.abs().max(1.0) * 1.0e-6;
        }
    }
    let origin = (summary.minimum / width).floor() * width;
    let mut end = (summary.maximum / width).ceil() * width;
    if end <= summary.maximum {
        end += width;
    }
    let bin_count = (((end - origin) / width).round() as usize).max(1);
    let mut counts = vec![0.0; bin_count];
    for observation in &sample.observations {
        let mut index = ((observation.y - origin) / width).floor() as isize;
        if observation.y == end {
            index = bin_count as isize - 1;
        }
        let index = index.clamp(0, bin_count as isize - 1) as usize;
        counts[index] += observation.contribution;
    }
    let total = compensated_sum(counts.iter().copied());
    let bins = counts
        .into_iter()
        .enumerate()
        .map(|(index, count)| {
            let lower = origin + index as f64 * width;
            HistogramBinDataV1 {
                lower,
                upper: lower + width,
                count,
                probability: count / total,
                density: count / (total * width),
            }
        })
        .collect();
    Ok(HistogramKernelV1 { bins })
}

pub(crate) fn histogram(
    sample: &PreparedGroupV1,
    config: &DistributionHistogramDiagnosticsConfigV1,
) -> Result<HistogramKernelV1, AppError> {
    match config.method {
        HistogramMethodV1::JmpAuto => {
            // No JMP numeric-bin evidence is currently frozen; keep behavior explicit as a fallback.
            freedman_diaconis_histogram(sample)
        }
        HistogramMethodV1::FreedmanDiaconis => freedman_diaconis_histogram(sample),
        HistogramMethodV1::Scott => scott_histogram(sample),
        HistogramMethodV1::Sturges => sturges_histogram(sample),
        HistogramMethodV1::FixedCount => {
            let Some(fixed_count) = config.fixed_count else {
                return Err(AppError::InvalidParam(
                    "distribution.config.histogramFixedCountOutOfRange".to_string(),
                ));
            };
            if !(1..=1000).contains(&fixed_count) {
                return Err(AppError::InvalidParam(
                    "distribution.config.histogramFixedCountOutOfRange".to_string(),
                ));
            }
            fixed_count_histogram(sample, fixed_count as usize)
        }
        HistogramMethodV1::FixedWidth => {
            let Some(fixed_width) = config.fixed_width else {
                return Err(AppError::InvalidParam(
                    "distribution.config.histogramFixedWidthInvalid".to_string(),
                ));
            };
            if !fixed_width.is_finite() || fixed_width <= 0.0 {
                return Err(AppError::InvalidParam(
                    "distribution.config.histogramFixedWidthInvalid".to_string(),
                ));
            }
            fixed_width_histogram(sample, fixed_width)
        }
    }
}

fn scott_histogram(sample: &PreparedGroupV1) -> Result<HistogramKernelV1, AppError> {
    let summary = continuous_summary(sample, 0.95)?;
    let n_eff_factor = summary.n_eff.powf(-1.0 / 3.0);
    let width = if let Some(std_dev) = summary.std_dev {
        3.5 * std_dev * n_eff_factor
    } else {
        0.0
    };
    width_histogram(sample, width)
}

fn sturges_histogram(sample: &PreparedGroupV1) -> Result<HistogramKernelV1, AppError> {
    let summary = continuous_summary(sample, 0.95)?;
    let bins = (summary.n_eff.log2() + 1.0).ceil().max(1.0) as usize;
    fixed_count_histogram(sample, bins)
}

fn fixed_count_histogram(
    sample: &PreparedGroupV1,
    requested_bins: usize,
) -> Result<HistogramKernelV1, AppError> {
    let summary = continuous_summary(sample, 0.95)?;
    if requested_bins == 0 {
        return Err(AppError::InvalidParam(
            "distribution.config.histogramFixedCountOutOfRange".to_string(),
        ));
    }
    let span = summary.maximum - summary.minimum;
    if span <= 0.0 {
        let width = summary.minimum.abs().max(1.0) * 1.0e-6;
        return fixed_width_histogram(sample, width);
    }
    let width = span / requested_bins as f64;
    let mut counts = vec![0.0; requested_bins];
    for observation in &sample.observations {
        let offset = observation.y - summary.minimum;
        let mut index = (offset / width).floor() as isize;
        if observation.y >= summary.maximum {
            index = requested_bins as isize - 1;
        }
        let index = index.clamp(0, requested_bins as isize - 1) as usize;
        counts[index] += observation.contribution;
    }
    let total = compensated_sum(counts.iter().copied());
    let bins = counts
        .into_iter()
        .enumerate()
        .map(|(index, count)| {
            let lower = summary.minimum + index as f64 * width;
            let upper = if index + 1 == requested_bins {
                summary.maximum
            } else {
                lower + width
            };
            HistogramBinDataV1 {
                lower,
                upper,
                count,
                probability: count / total,
                density: count / (total * (upper - lower)),
            }
        })
        .collect();
    Ok(HistogramKernelV1 { bins })
}

fn fixed_width_histogram(
    sample: &PreparedGroupV1,
    requested_width: f64,
) -> Result<HistogramKernelV1, AppError> {
    width_histogram(sample, requested_width)
}

fn width_histogram(
    sample: &PreparedGroupV1,
    requested_width: f64,
) -> Result<HistogramKernelV1, AppError> {
    let summary = continuous_summary(sample, 0.95)?;
    let width = if requested_width.is_finite() && requested_width > 0.0 {
        requested_width
    } else if summary.minimum < summary.maximum {
        let bins = (summary.n_eff.log2() + 1.0).ceil().max(1.0);
        (summary.maximum - summary.minimum) / bins
    } else {
        summary.minimum.abs().max(1.0) * 1.0e-6
    };

    let origin = (summary.minimum / width).floor() * width;
    let mut end = (summary.maximum / width).ceil() * width;
    if end <= summary.maximum {
        end += width;
    }
    let bin_count = (((end - origin) / width).round() as usize).max(1);
    let mut counts = vec![0.0; bin_count];
    for observation in &sample.observations {
        let mut index = ((observation.y - origin) / width).floor() as isize;
        if observation.y == end {
            index = bin_count as isize - 1;
        }
        let index = index.clamp(0, bin_count as isize - 1) as usize;
        counts[index] += observation.contribution;
    }
    let total = compensated_sum(counts.iter().copied());
    let bins = counts
        .into_iter()
        .enumerate()
        .map(|(index, count)| {
            let lower = origin + index as f64 * width;
            HistogramBinDataV1 {
                lower,
                upper: lower + width,
                count,
                probability: count / total,
                density: count / (total * width),
            }
        })
        .collect();
    Ok(HistogramKernelV1 { bins })
}

pub(crate) fn tukey_box(
    sample: &PreparedGroupV1,
    confidence_level: f64,
) -> Result<BoxKernelV1, AppError> {
    let summary = continuous_summary(sample, confidence_level)?;
    let q1 = weighted_type6(&sample.observations, 0.25)?;
    let q3 = weighted_type6(&sample.observations, 0.75)?;
    let iqr = q3 - q1;
    let lower_fence = q1 - 1.5 * iqr;
    let upper_fence = q3 + 1.5 * iqr;
    let lower_whisker = sample
        .observations
        .iter()
        .filter(|value| value.y >= lower_fence)
        .map(|value| value.y)
        .min_by(f64::total_cmp)
        .unwrap_or(summary.minimum);
    let upper_whisker = sample
        .observations
        .iter()
        .filter(|value| value.y <= upper_fence)
        .map(|value| value.y)
        .max_by(f64::total_cmp)
        .unwrap_or(summary.maximum);
    let mut outlier_map = BTreeMap::<u64, BoxOutlierV1>::new();
    for value in sample
        .observations
        .iter()
        .filter(|value| value.y < lower_fence || value.y > upper_fence)
    {
        let entry = outlier_map
            .entry(value.y.to_bits())
            .or_insert(BoxOutlierV1 {
                value: value.y,
                contribution: 0.0,
                source_row_count: 0,
            });
        entry.contribution += value.contribution;
        entry.source_row_count += 1;
    }
    let mut outliers = outlier_map.into_values().collect::<Vec<_>>();
    outliers.sort_by(|left, right| left.value.total_cmp(&right.value));
    Ok(BoxKernelV1 {
        lower_quartile: q1,
        median: summary.median,
        upper_quartile: q3,
        lower_whisker,
        upper_whisker,
        outliers,
        mean_ci_lower: summary.mean_ci_lower,
        mean_ci_upper: summary.mean_ci_upper,
    })
}

pub(crate) fn weighted_ecdf(sample: &PreparedGroupV1) -> Result<EcdfKernelV1, AppError> {
    if sample.observations.is_empty() {
        return Err(AppError::Stats(
            "distribution.method.emptyGroup".to_string(),
        ));
    }
    let mut masses = BTreeMap::<u64, (f64, f64)>::new();
    for observation in &sample.observations {
        let value = if observation.y == 0.0 {
            0.0
        } else {
            observation.y
        };
        let entry = masses.entry(value.to_bits()).or_insert((value, 0.0));
        entry.1 += observation.contribution;
    }
    let mut jumps = masses
        .into_values()
        .map(|(value, contribution)| EcdfJumpV1 {
            value,
            contribution,
        })
        .collect::<Vec<_>>();
    jumps.sort_by(|left, right| left.value.total_cmp(&right.value));
    let total = compensated_sum(jumps.iter().map(|jump| jump.contribution));
    let mut points = Vec::with_capacity(jumps.len() * 2 + 1);
    points.push(EcdfPointV1 {
        x: jumps[0].value,
        probability: 0.0,
    });
    let mut cumulative = 0.0;
    for jump in &jumps {
        points.push(EcdfPointV1 {
            x: jump.value,
            probability: cumulative / total,
        });
        cumulative += jump.contribution;
        points.push(EcdfPointV1 {
            x: jump.value,
            probability: (cumulative / total).min(1.0),
        });
    }
    if let Some(last) = points.last_mut() {
        last.probability = 1.0;
    }
    Ok(EcdfKernelV1 { points, jumps })
}

pub(crate) fn normal_quantile_plot(
    sample: &PreparedGroupV1,
    has_weight_column: bool,
    confidence_level: f64,
    max_emitted_points: usize,
) -> Result<NormalQuantileKernelV1, AppError> {
    normal_quantile_plot_with_priorities(
        sample,
        has_weight_column,
        confidence_level,
        max_emitted_points,
        &[],
        &[],
    )
}

pub(crate) fn normal_quantile_plot_with_priorities(
    sample: &PreparedGroupV1,
    has_weight_column: bool,
    confidence_level: f64,
    max_emitted_points: usize,
    priority_values: &[f64],
    priority_ranks: &[u64],
) -> Result<NormalQuantileKernelV1, AppError> {
    if max_emitted_points == 0 {
        return Err(AppError::InvalidParam(
            "distribution.config.normalQuantileMaxPointsInvalid".to_string(),
        ));
    }
    if !confidence_level.is_finite() || confidence_level <= 0.0 || confidence_level >= 1.0 {
        return Err(AppError::InvalidParam(
            "distribution.config.normalQuantileConfidenceOutOfRange".to_string(),
        ));
    }
    if has_weight_column {
        return Ok(NormalQuantileKernelV1 {
            points: Vec::new(),
            reference_line: Vec::new(),
            confidence_band: Vec::new(),
            status: NormalQuantileKernelStatusV1::Unavailable,
            reason_code: Some("normalQuantile.weightUnsupported.v1".to_string()),
            has_ties: false,
        });
    }
    if sample.observations.is_empty() {
        return Ok(NormalQuantileKernelV1 {
            points: Vec::new(),
            reference_line: Vec::new(),
            confidence_band: Vec::new(),
            status: NormalQuantileKernelStatusV1::Unavailable,
            reason_code: Some("distribution.method.emptyGroup".to_string()),
            has_ties: false,
        });
    }

    let mut sorted = sample.observations.clone();
    for observation in &mut sorted {
        if observation.y == 0.0 {
            observation.y = 0.0;
        }
    }
    sorted.sort_by(|left, right| {
        left.y
            .total_cmp(&right.y)
            .then(left.row_id.cmp(&right.row_id))
    });

    let logical_n = sorted
        .iter()
        .try_fold(0_u64, |total, item| total.checked_add(item.frequency))
        .ok_or_else(|| {
            AppError::InvalidParam("distribution.method.frequencyOverflow".to_string())
        })?;
    if logical_n == 0 {
        return Ok(NormalQuantileKernelV1 {
            points: Vec::new(),
            reference_line: Vec::new(),
            confidence_band: Vec::new(),
            status: NormalQuantileKernelStatusV1::Unavailable,
            reason_code: Some("distribution.method.groupUnavailable".to_string()),
            has_ties: false,
        });
    }

    let has_ties = sorted.windows(2).any(|window| window[0].y == window[1].y)
        || sorted.iter().any(|item| item.frequency > 1);
    let mut resolved_priority_ranks = priority_ranks.to_vec();
    resolved_priority_ranks.extend(priority_ranks_from_values(&sorted, priority_values));
    let selected_ranks =
        deterministic_rank_grid(logical_n, max_emitted_points, &resolved_priority_ranks);
    let normal = Normal::new(0.0, 1.0).map_err(|error| {
        AppError::Stats(format!(
            "distribution.normalQuantile.normalInitFailed:{error}"
        ))
    })?;

    let mut points = Vec::with_capacity(selected_ranks.len());
    let mut observation_index = 0usize;
    let mut cumulative_frequency = 0_u64;
    for rank in selected_ranks {
        while observation_index + 1 < sorted.len() {
            let Some(current) = sorted.get(observation_index) else {
                return Err(AppError::Stats(
                    "distribution.normalQuantile.rankMappingFailed".to_string(),
                ));
            };
            let next_cumulative = cumulative_frequency
                .checked_add(current.frequency)
                .ok_or_else(|| {
                    AppError::InvalidParam("distribution.method.frequencyOverflow".to_string())
                })?;
            if next_cumulative >= rank {
                break;
            }
            cumulative_frequency = next_cumulative;
            observation_index += 1;
        }
        let observed_value = sorted
            .get(observation_index)
            .ok_or_else(|| {
                AppError::Stats("distribution.normalQuantile.rankMappingFailed".to_string())
            })?
            .y;
        let probability = rank as f64 / (logical_n as f64 + 1.0);
        let normal_score = normal.inverse_cdf(probability);
        points.push(NormalQuantilePointDataV1 {
            rank,
            probability,
            normal_score,
            observed_value,
        });
    }

    let summary = continuous_summary(sample, confidence_level)?;
    let mean = summary.mean;
    let std_dev = summary.std_dev.unwrap_or(0.0).max(0.0);
    let min_score = points
        .iter()
        .map(|point| point.normal_score)
        .min_by(f64::total_cmp)
        .unwrap_or(0.0);
    let max_score = points
        .iter()
        .map(|point| point.normal_score)
        .max_by(f64::total_cmp)
        .unwrap_or(0.0);
    let reference_line = vec![
        EcdfPointV1 {
            x: min_score,
            probability: mean + std_dev * min_score,
        },
        EcdfPointV1 {
            x: max_score,
            probability: mean + std_dev * max_score,
        },
    ];

    let alpha = 1.0 - confidence_level;
    let critical = normal.inverse_cdf(1.0 - alpha / 2.0);
    let confidence_band = points
        .iter()
        .map(|point| {
            let p = point.probability;
            let se_p = (p * (1.0 - p) / logical_n as f64).max(0.0).sqrt();
            let density_at_z = normal.pdf(point.normal_score).abs();
            let delta_z = if density_at_z <= 0.0 {
                0.0
            } else {
                critical * se_p / density_at_z
            };
            let lower_z = point.normal_score - delta_z;
            let upper_z = point.normal_score + delta_z;
            NormalQuantileBandDataV1 {
                x: point.normal_score,
                lower: mean + std_dev * lower_z,
                upper: mean + std_dev * upper_z,
            }
        })
        .collect::<Vec<_>>();

    Ok(NormalQuantileKernelV1 {
        points,
        reference_line,
        confidence_band,
        status: NormalQuantileKernelStatusV1::Available,
        reason_code: None,
        has_ties,
    })
}

fn priority_ranks_from_values(
    sorted: &[PreparedObservationV1],
    priority_values: &[f64],
) -> Vec<u64> {
    if sorted.is_empty() || priority_values.is_empty() {
        return Vec::new();
    }
    let mut ranges = Vec::<(f64, u64, u64)>::with_capacity(sorted.len());
    let mut cumulative = 0_u64;
    for observation in sorted {
        let start = cumulative.saturating_add(1);
        cumulative = cumulative.saturating_add(observation.frequency);
        ranges.push((observation.y, start, cumulative));
    }

    priority_values
        .iter()
        .copied()
        .filter(|value| value.is_finite())
        .filter_map(|priority_value| {
            ranges
                .iter()
                .min_by(|left, right| {
                    let left_distance = (left.0 - priority_value).abs();
                    let right_distance = (right.0 - priority_value).abs();
                    left_distance
                        .total_cmp(&right_distance)
                        .then(left.0.total_cmp(&right.0))
                })
                .map(|(_, start, end)| start + (end.saturating_sub(*start) / 2))
        })
        .collect()
}

fn deterministic_rank_grid(logical_n: u64, max_points: usize, priority_ranks: &[u64]) -> Vec<u64> {
    if logical_n == 0 {
        return Vec::new();
    }
    let logical_n_usize = usize::try_from(logical_n).unwrap_or(usize::MAX);
    if logical_n_usize <= max_points {
        return (1..=logical_n).collect();
    }

    let center = (logical_n + 1) / 2;
    let mut required = BTreeSet::new();
    required.insert(1_u64);
    required.insert(center);
    required.insert(logical_n);
    for rank in priority_ranks
        .iter()
        .copied()
        .filter(|rank| (1..=logical_n).contains(rank))
    {
        required.insert(rank.saturating_sub(1).max(1));
        required.insert(rank);
        required.insert(rank.saturating_add(1).min(logical_n));
    }

    let mut ranks = required.clone();
    let denominator = (max_points.saturating_sub(1)) as f64;
    for index in 0..max_points {
        let fraction = if denominator == 0.0 {
            0.0
        } else {
            index as f64 / denominator
        };
        let rank = 1_u64 + ((logical_n - 1) as f64 * fraction).round() as u64;
        ranks.insert(rank.clamp(1, logical_n));
    }

    let mut ranked = ranks.into_iter().collect::<Vec<_>>();
    if ranked.len() <= max_points {
        return ranked;
    }

    let mut selected = BTreeSet::new();
    for required_rank in required {
        selected.insert(required_rank);
    }
    if selected.len() >= max_points {
        let mut forced = selected.into_iter().collect::<Vec<_>>();
        forced.truncate(max_points);
        return forced;
    }

    let candidates = ranked
        .iter()
        .copied()
        .filter(|rank| !selected.contains(rank))
        .collect::<Vec<_>>();
    let remaining_slots = max_points.saturating_sub(selected.len());
    if remaining_slots == 0 || candidates.is_empty() {
        return selected.into_iter().collect();
    }
    if remaining_slots >= candidates.len() {
        for candidate in candidates {
            selected.insert(candidate);
        }
        return selected.into_iter().collect();
    }

    for index in 0..remaining_slots {
        let pick = if remaining_slots == 1 {
            candidates.len() / 2
        } else {
            ((index as f64) * (candidates.len().saturating_sub(1) as f64)
                / ((remaining_slots - 1) as f64))
                .round() as usize
        };
        if let Some(candidate) = candidates.get(pick) {
            selected.insert(*candidate);
        }
    }

    ranked = selected.into_iter().collect();
    ranked.truncate(max_points);
    ranked
}
