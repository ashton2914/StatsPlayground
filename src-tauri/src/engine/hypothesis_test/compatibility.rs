use crate::engine::hypothesis_test::normalize::NormalizedStudy;
use crate::models::hypothesis_test::{HypothesisTestAlternative, HypothesisTestMethodId};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CompatibilityState {
    Compatible,
    Incompatible,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CompatibilityReason {
    RequiresIndependentTwo,
    RequiresPairedTwo,
    RequiresIndependentMulti,
    RequiresCompleteBlock,
    InsufficientObservations,
    ZeroVariance,
    AllRanksTied,
    OneSidedOmnibusUnsupported,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MethodCompatibility {
    pub state: CompatibilityState,
    pub reasons: Vec<CompatibilityReason>,
}

pub fn evaluate_method_compatibility(
    study: &NormalizedStudy,
    method: HypothesisTestMethodId,
    alternative: HypothesisTestAlternative,
) -> MethodCompatibility {
    let is_omnibus = matches!(
        &method,
        HypothesisTestMethodId::OneWayAnova
            | HypothesisTestMethodId::WelchAnova
            | HypothesisTestMethodId::KruskalWallis
            | HypothesisTestMethodId::RandomizedBlockAnova
            | HypothesisTestMethodId::Friedman
    );
    if is_omnibus && !matches!(alternative, HypothesisTestAlternative::TwoSided) {
        return incompatible(CompatibilityReason::OneSidedOmnibusUnsupported);
    }
    let reason = match method {
        HypothesisTestMethodId::StudentTwoSampleT
        | HypothesisTestMethodId::WelchTwoSampleT
        | HypothesisTestMethodId::MannWhitneyU => match study {
            NormalizedStudy::IndependentTwo(groups) => {
                if matches!(method, HypothesisTestMethodId::MannWhitneyU) {
                    None
                } else {
                    parametric_independent_reason(groups, &method)
                }
            }
            _ => Some(CompatibilityReason::RequiresIndependentTwo),
        },
        HypothesisTestMethodId::PairedT | HypothesisTestMethodId::WilcoxonSignedRank => {
            match study {
                NormalizedStudy::PairedTwo(paired) => {
                    if matches!(method, HypothesisTestMethodId::PairedT) {
                        paired_t_reason(&paired.pairs)
                    } else {
                        None
                    }
                }
                _ => Some(CompatibilityReason::RequiresPairedTwo),
            }
        }
        HypothesisTestMethodId::OneWayAnova
        | HypothesisTestMethodId::WelchAnova
        | HypothesisTestMethodId::KruskalWallis => match study {
            NormalizedStudy::IndependentMulti(groups) => multi_group_reason(groups, &method),
            _ => Some(CompatibilityReason::RequiresIndependentMulti),
        },
        HypothesisTestMethodId::RandomizedBlockAnova | HypothesisTestMethodId::Friedman => {
            match study {
                NormalizedStudy::CompleteBlock(blocks) => block_reason(blocks, &method),
                _ => Some(CompatibilityReason::RequiresCompleteBlock),
            }
        }
    };
    match reason {
        None => MethodCompatibility { state: CompatibilityState::Compatible, reasons: vec![] },
        Some(reason) => incompatible(reason),
    }
}

fn incompatible(reason: CompatibilityReason) -> MethodCompatibility {
    MethodCompatibility { state: CompatibilityState::Incompatible, reasons: vec![reason] }
}

fn multi_group_reason(
    groups: &crate::engine::hypothesis_test::normalize::IndependentGroups,
    method: &HypothesisTestMethodId,
) -> Option<CompatibilityReason> {
    let minimum = if matches!(method, HypothesisTestMethodId::KruskalWallis) { 1 } else { 2 };
    if groups.groups.len() < 3 || groups.groups.iter().any(|group| group.values.len() < minimum) {
        return Some(CompatibilityReason::InsufficientObservations);
    }
    if matches!(method, HypothesisTestMethodId::KruskalWallis) {
        let first = groups.groups.first()?.values.first()?;
        return groups.groups.iter().flat_map(|group| &group.values)
            .all(|value| value == first)
            .then_some(CompatibilityReason::AllRanksTied);
    }
    let variances = groups.groups.iter().map(|group| variance(&group.values))
        .collect::<Option<Vec<_>>>();
    let Some(variances) = variances else {
        return Some(CompatibilityReason::InsufficientObservations);
    };
    let estimable = if matches!(method, HypothesisTestMethodId::WelchAnova) {
        variances.iter().all(|variance| *variance > 0.0)
    } else {
        groups.groups.iter().zip(variances)
            .map(|(group, variance)| (group.values.len() - 1) as f64 * variance)
            .sum::<f64>() > 0.0
    };
    (!estimable).then_some(CompatibilityReason::ZeroVariance)
}

fn block_reason(
    study: &crate::engine::hypothesis_test::normalize::CompleteBlocks,
    method: &HypothesisTestMethodId,
) -> Option<CompatibilityReason> {
    if study.conditions.len() < 3 || study.blocks.len() < 2
        || study.blocks.iter().any(|block| block.len() != study.conditions.len())
    {
        return Some(CompatibilityReason::InsufficientObservations);
    }
    if matches!(method, HypothesisTestMethodId::Friedman) {
        return study.blocks.iter().all(|block| {
            block.iter().skip(1).all(|value| value == &block[0])
        }).then_some(CompatibilityReason::AllRanksTied);
    }
    let block_count = study.blocks.len();
    let condition_count = study.conditions.len();
    let grand_mean = study.blocks.iter().flatten().sum::<f64>() / (block_count * condition_count) as f64;
    let condition_ss = block_count as f64 * (0..condition_count).map(|condition| {
        let mean = study.blocks.iter().map(|block| block[condition]).sum::<f64>() / block_count as f64;
        (mean - grand_mean).powi(2)
    }).sum::<f64>();
    let block_ss = condition_count as f64 * study.blocks.iter().map(|block| {
        let mean = block.iter().sum::<f64>() / condition_count as f64;
        (mean - grand_mean).powi(2)
    }).sum::<f64>();
    let total_ss = study.blocks.iter().flatten().map(|value| (value - grand_mean).powi(2)).sum::<f64>();
    let residual_ss = total_ss - condition_ss - block_ss;
    (residual_ss <= f64::EPSILON * total_ss.max(1.0)).then_some(CompatibilityReason::ZeroVariance)
}

fn parametric_independent_reason(
    groups: &crate::engine::hypothesis_test::normalize::IndependentGroups,
    method: &HypothesisTestMethodId,
) -> Option<CompatibilityReason> {
    if groups.groups.len() != 2 || groups.groups.iter().any(|group| group.values.len() < 2) {
        return Some(CompatibilityReason::InsufficientObservations);
    }
    let variances = groups.groups.iter().map(|group| variance(&group.values)).collect::<Option<Vec<_>>>()?;
    let estimable = match method {
        HypothesisTestMethodId::StudentTwoSampleT => {
            let residual_sum = groups.groups.iter().zip(&variances)
                .map(|(group, variance)| (group.values.len() - 1) as f64 * variance)
                .sum::<f64>();
            residual_sum > 0.0
        }
        HypothesisTestMethodId::WelchTwoSampleT => variances.iter().sum::<f64>() > 0.0,
        _ => true,
    };
    (!estimable).then_some(CompatibilityReason::ZeroVariance)
}

fn paired_t_reason(pairs: &[[f64; 2]]) -> Option<CompatibilityReason> {
    if pairs.len() < 2 {
        return Some(CompatibilityReason::InsufficientObservations);
    }
    let differences = pairs.iter().map(|pair| pair[0] - pair[1]).collect::<Vec<_>>();
    match variance(&differences) {
        Some(value) if value > 0.0 => None,
        _ => Some(CompatibilityReason::ZeroVariance),
    }
}

fn variance(values: &[f64]) -> Option<f64> {
    if values.len() < 2 || values.iter().any(|value| !value.is_finite()) {
        return None;
    }
    let mean = values.iter().sum::<f64>() / values.len() as f64;
    let value = values.iter().map(|value| (value - mean).powi(2)).sum::<f64>()
        / (values.len() - 1) as f64;
    value.is_finite().then_some(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::hypothesis_test::normalize::{CompleteBlocks, ConditionValues, IndependentGroups};

    #[test]
    fn classifies_structure_and_zero_variance_without_execution_errors() {
        let study = NormalizedStudy::IndependentTwo(IndependentGroups { groups: vec![
            ConditionValues { condition: "A".into(), values: vec![1.0, 2.0, 3.0] },
            ConditionValues { condition: "B".into(), values: vec![2.0, 3.0, 5.0] },
        ] });
        assert_eq!(
            evaluate_method_compatibility(
                &study,
                HypothesisTestMethodId::WelchTwoSampleT,
                HypothesisTestAlternative::TwoSided,
            ).state,
            CompatibilityState::Compatible,
        );
        assert_eq!(
            evaluate_method_compatibility(
                &study,
                HypothesisTestMethodId::PairedT,
                HypothesisTestAlternative::TwoSided,
            ).reasons,
            vec![CompatibilityReason::RequiresPairedTwo],
        );

        let constant = NormalizedStudy::IndependentTwo(IndependentGroups { groups: vec![
            ConditionValues { condition: "A".into(), values: vec![1.0, 1.0] },
            ConditionValues { condition: "B".into(), values: vec![2.0, 2.0] },
        ] });
        assert_eq!(
            evaluate_method_compatibility(
                &constant,
                HypothesisTestMethodId::StudentTwoSampleT,
                HypothesisTestAlternative::TwoSided,
            ).reasons,
            vec![CompatibilityReason::ZeroVariance],
        );
    }

    #[test]
    fn rejects_one_sided_and_degenerate_multi_group_methods_before_execution() {
        let singleton = NormalizedStudy::IndependentMulti(IndependentGroups { groups: vec![
            ConditionValues { condition: "A".into(), values: vec![1.0, 2.0] },
            ConditionValues { condition: "B".into(), values: vec![2.0] },
            ConditionValues { condition: "C".into(), values: vec![3.0, 4.0] },
        ] });
        assert_eq!(
            evaluate_method_compatibility(
                &singleton,
                HypothesisTestMethodId::WelchAnova,
                HypothesisTestAlternative::TwoSided,
            ).reasons,
            vec![CompatibilityReason::InsufficientObservations],
        );
        assert_eq!(
            evaluate_method_compatibility(
                &singleton,
                HypothesisTestMethodId::KruskalWallis,
                HypothesisTestAlternative::Greater,
            ).reasons,
            vec![CompatibilityReason::OneSidedOmnibusUnsupported],
        );

        let tied = NormalizedStudy::IndependentMulti(IndependentGroups { groups: vec![
            ConditionValues { condition: "A".into(), values: vec![1.0] },
            ConditionValues { condition: "B".into(), values: vec![1.0] },
            ConditionValues { condition: "C".into(), values: vec![1.0] },
        ] });
        assert_eq!(
            evaluate_method_compatibility(
                &tied,
                HypothesisTestMethodId::KruskalWallis,
                HypothesisTestAlternative::TwoSided,
            ).reasons,
            vec![CompatibilityReason::AllRanksTied],
        );
    }

    #[test]
    fn rejects_degenerate_complete_block_methods_before_execution() {
        let tied = NormalizedStudy::CompleteBlock(CompleteBlocks {
            conditions: vec!["A".into(), "B".into(), "C".into()],
            subjects: vec!["1".into(), "2".into()],
            blocks: vec![vec![1.0, 1.0, 1.0], vec![2.0, 2.0, 2.0]],
        });
        assert_eq!(
            evaluate_method_compatibility(
                &tied,
                HypothesisTestMethodId::Friedman,
                HypothesisTestAlternative::TwoSided,
            ).reasons,
            vec![CompatibilityReason::AllRanksTied],
        );
        assert_eq!(
            evaluate_method_compatibility(
                &tied,
                HypothesisTestMethodId::RandomizedBlockAnova,
                HypothesisTestAlternative::TwoSided,
            ).reasons,
            vec![CompatibilityReason::ZeroVariance],
        );
    }
}