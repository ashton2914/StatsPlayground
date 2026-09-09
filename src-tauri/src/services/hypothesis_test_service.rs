use crate::engine::hypothesis_test::normalize::{
    normalize_hypothesis_test_rows, ExclusionReason, NormalizedHypothesisTest,
};
use crate::engine::hypothesis_test::plot::build_plot_data;
use crate::engine::hypothesis_test::run_hypothesis_test;
use crate::error::AppError;
use crate::models::hypothesis_test::{
    HypothesisTestAudit, HypothesisTestExclusion, HypothesisTestRequest,
    HypothesisTestResponse,
};
use crate::state::AppState;

pub struct HypothesisTestService<'a> {
    state: &'a AppState,
}

impl<'a> HypothesisTestService<'a> {
    pub fn new(state: &'a AppState) -> Self {
        Self { state }
    }

    pub fn prepare(
        &self,
        request: &HypothesisTestRequest,
    ) -> Result<NormalizedHypothesisTest, AppError> {
        validate_probability(request.definition.alpha, "alpha")?;
        validate_probability(request.definition.confidence_level, "confidence level")?;

        let db = self
            .state
            .db
            .lock()
            .map_err(|error| AppError::Database(error.to_string()))?;
        let generation = db.get_dataset_generation(&request.dataset_id)?;
        if generation != request.generation {
            return Err(AppError::InvalidParam(format!(
                "stale dataset generation: expected {generation}, received {}",
                request.generation
            )));
        }
        let rows = db.read_hypothesis_test_rows(&request.dataset_id, &request.definition.roles)?;
        normalize_hypothesis_test_rows(
            rows,
            request.definition.study_design.clone(),
            &request.definition.level_order,
        )
    }

    pub fn run(&self, request: HypothesisTestRequest) -> Result<HypothesisTestResponse, AppError> {
        let normalized = self.prepare(&request)?;
        let retained_observations = normalized.study.retained_observations() as u64;
        let plot_data = build_plot_data(&normalized.study, request.definition.confidence_level)?;
        let computation = run_hypothesis_test(normalized.study, &request.definition)?;
        let exclusions = normalized.exclusions.into_iter().map(|exclusion| {
            HypothesisTestExclusion {
                identity: exclusion.identity,
                reason_code: match exclusion.reason {
                    ExclusionReason::MissingResponse => "MISSING_RESPONSE",
                    ExclusionReason::MissingCondition => "MISSING_CONDITION",
                    ExclusionReason::IncompletePair => "INCOMPLETE_PAIR",
                    ExclusionReason::IncompleteBlock => "INCOMPLETE_BLOCK",
                }.into(),
                condition: exclusion.condition,
            }
        }).collect();
        let executed_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|error| AppError::Stats(error.to_string()))?
            .as_secs()
            .to_string();
        Ok(HypothesisTestResponse {
            analysis_kind: request.analysis_kind,
            analysis_id: request.analysis_id,
            dataset_id: request.dataset_id,
            generation: request.generation,
            config_revision: request.config_revision,
            selector_version: request.definition.selector_version,
            request_fingerprint: request.request_fingerprint,
            retained_observations,
            plot_data,
            exclusions,
            compatibility: computation.compatibility,
            diagnostics: computation.diagnostics,
            selection_decision: computation.selection_decision,
            primary_result: computation.primary_result,
            sensitivity_results: computation.sensitivity_results,
            post_hoc_result: computation.post_hoc_result,
            warnings: computation.warnings,
            method_audit: HypothesisTestAudit {
                selector_version: "1".into(),
                method_version: "1".into(),
                formula_version: "1".into(),
                inference_path: computation.inference_path,
                correction_codes: computation.correction_codes,
                executed_at,
            },
        })
    }
}

fn validate_probability(value: f64, name: &str) -> Result<(), AppError> {
    if value.is_finite() && value > 0.0 && value < 1.0 {
        Ok(())
    } else {
        Err(AppError::InvalidParam(format!(
            "{name} must be finite and strictly inside (0, 1)"
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::hypothesis_test::{
        HypothesisTestAlternative, HypothesisTestDefinition, HypothesisTestFieldRef,
        HypothesisTestRoles, HypothesisTestSelectionMode, HypothesisTestStudyDesign,
    };

    #[test]
    fn rejects_stale_generation_before_reading_rows() {
        let state = AppState::new().expect("state");
        {
            let db = state.db.lock().expect("db lock");
            db.create_empty_table(
                "hypothesis-stale",
                "hypothesis-stale",
                &["A".into(), "B".into()],
                &["DOUBLE".into(), "DOUBLE".into()],
            ).expect("dataset");
        }

        let error = HypothesisTestService::new(&state)
            .prepare(&request("hypothesis-stale", 1))
            .expect_err("stale request must fail");
        assert!(matches!(error, AppError::InvalidParam(message) if message.contains("stale dataset generation")));
    }

    #[test]
    fn prepares_normalized_wide_independent_study() {
        let state = AppState::new().expect("state");
        {
            let db = state.db.lock().expect("db lock");
            db.create_empty_table(
                "hypothesis-wide",
                "hypothesis-wide",
                &["A".into(), "B".into()],
                &["DOUBLE".into(), "DOUBLE".into()],
            ).expect("dataset");
            db.conn().execute_batch(
                r#"INSERT INTO "dataset_hypothesis_wide" (_row_id, A, B) VALUES
                    (1, 1.0, 3.0),
                    (2, 2.0, 4.0);"#,
            ).expect("rows");
        }

        let normalized = HypothesisTestService::new(&state)
            .prepare(&request("hypothesis-wide", 0))
            .expect("prepare study");
        assert_eq!(normalized.study.retained_observations(), 4);
    }

    #[test]
    fn runs_engine_and_preserves_complete_request_identity() {
        let state = AppState::new().expect("state");
        {
            let db = state.db.lock().expect("db lock");
            db.create_empty_table(
                "hypothesis-run",
                "hypothesis-run",
                &["A".into(), "B".into()],
                &["DOUBLE".into(), "DOUBLE".into()],
            ).expect("dataset");
            db.conn().execute_batch(
                r#"INSERT INTO "dataset_hypothesis_run" (_row_id, A, B) VALUES
                    (1, 0.0, 4.0), (2, 1.0, 5.0), (3, 2.0, 6.0), (4, 3.0, 7.0),
                    (5, 4.0, 8.0), (6, 5.0, 9.0), (7, 6.0, 10.0), (8, 7.0, 11.0);"#,
            ).expect("rows");
        }

        let request = request("hypothesis-run", 0);
        let response = HypothesisTestService::new(&state).run(request).expect("response");
        assert_eq!(response.analysis_kind, "hypothesisTest");
        assert_eq!(response.analysis_id, "analysis-1");
        assert_eq!(response.dataset_id, "hypothesis-run");
        assert_eq!(response.request_fingerprint, "fingerprint");
        assert_eq!(response.retained_observations, 16);
        assert_eq!(response.primary_result.method_id, crate::models::hypothesis_test::HypothesisTestMethodId::StudentTwoSampleT);
        assert_eq!(response.plot_data.study_structure, "independent");
        assert_eq!(response.plot_data.conditions, vec!["A", "B"]);
        assert_eq!(response.plot_data.observations.len(), 16);
        assert_eq!(response.plot_data.summaries[0].count, 8);
        assert_eq!(response.plot_data.summaries[0].mean, 3.5);
        assert_eq!(response.plot_data.diagnostic_kind, "groupResiduals");
        assert_eq!(response.plot_data.qq_points.len(), 16);
    }

    fn request(dataset_id: &str, generation: u64) -> HypothesisTestRequest {
        HypothesisTestRequest {
            analysis_kind: "hypothesisTest".into(),
            analysis_id: "analysis-1".into(),
            dataset_id: dataset_id.into(),
            generation,
            config_revision: 1,
            definition: HypothesisTestDefinition {
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
                level_order: vec!["A".into(), "B".into()],
                reference_level: None,
                post_hoc: "automatic".into(),
                selector_version: "1".into(),
            },
            request_fingerprint: "fingerprint".into(),
        }
    }
}