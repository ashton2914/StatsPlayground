//! Standalone archived tables stream directly into the owning project transaction.
use crate::{
    engine::duckdb_engine::{ArchiveColumnPlan, DuckDbEngine, NATURAL_ORDER_STRIDE},
    error::AppError,
    models::{
        calculated_column::ArchivedCalculatedColumn,
        project_persistence::*,
        table::{
            ColumnDisplayProps, ColumnDisplayPropsWithoutIndex, ColumnFormatInfo, DatasetMeta,
        },
    },
    services::{
        project_catalog::ProjectCatalog,
        project_database::ProjectDatabase,
        project_service::{self, json_to_duckdb_param},
        spprj_archive::TableDoc,
        streaming_table_reader::{self, StreamedTableHeader, TableBatchSink, TableHeaderScan},
    },
};
use duckdb::{appender_params_from_iter, params, types::Value as DuckValue};
use serde_json::Value;
use std::{collections::HashMap, path::Path};

/// The enclosing project commit owns rollback, publication and the sole writer.
pub(crate) struct NativeTableRestoreSink<'a> {
    engine: &'a DuckDbEngine,
    doc: TableDoc,
    canonical_columns: Vec<(String, String)>,
    calculated: Option<HashMap<String, ArchivedCalculatedColumn>>,
    plans: Option<Vec<ArchiveColumnPlan>>,
    display: Vec<ColumnDisplayProps>,
    cancelled: &'a dyn Fn() -> bool,
    rows_written: usize,
    max_row_id: i64,
}
impl<'a> NativeTableRestoreSink<'a> {
    pub(crate) fn begin(
        engine: &'a DuckDbEngine,
        doc: TableDoc,
        cancelled: &'a dyn Fn() -> bool,
    ) -> Result<Self, AppError> {
        if doc.version != "1"
            && doc.version != "2"
            && !project_service::table_doc_is_v3(&doc.version)
        {
            return Err(AppError::InvalidParam(
                "project_table_version_unsupported".into(),
            ));
        }
        let validation = if project_service::table_doc_is_v3(&doc.version) {
            Some(super::spprj_archive::validate_table_doc_structure(&doc)?)
        } else {
            None
        };
        let plans = validation
            .as_ref()
            .map(|value| {
                project_service::table_doc_to_archive_column_plans(
                    &doc,
                    Some(&value.calculated_columns_by_id),
                )
            })
            .transpose()?;
        let display = doc
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
        for props in &display {
            super::data_service::DataService::validate_display_without_index(
                &ColumnDisplayPropsWithoutIndex {
                    width: props.width,
                    format: props.format.clone(),
                    extras: props.extras.clone(),
                },
            )?;
        }
        let names = DuckDbEngine::remap_internal_user_column_names(
            &doc.columns
                .iter()
                .map(|column| column.name.clone())
                .collect::<Vec<_>>(),
        )?;
        engine.create_empty_table(
            &doc.id,
            &doc.name,
            &names,
            &doc.columns
                .iter()
                .map(|column| column.col_type.clone())
                .collect::<Vec<_>>(),
        )?;
        let physical = DuckDbEngine::quote_identifier(&DuckDbEngine::internal_table_name(&doc.id));
        let index = DuckDbEngine::quote_identifier(&format!(
            "project_import_rows_{}",
            doc.id.replace('-', "_")
        ));
        engine.conn().execute_batch(&format!("ALTER TABLE {physical} ALTER COLUMN _row_id SET DATA TYPE BIGINT; CREATE UNIQUE INDEX {index} ON {physical}(_row_id)"))?;
        let canonical_columns = engine.get_user_columns(&doc.id)?;
        Ok(Self {
            engine,
            doc,
            canonical_columns,
            calculated: validation.map(|value| value.calculated_columns_by_id),
            plans,
            display,
            cancelled,
            rows_written: 0,
            max_row_id: 0,
        })
    }
    pub(crate) fn finish(self) -> Result<(DatasetMeta, Vec<ColumnDisplayProps>), AppError> {
        if (self.cancelled)() {
            return Err(AppError::Cancelled("import_cancelled".into()));
        }
        let count = i64::try_from(self.rows_written)
            .map_err(|_| AppError::InvalidParam("project_row_count_exhausted".into()))?;
        self.engine.conn().execute(
            "UPDATE _meta_datasets SET row_count=?,next_row_id=?,source_type=? WHERE id=?",
            params![
                count,
                self.max_row_id.saturating_add(1),
                &self.doc.source_type,
                &self.doc.id
            ],
        )?;
        if let Some(calculated) = &self.calculated {
            project_service::validate_restored_ready_calculated_columns(
                self.engine,
                &self.doc,
                calculated,
            )?;
        }
        if let Some(plans) = &self.plans {
            self.engine
                .replace_archive_column_ids(&self.doc.id, plans)?;
            self.engine
                .replace_archived_calculated_columns(&self.doc.id, plans)?;
        } else {
            self.engine
                .replace_archived_calculated_columns(&self.doc.id, &[])?;
        }
        self.engine.rebuild_natural_anchors(&self.doc.id, 0)?;
        Ok((self.engine.get_dataset_meta(&self.doc.id)?, self.display))
    }
}
impl TableBatchSink for NativeTableRestoreSink<'_> {
    fn begin_table(&mut self, _header: &StreamedTableHeader) -> Result<(), AppError> {
        Ok(())
    }
    fn append_rows(&mut self, rows: &[Vec<Value>]) -> Result<(), AppError> {
        if (self.cancelled)() {
            return Err(AppError::Cancelled("import_cancelled".into()));
        }
        let width = self.doc.columns.len() + 1;
        for row in rows {
            if row.len() != width {
                return Err(AppError::InvalidParam(
                    "project_table_row_width_invalid".into(),
                ));
            }
            let id = row[0]
                .as_i64()
                .filter(|id| *id > 0)
                .ok_or_else(|| AppError::InvalidParam("project_table_row_id_invalid".into()))?;
            self.max_row_id = self.max_row_id.max(id);
        }
        if rows.is_empty() {
            return Ok(());
        }
        let physical = DuckDbEngine::internal_table_name(&self.doc.id);
        let mut appender = self.engine.conn().appender(&physical)?;
        for (offset, row) in rows.iter().enumerate() {
            let mut values = row
                .iter()
                .enumerate()
                .map(|(index, value)| {
                    let kind = index
                        .checked_sub(1)
                        .map(|index| self.canonical_columns[index].1.as_str());
                    let tagged = index > 0
                        && self.doc.version != "1"
                        && !super::archive_cell::is_archive_scalar_type(
                            &self.canonical_columns[index - 1].1,
                        );
                    json_to_duckdb_param(value, tagged, kind)
                })
                .collect::<Result<Vec<_>, _>>()?;
            let ordinal = self
                .rows_written
                .checked_add(offset)
                .and_then(|value| value.checked_add(1))
                .ok_or_else(|| AppError::InvalidParam("project_row_count_exhausted".into()))?;
            let order = i128::try_from(ordinal)
                .ok()
                .and_then(|value| value.checked_mul(NATURAL_ORDER_STRIDE))
                .ok_or_else(|| AppError::InvalidParam("project_row_order_exhausted".into()))?;
            values.push(DuckValue::HugeInt(order));
            appender.append_row(appender_params_from_iter(values.iter()))?;
        }
        appender.flush()?;
        #[cfg(any(test, feature="perf-harness"))]
        super::project_work_counters::restored_rows(rows.len());
        self.rows_written = self
            .rows_written
            .checked_add(rows.len())
            .ok_or_else(|| AppError::InvalidParam("project_row_count_exhausted".into()))?;
        Ok(())
    }
    fn finish_table(&mut self, count: usize) -> Result<(), AppError> {
        if count != self.rows_written {
            return Err(AppError::InvalidParam(
                "project_table_row_count_invalid".into(),
            ));
        }
        Ok(())
    }
}

impl ProjectDatabase {
    pub(crate) fn import_project_table_file(
        &self,
        context: &ProjectWriteContext,
        file_path: &str,
        cancelled: impl Fn() -> bool,
    ) -> Result<ProjectCommit<ProjectTableImportResult>, AppError> {
        self.commit_with_effects(context, &("import_table", file_path), |engine| {
            if cancelled() {
                return Err(AppError::Cancelled("import_cancelled".into()));
            }
            let path = Path::new(file_path);
            let stamp = super::project_output::SourceStamp::read(path)?;
            let original =
                match streaming_table_reader::scan_table_header(std::fs::File::open(path)?)? {
                    TableHeaderScan::Canonical(header) => header,
                    TableHeaderScan::RequiresBufferedCompatibility => {
                        streaming_table_reader::scan_complete_table_header(std::fs::File::open(
                            path,
                        )?)?
                    }
                };
            let metadata = TableDoc {
                id: original.id.clone(),
                name: original.name.clone(),
                source_type: original.source_type.clone(),
                version: original.version.clone(),
                columns: original.columns.clone(),
                rows: vec![],
            };
            let mut destination = project_service::remap_imported_table_doc(&metadata)?;
            destination.name = super::data_service::DataService::resolve_create_dataset_name(
                engine,
                &destination.name,
            )?;
            let mut sink = NativeTableRestoreSink::begin(engine, destination, &cancelled)?;
            streaming_table_reader::stream_table_rows_unordered(
                std::fs::File::open(path)?,
                &original,
                &mut sink,
            )?;
            let (meta, display) = sink.finish()?;
            stamp.verify(path)?;
            let label = path
                .file_name()
                .and_then(|name| name.to_str())
                .ok_or_else(|| AppError::InvalidParam("import_source_invalid".into()))?;
            engine.conn().execute(
                "UPDATE _meta_datasets SET source_type='sptb',source_path=? WHERE id=?",
                params![label, &meta.id],
            )?;
            let meta = engine.get_dataset_meta(&meta.id)?;
            let catalog = ProjectCatalog::new(engine);
            let event = catalog.publish_new_table(&meta, "")?;
            let mut setting_ids = vec![];
            if !display.is_empty() {
                let key = format!("display:{}", meta.id);
                let value =
                    super::project_column_settings::replacement(engine, &meta.id, &display)?;
                catalog.apply_patch(&ProjectRecordPatch {
                    settings: vec![ProjectSettingWrite {
                        key: key.clone(),
                        expected_revision: None,
                        value,
                    }],
                    ..Default::default()
                })?;
                setting_ids.push(key);
            }
            engine.conn().execute(
                "INSERT INTO _project_output_events VALUES(?,?,'import_sptb',?)",
                params![event.id, &meta.id, meta.generation],
            )?;
            Ok(super::project_transaction::CommitEffects {
                value: ProjectTableImportResult {
                    id: meta.id.clone(),
                },
                dataset_ids: vec![meta.id],
                document_ids: vec![],
                setting_ids,
            })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        engine::duckdb_engine::{DuckDbEngine, NATURAL_ORDER_SQL},
        services::project_catalog::ProjectCatalog,
    };
    use sha2::{Digest, Sha256};
    fn context(db: &ProjectDatabase, id: &str) -> ProjectWriteContext {
        ProjectWriteContext {
            operation_id: id.into(),
            expected_project_id: db.header().unwrap().project_id,
            expected_epoch: db.epoch(),
            expected_revision: db.committed_revision().unwrap(),
            request_digest: String::new(),
            dataset_generations: vec![],
            document_revisions: vec![],
        }
    }
    fn source(path: &std::path::Path) {
        std::fs::write(path,r#"{"rows":[[3000000000,9007199254740993,"1.234567890123456789",null],[7,-9007199254740993,"-2.345678901234567890",false]],"columns":[{"name":"big","colType":"BIGINT","width":177},{"name":"precise","colType":"DECIMAL(38,18)"},{"name":"flag","colType":"BOOLEAN"}],"version":"2","sourceType":"manual","name":"Exact","id":"foreign"}"#).unwrap();
    }
    #[test]
    fn project_v5_sptb_import_remaps_formulas_and_recovers_atomic_public_receipts() {
        use crate::{
            models::table::CreateTableFromRowsRequest,
            services::{
                calculated_column_service::{CalculatedColumnService, UpsertCalculatedColumnInput},
                project_service::ProjectService,
            },
            state::AppState,
        };
        let root = tempfile::tempdir().unwrap();
        let input = root.path().join("formulas.sptb");
        let source_state = AppState::new().unwrap();
        source_state
            .db
            .lock()
            .unwrap()
            .create_table_from_rows(
                "external",
                &CreateTableFromRowsRequest {
                    name: "Formula source".into(),
                    column_names: vec!["value".into()],
                    column_types: vec!["DOUBLE".into()],
                    rows: vec![vec![serde_json::json!(2)], vec![serde_json::json!(3)]],
                },
            )
            .unwrap();
        CalculatedColumnService::new(&source_state)
            .upsert(&UpsertCalculatedColumnInput {
                dataset_id: "external".into(),
                output_name: "doubled".into(),
                formula_text: "[value] * 2".into(),
                at_index: None,
                output_column_id: None,
                formula_id: None,
                expected_generation: Some(0),
            })
            .unwrap();
        let original = ProjectService::new(&source_state)
            .compose_table_doc("external")
            .unwrap();
        super::super::spprj_archive::write_table_file(&original, input.to_str().unwrap()).unwrap();
        let hash = Sha256::digest(std::fs::read(&input).unwrap());
        let db = ProjectDatabase::create(&root.path().join("project.spprj"), false).unwrap();
        let first = db
            .import_project_table_file(&context(&db, "first"), input.to_str().unwrap(), || false)
            .unwrap();
        let second_write = context(&db, "second");
        super::super::project_transaction::inject_commit_failure_for_test(1);
        assert!(db
            .import_project_table_file(&second_write, input.to_str().unwrap(), || false)
            .is_err());
        db.with_reader(db.epoch(), |engine| {
            assert_eq!(engine.list_datasets()?.len(), 1);
            Ok(())
        })
        .unwrap();
        super::super::project_transaction::inject_commit_failure_for_test(2);
        assert!(db
            .import_project_table_file(&second_write, input.to_str().unwrap(), || false)
            .is_err());
        assert_eq!(Sha256::digest(std::fs::read(&input).unwrap()), hash);
        std::fs::remove_file(&input).unwrap();
        let second = db
            .import_project_table_file(&second_write, input.to_str().unwrap(), || false)
            .unwrap();
        assert_ne!(first.value.id, second.value.id);
        db.with_reader(db.epoch(), |engine| {
            let first_columns = engine.get_user_column_descriptors(&first.value.id)?;
            let second_columns = engine.get_user_column_descriptors(&second.value.id)?;
            for (index, column) in first_columns.iter().enumerate() {
                assert_ne!(
                    Some(&column.column_id),
                    original.columns[index].column_id.as_ref()
                );
                assert_ne!(column.column_id, second_columns[index].column_id);
            }
            let source_formula = &original.columns[1]
                .calculated
                .as_ref()
                .unwrap()
                .ready_definition()
                .unwrap()
                .formula_id;
            let first_plans = engine.get_archive_column_plans(&first.value.id)?;
            let second_plans = engine.get_archive_column_plans(&second.value.id)?;
            let first_formula = first_plans[1].calculated.as_ref().unwrap().formula_id();
            assert_ne!(first_formula, source_formula);
            assert_ne!(
                first_formula,
                second_plans[1].calculated.as_ref().unwrap().formula_id()
            );
            for id in [&first.value.id, &second.value.id] {
                let table = DuckDbEngine::quote_identifier(&DuckDbEngine::internal_table_name(id));
                let values = engine
                    .conn()
                    .prepare(&format!("SELECT doubled FROM {table} ORDER BY _row_id"))?
                    .query_map([], |row| row.get::<_, f64>(0))?
                    .collect::<Result<Vec<_>, _>>()?;
                assert_eq!(values, vec![4.0, 6.0]);
            }
            assert_eq!(engine.list_datasets()?.len(), 2);
            Ok(())
        })
        .unwrap();
        let mut edit = context(&db, "edit-imported-formula");
        edit.dataset_generations = vec![DatasetGeneration {
            id: first.value.id.clone(),
            generation: 0,
        }];
        db.commit_with_effects(&edit, &"edit", |engine| {
            super::super::project_cell_mutation::update_cells_compact_in_transaction(
                engine,
                &first.value.id,
                &[crate::models::table::CellUpdate {
                    row_id: 1,
                    column_name: "value".into(),
                    value: Some("4".into()),
                }],
                0,
            )?;
            Ok(super::super::project_transaction::CommitEffects {
                value: (),
                dataset_ids: vec![first.value.id.clone()],
                document_ids: vec![],
                setting_ids: vec![],
            })
        })
        .unwrap();
        db.with_reader(db.epoch(), |engine| {
            let table =
                DuckDbEngine::quote_identifier(&DuckDbEngine::internal_table_name(&first.value.id));
            let value: f64 = engine.conn().query_row(
                &format!("SELECT doubled FROM {table} WHERE _row_id=1"),
                [],
                |row| row.get(0),
            )?;
            assert_eq!(
                value, 8.0,
                "imported formula must reference the remapped source column"
            );
            Ok(())
        })
        .unwrap();
        let resolved = serde_json::to_value(db.resolve_operation(&second_write).unwrap()).unwrap();
        assert_eq!(
            resolved["commit"]["value"],
            serde_json::to_value(second.value).unwrap()
        );
    }

    #[test]
    fn project_v5_sptb_import_streams_reordered_headers_exact_values_and_replays_without_source() {
        let root = tempfile::tempdir().unwrap();
        let input = root.path().join("source.sptb");
        source(&input);
        let hash = Sha256::digest(std::fs::read(&input).unwrap());
        let path = root.path().join("project.spprj");
        let db = ProjectDatabase::create(&path, false).unwrap();
        let write = context(&db, "import");
        let imported = db
            .import_project_table_file(&write, input.to_str().unwrap(), || false)
            .unwrap();
        assert_ne!(imported.value.id, "foreign");
        assert_eq!(
            serde_json::to_value(&imported.value).unwrap(),
            serde_json::json!({"id":imported.value.id})
        );
        assert_eq!(imported.changed_dataset_metadata[0].row_count, 2);
        assert_eq!(imported.changed_history_entries.len(), 1);
        assert_eq!(
            imported.changed_history_entries[0].operation,
            "create_table"
        );
        assert_eq!(
            Sha256::digest(std::fs::read(&input).unwrap()),
            hash,
            "import must preserve its external source"
        );
        std::fs::remove_file(&input).unwrap();
        assert_eq!(
            db.import_project_table_file(&write, input.to_str().unwrap(), || false)
                .unwrap()
                .value,
            imported.value
        );
        let id = imported.value.id.clone();
        db.shutdown().unwrap();
        let reopened = ProjectDatabase::open(&path, false).unwrap();
        reopened.with_reader(reopened.epoch(),|engine| {
            let table=DuckDbEngine::quote_identifier(&DuckDbEngine::internal_table_name(&id));
            let rows=engine.conn().prepare(&format!("SELECT _row_id,big,CAST(precise AS VARCHAR),flag FROM {table} ORDER BY {NATURAL_ORDER_SQL},_row_id"))?.query_map([],|row|Ok((row.get::<_,i64>(0)?,row.get::<_,i64>(1)?,row.get::<_,String>(2)?,row.get::<_,Option<bool>>(3)?)))?.collect::<Result<Vec<_>,_>>()?;
            assert_eq!(rows,vec![(3000000000,9007199254740993,"1.234567890123456789".into(),None),(7,-9007199254740993,"-2.345678901234567890".into(),Some(false))]);
            let next:i64=engine.conn().query_row("SELECT next_row_id FROM _meta_datasets WHERE id=?",[&id],|row|row.get(0))?;assert_eq!(next,3000000001);
            let catalog=ProjectCatalog::new(engine);assert_eq!(catalog.describe_table(&id)?.source_type,"sptb");assert_eq!(super::super::project_column_settings::read(engine,&id)?[0].width,Some(177.0));
            assert_eq!(catalog.list_history(&HistoryPageRequest{dataset_id:Some(id.clone()),after:None,limit:200})?.items.len(),1);Ok(())
        }).unwrap();
    }
    #[test]
    fn project_v5_sptb_import_rolls_back_duplicate_rows_and_cancellation() {
        let root = tempfile::tempdir().unwrap();
        let input = root.path().join("duplicate.sptb");
        std::fs::write(&input,r#"{"id":"x","name":"Duplicate","sourceType":"manual","version":"1","columns":[{"name":"v","colType":"BIGINT"}],"rows":[[1,1],[1,2]]}"#).unwrap();
        let db = ProjectDatabase::create(&root.path().join("project.spprj"), false).unwrap();
        assert!(db
            .import_project_table_file(&context(&db, "duplicate"), input.to_str().unwrap(), || {
                false
            })
            .is_err());
        assert!(matches!(
            db.import_project_table_file(
                &context(&db, "cancelled"),
                "/source/need-not-exist.sptb",
                || true
            ),
            Err(AppError::Cancelled(_))
        ));
        assert_eq!(db.committed_revision().unwrap(), 0);
        db.with_reader(db.epoch(), |engine| {
            assert!(engine.list_datasets()?.is_empty());
            assert!(ProjectCatalog::new(engine)
                .list_history(&HistoryPageRequest {
                    dataset_id: None,
                    after: None,
                    limit: 200
                })?
                .items
                .is_empty());
            Ok(())
        })
        .unwrap();
    }
}
