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
use std::fs;
use std::path::Path;

const AUTHORIZED_EXPORT_TEMP_PREFIX: &str = ".statsplayground-export-";
const AUTHORIZED_EXPORT_STAGING_FILE: &str = "staged.csv";

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
            .export_csv_authorized(&dataset_id, &grant.root_id, "nested/alpha.csv", false)
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
            .export_csv_authorized(&dataset_id, &grant.root_id, "nested/alpha.csv", true)
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
                false,
                || {
                    std::fs::create_dir_all(&nested).expect("nested dir");
                    std::fs::write(&target, b"racing-bytes").expect("race target");
                    Ok(())
                },
            )
            .expect_err("create-new publish must reject a racing target");

        assert!(matches!(
            error,
            AppError::InvalidParam(_) | AppError::FileIO(_)
        ));
        assert_eq!(
            std::fs::read(&target).expect("read racing target"),
            b"racing-bytes"
        );
        assert_directory_entries(&nested, &["alpha.csv"]);
    }

    #[test]
    fn export_csv_authorized_rejects_unconfirmed_overwrite_and_preserves_original_bytes() {
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
        let target = nested.join("alpha.csv");
        std::fs::create_dir_all(&nested).expect("nested dir");
        std::fs::write(&target, b"original-bytes").expect("seed target");
        let service = IoService::new(&state);
        let grant = service
            .authorize_output_root(&export_root.to_string_lossy())
            .expect("authorize root");

        let error = service
            .export_csv_authorized(&dataset_id, &grant.root_id, "nested/alpha.csv", false)
            .expect_err("overwrite must require trusted confirmation");

        assert!(matches!(
            error,
            AppError::InvalidParam(_) | AppError::FileIO(_)
        ));
        assert_eq!(
            std::fs::read(&target).expect("read seeded target"),
            b"original-bytes"
        );
        assert_directory_entries(&nested, &["alpha.csv"]);
    }

    #[test]
    fn export_csv_authorized_staging_leaf_is_absent_before_exporter_runs_and_staging_dir_is_cleaned_on_success(
    ) {
        let temp = TempDir::new().expect("temp dir");
        let export_root = temp.path().join("exports");
        std::fs::create_dir_all(&export_root).expect("export root");
        let state = AppState::new().expect("create app state");
        let service = IoService::new(&state);
        let grant = service
            .authorize_output_root(&export_root.to_string_lossy())
            .expect("authorize root");
        let observed_staging_dir = std::cell::RefCell::new(None::<std::path::PathBuf>);

        service
            .export_csv_authorized_with_exporter_and_publish_hook(
                &grant.root_id,
                "nested/alpha.csv",
                false,
                |staging_leaf| {
                    observed_staging_dir
                        .replace(staging_leaf.parent().map(std::path::Path::to_path_buf));
                    assert!(
                        !staging_leaf.exists(),
                        "staging leaf must not exist before exporter runs"
                    );
                    std::fs::write(staging_leaf, b"label,value\nada,1\n")
                        .expect("write staged csv");
                    Ok(())
                },
                || Ok(()),
            )
            .expect("export csv");

        let nested = export_root.join("nested");
        let contents = std::fs::read_to_string(nested.join("alpha.csv")).expect("read csv");
        assert!(contents.contains("label,value"));
        assert!(contents.contains("ada,1"));
        assert_directory_entries(&nested, &["alpha.csv"]);

        let staging_dir = observed_staging_dir
            .borrow()
            .clone()
            .expect("observe staging dir");
        assert!(
            !staging_dir.exists(),
            "staging directory must be removed after publish"
        );
    }

    #[test]
    fn export_csv_authorized_staging_dir_is_cleaned_on_export_failure() {
        let temp = TempDir::new().expect("temp dir");
        let export_root = temp.path().join("exports");
        std::fs::create_dir_all(&export_root).expect("export root");
        let state = AppState::new().expect("create app state");
        let service = IoService::new(&state);
        let grant = service
            .authorize_output_root(&export_root.to_string_lossy())
            .expect("authorize root");
        let observed_staging_dir = std::cell::RefCell::new(None::<std::path::PathBuf>);

        let error = service
            .export_csv_authorized_with_exporter_and_publish_hook(
                &grant.root_id,
                "nested/alpha.csv",
                false,
                |staging_leaf| {
                    observed_staging_dir
                        .replace(staging_leaf.parent().map(std::path::Path::to_path_buf));
                    assert!(
                        !staging_leaf.exists(),
                        "staging leaf must not exist before exporter runs"
                    );
                    std::fs::write(staging_leaf, b"partial-bytes").expect("write partial bytes");
                    Err(AppError::FileIO("injected export failure".to_string()))
                },
                || Ok(()),
            )
            .expect_err("injected exporter failure must abort export");

        assert!(matches!(error, AppError::FileIO(_)));
        let staging_dir = observed_staging_dir
            .borrow()
            .clone()
            .expect("observe staging dir");
        assert!(
            !staging_dir.exists(),
            "staging directory must be removed after export failure"
        );
        assert!(!export_root.join("nested").join("alpha.csv").exists());
        assert_directory_entries(&export_root, &["nested"]);
        assert_directory_entries(&export_root.join("nested"), &[]);
    }

    #[test]
    fn authorized_export_staging_windows_creation_contract() {
        let source = include_str!("io_service.rs");
        let windows = source
            .split_once("\nmod windows_acl {")
            .expect("Windows ACL module")
            .1;
        let creator = source
            .split_once("\nfn create_authorized_export_staging_dir")
            .expect("staging creator")
            .1;
        assert!(
            creator.contains("windows_acl::create_private_current_user_directory(parent)"),
            "Windows staging must use native create-time security, not tempdir_in followed by ACL replacement"
        );
        assert!(
            !windows.contains("SetNamedSecurityInfoW"),
            "no post-create ACL replacement"
        );
        assert!(
            !windows.contains("tempdir_in("),
            "Windows must not create an inherited-ACL TempDir"
        );
        assert!(windows.contains("CreateDirectoryW(path_wide.as_ptr(), security_attributes)"));
        let prepare = windows
            .find("SetSecurityDescriptorControl(")
            .expect("protected descriptor");
        let create = windows
            .find("create_directory(&path, &security_attributes)")
            .expect("create-time attributes");
        assert!(
            prepare < create,
            "DACL protection must precede native creation"
        );
        assert!(windows.contains("SetSecurityDescriptorDacl(descriptor_ptr, 1, dacl.0, 0)"));
        assert!(windows.contains("SetSecurityDescriptorOwner(descriptor_ptr, current_user.sid, 0)"));
        assert!(windows.contains("lpSecurityDescriptor: descriptor_ptr"));
        assert!(windows.contains("Err(ERROR_ALREADY_EXISTS) => continue"));
    }

    #[cfg(windows)]
    #[test]
    fn authorized_export_staging_windows_attributes_precede_creation() {
        use windows_sys::Win32::Foundation::{ERROR_ACCESS_DENIED, ERROR_ALREADY_EXISTS};
        use windows_sys::Win32::Security::{
            EqualSid, GetAce, GetSecurityDescriptorControl, GetSecurityDescriptorDacl,
            GetSecurityDescriptorOwner, ACCESS_ALLOWED_ACE, CONTAINER_INHERIT_ACE,
            OBJECT_INHERIT_ACE, SE_DACL_PROTECTED,
        };
        use windows_sys::Win32::Storage::FileSystem::FILE_ALL_ACCESS;
        use windows_sys::Win32::System::SystemServices::ACCESS_ALLOWED_ACE_TYPE;

        let temp = TempDir::new().expect("temp dir");
        let mut attempts = 0;
        let mut collision = None;
        let staging = windows_acl::create_private_current_user_directory_with(
            temp.path(),
            |path, attributes| {
                assert!(
                    !path.exists(),
                    "descriptor must be ready before the directory exists"
                );
                assert_eq!(
                    attributes.nLength as usize,
                    std::mem::size_of_val(attributes)
                );
                assert_eq!(attributes.bInheritHandle, 0);
                let mut control = 0;
                let mut revision = 0;
                let mut present = 0;
                let mut defaulted = 0;
                let mut dacl = std::ptr::null_mut();
                let mut owner = std::ptr::null_mut();
                unsafe {
                    assert_ne!(
                        GetSecurityDescriptorControl(
                            attributes.lpSecurityDescriptor,
                            &mut control,
                            &mut revision
                        ),
                        0
                    );
                    assert_ne!(
                        GetSecurityDescriptorDacl(
                            attributes.lpSecurityDescriptor,
                            &mut present,
                            &mut dacl,
                            &mut defaulted
                        ),
                        0
                    );
                    assert_ne!(
                        GetSecurityDescriptorOwner(
                            attributes.lpSecurityDescriptor,
                            &mut owner,
                            &mut defaulted
                        ),
                        0
                    );
                }
                assert_ne!(control & SE_DACL_PROTECTED, 0);
                assert_ne!(present, 0);
                assert!(!dacl.is_null());
                assert!(!owner.is_null());
                let mut ace = std::ptr::null_mut();
                unsafe {
                    assert_eq!((*dacl).AceCount, 1);
                    assert_ne!(GetAce(dacl, 0, &mut ace), 0);
                    let allowed = &*ace.cast::<ACCESS_ALLOWED_ACE>();
                    assert_eq!(u32::from(allowed.Header.AceType), ACCESS_ALLOWED_ACE_TYPE);
                    assert_eq!(
                        u32::from(allowed.Header.AceFlags),
                        CONTAINER_INHERIT_ACE | OBJECT_INHERIT_ACE
                    );
                    assert_eq!(allowed.Mask, FILE_ALL_ACCESS);
                    assert_ne!(
                        EqualSid((&allowed.SidStart as *const u32).cast_mut().cast(), owner),
                        0
                    );
                }
                attempts += 1;
                if attempts == 1 {
                    std::fs::create_dir(path).expect("collision fixture");
                    std::fs::write(path.join("keep"), b"keep").expect("collision contents");
                    collision = Some(path.to_path_buf());
                    assert_eq!(
                        windows_acl::create_directory(path, attributes),
                        Err(ERROR_ALREADY_EXISTS)
                    );
                    Err(ERROR_ALREADY_EXISTS)
                } else {
                    windows_acl::create_directory(path, attributes)
                }
            },
        )
        .expect("retry collision with a new path");
        assert_eq!(attempts, 2);
        let staging_path = staging.path().to_path_buf();
        let inspection =
            inspect_windows_staging_dir_acl(&staging_path).expect("inspect created directory");
        assert!(inspection.owner_is_current_user && inspection.dacl_is_protected);
        assert!(
            inspection.current_user_has_full_control && inspection.only_current_user_allows_access
        );
        std::fs::create_dir(staging_path.join("child")).expect("create child directory");
        std::fs::write(staging_path.join("child/data"), b"private").expect("create child file");
        for child in [staging_path.join("child"), staging_path.join("child/data")] {
            let child_acl =
                inspect_windows_staging_dir_acl(&child).expect("inspect inherited child ACL");
            assert!(
                child_acl.current_user_has_full_control
                    && child_acl.only_current_user_allows_access
            );
        }
        drop(staging);
        assert!(!staging_path.exists());
        assert_eq!(
            std::fs::read(collision.expect("collision path").join("keep")).unwrap(),
            b"keep"
        );

        let mut failed_attempts = 0;
        let result =
            windows_acl::create_private_current_user_directory_with(temp.path(), |_, _| {
                failed_attempts += 1;
                Err(ERROR_ACCESS_DENIED)
            });
        assert!(result.is_err());
        assert_eq!(failed_attempts, 1, "only name collisions may be retried");
    }

    #[cfg(windows)]
    #[test]
    fn authorized_export_staging_dir_has_protected_current_user_windows_acl() {
        let temp = TempDir::new().expect("temp dir");
        let staging_dir =
            create_authorized_export_staging_dir(temp.path()).expect("create private staging dir");

        let protection =
            inspect_windows_staging_dir_acl(staging_dir.path()).expect("inspect staging ACL");

        assert!(
            protection.owner_is_current_user,
            "staging owner must be the current process user"
        );
        assert!(
            protection.dacl_is_protected,
            "staging DACL must block inherited ACEs"
        );
        assert!(
            protection.current_user_has_full_control,
            "current user must retain full control"
        );
        assert!(
            protection.only_current_user_allows_access,
            "no other explicit allow ACE may grant access"
        );
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
            .query_row("SELECT label FROM \"Nested-Beta Share\"", [], |row| {
                row.get(0)
            })
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
        let path =
            std::env::temp_dir().join(format!("datalink-export-csv-{}.zip", uuid::Uuid::new_v4()));
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
            host: "127.0.0.1".into(),
            port: 53306,
            database: "statsplayground_test".into(),
            authentication_type: AuthenticationType::UsernamePassword,
            tls_mode: TlsMode::Disabled,
            connect_timeout_seconds: 10,
            tls_root_certificate_pem: None,
        };
        let credentials = ConnectionCredentials {
            username: "stats_reader".into(),
            password: std::env::var("STATSPG_TEST_MYSQL_PASSWORD").expect("fixture password"),
        };
        let state = AppState::new().expect("app state");
        let service = IoService::new(&state);
        let object = |name: &str| SourceObjectRef {
            catalog: Some("statsplayground_test".into()),
            schema: Some("statsplayground_test".into()),
            name: name.into(),
            object_type: SourceObjectType::Table,
        };
        for (name, expected) in [
            ("customers", 3),
            ("measurements", 100_000),
            ("type_samples", 2),
            ("empty_table", 0),
        ] {
            let progress = std::cell::Cell::new((0, 0));
            let summary = service
                .import_server_snapshot(
                    definition.clone(),
                    credentials.clone(),
                    object(name),
                    name,
                    |done, total| progress.set((done, total)),
                    || false,
                )
                .expect("import fixture");
            assert_eq!(summary.total_rows_written, expected);
            assert_eq!(progress.get(), (expected, expected));
        }
        let cancelled = service
            .import_server_snapshot(
                definition,
                credentials,
                object("measurements"),
                "cancelled_import",
                |_, _| {},
                || true,
            )
            .expect_err("cancel import");
        assert!(matches!(cancelled, AppError::Cancelled(_)));
        let database = state.db.lock().expect("database");
        let datasets = database.list_datasets().expect("datasets");
        assert_eq!(datasets.len(), 4);
        assert!(datasets
            .iter()
            .all(|dataset| dataset.source_type == "mysql"));
        assert!(!datasets
            .iter()
            .any(|dataset| dataset.name == "cancelled_import"));
        let types = datasets
            .iter()
            .find(|dataset| dataset.name == "type_samples")
            .expect("type dataset");
        let values = database
            .query_table(&types.id, 0, 100, Some("id"), Some("asc"))
            .expect("read imported values");
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
        overwrite_confirmed: bool,
    ) -> Result<(), AppError> {
        self.export_csv_authorized_with_exporter_and_publish_hook(
            root_id,
            relative_path,
            overwrite_confirmed,
            |staging_leaf| {
                let staging_path = staging_leaf.to_str().ok_or_else(|| {
                    AppError::FileIO("temporary export path is not valid UTF-8".to_string())
                })?;
                self.export_csv(dataset_id, staging_path)
            },
            || Ok(()),
        )
    }

    fn export_csv_authorized_with_publish_hook<F>(
        &self,
        dataset_id: &str,
        root_id: &str,
        relative_path: &str,
        overwrite_confirmed: bool,
        before_publish: F,
    ) -> Result<(), AppError>
    where
        F: FnOnce() -> Result<(), AppError>,
    {
        self.export_csv_authorized_with_exporter_and_publish_hook(
            root_id,
            relative_path,
            overwrite_confirmed,
            |staging_leaf| {
                let staging_path = staging_leaf.to_str().ok_or_else(|| {
                    AppError::FileIO("temporary export path is not valid UTF-8".to_string())
                })?;
                self.export_csv(dataset_id, staging_path)
            },
            before_publish,
        )
    }

    fn export_csv_authorized_with_exporter_and_publish_hook<E, F>(
        &self,
        root_id: &str,
        relative_path: &str,
        overwrite_confirmed: bool,
        export_to_staging: E,
        before_publish: F,
    ) -> Result<(), AppError>
    where
        E: FnOnce(&Path) -> Result<(), AppError>,
        F: FnOnce() -> Result<(), AppError>,
    {
        let initial = self.resolve_authorized_output(root_id, relative_path)?;
        authorize_overwrite_status(&initial.status, overwrite_confirmed)?;

        let parent = initial.path.parent().ok_or_else(|| {
            AppError::FileIO("resolved output path has no parent directory".to_string())
        })?;
        fs::create_dir_all(parent)?;

        let staging_dir = create_authorized_export_staging_dir(parent)?;
        let staging_leaf = staging_dir.path().join(AUTHORIZED_EXPORT_STAGING_FILE);

        export_to_staging(&staging_leaf)?;
        verify_staged_export_leaf(&staging_leaf)?;

        before_publish()?;
        let revalidated = self.resolve_authorized_output(root_id, relative_path)?;
        authorize_overwrite_status(&revalidated.status, overwrite_confirmed)?;
        publish_authorized_export(&staging_leaf, &revalidated.path, &revalidated.status)
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
        self.import_server_snapshot(
            definition,
            credentials,
            object,
            target_name,
            on_progress,
            is_cancelled,
        )
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

    fn resolve_authorized_output(
        &self,
        root_id: &str,
        relative_path: &str,
    ) -> Result<crate::services::path_authorization_service::ResolvedOutputPath, AppError> {
        let authorizer = self.lock_path_authorization()?;
        authorizer.resolve_output(root_id, relative_path)
    }
}

fn authorize_overwrite_status(
    status: &OutputPathStatus,
    overwrite_confirmed: bool,
) -> Result<(), AppError> {
    if matches!(status, OutputPathStatus::OverwriteExisting) && !overwrite_confirmed {
        return Err(AppError::InvalidParam(
            "authorized CSV overwrite requires trusted confirmation".to_string(),
        ));
    }
    Ok(())
}

#[cfg(unix)]
fn create_authorized_export_staging_dir(parent: &Path) -> Result<tempfile::TempDir, AppError> {
    use std::os::unix::fs::PermissionsExt;

    let staging_dir = tempfile::Builder::new()
        .prefix(AUTHORIZED_EXPORT_TEMP_PREFIX)
        .tempdir_in(parent)
        .map_err(|error| AppError::FileIO(error.to_string()))?;
    fs::set_permissions(staging_dir.path(), fs::Permissions::from_mode(0o700))
        .map_err(|error| AppError::FileIO(error.to_string()))?;
    Ok(staging_dir)
}

#[cfg(windows)]
fn create_authorized_export_staging_dir(parent: &Path) -> Result<WindowsStagingDir, AppError> {
    windows_acl::create_private_current_user_directory(parent)
}

#[cfg(windows)]
struct WindowsStagingDir {
    path: std::path::PathBuf,
}

#[cfg(windows)]
impl WindowsStagingDir {
    fn path(&self) -> &Path {
        &self.path
    }
}

#[cfg(windows)]
impl Drop for WindowsStagingDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

fn verify_staged_export_leaf(path: &Path) -> Result<(), AppError> {
    let metadata =
        fs::symlink_metadata(path).map_err(|error| AppError::FileIO(error.to_string()))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(AppError::FileIO(
            "staged export must be a regular non-symlink file".to_string(),
        ));
    }
    Ok(())
}

fn publish_authorized_export(
    temp_path: &Path,
    output_path: &Path,
    initial_status: &OutputPathStatus,
) -> Result<(), AppError> {
    match initial_status {
        OutputPathStatus::CreateNew => publish_authorized_export_create_new(temp_path, output_path),
        OutputPathStatus::OverwriteExisting => {
            publish_authorized_export_overwrite(temp_path, output_path)
        }
    }
}

fn publish_authorized_export_create_new(
    temp_path: &Path,
    output_path: &Path,
) -> Result<(), AppError> {
    std::fs::hard_link(temp_path, output_path)
        .map_err(|error| AppError::FileIO(error.to_string()))?;
    std::fs::remove_file(temp_path).map_err(|error| AppError::FileIO(error.to_string()))?;
    Ok(())
}

fn publish_authorized_export_overwrite(
    temp_path: &Path,
    output_path: &Path,
) -> Result<(), AppError> {
    atomic_replace_file(temp_path, output_path)
}

#[cfg(unix)]
fn atomic_replace_file(temp_path: &Path, output_path: &Path) -> Result<(), AppError> {
    std::fs::rename(temp_path, output_path).map_err(|error| AppError::FileIO(error.to_string()))?;
    Ok(())
}

#[cfg(not(any(unix, windows)))]
fn create_authorized_export_staging_dir(_parent: &Path) -> Result<tempfile::TempDir, AppError> {
    Err(AppError::FileIO(
        "private export staging permissions are not implemented on this platform".to_string(),
    ))
}

#[cfg(windows)]
#[derive(Debug, PartialEq, Eq)]
struct WindowsStagingDirAclInspection {
    owner_is_current_user: bool,
    dacl_is_protected: bool,
    current_user_has_full_control: bool,
    only_current_user_allows_access: bool,
}

#[cfg(windows)]
fn inspect_windows_staging_dir_acl(
    path: &Path,
) -> Result<WindowsStagingDirAclInspection, AppError> {
    windows_acl::inspect_private_current_user_directory_acl(path)
}

#[cfg(windows)]
mod windows_acl {
    use super::{AppError, Path, WindowsStagingDir, AUTHORIZED_EXPORT_TEMP_PREFIX};
    use std::ffi::OsStr;
    use std::iter::once;
    use std::mem::MaybeUninit;
    use std::os::windows::ffi::OsStrExt;
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, LocalFree, ERROR_ALREADY_EXISTS, ERROR_INSUFFICIENT_BUFFER,
        ERROR_SUCCESS, HANDLE, HLOCAL,
    };
    use windows_sys::Win32::Security::Authorization::{
        GetNamedSecurityInfoW, SetEntriesInAclW, EXPLICIT_ACCESS_W, NO_MULTIPLE_TRUSTEE,
        SET_ACCESS, SE_FILE_OBJECT, TRUSTEE_IS_SID, TRUSTEE_IS_USER, TRUSTEE_W,
    };
    use windows_sys::Win32::Security::{
        AclSizeInformation, EqualSid, GetAce, GetAclInformation, GetSecurityDescriptorControl,
        GetTokenInformation, InitializeSecurityDescriptor, IsValidSid,
        SetSecurityDescriptorControl, SetSecurityDescriptorDacl, SetSecurityDescriptorOwner,
        TokenUser, ACCESS_ALLOWED_ACE, ACL, ACL_SIZE_INFORMATION, CONTAINER_INHERIT_ACE,
        DACL_SECURITY_INFORMATION, INHERIT_ONLY_ACE, OBJECT_INHERIT_ACE,
        OWNER_SECURITY_INFORMATION, PSID, SECURITY_ATTRIBUTES, SECURITY_DESCRIPTOR,
        SE_DACL_PROTECTED, TOKEN_QUERY, TOKEN_USER,
    };
    use windows_sys::Win32::Storage::FileSystem::{CreateDirectoryW, FILE_ALL_ACCESS};
    use windows_sys::Win32::System::Memory::{LocalAlloc, LMEM_FIXED};
    use windows_sys::Win32::System::SystemServices::{
        ACCESS_ALLOWED_ACE_TYPE, SECURITY_DESCRIPTOR_REVISION,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    pub(super) fn create_private_current_user_directory(
        parent: &Path,
    ) -> Result<WindowsStagingDir, AppError> {
        create_private_current_user_directory_with(parent, create_directory)
    }

    pub(super) fn create_private_current_user_directory_with(
        parent: &Path,
        mut create_directory: impl FnMut(&Path, &SECURITY_ATTRIBUTES) -> Result<(), u32>,
    ) -> Result<WindowsStagingDir, AppError> {
        let current_user = CurrentUserSid::new()?;
        let trustee = TRUSTEE_W {
            pMultipleTrustee: null_mut(),
            MultipleTrusteeOperation: NO_MULTIPLE_TRUSTEE,
            TrusteeForm: TRUSTEE_IS_SID,
            TrusteeType: TRUSTEE_IS_USER,
            ptstrName: current_user.sid.cast::<u16>(),
        };
        let explicit_access = EXPLICIT_ACCESS_W {
            grfAccessPermissions: FILE_ALL_ACCESS,
            grfAccessMode: SET_ACCESS,
            grfInheritance: CONTAINER_INHERIT_ACE | OBJECT_INHERIT_ACE,
            Trustee: trustee,
        };
        let mut dacl: *mut ACL = null_mut();
        let acl_status = unsafe { SetEntriesInAclW(1, &explicit_access, null(), &mut dacl) };
        if acl_status != ERROR_SUCCESS {
            return Err(last_acl_error("build private staging DACL", acl_status));
        }
        let dacl = LocalAcl(dacl);

        let mut descriptor = MaybeUninit::<SECURITY_DESCRIPTOR>::uninit();
        let descriptor_ptr = descriptor.as_mut_ptr().cast();
        if unsafe { InitializeSecurityDescriptor(descriptor_ptr, SECURITY_DESCRIPTOR_REVISION) }
            == 0
        {
            return Err(last_io_error("initialize private staging descriptor"));
        }
        if unsafe { SetSecurityDescriptorOwner(descriptor_ptr, current_user.sid, 0) } == 0 {
            return Err(last_io_error("set private staging owner"));
        }
        if unsafe { SetSecurityDescriptorDacl(descriptor_ptr, 1, dacl.0, 0) } == 0 {
            return Err(last_io_error("set private staging DACL"));
        }
        if unsafe {
            SetSecurityDescriptorControl(descriptor_ptr, SE_DACL_PROTECTED, SE_DACL_PROTECTED)
        } == 0
        {
            return Err(last_io_error("protect private staging DACL"));
        }
        let security_attributes = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor_ptr,
            bInheritHandle: 0,
        };

        for _attempt in 0..32 {
            let path = parent.join(format!(
                "{AUTHORIZED_EXPORT_TEMP_PREFIX}{}",
                uuid::Uuid::new_v4()
            ));
            match create_directory(&path, &security_attributes) {
                Ok(()) => {
                    let staging = WindowsStagingDir { path };
                    let inspection = inspect_private_current_user_directory_acl(staging.path())?;
                    if inspection.owner_is_current_user
                        && inspection.dacl_is_protected
                        && inspection.current_user_has_full_control
                        && inspection.only_current_user_allows_access
                    {
                        return Ok(staging);
                    }
                    return Err(AppError::FileIO(
                        "private export staging ACL verification failed".to_string(),
                    ));
                }
                Err(ERROR_ALREADY_EXISTS) => continue,
                Err(status) => {
                    return Err(last_acl_error("create private staging directory", status))
                }
            }
        }
        Err(AppError::FileIO(
            "private export staging name collisions exhausted".to_string(),
        ))
    }

    pub(super) fn create_directory(
        path: &Path,
        security_attributes: &SECURITY_ATTRIBUTES,
    ) -> Result<(), u32> {
        let path_wide = wide_path(path);
        if unsafe { CreateDirectoryW(path_wide.as_ptr(), security_attributes) } != 0 {
            Ok(())
        } else {
            Err(unsafe { GetLastError() })
        }
    }

    pub(super) fn inspect_private_current_user_directory_acl(
        path: &Path,
    ) -> Result<super::WindowsStagingDirAclInspection, AppError> {
        let current_user = CurrentUserSid::new()?;
        let path_wide = wide_path(path);
        let mut owner: PSID = null_mut();
        let mut dacl: *mut ACL = null_mut();
        let mut security_descriptor = null_mut();
        let status = unsafe {
            GetNamedSecurityInfoW(
                path_wide.as_ptr(),
                SE_FILE_OBJECT,
                OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                &mut owner,
                null_mut(),
                &mut dacl,
                null_mut(),
                &mut security_descriptor,
            )
        };
        if status != ERROR_SUCCESS {
            return Err(last_acl_error("read private staging ACL", status));
        }
        let security_descriptor = LocalSecurityDescriptor(security_descriptor);
        let owner_is_current_user =
            !owner.is_null() && unsafe { EqualSid(owner, current_user.sid) } != 0;
        let dacl_is_protected = security_descriptor.is_dacl_protected()?;
        let (current_user_has_full_control, only_current_user_allows_access) =
            inspect_allow_aces(dacl, current_user.sid)?;

        Ok(super::WindowsStagingDirAclInspection {
            owner_is_current_user,
            dacl_is_protected,
            current_user_has_full_control,
            only_current_user_allows_access,
        })
    }

    fn inspect_allow_aces(
        dacl: *mut ACL,
        current_user_sid: PSID,
    ) -> Result<(bool, bool), AppError> {
        if dacl.is_null() {
            return Ok((false, false));
        }

        let mut info = MaybeUninit::<ACL_SIZE_INFORMATION>::uninit();
        let ok = unsafe {
            GetAclInformation(
                dacl,
                info.as_mut_ptr() as *mut _,
                std::mem::size_of::<ACL_SIZE_INFORMATION>() as u32,
                AclSizeInformation,
            )
        };
        if ok == 0 {
            return Err(last_io_error("read staging DACL information"));
        }
        let info = unsafe { info.assume_init() };
        if info.AceCount != 1 {
            return Ok((false, false));
        }
        let mut current_user_has_full_control = false;

        for index in 0..info.AceCount {
            let mut ace = null_mut();
            let ok = unsafe { GetAce(dacl, index, &mut ace) };
            if ok == 0 {
                return Err(last_io_error("read staging DACL ACE"));
            }
            let header = unsafe { *(ace as *const windows_sys::Win32::Security::ACE_HEADER) };
            if u32::from(header.AceType) != ACCESS_ALLOWED_ACE_TYPE
                || u32::from(header.AceFlags) & INHERIT_ONLY_ACE != 0
            {
                return Ok((false, false));
            }

            let allowed = unsafe { &*(ace as *const ACCESS_ALLOWED_ACE) };
            let sid = &allowed.SidStart as *const u32 as PSID;
            let is_current_user = unsafe { EqualSid(sid, current_user_sid) } != 0;
            if !is_current_user {
                return Ok((current_user_has_full_control, false));
            }
            if allowed.Mask & FILE_ALL_ACCESS == FILE_ALL_ACCESS {
                current_user_has_full_control = true;
            }
        }

        Ok((current_user_has_full_control, true))
    }

    struct CurrentUserSid {
        sid: PSID,
        buffer: HLOCAL,
    }

    impl CurrentUserSid {
        fn new() -> Result<Self, AppError> {
            let mut token: HANDLE = null_mut();
            let opened = unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) };
            if opened == 0 {
                return Err(last_io_error("open current process token"));
            }
            let token = TokenHandle(token);

            let mut needed = 0u32;
            let sized =
                unsafe { GetTokenInformation(token.0, TokenUser, null_mut(), 0, &mut needed) };
            if sized != 0
                || unsafe { GetLastError() } != ERROR_INSUFFICIENT_BUFFER
                || needed < std::mem::size_of::<TOKEN_USER>() as u32
            {
                return Err(last_io_error("size current user token"));
            }
            let buffer_handle = unsafe { LocalAlloc(LMEM_FIXED, needed as usize) };
            if buffer_handle.is_null() {
                return Err(last_io_error("allocate current user token buffer"));
            }
            let buffer = buffer_handle;
            let ok =
                unsafe { GetTokenInformation(token.0, TokenUser, buffer, needed, &mut needed) };
            if ok == 0 {
                let error = last_io_error("read current user token");
                unsafe { LocalFree(buffer_handle) };
                return Err(error);
            }
            let token_user = unsafe { &*(buffer as *const TOKEN_USER) };
            if token_user.User.Sid.is_null() || unsafe { IsValidSid(token_user.User.Sid) } == 0 {
                unsafe { LocalFree(buffer_handle) };
                return Err(AppError::FileIO("invalid current user SID".to_string()));
            }
            Ok(Self {
                sid: token_user.User.Sid,
                buffer: buffer_handle,
            })
        }
    }

    impl Drop for CurrentUserSid {
        fn drop(&mut self) {
            unsafe {
                LocalFree(self.buffer);
            }
        }
    }

    struct TokenHandle(HANDLE);

    impl Drop for TokenHandle {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }

    struct LocalAcl(*mut ACL);

    impl Drop for LocalAcl {
        fn drop(&mut self) {
            unsafe {
                LocalFree(self.0.cast());
            }
        }
    }

    struct LocalSecurityDescriptor(*mut std::ffi::c_void);

    impl LocalSecurityDescriptor {
        fn is_dacl_protected(&self) -> Result<bool, AppError> {
            let mut control = 0u16;
            let mut revision = 0u32;
            let ok = unsafe { GetSecurityDescriptorControl(self.0, &mut control, &mut revision) };
            if ok == 0 {
                return Err(last_io_error("read staging security descriptor control"));
            }
            Ok(control & SE_DACL_PROTECTED != 0)
        }
    }

    impl Drop for LocalSecurityDescriptor {
        fn drop(&mut self) {
            unsafe {
                LocalFree(self.0);
            }
        }
    }

    fn wide_path(path: &Path) -> Vec<u16> {
        OsStr::new(path)
            .encode_wide()
            .chain(once(0))
            .collect::<Vec<_>>()
    }

    fn last_acl_error(context: &str, status: u32) -> AppError {
        AppError::FileIO(format!("{context}: Windows error {status}"))
    }

    fn last_io_error(context: &str) -> AppError {
        AppError::FileIO(format!("{context}: {}", std::io::Error::last_os_error()))
    }
}

#[cfg(windows)]
fn atomic_replace_file(temp_path: &Path, output_path: &Path) -> Result<(), AppError> {
    use std::ffi::OsStr;
    use std::iter::once;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, ReplaceFileW, MOVEFILE_WRITE_THROUGH,
    };

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

    let moved = unsafe {
        MoveFileExW(
            temp_wide.as_ptr(),
            output_wide.as_ptr(),
            MOVEFILE_WRITE_THROUGH,
        )
    };
    if moved != 0 {
        return Ok(());
    }

    Err(AppError::FileIO(
        std::io::Error::last_os_error().to_string(),
    ))
}
