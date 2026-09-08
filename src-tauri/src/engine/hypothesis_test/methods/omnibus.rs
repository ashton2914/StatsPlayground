use crate::engine::hypothesis_test::normalize::IndependentGroups;
use crate::error::AppError;
use statrs::distribution::{ChiSquared, ContinuousCDF, FisherSnedecor};

use super::parametric::sample_moments;
use super::rank::average_ranks;

#[derive(Debug, Clone, PartialEq)]
pub struct OmnibusResult {
    pub statistic: f64,
    pub numerator_degrees_of_freedom: f64,
    pub denominator_degrees_of_freedom: Option<f64>,
    pub p_value: f64,
    pub effect_size: f64,
}

pub fn one_way_anova(groups: &IndependentGroups) -> Result<OmnibusResult, AppError> {
    validate_groups(groups, false)?;
    let count = groups.groups.iter().map(|group| group.values.len()).sum::<usize>();
    let grand_mean = groups.groups.iter().flat_map(|group| &group.values).sum::<f64>() / count as f64;
    let mut between = 0.0;
    let mut within = 0.0;
    for group in &groups.groups {
        let (mean, variance) = sample_moments(&group.values)?;
        between += group.values.len() as f64 * (mean - grand_mean).powi(2);
        within += (group.values.len() - 1) as f64 * variance;
    }
    let df1 = (groups.groups.len() - 1) as f64;
    let df2 = (count - groups.groups.len()) as f64;
    let mean_square_within = within / df2;
    if mean_square_within <= 0.0 {
        return Err(AppError::Stats("ANOVA residual variance is not estimable".into()));
    }
    let statistic = (between / df1) / mean_square_within;
    let distribution = FisherSnedecor::new(df1, df2)
        .map_err(|error| AppError::Stats(error.to_string()))?;
    let effect_size = (between - df1 * mean_square_within)
        / (between + within + mean_square_within);
    Ok(OmnibusResult {
        statistic,
        numerator_degrees_of_freedom: df1,
        denominator_degrees_of_freedom: Some(df2),
        p_value: distribution.sf(statistic),
        effect_size,
    })
}

pub fn welch_anova(groups: &IndependentGroups) -> Result<OmnibusResult, AppError> {
    validate_groups(groups, false)?;
    let group_moments = groups.groups.iter().map(|group| {
        sample_moments(&group.values).map(|(mean, variance)| {
            (group.values.len() as f64, mean, variance)
        })
    }).collect::<Result<Vec<_>, _>>()?;
    if group_moments.iter().any(|(_, _, variance)| *variance <= 0.0) {
        return Err(AppError::Stats("Welch ANOVA requires positive variance in every group".into()));
    }
    let weights = group_moments.iter().map(|(count, _, variance)| count / variance).collect::<Vec<_>>();
    let weight_sum = weights.iter().sum::<f64>();
    let weighted_mean = group_moments.iter().zip(&weights)
        .map(|((_, mean, _), weight)| mean * weight).sum::<f64>() / weight_sum;
    let groups_count = group_moments.len() as f64;
    let df1 = groups_count - 1.0;
    let weighted_between = group_moments.iter().zip(&weights)
        .map(|((_, mean, _), weight)| weight * (mean - weighted_mean).powi(2))
        .sum::<f64>() / df1;
    let correction_sum = group_moments.iter().zip(&weights)
        .map(|((count, _, _), weight)| (1.0 - weight / weight_sum).powi(2) / (count - 1.0))
        .sum::<f64>();
    let correction = 1.0 + 2.0 * (groups_count - 2.0) * correction_sum
        / (groups_count.powi(2) - 1.0);
    let statistic = weighted_between / correction;
    let df2 = (groups_count.powi(2) - 1.0) / (3.0 * correction_sum);
    let distribution = FisherSnedecor::new(df1, df2)
        .map_err(|error| AppError::Stats(error.to_string()))?;
    let effect_size = ((statistic - 1.0) * df1)
        / (statistic * df1 + df2 + 1.0);
    Ok(OmnibusResult {
        statistic,
        numerator_degrees_of_freedom: df1,
        denominator_degrees_of_freedom: Some(df2),
        p_value: distribution.sf(statistic),
        effect_size,
    })
}

pub fn kruskal_wallis(groups: &IndependentGroups) -> Result<OmnibusResult, AppError> {
    validate_groups(groups, true)?;
    let mut pooled = groups.groups.iter().enumerate().flat_map(|(group_index, group)| {
        group.values.iter().map(move |value| (*value, group_index))
    }).collect::<Vec<_>>();
    pooled.sort_by(|left, right| left.0.total_cmp(&right.0));
    let sorted_values = pooled.iter().map(|item| item.0).collect::<Vec<_>>();
    let (ranks, ties) = average_ranks(&sorted_values);
    let mut rank_sums = vec![0.0; groups.groups.len()];
    for ((_, group_index), rank) in pooled.iter().zip(ranks) {
        rank_sums[*group_index] += rank;
    }
    let count = pooled.len();
    let uncorrected = 12.0 / (count * (count + 1)) as f64
        * rank_sums.iter().zip(&groups.groups)
            .map(|(sum, group)| sum.powi(2) / group.values.len() as f64)
            .sum::<f64>()
        - 3.0 * (count + 1) as f64;
    let tie_correction = 1.0 - ties.iter().map(|size| size.pow(3) - size).sum::<usize>() as f64
        / (count.pow(3) - count) as f64;
    if tie_correction <= 0.0 {
        return Err(AppError::Stats("Kruskal-Wallis is undefined when all observations tie".into()));
    }
    let statistic = uncorrected / tie_correction;
    let degrees_of_freedom = (groups.groups.len() - 1) as f64;
    let distribution = ChiSquared::new(degrees_of_freedom)
        .map_err(|error| AppError::Stats(error.to_string()))?;
    let effect_size = (statistic - degrees_of_freedom) / (count - groups.groups.len()) as f64;
    Ok(OmnibusResult {
        statistic,
        numerator_degrees_of_freedom: degrees_of_freedom,
        denominator_degrees_of_freedom: None,
        p_value: distribution.sf(statistic),
        effect_size,
    })
}

fn validate_groups(groups: &IndependentGroups, allow_singletons: bool) -> Result<(), AppError> {
    if groups.groups.len() < 2 {
        return Err(AppError::Stats("omnibus test requires at least two groups".into()));
    }
    let minimum = if allow_singletons { 1 } else { 2 };
    if groups.groups.iter().any(|group| {
        group.values.len() < minimum || group.values.iter().any(|value| !value.is_finite())
    }) {
        return Err(AppError::Stats("omnibus groups have insufficient finite observations".into()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::hypothesis_test::methods::parametric::{student_two_sample_t, welch_two_sample_t};
    use crate::engine::hypothesis_test::normalize::ConditionValues;
    use crate::models::hypothesis_test::HypothesisTestAlternative;

    #[test]
    fn two_group_anova_matches_corresponding_t_squared() {
        let groups = fixture();
        let student = student_two_sample_t(
            &groups.groups[0].values,
            &groups.groups[1].values,
            HypothesisTestAlternative::TwoSided,
            0.95,
        ).expect("Student t");
        let welch = welch_two_sample_t(
            &groups.groups[0].values,
            &groups.groups[1].values,
            HypothesisTestAlternative::TwoSided,
            0.95,
        ).expect("Welch t");

        let anova = one_way_anova(&groups).expect("ANOVA");
        let welch_anova = welch_anova(&groups).expect("Welch ANOVA");
        assert!((anova.statistic - student.statistic.powi(2)).abs() < 1e-10);
        assert!((welch_anova.statistic - welch.statistic.powi(2)).abs() < 1e-10);
        assert!((welch_anova.denominator_degrees_of_freedom.unwrap()
            - welch.degrees_of_freedom).abs() < 1e-10);
    }

    #[test]
    fn kruskal_wallis_applies_tie_correction() {
        let groups = IndependentGroups { groups: vec![
            ConditionValues { condition: "A".into(), values: vec![1.0, 2.0, 2.0] },
            ConditionValues { condition: "B".into(), values: vec![2.0, 3.0, 4.0] },
            ConditionValues { condition: "C".into(), values: vec![4.0, 5.0, 6.0] },
        ] };
        let result = kruskal_wallis(&groups).expect("Kruskal-Wallis");
        assert!((result.statistic - 6.330_434_782_608_691).abs() < 1e-10);
        assert_eq!(result.numerator_degrees_of_freedom, 2.0);
        assert!(result.p_value > 0.0 && result.p_value < 0.05);
    }

    fn fixture() -> IndependentGroups {
        IndependentGroups { groups: vec![
            ConditionValues { condition: "A".into(), values: vec![10.0, 11.0, 12.0, 13.0] },
            ConditionValues { condition: "B".into(), values: vec![20.0, 22.0, 24.0, 26.0, 28.0] },
        ] }
    }
}