use std::collections::HashSet;
use std::sync::MutexGuard;

use duckdb::appender_params_from_iter;
use duckdb::types::Value as DuckValue;
use serde_json::Value;

use crate::engine::duckdb_engine::{ArchiveColumnPlan, DuckDbEngine};
use crate::error::AppError;
use crate::models::calculated_column::ArchivedCalculatedColumn;
use crate::models::table::{ColumnDisplayProps, ColumnFormatInfo};
use crate::services::archive_cell::is_archive_scalar_type;
use crate::services::project_service::{
    formula_archive_inconsistent, json_to_duckdb_param, table_doc_is_v3,
    table_doc_to_archive_column_plans, validate_restored_ready_calculated_columns,
};
use crate::services::spprj_archive::{self, TableDoc};
use crate::services::streaming_table_reader::{StreamedTableHeader, TableBatchSink};
use crate::state::AppState;

const RESTORE_BATCH_ROWS: usize = 5_000;

pub(crate) struct ProjectTableRestoreSession<'a> {
    state: &'a AppState,
    db: MutexGuard<'a, DuckDbEngine>,
    header: StreamedTableHeader,
    canonical_columns: Vec<(String, String)>,
    calculated_columns_by_id: Option<std::collections::HashMap<String, ArchivedCalculatedColumn>>,
    archive_columns: Option<Vec<ArchiveColumnPlan>>,
    row_ids: HashSet<i64>,
    rows_written: usize,
    rows_total: Option<usize>,
    progress: Option<&'a dyn Fn(usize, usize)>,
}

impl<'a> ProjectTableRestoreSession<'a> {
    pub(crate) fn begin(
        state: &'a AppState,
        header: StreamedTableHeader,
        rows_total: Option<usize>,
        progress: Option<&'a dyn Fn(usize, usize)>,
    ) -> Result<Self, AppError> {
        if header.version != "1" && header.version != "2" && !table_doc_is_v3(&header.version) {
            return Err(AppError::InvalidParam(format!(
                "unsupported table document version: {}",
                header.version
            )));
        }

        let metadata_doc = TableDoc {
            id: header.id.clone(),
            name: header.name.clone(),
            source_type: header.source_type.clone(),
            version: header.version.clone(),
            columns: header.columns.clone(),
            rows: Vec::new(),
        };
        let v3_validation = if table_doc_is_v3(&header.version) {
            Some(
                spprj_archive::validate_table_doc_structure(&metadata_doc).map_err(|error| {
                    match error {
                        AppError::FileIO(message)
                            if message.contains("calculated column graph invalid") =>
                        {
                            formula_archive_inconsistent(message)
                        }
                        other => other,
                    }
                })?,
            )
        } else {
            None
        };
        let archive_columns = v3_validation
            .as_ref()
            .map(|validation| {
                table_doc_to_archive_column_plans(
                    &metadata_doc,
                    Some(&validation.calculated_columns_by_id),
                )
            })
            .transpose()?;
        let calculated_columns_by_id =
            v3_validation.map(|validation| validation.calculated_columns_by_id);

        let archived_col_names = header
            .columns
            .iter()
            .map(|column| column.name.clone())
            .collect::<Vec<_>>();
        let col_names = DuckDbEngine::remap_internal_user_column_names(&archived_col_names)?;
        let col_types = header
            .columns
            .iter()
            .map(|column| column.col_type.clone())
            .collect::<Vec<_>>();
        let db = state
            .db
            .lock()
            .map_err(|error| AppError::Database(error.to_string()))?;
        db.conn().execute_batch("BEGIN TRANSACTION")?;
        let create_result = (|| {
            db.create_empty_table(&header.id, &header.name, &col_names, &col_types)?;
            db.get_user_columns(&header.id)
        })();
        let canonical_columns = match create_result {
            Ok(columns) => columns,
            Err(error) => {
                let _ = db.conn().execute_batch("ROLLBACK");
                return Err(error);
            }
        };
        Ok(Self {
            state,
            db,
            header,
            canonical_columns,
            calculated_columns_by_id,
            archive_columns,
            row_ids: HashSet::with_capacity(rows_total.unwrap_or_default()),
            rows_written: 0,
            rows_total,
            progress,
        })
    }

    pub(crate) fn append_rows(&mut self, rows: &[Vec<Value>]) -> Result<(), AppError> {
        let expected_row_width = self.header.columns.len() + 1;
        for row in rows {
            if row.len() != expected_row_width {
                return Err(AppError::InvalidParam(format!(
                    "table rows must contain exactly {expected_row_width} values"
                )));
            }
            let row_id = row[0]
                .as_i64()
                .ok_or_else(|| AppError::InvalidParam("table row IDs must be integers".into()))?;
            if row_id <= 0 {
                return Err(AppError::InvalidParam(
                    "table row IDs must be positive".into(),
                ));
            }
            if !self.row_ids.insert(row_id) {
                return Err(AppError::InvalidParam(
                    "table row IDs must be unique".into(),
                ));
            }
        }

        if rows.is_empty() {
            return Ok(());
        }

        {
            let table_name = format!("dataset_{}", self.header.id.replace('-', "_"));
            let mut appender = self.db.conn().appender(&table_name)?;
            for row in rows {
                let mut values = row
                    .iter()
                    .enumerate()
                    .map(|(index, value)| {
                        let column_type = index
                            .checked_sub(1)
                            .map(|column_index| self.canonical_columns[column_index].1.as_str());
                        let decode_archive_tag = index > 0
                            && self.header.version != "1"
                            && !is_archive_scalar_type(&self.canonical_columns[index - 1].1);
                        json_to_duckdb_param(value, decode_archive_tag, column_type)
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                values.push(DuckValue::Null);
                appender.append_row(appender_params_from_iter(values))?;
            }
            appender.flush()?;
        }

        let previous_rows_written = self.rows_written;
        self.rows_written += rows.len();
        if let Some(progress) = self.progress {
            match self.rows_total {
                Some(total) => {
                    let mut milestone =
                        ((previous_rows_written / RESTORE_BATCH_ROWS) + 1) * RESTORE_BATCH_ROWS;
                    while milestone <= self.rows_written && milestone <= total {
                        progress(milestone, total);
                        milestone += RESTORE_BATCH_ROWS;
                    }
                    if self.rows_written == total && self.rows_written % RESTORE_BATCH_ROWS != 0 {
                        progress(self.rows_written, total);
                    }
                }
                None => progress(self.rows_written, 0),
            }
        }
        Ok(())
    }

    pub(crate) fn finish(self) -> Result<String, AppError> {
        let display_props = self
            .header
            .columns
            .iter()
            .enumerate()
            .filter(|(_, column)| {
                column.width.is_some() || column.format.is_some() || column.extras.is_some()
            })
            .map(|(col_index, column)| ColumnDisplayProps {
                col_index,
                width: column.width,
                format: column.format.as_ref().map(|format| ColumnFormatInfo {
                    kind: format.kind.clone(),
                    decimals: format.decimals,
                    currency: format.currency.clone(),
                }),
                extras: column.extras.clone(),
            })
            .collect::<Vec<_>>();
        let restore_result = (|| {
            let table_ident = DuckDbEngine::quote_identifier(&format!(
                "dataset_{}",
                self.header.id.replace('-', "_")
            ));
            let row_count: i64 = self.db.conn().query_row(
                &format!("SELECT COUNT(*) FROM {table_ident}"),
                [],
                |row| row.get(0),
            )?;
            self.db.conn().execute(
                "UPDATE _meta_datasets SET row_count = $1 WHERE id = $2",
                duckdb::params![row_count, self.header.id],
            )?;
            if let Some(calculated_columns_by_id) = &self.calculated_columns_by_id {
                let doc = TableDoc {
                    id: self.header.id.clone(),
                    name: self.header.name.clone(),
                    source_type: self.header.source_type.clone(),
                    version: self.header.version.clone(),
                    columns: self.header.columns.clone(),
                    rows: Vec::new(),
                };
                validate_restored_ready_calculated_columns(
                    &self.db,
                    &doc,
                    calculated_columns_by_id,
                )?;
            }
            if let Some(archive_columns) = &self.archive_columns {
                self.db
                    .replace_archive_column_ids(&self.header.id, archive_columns)?;
                self.db
                    .replace_archived_calculated_columns(&self.header.id, archive_columns)?;
            } else {
                self.db
                    .replace_archived_calculated_columns(&self.header.id, &[])?;
            }
            self.state
                .column_display
                .lock()
                .map_err(|error| AppError::Database(error.to_string()))
        })();

        let mut display = match restore_result {
            Ok(display) => display,
            Err(error) => {
                let _ = self.db.conn().execute_batch("ROLLBACK");
                return Err(error);
            }
        };
        if let Err(error) = self.db.conn().execute_batch("COMMIT") {
            let _ = self.db.conn().execute_batch("ROLLBACK");
            return Err(error.into());
        }
        drop(self.db);

        if !display_props.is_empty() {
            display.insert(self.header.id.clone(), display_props);
        }

        Ok(self.header.id)
    }

    pub(crate) fn abort(self, error: AppError) -> AppError {
        let _ = self.db.conn().execute_batch("ROLLBACK");
        error
    }
}

impl TableBatchSink for ProjectTableRestoreSession<'_> {
    fn begin_table(&mut self, header: &StreamedTableHeader) -> Result<(), AppError> {
        if self.header.id != header.id {
            return Err(AppError::FileIO("streamed table header changed".into()));
        }
        Ok(())
    }

    fn append_rows(&mut self, rows: &[Vec<Value>]) -> Result<(), AppError> {
        ProjectTableRestoreSession::append_rows(self, rows)
    }

    fn finish_table(&mut self, row_count: usize) -> Result<(), AppError> {
        if row_count != self.rows_written {
            return Err(AppError::FileIO(format!(
                "streamed row count mismatch: parsed {row_count}, restored {}",
                self.rows_written
            )));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::collections::BTreeMap;

    use duckdb::types::Value as DuckValue;

    use super::ProjectTableRestoreSession;
    use crate::models::calculated_column::{
        definition_fingerprint, ArchivedCalculatedColumn, ArchivedCalculatedColumnState,
        CalculatedBinaryOperatorV1, CalculatedColumnDefinitionV1, CalculatedExpressionV1,
        CalculatedOutputTypeV1,
    };
    use crate::models::table::ColumnDisplayProps;
    use crate::services::project_service::ProjectService;
    use crate::services::spprj_archive::{TableColumn, TableColumnFormat, TableDoc};
    use crate::services::streaming_table_reader::StreamedTableHeader;
    use crate::state::AppState;

    #[derive(Debug)]
    struct RestoredTableObservation {
        rows: Vec<Vec<DuckValue>>,
        columns: Vec<(String, String)>,
        display: Vec<ColumnDisplayProps>,
        calculated: Vec<ArchivedCalculatedColumn>,
    }

    fn calculated_column() -> ArchivedCalculatedColumn {
        let expression = CalculatedExpressionV1::Binary {
            operator: CalculatedBinaryOperatorV1::Multiply,
            left: Box::new(CalculatedExpressionV1::ColumnRef {
                column_id: "10000000-0000-4000-8000-000000000001".into(),
            }),
            right: Box::new(CalculatedExpressionV1::NumberLiteral { value: 2.into() }),
        };
        let mut definition = CalculatedColumnDefinitionV1 {
            formula_id: "20000000-0000-4000-8000-000000000001".into(),
            schema_version: "1".into(),
            output_column_id: "10000000-0000-4000-8000-000000000003".into(),
            dependency_column_ids: vec!["10000000-0000-4000-8000-000000000001".into()],
            expression,
            inferred_output_type: CalculatedOutputTypeV1::Continuous,
            fingerprint: String::new(),
        };
        definition.fingerprint = definition_fingerprint(&definition);
        ArchivedCalculatedColumn::Ready {
            definition,
            state: ArchivedCalculatedColumnState::default(),
        }
    }

    fn mixed_archive_table_doc() -> TableDoc {
        let mut extras = BTreeMap::new();
        extras.insert("unit".into(), serde_json::json!("widgets"));
        TableDoc {
            id: "table-1".into(),
            name: "Mixed archive".into(),
            source_type: "manual".into(),
            version: "3".into(),
            columns: vec![
                TableColumn {
                    column_id: Some("10000000-0000-4000-8000-000000000001".into()),
                    name: "base".into(),
                    col_type: "DOUBLE".into(),
                    width: Some(120.0),
                    format: Some(TableColumnFormat {
                        kind: "number".into(),
                        decimals: Some(0),
                        currency: None,
                    }),
                    extras: Some(extras),
                    calculated: None,
                },
                TableColumn {
                    column_id: Some("10000000-0000-4000-8000-000000000002".into()),
                    name: "items".into(),
                    col_type: "INTEGER[]".into(),
                    ..Default::default()
                },
                TableColumn {
                    column_id: Some("10000000-0000-4000-8000-000000000003".into()),
                    name: "double_base".into(),
                    col_type: "DOUBLE".into(),
                    calculated: Some(calculated_column()),
                    ..Default::default()
                },
            ],
            rows: vec![
                vec![
                    serde_json::json!(1),
                    serde_json::json!(4.0),
                    serde_json::json!({"$duckdbValue": "[1, 2]"}),
                    serde_json::json!(8.0),
                ],
                vec![
                    serde_json::json!(2),
                    serde_json::Value::Null,
                    serde_json::Value::Null,
                    serde_json::Value::Null,
                ],
            ],
        }
    }

    fn observe(state: &AppState, dataset_id: &str) -> RestoredTableObservation {
        let db = state.db.lock().unwrap();
        let columns = db.get_user_columns(dataset_id).unwrap();
        let mut statement = db
            .conn()
            .prepare(
                "SELECT _row_id, base, items, double_base \
                 FROM dataset_table_1 ORDER BY _row_id",
            )
            .unwrap();
        let rows = statement
            .query_map([], |row| {
                Ok(vec![
                    row.get::<_, DuckValue>(0)?,
                    row.get::<_, DuckValue>(1)?,
                    row.get::<_, DuckValue>(2)?,
                    row.get::<_, DuckValue>(3)?,
                ])
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        let calculated = db
            .get_archived_calculated_columns_by_id(dataset_id)
            .unwrap()
            .into_values()
            .collect();
        drop(statement);
        drop(db);
        let display = state
            .column_display
            .lock()
            .unwrap()
            .get(dataset_id)
            .cloned()
            .unwrap_or_default();
        RestoredTableObservation {
            rows,
            columns,
            display,
            calculated,
        }
    }

    fn restore_with_existing_buffered_path(doc: &TableDoc) -> RestoredTableObservation {
        let state = AppState::new().unwrap();
        ProjectService::new(&state).restore_table_doc(doc).unwrap();
        observe(&state, &doc.id)
    }

    fn restore_in_two_batches(doc: &TableDoc) -> RestoredTableObservation {
        let state = AppState::new().unwrap();
        let header = StreamedTableHeader {
            id: doc.id.clone(),
            name: doc.name.clone(),
            source_type: doc.source_type.clone(),
            version: doc.version.clone(),
            columns: doc.columns.clone(),
        };
        let mut session =
            ProjectTableRestoreSession::begin(&state, header, Some(doc.rows.len()), None).unwrap();
        session.append_rows(&doc.rows[..1]).unwrap();
        session.append_rows(&doc.rows[1..]).unwrap();
        session.finish().unwrap();
        observe(&state, &doc.id)
    }

    fn basic_streamed_header() -> StreamedTableHeader {
        StreamedTableHeader {
            id: "table-1".into(),
            name: "Basic".into(),
            source_type: "manual".into(),
            version: "1".into(),
            columns: vec![TableColumn {
                name: "value".into(),
                col_type: "INTEGER".into(),
                ..Default::default()
            }],
        }
    }

    fn json_row(row_id: i64, value: i64) -> Vec<serde_json::Value> {
        vec![serde_json::json!(row_id), serde_json::json!(value)]
    }

    #[test]
    fn restore_session_matches_buffered_restore_values_and_metadata() {
        let doc = mixed_archive_table_doc();
        let expected = restore_with_existing_buffered_path(&doc);
        let actual = restore_in_two_batches(&doc);
        assert_eq!(actual.rows, expected.rows);
        assert_eq!(actual.columns, expected.columns);
        assert_eq!(
            serde_json::to_value(&actual.display).unwrap(),
            serde_json::to_value(&expected.display).unwrap()
        );
        assert_eq!(actual.calculated, expected.calculated);
        assert_eq!(
            actual.columns,
            vec![
                ("base".into(), "DOUBLE".into()),
                ("items".into(), "INTEGER[]".into()),
                ("double_base".into(), "DOUBLE".into()),
            ]
        );
        assert_eq!(
            serde_json::to_value(&actual.display).unwrap(),
            serde_json::json!([{
                "colIndex": 0,
                "width": 120.0,
                "format": {"kind": "number", "decimals": 0},
                "extras": {"unit": "widgets"}
            }])
        );
        assert_eq!(actual.calculated, vec![calculated_column()]);
        assert_eq!(
            &actual.rows[0][..2],
            &[DuckValue::Int(1), DuckValue::Double(4.0)]
        );
        assert_ne!(actual.rows[0][2], DuckValue::Null);
        assert_eq!(actual.rows[0][3], DuckValue::Double(8.0));
        assert_eq!(
            actual.rows[1],
            vec![
                DuckValue::Int(2),
                DuckValue::Null,
                DuckValue::Null,
                DuckValue::Null,
            ]
        );
    }

    #[test]
    fn restore_session_rolls_back_duplicate_row_id() {
        let state = AppState::new().unwrap();
        let mut session =
            ProjectTableRestoreSession::begin(&state, basic_streamed_header(), None, None).unwrap();
        let error = session
            .append_rows(&[json_row(1, 10), json_row(1, 20)])
            .unwrap_err();
        let _ = session.abort(error);

        assert!(state
            .db
            .lock()
            .unwrap()
            .get_dataset_meta("table-1")
            .is_err());
    }

    #[test]
    fn restore_session_reports_indeterminate_progress_in_bounded_steps() {
        let state = AppState::new().unwrap();
        let progress = RefCell::new(Vec::new());
        let callback = |done, total| progress.borrow_mut().push((done, total));
        let mut session = ProjectTableRestoreSession::begin(
            &state,
            basic_streamed_header(),
            None,
            Some(&callback),
        )
        .unwrap();
        let rows = (1..=12_000)
            .map(|row_id| json_row(row_id, row_id))
            .collect::<Vec<_>>();
        session.append_rows(&rows[..5_000]).unwrap();
        session.append_rows(&rows[5_000..10_000]).unwrap();
        session.append_rows(&rows[10_000..]).unwrap();
        session.finish().unwrap();

        assert_eq!(
            progress.into_inner(),
            vec![(5_000, 0), (10_000, 0), (12_000, 0)]
        );
    }

    #[test]
    fn restore_session_rolls_back_when_display_lock_is_poisoned() {
        let state = AppState::new().unwrap();
        let mut header = basic_streamed_header();
        header.columns[0].width = Some(80.0);
        let mut session = ProjectTableRestoreSession::begin(&state, header, Some(1), None).unwrap();
        session.append_rows(&[json_row(1, 10)]).unwrap();
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _display = state.column_display.lock().unwrap();
            panic!("poison display mutex");
        }));

        let error = session.finish().unwrap_err();

        assert!(matches!(error, crate::error::AppError::Database(_)));
        assert!(state
            .db
            .lock()
            .unwrap()
            .get_dataset_meta("table-1")
            .is_err());
    }
}
