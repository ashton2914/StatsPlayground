use std::collections::BTreeMap;

use crate::engine::duckdb_engine::{DuckDbEngine, ValuedColumn};
use crate::engine::fit_model::matrix::{MatrixError, ModelMatrixSpec};
use crate::engine::fit_model::ols::{
    fit_linear_model_with_diagnostics, FitModelData, FitModelEngineError,
};
use crate::engine::fit_model::terms::{resolve_terms, TermError};
use crate::error::AppError;
use crate::models::fit_model::{
    FitModelRequest, FitModelResult, FitModelRowDiagnostic, FitModelSavedColumn,
    FitModelSavedMetric, SaveFitModelColumnsRequest, SaveFitModelColumnsResult,
};
use crate::state::AppState;

pub struct FitModelService<'a> {
    state: &'a AppState,
}

impl<'a> FitModelService<'a> {
    pub fn new(state: &'a AppState) -> Self {
        Self { state }
    }

    pub fn run(&self, request: FitModelRequest) -> Result<FitModelResult, AppError> {
        validate_confidence_level(request.confidence_level)?;
        let db = self
            .state
            .db
            .lock()
            .map_err(|error| AppError::Database(error.to_string()))?;
        let fit_input = prepare_fit_input(
            &db,
            &request.dataset_id,
            request.generation,
            &request.response_column,
            &request.terms,
            request.centering_method,
        )?;
        fit_linear_model_with_diagnostics(fit_input, request.confidence_level)
            .map(|computation| computation.result)
            .map_err(map_engine_error)
    }

    pub fn save_columns(
        &self,
        request: SaveFitModelColumnsRequest,
    ) -> Result<SaveFitModelColumnsResult, AppError> {
        validate_confidence_level(request.confidence_level)?;
        if request.metrics.is_empty() {
            return Err(AppError::InvalidParam(
                "at least one Fit Model metric must be selected".into(),
            ));
        }
        let mut unique_metrics = std::collections::HashSet::new();
        if request
            .metrics
            .iter()
            .any(|metric| !unique_metrics.insert(metric.clone()))
        {
            return Err(AppError::InvalidParam(
                "Fit Model save metrics must be unique".into(),
            ));
        }
        let prefix = clean_model_name(&request.model_name)?;

        let db = self
            .state
            .db
            .lock()
            .map_err(|error| AppError::Database(error.to_string()))?;
        let fit_input = prepare_fit_input(
            &db,
            &request.dataset_id,
            request.expected_generation,
            &request.response_column,
            &request.terms,
            request.centering_method,
        )?;
        let computation = fit_linear_model_with_diagnostics(fit_input, request.confidence_level)
            .map_err(map_engine_error)?;
        if !matches!(computation.result, FitModelResult::Fitted(_)) {
            return Err(AppError::InvalidParam(
                "Fit Model diagnostic columns require a computable fit".into(),
            ));
        }

        let requested_names = request
            .metrics
            .iter()
            .map(|metric| format!("{prefix} {}", metric_label(metric)))
            .collect::<Vec<_>>();
        let resolved_names = db.resolve_valued_column_names(&request.dataset_id, &requested_names)?;
        let columns = request
            .metrics
            .iter()
            .zip(&requested_names)
            .map(|(metric, name)| {
                let values = computation
                    .diagnostic_rows
                    .iter()
                    .map(|row| {
                        metric_value(row, metric).map(|value| (row.row_index, Some(value)))
                    })
                    .collect::<Option<Vec<_>>>()
                    .ok_or_else(|| {
                        AppError::InvalidParam(format!(
                            "Fit Model metric is not estimable: {}",
                            metric_label(metric)
                        ))
                    })?;
                Ok(ValuedColumn {
                    name: name.clone(),
                    column_type: "DOUBLE".into(),
                    values,
                })
            })
            .collect::<Result<Vec<_>, AppError>>()?;
        let (change_set_id, generation) = db.add_valued_columns_with_change_set(
            &request.dataset_id,
            &columns,
            request.expected_generation,
        )?;
        Ok(SaveFitModelColumnsResult {
            change_set_id,
            generation,
            columns: request
                .metrics
                .into_iter()
                .zip(resolved_names)
                .map(|(metric, column_name)| FitModelSavedColumn {
                    metric,
                    column_name,
                })
                .collect(),
        })
    }
}

fn prepare_fit_input(
    db: &DuckDbEngine,
    dataset_id: &str,
    generation: u64,
    response_column: &str,
    requested_terms: &[crate::models::fit_model::FitModelTerm],
    centering_method: crate::models::fit_model::FitModelCenteringMethod,
) -> Result<FitModelData, AppError> {
    let terms = resolve_terms(requested_terms).map_err(map_term_error)?;
    let predictor_names = required_column_names(&terms);
    let rows = db.read_fit_model_rows(
        dataset_id,
        generation,
        response_column,
        &predictor_names,
    )?;
    let mut columns = BTreeMap::new();
    for (index, name) in rows.predictor_names.iter().enumerate() {
        columns.insert(
            name.clone(),
            rows.used_rows
                .iter()
                .map(|row| row.predictors[index])
                .collect(),
        );
    }
    let model_matrix_spec = ModelMatrixSpec::from_columns(terms, centering_method, &columns)
        .map_err(map_matrix_error)?;
    let design_matrix = model_matrix_spec
        .transform_training_columns(&columns)
        .map_err(map_matrix_error)?;
    Ok(FitModelData {
        response_column: response_column.to_string(),
        predictor_columns: rows.predictor_names,
        predictor_ranges: predictor_ranges(&columns)?,
        predictor_rows: rows
            .used_rows
            .iter()
            .map(|row| row.predictors.clone())
            .collect(),
        model_matrix_spec,
        design_matrix,
        response_values: rows.used_rows.iter().map(|row| row.response).collect(),
        row_indexes: rows.used_rows.iter().map(|row| row.row_index).collect(),
        excluded_rows: rows.excluded_rows,
    })
}

fn clean_model_name(model_name: &str) -> Result<String, AppError> {
    let name = model_name.split_whitespace().collect::<Vec<_>>().join(" ");
    if name.is_empty() || name.chars().any(char::is_control) {
        return Err(AppError::InvalidParam(
            "Fit Model name must contain visible characters".into(),
        ));
    }
    Ok(name)
}

fn metric_label(metric: &FitModelSavedMetric) -> &'static str {
    match metric {
        FitModelSavedMetric::Predicted => "Predicted",
        FitModelSavedMetric::Residual => "Residual",
        FitModelSavedMetric::StudentizedResidual => "Studentized Residual",
        FitModelSavedMetric::Leverage => "Leverage",
        FitModelSavedMetric::CooksDistance => "Cook's D",
        FitModelSavedMetric::MeanConfidenceLower => "Mean CI Lower",
        FitModelSavedMetric::MeanConfidenceUpper => "Mean CI Upper",
        FitModelSavedMetric::PredictionLower => "Prediction Lower",
        FitModelSavedMetric::PredictionUpper => "Prediction Upper",
    }
}

fn metric_value(row: &FitModelRowDiagnostic, metric: &FitModelSavedMetric) -> Option<f64> {
    match metric {
        FitModelSavedMetric::Predicted => Some(row.fitted),
        FitModelSavedMetric::Residual => Some(row.residual),
        FitModelSavedMetric::StudentizedResidual => row.studentized_residual,
        FitModelSavedMetric::Leverage => row.leverage,
        FitModelSavedMetric::CooksDistance => row.cooks_distance,
        FitModelSavedMetric::MeanConfidenceLower => row.mean_confidence_lower,
        FitModelSavedMetric::MeanConfidenceUpper => row.mean_confidence_upper,
        FitModelSavedMetric::PredictionLower => row.prediction_lower,
        FitModelSavedMetric::PredictionUpper => row.prediction_upper,
    }
}

fn predictor_ranges(
    columns: &BTreeMap<String, Vec<f64>>,
) -> Result<Vec<crate::models::fit_model::FitModelPredictorRange>, AppError> {
    let mut ranges = Vec::with_capacity(columns.len());
    for (column_name, values) in columns {
        if values.is_empty() || values.iter().any(|value| !value.is_finite()) {
            return Err(AppError::Stats(format!(
                "fit model predictor range is unavailable for {column_name}"
            )));
        }
        let minimum = values.iter().copied().fold(f64::INFINITY, f64::min);
        let maximum = values.iter().copied().fold(f64::NEG_INFINITY, f64::max);
        let mean = values.iter().enumerate().fold(0.0, |mean, (index, value)| {
            let count = (index + 1) as f64;
            mean * ((count - 1.0) / count) + value / count
        });
        if !minimum.is_finite() || !maximum.is_finite() || !mean.is_finite() {
            return Err(AppError::Stats(format!(
                "fit model predictor range is non-finite for {column_name}"
            )));
        }
        ranges.push(crate::models::fit_model::FitModelPredictorRange {
            column_name: column_name.clone(),
            minimum,
            maximum,
            mean,
        });
    }
    Ok(ranges)
}

fn validate_confidence_level(confidence_level: f64) -> Result<(), AppError> {
    if confidence_level != 0.95 {
        return Err(AppError::InvalidParam(
            "Fit Model confidence level must be 0.95".into(),
        ));
    }
    Ok(())
}

fn required_column_names(terms: &[crate::engine::fit_model::ResolvedTerm]) -> Vec<String> {
    let mut names = Vec::new();
    for term in terms {
        for name in term.column_names() {
            if !names.contains(name) {
                names.push(name.clone());
            }
        }
    }
    names
}

fn map_term_error(error: TermError) -> AppError {
    match error {
        TermError::EmptyColumnName => {
            AppError::InvalidParam("fit model term contains an empty column name".into())
        }
        TermError::TooManyTerms { actual, maximum } => AppError::InvalidParam(format!(
            "fit model contains {actual} terms; maximum is {maximum}"
        )),
        TermError::InvalidArity {
            kind,
            expected,
            actual,
        } => AppError::InvalidParam(format!(
            "fit model term {:?} requires {} columns but received {}",
            kind, expected, actual
        )),
        TermError::InteractionRequiresAtLeastTwoColumns(actual) => AppError::InvalidParam(format!(
            "fit model interaction requires at least 2 columns but received {actual}"
        )),
        TermError::InvalidExponent { kind, exponent } => AppError::InvalidParam(format!(
            "fit model term {:?} has invalid exponent {:?}; only power exponent 2 is supported",
            kind, exponent
        )),
        TermError::DuplicateTerm(term_id) => {
            AppError::InvalidParam(format!("fit model term is duplicated: {term_id}"))
        }
        TermError::MissingMainEffect(column) => AppError::InvalidParam(format!(
            "fit model interaction requires missing main effect column: {column}"
        )),
        TermError::PowerRequiresMainEffect(column) => AppError::InvalidParam(format!(
            "fit model power requires missing main effect column: {column}"
        )),
        TermError::InteractionRequiresDistinctColumns(column) => AppError::InvalidParam(format!(
            "fit model interaction requires distinct columns: {column}"
        )),
    }
}

fn map_matrix_error(error: MatrixError) -> AppError {
    match error {
        MatrixError::MissingColumn(column) => {
            AppError::InvalidParam(format!("fit model is missing required column: {column}"))
        }
        MatrixError::ColumnLengthMismatch {
            column,
            expected,
            actual,
        } => AppError::Stats(format!(
            "fit model column length mismatch for {column}: expected {expected}, got {actual}"
        )),
        MatrixError::EmptyTrainingData => {
            AppError::InvalidParam("fit model has no usable rows after filtering".into())
        }
        MatrixError::MissingCenter(column) => {
            AppError::Stats(format!("fit model missing centering mean for {column}"))
        }
        MatrixError::InvalidResolvedTerm(term_id) => {
            AppError::Stats(format!("fit model resolved term is invalid: {term_id}"))
        }
    }
}

fn map_engine_error(error: FitModelEngineError) -> AppError {
    match error {
        FitModelEngineError::InvalidInput(message) => AppError::InvalidParam(message),
        FitModelEngineError::InvalidConfidenceLevel(value) => AppError::InvalidParam(format!(
            "confidence level must be finite and strictly inside (0, 1); received {value}"
        )),
        FitModelEngineError::NumericalFailure(message) => AppError::Stats(message),
        FitModelEngineError::SolveFailure => {
            AppError::Stats("fit model failed to solve linear system".into())
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use crate::error::AppError;
    use crate::models::fit_model::{
        FitModelCenteringMethod, FitModelRequest, FitModelResult, FitModelSavedMetric,
        FitModelTerm, FitModelTermKind, SaveFitModelColumnsRequest,
    };
    use crate::state::AppState;

    use super::{predictor_ranges, validate_confidence_level, FitModelService};

    fn seed_dataset(state: &AppState, dataset_id: &str) {
        let db = state.db.lock().expect("test db lock");
        db.create_empty_table(
            dataset_id,
            dataset_id,
            &["Y".into(), "A".into(), "B".into()],
            &["DOUBLE".into(), "DOUBLE".into(), "DOUBLE".into()],
        )
        .expect("seed metadata");
        db.conn()
            .execute_batch(&format!(
                r#"
                INSERT INTO "dataset_{}" (_row_id, Y, A, B) VALUES
                    (1, 10.0, 1.0, 1.0),
                    (2, 20.0, 2.0, 4.0),
                    (3, 30.0, 4.0, 2.0);
                "#,
                dataset_id.replace('-', "_")
            ))
            .expect("seed rows");
        db.conn()
            .execute(
                "UPDATE _meta_datasets SET row_count = 3 WHERE id = $1",
                duckdb::params![dataset_id],
            )
            .expect("row count");
    }

    fn request(dataset_id: &str, generation: u64, confidence_level: f64) -> FitModelRequest {
        FitModelRequest {
            dataset_id: dataset_id.into(),
            generation,
            response_column: "Y".into(),
            terms: vec![
                FitModelTerm {
                    kind: FitModelTermKind::Main,
                    column_names: vec!["A".into()],
                    exponent: None,
                },
                FitModelTerm {
                    kind: FitModelTermKind::Main,
                    column_names: vec!["B".into()],
                    exponent: None,
                },
            ],
            centering_method: FitModelCenteringMethod::None,
            confidence_level,
        }
    }

    #[test]
    fn rejects_confidence_level_outside_open_unit_interval() {
        let state = AppState::new().expect("state");
        seed_dataset(&state, "fit-model-confidence");
        let service = FitModelService::new(&state);

        let error = service
            .run(request("fit-model-confidence", 0, 1.0))
            .expect_err("confidence level must fail");
        assert!(matches!(error, AppError::InvalidParam(message) if message.contains("confidence")));
    }

    #[test]
    fn rejects_confidence_level_other_than_frozen_default() {
        assert!(validate_confidence_level(0.95).is_ok());
        assert!(validate_confidence_level(0.90).is_err());
    }

    #[test]
    fn predictor_range_mean_does_not_overflow_for_finite_values() {
        let ranges = predictor_ranges(&BTreeMap::from([(
            "A".to_string(),
            vec![f64::MAX, f64::MAX],
        )]))
        .expect("finite predictor range should remain representable");

        assert_eq!(ranges[0].mean, f64::MAX);
    }

    #[test]
    fn maps_term_resolution_errors_to_invalid_param() {
        let state = AppState::new().expect("state");
        seed_dataset(&state, "fit-model-terms");
        let service = FitModelService::new(&state);
        let mut req = request("fit-model-terms", 0, 0.95);
        req.terms.push(FitModelTerm {
            kind: FitModelTermKind::Interaction,
            column_names: vec!["A".into(), "A".into()],
            exponent: None,
        });

        let error = service.run(req).expect_err("invalid terms must fail");
        assert!(
            matches!(error, AppError::InvalidParam(message) if message.contains("interaction") || message.contains("term"))
        );
    }

    #[test]
    fn rejects_stale_generation() {
        let state = AppState::new().expect("state");
        seed_dataset(&state, "fit-model-stale");
        {
            let db = state.db.lock().expect("lock");
            db.conn()
                .execute(
                    "UPDATE _meta_datasets SET generation = 1 WHERE id = $1",
                    duckdb::params!["fit-model-stale"],
                )
                .expect("set generation");
        }

        let error = FitModelService::new(&state)
            .run(request("fit-model-stale", 0, 0.95))
            .expect_err("stale generation must fail");
        assert!(matches!(error, AppError::InvalidParam(message) if message.contains("generation")));
    }

    #[test]
    fn runs_fit_model_successfully_for_valid_request() {
        let state = AppState::new().expect("state");
        seed_dataset(&state, "fit-model-success");

        let result = FitModelService::new(&state)
            .run(request("fit-model-success", 0, 0.95))
            .expect("expected successful fit model run");

        assert!(matches!(result, FitModelResult::Fitted(_)));
    }

    #[test]
    fn save_columns_writes_complete_cases_and_leaves_excluded_rows_null() {
        let state = AppState::new().expect("state");
        seed_dataset(&state, "fit-model-save-columns");
        {
            let db = state.db.lock().expect("lock");
            db.conn()
                .execute_batch(
                    r#"INSERT INTO "dataset_fit_model_save_columns" (_row_id, Y, A, B)
                       VALUES (4, 40.0, NULL, 8.0);
                       UPDATE _meta_datasets SET row_count = 4
                       WHERE id = 'fit-model-save-columns';"#,
                )
                .expect("excluded row");
        }

        let fit_request = request("fit-model-save-columns", 0, 0.95);
        let result = FitModelService::new(&state)
            .save_columns(SaveFitModelColumnsRequest {
                dataset_id: fit_request.dataset_id,
                expected_generation: fit_request.generation,
                model_name: "Response Surface".into(),
                response_column: fit_request.response_column,
                terms: fit_request.terms,
                centering_method: fit_request.centering_method,
                confidence_level: fit_request.confidence_level,
                metrics: vec![
                    FitModelSavedMetric::Predicted,
                    FitModelSavedMetric::Residual,
                ],
            })
            .expect("save columns");

        assert_eq!(result.generation, 1);
        assert!(!result.change_set_id.is_empty());
        assert_eq!(result.columns[0].column_name, "Response Surface Predicted");
        assert_eq!(result.columns[1].column_name, "Response Surface Residual");
        let db = state.db.lock().expect("lock");
        let values = db
            .conn()
            .prepare(
                r#"SELECT "Response Surface Predicted", "Response Surface Residual"
                   FROM "dataset_fit_model_save_columns" ORDER BY _row_id"#,
            )
            .expect("prepare")
            .query_map([], |row| {
                Ok((row.get::<_, Option<f64>>(0)?, row.get::<_, Option<f64>>(1)?))
            })
            .expect("query")
            .collect::<Result<Vec<_>, _>>()
            .expect("values");
        assert_eq!(values.len(), 4);
        assert!(values[..3]
            .iter()
            .all(|(predicted, residual)| predicted.is_some() && residual.is_some()));
        assert_eq!(values[3], (None, None));
        assert_eq!(db.get_dataset_generation("fit-model-save-columns").unwrap(), 1);
    }

    #[test]
    fn save_columns_rejects_invalid_metric_sets_without_mutation() {
        let state = AppState::new().expect("state");
        seed_dataset(&state, "fit-model-save-invalid");
        let fit_request = request("fit-model-save-invalid", 0, 0.95);
        let make_request = |metrics| SaveFitModelColumnsRequest {
            dataset_id: fit_request.dataset_id.clone(),
            expected_generation: 0,
            model_name: "Invalid Save".into(),
            response_column: fit_request.response_column.clone(),
            terms: fit_request.terms.clone(),
            centering_method: fit_request.centering_method.clone(),
            confidence_level: 0.95,
            metrics,
        };
        let service = FitModelService::new(&state);

        assert!(matches!(
            service.save_columns(make_request(vec![])),
            Err(AppError::InvalidParam(_))
        ));
        assert!(matches!(
            service.save_columns(make_request(vec![
                FitModelSavedMetric::Residual,
                FitModelSavedMetric::Residual,
            ])),
            Err(AppError::InvalidParam(_))
        ));
        assert!(matches!(
            service.save_columns(make_request(vec![FitModelSavedMetric::PredictionUpper])),
            Err(AppError::InvalidParam(message)) if message.contains("not estimable")
        ));

        let db = state.db.lock().expect("lock");
        assert_eq!(db.get_dataset_generation("fit-model-save-invalid").unwrap(), 0);
        let saved_columns: i64 = db
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM _meta_columns WHERE dataset_id = ? AND col_name LIKE 'Invalid Save%'",
                duckdb::params!["fit-model-save-invalid"],
                |row| row.get(0),
            )
            .expect("column count");
        assert_eq!(saved_columns, 0);
    }
}
