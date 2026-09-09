use crate::engine::hypothesis_test::normalize::{CompleteBlocks, IndependentGroups};
use crate::engine::hypothesis_test::methods::rank::{average_ranks, wilcoxon_signed_rank};
use crate::engine::hypothesis_test::post_hoc::{compact_letters, holm_adjust, PostHocComparison, PostHocResult};
use crate::error::AppError;
use crate::models::hypothesis_test::HypothesisTestAlternative;
use statrs::distribution::{ContinuousCDF, Normal};

pub fn dunn_holm(groups: &IndependentGroups, alpha: f64) -> Result<PostHocResult, AppError> {
    if groups.groups.len() < 3 || groups.groups.iter().any(|group| group.values.is_empty()) {
        return Err(AppError::Stats("Dunn post-hoc requires at least three non-empty groups".into()));
    }
    if !alpha.is_finite() || !(0.0..1.0).contains(&alpha) {
        return Err(AppError::InvalidParam("alpha must be inside (0, 1)".into()));
    }
    let mut pooled = groups.groups.iter().enumerate().flat_map(|(group_index, group)| {
        group.values.iter().map(move |value| (*value, group_index))
    }).collect::<Vec<_>>();
    pooled.sort_by(|left, right| left.0.total_cmp(&right.0));
    let (ranks, ties) = average_ranks(&pooled.iter().map(|item| item.0).collect::<Vec<_>>());
    let mut rank_sums = vec![0.0; groups.groups.len()];
    for ((_, group_index), rank) in pooled.iter().zip(ranks) {
        rank_sums[*group_index] += rank;
    }
    let count = pooled.len();
    let tie_sum = ties.iter().map(|size| size.pow(3) - size).sum::<usize>() as f64;
    let rank_variance = count as f64 * (count + 1) as f64 / 12.0
        - tie_sum / (12.0 * (count - 1) as f64);
    if rank_variance <= 0.0 {
        return Err(AppError::Stats("Dunn rank variance is not estimable".into()));
    }
    let normal = Normal::new(0.0, 1.0).map_err(|error| AppError::Stats(error.to_string()))?;
    let mut comparisons = Vec::new();
    for left in 0..groups.groups.len() - 1 {
        for right in left + 1..groups.groups.len() {
            let left_count = groups.groups[left].values.len() as f64;
            let right_count = groups.groups[right].values.len() as f64;
            let estimate = rank_sums[left] / left_count - rank_sums[right] / right_count;
            let standard_error = (rank_variance * (1.0 / left_count + 1.0 / right_count)).sqrt();
            let statistic = estimate / standard_error;
            comparisons.push(PostHocComparison {
                left: groups.groups[left].condition.clone(),
                right: groups.groups[right].condition.clone(),
                estimate,
                standard_error: Some(standard_error),
                statistic,
                degrees_of_freedom: None,
                raw_p_value: (2.0 * normal.cdf(-statistic.abs())).min(1.0),
                adjusted_p_value: 0.0,
                lower: None,
                upper: None,
            });
        }
    }
    let adjusted = holm_adjust(&comparisons.iter().map(|item| item.raw_p_value).collect::<Vec<_>>())?;
    for (comparison, adjusted_p_value) in comparisons.iter_mut().zip(adjusted) {
        comparison.adjusted_p_value = adjusted_p_value;
    }
    let conditions = groups.groups.iter().map(|group| group.condition.clone()).collect::<Vec<_>>();
    let compact_letters = compact_letters(&conditions, &comparisons, alpha)?;
    Ok(PostHocResult { family: "dunnHolm".into(), comparisons, compact_letters })
}

pub fn paired_wilcoxon_holm(
    study: &CompleteBlocks,
    alpha: f64,
) -> Result<PostHocResult, AppError> {
    if study.conditions.len() < 3 || study.blocks.is_empty()
        || study.blocks.iter().any(|block| block.len() != study.conditions.len())
    {
        return Err(AppError::Stats("paired post-hoc requires a complete matrix with three conditions".into()));
    }
    if !alpha.is_finite() || !(0.0..1.0).contains(&alpha) {
        return Err(AppError::InvalidParam("alpha must be inside (0, 1)".into()));
    }
    let mut comparisons = Vec::new();
    for left in 0..study.conditions.len() - 1 {
        for right in left + 1..study.conditions.len() {
            let pairs = study.blocks.iter().map(|block| [block[left], block[right]])
                .collect::<Vec<_>>();
            let result = wilcoxon_signed_rank(&pairs, HypothesisTestAlternative::TwoSided)?;
            let differences = pairs.iter().map(|pair| pair[0] - pair[1]).collect::<Vec<_>>();
            comparisons.push(PostHocComparison {
                left: study.conditions[left].clone(),
                right: study.conditions[right].clone(),
                estimate: walsh_median(&differences),
                standard_error: None,
                statistic: result.statistic,
                degrees_of_freedom: None,
                raw_p_value: result.p_value,
                adjusted_p_value: 0.0,
                lower: None,
                upper: None,
            });
        }
    }
    let adjusted = holm_adjust(&comparisons.iter().map(|item| item.raw_p_value).collect::<Vec<_>>())?;
    for (comparison, adjusted_p_value) in comparisons.iter_mut().zip(adjusted) {
        comparison.adjusted_p_value = adjusted_p_value;
    }
    let compact_letters = compact_letters(&study.conditions, &comparisons, alpha)?;
    Ok(PostHocResult {
        family: "pairedWilcoxonHolm".into(),
        comparisons,
        compact_letters,
    })
}

fn walsh_median(differences: &[f64]) -> f64 {
    let mut averages = Vec::with_capacity(differences.len() * (differences.len() + 1) / 2);
    for left in 0..differences.len() {
        for right in left..differences.len() {
            averages.push((differences[left] + differences[right]) / 2.0);
        }
    }
    averages.sort_by(f64::total_cmp);
    let middle = averages.len() / 2;
    if averages.len() % 2 == 0 {
        (averages[middle - 1] + averages[middle]) / 2.0
    } else {
        averages[middle]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::hypothesis_test::normalize::ConditionValues;

    #[test]
    fn dunn_uses_joint_tied_ranks_and_one_holm_family() {
        let groups = IndependentGroups { groups: vec![
            ConditionValues { condition: "A".into(), values: vec![1.0, 2.0, 2.0] },
            ConditionValues { condition: "B".into(), values: vec![2.0, 3.0, 4.0] },
            ConditionValues { condition: "C".into(), values: vec![7.0, 8.0, 9.0] },
        ] };
        let result = dunn_holm(&groups, 0.05).expect("Dunn-Holm");
        assert_eq!(result.family, "dunnHolm");
        assert_eq!(result.comparisons.len(), 3);
        assert!(result.comparisons.iter().all(|comparison| {
            comparison.adjusted_p_value >= comparison.raw_p_value
                && comparison.lower.is_none()
                && comparison.upper.is_none()
        }));
        assert!(result.comparisons[0].estimate < 0.0);
        assert!(result.comparisons[1].adjusted_p_value < 0.05);
    }

    #[test]
    fn paired_wilcoxon_holm_retains_pairwise_exact_or_tied_inference() {
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
        let result = paired_wilcoxon_holm(&study, 0.05).expect("paired Wilcoxon-Holm");
        assert_eq!(result.family, "pairedWilcoxonHolm");
        assert_eq!(result.comparisons.len(), 3);
        assert!(result.comparisons.iter().all(|comparison| {
            comparison.adjusted_p_value >= comparison.raw_p_value
                && comparison.degrees_of_freedom.is_none()
                && comparison.lower.is_none()
                && comparison.upper.is_none()
        }));
    }
}