use statrs::distribution::{ContinuousCDF, Normal, StudentsT};

use crate::engine::hypothesis_test::normalize::NormalizedStudy;
use crate::error::AppError;
use crate::models::hypothesis_test::{
    HypothesisTestPlotData, HypothesisTestPlotObservation, HypothesisTestPlotSummary,
    HypothesisTestQqPoint, HypothesisTestValue,
};

pub fn build_plot_data(
    study: &NormalizedStudy,
    confidence_level: f64,
) -> Result<HypothesisTestPlotData, AppError> {
    let (study_structure, conditions, observations, diagnostic_kind, diagnostic_values) =
        match study {
            NormalizedStudy::IndependentTwo(groups) | NormalizedStudy::IndependentMulti(groups) => {
                let conditions = groups
                    .groups
                    .iter()
                    .map(|group| group.condition.clone())
                    .collect::<Vec<_>>();
                let observations = groups
                    .groups
                    .iter()
                    .flat_map(|group| {
                        group.values.iter().map(|value| HypothesisTestPlotObservation {
                            condition: group.condition.clone(),
                            value: *value,
                            subject: None,
                        })
                    })
                    .collect::<Vec<_>>();
                let diagnostic_values = groups
                    .groups
                    .iter()
                    .flat_map(|group| {
                        let mean = mean(&group.values);
                        group.values.iter().map(move |value| value - mean)
                    })
                    .collect::<Vec<_>>();
                (
                    "independent",
                    conditions,
                    observations,
                    "groupResiduals",
                    diagnostic_values,
                )
            }
            NormalizedStudy::PairedTwo(paired) => {
                let observations = paired
                    .subjects
                    .iter()
                    .zip(&paired.pairs)
                    .flat_map(|(subject, pair)| {
                        paired.conditions.iter().zip(pair).map(|(condition, value)| {
                            HypothesisTestPlotObservation {
                                condition: condition.clone(),
                                value: *value,
                                subject: Some(subject.clone()),
                            }
                        })
                    })
                    .collect::<Vec<_>>();
                let diagnostic_values = paired
                    .pairs
                    .iter()
                    .map(|pair| pair[0] - pair[1])
                    .collect::<Vec<_>>();
                (
                    "paired",
                    paired.conditions.to_vec(),
                    observations,
                    "pairedDifferences",
                    diagnostic_values,
                )
            }
            NormalizedStudy::CompleteBlock(blocks) => {
                let observations = blocks
                    .subjects
                    .iter()
                    .zip(&blocks.blocks)
                    .flat_map(|(subject, values)| {
                        blocks.conditions.iter().zip(values).map(|(condition, value)| {
                            HypothesisTestPlotObservation {
                                condition: condition.clone(),
                                value: *value,
                                subject: Some(subject.clone()),
                            }
                        })
                    })
                    .collect::<Vec<_>>();
                let grand_mean = mean(&blocks.blocks.iter().flatten().copied().collect::<Vec<_>>());
                let condition_means = (0..blocks.conditions.len())
                    .map(|index| mean(&blocks.blocks.iter().map(|block| block[index]).collect::<Vec<_>>()))
                    .collect::<Vec<_>>();
                let block_means = blocks.blocks.iter().map(|block| mean(block)).collect::<Vec<_>>();
                let diagnostic_values = blocks
                    .blocks
                    .iter()
                    .enumerate()
                    .flat_map(|(block_index, block)| {
                        let condition_means = &condition_means;
                        let block_mean = block_means[block_index];
                        block.iter().enumerate().map(move |(condition_index, value)| {
                            value - condition_means[condition_index] - block_mean + grand_mean
                        })
                    })
                    .collect::<Vec<_>>();
                (
                    "completeBlock",
                    blocks.conditions.clone(),
                    observations,
                    "additiveResiduals",
                    diagnostic_values,
                )
            }
        };

    ensure_finite(&observations, &diagnostic_values)?;
    let summaries = conditions
        .iter()
        .map(|condition| {
            summarize_condition(condition, &observations, confidence_level)
        })
        .collect::<Result<Vec<_>, _>>()?;
    let qq_points = qq_points(&diagnostic_values)?;

    Ok(HypothesisTestPlotData {
        study_structure: study_structure.into(),
        conditions,
        observations,
        summaries,
        diagnostic_kind: diagnostic_kind.into(),
        diagnostic_values,
        qq_points,
    })
}

fn summarize_condition(
    condition: &str,
    observations: &[HypothesisTestPlotObservation],
    confidence_level: f64,
) -> Result<HypothesisTestPlotSummary, AppError> {
    let mut values = observations
        .iter()
        .filter(|observation| observation.condition == condition)
        .map(|observation| observation.value)
        .collect::<Vec<_>>();
    if values.is_empty() {
        return Err(AppError::Stats(format!("condition {condition} has no retained observations")));
    }
    values.sort_by(f64::total_cmp);
    let average = mean(&values);
    let (mean_interval_lower, mean_interval_upper) = mean_interval(&values, confidence_level)
        .map(|(lower, upper)| {
            (
                HypothesisTestValue::Available { value: lower },
                HypothesisTestValue::Available { value: upper },
            )
        })
        .unwrap_or_else(|| {
            (
                HypothesisTestValue::Unavailable { reason: "insufficientObservations".into() },
                HypothesisTestValue::Unavailable { reason: "insufficientObservations".into() },
            )
        });
    Ok(HypothesisTestPlotSummary {
        condition: condition.into(),
        count: values.len() as u64,
        mean: average,
        median: quantile(&values, 0.5),
        lower_quartile: quantile(&values, 0.25),
        upper_quartile: quantile(&values, 0.75),
        minimum: values[0],
        maximum: values[values.len() - 1],
        mean_interval_lower,
        mean_interval_upper,
    })
}

fn mean_interval(values: &[f64], confidence_level: f64) -> Option<(f64, f64)> {
    if values.len() < 2 {
        return None;
    }
    let average = mean(values);
    let variance = values
        .iter()
        .map(|value| (value - average).powi(2))
        .sum::<f64>()
        / (values.len() - 1) as f64;
    let critical = StudentsT::new(0.0, 1.0, (values.len() - 1) as f64)
        .ok()?
        .inverse_cdf(0.5 + confidence_level / 2.0);
    let margin = critical * (variance / values.len() as f64).sqrt();
    let interval = (average - margin, average + margin);
    (interval.0.is_finite() && interval.1.is_finite()).then_some(interval)
}

fn qq_points(values: &[f64]) -> Result<Vec<HypothesisTestQqPoint>, AppError> {
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    let normal = Normal::new(0.0, 1.0)
        .map_err(|error| AppError::Stats(format!("normal quantile setup failed: {error}")))?;
    let count = sorted.len() as f64;
    sorted
        .into_iter()
        .enumerate()
        .map(|(index, observed)| {
            let theoretical = normal.inverse_cdf((index as f64 + 0.5) / count);
            if theoretical.is_finite() && observed.is_finite() {
                Ok(HypothesisTestQqPoint { theoretical, observed })
            } else {
                Err(AppError::Stats("non-finite hypothesis plot coordinate".into()))
            }
        })
        .collect()
}

fn ensure_finite(
    observations: &[HypothesisTestPlotObservation],
    diagnostic_values: &[f64],
) -> Result<(), AppError> {
    if observations.iter().all(|item| item.value.is_finite())
        && diagnostic_values.iter().all(|value| value.is_finite())
    {
        Ok(())
    } else {
        Err(AppError::Stats("non-finite hypothesis plot coordinate".into()))
    }
}

fn mean(values: &[f64]) -> f64 {
    values.iter().sum::<f64>() / values.len() as f64
}

fn quantile(sorted: &[f64], probability: f64) -> f64 {
    let position = probability * (sorted.len() - 1) as f64;
    let lower = position.floor() as usize;
    let upper = position.ceil() as usize;
    if lower == upper {
        sorted[lower]
    } else {
        sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower as f64)
    }
}