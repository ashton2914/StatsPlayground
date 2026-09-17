use crate::error::AppError;
use crate::models::table::{
    ColumnDisplayProps, ColumnDisplayPropsWithoutIndex, CreateManagedTableRequest,
    CreateTableFromRowsRequest, DatasetMeta, ManagedTableCreateColumn, ManagedTableCreateResult,
    SqlQueryResult, TableFilterValue, TableQueryResult, TableWindowRequest, TableWindowResult,
};
use crate::services::spprj_archive::{
    normalize_unsafe_portable_basename, validate_portable_basename,
};
use crate::state::AppState;

fn reject_calculated_column_writes<'a>(
    db: &crate::engine::duckdb_engine::DuckDbEngine,
    dataset_id: &str,
    column_names: impl IntoIterator<Item = &'a str>,
) -> Result<(), AppError> {
    let calculated_names = db.calculated_column_names(dataset_id)?;
    if let Some(column_name) = column_names
        .into_iter()
        .find(|column_name| calculated_names.contains(*column_name))
    {
        return Err(AppError::InvalidParam(format!(
            "calculated output column is read-only until convert to values: {column_name}"
        )));
    }
    Ok(())
}

fn allocate_case_insensitive_dataset_name<I, S>(requested: &str, existing: I) -> String
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let lower_requested = requested.to_lowercase();
    let occupied = existing
        .into_iter()
        .map(|name| name.as_ref().to_lowercase())
        .collect::<std::collections::HashSet<_>>();
    if !occupied.contains(&lower_requested) {
        return requested.to_string();
    }

    let mut suffix = 2;
    loop {
        let candidate = format!("{requested}-{suffix}");
        if !occupied.contains(&candidate.to_lowercase()) {
            return candidate;
        }
        suffix += 1;
    }
}

/// Compute the new index of a column originally at `idx` after a single column
/// is moved from `from` to `to`. Mirrors an array `remove(from) + insert(to)`.
fn remap_moved_index(idx: usize, from: usize, to: usize) -> usize {
    if idx == from {
        to
    } else if from < to {
        // Columns in (from, to] slide one slot left.
        if idx > from && idx <= to {
            idx - 1
        } else {
            idx
        }
    } else {
        // from > to: columns in [to, from) slide one slot right.
        if idx >= to && idx < from {
            idx + 1
        } else {
            idx
        }
    }
}

pub struct DataService<'a> {
    state: &'a AppState,
}

const SUPPORTED_MANUAL_TABLE_TYPES: &[&str] = &[
    "VARCHAR",
    "INTEGER",
    "BIGINT",
    "DOUBLE",
    "BOOLEAN",
    "DATE",
    "TIMESTAMP",
];

const SUPPORTED_DISPLAY_FORMAT_KINDS: &[&str] =
    &["asis", "fixed", "percent", "scientific", "currency"];

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::table::{
        ColumnDisplayPropsWithoutIndex, ColumnFormatInfo, CreateManagedTableRequest,
        CreateTableColumn, CreateTableFromRowsRequest,
    };
    use crate::state::AppState;
    use duckdb::params;

    fn metadata_dataset_count(state: &AppState, dataset_id: &str) -> i64 {
        let db = state.db.lock().expect("db lock");
        db.conn()
            .query_row(
                "SELECT COUNT(*) FROM _meta_datasets WHERE id = $1",
                params![dataset_id],
                |row| row.get(0),
            )
            .expect("metadata count")
    }

    fn physical_table_exists(state: &AppState, dataset_id: &str) -> bool {
        let table_name = format!("dataset_{}", dataset_id.replace('-', "_"));
        let db = state.db.lock().expect("db lock");
        let count: i64 = db
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM information_schema.tables WHERE table_name = $1",
                params![table_name],
                |row| row.get(0),
            )
            .expect("table existence count");
        count == 1
    }

    fn metadata_total_dataset_count(state: &AppState) -> i64 {
        let db = state.db.lock().expect("db lock");
        db.conn()
            .query_row("SELECT COUNT(*) FROM _meta_datasets", [], |row| row.get(0))
            .expect("dataset total count")
    }

    fn physical_table_count(state: &AppState) -> i64 {
        let db = state.db.lock().expect("db lock");
        db.conn()
            .query_row(
                "SELECT COUNT(*) FROM information_schema.tables WHERE table_name LIKE 'dataset_%'",
                [],
                |row| row.get(0),
            )
            .expect("physical dataset table count")
    }

    fn tiny_rows_request(name: &str) -> CreateTableFromRowsRequest {
        CreateTableFromRowsRequest {
            name: name.to_string(),
            column_names: vec!["value".to_string()],
            column_types: vec!["VARCHAR".to_string()],
            rows: vec![vec![serde_json::Value::String("ok".to_string())]],
        }
    }

    #[test]
    fn allocator_keeps_unique_name_without_suffix() {
        let resolved = allocate_case_insensitive_dataset_name("Sales", ["Costs", "Gross Margin"]);
        assert_eq!(resolved, "Sales");
    }

    #[test]
    fn allocator_appends_next_suffix_case_insensitively() {
        let resolved =
            allocate_case_insensitive_dataset_name("sales", ["Sales", "sales-2", "SALES-3"]);
        assert_eq!(resolved, "sales-4");
    }

    #[test]
    fn allocator_treats_numeric_suffix_gaps_deterministically() {
        let resolved = allocate_case_insensitive_dataset_name(
            "Summary",
            ["summary", "summary-3", "summary-7"],
        );
        assert_eq!(resolved, "Summary-2");
    }

    #[test]
    fn create_boundary_rejects_windows_reserved_names_with_typed_error() {
        let state = AppState::new().expect("state");
        let service = DataService::new(&state);

        let err = service
            .create_table("NUL.txt", &["value".to_string()], &["VARCHAR".to_string()])
            .expect_err("reserved names must be rejected at create boundary");

        assert!(
            matches!(err, AppError::InvalidParam(message) if message.contains("reserved Windows device name"))
        );
    }

    #[test]
    fn create_boundary_rejects_control_chars_with_typed_error() {
        let state = AppState::new().expect("state");
        let service = DataService::new(&state);
        let request = tiny_rows_request("bad\u{0001}name");

        let err = service
            .create_table_from_rows(&request)
            .expect_err("control characters must be rejected at create boundary");

        assert!(
            matches!(err, AppError::InvalidParam(message) if message.contains("control character"))
        );
    }

    #[test]
    fn create_boundary_returns_collision_resolved_final_metadata_name() {
        let state = AppState::new().expect("state");
        let service = DataService::new(&state);

        let first = service
            .create_table("Sales", &["value".to_string()], &["VARCHAR".to_string()])
            .expect("first create");
        let second = service
            .create_table("sales", &["value".to_string()], &["VARCHAR".to_string()])
            .expect("second create");

        assert_eq!(first.name, "Sales");
        assert_eq!(second.name, "sales-2");
    }

    #[test]
    fn invalid_name_rejection_does_not_mutate_dataset_list() {
        let state = AppState::new().expect("state");
        let service = DataService::new(&state);

        service
            .create_table("Good", &["value".to_string()], &["VARCHAR".to_string()])
            .expect("seed create");
        let before = service.list_datasets().expect("list before");

        let err = service
            .create_table(
                "bad\u{0001}name",
                &["value".to_string()],
                &["VARCHAR".to_string()],
            )
            .expect_err("invalid create must fail");
        assert!(matches!(err, AppError::InvalidParam(_)));

        let after = service.list_datasets().expect("list after");
        assert_eq!(after.len(), before.len());
        assert_eq!(after[0].name, before[0].name);
    }

    #[test]
    fn create_table_from_sql_query_rejects_reserved_name_before_mutation() {
        let state = AppState::new().expect("state");
        let service = DataService::new(&state);

        service
            .create_table("Seed", &["value".to_string()], &["VARCHAR".to_string()])
            .expect("seed create");
        let before = service.list_datasets().expect("list before");

        let err = service
            .create_table_from_sql_query("SELECT 1 AS value", "CON.txt")
            .expect_err("reserved names must be rejected before SQL create");
        assert!(
            matches!(err, AppError::InvalidParam(message) if message.contains("reserved Windows device name"))
        );

        let after = service.list_datasets().expect("list after");
        assert_eq!(after.len(), before.len());
        assert_eq!(after[0].name, before[0].name);
    }

    #[test]
    fn preflight_sql_create_rejects_invalid_query_without_side_effects() {
        let state = AppState::new().expect("state");
        let service = DataService::new(&state);
        service
            .create_table("Seed", &["value".to_string()], &["VARCHAR".to_string()])
            .expect("seed create");

        let datasets_before = metadata_total_dataset_count(&state);
        let physical_before = physical_table_count(&state);

        let error = service
            .preflight_create_table_from_sql_query("SELECT 1; SELECT 2", "Bad")
            .expect_err("preflight must reject multi-statement query");

        assert!(matches!(error, AppError::InvalidParam(_)));
        assert_eq!(metadata_total_dataset_count(&state), datasets_before);
        assert_eq!(physical_table_count(&state), physical_before);
    }

    #[test]
    fn preflight_sql_create_rejects_reserved_row_id_without_side_effects() {
        let state = AppState::new().expect("state");
        let service = DataService::new(&state);
        service
            .create_table("Seed", &["value".to_string()], &["VARCHAR".to_string()])
            .expect("seed create");

        let datasets_before = metadata_total_dataset_count(&state);
        let physical_before = physical_table_count(&state);

        let error = service
            .preflight_create_table_from_sql_query("SELECT 1 AS \"_row_id\"", "Bad")
            .expect_err("reserved row id must fail preflight");

        assert!(
            matches!(error, AppError::InvalidParam(message) if message.contains("reserved name _row_id"))
        );
        assert_eq!(metadata_total_dataset_count(&state), datasets_before);
        assert_eq!(physical_table_count(&state), physical_before);
    }

    #[test]
    fn import_name_normalization_is_deterministic_for_unsafe_stems() {
        assert_eq!(
            normalize_unsafe_portable_basename("NUL.txt", "untitled"),
            "_NUL.txt"
        );
        assert_eq!(
            normalize_unsafe_portable_basename(" bad\u{0001}/name. ", "untitled"),
            "bad__name"
        );
        assert_eq!(
            normalize_unsafe_portable_basename("", "untitled"),
            "untitled"
        );
    }

    #[test]
    fn create_managed_table_persists_display_props_and_opaque_extras() {
        let state = AppState::new().expect("state");
        let service = DataService::new(&state);
        let request = CreateManagedTableRequest {
            name: "Managed Table".to_string(),
            columns: vec![
                CreateTableColumn {
                    name: "length".to_string(),
                    column_type: "DOUBLE".to_string(),
                    display: Some(ColumnDisplayPropsWithoutIndex {
                        width: Some(144.0),
                        format: Some(ColumnFormatInfo {
                            kind: "currency".to_string(),
                            decimals: Some(3),
                            currency: Some("USD".to_string()),
                        }),
                        extras: Some(std::collections::BTreeMap::from([
                            ("unit".to_string(), serde_json::json!({ "symbol": "mm" })),
                            (
                                "spec".to_string(),
                                serde_json::json!({ "lower": 1.2, "upper": 3.4 }),
                            ),
                            (
                                "range".to_string(),
                                serde_json::json!({ "preferred": [1.5, 2.5] }),
                            ),
                            (
                                "notes".to_string(),
                                serde_json::json!({ "text": "critical" }),
                            ),
                            (
                                "valueOrder".to_string(),
                                serde_json::json!({ "values": ["EV", "DV", "PQ"] }),
                            ),
                            (
                                "opaque".to_string(),
                                serde_json::json!({ "nested": { "a": [1, true, "x"] } }),
                            ),
                        ])),
                    }),
                },
                CreateTableColumn {
                    name: "build".to_string(),
                    column_type: "VARCHAR".to_string(),
                    display: Some(ColumnDisplayPropsWithoutIndex {
                        width: Some(220.0),
                        format: Some(ColumnFormatInfo {
                            kind: "asis".to_string(),
                            decimals: None,
                            currency: None,
                        }),
                        extras: Some(std::collections::BTreeMap::from([(
                            "valueOrder".to_string(),
                            serde_json::json!({ "values": ["EV", "DV"] }),
                        )])),
                    }),
                },
            ],
            rows: vec![
                vec![serde_json::json!(1.234), serde_json::json!("EV")],
                vec![serde_json::Value::Null, serde_json::json!("DV")],
            ],
        };

        let meta = service
            .create_managed_table(&request)
            .expect("managed table created");

        assert_eq!(meta.source_type, "manual");
        assert_eq!(meta.row_count, 2);
        assert_eq!(meta.col_count, 2);
        assert_eq!(metadata_dataset_count(&state, &meta.id), 1);
        assert!(physical_table_exists(&state, &meta.id));

        let display = state
            .column_display
            .lock()
            .expect("display lock")
            .get(&meta.id)
            .cloned()
            .expect("display persisted");
        assert_eq!(display.len(), 2);
        assert_eq!(display[0].col_index, 0);
        assert_eq!(display[0].width, Some(144.0));
        assert_eq!(
            display[0].format.as_ref().and_then(|value| value.decimals),
            Some(3)
        );
        assert_eq!(
            display[0]
                .format
                .as_ref()
                .and_then(|value| value.currency.clone()),
            Some("USD".to_string())
        );
        assert_eq!(
            display[0].extras.as_ref().expect("extras")["unit"],
            serde_json::json!({ "symbol": "mm" })
        );
        assert_eq!(
            display[0].extras.as_ref().expect("extras")["opaque"],
            serde_json::json!({ "nested": { "a": [1, true, "x"] } })
        );
        assert_eq!(display[1].col_index, 1);
        assert_eq!(display[1].width, Some(220.0));
        assert_eq!(
            display[1].extras.as_ref().expect("extras")["valueOrder"],
            serde_json::json!({ "values": ["EV", "DV"] })
        );
    }

    #[test]
    fn create_managed_table_outcome_returns_canonical_columns_and_display() {
        let state = AppState::new().expect("state");
        let service = DataService::new(&state);
        let request = CreateManagedTableRequest {
            name: "Managed Canonical".to_string(),
            columns: vec![CreateTableColumn {
                name: "length".to_string(),
                column_type: "double".to_string(),
                display: Some(ColumnDisplayPropsWithoutIndex {
                    width: Some(144.0),
                    format: Some(ColumnFormatInfo {
                        kind: "Currency".to_string(),
                        decimals: Some(3),
                        currency: Some("USD".to_string()),
                    }),
                    extras: Some(std::collections::BTreeMap::from([(
                        "unit".to_string(),
                        serde_json::json!({ "symbol": "mm" }),
                    )])),
                }),
            }],
            rows: vec![vec![serde_json::json!(1.234)]],
        };

        let outcome = service
            .create_managed_table_outcome(&request)
            .expect("managed outcome created");

        assert_eq!(outcome.dataset.name, "Managed Canonical");
        assert_eq!(outcome.dataset.source_type, "manual");
        assert_eq!(outcome.generation, outcome.dataset.generation);
        assert_eq!(outcome.columns.len(), 1);
        assert_eq!(outcome.columns[0].col_name, "length");
        assert_eq!(outcome.columns[0].col_type, "DOUBLE");
        assert_eq!(outcome.columns[0].width, Some(144.0));
        assert_eq!(
            outcome.columns[0]
                .format
                .as_ref()
                .map(|value| value.kind.as_str()),
            Some("currency")
        );
        assert_eq!(
            outcome.columns[0].extras.as_ref().expect("extras")["unit"],
            serde_json::json!({ "symbol": "mm" })
        );
    }

    #[test]
    fn create_managed_table_rejects_malformed_rows_without_side_effects() {
        let state = AppState::new().expect("state");
        let service = DataService::new(&state);
        let datasets_before = metadata_total_dataset_count(&state);
        let physical_before = physical_table_count(&state);
        let request = CreateManagedTableRequest {
            name: "Bad Rows".to_string(),
            columns: vec![
                CreateTableColumn {
                    name: "left".to_string(),
                    column_type: "DOUBLE".to_string(),
                    display: None,
                },
                CreateTableColumn {
                    name: "right".to_string(),
                    column_type: "DOUBLE".to_string(),
                    display: None,
                },
            ],
            rows: vec![
                vec![serde_json::json!(1.0), serde_json::json!(2.0)],
                vec![serde_json::json!(3.0)],
            ],
        };

        let error = service
            .create_managed_table(&request)
            .expect_err("malformed row width must fail");

        assert!(matches!(error, AppError::InvalidParam(message) if message.contains("width")));
        assert_eq!(metadata_total_dataset_count(&state), datasets_before);
        assert_eq!(physical_table_count(&state), physical_before);
        assert!(state
            .column_display
            .lock()
            .expect("display lock")
            .is_empty());
    }

    #[test]
    fn create_managed_table_rejects_invalid_display_and_rolls_back_everything() {
        let state = AppState::new().expect("state");
        let service = DataService::new(&state);
        let datasets_before = metadata_total_dataset_count(&state);
        let physical_before = physical_table_count(&state);
        let request = CreateManagedTableRequest {
            name: "Display Failure".to_string(),
            columns: vec![CreateTableColumn {
                name: "amount".to_string(),
                column_type: "DOUBLE".to_string(),
                display: Some(ColumnDisplayPropsWithoutIndex {
                    width: Some(f64::NAN),
                    format: Some(ColumnFormatInfo {
                        kind: "currency".to_string(),
                        decimals: Some(2),
                        currency: Some("USD".to_string()),
                    }),
                    extras: Some(std::collections::BTreeMap::from([(
                        "unit".to_string(),
                        serde_json::json!({ "symbol": "$" }),
                    )])),
                }),
            }],
            rows: vec![vec![serde_json::json!(10.0)]],
        };

        let error = service
            .create_managed_table(&request)
            .expect_err("invalid display must fail");

        assert!(matches!(error, AppError::InvalidParam(message) if message.contains("width")));
        assert_eq!(metadata_total_dataset_count(&state), datasets_before);
        assert_eq!(physical_table_count(&state), physical_before);
        assert!(state
            .column_display
            .lock()
            .expect("display lock")
            .is_empty());
    }

    #[test]
    fn create_managed_table_rejects_unsupported_but_canonicalizable_sql_type_without_side_effects()
    {
        let state = AppState::new().expect("state");
        let service = DataService::new(&state);
        let datasets_before = metadata_total_dataset_count(&state);
        let physical_before = physical_table_count(&state);
        let request = CreateManagedTableRequest {
            name: "Unsupported Type".to_string(),
            columns: vec![CreateTableColumn {
                name: "amount".to_string(),
                column_type: "DECIMAL(10,2)".to_string(),
                display: None,
            }],
            rows: vec![vec![serde_json::json!(1.23)]],
        };

        let error = service
            .create_managed_table(&request)
            .expect_err("unsupported canonical SQL type must be rejected");

        assert!(
            matches!(error, AppError::InvalidParam(message) if message.contains("unsupported column type"))
        );
        assert_eq!(metadata_total_dataset_count(&state), datasets_before);
        assert_eq!(physical_table_count(&state), physical_before);
        assert!(state
            .column_display
            .lock()
            .expect("display lock")
            .is_empty());
    }

    #[test]
    fn create_managed_table_rejects_unknown_display_format_kind_without_side_effects() {
        let state = AppState::new().expect("state");
        let service = DataService::new(&state);
        let datasets_before = metadata_total_dataset_count(&state);
        let physical_before = physical_table_count(&state);
        let request = CreateManagedTableRequest {
            name: "Unknown Format".to_string(),
            columns: vec![CreateTableColumn {
                name: "amount".to_string(),
                column_type: "DOUBLE".to_string(),
                display: Some(ColumnDisplayPropsWithoutIndex {
                    width: Some(120.0),
                    format: Some(ColumnFormatInfo {
                        kind: "datetime".to_string(),
                        decimals: None,
                        currency: None,
                    }),
                    extras: None,
                }),
            }],
            rows: vec![vec![serde_json::json!(1.23)]],
        };

        let error = service
            .create_managed_table(&request)
            .expect_err("unknown display format kind must be rejected");

        assert!(
            matches!(error, AppError::InvalidParam(message) if message.contains("unsupported display format kind"))
        );
        assert_eq!(metadata_total_dataset_count(&state), datasets_before);
        assert_eq!(physical_table_count(&state), physical_before);
        assert!(state
            .column_display
            .lock()
            .expect("display lock")
            .is_empty());
    }

    #[test]
    fn create_managed_table_when_display_lock_is_poisoned_fails_before_db_mutation() {
        let state = AppState::new().expect("state");
        let service = DataService::new(&state);

        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = state.column_display.lock().expect("display lock");
            panic!("poison display lock");
        }));
        assert!(state.column_display.is_poisoned());

        let datasets_before = metadata_total_dataset_count(&state);
        let physical_before = physical_table_count(&state);
        let request = CreateManagedTableRequest {
            name: "Poisoned Display Lock".to_string(),
            columns: vec![CreateTableColumn {
                name: "value".to_string(),
                column_type: "DOUBLE".to_string(),
                display: None,
            }],
            rows: vec![vec![serde_json::json!(1.0)]],
        };

        let error = service
            .create_managed_table(&request)
            .expect_err("poisoned display lock must fail");

        assert!(matches!(error, AppError::Database(_)));
        assert_eq!(metadata_total_dataset_count(&state), datasets_before);
        assert_eq!(physical_table_count(&state), physical_before);
    }
}

impl<'a> DataService<'a> {
    pub fn new(state: &'a AppState) -> Self {
        Self { state }
    }

    pub fn import_csv(&self, file_path: &str) -> Result<DatasetMeta, AppError> {
        let db = self
            .state
            .db
            .lock()
            .map_err(|e| AppError::Database(e.to_string()))?;
        let id = uuid::Uuid::new_v4().to_string();
        let source_stem = std::path::Path::new(file_path)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("untitled");
        let requested_name = normalize_unsafe_portable_basename(source_stem, "untitled");
        let resolved_name = Self::resolve_create_dataset_name(&db, &requested_name)?;
        db.import_csv(&id, &resolved_name, file_path)
    }

    fn validate_create_dataset_name_boundary(name: &str) -> Result<(), AppError> {
        validate_portable_basename(name, "Dataset name").map_err(AppError::InvalidParam)
    }

    fn resolve_create_dataset_name(
        db: &crate::engine::duckdb_engine::DuckDbEngine,
        requested_name: &str,
    ) -> Result<String, AppError> {
        Self::validate_create_dataset_name_boundary(requested_name)?;
        let existing_names = db
            .list_datasets()?
            .into_iter()
            .map(|dataset| dataset.name)
            .collect::<Vec<_>>();
        let resolved = allocate_case_insensitive_dataset_name(requested_name, existing_names);
        Self::validate_create_dataset_name_boundary(&resolved)?;
        db.validate_dataset_name(&resolved, None)?;
        Ok(resolved)
    }

    fn validate_display_without_index(
        display: &ColumnDisplayPropsWithoutIndex,
    ) -> Result<(), AppError> {
        if let Some(width) = display.width {
            if !width.is_finite() || width <= 0.0 {
                return Err(AppError::InvalidParam(
                    "display width must be finite and greater than 0".into(),
                ));
            }
        }

        if let Some(format) = &display.format {
            let kind = format.kind.trim();
            if kind.is_empty() {
                return Err(AppError::InvalidParam(
                    "display format kind must be non-empty".into(),
                ));
            }
            if !SUPPORTED_DISPLAY_FORMAT_KINDS
                .iter()
                .any(|supported| kind.eq_ignore_ascii_case(supported))
            {
                return Err(AppError::InvalidParam(format!(
                    "unsupported display format kind: {kind}"
                )));
            }
            if let Some(decimals) = format.decimals {
                if decimals > 20 {
                    return Err(AppError::InvalidParam(
                        "display decimals must be between 0 and 20".into(),
                    ));
                }
            }
            if kind.eq_ignore_ascii_case("currency") {
                let currency = format.currency.as_deref().map(str::trim).unwrap_or("");
                if currency.is_empty() {
                    return Err(AppError::InvalidParam(
                        "display currency format requires currency code".into(),
                    ));
                }
            }
        }

        if let Some(extras) = &display.extras {
            for key in extras.keys() {
                if key.trim().is_empty() {
                    return Err(AppError::InvalidParam(
                        "display extras keys must be non-empty".into(),
                    ));
                }
            }
        }

        Ok(())
    }

    pub fn list_datasets(&self) -> Result<Vec<DatasetMeta>, AppError> {
        let db = self
            .state
            .db
            .lock()
            .map_err(|e| AppError::Database(e.to_string()))?;
        db.list_datasets()
    }

    pub fn delete_dataset(&self, dataset_id: &str) -> Result<(), AppError> {
        let db = self
            .state
            .db
            .lock()
            .map_err(|e| AppError::Database(e.to_string()))?;
        db.delete_dataset(dataset_id)
    }

    pub fn query_table(
        &self,
        dataset_id: &str,
        page: usize,
        page_size: usize,
        sort_by: Option<&str>,
        sort_order: Option<&str>,
    ) -> Result<TableQueryResult, AppError> {
        let db = self
            .state
            .db
            .lock()
            .map_err(|e| AppError::Database(e.to_string()))?;
        db.query_table(dataset_id, page, page_size, sort_by, sort_order)
    }

    pub fn query_table_window(
        &self,
        request: &TableWindowRequest,
    ) -> Result<TableWindowResult, AppError> {
        let db = self
            .state
            .db
            .lock()
            .map_err(|error| AppError::Database(error.to_string()))?;
        db.query_table_window(request)
    }

    pub fn get_dataset_generation(&self, dataset_id: &str) -> Result<u64, AppError> {
        let db = self
            .state
            .db
            .lock()
            .map_err(|error| AppError::Database(error.to_string()))?;
        db.get_dataset_generation(dataset_id)
    }

    pub fn locate_table_row(
        &self,
        dataset_id: &str,
        row_id: i64,
        filters: &[crate::models::table::TableWindowFilter],
        generation: u64,
    ) -> Result<Option<usize>, AppError> {
        let db = self
            .state
            .db
            .lock()
            .map_err(|error| AppError::Database(error.to_string()))?;
        db.locate_table_row(dataset_id, row_id, filters, generation)
    }

    pub fn query_table_filter_values(
        &self,
        dataset_id: &str,
        field: &str,
        search: &str,
        limit: usize,
        generation: u64,
    ) -> Result<Vec<TableFilterValue>, AppError> {
        let db = self
            .state
            .db
            .lock()
            .map_err(|error| AppError::Database(error.to_string()))?;
        db.query_table_filter_values(dataset_id, field, search, limit, generation)
    }

    pub fn execute_sql_query(
        &self,
        sql: &str,
        page: usize,
        page_size: usize,
    ) -> Result<SqlQueryResult, AppError> {
        let db = self
            .state
            .db
            .lock()
            .map_err(|e| AppError::Database(e.to_string()))?;
        db.execute_sql_query(sql, page, page_size)
    }

    pub fn create_table(
        &self,
        name: &str,
        column_names: &[String],
        column_types: &[String],
    ) -> Result<DatasetMeta, AppError> {
        if column_names.len() != column_types.len() {
            return Err(AppError::InvalidParam(
                "Column names and types length mismatch".into(),
            ));
        }
        let request = CreateManagedTableRequest {
            name: name.to_string(),
            columns: column_names
                .iter()
                .zip(column_types.iter())
                .map(
                    |(column_name, column_type)| crate::models::table::CreateTableColumn {
                        name: column_name.clone(),
                        column_type: column_type.clone(),
                        display: None,
                    },
                )
                .collect(),
            rows: Vec::new(),
        };
        self.create_managed_table(&request)
    }

    pub fn create_table_from_sql_query(
        &self,
        sql: &str,
        name: &str,
    ) -> Result<DatasetMeta, AppError> {
        let db = self
            .state
            .db
            .lock()
            .map_err(|e| AppError::Database(e.to_string()))?;
        let id = uuid::Uuid::new_v4().to_string();
        let resolved_name = Self::resolve_create_dataset_name(&db, name)?;
        db.create_table_from_sql_query(&id, &resolved_name, sql)
    }

    pub fn preflight_create_table_from_sql_query(
        &self,
        sql: &str,
        name: &str,
    ) -> Result<(), AppError> {
        let db = self
            .state
            .db
            .lock()
            .map_err(|e| AppError::Database(e.to_string()))?;
        let resolved_name = Self::resolve_create_dataset_name(&db, name)?;
        db.preflight_create_table_from_sql_query(sql, &resolved_name)
    }

    pub fn create_table_from_rows(
        &self,
        request: &CreateTableFromRowsRequest,
    ) -> Result<DatasetMeta, AppError> {
        if request.column_names.len() != request.column_types.len() {
            return Err(AppError::InvalidParam(
                "Column names and types length mismatch".into(),
            ));
        }
        let managed = CreateManagedTableRequest {
            name: request.name.clone(),
            columns: request
                .column_names
                .iter()
                .zip(request.column_types.iter())
                .map(
                    |(column_name, column_type)| crate::models::table::CreateTableColumn {
                        name: column_name.clone(),
                        column_type: column_type.clone(),
                        display: None,
                    },
                )
                .collect(),
            rows: request.rows.clone(),
        };
        self.create_managed_table(&managed)
    }

    pub fn create_managed_table(
        &self,
        request: &CreateManagedTableRequest,
    ) -> Result<DatasetMeta, AppError> {
        Ok(self.create_managed_table_outcome(request)?.dataset)
    }

    pub fn create_managed_table_outcome(
        &self,
        request: &CreateManagedTableRequest,
    ) -> Result<ManagedTableCreateResult, AppError> {
        if request.columns.is_empty() {
            if !request.rows.is_empty() {
                return Err(AppError::InvalidParam(
                    "rows are not allowed when creating a table without columns".into(),
                ));
            }
        }

        if !request.columns.is_empty() {
            for (row_index, row) in request.rows.iter().enumerate() {
                if row.len() != request.columns.len() {
                    return Err(AppError::InvalidParam(format!(
                        "row {} has width {}, expected {}",
                        row_index + 1,
                        row.len(),
                        request.columns.len()
                    )));
                }
            }
        }

        let db = self
            .state
            .db
            .lock()
            .map_err(|e| AppError::Database(e.to_string()))?;
        let mut display_guard = self
            .state
            .column_display
            .lock()
            .map_err(|error| AppError::Database(error.to_string()))?;

        let mut display_props = Vec::new();
        let mut canonical_column_types = Vec::with_capacity(request.columns.len());
        let mut canonical_columns = Vec::with_capacity(request.columns.len());
        for (col_index, column) in request.columns.iter().enumerate() {
            if column.name.trim().is_empty() {
                return Err(AppError::InvalidParam(format!(
                    "column {} name must be non-empty",
                    col_index + 1
                )));
            }

            let canonical_type = db.canonicalize_column_type_for_create(&column.column_type)?;
            if !SUPPORTED_MANUAL_TABLE_TYPES
                .iter()
                .any(|supported| canonical_type.eq_ignore_ascii_case(supported))
            {
                return Err(AppError::InvalidParam(format!(
                    "unsupported column type: {}",
                    column.column_type
                )));
            }
            canonical_column_types.push(canonical_type.clone());

            let normalized_format = column.display.as_ref().and_then(|display| {
                display.format.as_ref().map(|value| {
                    let mut normalized = value.clone();
                    normalized.kind = normalized.kind.trim().to_ascii_lowercase();
                    normalized
                })
            });
            let normalized_extras = column
                .display
                .as_ref()
                .and_then(|display| display.extras.clone());
            let width = column.display.as_ref().and_then(|display| display.width);

            if let Some(display) = &column.display {
                Self::validate_display_without_index(display)?;
                display_props.push(ColumnDisplayProps {
                    col_index,
                    width,
                    format: normalized_format.clone(),
                    extras: normalized_extras.clone(),
                });
            }

            canonical_columns.push(ManagedTableCreateColumn {
                col_index,
                col_name: column.name.clone(),
                col_type: canonical_type,
                width,
                format: normalized_format,
                extras: normalized_extras,
            });
        }

        let id = uuid::Uuid::new_v4().to_string();
        let resolved_name = Self::resolve_create_dataset_name(&db, &request.name)?;

        let created = if request.columns.is_empty() {
            db.create_empty_table(&id, &resolved_name, &[], &[])?
        } else {
            let resolved_request = CreateTableFromRowsRequest {
                name: resolved_name,
                column_names: request
                    .columns
                    .iter()
                    .map(|column| column.name.clone())
                    .collect(),
                column_types: canonical_column_types,
                rows: request.rows.clone(),
            };
            db.create_table_from_rows(&id, &resolved_request)?
        };

        if display_props.is_empty() {
            display_guard.remove(&id);
        } else {
            display_guard.insert(id.clone(), display_props);
        }

        Ok(ManagedTableCreateResult {
            generation: created.generation,
            dataset: created,
            columns: canonical_columns,
        })
    }

    pub fn add_row(&self, dataset_id: &str) -> Result<i64, AppError> {
        let db = self
            .state
            .db
            .lock()
            .map_err(|e| AppError::Database(e.to_string()))?;
        db.add_row(dataset_id)
    }

    pub fn add_rows(
        &self,
        dataset_id: &str,
        count: usize,
    ) -> Result<crate::models::table::AddedRowsResult, AppError> {
        let db = self
            .state
            .db
            .lock()
            .map_err(|e| AppError::Database(e.to_string()))?;
        let row_ids = db.add_rows(dataset_id, count)?;
        let generation = db.get_dataset_generation(dataset_id)?;
        Ok(crate::models::table::AddedRowsResult {
            row_ids,
            generation,
        })
    }

    pub fn apply_added_rows(
        &self,
        dataset_id: &str,
        row_ids: &[i64],
        undo: bool,
        expected_generation: u64,
    ) -> Result<u64, AppError> {
        let db = self
            .state
            .db
            .lock()
            .map_err(|e| AppError::Database(e.to_string()))?;
        db.apply_added_rows(dataset_id, row_ids, undo, expected_generation)
    }

    pub fn update_cell(
        &self,
        dataset_id: &str,
        row_id: i64,
        column_name: &str,
        value: &str,
    ) -> Result<(), AppError> {
        let db = self
            .state
            .db
            .lock()
            .map_err(|e| AppError::Database(e.to_string()))?;
        reject_calculated_column_writes(&db, dataset_id, [column_name])?;
        db.update_cell(dataset_id, row_id, column_name, value)
    }

    pub fn clear_cells(
        &self,
        dataset_id: &str,
        cells: &[crate::models::table::CellPosition],
    ) -> Result<(), AppError> {
        let db = self
            .state
            .db
            .lock()
            .map_err(|e| AppError::Database(e.to_string()))?;
        reject_calculated_column_writes(
            &db,
            dataset_id,
            cells.iter().map(|cell| cell.column_name.as_str()),
        )?;
        db.clear_cells(dataset_id, cells)
    }

    pub fn update_cells(
        &self,
        dataset_id: &str,
        updates: &[crate::models::table::CellUpdate],
        expected_generation: Option<u64>,
    ) -> Result<u64, AppError> {
        let db = self
            .state
            .db
            .lock()
            .map_err(|e| AppError::Database(e.to_string()))?;
        reject_calculated_column_writes(
            &db,
            dataset_id,
            updates.iter().map(|update| update.column_name.as_str()),
        )?;
        db.update_cells_if_generation(dataset_id, updates, expected_generation)
    }

    pub fn delete_row(&self, dataset_id: &str, row_id: i64) -> Result<(), AppError> {
        let db = self
            .state
            .db
            .lock()
            .map_err(|e| AppError::Database(e.to_string()))?;
        db.delete_row(dataset_id, row_id)
    }

    pub fn delete_rows(&self, dataset_id: &str, row_ids: &[i64]) -> Result<(), AppError> {
        let db = self
            .state
            .db
            .lock()
            .map_err(|e| AppError::Database(e.to_string()))?;
        db.delete_rows(dataset_id, row_ids)
    }

    pub fn delete_rows_with_change_set(
        &self,
        dataset_id: &str,
        row_ids: &[i64],
        expected_generation: Option<u64>,
    ) -> Result<String, AppError> {
        let db = self
            .state
            .db
            .lock()
            .map_err(|e| AppError::Database(e.to_string()))?;
        db.delete_rows_with_change_set(dataset_id, row_ids, expected_generation)
    }

    pub fn delete_columns_with_change_set(
        &self,
        dataset_id: &str,
        column_names: &[String],
        expected_generation: Option<u64>,
    ) -> Result<String, AppError> {
        let db = self
            .state
            .db
            .lock()
            .map_err(|e| AppError::Database(e.to_string()))?;
        db.delete_columns_with_change_set(dataset_id, column_names, expected_generation)
    }

    pub fn alter_column_with_change_set(
        &self,
        dataset_id: &str,
        old_name: &str,
        new_name: &str,
        new_type: &str,
        expected_generation: Option<u64>,
    ) -> Result<String, AppError> {
        let db = self
            .state
            .db
            .lock()
            .map_err(|e| AppError::Database(e.to_string()))?;
        db.alter_column_with_change_set(
            dataset_id,
            old_name,
            new_name,
            new_type,
            expected_generation,
        )
    }

    pub fn alter_columns_type_with_change_set(
        &self,
        dataset_id: &str,
        column_names: &[String],
        new_type: &str,
        expected_generation: Option<u64>,
    ) -> Result<String, AppError> {
        let db = self
            .state
            .db
            .lock()
            .map_err(|e| AppError::Database(e.to_string()))?;
        db.alter_columns_type_with_change_set(
            dataset_id,
            column_names,
            new_type,
            expected_generation,
        )
    }

    pub fn rename_dataset(&self, dataset_id: &str, new_name: &str) -> Result<(), AppError> {
        let db = self
            .state
            .db
            .lock()
            .map_err(|e| AppError::Database(e.to_string()))?;
        db.rename_dataset(dataset_id, new_name)
    }

    pub fn add_column(
        &self,
        dataset_id: &str,
        col_name: &str,
        col_type: &str,
    ) -> Result<(), AppError> {
        let db = self
            .state
            .db
            .lock()
            .map_err(|e| AppError::Database(e.to_string()))?;
        db.add_column(dataset_id, col_name, col_type)
    }

    pub fn add_column_with_change_set(
        &self,
        dataset_id: &str,
        col_name: &str,
        col_type: &str,
        at_index: Option<i32>,
        expected_generation: Option<u64>,
    ) -> Result<String, AppError> {
        let db = self
            .state
            .db
            .lock()
            .map_err(|e| AppError::Database(e.to_string()))?;
        db.add_column_with_change_set(
            dataset_id,
            col_name,
            col_type,
            at_index,
            expected_generation,
        )
    }

    pub fn add_columns_with_change_set(
        &self,
        dataset_id: &str,
        columns: &[crate::models::table::ColumnDefinition],
        at_index: Option<i32>,
        expected_generation: Option<u64>,
    ) -> Result<String, AppError> {
        let db = self
            .state
            .db
            .lock()
            .map_err(|e| AppError::Database(e.to_string()))?;
        let engine_columns = columns
            .iter()
            .map(|column| (column.name.clone(), column.column_type.clone()))
            .collect::<Vec<_>>();
        db.add_columns_with_change_set(dataset_id, &engine_columns, at_index, expected_generation)
    }

    /// Insert a column at a specific visible index and shift any stored display
    /// props (width/format/extras) at/after that index one slot right so they
    /// stay aligned with the new column layout.
    pub fn insert_column_at(
        &self,
        dataset_id: &str,
        col_name: &str,
        col_type: &str,
        at_index: usize,
    ) -> Result<(), AppError> {
        {
            let db = self
                .state
                .db
                .lock()
                .map_err(|e| AppError::Database(e.to_string()))?;
            db.insert_column_at(dataset_id, col_name, col_type, at_index as i32)?;
        }
        let mut display = self
            .state
            .column_display
            .lock()
            .map_err(|e| AppError::Database(e.to_string()))?;
        if let Some(props) = display.get_mut(dataset_id) {
            for p in props.iter_mut() {
                if p.col_index >= at_index {
                    p.col_index += 1;
                }
            }
        }
        Ok(())
    }

    /// Move a column from visible index `from` to `to`, remapping stored display
    /// props so they follow their column to the new position.
    pub fn reorder_column(&self, dataset_id: &str, from: usize, to: usize) -> Result<(), AppError> {
        {
            let db = self
                .state
                .db
                .lock()
                .map_err(|e| AppError::Database(e.to_string()))?;
            db.reorder_column(dataset_id, from as i32, to as i32)?;
        }
        if from == to {
            return Ok(());
        }
        let mut display = self
            .state
            .column_display
            .lock()
            .map_err(|e| AppError::Database(e.to_string()))?;
        if let Some(props) = display.get_mut(dataset_id) {
            for p in props.iter_mut() {
                p.col_index = remap_moved_index(p.col_index, from, to);
            }
        }
        Ok(())
    }

    pub fn reorder_column_if_generation(
        &self,
        dataset_id: &str,
        from: usize,
        to: usize,
        expected_generation: u64,
    ) -> Result<u64, AppError> {
        let generation = {
            let db = self
                .state
                .db
                .lock()
                .map_err(|e| AppError::Database(e.to_string()))?;
            let from_index = i32::try_from(from)
                .map_err(|_| AppError::InvalidParam("source column index is too large".into()))?;
            let to_index = i32::try_from(to)
                .map_err(|_| AppError::InvalidParam("target column index is too large".into()))?;
            db.reorder_column_if_generation(dataset_id, from_index, to_index, expected_generation)?
        };
        let mut display = self
            .state
            .column_display
            .lock()
            .map_err(|e| AppError::Database(e.to_string()))?;
        if let Some(props) = display.get_mut(dataset_id) {
            for property in props.iter_mut() {
                property.col_index = remap_moved_index(property.col_index, from, to);
            }
        }
        Ok(generation)
    }

    pub fn delete_column(&self, dataset_id: &str, col_name: &str) -> Result<(), AppError> {
        let db = self
            .state
            .db
            .lock()
            .map_err(|e| AppError::Database(e.to_string()))?;
        db.delete_column(dataset_id, col_name)
    }

    pub fn rename_column(
        &self,
        dataset_id: &str,
        old_name: &str,
        new_name: &str,
    ) -> Result<(), AppError> {
        let db = self
            .state
            .db
            .lock()
            .map_err(|e| AppError::Database(e.to_string()))?;
        db.rename_column(dataset_id, old_name, new_name)
    }

    pub fn change_column_type(
        &self,
        dataset_id: &str,
        col_name: &str,
        new_type: &str,
    ) -> Result<(), AppError> {
        let db = self
            .state
            .db
            .lock()
            .map_err(|e| AppError::Database(e.to_string()))?;
        db.change_column_type(dataset_id, col_name, new_type)
    }

    pub fn paste_at_position(
        &self,
        dataset_id: &str,
        start_row: usize,
        start_col: usize,
        rows: &[Vec<String>],
        header_names: Option<&[String]>,
        col_types: &[String],
        expected_generation: Option<u64>,
    ) -> Result<(), AppError> {
        let db = self
            .state
            .db
            .lock()
            .map_err(|e| AppError::Database(e.to_string()))?;
        db.paste_at_position_if_generation(
            dataset_id,
            start_row,
            start_col,
            rows,
            header_names,
            col_types,
            expected_generation,
        )
    }

    pub fn paste_at_position_with_change_set(
        &self,
        dataset_id: &str,
        start_row: usize,
        start_col: usize,
        rows: &[Vec<String>],
        header_names: Option<&[String]>,
        col_types: &[String],
        expected_generation: Option<u64>,
    ) -> Result<String, AppError> {
        let db = self
            .state
            .db
            .lock()
            .map_err(|e| AppError::Database(e.to_string()))?;
        db.paste_at_position_with_change_set(
            dataset_id,
            start_row,
            start_col,
            rows,
            header_names,
            col_types,
            expected_generation,
        )
    }

    pub fn apply_change_set(&self, change_set_id: &str, undo: bool) -> Result<(), AppError> {
        let db = self
            .state
            .db
            .lock()
            .map_err(|e| AppError::Database(e.to_string()))?;
        db.apply_change_set(change_set_id, undo)
    }

    pub fn drop_change_set(&self, change_set_id: &str) -> Result<(), AppError> {
        let db = self
            .state
            .db
            .lock()
            .map_err(|e| AppError::Database(e.to_string()))?;
        db.drop_change_set(change_set_id)
    }

    pub fn restore_snapshot(
        &self,
        dataset_id: &str,
        col_names: &[String],
        col_types: &[String],
        rows: &[Vec<serde_json::Value>],
    ) -> Result<(), AppError> {
        let db = self
            .state
            .db
            .lock()
            .map_err(|e| AppError::Database(e.to_string()))?;
        db.restore_snapshot(dataset_id, col_names, col_types, rows)
    }

    // ─── Table Operations ───

    pub fn get_columns(&self, dataset_id: &str) -> Result<Vec<(String, String)>, AppError> {
        let db = self
            .state
            .db
            .lock()
            .map_err(|e| AppError::Database(e.to_string()))?;
        db.get_user_columns(dataset_id)
    }

    pub fn get_column_descriptors(
        &self,
        dataset_id: &str,
    ) -> Result<Vec<crate::models::table::ColumnDescriptor>, AppError> {
        let db = self
            .state
            .db
            .lock()
            .map_err(|e| AppError::Database(e.to_string()))?;
        db.get_table_column_descriptors(dataset_id)
    }

    pub fn sort_table(
        &self,
        source_id: &str,
        sort_cols: &[String],
        sort_orders: &[String],
        new_name: &str,
    ) -> Result<DatasetMeta, AppError> {
        let db = self
            .state
            .db
            .lock()
            .map_err(|e| AppError::Database(e.to_string()))?;
        let id = uuid::Uuid::new_v4().to_string();
        let resolved_name = Self::resolve_create_dataset_name(&db, new_name)?;
        db.sort_table(&id, &resolved_name, source_id, sort_cols, sort_orders)
    }

    pub fn subset_table(
        &self,
        source_id: &str,
        columns: &[String],
        row_filter: Option<&str>,
        new_name: &str,
    ) -> Result<DatasetMeta, AppError> {
        let db = self
            .state
            .db
            .lock()
            .map_err(|e| AppError::Database(e.to_string()))?;
        let id = uuid::Uuid::new_v4().to_string();
        let resolved_name = Self::resolve_create_dataset_name(&db, new_name)?;
        db.subset_table(&id, &resolved_name, source_id, columns, row_filter)
    }

    pub fn transpose_table(
        &self,
        source_id: &str,
        new_name: &str,
    ) -> Result<DatasetMeta, AppError> {
        let db = self
            .state
            .db
            .lock()
            .map_err(|e| AppError::Database(e.to_string()))?;
        let id = uuid::Uuid::new_v4().to_string();
        let resolved_name = Self::resolve_create_dataset_name(&db, new_name)?;
        db.transpose_table(&id, &resolved_name, source_id)
    }

    pub fn stack_table(
        &self,
        source_id: &str,
        stack_cols: &[String],
        id_cols: &[String],
        new_name: &str,
    ) -> Result<DatasetMeta, AppError> {
        let db = self
            .state
            .db
            .lock()
            .map_err(|e| AppError::Database(e.to_string()))?;
        let id = uuid::Uuid::new_v4().to_string();
        let resolved_name = Self::resolve_create_dataset_name(&db, new_name)?;
        db.stack_table(&id, &resolved_name, source_id, stack_cols, id_cols)
    }

    pub fn split_table(
        &self,
        source_id: &str,
        split_col: &str,
        value_col: &str,
        id_cols: &[String],
        new_name: &str,
    ) -> Result<DatasetMeta, AppError> {
        let db = self
            .state
            .db
            .lock()
            .map_err(|e| AppError::Database(e.to_string()))?;
        let id = uuid::Uuid::new_v4().to_string();
        let resolved_name = Self::resolve_create_dataset_name(&db, new_name)?;
        db.split_table(
            &id,
            &resolved_name,
            source_id,
            split_col,
            value_col,
            id_cols,
        )
    }

    pub fn summary_table(
        &self,
        source_id: &str,
        stat_cols: &[String],
        group_cols: &[String],
        statistics: &[String],
        new_name: &str,
    ) -> Result<DatasetMeta, AppError> {
        let db = self
            .state
            .db
            .lock()
            .map_err(|e| AppError::Database(e.to_string()))?;
        let id = uuid::Uuid::new_v4().to_string();
        let resolved_name = Self::resolve_create_dataset_name(&db, new_name)?;
        db.summary_table(
            &id,
            &resolved_name,
            source_id,
            stat_cols,
            group_cols,
            statistics,
        )
    }

    pub fn join_tables(
        &self,
        left_id: &str,
        right_id: &str,
        join_type: &str,
        left_key: &str,
        right_key: &str,
        new_name: &str,
    ) -> Result<DatasetMeta, AppError> {
        let db = self
            .state
            .db
            .lock()
            .map_err(|e| AppError::Database(e.to_string()))?;
        let id = uuid::Uuid::new_v4().to_string();
        let resolved_name = Self::resolve_create_dataset_name(&db, new_name)?;
        db.join_tables(
            &id,
            &resolved_name,
            left_id,
            right_id,
            join_type,
            left_key,
            right_key,
        )
    }

    pub fn update_table(
        &self,
        left_id: &str,
        right_id: &str,
        match_col: &str,
        update_cols: &[String],
    ) -> Result<(), AppError> {
        let db = self
            .state
            .db
            .lock()
            .map_err(|e| AppError::Database(e.to_string()))?;
        db.update_table(left_id, right_id, match_col, update_cols)
    }

    pub fn concatenate_tables(
        &self,
        source_ids: &[String],
        new_name: &str,
    ) -> Result<DatasetMeta, AppError> {
        let db = self
            .state
            .db
            .lock()
            .map_err(|e| AppError::Database(e.to_string()))?;
        let id = uuid::Uuid::new_v4().to_string();
        let resolved_name = Self::resolve_create_dataset_name(&db, new_name)?;
        db.concatenate_tables(&id, &resolved_name, source_ids)
    }
}
