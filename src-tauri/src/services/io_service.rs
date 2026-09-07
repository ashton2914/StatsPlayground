use crate::connectors::ServerConnector;
use crate::error::AppError;
use crate::models::data_link::{
    ConnectionCredentials, ConnectionDefinition, ImportSummary, ImportTableSummary,
    SourceObjectRef, SqliteImportSelection,
};
use crate::models::table::DatasetMeta;
use crate::state::AppState;
use std::collections::HashMap;

pub struct IoService<'a> {
    state: &'a AppState,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::data_link::{AuthenticationType, ConnectorKind, SourceObjectType, TlsMode};

    #[test]
    fn skip_only_sqlite_import_does_not_trigger_legacy_import_all() {
        let path = std::env::temp_dir().join(format!(
            "datalink-skip-only-{}.sqlite",
            uuid::Uuid::new_v4()
        ));
        let sqlite = rusqlite::Connection::open(&path).expect("create SQLite fixture");
        sqlite
            .execute_batch("CREATE TABLE existing_values (id INTEGER); INSERT INTO existing_values VALUES (1);")
            .expect("populate SQLite fixture");
        drop(sqlite);

        let state = AppState::new().expect("create app state");
        let summary = IoService::new(&state)
            .import_selected_sqlite(
                path.to_str().expect("fixture path"),
                &[SqliteImportSelection {
                    source_name: "existing_values".to_string(),
                    target_name: "existing_values".to_string(),
                    action: "skip".to_string(),
                }],
                |_, _, _, _, _| {},
                || false,
            )
            .expect("summarize skipped import");

        assert_eq!(summary.status, "completed");
        assert!(summary.imported.is_empty());
        assert_eq!(summary.skipped.len(), 1);
        assert_eq!(summary.total_rows_written, 0);
        assert!(state
            .db
            .lock()
            .expect("lock database")
            .list_datasets()
            .expect("list datasets")
            .is_empty());

        std::fs::remove_file(path).expect("remove fixture");
    }

    #[test]
    #[ignore = "requires the local PostgreSQL fixture and STATSPG_TEST_POSTGRES_PASSWORD"]
    fn imports_postgres_snapshot_into_managed_dataset() {
        let password = std::env::var("STATSPG_TEST_POSTGRES_PASSWORD")
            .expect("STATSPG_TEST_POSTGRES_PASSWORD must be set");
        let definition = ConnectionDefinition {
            connector: ConnectorKind::PostgreSql,
            host: "127.0.0.1".to_string(),
            port: 55432,
            database: "statsplayground_test".to_string(),
            authentication_type: AuthenticationType::UsernamePassword,
            tls_mode: TlsMode::Disabled,
            tls_root_certificate_pem: None,
            connect_timeout_seconds: 5,
        };
        let credentials = ConnectionCredentials {
            username: "stats_reader".to_string(),
            password,
        };
        let object = SourceObjectRef {
            catalog: Some("statsplayground_test".to_string()),
            schema: Some("datalink".to_string()),
            name: "customers".to_string(),
            object_type: SourceObjectType::Table,
        };
        let state = AppState::new().expect("create app state");

        let summary = IoService::new(&state)
            .import_postgres_snapshot(
                definition,
                credentials,
                object,
                "postgres_customers",
                |_, _| {},
                || false,
            )
            .expect("import PostgreSQL snapshot");

        assert_eq!(summary.status, "completed");
        assert_eq!(summary.total_rows_written, 3);
        let datasets = state
            .db
            .lock()
            .expect("lock database")
            .list_datasets()
            .expect("list datasets");
        assert_eq!(datasets.len(), 1);
        assert_eq!(datasets[0].name, "postgres_customers");
        assert_eq!(datasets[0].source_type, "postgresql");
        assert_eq!(datasets[0].row_count, 3);
    }

    #[test]
    #[ignore = "requires the local MySQL fixture and STATSPG_TEST_MYSQL_PASSWORD"]
    fn mysql_snapshot_import_and_cancellation() {
        let definition = ConnectionDefinition {
            connector: ConnectorKind::MySql,
            host: "127.0.0.1".into(), port: 53306,
            database: "statsplayground_test".into(),
            authentication_type: AuthenticationType::UsernamePassword,
            tls_mode: TlsMode::Disabled, connect_timeout_seconds: 10,
            tls_root_certificate_pem: None,
        };
        let credentials = ConnectionCredentials {
            username: "stats_reader".into(),
            password: std::env::var("STATSPG_TEST_MYSQL_PASSWORD").expect("fixture password"),
        };
        let state = AppState::new().expect("app state");
        let service = IoService::new(&state);
        let object = |name: &str| SourceObjectRef {
            catalog: Some("statsplayground_test".into()), schema: Some("statsplayground_test".into()),
            name: name.into(), object_type: SourceObjectType::Table,
        };
        for (name, expected) in [("customers", 3), ("measurements", 100_000), ("type_samples", 2), ("empty_table", 0)] {
            let progress = std::cell::Cell::new((0, 0));
            let summary = service.import_server_snapshot(
                definition.clone(), credentials.clone(), object(name), name,
                |done, total| progress.set((done, total)), || false,
            ).expect("import fixture");
            assert_eq!(summary.total_rows_written, expected);
            assert_eq!(progress.get(), (expected, expected));
        }
        let cancelled = service.import_server_snapshot(
            definition, credentials, object("measurements"), "cancelled_import", |_, _| {}, || true,
        ).expect_err("cancel import");
        assert!(matches!(cancelled, AppError::Cancelled(_)));
        let database = state.db.lock().expect("database");
        let datasets = database.list_datasets().expect("datasets");
        assert_eq!(datasets.len(), 4);
        assert!(datasets.iter().all(|dataset| dataset.source_type == "mysql"));
        assert!(!datasets.iter().any(|dataset| dataset.name == "cancelled_import"));
        let types = datasets.iter().find(|dataset| dataset.name == "type_samples").expect("type dataset");
        let values = database.query_table(&types.id, 0, 100, Some("id"), Some("asc")).expect("read imported values");
        assert_eq!(values.rows[0][2], "18446744073709551615");
        assert_eq!(values.rows[0][3], "123456789012345678901.123456789");
        assert_eq!(values.column_types[4], "BLOB");
        assert!(values.rows[0][8].is_null());
    }

    #[test]
    #[ignore = "requires the local PostgreSQL fixture and STATSPG_TEST_POSTGRES_PASSWORD"]
    fn imports_large_postgres_snapshot_in_batches() {
        let password = std::env::var("STATSPG_TEST_POSTGRES_PASSWORD")
            .expect("STATSPG_TEST_POSTGRES_PASSWORD must be set");
        let definition = ConnectionDefinition {
            connector: ConnectorKind::PostgreSql,
            host: "127.0.0.1".to_string(),
            port: 55432,
            database: "statsplayground_test".to_string(),
            authentication_type: AuthenticationType::UsernamePassword,
            tls_mode: TlsMode::Disabled,
            tls_root_certificate_pem: None,
            connect_timeout_seconds: 5,
        };
        let credentials = ConnectionCredentials {
            username: "stats_reader".to_string(),
            password,
        };
        let object = SourceObjectRef {
            catalog: Some("statsplayground_test".to_string()),
            schema: Some("datalink".to_string()),
            name: "measurements".to_string(),
            object_type: SourceObjectType::Table,
        };
        let state = AppState::new().expect("create app state");
        let final_progress = std::cell::Cell::new((0, 0));

        let summary = IoService::new(&state)
            .import_postgres_snapshot(
                definition,
                credentials,
                object,
                "postgres_measurements",
                |rows_done, rows_total| final_progress.set((rows_done, rows_total)),
                || false,
            )
            .expect("import large PostgreSQL snapshot");

        assert_eq!(summary.total_rows_written, 100_000);
        assert_eq!(final_progress.get(), (100_000, 100_000));
        let datasets = state
            .db
            .lock()
            .expect("lock database")
            .list_datasets()
            .expect("list datasets");
        assert_eq!(datasets.len(), 1);
        assert_eq!(datasets[0].name, "postgres_measurements");
        assert_eq!(datasets[0].row_count, 100_000);
    }
}

impl<'a> IoService<'a> {
    pub fn new(state: &'a AppState) -> Self {
        Self { state }
    }

    pub fn export_csv(&self, dataset_id: &str, output_path: &str) -> Result<(), AppError> {
        let db = self
            .state
            .db
            .lock()
            .map_err(|e| AppError::Database(e.to_string()))?;
        db.export_csv(dataset_id, output_path)
    }

    pub fn import_sqlite<F>(
        &self,
        file_path: &str,
        on_progress: F,
    ) -> Result<Vec<DatasetMeta>, AppError>
    where
        F: Fn(&str, usize, usize, usize, usize),
    {
        let db = self
            .state
            .db
            .lock()
            .map_err(|e| AppError::Database(e.to_string()))?;
        let results = db.import_sqlite(file_path, &on_progress, &|| false)?;
        Ok(results.into_iter().map(|(_, meta, _)| meta).collect())
    }

    pub fn import_selected_sqlite<F, C>(
        &self,
        file_path: &str,
        selections: &[SqliteImportSelection],
        on_progress: F,
        is_cancelled: C,
    ) -> Result<ImportSummary, AppError>
    where
        F: Fn(&str, usize, usize, usize, usize),
        C: Fn() -> bool,
    {
        let db = self
            .state
            .db
            .lock()
            .map_err(|e| AppError::Database(e.to_string()))?;
        let skipped = selections
            .iter()
            .filter(|selection| selection.action == "skip")
            .map(|selection| ImportTableSummary {
                source_name: selection.source_name.clone(),
                target_name: selection.target_name.clone(),
                action: selection.action.clone(),
                rows_written: 0,
            })
            .collect::<Vec<_>>();
        let import_pairs = selections
            .iter()
            .filter(|selection| selection.action != "skip")
            .map(|selection| {
                (
                    selection.source_name.clone(),
                    selection.target_name.clone(),
                    selection.action == "append",
                )
            })
            .collect::<Vec<_>>();
        if import_pairs.is_empty() {
            return Ok(ImportSummary {
                status: "completed".to_string(),
                imported: Vec::new(),
                skipped,
                failed_table: None,
                error: None,
                total_rows_written: 0,
            });
        }
        let results =
            db.import_selected_sqlite(file_path, &import_pairs, &on_progress, &is_cancelled)?;
        let imported = results
            .into_iter()
            .zip(import_pairs)
            .map(
                |((source_name, _, rows_written), (_, target_name, append))| ImportTableSummary {
                    source_name,
                    target_name,
                    action: if append { "append" } else { "create" }.to_string(),
                    rows_written,
                },
            )
            .collect::<Vec<_>>();
        let total_rows_written = imported.iter().map(|table| table.rows_written).sum();
        Ok(ImportSummary {
            status: "completed".to_string(),
            imported,
            skipped,
            failed_table: None,
            error: None,
            total_rows_written,
        })
    }

    pub fn import_postgres_snapshot<F, C>(
        &self,
        definition: ConnectionDefinition,
        credentials: ConnectionCredentials,
        object: SourceObjectRef,
        target_name: &str,
        on_progress: F,
        is_cancelled: C,
    ) -> Result<ImportSummary, AppError>
    where
        F: Fn(usize, usize),
        C: Fn() -> bool,
    {
        self.import_server_snapshot(definition, credentials, object, target_name, on_progress, is_cancelled)
    }

    pub fn import_server_snapshot<F, C>(
        &self,
        definition: ConnectionDefinition,
        credentials: ConnectionCredentials,
        object: SourceObjectRef,
        target_name: &str,
        on_progress: F,
        is_cancelled: C,
    ) -> Result<ImportSummary, AppError>
    where
        F: Fn(usize, usize),
        C: Fn() -> bool,
    {
        let source_name = object
            .schema
            .as_deref()
            .map(|schema| format!("{schema}.{}", object.name))
            .unwrap_or_else(|| object.name.clone());
        let source_description = format!("{}.{}", definition.database, source_name);
        let connector = ServerConnector::new(definition, credentials)
            .map_err(|error| AppError::Database(error.message))?;
        let db = self
            .state
            .db
            .lock()
            .map_err(|error| AppError::Database(error.to_string()))?;
        let (_, rows_written) = db.import_server_snapshot(
            &connector,
            &object,
            target_name,
            &source_description,
            &on_progress,
            &is_cancelled,
        )?;
        Ok(ImportSummary {
            status: "completed".to_string(),
            imported: vec![ImportTableSummary {
                source_name,
                target_name: target_name.to_string(),
                action: "create".to_string(),
                rows_written,
            }],
            skipped: Vec::new(),
            failed_table: None,
            error: None,
            total_rows_written: rows_written,
        })
    }

    /// Export every dataset into a single SQLite database.
    pub fn export_sqlite(&self, output_path: &str) -> Result<(), AppError> {
        self.export_sqlite_subset(output_path, None, &HashMap::new())
    }

    /// Export a subset of datasets to a single SQLite database, with optional
    /// per-dataset name overrides (used by the UI to encode folder structure
    /// as `folder-table` table names).
    pub fn export_sqlite_subset(
        &self,
        output_path: &str,
        subset: Option<&[String]>,
        name_overrides: &HashMap<String, String>,
    ) -> Result<(), AppError> {
        let db = self
            .state
            .db
            .lock()
            .map_err(|e| AppError::Database(e.to_string()))?;
        db.export_sqlite_subset(output_path, subset, name_overrides)
    }

    /// Export every dataset as CSVs zipped together.
    pub fn export_csv_zip(&self, output_path: &str) -> Result<(), AppError> {
        self.export_csv_zip_subset(output_path, None, &HashMap::new())
    }

    /// Export a subset of datasets as CSVs zipped together, with optional
    /// per-dataset archive paths so the UI can preserve folder structure
    /// inside the zip.
    pub fn export_csv_zip_subset(
        &self,
        output_path: &str,
        subset: Option<&[String]>,
        archive_paths: &HashMap<String, String>,
    ) -> Result<(), AppError> {
        let db = self
            .state
            .db
            .lock()
            .map_err(|e| AppError::Database(e.to_string()))?;
        db.export_csv_zip_subset(output_path, subset, archive_paths)
    }
}
