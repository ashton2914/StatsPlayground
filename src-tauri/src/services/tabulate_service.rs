use crate::error::AppError;
use crate::models::tabulate::{TabulateRequest, TabulateResult, TabulateStatistic};
use crate::state::AppState;
use std::collections::HashSet;

pub const MAX_RESULT_CELLS: u64 = 10_000;
pub const MAX_RESULT_CELLS_STR: &str = "10,000";

pub struct TabulateService<'a> {
    state: &'a AppState,
}

impl<'a> TabulateService<'a> {
    pub fn new(state: &'a AppState) -> Self {
        Self { state }
    }

    pub fn run(&self, request: TabulateRequest) -> Result<TabulateResult, AppError> {
        // Validate statistics presence
        if request.statistics.is_empty() {
            return Err(AppError::InvalidParam(
                "At least one statistic must be requested".into(),
            ));
        }

        // Validate result limit: must match the configured constant exactly
        if request.max_result_cells != MAX_RESULT_CELLS {
            return Err(AppError::InvalidParam(format!(
                "max_result_cells must be exactly {}",
                MAX_RESULT_CELLS_STR
            )));
        }

        validate_definition(
            &request.dataset_id,
            &request.row_fields,
            &request.column_fields,
            &request.statistics,
        )?;

        let db = self
            .state
            .db
            .lock()
            .map_err(|e| AppError::Database(e.to_string()))?;
        db.tabulate(&request)
    }
}

pub(crate) fn validate_definition(
    dataset_id: &str,
    row_fields: &[String],
    column_fields: &[String],
    statistics: &[TabulateStatistic],
) -> Result<(), AppError> {
    if statistics.is_empty() {
        return Err(AppError::InvalidParam(
            "At least one statistic must be requested".into(),
        ));
    }
    if dataset_id.trim().is_empty() {
        return Err(AppError::InvalidParam("dataset_id must be provided".into()));
    }

    // Validate row/column field names are non-blank and not duplicated within their role
    let mut seen = HashSet::new();
    for f in row_fields {
        if f.trim().is_empty() {
            return Err(AppError::InvalidParam(
                "row field names must not be blank".into(),
            ));
        }
        if !seen.insert(f) {
            return Err(AppError::InvalidParam("duplicate row field".into()));
        }
    }
    seen.clear();
    for f in column_fields {
        if f.trim().is_empty() {
            return Err(AppError::InvalidParam(
                "column field names must not be blank".into(),
            ));
        }
        if !seen.insert(f) {
            return Err(AppError::InvalidParam("duplicate column field".into()));
        }
    }

    // Validate statistics content
    for stat in statistics {
        if stat.id.trim().is_empty() {
            return Err(AppError::InvalidParam(
                "statistic id must not be blank".into(),
            ));
        }
        if stat.field.trim().is_empty() {
            return Err(AppError::InvalidParam(
                "statistic field must not be blank".into(),
            ));
        }
        if let Some(q) = stat.quantile {
            if !q.is_finite() || !(0.0..=1.0).contains(&q) {
                return Err(AppError::InvalidParam(
                    "quantile must be finite and in [0,1]".into(),
                ));
            }
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::tabulate::{StatisticKind, TabulateRequest, TabulateStatistic};
    use crate::state::AppState;

    fn request_with_statistic(limit: u64) -> AppError {
        let state = AppState::new().expect("test state");
        let service = TabulateService::new(&state);
        let req = TabulateRequest {
            dataset_id: "ds".into(),
            row_fields: vec![],
            column_fields: vec![],
            statistics: vec![TabulateStatistic {
                id: "s1".into(),
                field: "col".into(),
                kind: StatisticKind::Count,
                quantile: None,
            }],
            include_row_totals: true,
            include_column_totals: true,
            max_result_cells: limit,
        };
        service.run(req).expect_err("limit must fail")
    }

    fn request_with_quantile(prob: f64) -> AppError {
        let state = AppState::new().expect("test state");
        let service = TabulateService::new(&state);
        let req = TabulateRequest {
            dataset_id: "ds".into(),
            row_fields: vec![],
            column_fields: vec![],
            statistics: vec![TabulateStatistic {
                id: "q1".into(),
                field: "col".into(),
                kind: StatisticKind::Quantile,
                quantile: Some(prob),
            }],
            include_row_totals: false,
            include_column_totals: false,
            max_result_cells: MAX_RESULT_CELLS,
        };
        service.run(req).expect_err("quantile must fail")
    }

    fn seed_small_valid_dataset(state: &AppState) {
        let db = state.db.lock().expect("test db lock");
        db.conn()
            .execute_batch(
                r#"
                CREATE TABLE "dataset_test_tabulate" (
                    region VARCHAR,
                    product VARCHAR,
                    sales DOUBLE
                );
                INSERT INTO "dataset_test_tabulate" VALUES
                    ('East', 'A', 10),
                    ('East', 'A', 20);
                INSERT INTO _meta_datasets (
                    id, name, source_path, source_type, row_count, col_count
                ) VALUES (
                    'test-tabulate', 'test-tabulate', NULL, 'manual', 2, 3
                );
                INSERT INTO _meta_columns (
                    dataset_id, col_index, col_name, col_type, role, missing_count
                ) VALUES
                    ('test-tabulate', 0, 'region', 'VARCHAR', 'continuous', 0),
                    ('test-tabulate', 1, 'product', 'VARCHAR', 'continuous', 0),
                    ('test-tabulate', 2, 'sales', 'DOUBLE', 'continuous', 0);
                "#,
            )
            .expect("seed test dataset");
    }

    #[test]
    fn rejects_empty_statistics() {
        let state = AppState::new().expect("test state");
        let service = TabulateService::new(&state);
        let error = service
            .run(TabulateRequest {
                dataset_id: "missing".into(),
                row_fields: vec![],
                column_fields: vec![],
                statistics: vec![],
                include_row_totals: true,
                include_column_totals: true,
                max_result_cells: MAX_RESULT_CELLS,
            })
            .expect_err("empty statistics must fail");
        assert!(matches!(error, AppError::InvalidParam(message) if message.contains("statistic")));
    }

    #[test]
    fn delegates_to_engine_for_exact_limit_count_request() {
        let state = AppState::new().expect("test state");
        seed_small_valid_dataset(&state);

        let service = TabulateService::new(&state);
        let result = service
            .run(TabulateRequest {
                dataset_id: "test-tabulate".into(),
                row_fields: vec!["region".into()],
                column_fields: vec!["product".into()],
                statistics: vec![TabulateStatistic {
                    id: "count-sales".into(),
                    field: "sales".into(),
                    kind: StatisticKind::Count,
                    quantile: None,
                }],
                include_row_totals: false,
                include_column_totals: false,
                max_result_cells: MAX_RESULT_CELLS,
            })
            .expect("service should delegate to engine");

        assert_eq!(result.limit, MAX_RESULT_CELLS);
        assert_eq!(result.cell_count, 1);
        assert_eq!(result.row_members, vec![vec![serde_json::json!("East")]]);
        assert_eq!(result.column_members, vec![vec![serde_json::json!("A")]]);
        assert_eq!(result.cells, vec![Some(2.0)]);
        assert_eq!(result.statistics.len(), 1);
    }

    #[test]
    fn rejects_wrong_result_limit() {
        let error = request_with_statistic(MAX_RESULT_CELLS - 1);
        assert!(matches!(error, AppError::InvalidParam(message) if message.contains("10,000")));
    }

    #[test]
    fn rejects_result_limit_above() {
        let error = request_with_statistic(MAX_RESULT_CELLS + 1);
        assert!(matches!(error, AppError::InvalidParam(message) if message.contains("10,000")));
    }

    #[test]
    fn rejects_non_finite_or_out_of_range_quantiles() {
        for probability in [f64::NAN, -0.01, 1.01] {
            let error = request_with_quantile(probability);
            assert!(
                matches!(error, AppError::InvalidParam(message) if message.contains("quantile"))
            );
        }
    }
}
