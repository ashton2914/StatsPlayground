use crate::engine::hypothesis_test::normalize::{IndependentGroups, PairedDifferences};
use crate::error::AppError;
use crate::engine::hypothesis_test::methods::parametric::sample_moments;
use statrs::function::gamma::ln_gamma;

#[derive(Debug, Clone, PartialEq)]
pub struct EffectEstimate {
    pub value: f64,
    pub denominator: &'static str,
    pub formula_version: &'static str,
}

pub fn hedges_g_pooled(groups: &IndependentGroups) -> Result<EffectEstimate, AppError> {
    let (left, right) = two_groups(groups)?;
    let (left_mean, left_variance) = sample_moments(&left.values)?;
    let (right_mean, right_variance) = sample_moments(&right.values)?;
    let degrees_of_freedom = (left.values.len() + right.values.len() - 2) as f64;
    let pooled_variance = (((left.values.len() - 1) as f64 * left_variance)
        + ((right.values.len() - 1) as f64 * right_variance)) / degrees_of_freedom;
    effect(
        left_mean - right_mean,
        pooled_variance.sqrt(),
        degrees_of_freedom,
        "pooledStandardDeviation",
        "hedges-g-v1",
    )
}

pub fn hedges_g_av(groups: &IndependentGroups) -> Result<EffectEstimate, AppError> {
    let (left, right) = two_groups(groups)?;
    let (left_mean, left_variance) = sample_moments(&left.values)?;
    let (right_mean, right_variance) = sample_moments(&right.values)?;
    effect(
        left_mean - right_mean,
        ((left_variance + right_variance) / 2.0).sqrt(),
        (left.values.len() + right.values.len() - 2) as f64,
        "averageGroupStandardDeviation",
        "hedges-g-av-v1",
    )
}

pub fn paired_d_z(differences: &PairedDifferences) -> Result<EffectEstimate, AppError> {
    let values = differences.pairs.iter().map(|pair| pair[0] - pair[1]).collect::<Vec<_>>();
    let (mean, variance) = sample_moments(&values)?;
    let denominator = variance.sqrt();
    if denominator <= 0.0 {
        return Err(AppError::Stats("paired difference standard deviation is zero".into()));
    }
    Ok(EffectEstimate {
        value: mean / denominator,
        denominator: "pairedDifferenceStandardDeviation",
        formula_version: "paired-dz-v1",
    })
}

fn two_groups(
    groups: &IndependentGroups,
) -> Result<(&crate::engine::hypothesis_test::normalize::ConditionValues, &crate::engine::hypothesis_test::normalize::ConditionValues), AppError> {
    if groups.groups.len() != 2 {
        return Err(AppError::Stats("effect size requires exactly two groups".into()));
    }
    Ok((&groups.groups[0], &groups.groups[1]))
}

fn effect(
    difference: f64,
    denominator: f64,
    degrees_of_freedom: f64,
    denominator_name: &'static str,
    formula_version: &'static str,
) -> Result<EffectEstimate, AppError> {
    if denominator <= 0.0 || !denominator.is_finite() {
        return Err(AppError::Stats("effect size denominator is not estimable".into()));
    }
    let correction = hedges_correction(degrees_of_freedom)?;
    Ok(EffectEstimate {
        value: correction * difference / denominator,
        denominator: denominator_name,
        formula_version,
    })
}

fn hedges_correction(degrees_of_freedom: f64) -> Result<f64, AppError> {
    if degrees_of_freedom <= 1.0 || !degrees_of_freedom.is_finite() {
        return Err(AppError::Stats("Hedges correction requires more than one degree of freedom".into()));
    }
    Ok((ln_gamma(degrees_of_freedom / 2.0)
        - 0.5 * (degrees_of_freedom / 2.0).ln()
        - ln_gamma((degrees_of_freedom - 1.0) / 2.0))
        .exp())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::hypothesis_test::normalize::{ConditionValues, IndependentGroups};

    #[test]
    fn pooled_hedges_g_uses_small_sample_correction() {
        let groups = IndependentGroups {
            groups: vec![
                ConditionValues { condition: "A".into(), values: vec![1.0, 2.0, 3.0, 4.0] },
                ConditionValues { condition: "B".into(), values: vec![2.0, 3.0, 4.0, 5.0] },
            ],
        };
        let effect = hedges_g_pooled(&groups).expect("Hedges g");
        assert!((effect.value + 0.672_835_339_205_376_1).abs() < 1e-12);
        assert_eq!(effect.denominator, "pooledStandardDeviation");
        assert_eq!(effect.formula_version, "hedges-g-v1");
    }

    #[test]
    fn g_av_and_paired_d_z_retain_denominator_identity() {
        let groups = IndependentGroups {
            groups: vec![
                ConditionValues { condition: "A".into(), values: vec![1.0, 2.0, 3.0, 4.0] },
                ConditionValues { condition: "B".into(), values: vec![4.0, 6.0, 8.0, 10.0] },
            ],
        };
        let g_av = hedges_g_av(&groups).expect("g-av");
        assert_eq!(g_av.denominator, "averageGroupStandardDeviation");
        assert_eq!(g_av.formula_version, "hedges-g-av-v1");

        let paired = PairedDifferences {
            conditions: ["Before".into(), "After".into()],
            subjects: vec!["1".into(), "2".into(), "3".into()],
            pairs: vec![[1.0, 2.0], [2.0, 4.0], [4.0, 5.0]],
        };
        let d_z = paired_d_z(&paired).expect("paired d-z");
        assert!((d_z.value + 2.309_401_076_758_503).abs() < 1e-12);
        assert_eq!(d_z.denominator, "pairedDifferenceStandardDeviation");
        assert_eq!(d_z.formula_version, "paired-dz-v1");
    }
}