use crate::connectors::ServerConnector;
use crate::error::AppError;
use crate::models::data_link::{
    ConnectionCredentials, ConnectionDefinition, ImportSummary, ImportTableSummary,
    SourceObjectRef, SqliteImportSelection,
};
use crate::models::table::DatasetMeta;
use crate::services::path_authorization_service::{
    AuthorizedCsvTargetInspection, OutputPathStatus, OutputRootGrant, PathAuthorizationService,
};
use crate::state::AppState;
use std::collections::HashMap;
use std::path::Path;

const AUTHORIZED_EXPORT_TEMP_PREFIX: &str = ".statsplayground-export-";

pub struct IoService<'a> {
    state: &'a AppState,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::data_link::{AuthenticationType, ConnectorKind, SourceObjectType, TlsMode};
    use crate::models::table::CreateTableFromRowsRequest;
    use crate::services::data_service::DataService;
    use std::collections::{BTreeSet, HashMap};
    use std::io::Read;
    use tempfile::TempDir;

    fn seed_export_dataset(
        service: &DataService<'_>,
        name: &str,
        rows: Vec<Vec<serde_json::Value>>,
    ) -> String {
        service
            .create_table_from_rows(&CreateTableFromRowsRequest {
                name: name.to_string(),
                column_names: vec!["label".to_string(), "value".to_string()],
                column_types: vec!["VARCHAR".to_string(), "INTEGER".to_string()],
                rows,
            })
            .expect("seed export dataset")
            .id
    }

    fn seed_empty_export_dataset(service: &DataService<'_>, name: &str) -> String {
        service
            .create_table(name, &[], &[])
            .expect("seed empty export dataset")
            .id
    }

    fn assert_directory_entries(path: &Path, expected: &[&str]) {
        let names = std::fs::read_dir(path)
            .expect("read dir")
            .map(|entry| {
                entry
                    .expect("dir entry")
                    .file_name()
                    .to_string_lossy()
                    .into_owned()
            })
            .collect::<BTreeSet<_>>();
        let expected_names = expected
            .iter()
            .map(|name| (*name).to_string())
            .collect::<BTreeSet<_>>();
        assert_eq!(names, expected_names);
    }

    #[test]
    fn export_csv_authorized_create_new_publishes_csv_without_temp_leaks() {
        let state = AppState::new().expect("create app state");
        let data = DataService::new(&state);
        let dataset_id = seed_export_dataset(
            &data,
            "Alpha",
            vec![vec![serde_json::json!("ada"), serde_json::json!(1)]],
        );
        let temp = TempDir::new().expect("temp dir");
        let export_root = temp.path().join("exports");
        std::fs::create_dir_all(&export_root).expect("export root");
        let service = IoService::new(&state);
        let grant = service
            .authorize_output_root(&export_root.to_string_lossy())
            .expect("authorize root");

        service
            .export_csv_authorized(&dataset_id, &grant.root_id, "nested/alpha.csv")
            .expect("export csv");

        let nested = export_root.join("nested");
        let contents = std::fs::read_to_string(nested.join("alpha.csv")).expect("read csv");
        assert!(contents.contains("label,value"));
        assert!(contents.contains("ada,1"));
        assert_directory_entries(&nested, &["alpha.csv"]);
    }

    #[test]
    fn export_csv_authorized_replaces_existing_target_without_temp_leaks() {
        let state = AppState::new().expect("create app state");
        let data = DataService::new(&state);
        let dataset_id = seed_export_dataset(
            &data,
            "Alpha",
            vec![vec![serde_json::json!("ada"), serde_json::json!(1)]],
        );
        let temp = TempDir::new().expect("temp dir");
        let export_root = temp.path().join("exports");
        let nested = export_root.join("nested");
        std::fs::create_dir_all(&nested).expect("nested dir");
        std::fs::write(nested.join("alpha.csv"), b"stale-bytes").expect("seed target");
        let service = IoService::new(&state);
        let grant = service
            .authorize_output_root(&export_root.to_string_lossy())
            .expect("authorize root");

        service
            .export_csv_authorized(&dataset_id, &grant.root_id, "nested/alpha.csv")
            .expect("replace csv");

        let contents = std::fs::read_to_string(nested.join("alpha.csv")).expect("read csv");
        assert!(contents.contains("label,value"));
        assert!(contents.contains("ada,1"));
        assert_directory_entries(&nested, &["alpha.csv"]);
    }

    #[test]
    fn export_csv_authorized_create_new_rejects_racing_target_and_preserves_bytes() {
        let state = AppState::new().expect("create app state");
        let data = DataService::new(&state);
        let dataset_id = seed_export_dataset(
            &data,
            "Alpha",
            vec![vec![serde_json::json!("ada"), serde_json::json!(1)]],
        );
        let temp = TempDir::new().expect("temp dir");
        let export_root = temp.path().join("exports");
        std::fs::create_dir_all(&export_root).expect("export root");
        let nested = export_root.join("nested");
        let target = nested.join("alpha.csv");
        let service = IoService::new(&state);
        let grant = service
            .authorize_output_root(&export_root.to_string_lossy())
            .expect("authorize root");

        let error = service
            .export_csv_authorized_with_publish_hook(
                &dataset_id,
                &grant.root_id,
                "nested/alpha.csv",
                || {
                    std::fs::create_dir_all(&nested).expect("nested dir");
                    std::fs::write(&target, b"racing-bytes").expect("race target");
                    Ok(())
                },
            )
            .expect_err("create-new publish must reject a racing target");

        assert!(matches!(error, AppError::FileIO(_)));
        assert_eq!(std::fs::read(&target).expect("read racing target"), b"racing-bytes");
        assert_directory_entries(&nested, &["alpha.csv"]);
    }

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
    fn export_sqlite_subset_uses_selected_names_only() {
        let state = AppState::new().expect("create app state");
        let data = DataService::new(&state);
        let alpha_id = seed_export_dataset(
            &data,
            "Alpha",
            vec![vec![serde_json::json!("ada"), serde_json::json!(1)]],
        );
        let beta_id = seed_export_dataset(
            &data,
            "Beta",
            vec![vec![serde_json::json!("grace"), serde_json::json!(2)]],
        );
        let gamma_id = seed_export_dataset(
            &data,
            "Gamma",
            vec![vec![serde_json::json!("linus"), serde_json::json!(3)]],
        );
        let path = std::env::temp_dir().join(format!(
            "datalink-export-subset-{}.sqlite",
            uuid::Uuid::new_v4()
        ));
        let overrides = HashMap::from([
            (alpha_id.clone(), "Incoming-Alpha Share".to_string()),
            (beta_id.clone(), "Nested-Beta Share".to_string()),
        ]);

        IoService::new(&state)
            .export_sqlite_subset(
                path.to_str().expect("fixture path"),
                Some(&[alpha_id.clone(), beta_id.clone()]),
                &overrides,
            )
            .expect("export sqlite subset");

        let sqlite = rusqlite::Connection::open(&path).expect("open exported SQLite");
        let names = sqlite
            .prepare(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
            )
            .expect("prepare table list")
            .query_map([], |row| row.get::<_, String>(0))
            .expect("query table list")
            .collect::<Result<BTreeSet<_>, _>>()
            .expect("collect table names");
        assert_eq!(
            names,
            BTreeSet::from([
                "Incoming-Alpha Share".to_string(),
                "Nested-Beta Share".to_string(),
            ])
        );
        assert!(!names.contains("Gamma"));
        let exported_label: String = sqlite
            .query_row("SELECT label FROM \"Nested-Beta Share\"", [], |row| row.get(0))
            .expect("read exported beta row");
        assert_eq!(exported_label, "grace");
        drop(sqlite);
        let _ = gamma_id;
        std::fs::remove_file(path).expect("remove fixture");
    }

    #[test]
    fn export_csv_zip_subset_writes_nested_entries_and_skips_unselected_tables() {
        let state = AppState::new().expect("create app state");
        let data = DataService::new(&state);
        let alpha_id = seed_export_dataset(
            &data,
            "Alpha",
            vec![vec![serde_json::json!("ada"), serde_json::json!(1)]],
        );
        let beta_id = seed_export_dataset(
            &data,
            "Beta",
            vec![vec![serde_json::json!("grace"), serde_json::json!(2)]],
        );
        let _gamma_id = seed_export_dataset(
            &data,
            "Gamma",
            vec![vec![serde_json::json!("linus"), serde_json::json!(3)]],
        );
        let path = std::env::temp_dir().join(format!(
            "datalink-export-csv-{}.zip",
            uuid::Uuid::new_v4()
        ));
        let archive_paths = HashMap::from([
            (alpha_id.clone(), "Incoming/Alpha Share".to_string()),
            (beta_id.clone(), "Nested/Review/Beta Share".to_string()),
        ]);

        IoService::new(&state)
            .export_csv_zip_subset(
                path.to_str().expect("fixture path"),
                Some(&[alpha_id, beta_id]),
                &archive_paths,
            )
            .expect("export csv zip subset");

        let file = std::fs::File::open(&path).expect("open exported zip");
        let mut zip = zip::ZipArchive::new(file).expect("read exported zip");
        let names = (0..zip.len())
            .map(|index| {
                zip.by_index(index)
                    .expect("read zip entry")
                    .name()
                    .to_string()
            })
            .collect::<BTreeSet<_>>();
        assert_eq!(
            names,
            BTreeSet::from([
                "Incoming/Alpha Share.csv".to_string(),
                "Nested/Review/Beta Share.csv".to_string(),
            ])
        );
        assert!(!names.iter().any(|name| name.contains("Gamma")));

        let mut beta_csv = String::new();
        zip.by_name("Nested/Review/Beta Share.csv")
            .expect("open beta csv")
            .read_to_string(&mut beta_csv)
            .expect("read beta csv");
        assert!(beta_csv.contains("label,value"));
        assert!(beta_csv.contains("grace,2"));

        drop(zip);
        std::fs::remove_file(path).expect("remove fixture");
    }

    #[test]
    fn export_csv_zip_subset_rejects_empty_schema_before_touching_output() {
        let state = AppState::new().expect("create app state");
        let empty_id = seed_empty_export_dataset(&DataService::new(&state), "Empty");
        let path = std::env::temp_dir().join(format!(
            "datalink-export-empty-{}.zip",
            uuid::Uuid::new_v4()
        ));
        std::fs::write(&path, b"keep existing output").expect("seed existing output");

        let error = IoService::new(&state)
            .export_csv_zip_subset(
                path.to_str().expect("fixture path"),
                Some(&[empty_id]),
                &HashMap::new(),
            )
            .expect_err("empty schema must be rejected");

        assert!(matches!(error, AppError::InvalidParam(_)));
        assert_eq!(
            std::fs::read(&path).expect("read existing output"),
            b"keep existing output"
        );
        std::fs::remove_file(path).expect("remove fixture");
    }

    #[test]
    fn export_sqlite_subset_rejects_empty_schema_before_touching_output() {
        let state = AppState::new().expect("create app state");
        let empty_id = seed_empty_export_dataset(&DataService::new(&state), "Empty");
        let path = std::env::temp_dir().join(format!(
            "datalink-export-empty-{}.sqlite",
            uuid::Uuid::new_v4()
        ));
        std::fs::write(&path, b"keep existing output").expect("seed existing output");

        let error = IoService::new(&state)
            .export_sqlite_subset(
                path.to_str().expect("fixture path"),
                Some(&[empty_id]),
                &HashMap::new(),
            )
            .expect_err("empty schema must be rejected");

        assert!(matches!(error, AppError::InvalidParam(_)));
        assert_eq!(
            std::fs::read(&path).expect("read existing output"),
            b"keep existing output"
        );
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

    pub fn authorize_output_root(&self, root_path: &str) -> Result<OutputRootGrant, AppError> {
        let mut authorizer = self.lock_path_authorization()?;
        authorizer.authorize_output_root(Path::new(root_path))
    }

    pub fn revoke_output_root(&self, root_id: &str) -> Result<(), AppError> {
        let mut authorizer = self.lock_path_authorization()?;
        authorizer.revoke_output_root(root_id)
    }

    pub fn inspect_authorized_csv_target(
        &self,
        root_id: &str,
        relative_path: &str,
    ) -> Result<AuthorizedCsvTargetInspection, AppError> {
        let authorizer = self.lock_path_authorization()?;
        let resolved = authorizer.resolve_output(root_id, relative_path)?;
        Ok(AuthorizedCsvTargetInspection {
            target_exists: resolved.status
                == crate::services::path_authorization_service::OutputPathStatus::OverwriteExisting,
        })
    }

    pub fn export_csv_authorized(
        &self,
        dataset_id: &str,
        root_id: &str,
        relative_path: &str,
    ) -> Result<(), AppError> {
        self.export_csv_authorized_with_publish_hook(dataset_id, root_id, relative_path, || Ok(()))
    }

    fn export_csv_authorized_with_publish_hook<F>(
        &self,
        dataset_id: &str,
        root_id: &str,
        relative_path: &str,
        before_publish: F,
    ) -> Result<(), AppError>
    where
        F: FnOnce() -> Result<(), AppError>,
    {
        let resolved = {
            let authorizer = self.lock_path_authorization()?;
            authorizer.resolve_output(root_id, relative_path)?
        };
        let parent = resolved.path.parent().ok_or_else(|| {
            AppError::FileIO("resolved output path has no parent directory".to_string())
        })?;

        std::fs::create_dir_all(parent)?;
        let temp_path = create_authorized_export_temp_path(parent)?;
        let temp_path_result = temp_path
            .to_str()
            .ok_or_else(|| AppError::FileIO("temporary export path is not valid UTF-8".to_string()));
        let temp_path_str = match temp_path_result {
            Ok(path) => path,
            Err(error) => {
                cleanup_authorized_export_tempfile(&temp_path);
                return Err(error);
            }
        };

        if let Err(error) = self.export_csv(dataset_id, temp_path_str) {
            cleanup_authorized_export_tempfile(&temp_path);
            return Err(error);
        }

        let publish_result = before_publish()
            .and_then(|_| self.revalidate_authorized_output(root_id, relative_path))
            .and_then(|_| publish_authorized_export(&temp_path, &resolved.path, &resolved.status));
        if let Err(error) = publish_result {
            cleanup_authorized_export_tempfile(&temp_path);
            return Err(error);
        }

        Ok(())
    }

    fn lock_path_authorization(
        &self,
    ) -> Result<std::sync::MutexGuard<'_, PathAuthorizationService>, AppError> {
        self.state
            .path_authorization
            .lock()
            .map_err(|error| AppError::Database(error.to_string()))
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

    fn revalidate_authorized_output(
        &self,
        root_id: &str,
        relative_path: &str,
    ) -> Result<(), AppError> {
        let authorizer = self.lock_path_authorization()?;
        authorizer.resolve_output(root_id, relative_path)?;
        Ok(())
    }
}

fn create_authorized_export_temp_path(parent: &Path) -> Result<std::path::PathBuf, AppError> {
    let named_temp = tempfile::Builder::new()
        .prefix(AUTHORIZED_EXPORT_TEMP_PREFIX)
        .suffix(".csv")
        .tempfile_in(parent)
        .map_err(|error| AppError::FileIO(error.to_string()))?;
    let (file, path) = named_temp
        .keep()
        .map_err(|error| AppError::FileIO(error.error.to_string()))?;
    drop(file);
    Ok(path)
}

fn cleanup_authorized_export_tempfile(path: &Path) {
    match std::fs::remove_file(path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => {}
    }
}

fn publish_authorized_export(
    temp_path: &Path,
    output_path: &Path,
    initial_status: &OutputPathStatus,
) -> Result<(), AppError> {
    match initial_status {
        OutputPathStatus::CreateNew => publish_authorized_export_create_new(temp_path, output_path),
        OutputPathStatus::OverwriteExisting => publish_authorized_export_overwrite(temp_path, output_path),
    }
}

fn publish_authorized_export_create_new(temp_path: &Path, output_path: &Path) -> Result<(), AppError> {
    std::fs::hard_link(temp_path, output_path).map_err(|error| AppError::FileIO(error.to_string()))?;
    std::fs::remove_file(temp_path).map_err(|error| AppError::FileIO(error.to_string()))?;
    Ok(())
}

fn publish_authorized_export_overwrite(temp_path: &Path, output_path: &Path) -> Result<(), AppError> {
    atomic_replace_file(temp_path, output_path)
}

#[cfg(unix)]
fn atomic_replace_file(temp_path: &Path, output_path: &Path) -> Result<(), AppError> {
    std::fs::rename(temp_path, output_path).map_err(|error| AppError::FileIO(error.to_string()))?;
    Ok(())
}

#[cfg(windows)]
fn atomic_replace_file(temp_path: &Path, output_path: &Path) -> Result<(), AppError> {
    use std::ffi::OsStr;
    use std::iter::once;
    use std::os::windows::ffi::OsStrExt;

    type Bool = i32;
    type Dword = u32;
    type Lpcwstr = *const u16;
    type Lpvoid = *mut std::ffi::c_void;

    const MOVEFILE_WRITE_THROUGH: Dword = 0x0000_0008;

    extern "system" {
        fn MoveFileExW(existing_file_name: Lpcwstr, new_file_name: Lpcwstr, flags: Dword) -> Bool;
        fn ReplaceFileW(
            replaced_file_name: Lpcwstr,
            replacement_file_name: Lpcwstr,
            backup_file_name: Lpcwstr,
            replace_flags: Dword,
            exclude: Lpvoid,
            reserved: Lpvoid,
        ) -> Bool;
    }

    fn wide(path: &Path) -> Vec<u16> {
        OsStr::new(path)
            .encode_wide()
            .chain(once(0))
            .collect::<Vec<_>>()
    }

    let temp_wide = wide(temp_path);
    let output_wide = wide(output_path);
    let replaced = unsafe {
        ReplaceFileW(
            output_wide.as_ptr(),
            temp_wide.as_ptr(),
            std::ptr::null(),
            0,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    if replaced != 0 {
        return Ok(());
    }

    let moved = unsafe { MoveFileExW(temp_wide.as_ptr(), output_wide.as_ptr(), MOVEFILE_WRITE_THROUGH) };
    if moved != 0 {
        return Ok(());
    }

    Err(AppError::FileIO(std::io::Error::last_os_error().to_string()))
}
