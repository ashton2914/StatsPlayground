use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock, RwLock};

use crate::engine::duckdb_engine::DuckDbEngine;
use crate::engine::shared_database::SharedDatabase;
use crate::error::AppError;
use crate::models::project_persistence::ProjectHeader;
use crate::services::project_schema::{self, ProjectFormat};

static NEXT_EPOCH: AtomicU64 = AtomicU64::new(1);
static OWNED_FILES: OnceLock<Mutex<HashSet<same_file::Handle>>> = OnceLock::new();

pub(crate) struct FileOwner(same_file::Handle);

impl FileOwner {
    pub(crate) fn acquire(path: &Path) -> Result<Self, AppError> {
        let identity = same_file::Handle::from_path(path)?;
        let mut owners = OWNED_FILES
            .get_or_init(Default::default)
            .lock()
            .map_err(|_| AppError::Busy("project_ownership_unavailable".into()))?;
        if !owners.insert(same_file::Handle::from_path(path)?) {
            return Err(AppError::Busy("project_already_open".into()));
        }
        Ok(Self(identity))
    }
}

impl Drop for FileOwner {
    fn drop(&mut self) {
        if let Ok(mut owners) = OWNED_FILES.get_or_init(Default::default).lock() {
            owners.remove(&self.0);
        }
    }
}

/// The optional engine makes shutdown release file handles without deleting data.
pub struct ProjectDatabase {
    pub(crate) writer: Mutex<SharedDatabase>,
    pub(crate) lifecycle: RwLock<()>,
    path: PathBuf,
    epoch: u64,
    read_only: bool,
    pub(crate) readers: [Mutex<Option<DuckDbEngine>>; 2],
    pub(crate) next_reader: AtomicUsize,
    owner: Mutex<Option<FileOwner>>,
    navigation_ready: Mutex<HashMap<String, u64>>,
    checkpoints: AtomicUsize,
}

impl ProjectDatabase {
    pub fn create(path: &Path, draft: bool) -> Result<Self, AppError> {
        if path.exists() {
            return Err(AppError::InvalidParam("project_destination_exists".into()));
        }
        let parent = path
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        let temporary = tempfile::Builder::new()
            .prefix(".sp-project-")
            .suffix(".spprj")
            .tempfile_in(parent)?
            .into_temp_path();
        // DuckDB creates a new database only when its path does not exist.
        std::fs::remove_file(&temporary)?;
        {
            let engine = DuckDbEngine::create_project_file(&temporary, draft)?;
            engine.conn().execute_batch("CHECKPOINT")?;
            let storage_version = project_schema::physical_storage_version(&temporary)?;
            project_schema::create_header(engine.conn(), &storage_version)?;
            engine.conn().execute_batch("CHECKPOINT")?;
        }
        temporary
            .persist_noclobber(path)
            .map_err(|e| AppError::FileIO(e.error.to_string()))?;
        std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(path)?
            .sync_all()?;
        #[cfg(unix)]
        std::fs::File::open(parent)?.sync_all()?;
        Self::open_owned(path, false, draft)
    }

    pub fn open(path: &Path, read_only: bool) -> Result<Self, AppError> {
        Self::open_owned(path, read_only, false)
    }

    fn open_owned(path: &Path, read_only: bool, draft: bool) -> Result<Self, AppError> {
        if project_schema::detect_project_format(path)? != ProjectFormat::DuckDb {
            return Err(AppError::InvalidParam("project_requires_migration".into()));
        }
        let owner = FileOwner::acquire(path)?;
        let canonical = std::fs::canonicalize(path)?;
        let mut wal_name=canonical.as_os_str().to_os_string();wal_name.push(".wal");
        let recovery_required=match std::fs::metadata(std::path::PathBuf::from(wal_name)) {
            Ok(metadata)=>metadata.len()>0,
            Err(error) if error.kind()==std::io::ErrorKind::NotFound=>false,
            Err(error)=>return Err(error.into()),
        };
        if recovery_required&&read_only {return Err(AppError::InvalidParam("project_requires_writable_recovery".into()));}
        if !recovery_required {
            let validation = DuckDbEngine::open_project_file(&canonical, draft, true)?;
            project_schema::read_header(validation.conn(), !read_only)?;
        }
        // A dirty writable file needs DuckDB's WAL replay before its application
        // header can be read. This raw opener never initializes application schema.
        let engine = DuckDbEngine::open_project_file(&canonical, draft, read_only)?;
        project_schema::read_header(engine.conn(), !read_only)?;
        let epoch = NEXT_EPOCH
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |v| v.checked_add(1))
            .map_err(|_| AppError::Busy("project_epoch_exhausted".into()))?;
        let readers = [
            Mutex::new(Some(engine.try_clone()?)),
            Mutex::new(Some(engine.try_clone()?)),
        ];
        Ok(Self {
            writer: Mutex::new(SharedDatabase::native(engine, epoch)),
            lifecycle: RwLock::new(()),
            path: canonical,
            epoch,
            read_only,
            readers,
            next_reader: AtomicUsize::new(0),
            owner: Mutex::new(Some(owner)),
            navigation_ready: Mutex::new(HashMap::new()),
            checkpoints: AtomicUsize::new(0),
        })
    }

    pub fn header(&self) -> Result<ProjectHeader, AppError> {
        self.with_engine(|engine| project_schema::read_header(engine.conn(), !self.read_only))
    }

    pub fn epoch(&self) -> u64 {
        self.epoch
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn is_read_only(&self) -> bool {
        self.read_only
    }

    pub(crate) fn with_engine<T>(
        &self,
        apply: impl FnOnce(&DuckDbEngine) -> Result<T, AppError>,
    ) -> Result<T, AppError> {
        let _lifecycle = self
            .lifecycle
            .read()
            .map_err(|_| AppError::Busy("project_lifecycle_unavailable".into()))?;
        let writer = self
            .writer
            .lock()
            .map_err(|_| AppError::Database("project_writer_unavailable".into()))?;
        let engine = writer.lock()?;
        if engine.native_epoch() != Some(self.epoch) {
            return Err(AppError::InvalidParam("project_closed".into()));
        }
        apply(&engine)
    }

    pub(crate) fn install_writer(&self, destination: &SharedDatabase) -> Result<(), AppError> {
        let _lifecycle = self
            .lifecycle
            .write()
            .map_err(|_| AppError::Busy("project_lifecycle_unavailable".into()))?;
        let mut writer = self
            .writer
            .lock()
            .map_err(|_| AppError::Database("project_writer_unavailable".into()))?;
        writer.transfer_native_to(destination, self.epoch)?;
        *writer = destination.clone();
        Ok(())
    }

    pub fn checkpoint_if_revision(
        &self,
        epoch: u64,
        expected_revision: u64,
    ) -> Result<bool, AppError> {
        if epoch != self.epoch {
            return Err(AppError::InvalidParam("project_epoch_stale".into()));
        }
        if self.read_only {
            return Err(AppError::ReadOnly("project_read_only".into()));
        }
        self.with_engine(|engine| {
            if project_schema::read_header(engine.conn(), true)?.committed_revision
                != expected_revision
            {
                return Ok(false);
            }
            #[cfg(all(feature="project-v5",feature="perf-harness"))]
            let _checkpoint_io=crate::perf_project_v5::CheckpointIoProbe::begin();
            engine.conn().execute_batch("CHECKPOINT")?;
            self.checkpoints.fetch_add(1, Ordering::AcqRel);
            Ok(true)
        })
    }

    #[cfg(test)]
    pub fn checkpoint_count(&self) -> usize {
        self.checkpoints.load(Ordering::Acquire)
    }

    /// Close only after all consumers have detached, with no commit gap around checkpointing.
    pub fn prepare_close(&self, epoch: u64) -> Result<(), AppError> {
        if epoch != self.epoch {
            return Err(AppError::InvalidParam("project_epoch_stale".into()));
        }
        let _lifecycle = self
            .lifecycle
            .write()
            .map_err(|_| AppError::Busy("project_lifecycle_unavailable".into()))?;
        let writer = self
            .writer
            .lock()
            .map_err(|_| AppError::Database("project_writer_unavailable".into()))?;
        let readers = self
            .readers
            .iter()
            .map(|reader| {
                reader
                    .lock()
                    .map_err(|_| AppError::Database("project_reader_unavailable".into()))
            })
            .collect::<Result<Vec<_>, _>>()?;
        {
            let engine = writer.lock()?;
            if engine.native_epoch() != Some(epoch) {
                return Err(AppError::InvalidParam("project_closed".into()));
            }
            let owned_connections = 1 + readers.iter().filter(|reader| reader.is_some()).count();
            if engine.storage_connection_count() != owned_connections {
                return Err(AppError::Busy("project_readers_still_active".into()));
            }
            if !self.read_only {
                #[cfg(all(feature="project-v5",feature="perf-harness"))]
                let _checkpoint_io=crate::perf_project_v5::CheckpointIoProbe::begin();
                engine.conn().execute_batch("CHECKPOINT")?;
                self.checkpoints.fetch_add(1, Ordering::AcqRel);
            }
        }
        for mut reader in readers {
            reader.take();
        }
        writer.clear_native(epoch)?;
        self.owner
            .lock()
            .map_err(|_| AppError::Busy("project_ownership_unavailable".into()))?
            .take();
        Ok(())
    }

    pub(crate) fn ensure_navigation(
        &self,
        dataset_id: &str,
        generation: u64,
    ) -> Result<(), AppError> {
        self.with_engine(|engine| {
            let current = engine.get_dataset_generation(dataset_id)?;
            if current != generation {
                return Err(AppError::InvalidParam(
                    "project_dataset_generation_stale".into(),
                ));
            }
            let mut ready = self
                .navigation_ready
                .lock()
                .map_err(|_| AppError::Busy("project_navigation_unavailable".into()))?;
            if ready.get(dataset_id) == Some(&generation) {
                return Ok(());
            }
            let row_count = engine.get_dataset_meta(dataset_id)?.row_count;
            let generation_i64 = i64::try_from(generation)
                .map_err(|_| AppError::InvalidParam("dataset generation is too large".into()))?;
            let repair = match engine.validate_natural_anchor_manifest(
                dataset_id,
                generation_i64,
                row_count,
            ) {
                Ok(()) => false,
                Err(AppError::InvalidParam(_)) => true,
                Err(error) => return Err(error),
            };
            if repair {
                if self.read_only {
                    return Err(AppError::ReadOnly(
                        "project_navigation_repair_requires_writable".into(),
                    ));
                }
                engine.conn().execute_batch("BEGIN TRANSACTION")?;
                if let Err(error) = engine.rebuild_natural_anchors(dataset_id, generation) {
                    let _ = engine.conn().execute_batch("ROLLBACK");
                    return Err(error);
                }
                engine.conn().execute_batch("COMMIT")?;
                engine.validate_natural_anchor_manifest(dataset_id, generation_i64, row_count)?;
            }
            ready.insert(dataset_id.into(), generation);
            Ok(())
        })
    }

    pub(crate) fn is_closed(&self) -> Result<bool, AppError> {
        let writer = self
            .writer
            .lock()
            .map_err(|_| AppError::Database("project_writer_unavailable".into()))?;
        Ok(!writer.has_native_epoch(self.epoch)?)
    }

    pub fn shutdown(&self) -> Result<(), AppError> {
        let _lifecycle = self
            .lifecycle
            .write()
            .map_err(|_| AppError::Busy("project_lifecycle_unavailable".into()))?;
        for reader in &self.readers {
            reader
                .lock()
                .map_err(|_| AppError::Database("project_reader_unavailable".into()))?
                .take();
        }
        self.writer
            .lock()
            .map_err(|_| AppError::Database("project_writer_unavailable".into()))?
            .clear_native(self.epoch)?;
        self.owner
            .lock()
            .map_err(|_| AppError::Busy("project_ownership_unavailable".into()))?
            .take();
        Ok(())
    }

    #[cfg(test)]
    fn with_writer_for_test<T>(
        &self,
        apply: impl FnOnce(&DuckDbEngine) -> Result<T, AppError>,
    ) -> Result<T, AppError> {
        if self.read_only {
            return Err(AppError::ReadOnly("project_read_only".into()));
        }
        self.with_engine(apply)
    }
}

impl Drop for ProjectDatabase {
    fn drop(&mut self) {
        let _ = self.shutdown();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use duckdb::Connection;

    #[test]
    fn project_v5_lifecycle_idle_checkpoint_is_revision_fenced_and_read_only_safe() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("checkpoint.spprj");
        let database = ProjectDatabase::create(&path, false).unwrap();
        assert_eq!(database.checkpoint_count(), 0);
        assert!(database
            .checkpoint_if_revision(database.epoch() + 1, 0)
            .is_err());
        assert!(!database
            .checkpoint_if_revision(database.epoch(), 1)
            .unwrap());
        assert_eq!(database.checkpoint_count(), 0);
        assert!(database
            .checkpoint_if_revision(database.epoch(), 0)
            .unwrap());
        assert_eq!(database.checkpoint_count(), 1);
        database.prepare_close(database.epoch()).unwrap();
        assert!(database
            .checkpoint_if_revision(database.epoch(), 0)
            .is_err());
        let original = std::fs::read(&path).unwrap();
        let readonly = ProjectDatabase::open(&path, true).unwrap();
        assert!(readonly
            .checkpoint_if_revision(readonly.epoch(), 0)
            .is_err());
        readonly.prepare_close(readonly.epoch()).unwrap();
        assert_eq!(readonly.checkpoint_count(), 0);
        assert_eq!(std::fs::read(&path).unwrap(), original);
    }

    #[test]
    fn project_v5_lifecycle_prepare_close_requires_quiesced_owners_and_preserves_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("close.spprj");
        let db = ProjectDatabase::create(&path, false).unwrap();
        let external = db.with_engine(|engine| engine.try_clone()).unwrap();
        assert!(db.prepare_close(db.epoch()).is_err());
        assert!(db.header().is_ok(), "failed close keeps the writer usable");
        drop(external);
        assert!(db.prepare_close(db.epoch() + 1).is_err());
        let identity = db.header().unwrap().project_id;
        db.prepare_close(db.epoch()).unwrap();
        assert!(db.header().is_err());
        let reopened = ProjectDatabase::open(&path, false).unwrap();
        assert_eq!(reopened.header().unwrap().project_id, identity);
        reopened.prepare_close(reopened.epoch()).unwrap();
        let before = std::fs::read(&path).unwrap();
        let read_only = ProjectDatabase::open(&path, true).unwrap();
        read_only.prepare_close(read_only.epoch()).unwrap();
        assert_eq!(before, std::fs::read(&path).unwrap());
    }

    #[test]
    fn project_v5_open_writer_facade_shares_connection_and_fences_retired_owner() {
        use crate::engine::shared_database::SharedDatabase;
        use crate::models::project_persistence::ProjectWriteContext;
        let dir = tempfile::tempdir().unwrap();
        let facade = SharedDatabase::temporary(DuckDbEngine::new_in_memory().unwrap());
        let first = ProjectDatabase::create(&dir.path().join("first.spprj"), false).unwrap();
        first.install_writer(&facade).unwrap();
        let context = ProjectWriteContext {
            operation_id: "shared-writer".into(),
            expected_project_id: first.header().unwrap().project_id,
            expected_epoch: first.epoch(),
            expected_revision: 0,
            request_digest: String::new(),
            document_revisions: vec![],
            dataset_generations: vec![],
        };
        first
            .commit(&context, &true, |engine| {
                engine
                    .conn()
                    .execute_batch("CREATE TABLE sole_writer AS SELECT 42 AS value")?;
                Ok(())
            })
            .unwrap();
        assert_eq!(
            facade
                .lock()
                .unwrap()
                .conn()
                .query_row("SELECT value FROM sole_writer", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            42
        );
        assert!(facade
            .lock()
            .unwrap()
            .replace_temporary(DuckDbEngine::new_in_memory().unwrap())
            .is_err());
        first.shutdown().unwrap();
        let second = ProjectDatabase::create(&dir.path().join("second.spprj"), false).unwrap();
        second.install_writer(&facade).unwrap();
        first.shutdown().unwrap();
        assert!(first.header().is_err());
        let second_id = second.header().unwrap().project_id;
        assert_eq!(
            facade
                .lock()
                .unwrap()
                .conn()
                .query_row("SELECT project_id FROM _project_header", [], |row| row
                    .get::<_, String>(
                    0
                ))
                .unwrap(),
            second_id
        );
        second.shutdown().unwrap();
        assert!(facade.lock().is_err());
    }

    #[test]
    fn project_database_persists_tables_and_identity() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("project.spprj");
        let db = ProjectDatabase::create(&path, false).unwrap();
        let header = db.header().unwrap();
        assert_eq!(header.format_version, "5.0.0");
        assert!(header.storage_version.parse::<u64>().is_ok());
        db.with_writer_for_test(|engine| {
            engine
                .conn()
                .execute_batch("CREATE TABLE keep_values AS SELECT 42 AS value")?;
            Ok(())
        })
        .unwrap();
        db.shutdown().unwrap();
        assert!(path.exists());
        let reopened = ProjectDatabase::open(&path, false).unwrap();
        assert_eq!(reopened.header().unwrap().project_id, header.project_id);
        assert_ne!(reopened.epoch(), db.epoch());
        assert_eq!(
            reopened
                .with_writer_for_test(|engine| Ok(engine.conn().query_row(
                    "SELECT value FROM keep_values",
                    [],
                    |r| r.get::<_, i32>(0)
                )?))
                .unwrap(),
            42
        );
    }

    #[test]
    fn project_database_read_only_does_not_write_or_initialize() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("readonly.spprj");
        ProjectDatabase::create(&path, false)
            .unwrap()
            .shutdown()
            .unwrap();
        let before = std::fs::read(&path).unwrap();
        let db = ProjectDatabase::open(&path, true).unwrap();
        assert!(db
            .with_writer_for_test(|engine| {
                engine
                    .conn()
                    .execute_batch("CREATE TABLE forbidden(value INTEGER)")?;
                Ok(())
            })
            .is_err());
        db.shutdown().unwrap();
        assert_eq!(before, std::fs::read(&path).unwrap());
    }

    #[test]
    fn project_database_duplicate_owner_is_rejected_and_released() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("locked.spprj");
        let db = ProjectDatabase::create(&path, false).unwrap();
        assert!(ProjectDatabase::open(&path, false).is_err());
        let alias = dir.path().join("alias.spprj");
        std::fs::hard_link(&path, &alias).unwrap();
        assert!(ProjectDatabase::open(&alias, false).is_err());
        db.shutdown().unwrap();
        assert!(ProjectDatabase::open(&path, false).is_ok());
    }

    #[test]
    fn project_database_rejects_foreign_future_and_create_overwrite() {
        let dir = tempfile::tempdir().unwrap();
        let foreign = dir.path().join("foreign.spprj");
        Connection::open(&foreign)
            .unwrap()
            .execute_batch("CREATE TABLE untouched AS SELECT 7 AS value")
            .unwrap();
        let before = std::fs::read(&foreign).unwrap();
        assert!(ProjectDatabase::open(&foreign, false).is_err());
        assert!(ProjectDatabase::create(&foreign, false).is_err());
        assert_eq!(before, std::fs::read(&foreign).unwrap());
        let future = dir.path().join("future.spprj");
        let db = ProjectDatabase::create(&future, false).unwrap();
        db.with_writer_for_test(|engine| {
            engine
                .conn()
                .execute("UPDATE _project_header SET format_version = ?", ["99.0.0"])?;
            Ok(())
        })
        .unwrap();
        db.shutdown().unwrap();
        let before = std::fs::read(&future).unwrap();
        assert!(ProjectDatabase::open(&future, false).is_err());
        assert_eq!(before, std::fs::read(&future).unwrap());
    }

    #[test]
    fn project_database_storage_lifetime_preserves_drafts_and_clones() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("draft.spprj");
        let db = ProjectDatabase::create(&path, true).unwrap();
        drop(db);
        assert!(path.exists());
        let engine = crate::engine::duckdb_engine::DuckDbEngine::new_in_memory().unwrap();
        let temporary = engine.storage_path().to_path_buf();
        let clone = engine.try_clone().unwrap();
        drop(engine);
        assert!(temporary.exists());
        drop(clone);
        assert!(!temporary.exists());
    }
}
