use crate::engine::hypothesis_test::normalize::{CompleteBlocks, IndependentGroups};
use crate::engine::hypothesis_test::methods::parametric::{paired_t, sample_moments};
use crate::engine::hypothesis_test::post_hoc::{compact_letters, holm_adjust, PostHocComparison, PostHocResult};
use crate::error::AppError;
use crate::models::hypothesis_test::HypothesisTestAlternative;

use super::studentized_range;

pub fn tukey_kramer(
    groups: &IndependentGroups,
    alpha: f64,
    confidence_level: f64,
) -> Result<PostHocResult, AppError> {
    validate(groups, alpha, confidence_level)?;
    let moments = group_moments(groups)?;
    let residual_df = moments.iter().map(|(count, _, _)| count - 1.0).sum::<f64>();
    let residual_sum_squares = moments.iter()
        .map(|(count, _, variance)| (count - 1.0) * variance).sum::<f64>();
    let mean_square_error = residual_sum_squares / residual_df;
    if mean_square_error <= 0.0 {
        return Err(AppError::Stats("Tukey-Kramer residual variance is not estimable".into()));
    }
    let critical = studentized_range::inverse_cdf(confidence_level, groups.groups.len(), residual_df)?;
    let mut comparisons = Vec::new();
    for left in 0..groups.groups.len() - 1 {
        for right in left + 1..groups.groups.len() {
            let estimate = moments[left].1 - moments[right].1;
            let standard_error = (mean_square_error / 2.0
                * (1.0 / moments[left].0 + 1.0 / moments[right].0)).sqrt();
            let statistic = estimate.abs() / standard_error;
            let probability = (1.0 - studentized_range::cdf(
                statistic,
                groups.groups.len(),
                residual_df,
            )?).clamp(0.0, 1.0);
            comparisons.push(comparison(
                groups, left, right, estimate, standard_error, statistic,
                residual_df, probability, critical,
            ));
        }
    }
    finish("tukeyKramer", groups, comparisons, alpha)
}

pub fn games_howell(
    groups: &IndependentGroups,
    alpha: f64,
    confidence_level: f64,
) -> Result<PostHocResult, AppError> {
    validate(groups, alpha, confidence_level)?;
    let moments = group_moments(groups)?;
    if moments.iter().any(|(_, _, variance)| *variance <= 0.0) {
        return Err(AppError::Stats("Games-Howell requires positive variance in every group".into()));
    }
    let mut comparisons = Vec::new();
    for left in 0..groups.groups.len() - 1 {
        for right in left + 1..groups.groups.len() {
            let left_component = moments[left].2 / moments[left].0;
            let right_component = moments[right].2 / moments[right].0;
            let variance_sum = left_component + right_component;
            let degrees_of_freedom = variance_sum.powi(2)
                / (left_component.powi(2) / (moments[left].0 - 1.0)
                    + right_component.powi(2) / (moments[right].0 - 1.0));
            let standard_error = (variance_sum / 2.0).sqrt();
            let estimate = moments[left].1 - moments[right].1;
            let statistic = estimate.abs() / standard_error;
            let probability = (1.0 - studentized_range::cdf(
                statistic,
                groups.groups.len(),
                degrees_of_freedom,
            )?).clamp(0.0, 1.0);
            let critical = studentized_range::inverse_cdf(
                confidence_level,
                groups.groups.len(),
                degrees_of_freedom,
            )?;
            comparisons.push(comparison(
                groups, left, right, estimate, standard_error, statistic,
                degrees_of_freedom, probability, critical,
            ));
        }
    }
    finish("gamesHowell", groups, comparisons, alpha)
}

pub fn paired_t_holm(
    study: &CompleteBlocks,
    alpha: f64,
    confidence_level: f64,
) -> Result<PostHocResult, AppError> {
    validate_blocks(study, alpha, confidence_level)?;
    let mut comparisons = Vec::new();
    for left in 0..study.conditions.len() - 1 {
        for right in left + 1..study.conditions.len() {
            let pairs = study.blocks.iter().map(|block| [block[left], block[right]])
                .collect::<Vec<_>>();
            let result = paired_t(&pairs, HypothesisTestAlternative::TwoSided, confidence_level)?;
            comparisons.push(PostHocComparison {
                left: study.conditions[left].clone(),
                right: study.conditions[right].clone(),
                estimate: result.estimate,
                standard_error: Some(result.standard_error),
                statistic: result.statistic,
                degrees_of_freedom: Some(result.degrees_of_freedom),
                raw_p_value: result.p_value,
                adjusted_p_value: 0.0,
                lower: Some(result.lower),
                upper: Some(result.upper),
            });
        }
    }
    finish_holm("pairedTHolm", &study.conditions, comparisons, alpha)
}

fn validate(groups: &IndependentGroups, alpha: f64, confidence_level: f64) -> Result<(), AppError> {
    if groups.groups.len() < 3 || groups.groups.iter().any(|group| group.values.len() < 2) {
        return Err(AppError::Stats("multi-group post-hoc requires three groups with two observations each".into()));
    }
    if !alpha.is_finite() || !(0.0..1.0).contains(&alpha)
        || !confidence_level.is_finite() || !(0.0..1.0).contains(&confidence_level)
    {
        return Err(AppError::InvalidParam("alpha and confidence level must be inside (0, 1)".into()));
    }
    Ok(())
}

fn group_moments(groups: &IndependentGroups) -> Result<Vec<(f64, f64, f64)>, AppError> {
    groups.groups.iter().map(|group| {
        sample_moments(&group.values)
            .map(|(mean, variance)| (group.values.len() as f64, mean, variance))
    }).collect()
}

#[allow(clippy::too_many_arguments)]
fn comparison(
    groups: &IndependentGroups,
    left: usize,
    right: usize,
    estimate: f64,
    standard_error: f64,
    statistic: f64,
    degrees_of_freedom: f64,
    probability: f64,
    critical: f64,
) -> PostHocComparison {
    PostHocComparison {
        left: groups.groups[left].condition.clone(),
        right: groups.groups[right].condition.clone(),
        estimate,
        standard_error: Some(standard_error),
        statistic,
        degrees_of_freedom: Some(degrees_of_freedom),
        raw_p_value: probability,
        adjusted_p_value: probability,
        lower: Some(estimate - critical * standard_error),
        upper: Some(estimate + critical * standard_error),
    }
}

fn finish(
    family: &str,
    groups: &IndependentGroups,
    comparisons: Vec<PostHocComparison>,
    alpha: f64,
) -> Result<PostHocResult, AppError> {
    let conditions = groups.groups.iter().map(|group| group.condition.clone()).collect::<Vec<_>>();
    let compact_letters = compact_letters(&conditions, &comparisons, alpha)?;
    Ok(PostHocResult { family: family.into(), comparisons, compact_letters })
}

fn validate_blocks(
    study: &CompleteBlocks,
    alpha: f64,
    confidence_level: f64,
) -> Result<(), AppError> {
    if study.conditions.len() < 3 || study.blocks.len() < 2
        || study.blocks.iter().any(|block| block.len() != study.conditions.len())
    {
        return Err(AppError::Stats("paired post-hoc requires a complete matrix with three conditions".into()));
    }
    if !alpha.is_finite() || !(0.0..1.0).contains(&alpha)
        || !confidence_level.is_finite() || !(0.0..1.0).contains(&confidence_level)
    {
        return Err(AppError::InvalidParam("alpha and confidence level must be inside (0, 1)".into()));
    }
    Ok(())
}

fn finish_holm(
    family: &str,
    conditions: &[String],
    mut comparisons: Vec<PostHocComparison>,
    alpha: f64,
) -> Result<PostHocResult, AppError> {
    let adjusted = holm_adjust(&comparisons.iter().map(|item| item.raw_p_value).collect::<Vec<_>>())?;
    for (comparison, adjusted_p_value) in comparisons.iter_mut().zip(adjusted) {
        comparison.adjusted_p_value = adjusted_p_value;
    }
    let compact_letters = compact_letters(conditions, &comparisons, alpha)?;
    Ok(PostHocResult { family: family.into(), comparisons, compact_letters })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::hypothesis_test::normalize::ConditionValues;

    #[test]
    fn tukey_kramer_returns_simultaneous_intervals_and_letters() {
        let result = tukey_kramer(&fixture(), 0.05, 0.95).expect("Tukey-Kramer");
        assert_eq!(result.family, "tukeyKramer");
        assert_eq!(result.comparisons.len(), 3);
        assert!(result.comparisons.iter().all(|comparison| {
            comparison.lower.is_some()
                && comparison.upper.is_some()
                && comparison.raw_p_value == comparison.adjusted_p_value
        }));
        assert_eq!(result.compact_letters[0].1, result.compact_letters[1].1);
        assert_ne!(result.compact_letters[0].1, result.compact_letters[2].1);
    }

    #[test]
    fn games_howell_uses_pair_specific_satterthwaite_degrees_of_freedom() {
        let groups = IndependentGroups { groups: vec![
            ConditionValues { condition: "A".into(), values: vec![1.0, 2.0, 3.0, 4.0] },
            ConditionValues { condition: "B".into(), values: vec![3.0, 7.0, 11.0, 15.0, 19.0] },
            ConditionValues { condition: "C".into(), values: vec![20.0, 21.0, 22.0, 23.0, 24.0, 25.0] },
        ] };
        let result = games_howell(&groups, 0.05, 0.95).expect("Games-Howell");
        let degrees = result.comparisons.iter()
            .map(|comparison| comparison.degrees_of_freedom.expect("df"))
            .collect::<Vec<_>>();
        assert!(degrees.iter().all(|value| value.is_finite() && *value > 0.0));
        assert!((degrees[0] - degrees[1]).abs() > 0.1);
        assert!((degrees[1] - degrees[2]).abs() > 0.1);
    }

    #[test]
    fn paired_t_holm_reuses_complete_blocks_and_adjusts_one_family() {
        let study = CompleteBlocks {
            conditions: vec!["A".into(), "B".into(), "C".into()],
            subjects: vec!["1".into(), "2".into(), "3".into(), "4".into()],
            blocks: vec![
                vec![1.0, 2.0, 8.0],
                vec![2.0, 4.0, 9.0],
                vec![4.0, 5.0, 11.0],
                vec![5.0, 7.0, 13.0],
            ],
        };
        let result = paired_t_holm(&study, 0.05, 0.95).expect("paired t-Holm");
        assert_eq!(result.family, "pairedTHolm");
        assert_eq!(result.comparisons.len(), 3);
        assert!(result.comparisons.iter().all(|comparison| {
            comparison.adjusted_p_value >= comparison.raw_p_value
                && comparison.degrees_of_freedom == Some(3.0)
                && comparison.lower.is_some()
                && comparison.upper.is_some()
        }));
    }

    fn fixture() -> IndependentGroups {
        IndependentGroups { groups: vec![
            ConditionValues { condition: "A".into(), values: vec![1.0, 2.0, 3.0, 4.0] },
            ConditionValues { condition: "B".into(), values: vec![2.0, 3.0, 4.0, 5.0] },
            ConditionValues { condition: "C".into(), values: vec![8.0, 9.0, 10.0, 11.0] },
        ] }
    }
}