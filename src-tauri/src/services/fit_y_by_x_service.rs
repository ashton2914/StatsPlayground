use crate::engine::fit_y_by_x::{calculate_bivariate, calculate_oneway};
use crate::error::AppError;
use crate::models::fit_y_by_x::{FitYByXPersonality, FitYByXRequest, FitYByXResult, FitYByXRow};
use crate::state::AppState;

pub struct FitYByXService<'a> {
    state: &'a AppState,
}

impl<'a> FitYByXService<'a> {
    pub fn new(state: &'a AppState) -> Self {
        Self { state }
    }

    pub fn run(&self, request: FitYByXRequest) -> Result<FitYByXResult, AppError> {
        if !request.confidence_level.is_finite()
            || request.confidence_level <= 0.0
            || request.confidence_level >= 1.0
        {
            return Err(AppError::InvalidParam(
                "confidence level must be finite and strictly inside (0, 1)".into(),
            ));
        }

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

        let row_data = db.read_fit_y_by_x_rows(
            &request.dataset_id,
            &request.response_column,
            &request.factor_column,
            request.personality.clone(),
        )?;
        let used_rows = row_data.rows.len() as u64;
        let excluded_rows = row_data
            .source_rows
            .checked_sub(used_rows)
            .ok_or_else(|| AppError::Stats("fit y by x row accounting underflowed".into()))?;

        match request.personality {
            FitYByXPersonality::Oneway => Ok(calculate_oneway(
                row_data.rows,
                excluded_rows,
                request.confidence_level,
            )),
            FitYByXPersonality::Bivariate => Ok(calculate_bivariate(
                into_bivariate_rows(row_data.rows)?,
                excluded_rows,
                request.confidence_level,
            )),
        }
    }
}

fn into_bivariate_rows(rows: Vec<FitYByXRow>) -> Result<Vec<(f64, f64)>, AppError> {
    rows.into_iter()
        .map(|row| match row {
            FitYByXRow::Bivariate { x, y } => Ok((x, y)),
            FitYByXRow::Oneway { .. } => Err(AppError::Stats(
                "fit y by x engine returned oneway rows for bivariate analysis".into(),
            )),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use crate::error::AppError;
    use crate::models::fit_y_by_x::{FitYByXPersonality, FitYByXRequest, FitYByXResult};
    use crate::state::AppState;

    use super::FitYByXService;

    fn seed_dataset(
        state: &AppState,
        dataset_id: &str,
        column_names: &[&str],
        column_types: &[&str],
        insert_sql: &str,
        row_count: i64,
    ) {
        let db = state.db.lock().expect("test db lock");
        let names = column_names
            .iter()
            .map(|name| (*name).to_string())
            .collect::<Vec<_>>();
        let types = column_types
            .iter()
            .map(|column_type| (*column_type).to_string())
            .collect::<Vec<_>>();
        db.create_empty_table(dataset_id, dataset_id, &names, &types)
            .expect("seed dataset metadata");
        db.conn()
            .execute_batch(insert_sql)
            .expect("seed dataset rows");
        db.conn()
            .execute(
                "UPDATE _meta_datasets SET row_count = $1 WHERE id = $2",
                duckdb::params![row_count, dataset_id],
            )
            .expect("update row count");
    }

    fn set_column_role(state: &AppState, dataset_id: &str, column_name: &str, role: &str) {
        let db = state.db.lock().expect("test db lock");
        db.conn()
            .execute(
                "UPDATE _meta_columns SET role = $1 WHERE dataset_id = $2 AND col_name = $3",
                duckdb::params![role, dataset_id, column_name],
            )
            .expect("set column role");
    }

    #[test]
    fn runs_oneway_for_valid_categorical_factor() -> Result<(), AppError> {
        let state = AppState::new().expect("test state");
        seed_dataset(
            &state,
            "fit-oneway",
            &["height", "site"],
            &["DOUBLE", "VARCHAR"],
            r#"
            INSERT INTO "dataset_fit_oneway" (_row_id, height, site) VALUES
                (1, 60.0, 'A'),
                (2, 62.0, 'A'),
                (3, 65.0, 'B'),
                (4, 67.0, 'B');
            "#,
            4,
        );

        let result = FitYByXService::new(&state).run(FitYByXRequest {
            dataset_id: "fit-oneway".into(),
            generation: 0,
            response_column: "height".into(),
            factor_column: "site".into(),
            personality: FitYByXPersonality::Oneway,
            confidence_level: 0.95,
        })?;

        assert!(matches!(result, FitYByXResult::Oneway(_)));
        Ok(())
    }

    #[test]
    fn counts_pairwise_excluded_rows_for_oneway_numeric_categorical_factor() -> Result<(), AppError>
    {
        let state = AppState::new().expect("test state");
        seed_dataset(
            &state,
            "fit-oneway-pairwise",
            &["height", "site_code"],
            &["DOUBLE", "DOUBLE"],
            r#"
            INSERT INTO "dataset_fit_oneway_pairwise" (_row_id, height, site_code) VALUES
                (1, 10.0, 1.0),
                (2, NULL, 1.0),
                (3, 12.0, NULL),
                (4, 13.0, 2.0),
                (5, 15.0, 2.0);
            "#,
            5,
        );
        set_column_role(&state, "fit-oneway-pairwise", "site_code", "nominal");

        let result = FitYByXService::new(&state).run(FitYByXRequest {
            dataset_id: "fit-oneway-pairwise".into(),
            generation: 0,
            response_column: "height".into(),
            factor_column: "site_code".into(),
            personality: FitYByXPersonality::Oneway,
            confidence_level: 0.95,
        })?;

        let FitYByXResult::Oneway(oneway) = result else {
            panic!("expected oneway result");
        };
        assert_eq!(oneway.used_rows, 3);
        assert_eq!(oneway.excluded_rows, 2);
        Ok(())
    }

    #[test]
    fn runs_bivariate_with_decimal_and_uhugeint_rows_and_exact_accounting() -> Result<(), AppError>
    {
        let state = AppState::new().expect("test state");
        seed_dataset(
            &state,
            "fit-bivariate-wide-numeric",
            &["response", "factor"],
            &["UHUGEINT", "DECIMAL(18,2)"],
            r#"
            INSERT INTO "dataset_fit_bivariate_wide_numeric" (_row_id, response, factor) VALUES
                (1, CAST(3 AS UHUGEINT), CAST(1.00 AS DECIMAL(18,2))),
                (2, CAST(5 AS UHUGEINT), CAST(2.00 AS DECIMAL(18,2))),
                (3, CAST(7 AS UHUGEINT), CAST(3.00 AS DECIMAL(18,2))),
                (4, NULL, CAST(4.00 AS DECIMAL(18,2))),
                (5, CAST(11 AS UHUGEINT), NULL);
            "#,
            5,
        );

        let result = FitYByXService::new(&state).run(FitYByXRequest {
            dataset_id: "fit-bivariate-wide-numeric".into(),
            generation: 0,
            response_column: "response".into(),
            factor_column: "factor".into(),
            personality: FitYByXPersonality::Bivariate,
            confidence_level: 0.95,
        })?;

        let FitYByXResult::Bivariate(bivariate) = result else {
            panic!("expected bivariate result");
        };
        assert_eq!(bivariate.used_rows, 3);
        assert_eq!(bivariate.excluded_rows, 2);
        assert_eq!(bivariate.summary_of_fit.observation_count, 3);
        assert_eq!(bivariate.intercept, 1.0);
        assert_eq!(bivariate.slope, 2.0);
        Ok(())
    }

    #[test]
    fn rejects_stale_generation_while_holding_db_lock() {
        let state = AppState::new().expect("test state");
        seed_dataset(
            &state,
            "fit-stale-generation",
            &["height", "site"],
            &["DOUBLE", "VARCHAR"],
            r#"
            INSERT INTO "dataset_fit_stale_generation" (_row_id, height, site) VALUES
                (1, 10.0, 'A'),
                (2, 11.0, 'B');
            "#,
            2,
        );
        {
            let db = state.db.lock().expect("test db lock");
            db.conn()
                .execute(
                    "UPDATE _meta_datasets SET generation = 1 WHERE id = $1",
                    duckdb::params!["fit-stale-generation"],
                )
                .expect("set dataset generation");
        }

        let error = FitYByXService::new(&state)
            .run(FitYByXRequest {
                dataset_id: "fit-stale-generation".into(),
                generation: 0,
                response_column: "height".into(),
                factor_column: "site".into(),
                personality: FitYByXPersonality::Oneway,
                confidence_level: 0.95,
            })
            .expect_err("stale generation must fail");

        assert!(matches!(error, AppError::InvalidParam(message) if message.contains("generation")));
    }

    #[test]
    fn rejects_unknown_dataset() {
        let state = AppState::new().expect("test state");

        let error = FitYByXService::new(&state)
            .run(FitYByXRequest {
                dataset_id: "missing".into(),
                generation: 0,
                response_column: "height".into(),
                factor_column: "site".into(),
                personality: FitYByXPersonality::Oneway,
                confidence_level: 0.95,
            })
            .expect_err("unknown dataset must fail");

        assert!(matches!(error, AppError::InvalidParam(message) if message.contains("dataset")));
    }

    #[test]
    fn rejects_unknown_column() {
        let state = AppState::new().expect("test state");
        seed_dataset(
            &state,
            "fit-unknown-column",
            &["height", "site"],
            &["DOUBLE", "VARCHAR"],
            r#"
            INSERT INTO "dataset_fit_unknown_column" (_row_id, height, site) VALUES
                (1, 10.0, 'A'),
                (2, 11.0, 'B');
            "#,
            2,
        );

        let error = FitYByXService::new(&state)
            .run(FitYByXRequest {
                dataset_id: "fit-unknown-column".into(),
                generation: 0,
                response_column: "height".into(),
                factor_column: "missing".into(),
                personality: FitYByXPersonality::Oneway,
                confidence_level: 0.95,
            })
            .expect_err("unknown column must fail");

        assert!(matches!(error, AppError::InvalidParam(message) if message.contains("column")));
    }

    #[test]
    fn rejects_same_column_for_x_and_y() {
        let state = AppState::new().expect("test state");
        seed_dataset(
            &state,
            "fit-same-column",
            &["height", "site"],
            &["DOUBLE", "VARCHAR"],
            r#"
            INSERT INTO "dataset_fit_same_column" (_row_id, height, site) VALUES
                (1, 10.0, 'A'),
                (2, 11.0, 'B');
            "#,
            2,
        );

        let error = FitYByXService::new(&state)
            .run(FitYByXRequest {
                dataset_id: "fit-same-column".into(),
                generation: 0,
                response_column: "height".into(),
                factor_column: "height".into(),
                personality: FitYByXPersonality::Oneway,
                confidence_level: 0.95,
            })
            .expect_err("same-column request must fail");

        assert!(matches!(error, AppError::InvalidParam(message) if message.contains("same")));
    }

    #[test]
    fn rejects_oneway_for_numeric_continuous_factor() {
        let state = AppState::new().expect("test state");
        seed_dataset(
            &state,
            "fit-oneway-continuous",
            &["height", "age"],
            &["DOUBLE", "DOUBLE"],
            r#"
            INSERT INTO "dataset_fit_oneway_continuous" (_row_id, height, age) VALUES
                (1, 60.0, 10.0),
                (2, 62.0, 11.0),
                (3, 65.0, 12.0);
            "#,
            3,
        );

        let error = FitYByXService::new(&state)
            .run(FitYByXRequest {
                dataset_id: "fit-oneway-continuous".into(),
                generation: 0,
                response_column: "height".into(),
                factor_column: "age".into(),
                personality: FitYByXPersonality::Oneway,
                confidence_level: 0.95,
            })
            .expect_err("continuous numeric factor must fail on oneway");

        assert!(matches!(error, AppError::InvalidParam(message) if message.contains("oneway")));
    }

    #[test]
    fn rejects_bivariate_for_categorical_factor() {
        let state = AppState::new().expect("test state");
        seed_dataset(
            &state,
            "fit-bivariate-categorical",
            &["height", "site"],
            &["DOUBLE", "VARCHAR"],
            r#"
            INSERT INTO "dataset_fit_bivariate_categorical" (_row_id, height, site) VALUES
                (1, 60.0, 'A'),
                (2, 62.0, 'B'),
                (3, 65.0, 'C');
            "#,
            3,
        );

        let error = FitYByXService::new(&state)
            .run(FitYByXRequest {
                dataset_id: "fit-bivariate-categorical".into(),
                generation: 0,
                response_column: "height".into(),
                factor_column: "site".into(),
                personality: FitYByXPersonality::Bivariate,
                confidence_level: 0.95,
            })
            .expect_err("categorical factor must fail on bivariate");

        assert!(matches!(error, AppError::InvalidParam(message) if message.contains("bivariate")));
    }

    #[test]
    fn rejects_confidence_levels_outside_open_interval() {
        let state = AppState::new().expect("test state");
        seed_dataset(
            &state,
            "fit-confidence",
            &["height", "site"],
            &["DOUBLE", "VARCHAR"],
            r#"
            INSERT INTO "dataset_fit_confidence" (_row_id, height, site) VALUES
                (1, 60.0, 'A'),
                (2, 62.0, 'B');
            "#,
            2,
        );

        for confidence_level in [0.0, 1.0, -0.1, 1.1, f64::NAN, f64::INFINITY] {
            let error = FitYByXService::new(&state)
                .run(FitYByXRequest {
                    dataset_id: "fit-confidence".into(),
                    generation: 0,
                    response_column: "height".into(),
                    factor_column: "site".into(),
                    personality: FitYByXPersonality::Oneway,
                    confidence_level,
                })
                .expect_err("invalid confidence level must fail");

            assert!(
                matches!(error, AppError::InvalidParam(message) if message.contains("confidence"))
            );
        }
    }
}
