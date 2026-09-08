use std::collections::HashMap;

use crate::engine::hypothesis_test::compatibility::{
    evaluate_method_compatibility, CompatibilityReason, CompatibilityState,
};
use crate::engine::hypothesis_test::diagnostics::{diagnose, EvidenceGrade};
use crate::engine::hypothesis_test::effect_size::{hedges_g_av, hedges_g_pooled, paired_d_z};
use crate::engine::hypothesis_test::methods::block::{friedman, randomized_block_anova};
use crate::engine::hypothesis_test::methods::omnibus::{kruskal_wallis, one_way_anova, welch_anova};
use crate::engine::hypothesis_test::methods::parametric::{paired_t, student_two_sample_t, welch_two_sample_t};
use crate::engine::hypothesis_test::methods::rank::{mann_whitney_u, wilcoxon_signed_rank, InferencePath, RankWarning};
use crate::engine::hypothesis_test::normalize::NormalizedStudy;
use crate::engine::hypothesis_test::post_hoc::parametric::{games_howell, paired_t_holm, tukey_kramer};
use crate::engine::hypothesis_test::post_hoc::rank::{dunn_holm, paired_wilcoxon_holm};
use crate::engine::hypothesis_test::post_hoc::PostHocResult;
use crate::engine::hypothesis_test::selector::{select_execution_plan, SelectorCertainty};
use crate::error::AppError;
use crate::models::hypothesis_test::{
    HypothesisTestCompatibility, HypothesisTestDefinition, HypothesisTestDiagnosticEvidence,
    HypothesisTestEffectSize, HypothesisTestEstimate, HypothesisTestMethodId,
    HypothesisTestMethodResult, HypothesisTestPostHocComparison, HypothesisTestPostHocResult,
    HypothesisTestSelectionDecision, HypothesisTestSensitivityResult, HypothesisTestValue,
};

#[derive(Debug, Clone, PartialEq)]
pub struct HypothesisTestComputation {
    pub compatibility: Vec<HypothesisTestCompatibility>,
    pub diagnostics: Vec<HypothesisTestDiagnosticEvidence>,
    pub selection_decision: HypothesisTestSelectionDecision,
    pub primary_result: HypothesisTestMethodResult,
    pub sensitivity_results: Vec<HypothesisTestSensitivityResult>,
    pub post_hoc_result: Option<HypothesisTestPostHocResult>,
    pub warnings: Vec<String>,
    pub inference_path: String,
    pub correction_codes: Vec<String>,
}

pub fn run_hypothesis_test(
    input: NormalizedStudy,
    definition: &HypothesisTestDefinition,
) -> Result<HypothesisTestComputation, AppError> {
    let diagnostic_summary = diagnose(&input)?;
    let plan = select_execution_plan(&input, &diagnostic_summary, definition)?;
    let (primary_result, inference_path, correction_codes, mut warnings) =
        execute_method(&input, plan.executed_method.clone(), definition)?;
    let mut sensitivity_results = Vec::new();
    for method in &plan.sensitivity_methods {
        let (result, _, _, method_warnings) = execute_method(&input, method.clone(), definition)?;
        warnings.extend(method_warnings);
        sensitivity_results.push(HypothesisTestSensitivityResult {
            robustness: robustness(&primary_result, &result, definition.alpha),
            method: result,
        });
    }
    warnings.sort();
    warnings.dedup();
    let post_hoc_result = if definition.post_hoc == "automatic"
        && primary_result.p_value <= definition.alpha
    {
        run_post_hoc(&input, &plan.executed_method, definition)?
            .map(to_post_hoc_result)
            .transpose()?
    } else {
        None
    };
    let compatibility = all_methods().into_iter().map(|method_id| {
        let result = evaluate_method_compatibility(
            &input,
            method_id.clone(),
            definition.alternative.clone(),
        );
        HypothesisTestCompatibility {
            method_id,
            state: match result.state {
                CompatibilityState::Compatible => "compatible",
                CompatibilityState::Incompatible => "incompatible",
            }.into(),
            reason_codes: result.reasons.into_iter().map(reason_code).map(str::to_owned).collect(),
        }
    }).collect();
    let diagnostics = diagnostic_summary.evidence.into_iter().map(|item| {
        HypothesisTestDiagnosticEvidence {
            code: item.code.into(),
            grade: match item.grade {
                EvidenceGrade::Supports => "supports",
                EvidenceGrade::Opposes => "opposes",
                EvidenceGrade::Insufficient => "insufficient",
            }.into(),
            value: item.value.map(available).unwrap_or_else(|| unavailable("diagnosticNotEstimable")),
            parameters: HashMap::new(),
        }
    }).collect();
    Ok(HypothesisTestComputation {
        compatibility,
        diagnostics,
        selection_decision: HypothesisTestSelectionDecision {
            selector_version: "1".into(),
            recommended_method: plan.recommended_method,
            executed_method: plan.executed_method,
            certainty: match plan.certainty {
                SelectorCertainty::High => "high",
                SelectorCertainty::Medium => "medium",
                SelectorCertainty::Low => "low",
            }.into(),
            reason_codes: plan.reason_codes.into_iter().map(str::to_owned).collect(),
            overridden: plan.overridden,
        },
        primary_result,
        sensitivity_results,
        post_hoc_result,
        warnings,
        inference_path,
        correction_codes,
    })
}

fn execute_method(
    study: &NormalizedStudy,
    method: HypothesisTestMethodId,
    definition: &HypothesisTestDefinition,
) -> Result<(HypothesisTestMethodResult, String, Vec<String>, Vec<String>), AppError> {
    match (method.clone(), study) {
        (HypothesisTestMethodId::StudentTwoSampleT, NormalizedStudy::IndependentTwo(groups))
        | (HypothesisTestMethodId::WelchTwoSampleT, NormalizedStudy::IndependentTwo(groups)) => {
            let result = if matches!(method, HypothesisTestMethodId::StudentTwoSampleT) {
                student_two_sample_t(&groups.groups[0].values, &groups.groups[1].values, definition.alternative.clone(), definition.confidence_level)?
            } else {
                welch_two_sample_t(&groups.groups[0].values, &groups.groups[1].values, definition.alternative.clone(), definition.confidence_level)?
            };
            let effect = if matches!(method, HypothesisTestMethodId::StudentTwoSampleT) {
                hedges_g_pooled(groups)?
            } else {
                hedges_g_av(groups)?
            };
            let effect_kind = if matches!(method, HypothesisTestMethodId::StudentTwoSampleT) { "hedgesG" } else { "hedgesGAv" };
            Ok((method_result(
                method, "t", result.statistic, vec![result.degrees_of_freedom], result.p_value,
                "meanDifference", Some(result.estimate), Some(result.lower), Some(result.upper),
                effect_kind, effect.value, effect.formula_version, definition,
            )?, "parametric".into(), vec![], vec![]))
        }
        (HypothesisTestMethodId::MannWhitneyU, NormalizedStudy::IndependentTwo(groups)) => {
            let result = mann_whitney_u(&groups.groups[0].values, &groups.groups[1].values, definition.alternative.clone())?;
            rank_method_result(method, "U", "relativeStochasticLocation", result, definition)
        }
        (HypothesisTestMethodId::PairedT, NormalizedStudy::PairedTwo(paired)) => {
            let result = paired_t(&paired.pairs, definition.alternative.clone(), definition.confidence_level)?;
            let effect = paired_d_z(paired)?;
            Ok((method_result(
                method, "t", result.statistic, vec![result.degrees_of_freedom], result.p_value,
                "meanPairedDifference", Some(result.estimate), Some(result.lower), Some(result.upper),
                "pairedDz", effect.value, effect.formula_version, definition,
            )?, "parametric".into(), vec![], vec![]))
        }
        (HypothesisTestMethodId::WilcoxonSignedRank, NormalizedStudy::PairedTwo(paired)) => {
            let result = wilcoxon_signed_rank(&paired.pairs, definition.alternative.clone())?;
            rank_method_result(method, "W", "pairedPseudomedian", result, definition)
        }
        (HypothesisTestMethodId::OneWayAnova, NormalizedStudy::IndependentMulti(groups))
        | (HypothesisTestMethodId::WelchAnova, NormalizedStudy::IndependentMulti(groups))
        | (HypothesisTestMethodId::KruskalWallis, NormalizedStudy::IndependentMulti(groups)) => {
            let result = match method {
                HypothesisTestMethodId::OneWayAnova => one_way_anova(groups)?,
                HypothesisTestMethodId::WelchAnova => welch_anova(groups)?,
                HypothesisTestMethodId::KruskalWallis => kruskal_wallis(groups)?,
                _ => unreachable!(),
            };
            let (statistic_name, estimand, effect_kind, formula) = match method {
                HypothesisTestMethodId::OneWayAnova => ("F", "groupMeans", "omegaSquared", "anova-v1"),
                HypothesisTestMethodId::WelchAnova => ("F", "groupMeans", "welchPartialOmegaSquared", "welch-anova-v1"),
                HypothesisTestMethodId::KruskalWallis => ("H", "rankDistributions", "epsilonSquared", "kruskal-wallis-v1"),
                _ => unreachable!(),
            };
            let mut degrees = vec![result.numerator_degrees_of_freedom];
            if let Some(value) = result.denominator_degrees_of_freedom { degrees.push(value); }
            Ok((method_result(
                method, statistic_name, result.statistic, degrees, result.p_value,
                estimand, None, None, None, effect_kind, result.effect_size, formula, definition,
            )?, if statistic_name == "H" { "asymptotic" } else { "parametric" }.into(),
                if statistic_name == "H" { vec!["tieCorrection".into()] } else { vec![] }, vec![]))
        }
        (HypothesisTestMethodId::RandomizedBlockAnova, NormalizedStudy::CompleteBlock(blocks))
        | (HypothesisTestMethodId::Friedman, NormalizedStudy::CompleteBlock(blocks)) => {
            let result = if matches!(method, HypothesisTestMethodId::RandomizedBlockAnova) {
                randomized_block_anova(blocks)?
            } else {
                friedman(blocks)?
            };
            let is_friedman = matches!(method, HypothesisTestMethodId::Friedman);
            let mut degrees = vec![result.numerator_degrees_of_freedom];
            if let Some(value) = result.denominator_degrees_of_freedom { degrees.push(value); }
            Ok((method_result(
                method, if is_friedman { "Q" } else { "F" }, result.statistic, degrees, result.p_value,
                if is_friedman { "conditionMeanRanks" } else { "blockAdjustedConditionMeans" },
                None, None, None, if is_friedman { "kendallsW" } else { "generalizedEtaSquared" },
                result.effect_size, if is_friedman { "friedman-v1" } else { "randomized-block-anova-v1" }, definition,
            )?, if is_friedman { "asymptotic" } else { "parametric" }.into(),
                if is_friedman { vec!["withinBlockTieCorrection".into()] } else { vec![] }, vec![]))
        }
        _ => Err(AppError::InvalidParam("method and normalized study are incompatible".into())),
    }
}

#[allow(clippy::too_many_arguments)]
fn method_result(
    method_id: HypothesisTestMethodId,
    statistic_name: &str,
    statistic: f64,
    degrees_of_freedom: Vec<f64>,
    p_value: f64,
    estimand: &str,
    estimate: Option<f64>,
    lower: Option<f64>,
    upper: Option<f64>,
    effect_kind: &str,
    effect: f64,
    formula_version: &str,
    definition: &HypothesisTestDefinition,
) -> Result<HypothesisTestMethodResult, AppError> {
    if !statistic.is_finite() || !p_value.is_finite() || !effect.is_finite()
        || degrees_of_freedom.iter().any(|value| !value.is_finite())
    {
        return Err(AppError::Stats("non-finite hypothesis-test result".into()));
    }
    let direction_value = estimate.unwrap_or(effect);
    Ok(HypothesisTestMethodResult {
        state: "computed".into(),
        method_id,
        statistic_name: statistic_name.into(),
        statistic,
        degrees_of_freedom,
        p_value: p_value.clamp(0.0, 1.0),
        direction: direction(direction_value).into(),
        conclusion: if p_value <= definition.alpha { "difference" } else { "insufficientEvidence" }.into(),
        estimate: HypothesisTestEstimate {
            estimand: estimand.into(),
            estimate: finite_value(estimate, "omnibusEstimateNotScalar"),
            lower: finite_value(lower, "intervalUnavailable"),
            upper: finite_value(upper, "intervalUnavailable"),
            confidence_level: definition.confidence_level,
            simultaneous: false,
        },
        effect_size: HypothesisTestEffectSize {
            kind: effect_kind.into(),
            estimate: available(effect),
            formula_version: formula_version.into(),
        },
        formula_version: formula_version.into(),
    })
}

fn rank_method_result(
    method: HypothesisTestMethodId,
    statistic_name: &str,
    estimand: &str,
    result: crate::engine::hypothesis_test::methods::rank::RankTestResult,
    definition: &HypothesisTestDefinition,
) -> Result<(HypothesisTestMethodResult, String, Vec<String>, Vec<String>), AppError> {
    let inference_path = match result.inference_path { InferencePath::Exact => "exact", InferencePath::Asymptotic => "asymptotic" };
    let warnings = result.warnings.iter().map(|warning| match warning {
        RankWarning::ExactUnavailableWithTies => "EXACT_UNAVAILABLE_WITH_TIES",
        RankWarning::ExactUnavailableWithZeros => "EXACT_UNAVAILABLE_WITH_ZEROS",
        RankWarning::ExactBudgetExceeded => "EXACT_BUDGET_EXCEEDED",
    }.to_owned()).collect::<Vec<_>>();
    let corrections = if matches!(result.inference_path, InferencePath::Asymptotic) {
        vec!["continuityCorrection".into(), "tieCorrection".into()]
    } else { vec![] };
    Ok((method_result(
        method, statistic_name, result.statistic, vec![], result.p_value,
        estimand, None, None, None, "rankBiserial", result.effect_size,
        "rank-test-v1", definition,
    )?, inference_path.into(), corrections, warnings))
}

fn run_post_hoc(
    study: &NormalizedStudy,
    method: &HypothesisTestMethodId,
    definition: &HypothesisTestDefinition,
) -> Result<Option<PostHocResult>, AppError> {
    match (method, study) {
        (HypothesisTestMethodId::OneWayAnova, NormalizedStudy::IndependentMulti(groups)) =>
            tukey_kramer(groups, definition.alpha, definition.confidence_level).map(Some),
        (HypothesisTestMethodId::WelchAnova, NormalizedStudy::IndependentMulti(groups)) =>
            games_howell(groups, definition.alpha, definition.confidence_level).map(Some),
        (HypothesisTestMethodId::KruskalWallis, NormalizedStudy::IndependentMulti(groups)) =>
            dunn_holm(groups, definition.alpha).map(Some),
        (HypothesisTestMethodId::RandomizedBlockAnova, NormalizedStudy::CompleteBlock(blocks)) =>
            paired_t_holm(blocks, definition.alpha, definition.confidence_level).map(Some),
        (HypothesisTestMethodId::Friedman, NormalizedStudy::CompleteBlock(blocks)) =>
            paired_wilcoxon_holm(blocks, definition.alpha).map(Some),
        _ => Ok(None),
    }
}

fn to_post_hoc_result(result: PostHocResult) -> Result<HypothesisTestPostHocResult, AppError> {
    let adjustment = match result.family.as_str() {
        "tukeyKramer" | "gamesHowell" => "studentizedRange",
        _ => "holm",
    }.to_owned();
    let comparisons = result.comparisons.into_iter().map(|item| {
        if !item.estimate.is_finite() || !item.raw_p_value.is_finite() || !item.adjusted_p_value.is_finite() {
            return Err(AppError::Stats("non-finite post-hoc result".into()));
        }
        Ok(HypothesisTestPostHocComparison {
            left: item.left,
            right: item.right,
            estimate: available(item.estimate),
            raw_p_value: item.raw_p_value,
            adjusted_p_value: item.adjusted_p_value,
            adjustment: adjustment.clone(),
            lower: finite_value(item.lower, "intervalNotSimultaneous"),
            upper: finite_value(item.upper, "intervalNotSimultaneous"),
        })
    }).collect::<Result<Vec<_>, _>>()?;
    Ok(HypothesisTestPostHocResult {
        state: "computed".into(),
        family: result.family,
        comparisons,
        compact_letters: result.compact_letters.into_iter().collect(),
    })
}

fn robustness(
    primary: &HypothesisTestMethodResult,
    sensitivity: &HypothesisTestMethodResult,
    alpha: f64,
) -> String {
    if primary.direction != sensitivity.direction {
        "substantivelyConflicting"
    } else if (primary.p_value <= alpha) != (sensitivity.p_value <= alpha) {
        "statisticallySensitive"
    } else {
        "stable"
    }.into()
}

fn all_methods() -> Vec<HypothesisTestMethodId> {
    vec![
        HypothesisTestMethodId::StudentTwoSampleT,
        HypothesisTestMethodId::WelchTwoSampleT,
        HypothesisTestMethodId::MannWhitneyU,
        HypothesisTestMethodId::OneWayAnova,
        HypothesisTestMethodId::WelchAnova,
        HypothesisTestMethodId::KruskalWallis,
        HypothesisTestMethodId::PairedT,
        HypothesisTestMethodId::WilcoxonSignedRank,
        HypothesisTestMethodId::RandomizedBlockAnova,
        HypothesisTestMethodId::Friedman,
    ]
}

fn reason_code(reason: CompatibilityReason) -> &'static str {
    match reason {
        CompatibilityReason::RequiresIndependentTwo => "REQUIRES_INDEPENDENT_TWO",
        CompatibilityReason::RequiresPairedTwo => "REQUIRES_PAIRED_TWO",
        CompatibilityReason::RequiresIndependentMulti => "REQUIRES_INDEPENDENT_MULTI",
        CompatibilityReason::RequiresCompleteBlock => "REQUIRES_COMPLETE_BLOCK",
        CompatibilityReason::InsufficientObservations => "INSUFFICIENT_OBSERVATIONS",
        CompatibilityReason::ZeroVariance => "ZERO_VARIANCE",
        CompatibilityReason::AllRanksTied => "ALL_RANKS_TIED",
        CompatibilityReason::OneSidedOmnibusUnsupported => "ONE_SIDED_OMNIBUS_UNSUPPORTED",
    }
}

fn direction(value: f64) -> &'static str {
    if value > 0.0 { "positive" } else if value < 0.0 { "negative" } else { "none" }
}

fn available(value: f64) -> HypothesisTestValue {
    HypothesisTestValue::Available { value }
}

fn unavailable(reason: &str) -> HypothesisTestValue {
    HypothesisTestValue::Unavailable { reason: reason.into() }
}

fn finite_value(value: Option<f64>, reason: &str) -> HypothesisTestValue {
    value.filter(|value| value.is_finite()).map(available).unwrap_or_else(|| unavailable(reason))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::hypothesis_test::normalize::{ConditionValues, IndependentGroups};
    use crate::models::hypothesis_test::{
        HypothesisTestAlternative, HypothesisTestFieldRef, HypothesisTestManualSelection,
        HypothesisTestMethodId, HypothesisTestRoles, HypothesisTestSelectionMode,
        HypothesisTestStudyDesign,
    };

    #[test]
    fn automatic_two_group_execution_returns_selected_primary_result() {
        let study = NormalizedStudy::IndependentTwo(IndependentGroups { groups: vec![
            group("A", 0.0),
            group("B", 4.0),
        ] });
        let result = run_hypothesis_test(study, &definition()).expect("computation");
        assert_eq!(result.selection_decision.executed_method, HypothesisTestMethodId::StudentTwoSampleT);
        assert_eq!(result.primary_result.method_id, HypothesisTestMethodId::StudentTwoSampleT);
        assert!(result.primary_result.p_value < 0.05);
        assert!(result.post_hoc_result.is_none());
        assert_eq!(result.compatibility.len(), 10);
    }

    #[test]
    fn significant_automatic_anova_dispatches_tukey_kramer() {
        let study = NormalizedStudy::IndependentMulti(IndependentGroups { groups: vec![
            group("A", 0.0),
            group("B", 0.2),
            group("C", 8.0),
        ] });
        let result = run_hypothesis_test(study, &definition()).expect("computation");
        assert_eq!(result.primary_result.method_id, HypothesisTestMethodId::OneWayAnova);
        assert_eq!(result.post_hoc_result.expect("post-hoc").family, "tukeyKramer");
    }

    #[test]
    fn incompatible_manual_method_fails_before_dispatch() {
        let study = NormalizedStudy::IndependentTwo(IndependentGroups { groups: vec![
            group("A", 0.0),
            group("B", 2.0),
        ] });
        let mut definition = definition();
        definition.selection_mode = HypothesisTestSelectionMode::Manual;
        definition.manual_selection = Some(HypothesisTestManualSelection {
            method_id: HypothesisTestMethodId::PairedT,
            reason: None,
        });
        assert!(matches!(
            run_hypothesis_test(study, &definition),
            Err(AppError::InvalidParam(message)) if message.contains("incompatible")
        ));
    }

    fn group(condition: &str, offset: f64) -> ConditionValues {
        ConditionValues {
            condition: condition.into(),
            values: vec![0.0, 1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0]
                .into_iter().map(|value| value + offset).collect(),
        }
    }

    fn definition() -> HypothesisTestDefinition {
        HypothesisTestDefinition {
            kind: "hypothesisTest".into(),
            roles: HypothesisTestRoles::Wide {
                measurements: vec![
                    HypothesisTestFieldRef { name: "A".into(), field_type: "continuous".into() },
                    HypothesisTestFieldRef { name: "B".into(), field_type: "continuous".into() },
                ],
                subject: None,
            },
            study_design: HypothesisTestStudyDesign::Independent,
            selection_mode: HypothesisTestSelectionMode::Automatic,
            manual_selection: None,
            alternative: HypothesisTestAlternative::TwoSided,
            alpha: 0.05,
            confidence_level: 0.95,
            level_order: vec![],
            reference_level: None,
            post_hoc: "automatic".into(),
            selector_version: "1".into(),
        }
    }
}