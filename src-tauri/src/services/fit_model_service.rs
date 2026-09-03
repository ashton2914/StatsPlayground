use std::collections::BTreeMap;

use crate::engine::fit_model::matrix::{MatrixError, ModelMatrixSpec};
use crate::engine::fit_model::ols::{fit_linear_model, FitModelData, FitModelEngineError};
use crate::engine::fit_model::terms::{resolve_terms, TermError};
use crate::error::AppError;
use crate::models::fit_model::{FitModelRequest, FitModelResult};
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
        let terms = resolve_terms(&request.terms).map_err(map_term_error)?;
        let predictor_names = required_column_names(&terms);

        let db = self
            .state
            .db
            .lock()
            .map_err(|error| AppError::Database(error.to_string()))?;
        let rows = db.read_fit_model_rows(
            &request.dataset_id,
            request.generation,
            &request.response_column,
            &predictor_names,
        )?;

        let mut columns = BTreeMap::new();
        for (index, name) in rows.predictor_names.iter().enumerate() {
            let values = rows
                .used_rows
                .iter()
                .map(|row| row.predictors[index])
                .collect::<Vec<_>>();
            columns.insert(name.clone(), values);
        }
        let response_values = rows
            .used_rows
            .iter()
            .map(|row| row.response)
            .collect::<Vec<_>>();
        let row_indexes = rows
            .used_rows
            .iter()
            .map(|row| row.row_index)
            .collect::<Vec<_>>();

        let model_matrix_spec =
            ModelMatrixSpec::from_columns(terms, request.centering_method, &columns)
                .map_err(map_matrix_error)?;
        let design_matrix = model_matrix_spec
            .transform_training_columns(&columns)
            .map_err(map_matrix_error)?;
        let fit_input = FitModelData {
            response_column: request.response_column,
            predictor_columns: rows.predictor_names,
            predictor_ranges: predictor_ranges(&columns)?,
            model_matrix_spec,
            design_matrix,
            response_values,
            row_indexes,
            excluded_rows: rows.excluded_rows,
        };

        fit_linear_model(fit_input, request.confidence_level).map_err(map_engine_error)
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
        FitModelCenteringMethod, FitModelRequest, FitModelResult, FitModelTerm, FitModelTermKind,
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
}
