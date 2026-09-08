use crate::engine::hypothesis_test::compatibility::{
    evaluate_method_compatibility, CompatibilityState,
};
use crate::engine::hypothesis_test::diagnostics::DiagnosticSummary;
use crate::engine::hypothesis_test::normalize::NormalizedStudy;
use crate::error::AppError;
use crate::models::hypothesis_test::{
    HypothesisTestDefinition, HypothesisTestMethodId, HypothesisTestSelectionMode,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SelectorCertainty {
    High,
    Medium,
    Low,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecutionPlan {
    pub recommended_method: HypothesisTestMethodId,
    pub executed_method: HypothesisTestMethodId,
    pub sensitivity_methods: Vec<HypothesisTestMethodId>,
    pub certainty: SelectorCertainty,
    pub reason_codes: Vec<&'static str>,
    pub overridden: bool,
}

pub fn select_execution_plan(
    study: &NormalizedStudy,
    diagnostics: &DiagnosticSummary,
    definition: &HypothesisTestDefinition,
) -> Result<ExecutionPlan, AppError> {
    if definition.selector_version != "1" {
        return Err(AppError::InvalidParam("unsupported hypothesis-test selector version".into()));
    }
    let recommended_method = recommended_method(study, diagnostics);
    ensure_compatible(study, &recommended_method, definition)?;
    let manual_method = match definition.selection_mode {
        HypothesisTestSelectionMode::Manual => Some(
            definition.manual_selection.as_ref()
                .ok_or_else(|| AppError::InvalidParam("manual mode requires a method".into()))?
                .method_id.clone(),
        ),
        HypothesisTestSelectionMode::Guided => {
            definition.manual_selection.as_ref().map(|selection| selection.method_id.clone())
        }
        HypothesisTestSelectionMode::Automatic => None,
    };
    if let Some(method) = &manual_method {
        ensure_compatible(study, method, definition)?;
    }
    let executed_method = manual_method.unwrap_or_else(|| recommended_method.clone());
    let overridden = executed_method != recommended_method;
    let certainty = if diagnostics.paired_asymmetry {
        SelectorCertainty::Low
    } else if diagnostics.limited_power || diagnostics.block_assumption_warning {
        SelectorCertainty::Medium
    } else {
        SelectorCertainty::High
    };
    let mut reason_codes = Vec::new();
    if diagnostics.severe_shape_or_influence {
        reason_codes.push("SEVERE_SHAPE_OR_INFLUENCE");
    }
    if diagnostics.heteroscedasticity_material {
        reason_codes.push("MATERIAL_HETEROSCEDASTICITY");
    }
    if diagnostics.limited_power {
        reason_codes.push("DIAGNOSTIC_POWER_LIMITED");
    }
    if diagnostics.paired_asymmetry {
        reason_codes.push("PAIRED_ASYMMETRY_CAVEAT");
    }
    if diagnostics.block_assumption_warning {
        reason_codes.push("BLOCK_COVARIANCE_NOT_ESTABLISHED");
    }
    if overridden {
        reason_codes.push("COMPATIBLE_MANUAL_OVERRIDE");
    }
    let mut sensitivity_methods = Vec::new();
    if overridden {
        sensitivity_methods.push(recommended_method.clone());
    }
    if !matches!(certainty, SelectorCertainty::High) {
        sensitivity_methods.push(counterpart(&executed_method, diagnostics));
    }
    sensitivity_methods.retain(|method| method != &executed_method);
    sensitivity_methods.dedup();
    Ok(ExecutionPlan {
        recommended_method,
        executed_method,
        sensitivity_methods,
        certainty,
        reason_codes,
        overridden,
    })
}

fn recommended_method(
    study: &NormalizedStudy,
    diagnostics: &DiagnosticSummary,
) -> HypothesisTestMethodId {
    match study {
        NormalizedStudy::IndependentTwo(_) if diagnostics.severe_shape_or_influence => {
            HypothesisTestMethodId::MannWhitneyU
        }
        NormalizedStudy::IndependentTwo(_) if diagnostics.heteroscedasticity_material => {
            HypothesisTestMethodId::WelchTwoSampleT
        }
        NormalizedStudy::IndependentTwo(_) => HypothesisTestMethodId::StudentTwoSampleT,
        NormalizedStudy::IndependentMulti(_) if diagnostics.severe_shape_or_influence => {
            HypothesisTestMethodId::KruskalWallis
        }
        NormalizedStudy::IndependentMulti(_) if diagnostics.heteroscedasticity_material => {
            HypothesisTestMethodId::WelchAnova
        }
        NormalizedStudy::IndependentMulti(_) => HypothesisTestMethodId::OneWayAnova,
        NormalizedStudy::PairedTwo(_) if diagnostics.severe_shape_or_influence => {
            HypothesisTestMethodId::WilcoxonSignedRank
        }
        NormalizedStudy::PairedTwo(_) => HypothesisTestMethodId::PairedT,
        NormalizedStudy::CompleteBlock(_) if diagnostics.severe_shape_or_influence => {
            HypothesisTestMethodId::Friedman
        }
        NormalizedStudy::CompleteBlock(_) => HypothesisTestMethodId::RandomizedBlockAnova,
    }
}

fn ensure_compatible(
    study: &NormalizedStudy,
    method: &HypothesisTestMethodId,
    definition: &HypothesisTestDefinition,
) -> Result<(), AppError> {
    let compatibility = evaluate_method_compatibility(
        study,
        method.clone(),
        definition.alternative.clone(),
    );
    if matches!(compatibility.state, CompatibilityState::Compatible) {
        Ok(())
    } else {
        Err(AppError::InvalidParam(format!(
            "selected hypothesis-test method is incompatible: {:?}",
            compatibility.reasons
        )))
    }
}

fn counterpart(
    method: &HypothesisTestMethodId,
    diagnostics: &DiagnosticSummary,
) -> HypothesisTestMethodId {
    match method {
        HypothesisTestMethodId::StudentTwoSampleT | HypothesisTestMethodId::WelchTwoSampleT => {
            HypothesisTestMethodId::MannWhitneyU
        }
        HypothesisTestMethodId::MannWhitneyU if diagnostics.heteroscedasticity_material => {
            HypothesisTestMethodId::WelchTwoSampleT
        }
        HypothesisTestMethodId::MannWhitneyU => HypothesisTestMethodId::StudentTwoSampleT,
        HypothesisTestMethodId::OneWayAnova | HypothesisTestMethodId::WelchAnova => {
            HypothesisTestMethodId::KruskalWallis
        }
        HypothesisTestMethodId::KruskalWallis if diagnostics.heteroscedasticity_material => {
            HypothesisTestMethodId::WelchAnova
        }
        HypothesisTestMethodId::KruskalWallis => HypothesisTestMethodId::OneWayAnova,
        HypothesisTestMethodId::PairedT => HypothesisTestMethodId::WilcoxonSignedRank,
        HypothesisTestMethodId::WilcoxonSignedRank => HypothesisTestMethodId::PairedT,
        HypothesisTestMethodId::RandomizedBlockAnova => HypothesisTestMethodId::Friedman,
        HypothesisTestMethodId::Friedman => HypothesisTestMethodId::RandomizedBlockAnova,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::hypothesis_test::diagnostics::DiagnosticEvidence;
    use crate::engine::hypothesis_test::normalize::{
        CompleteBlocks, ConditionValues, IndependentGroups, PairedDifferences,
    };
    use crate::models::hypothesis_test::{
        HypothesisTestAlternative, HypothesisTestFieldRef, HypothesisTestManualSelection,
        HypothesisTestRoles, HypothesisTestSelectionMode, HypothesisTestStudyDesign,
    };

    #[test]
    fn selector_routes_all_independent_methods_from_shape_then_variance() {
        let two = independent(2);
        let multi = independent(3);
        assert_eq!(selected(&two, diagnostic(false, false)).executed_method, HypothesisTestMethodId::StudentTwoSampleT);
        assert_eq!(selected(&two, diagnostic(false, true)).executed_method, HypothesisTestMethodId::WelchTwoSampleT);
        assert_eq!(selected(&two, diagnostic(true, true)).executed_method, HypothesisTestMethodId::MannWhitneyU);
        assert_eq!(selected(&multi, diagnostic(false, false)).executed_method, HypothesisTestMethodId::OneWayAnova);
        assert_eq!(selected(&multi, diagnostic(false, true)).executed_method, HypothesisTestMethodId::WelchAnova);
        assert_eq!(selected(&multi, diagnostic(true, true)).executed_method, HypothesisTestMethodId::KruskalWallis);
    }

    #[test]
    fn selector_routes_paired_and_complete_block_methods() {
        let paired = NormalizedStudy::PairedTwo(PairedDifferences {
            conditions: ["A".into(), "B".into()],
            subjects: vec!["1".into(), "2".into(), "3".into()],
            pairs: vec![[1.0, 2.0], [2.0, 4.0], [4.0, 5.0]],
        });
        let blocked = NormalizedStudy::CompleteBlock(CompleteBlocks {
            conditions: vec!["A".into(), "B".into(), "C".into()],
            subjects: vec!["1".into(), "2".into(), "3".into()],
            blocks: vec![vec![1.0, 2.0, 4.0], vec![2.0, 4.0, 5.0], vec![4.0, 5.0, 8.0]],
        });
        assert_eq!(selected(&paired, diagnostic(false, false)).executed_method, HypothesisTestMethodId::PairedT);
        assert_eq!(selected(&paired, diagnostic(true, false)).executed_method, HypothesisTestMethodId::WilcoxonSignedRank);
        assert_eq!(selected(&blocked, diagnostic(false, false)).executed_method, HypothesisTestMethodId::RandomizedBlockAnova);
        assert_eq!(selected(&blocked, diagnostic(true, false)).executed_method, HypothesisTestMethodId::Friedman);
    }

    #[test]
    fn compatible_manual_override_preserves_recommendation_and_adds_sensitivity() {
        let study = independent(2);
        let mut definition = definition();
        definition.selection_mode = HypothesisTestSelectionMode::Manual;
        definition.manual_selection = Some(HypothesisTestManualSelection {
            method_id: HypothesisTestMethodId::StudentTwoSampleT,
            reason: Some("planned pooled analysis".into()),
        });
        let plan = select_execution_plan(&study, &diagnostic(false, true), &definition)
            .expect("manual plan");
        assert_eq!(plan.recommended_method, HypothesisTestMethodId::WelchTwoSampleT);
        assert_eq!(plan.executed_method, HypothesisTestMethodId::StudentTwoSampleT);
        assert!(plan.overridden);
        assert!(plan.sensitivity_methods.contains(&HypothesisTestMethodId::WelchTwoSampleT));
    }

    fn selected(study: &NormalizedStudy, diagnostics: DiagnosticSummary) -> ExecutionPlan {
        select_execution_plan(study, &diagnostics, &definition()).expect("selection")
    }

    fn diagnostic(severe: bool, heteroscedastic: bool) -> DiagnosticSummary {
        DiagnosticSummary {
            severe_shape_or_influence: severe,
            heteroscedasticity_material: heteroscedastic,
            limited_power: false,
            paired_asymmetry: false,
            block_assumption_warning: false,
            evidence: Vec::<DiagnosticEvidence>::new(),
        }
    }

    fn independent(count: usize) -> NormalizedStudy {
        let groups = (0..count).map(|index| ConditionValues {
            condition: index.to_string(),
            values: vec![index as f64, index as f64 + 1.0, index as f64 + 3.0],
        }).collect();
        if count == 2 {
            NormalizedStudy::IndependentTwo(IndependentGroups { groups })
        } else {
            NormalizedStudy::IndependentMulti(IndependentGroups { groups })
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