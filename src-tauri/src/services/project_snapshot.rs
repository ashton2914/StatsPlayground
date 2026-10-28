use super::{project_catalog::ProjectCatalog, project_database::ProjectDatabase};
use crate::error::AppError;
use std::path::Path;

#[derive(Debug)]
pub struct SnapshotFailure {
    pub error: AppError,
    pub destination_published: bool,
}
impl From<AppError> for SnapshotFailure {
    fn from(error: AppError) -> Self {
        Self {
            error,
            destination_published: false,
        }
    }
}
impl From<std::io::Error> for SnapshotFailure {
    fn from(error: std::io::Error) -> Self {
        AppError::from(error).into()
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SnapshotPhase {
    Copy,
    Validate,
    Flush,
    Publish,
    Reopen,
}
pub struct ProjectSnapshotService;
impl ProjectSnapshotService {
    pub fn save_as(
        source: &ProjectDatabase,
        destination: &Path,
        first_naming: bool,
    ) -> Result<ProjectDatabase, SnapshotFailure> {
        Self::with_hook(source, destination, first_naming, |_| Ok(()))
    }
    fn with_hook(
        source: &ProjectDatabase,
        destination: &Path,
        first_naming: bool,
        hook: impl Fn(SnapshotPhase) -> Result<(), AppError>,
    ) -> Result<ProjectDatabase, SnapshotFailure> {
        if !source.is_closed()? {
            return Err(AppError::Busy("project_snapshot_source_open".into()).into());
        }
        if destination.exists()
            && (std::fs::symlink_metadata(destination)?.file_type().is_symlink()
                || same_file::is_same_file(source.path(), destination)?)
        {
            return Err(AppError::InvalidParam("project_snapshot_alias_destination".into()).into());
        }
        let destination_identity = if destination.exists() {
            Some(same_file::Handle::from_path(destination)?)
        } else {
            None
        };
        let _destination_owner = if destination_identity.is_some() {
            Some(super::project_database::FileOwner::acquire(destination)?)
        } else {
            None
        };
        // Native session ownership is process-local; DuckDB's file lock also excludes external readers/writers.
        let destination_engine = if destination_identity.is_some()
            && super::project_schema::detect_project_format(destination).ok()
                == Some(super::project_schema::ProjectFormat::DuckDb)
        {
            let mut wal = destination.as_os_str().to_os_string();
            wal.push(".wal");
            if Path::new(&wal).exists() {
                return Err(AppError::Busy(
                    "project_snapshot_destination_requires_recovery".into(),
                )
                .into());
            }
            Some(
                crate::engine::duckdb_engine::DuckDbEngine::open_project_file(
                    destination,
                    false,
                    false,
                )?,
            )
        } else {
            None
        };
        let mut wal = source.path().as_os_str().to_os_string();
        wal.push(".wal");
        if Path::new(&wal).exists() {
            return Err(AppError::Busy("project_snapshot_source_requires_recovery".into()).into());
        }
        // A fresh read-only owner prevents another native session from changing the source.
        let source_guard = ProjectDatabase::open(source.path(), true)?;
        let source_header = source_guard.header()?;
        let parent = destination
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        let temporary = tempfile::Builder::new()
            .prefix(".sp-snapshot-")
            .suffix(".spprj")
            .tempfile_in(parent)?
            .into_temp_path();
        hook(SnapshotPhase::Copy)?;
        {
            let mut input = std::fs::File::open(source.path())?;
            let mut output = std::fs::OpenOptions::new()
                .write(true)
                .truncate(true)
                .open(&temporary)?;
            #[cfg(any(test, feature="perf-harness"))]
            super::project_work_counters::database_copy();
            std::io::copy(&mut input, &mut output)?;
            output.sync_all()?;
        }
        source_guard.prepare_close(source_guard.epoch())?;
        hook(SnapshotPhase::Validate)?;
        let staged = ProjectDatabase::open(&temporary, false)?;
        staged.with_engine(|engine| {
            ProjectCatalog::new(engine).validate_metadata()?;
            if !first_naming {
                engine.conn().execute_batch("BEGIN TRANSACTION")?;
                let result = (|| -> Result<(), AppError> {
                    engine.conn().execute(
                        "UPDATE _project_header SET project_id=? WHERE singleton=TRUE",
                        [uuid::Uuid::new_v4().to_string()],
                    )?;
                    engine
                        .conn()
                        .execute_batch("DELETE FROM _project_commit_receipts")?;
                    let has_cancellations:bool=engine.conn().query_row("SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name='_project_cancelled_operations')",[],|row|row.get(0))?;
                    if has_cancellations {engine.conn().execute_batch("DELETE FROM _project_cancelled_operations")?;}
                    Ok(())
                })();
                if let Err(error) = result {
                    let _ = engine.conn().execute_batch("ROLLBACK");
                    return Err(error);
                }
                engine.conn().execute_batch("COMMIT")?;
            }
            Ok(())
        })?;
        if first_naming && staged.header()?.project_id != source_header.project_id {
            return Err(AppError::InvalidParam("project_snapshot_identity_mismatch".into()).into());
        }
        staged.prepare_close(staged.epoch())?;
        hook(SnapshotPhase::Flush)?;
        std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&temporary)?
            .sync_all()?;
        hook(SnapshotPhase::Publish)?;
        let current_identity = if destination.exists() {
            Some(same_file::Handle::from_path(destination)?)
        } else {
            None
        };
        if current_identity != destination_identity {
            return Err(AppError::Busy("project_snapshot_destination_changed".into()).into());
        }
        // Windows replacement rejects open DuckDB handles itself; POSIX needs the lock held through rename.
        #[cfg(windows)]
        drop(destination_engine);
        super::streaming_project_writer::replace_archive_atomically_os(&temporary, destination)?;
        #[cfg(not(windows))]
        drop(destination_engine);
        let reopen = (|| -> Result<ProjectDatabase, AppError> {
            #[cfg(unix)]
            std::fs::File::open(parent)?.sync_all()?;
            hook(SnapshotPhase::Reopen)?;
            ProjectDatabase::open(destination, false)
        })();
        reopen.map_err(|error| SnapshotFailure {
            error,
            destination_published: true,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn project_snapshot_cancellation_namespace_follows_project_identity() {
        use crate::models::project_persistence::ProjectWriteContext;
        let root=tempfile::tempdir().unwrap();let source=ProjectDatabase::create(&root.path().join("source.spprj"),false).unwrap();let project_id=source.header().unwrap().project_id;
        let context=ProjectWriteContext {operation_id:"cancelled".into(),expected_project_id:project_id.clone(),expected_epoch:source.epoch(),expected_revision:0,request_digest:String::new(),document_revisions:vec![],dataset_generations:vec![]};
        source.resolve_operation(&context).unwrap();source.prepare_close(source.epoch()).unwrap();
        let named=ProjectSnapshotService::save_as(&source,&root.path().join("named.spprj"),true).unwrap();
        let count:i64=named.with_reader(named.epoch(),|engine|Ok(engine.conn().query_row("SELECT COUNT(*) FROM _project_cancelled_operations",[],|row|row.get(0))?)).unwrap();assert_eq!(count,1);named.prepare_close(named.epoch()).unwrap();
        let copy=ProjectSnapshotService::save_as(&named,&root.path().join("copy.spprj"),false).unwrap();assert_ne!(copy.header().unwrap().project_id,project_id);
        let count:i64=copy.with_reader(copy.epoch(),|engine|Ok(engine.conn().query_row("SELECT COUNT(*) FROM _project_cancelled_operations",[],|row|row.get(0))?)).unwrap();assert_eq!(count,0,"Save As must reset the old cancellation namespace");
    }

    #[test]
    fn project_snapshot_preserves_unrecovered_wal_files_and_readonly_sources() {
        let root = tempfile::tempdir().unwrap();
        let source_path = root.path().join("source.spprj");
        let source = ProjectDatabase::create(&source_path, false).unwrap();
        source.prepare_close(source.epoch()).unwrap();
        let original = std::fs::read(&source_path).unwrap();
        let mut wal_path = source_path.as_os_str().to_os_string();
        wal_path.push(".wal");
        std::fs::write(&wal_path, b"retain source WAL").unwrap();
        let destination = root.path().join("copy.spprj");
        let failure = match ProjectSnapshotService::save_as(&source, &destination, false) {
            Err(failure) => failure,
            Ok(_) => panic!("WAL requires explicit recovery"),
        };
        assert!(!failure.destination_published);
        assert!(!destination.exists());
        assert_eq!(std::fs::read(&source_path).unwrap(), original);
        assert_eq!(std::fs::read(&wal_path).unwrap(), b"retain source WAL");

        let clean_root = tempfile::tempdir().unwrap();
        let clean_path = clean_root.path().join("readonly.spprj");
        ProjectDatabase::create(&clean_path, false)
            .unwrap()
            .shutdown()
            .unwrap();
        let readonly = ProjectDatabase::open(&clean_path, true).unwrap();
        let identity = readonly.header().unwrap().project_id;
        readonly.prepare_close(readonly.epoch()).unwrap();
        let original = std::fs::read(&clean_path).unwrap();
        let destination = clean_root.path().join("copy.spprj");
        let copy = ProjectSnapshotService::save_as(&readonly, &destination, false).unwrap();
        assert_ne!(copy.header().unwrap().project_id, identity);
        assert_eq!(std::fs::read(&clean_path).unwrap(), original);
        copy.prepare_close(copy.epoch()).unwrap();
        let original_destination = std::fs::read(&destination).unwrap();
        let mut destination_wal = destination.as_os_str().to_os_string();
        destination_wal.push(".wal");
        std::fs::write(&destination_wal, b"retain destination WAL").unwrap();
        assert!(ProjectSnapshotService::save_as(&readonly, &destination, false).is_err());
        assert_eq!(std::fs::read(&destination).unwrap(), original_destination);
        assert_eq!(
            std::fs::read(&destination_wal).unwrap(),
            b"retain destination WAL"
        );
    }

    #[test]
    fn project_snapshot_rejects_destination_open_in_another_process() {
        const CHILD_PATH: &str = "STATSPG_SNAPSHOT_OCCUPIED_DESTINATION";
        if let Some(path) = std::env::var_os(CHILD_PATH) {
            let path = std::path::PathBuf::from(path);
            let _database = ProjectDatabase::open(&path, false).unwrap();
            std::fs::write(path.with_extension("ready"), b"ready").unwrap();
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
            while !path.with_extension("stop").exists() {
                assert!(std::time::Instant::now() < deadline);
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            return;
        }
        struct Child(std::process::Child);
        impl Drop for Child {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        let root = tempfile::tempdir().unwrap();
        let source = ProjectDatabase::create(&root.path().join("source.spprj"), false).unwrap();
        source.prepare_close(source.epoch()).unwrap();
        let destination = root.path().join("occupied.spprj");
        ProjectDatabase::create(&destination, false)
            .unwrap()
            .shutdown()
            .unwrap();
        let before = std::fs::read(&destination).unwrap();
        let _child = Child(std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "services::project_snapshot::tests::project_snapshot_rejects_destination_open_in_another_process"])
            .env(CHILD_PATH, &destination).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn().unwrap());
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while !destination.with_extension("ready").exists() {
            assert!(
                std::time::Instant::now() < deadline,
                "child did not acquire project"
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        let failure = match ProjectSnapshotService::save_as(&source, &destination, false) {
            Err(error) => error,
            Ok(_) => panic!("must not replace a project another process is using"),
        };
        assert!(!failure.destination_published);
        assert_eq!(std::fs::read(&destination).unwrap(), before);
    }

    #[test]
    fn project_snapshot_failure_matrix_preserves_source_and_reports_publication() {
        for phase in [
            SnapshotPhase::Copy,
            SnapshotPhase::Validate,
            SnapshotPhase::Flush,
            SnapshotPhase::Publish,
            SnapshotPhase::Reopen,
        ] {
            let root = tempfile::tempdir().unwrap();
            let source_path = root.path().join("source.spprj");
            let source = ProjectDatabase::create(&source_path, false).unwrap();
            let identity = source.header().unwrap().project_id;
            source.prepare_close(source.epoch()).unwrap();
            let original = std::fs::read(&source_path).unwrap();
            let destination = root.path().join("destination.spprj");
            std::fs::write(&destination, b"existing file").unwrap();
            let failure =
                match ProjectSnapshotService::with_hook(&source, &destination, false, |current| {
                    if current == phase {
                        Err(AppError::FileIO(format!("injected {phase:?}")))
                    } else {
                        Ok(())
                    }
                }) {
                    Err(failure) => failure,
                    Ok(_) => panic!("injection must fail"),
                };
            assert!(failure.error.to_string().contains("injected"));
            assert_eq!(
                failure.destination_published,
                phase == SnapshotPhase::Reopen
            );
            assert_eq!(std::fs::read(&source_path).unwrap(), original);
            if phase == SnapshotPhase::Reopen {
                let published = ProjectDatabase::open(&destination, false).unwrap();
                assert_ne!(published.header().unwrap().project_id, identity);
            } else {
                assert_eq!(std::fs::read(&destination).unwrap(), b"existing file");
            }
            ProjectDatabase::open(&source_path, false)
                .unwrap()
                .shutdown()
                .unwrap();
        }
    }

    #[test]
    fn project_snapshot_rejects_destination_owned_by_another_session() {
        let root = tempfile::tempdir().unwrap();
        let source = ProjectDatabase::create(&root.path().join("source.spprj"), false).unwrap();
        source.prepare_close(source.epoch()).unwrap();
        let destination = root.path().join("live.spprj");
        let live = ProjectDatabase::create(&destination, false).unwrap();
        let before = std::fs::read(&destination).unwrap();
        let failure = match ProjectSnapshotService::save_as(&source, &destination, false) {
            Err(error) => error,
            Ok(_) => panic!("an owned destination must not be replaced"),
        };
        assert!(
            !failure.destination_published,
            "must reject before replacement"
        );
        assert_eq!(std::fs::read(&destination).unwrap(), before);
        assert!(live.header().is_ok());
    }

    #[test]
    fn project_snapshot_first_naming_and_save_as_preserve_artifacts_and_source() {
        let root = tempfile::tempdir().unwrap();
        let source_path = root.path().join("draft.spprj");
        let source = ProjectDatabase::create(&source_path, true).unwrap();
        source
            .with_engine(|engine| {
                engine
                    .conn()
                    .execute_batch("CREATE TABLE artifact_stable AS SELECT 42 AS value")?;
                Ok(())
            })
            .unwrap();
        let identity = source.header().unwrap().project_id;
        assert!(
            ProjectSnapshotService::save_as(&source, &root.path().join("unsafe.spprj"), true)
                .is_err(),
            "copying a live source is forbidden"
        );
        source.prepare_close(source.epoch()).unwrap();
        let original = std::fs::read(&source_path).unwrap();
        let named_path = root.path().join("named.spprj");
        let named = ProjectSnapshotService::save_as(&source, &named_path, true).unwrap();
        assert_eq!(named.header().unwrap().project_id, identity);
        assert_eq!(
            named
                .with_engine(|engine| Ok(engine.conn().query_row(
                    "SELECT value FROM artifact_stable",
                    [],
                    |row| row.get::<_, i64>(0)
                )?))
                .unwrap(),
            42
        );
        named.prepare_close(named.epoch()).unwrap();
        let copy = ProjectSnapshotService::save_as(&source, &root.path().join("copy.spprj"), false)
            .unwrap();
        assert_ne!(copy.header().unwrap().project_id, identity);
        assert_eq!(std::fs::read(&source_path).unwrap(), original);
        assert!(ProjectSnapshotService::save_as(&source, &source_path, false).is_err());
        let alias = root.path().join("alias.spprj");
        std::fs::hard_link(&source_path, &alias).unwrap();
        assert!(ProjectSnapshotService::save_as(&source, &alias, false).is_err());
    }
}
