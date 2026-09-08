use crate::engine::hypothesis_test::methods::omnibus::one_way_anova;
use crate::engine::hypothesis_test::normalize::{ConditionValues, IndependentGroups, NormalizedStudy};
use crate::error::AppError;

#[derive(Debug, Clone, PartialEq)]
pub struct DiagnosticEvidence {
    pub code: &'static str,
    pub grade: EvidenceGrade,
    pub value: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EvidenceGrade {
    Supports,
    Opposes,
    Insufficient,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DiagnosticSummary {
    pub severe_shape_or_influence: bool,
    pub heteroscedasticity_material: bool,
    pub limited_power: bool,
    pub paired_asymmetry: bool,
    pub block_assumption_warning: bool,
    pub evidence: Vec<DiagnosticEvidence>,
}

pub fn diagnose(study: &NormalizedStudy) -> Result<DiagnosticSummary, AppError> {
    match study {
        NormalizedStudy::IndependentTwo(groups) | NormalizedStudy::IndependentMulti(groups) => {
            diagnose_independent(groups)
        }
        NormalizedStudy::PairedTwo(paired) => {
            let differences = paired.pairs.iter().map(|pair| pair[0] - pair[1]).collect::<Vec<_>>();
            let shape = shape(&differences)?;
            Ok(DiagnosticSummary {
                severe_shape_or_influence: shape.severe,
                heteroscedasticity_material: false,
                limited_power: differences.len() < 8,
                paired_asymmetry: shape.skewness.abs() > 1.0,
                block_assumption_warning: false,
                evidence: vec![
                    evidence("pairedDifferenceSkewness", shape.skewness, shape_grade(shape.severe, differences.len())),
                    optional_evidence("pairedRobustInfluence", shape.robust_deviation, shape_grade(shape.severe, differences.len())),
                ],
            })
        }
        NormalizedStudy::CompleteBlock(study) => {
            let block_count = study.blocks.len();
            let condition_count = study.conditions.len();
            let grand = study.blocks.iter().flatten().sum::<f64>() / (block_count * condition_count) as f64;
            let condition_means = (0..condition_count).map(|condition| {
                study.blocks.iter().map(|block| block[condition]).sum::<f64>() / block_count as f64
            }).collect::<Vec<_>>();
            let block_means = study.blocks.iter().map(|block| {
                block.iter().sum::<f64>() / condition_count as f64
            }).collect::<Vec<_>>();
            let residuals = study.blocks.iter().enumerate().flat_map(|(block_index, block)| {
                let condition_means = &condition_means;
                let block_mean = block_means[block_index];
                block.iter().enumerate().map(move |(condition, value)| {
                    value - condition_means[condition] - block_mean + grand
                })
            }).collect::<Vec<_>>();
            let shape = shape(&residuals)?;
            let limited_power = block_count < 8;
            Ok(DiagnosticSummary {
                severe_shape_or_influence: shape.severe,
                heteroscedasticity_material: false,
                limited_power,
                paired_asymmetry: false,
                block_assumption_warning: block_count < 30 || shape.severe,
                evidence: vec![
                    evidence("additiveResidualShape", shape.skewness.abs().max(shape.kurtosis), shape_grade(shape.severe, block_count)),
                    evidence("completeBlockCount", block_count as f64, if limited_power { EvidenceGrade::Insufficient } else { EvidenceGrade::Supports }),
                ],
            })
        }
    }
}

fn diagnose_independent(groups: &IndependentGroups) -> Result<DiagnosticSummary, AppError> {
    let shapes = groups.groups.iter().map(|group| shape(&group.values)).collect::<Result<Vec<_>, _>>()?;
    let severe = shapes.iter().any(|shape| shape.severe);
    let limited_power = groups.groups.iter().any(|group| group.values.len() < 8);
    let counts = groups.groups.iter().map(|group| group.values.len()).collect::<Vec<_>>();
    let sample_ratio = *counts.iter().max().unwrap_or(&1) as f64 / *counts.iter().min().unwrap_or(&1) as f64;
    let variances = groups.groups.iter().map(|group| sample_variance(&group.values)).collect::<Result<Vec<_>, _>>()?;
    let positive = variances.iter().copied().filter(|variance| *variance > 0.0).collect::<Vec<_>>();
    let variance_ratio = if positive.len() == variances.len() {
        Some(positive.iter().copied().fold(f64::NEG_INFINITY, f64::max)
            / positive.iter().copied().fold(f64::INFINITY, f64::min))
    } else {
        None
    };
    let brown_forsythe_p = if groups.groups.iter().all(|group| group.values.len() >= 5) {
        brown_forsythe(groups)
    } else {
        None
    };
    let heteroscedasticity_material = brown_forsythe_p.is_some_and(|value| value < 0.10)
        || (variance_ratio.is_some_and(|value| value > 2.0) && sample_ratio > 2.0)
        || (positive.len() != variances.len() && positive.iter().any(|value| *value > 0.0));
    Ok(DiagnosticSummary {
        severe_shape_or_influence: severe,
        heteroscedasticity_material,
        limited_power,
        paired_asymmetry: false,
        block_assumption_warning: false,
        evidence: vec![
            optional_evidence("varianceRatio", variance_ratio, if heteroscedasticity_material { EvidenceGrade::Opposes } else { EvidenceGrade::Supports }),
            evidence("sampleSizeRatio", sample_ratio, if sample_ratio > 2.0 { EvidenceGrade::Opposes } else { EvidenceGrade::Supports }),
            optional_evidence("brownForsytheP", brown_forsythe_p, match brown_forsythe_p {
                Some(value) if value < 0.10 => EvidenceGrade::Opposes,
                Some(_) => EvidenceGrade::Supports,
                None => EvidenceGrade::Insufficient,
            }),
        ],
    })
}

struct ShapeSummary {
    skewness: f64,
    kurtosis: f64,
    robust_deviation: Option<f64>,
    severe: bool,
}

fn shape(values: &[f64]) -> Result<ShapeSummary, AppError> {
    if values.len() < 3 || values.iter().any(|value| !value.is_finite()) {
        return Err(AppError::Stats("shape diagnostics require three finite observations".into()));
    }
    let count = values.len() as f64;
    let mean = values.iter().sum::<f64>() / count;
    let second = values.iter().map(|value| (value - mean).powi(2)).sum::<f64>() / count;
    let third = values.iter().map(|value| (value - mean).powi(3)).sum::<f64>() / count;
    let fourth = values.iter().map(|value| (value - mean).powi(4)).sum::<f64>() / count;
    let skewness = if second > 0.0 {
        (count * (count - 1.0)).sqrt() / (count - 2.0) * third / second.powf(1.5)
    } else {
        0.0
    };
    let kurtosis = if values.len() >= 4 && second > 0.0 {
        (count - 1.0) / ((count - 2.0) * (count - 3.0))
            * ((count + 1.0) * (fourth / second.powi(2) - 3.0) + 6.0)
    } else {
        0.0
    };
    let center = median(values);
    let deviations = values.iter().map(|value| (value - center).abs()).collect::<Vec<_>>();
    let robust_scale = 1.4826 * median(&deviations);
    let robust_deviation = (robust_scale > 0.0).then(|| {
        deviations.iter().copied().fold(0.0, f64::max) / robust_scale
    });
    let severe = values.len() < 30
        && (skewness.abs() > 2.0 || kurtosis > 7.0 || robust_deviation.is_some_and(|value| value > 5.0));
    Ok(ShapeSummary { skewness, kurtosis, robust_deviation, severe })
}

fn brown_forsythe(groups: &IndependentGroups) -> Option<f64> {
    let deviations = IndependentGroups { groups: groups.groups.iter().map(|group| {
        let center = median(&group.values);
        ConditionValues {
            condition: group.condition.clone(),
            values: group.values.iter().map(|value| (value - center).abs()).collect(),
        }
    }).collect() };
    one_way_anova(&deviations).ok().map(|result| result.p_value)
}

fn sample_variance(values: &[f64]) -> Result<f64, AppError> {
    if values.len() < 2 {
        return Err(AppError::Stats("variance diagnostic requires two observations".into()));
    }
    let mean = values.iter().sum::<f64>() / values.len() as f64;
    Ok(values.iter().map(|value| (value - mean).powi(2)).sum::<f64>() / (values.len() - 1) as f64)
}

fn median(values: &[f64]) -> f64 {
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    let middle = sorted.len() / 2;
    if sorted.len() % 2 == 0 {
        (sorted[middle - 1] + sorted[middle]) / 2.0
    } else {
        sorted[middle]
    }
}

fn shape_grade(severe: bool, relevant_count: usize) -> EvidenceGrade {
    if severe {
        EvidenceGrade::Opposes
    } else if relevant_count < 8 {
        EvidenceGrade::Insufficient
    } else {
        EvidenceGrade::Supports
    }
}

fn evidence(code: &'static str, value: f64, grade: EvidenceGrade) -> DiagnosticEvidence {
    DiagnosticEvidence { code, grade, value: Some(value) }
}

fn optional_evidence(code: &'static str, value: Option<f64>, grade: EvidenceGrade) -> DiagnosticEvidence {
    DiagnosticEvidence { code, grade, value }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::hypothesis_test::normalize::{
        CompleteBlocks, ConditionValues, IndependentGroups, PairedDifferences,
    };

    #[test]
    fn independent_diagnostics_detect_extreme_influence_and_material_variance() {
        let study = NormalizedStudy::IndependentTwo(IndependentGroups { groups: vec![
            ConditionValues { condition: "A".into(), values: vec![0.0, 0.0, 0.0, 0.0, 20.0] },
            ConditionValues { condition: "B".into(), values: vec![1.0, 1.1, 0.9, 1.0, 1.1, 0.9, 1.0, 1.1, 0.9, 1.0, 1.1, 0.9] },
        ] });
        let summary = diagnose(&study).expect("diagnostics");
        assert!(summary.severe_shape_or_influence);
        assert!(summary.heteroscedasticity_material);
        assert!(summary.limited_power);
        assert!(summary.evidence.iter().any(|item| item.code == "varianceRatio"));
    }

    #[test]
    fn paired_and_block_diagnostics_use_differences_and_additive_residuals() {
        let paired = NormalizedStudy::PairedTwo(PairedDifferences {
            conditions: ["A".into(), "B".into()],
            subjects: (1..=6).map(|value| value.to_string()).collect(),
            pairs: vec![[1.0, 1.0], [2.0, 2.0], [3.0, 3.0], [4.0, 4.0], [5.0, 5.0], [30.0, 6.0]],
        });
        let paired_summary = diagnose(&paired).expect("paired diagnostics");
        assert!(paired_summary.paired_asymmetry);
        assert!(paired_summary.severe_shape_or_influence);

        let blocked = NormalizedStudy::CompleteBlock(CompleteBlocks {
            conditions: vec!["A".into(), "B".into(), "C".into()],
            subjects: vec!["1".into(), "2".into(), "3".into()],
            blocks: vec![vec![1.0, 2.0, 4.0], vec![2.0, 3.0, 5.0], vec![4.0, 5.0, 8.0]],
        });
        let block_summary = diagnose(&blocked).expect("block diagnostics");
        assert!(block_summary.block_assumption_warning);
        assert!(block_summary.evidence.iter().any(|item| item.code == "additiveResidualShape"));
    }
}