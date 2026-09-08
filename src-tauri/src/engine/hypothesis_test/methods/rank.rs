use crate::error::AppError;
use crate::models::hypothesis_test::HypothesisTestAlternative;
use statrs::distribution::{ContinuousCDF, Normal};

use super::exact::{choose_capped, powers_of_two_capped, MAX_EXACT_STATES};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InferencePath {
    Exact,
    Asymptotic,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RankWarning {
    ExactUnavailableWithTies,
    ExactUnavailableWithZeros,
    ExactBudgetExceeded,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RankTestResult {
    pub statistic: f64,
    pub p_value: f64,
    pub effect_size: f64,
    pub inference_path: InferencePath,
    pub warnings: Vec<RankWarning>,
    pub zero_differences: usize,
}

pub fn mann_whitney_u(
    left: &[f64],
    right: &[f64],
    alternative: HypothesisTestAlternative,
) -> Result<RankTestResult, AppError> {
    if left.is_empty() || right.is_empty() || left.iter().chain(right).any(|value| !value.is_finite()) {
        return Err(AppError::Stats("Mann-Whitney U requires non-empty finite groups".into()));
    }
    let mut values = left.iter().map(|value| (*value, 0_usize))
        .chain(right.iter().map(|value| (*value, 1_usize)))
        .collect::<Vec<_>>();
    values.sort_by(|left, right| left.0.total_cmp(&right.0));
    let (ranks, tie_sizes) = average_ranks(&values.iter().map(|item| item.0).collect::<Vec<_>>());
    let rank_sum_left = values.iter().zip(&ranks)
        .filter(|((_, group), _)| *group == 0)
        .map(|(_, rank)| rank)
        .sum::<f64>();
    let n1 = left.len();
    let n2 = right.len();
    let statistic = rank_sum_left - (n1 * (n1 + 1) / 2) as f64;
    let effect_size = 2.0 * statistic / (n1 * n2) as f64 - 1.0;
    let exact_states = choose_capped(n1 + n2, n1, MAX_EXACT_STATES);
    if tie_sizes.is_empty() && exact_states.is_some() {
        let p_value = exact_mann_whitney_p(n1, n2, statistic as usize, alternative);
        return Ok(RankTestResult {
            statistic,
            p_value,
            effect_size,
            inference_path: InferencePath::Exact,
            warnings: vec![],
            zero_differences: 0,
        });
    }
    let warning = if tie_sizes.is_empty() {
        RankWarning::ExactBudgetExceeded
    } else {
        RankWarning::ExactUnavailableWithTies
    };
    let total = n1 + n2;
    let tie_sum = tie_sizes.iter().map(|size| size.pow(3) - size).sum::<usize>() as f64;
    let variance = (n1 * n2) as f64 / 12.0
        * ((total + 1) as f64 - tie_sum / (total * (total - 1)) as f64);
    let p_value = normal_p_value(statistic, (n1 * n2) as f64 / 2.0, variance.sqrt(), alternative)?;
    Ok(RankTestResult {
        statistic,
        p_value,
        effect_size,
        inference_path: InferencePath::Asymptotic,
        warnings: vec![warning],
        zero_differences: 0,
    })
}

pub fn wilcoxon_signed_rank(
    pairs: &[[f64; 2]],
    alternative: HypothesisTestAlternative,
) -> Result<RankTestResult, AppError> {
    if pairs.iter().flatten().any(|value| !value.is_finite()) {
        return Err(AppError::Stats("signed-rank requires finite pairs".into()));
    }
    let zero_differences = pairs.iter().filter(|pair| pair[0] == pair[1]).count();
    let differences = pairs.iter().map(|pair| pair[0] - pair[1])
        .filter(|difference| *difference != 0.0)
        .collect::<Vec<_>>();
    if differences.is_empty() {
        return Err(AppError::Stats("signed-rank requires at least one non-zero difference".into()));
    }
    let absolute = differences.iter().map(|value| value.abs()).collect::<Vec<_>>();
    let mut order = (0..absolute.len()).collect::<Vec<_>>();
    order.sort_by(|left, right| absolute[*left].total_cmp(&absolute[*right]));
    let sorted = order.iter().map(|index| absolute[*index]).collect::<Vec<_>>();
    let (sorted_ranks, tie_sizes) = average_ranks(&sorted);
    let mut ranks = vec![0.0; differences.len()];
    for (position, index) in order.into_iter().enumerate() {
        ranks[index] = sorted_ranks[position];
    }
    let statistic = differences.iter().zip(&ranks)
        .filter(|(difference, _)| **difference > 0.0)
        .map(|(_, rank)| rank)
        .sum::<f64>();
    let total_rank = ranks.iter().sum::<f64>();
    let effect_size = (2.0 * statistic - total_rank) / total_rank;
    let exact_states = powers_of_two_capped(differences.len(), MAX_EXACT_STATES);
    if tie_sizes.is_empty() && zero_differences == 0 && exact_states.is_some() {
        let p_value = exact_signed_rank_p(differences.len(), statistic as usize, alternative);
        return Ok(RankTestResult {
            statistic,
            p_value,
            effect_size,
            inference_path: InferencePath::Exact,
            warnings: vec![],
            zero_differences,
        });
    }
    let warning = if zero_differences > 0 {
        RankWarning::ExactUnavailableWithZeros
    } else if !tie_sizes.is_empty() {
        RankWarning::ExactUnavailableWithTies
    } else {
        RankWarning::ExactBudgetExceeded
    };
    let variance = ranks.iter().map(|rank| rank * rank).sum::<f64>() / 4.0;
    let p_value = normal_p_value(statistic, total_rank / 2.0, variance.sqrt(), alternative)?;
    Ok(RankTestResult {
        statistic,
        p_value,
        effect_size,
        inference_path: InferencePath::Asymptotic,
        warnings: vec![warning],
        zero_differences,
    })
}

pub(crate) fn average_ranks(sorted: &[f64]) -> (Vec<f64>, Vec<usize>) {
    let mut ranks = vec![0.0; sorted.len()];
    let mut tie_sizes = Vec::new();
    let mut start = 0;
    while start < sorted.len() {
        let mut end = start + 1;
        while end < sorted.len() && sorted[end] == sorted[start] {
            end += 1;
        }
        let average = ((start + 1 + end) as f64) / 2.0;
        ranks[start..end].fill(average);
        if end - start > 1 {
            tie_sizes.push(end - start);
        }
        start = end;
    }
    (ranks, tie_sizes)
}

fn exact_mann_whitney_p(
    n1: usize,
    n2: usize,
    observed: usize,
    alternative: HypothesisTestAlternative,
) -> f64 {
    let mut counts = vec![0_u64; n1 * n2 + 1];
    enumerate_rank_sums(1, n1 + n2, n1, 0, n1 * (n1 + 1) / 2, &mut counts);
    exact_tail_p(&counts, observed, alternative)
}

fn enumerate_rank_sums(
    next_rank: usize,
    total: usize,
    remaining: usize,
    rank_sum: usize,
    offset: usize,
    counts: &mut [u64],
) {
    if remaining == 0 {
        counts[rank_sum - offset] += 1;
        return;
    }
    if total + 1 - next_rank < remaining {
        return;
    }
    for rank in next_rank..=total + 1 - remaining {
        enumerate_rank_sums(rank + 1, total, remaining - 1, rank_sum + rank, offset, counts);
    }
}

fn exact_signed_rank_p(
    count: usize,
    observed: usize,
    alternative: HypothesisTestAlternative,
) -> f64 {
    let total_rank = count * (count + 1) / 2;
    let mut counts = vec![0_u64; total_rank + 1];
    counts[0] = 1;
    for rank in 1..=count {
        for sum in (rank..=total_rank).rev() {
            counts[sum] += counts[sum - rank];
        }
    }
    exact_tail_p(&counts, observed, alternative)
}

fn exact_tail_p(
    counts: &[u64],
    observed: usize,
    alternative: HypothesisTestAlternative,
) -> f64 {
    let total = counts.iter().sum::<u64>() as f64;
    let lower = counts[..=observed].iter().sum::<u64>() as f64 / total;
    let upper = counts[observed..].iter().sum::<u64>() as f64 / total;
    match alternative {
        HypothesisTestAlternative::TwoSided => (2.0 * lower.min(upper)).min(1.0),
        HypothesisTestAlternative::Less => lower,
        HypothesisTestAlternative::Greater => upper,
    }
}

fn normal_p_value(
    statistic: f64,
    mean: f64,
    standard_deviation: f64,
    alternative: HypothesisTestAlternative,
) -> Result<f64, AppError> {
    if standard_deviation <= 0.0 || !standard_deviation.is_finite() {
        return Err(AppError::Stats("rank variance is not estimable".into()));
    }
    let correction = match alternative {
        HypothesisTestAlternative::TwoSided => 0.5 * (statistic - mean).signum(),
        HypothesisTestAlternative::Less => -0.5,
        HypothesisTestAlternative::Greater => 0.5,
    };
    let z = (statistic - mean - correction) / standard_deviation;
    let normal = Normal::new(0.0, 1.0).map_err(|error| AppError::Stats(error.to_string()))?;
    Ok(match alternative {
        HypothesisTestAlternative::TwoSided => (2.0 * normal.cdf(-z.abs())).min(1.0),
        HypothesisTestAlternative::Less => normal.cdf(z),
        HypothesisTestAlternative::Greater => normal.sf(z),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mann_whitney_uses_exact_distribution_without_ties() {
        let result = mann_whitney_u(
            &[1.0, 2.0],
            &[3.0, 4.0],
            HypothesisTestAlternative::TwoSided,
        ).expect("Mann-Whitney U");
        assert_eq!(result.statistic, 0.0);
        assert!((result.p_value - 1.0 / 3.0).abs() < 1e-12);
        assert_eq!(result.effect_size, -1.0);
        assert_eq!(result.inference_path, InferencePath::Exact);
        assert!(result.warnings.is_empty());
    }

    #[test]
    fn signed_rank_uses_exact_distribution_without_zeros() {
        let result = wilcoxon_signed_rank(
            &[[2.0, 1.0], [4.0, 2.0], [6.0, 3.0]],
            HypothesisTestAlternative::TwoSided,
        ).expect("signed-rank");
        assert_eq!(result.statistic, 6.0);
        assert_eq!(result.zero_differences, 0);
        assert!((result.p_value - 0.25).abs() < 1e-12);
        assert_eq!(result.effect_size, 1.0);
        assert_eq!(result.inference_path, InferencePath::Exact);
    }

    #[test]
    fn signed_rank_removes_zeros_and_reports_asymptotic_fallback() {
        let result = wilcoxon_signed_rank(
            &[[2.0, 1.0], [4.0, 2.0], [6.0, 3.0], [5.0, 5.0]],
            HypothesisTestAlternative::TwoSided,
        ).expect("signed-rank with zero");
        assert_eq!(result.zero_differences, 1);
        assert_eq!(result.inference_path, InferencePath::Asymptotic);
        assert_eq!(result.warnings, vec![RankWarning::ExactUnavailableWithZeros]);
    }

    #[test]
    fn ties_force_deterministic_asymptotic_inference() {
        let result = mann_whitney_u(
            &[1.0, 2.0, 2.0],
            &[2.0, 3.0, 4.0],
            HypothesisTestAlternative::TwoSided,
        ).expect("tied Mann-Whitney U");
        assert_eq!(result.inference_path, InferencePath::Asymptotic);
        assert_eq!(result.warnings, vec![RankWarning::ExactUnavailableWithTies]);
        assert!(result.p_value > 0.0 && result.p_value <= 1.0);
    }
}