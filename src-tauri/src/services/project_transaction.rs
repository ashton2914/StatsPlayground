use std::sync::atomic::Ordering;

use duckdb::{params, OptionalExt};
use serde::{de::DeserializeOwned, Serialize};
use sha2::{Digest, Sha256};

use crate::engine::duckdb_engine::DuckDbEngine;
use crate::error::AppError;
use crate::models::project_persistence::{
    DatasetGeneration, DocumentRevision, ProjectCommit, ProjectWriteContext,
};
use crate::services::project_database::ProjectDatabase;
use crate::services::project_schema;

#[cfg(test)]
thread_local! { static COMMIT_FAILURE: std::cell::Cell<u8> = const { std::cell::Cell::new(0) }; }

#[cfg(test)]
pub(crate) fn inject_commit_failure_for_test(mode: u8) {
    COMMIT_FAILURE.with(|failure| failure.set(mode));
}

pub(crate) struct CommitEffects<T> {
    pub value: T,
    pub dataset_ids: Vec<String>,
    pub document_ids: Vec<String>,
    pub setting_ids: Vec<String>,
}

struct Transaction<'a> {
    conn: &'a duckdb::Connection,
    active: bool,
}

impl Drop for Transaction<'_> {
    fn drop(&mut self) {
        if self.active {
            let _ = self.conn.execute_batch("ROLLBACK");
        }
    }
}

fn fingerprint(
    context: &ProjectWriteContext,
    request: &impl Serialize,
) -> Result<String, AppError> {
    let mut documents = context.document_revisions.clone();
    documents.sort_by(|a, b| a.id.cmp(&b.id));
    let mut datasets = context.dataset_generations.clone();
    datasets.sort_by(|a, b| a.id.cmp(&b.id));
    let mut canonical = serde_json::to_value((
        &context.expected_project_id,
        context.expected_revision,
        documents,
        datasets,
        request,
    ))
    .map_err(|_| AppError::InvalidParam("project_request_not_serializable".into()))?;
    canonical.sort_all_objects();
    let bytes = serde_json::to_vec(&canonical)
        .map_err(|_| AppError::InvalidParam("project_request_not_serializable".into()))?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn read_operation_state<T:DeserializeOwned>(
    engine:&DuckDbEngine,context:&ProjectWriteContext,digest:&str,epoch:u64,
)->Result<(crate::models::project_persistence::ProjectHeader,Option<ProjectCommit<T>>),AppError> {
    let conn=engine.conn();
    let header = project_schema::read_header(conn, true)?;
    if header.project_id != context.expected_project_id {
        return Err(AppError::InvalidParam("project_identity_stale".into()));
    }
    let receipt = conn
        .query_row(
            "SELECT request_digest, result_json FROM _project_commit_receipts
         WHERE project_id = ? AND operation_id = ?",
            params![&header.project_id, &context.operation_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?;
    if let Some((recorded_digest, json)) = receipt {
        if recorded_digest != digest {
            return Err(AppError::InvalidParam("project_operation_id_reused".into()));
        }
        let mut replay: ProjectCommit<T> = serde_json::from_str(&json)
            .map_err(|_| AppError::Database("project_receipt_invalid".into()))?;
        replay.epoch = epoch;
        return Ok((header,Some(replay)));
    }
    let has_cancellations:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name='_project_cancelled_operations')",[],|row|row.get(0))?;
    if has_cancellations {
        let cancelled:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM _project_cancelled_operations WHERE project_id=? AND operation_id=?)",params![&header.project_id,&context.operation_id],|row|row.get(0))?;
        if cancelled {return Err(AppError::InvalidParam("project_operation_cancelled".into()));}
    }
    Ok((header,None))
}

fn validate_current_context(engine:&DuckDbEngine,context:&ProjectWriteContext,committed_revision:u64)->Result<(),AppError> {
    let conn=engine.conn();
    if committed_revision != context.expected_revision {
        return Err(AppError::InvalidParam("project_revision_stale".into()));
    }
    for expected in &context.dataset_generations {
        if engine.get_dataset_generation(&expected.id)? != expected.generation {
            return Err(AppError::InvalidParam(
                "project_dataset_generation_stale".into(),
            ));
        }
    }
    for expected in &context.document_revisions {
        let revision: u64 = conn.query_row(
            "SELECT revision FROM _project_directory WHERE id = ?",
            [&expected.id],
            |r| r.get(0),
        )?;
        if revision != expected.revision {
            return Err(AppError::InvalidParam(
                "project_document_revision_stale".into(),
            ));
        }
    }
    Ok(())
}

impl ProjectDatabase {
    pub fn resolve_operation(&self,context:&ProjectWriteContext)->Result<crate::models::project_persistence::ProjectOperationResolution,AppError> {
        use crate::models::project_persistence::ProjectOperationResolution;
        if self.is_read_only() {return Err(AppError::ReadOnly("project_read_only".into()));}
        if context.expected_epoch!=self.epoch() {return Err(AppError::InvalidParam("project_epoch_stale".into()));}
        if context.operation_id.trim().is_empty()||context.operation_id.len()>256 {return Err(AppError::InvalidParam("project_operation_id_invalid".into()));}
        self.with_engine(|engine| {
            let conn=engine.conn();let header=project_schema::read_header(conn,true)?;
            if header.project_id!=context.expected_project_id {return Err(AppError::InvalidParam("project_identity_stale".into()));}
            let receipt:Option<String>=conn.query_row("SELECT result_json FROM _project_commit_receipts WHERE project_id=? AND operation_id=?",params![&header.project_id,&context.operation_id],|row|row.get(0)).optional()?;
            if let Some(json)=receipt {let mut commit:ProjectCommit<serde_json::Value>=serde_json::from_str(&json).map_err(|_|AppError::Database("project_receipt_invalid".into()))?;commit.epoch=self.epoch();return Ok(ProjectOperationResolution::Committed{commit});}
            conn.execute_batch("BEGIN TRANSACTION")?;let mut transaction=Transaction{conn,active:true};
            conn.execute_batch("CREATE TABLE IF NOT EXISTS _project_cancelled_operations(project_id VARCHAR NOT NULL,operation_id VARCHAR NOT NULL,PRIMARY KEY(project_id,operation_id))")?;
            conn.execute("INSERT INTO _project_cancelled_operations VALUES(?,?) ON CONFLICT DO NOTHING",params![&header.project_id,&context.operation_id])?;
            conn.execute_batch("COMMIT")?;transaction.active=false;
            Ok(ProjectOperationResolution::Cancelled{operation_id:context.operation_id.clone(),epoch:self.epoch(),committed_revision:header.committed_revision})
        })
    }

    pub fn committed_revision(&self) -> Result<u64, AppError> {
        Ok(self.header()?.committed_revision)
    }

    pub fn with_reader<T>(
        &self,
        epoch: u64,
        read: impl FnOnce(&DuckDbEngine) -> Result<T, AppError>,
    ) -> Result<T, AppError> {
        let _lifecycle = self
            .lifecycle
            .read()
            .map_err(|_| AppError::Busy("project_lifecycle_unavailable".into()))?;
        if epoch != self.epoch() {
            return Err(AppError::InvalidParam("project_epoch_stale".into()));
        }
        let slot = self.next_reader.fetch_add(1, Ordering::Relaxed) % self.readers.len();
        let reader = self.readers[slot]
            .lock()
            .map_err(|_| AppError::Database("project_reader_unavailable".into()))?;
        let engine = reader
            .as_ref()
            .ok_or_else(|| AppError::InvalidParam("project_closed".into()))?;
        let conn = engine.conn();
        conn.execute_batch("BEGIN TRANSACTION READ ONLY")?;
        let mut transaction = Transaction { conn, active: true };
        let value = read(engine)?;
        conn.execute_batch("COMMIT")?;
        transaction.active = false;
        Ok(value)
    }

    /// `request` is the normalized typed operation, including its command identity.
    /// The callback must use transaction-neutral helpers on the supplied engine.
    #[cfg(test)]
    pub fn commit<T: Serialize + DeserializeOwned, P: Serialize>(
        &self,
        context: &ProjectWriteContext,
        request: &P,
        apply: impl FnOnce(&DuckDbEngine) -> Result<T, AppError>,
    ) -> Result<ProjectCommit<T>, AppError> {
        self.commit_with_effects(context, request, |engine| {
            Ok(CommitEffects {
                value: apply(engine)?,
                dataset_ids: Vec::new(),
                document_ids: Vec::new(),
                setting_ids: Vec::new(),
            })
        })
    }

    fn operation_digest<P:Serialize>(&self,context:&ProjectWriteContext,request:&P)->Result<String,AppError> {
        if self.is_read_only() {
            return Err(AppError::ReadOnly("project_read_only".into()));
        }
        if context.expected_epoch != self.epoch() {
            return Err(AppError::InvalidParam("project_epoch_stale".into()));
        }
        if context.operation_id.trim().is_empty() || context.operation_id.len() > 256 {
            return Err(AppError::InvalidParam(
                "project_operation_id_invalid".into(),
            ));
        }
        let digest = fingerprint(context, request)?;
        if !context.request_digest.is_empty() && context.request_digest != digest {
            return Err(AppError::InvalidParam(
                "project_request_digest_mismatch".into(),
            ));
        }
        Ok(digest)
    }

    /// Read the immutable acknowledgement before expensive computation. This
    /// reserves nothing; publication must still revalidate the same context.
    pub(crate) fn preflight_commit<T:DeserializeOwned,P:Serialize>(
        &self,context:&ProjectWriteContext,request:&P,
    )->Result<Option<ProjectCommit<T>>,AppError> {
        let digest=self.operation_digest(context,request)?;
        self.with_engine(|engine| {
            let (header,receipt)=read_operation_state(engine,context,&digest,self.epoch())?;
            if receipt.is_some() {return Ok(receipt);}
            validate_current_context(engine,context,header.committed_revision)?;
            Ok(None)
        })
    }

    pub(crate) fn commit_with_effects<T: Serialize + DeserializeOwned, P: Serialize>(
        &self,
        context: &ProjectWriteContext,
        request: &P,
        apply: impl FnOnce(&DuckDbEngine) -> Result<CommitEffects<T>, AppError>,
    ) -> Result<ProjectCommit<T>, AppError> {
        let digest=self.operation_digest(context,request)?;
        self.with_engine(|engine| {
            let conn = engine.conn();
            let (header,receipt)=read_operation_state(engine,context,&digest,self.epoch())?;
            if let Some(receipt)=receipt {return Ok(receipt);}
            conn.execute_batch("BEGIN TRANSACTION")?;
            let mut transaction = Transaction { conn, active: true };
            validate_current_context(engine,context,header.committed_revision)?;
            let mut history_cursors = std::collections::BTreeMap::new();
            for expected in &context.dataset_generations {
                let next:Option<u64> = conn.query_row("SELECT next_history_ordinal FROM _history_dataset_state WHERE dataset_id=?",[&expected.id],|row|row.get(0)).optional()?;
                history_cursors.insert(expected.id.clone(),next.unwrap_or(0));
            }
            let effects = apply(engine)?;
            let value = effects.value;
            let revision = header
                .committed_revision
                .checked_add(1)
                .ok_or_else(|| AppError::InvalidParam("project_revision_exhausted".into()))?;
            let mut generations = Vec::new();
            let dataset_ids = context
                .dataset_generations
                .iter()
                .map(|expected| expected.id.clone())
                .chain(effects.dataset_ids)
                .collect::<std::collections::BTreeSet<_>>();
            for id in dataset_ids.iter().cloned() {
                let generation: Option<u64> = conn
                    .query_row(
                        "SELECT generation FROM _meta_datasets WHERE id = ?",
                        [&id],
                        |r| r.get(0),
                    )
                    .optional()?;
                if let Some(generation) = generation {
                    generations.push(DatasetGeneration { id, generation });
                }
            }
            let mut documents = Vec::new();
            let mut document_ids = context
                .document_revisions
                .iter()
                .map(|expected| expected.id.clone())
                .chain(effects.document_ids)
                .chain(dataset_ids)
                .collect::<std::collections::BTreeSet<_>>();
            let mut directory_entries = Vec::new();
            let mut deleted_directory_ids = Vec::new();
            let mut visited_directory_ids = std::collections::BTreeSet::new();
            while let Some(id) = document_ids.pop_first() {
                if !visited_directory_ids.insert(id.clone()) { continue; }
                let revision: Option<u64> = conn
                    .query_row(
                        "SELECT revision FROM _project_directory WHERE id = ?",
                        [&id],
                        |r| r.get(0),
                    )
                    .optional()?;
                if let Some(revision) = revision {
                    let summary=crate::services::project_catalog::ProjectCatalog::new(engine).summary(&id)?;
                    if !summary.folder.is_empty() { document_ids.insert(format!("folder:{}",summary.folder)); }
                    directory_entries.push(summary);
                    documents.push(DocumentRevision { id, revision });
                } else { deleted_directory_ids.push(id); }
            }
            let dataset_metadata=directory_entries.iter().filter(|entry|entry.kind==crate::models::project_persistence::ProjectDocumentKind::Table).map(|entry|engine.get_dataset_meta(&entry.id)).collect::<Result<Vec<_>,_>>()?;
            let mut settings = Vec::new();
            let mut filter_settings = Vec::new();
            for key in effects
                .setting_ids
                .into_iter()
                .collect::<std::collections::BTreeSet<_>>()
            {
                let revision: Option<u64> = conn
                    .query_row(
                        "SELECT revision FROM _project_settings WHERE key=?",
                        [&key],
                        |row| row.get(0),
                    )
                    .optional()?;
                if let Some(revision) = revision {
                    if let Some(dataset) = key.strip_prefix("filter:") {
                        let value=crate::services::project_catalog::ProjectCatalog::new(engine).get_setting(&key)?.ok_or_else(||AppError::Database("project_filter_setting_missing".into()))?.1;
                        filter_settings.push(crate::models::project_persistence::ProjectSettingRecord {key:key.clone(),revision,value:crate::services::project_column_filters::effective(engine,dataset,value)?});
                    }
                    settings.push(crate::models::project_persistence::SettingRevision {
                        key,
                        revision,
                    });
                }
            }
            let mut history_entries = Vec::new();
            let public_history = super::project_history_group::public_timeline(engine)?;
            for (dataset_id,first) in history_cursors {
                let next:Option<u64> = conn.query_row("SELECT next_history_ordinal FROM _history_dataset_state WHERE dataset_id=?",[&dataset_id],|row|row.get(0)).optional()?;
                for ordinal in first..next.unwrap_or(first) {
                    let entry = conn.query_row(
                        &format!("SELECT change_set_id,dataset_id,operation,applied,current_generation FROM ({public_history}) visible WHERE dataset_id=? AND history_ordinal=?"),
                        params![&dataset_id,ordinal],|row|Ok(crate::models::project_persistence::ProjectHistorySummary {
                            id:row.get(0)?,dataset_id:row.get(1)?,operation:row.get(2)?,applied:row.get(3)?,generation:row.get(4)?,dataset_name:None,description:None,timestamp:None,
                        })).optional()?;
                    if let Some(entry) = entry { history_entries.push(entry); }
                }
            }
            history_entries.extend(super::project_table_lifecycle::committed_summaries(engine,revision)?);
            super::project_history_frontier::record(engine,revision,&history_entries)?;
            let mut outcome = ProjectCommit {
                operation_id: context.operation_id.clone(),
                epoch: 0,
                committed_revision: revision,
                value,
                changed_dataset_generations: generations,
                changed_dataset_metadata:dataset_metadata,
                changed_document_revisions: documents,
                changed_setting_revisions: settings,
                changed_filter_settings: filter_settings,
                changed_history_entries: history_entries,
                changed_directory_entries: directory_entries,
                deleted_directory_ids,
            };
            let serialized = serde_json::to_string(&outcome)
                .map_err(|_| AppError::InvalidParam("project_result_not_serializable".into()))?;
            conn.execute(
                "UPDATE _project_header SET committed_revision = ? WHERE singleton = TRUE",
                [revision],
            )?;
            conn.execute(
                "INSERT INTO _project_commit_receipts VALUES (?, ?, ?, ?)",
                params![
                    &header.project_id,
                    &context.operation_id,
                    &digest,
                    &serialized
                ],
            )?;
            #[cfg(test)]
            let failure = COMMIT_FAILURE.with(|f| f.replace(0));
            #[cfg(test)]
            if failure == 1 {
                return Err(AppError::Database("injected_before_commit".into()));
            }
            #[cfg(all(feature="project-v5",feature="perf-harness"))]
            crate::perf_project_v5::crash_point("before-commit",&context.operation_id)?;
            conn.execute_batch("COMMIT")?;
            transaction.active = false;
            #[cfg(all(feature="project-v5",feature="perf-harness"))]
            crate::perf_project_v5::crash_point("after-commit",&context.operation_id)?;
            #[cfg(test)]
            if failure == 2 {
                return Err(AppError::Database("injected_lost_ack".into()));
            }
            outcome.epoch = self.epoch();
            Ok(outcome)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::project_persistence::{DatasetGeneration, ProjectWriteContext};
    use crate::services::project_database::ProjectDatabase;
    use serde_json::json;

    fn context(db: &ProjectDatabase, id: &str, revision: u64) -> ProjectWriteContext {
        ProjectWriteContext {
            operation_id: id.into(),
            expected_project_id: db.header().unwrap().project_id,
            expected_epoch: db.epoch(),
            expected_revision: revision,
            request_digest: String::new(),
            document_revisions: vec![],
            dataset_generations: vec![],
        }
    }

    #[test]
    fn project_transaction_preflight_replays_without_reserving_or_mutating() {
        let dir=tempfile::tempdir().unwrap();let path=dir.path().join("preflight.spprj");let db=ProjectDatabase::create(&path,false).unwrap();
        let original=context(&db,"compute-once",0);let payload=json!({"kind":"compute","seed":7});
        assert!(db.preflight_commit::<u64,_>(&original,&payload).unwrap().is_none());assert_eq!(db.committed_revision().unwrap(),0);
        let cancelled:i64=db.with_engine(|e|Ok(e.conn().query_row("SELECT COUNT(*) FROM _project_cancelled_operations",[],|r|r.get(0))?)).unwrap();assert_eq!(cancelled,0);
        let saved=db.commit(&original,&payload,|_|Ok(42u64)).unwrap();db.commit(&context(&db,"other",1),&"other",|_|Ok(1u64)).unwrap();
        assert_eq!(serde_json::to_value(db.preflight_commit::<u64,_>(&original,&payload).unwrap().unwrap()).unwrap(),serde_json::to_value(saved).unwrap());
        assert!(db.preflight_commit::<u64,_>(&original,&json!({"kind":"compute","seed":8})).unwrap_err().to_string().contains("operation_id_reused"));
        assert!(db.preflight_commit::<u64,_>(&context(&db,"new-stale",0),&payload).unwrap_err().to_string().contains("revision_stale"));
        let mut foreign=original.clone();foreign.expected_epoch+=1;assert!(db.preflight_commit::<u64,_>(&foreign,&payload).unwrap_err().to_string().contains("epoch_stale"));
        foreign=original.clone();foreign.expected_project_id="foreign".into();assert!(db.preflight_commit::<u64,_>(&foreign,&payload).unwrap_err().to_string().contains("identity_stale"));
        let rejected=context(&db,"cancelled",2);db.resolve_operation(&rejected).unwrap();assert!(db.preflight_commit::<u64,_>(&rejected,&payload).unwrap_err().to_string().contains("operation_cancelled"));
        assert_eq!(db.committed_revision().unwrap(),2);
    }

    #[test]
    fn project_transaction_resolution_fences_late_requests_and_returns_committed_receipts() {
        let dir=tempfile::tempdir().unwrap();let path=dir.path().join("resolution.spprj");let db=ProjectDatabase::create(&path,false).unwrap();let cancelled=context(&db,"cancelled",0);
        let resolution=db.resolve_operation(&cancelled).unwrap();assert_eq!(serde_json::to_value(&resolution).unwrap()["status"],"cancelled");
        let error=db.commit(&cancelled,&"late",|_|Ok(99u64)).unwrap_err();assert!(error.to_string().contains("project_operation_cancelled"));assert_eq!(db.committed_revision().unwrap(),0);
        let applied=context(&db,"committed",0);let receipt=db.commit(&applied,&"applied",|engine| {engine.conn().execute_batch("CREATE TABLE applied(value INTEGER); INSERT INTO applied VALUES(1)")?;Ok(27u64)}).unwrap();
        let resolved=serde_json::to_value(db.resolve_operation(&applied).unwrap()).unwrap();assert_eq!(resolved["status"],"committed");assert_eq!(resolved["commit"]["value"],27);assert_eq!(resolved["commit"]["committedRevision"],receipt.committed_revision);
        db.prepare_close(db.epoch()).unwrap();let db=ProjectDatabase::open(&path,false).unwrap();let mut late=cancelled.clone();late.expected_epoch=db.epoch();
        assert!(db.commit(&late,&"late",|_|Ok(99u64)).unwrap_err().to_string().contains("project_operation_cancelled"));
        assert_eq!(serde_json::to_value(db.resolve_operation(&late).unwrap()).unwrap()["status"],"cancelled");
        let mut foreign=late.clone();foreign.expected_project_id="foreign".into();assert!(db.resolve_operation(&foreign).is_err());
        foreign=late.clone();foreign.expected_epoch+=1;assert!(db.resolve_operation(&foreign).is_err());
    }

    #[test]
    fn project_transaction_resolution_supports_pre_marker_files_and_lost_ack() {
        let dir=tempfile::tempdir().unwrap();let path=dir.path().join("old-resolution.spprj");let db=ProjectDatabase::create(&path,false).unwrap();
        db.with_engine(|engine|{engine.conn().execute_batch("DROP TABLE _project_cancelled_operations")?;Ok(())}).unwrap();
        let applied=context(&db,"lost-ack",0);inject_commit_failure_for_test(2);
        assert!(db.commit(&applied,&"applied",|engine|{engine.conn().execute_batch("CREATE TABLE applied(value INTEGER);INSERT INTO applied VALUES(1)")?;Ok(27u64)}).unwrap_err().to_string().contains("injected_lost_ack"));
        let exists:bool=db.with_reader(db.epoch(),|engine|Ok(engine.conn().query_row("SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name='_project_cancelled_operations')",[],|row|row.get(0))?)).unwrap();assert!(!exists,"ordinary commits must not upgrade pre-marker files");
        let resolved=serde_json::to_value(db.resolve_operation(&applied).unwrap()).unwrap();assert_eq!(resolved["status"],"committed");assert_eq!(resolved["commit"]["value"],27);
        let cancelled=context(&db,"cancel",1);assert_eq!(serde_json::to_value(db.resolve_operation(&cancelled).unwrap()).unwrap()["status"],"cancelled");assert_eq!(db.committed_revision().unwrap(),1);
        let count:i64=db.with_reader(db.epoch(),|engine|Ok(engine.conn().query_row("SELECT COUNT(*) FROM applied",[],|row|row.get(0))?)).unwrap();assert_eq!(count,1);
    }

    #[test]
    fn project_transaction_reader_cannot_bypass_writer() {
        let dir = tempfile::tempdir().unwrap();
        let db = ProjectDatabase::create(&dir.path().join("reader.spprj"), false).unwrap();
        let result = db.with_reader(db.epoch(), |engine| {
            engine
                .conn()
                .execute_batch("CREATE TABLE reader_bypass(value INTEGER)")?;
            Ok(())
        });
        assert!(result.is_err(), "reader callbacks must not publish writes");
        assert_eq!(db.committed_revision().unwrap(), 0);
    }

    #[test]
    fn project_transaction_rejects_foreign_project_identity_even_with_current_epoch() {
        let dir = tempfile::tempdir().unwrap();
        let db = ProjectDatabase::create(&dir.path().join("identity.spprj"), false).unwrap();
        let mut json = serde_json::to_value(context(&db, "foreign", 0)).unwrap();
        json["expectedProjectId"] = json!(uuid::Uuid::new_v4().to_string());
        let context: ProjectWriteContext = serde_json::from_value(json).unwrap();
        assert!(db
            .commit(&context, &"wrong-project", |e| {
                e.conn()
                    .execute_batch("CREATE TABLE wrong_project(value INTEGER)")?;
                Ok(())
            })
            .is_err());
        assert_eq!(db.committed_revision().unwrap(), 0);
    }

    #[test]
    fn project_transaction_rolls_back_data_and_revision_on_failure() {
        let dir = tempfile::tempdir().unwrap();
        let db = ProjectDatabase::create(&dir.path().join("atomic.spprj"), false).unwrap();
        let result = db.commit::<(), _>(
            &context(&db, "failed", 0),
            &json!({"kind":"create"}),
            |engine| {
                engine
                    .conn()
                    .execute_batch("CREATE TABLE failed AS SELECT 42 AS value")?;
                Err(AppError::InvalidParam("injected".into()))
            },
        );
        assert!(result.is_err());
        assert_eq!(db.committed_revision().unwrap(), 0);
        assert!(db
            .with_reader(db.epoch(), |engine| Ok(engine.conn().query_row(
                "SELECT value FROM failed",
                [],
                |r| r.get::<_, i32>(0)
            )?))
            .is_err());
    }

    #[test]
    fn project_transaction_replays_receipt_after_reopen_without_double_apply() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("retry.spprj");
        let db = ProjectDatabase::create(&path, false).unwrap();
        let mut request = context(&db, "once", 0);
        let payload = json!({"kind":"create","value":42});
        let first = db
            .commit(&request, &payload, |engine| {
                engine
                    .conn()
                    .execute_batch("CREATE TABLE once AS SELECT 42 AS value")?;
                Ok(42_i32)
            })
            .unwrap();
        assert_eq!(first.committed_revision, 1);
        assert_eq!(first.value, 42);
        db.shutdown().unwrap();
        let reopened = ProjectDatabase::open(&path, false).unwrap();
        request.expected_epoch = reopened.epoch();
        let replay = reopened
            .commit::<i32, _>(&request, &payload, |_| panic!("must not apply replay"))
            .unwrap();
        assert_eq!(replay.value, 42);
        assert_eq!(replay.committed_revision, 1);
        assert_eq!(replay.epoch, reopened.epoch());
        assert!(reopened
            .commit::<i32, _>(&request, &json!({"kind":"different"}), |_| Ok(99))
            .is_err());
        assert_eq!(reopened.committed_revision().unwrap(), 1);
    }

    #[test]
    fn project_transaction_validates_epoch_revision_and_generation() {
        let dir = tempfile::tempdir().unwrap();
        let db = ProjectDatabase::create(&dir.path().join("stale.spprj"), false).unwrap();
        let mut request = context(&db, "stale", 1);
        assert!(db.commit(&request, &json!({}), |_| Ok(())).is_err());
        request.expected_revision = 0;
        request.expected_epoch += 1;
        assert!(db.commit(&request, &json!({}), |_| Ok(())).is_err());
        request.expected_epoch = db.epoch();
        request.dataset_generations.push(DatasetGeneration {
            id: "unknown".into(),
            generation: 0,
        });
        assert!(db.commit(&request, &json!({}), |_| Ok(())).is_err());
        assert_eq!(db.committed_revision().unwrap(), 0);
    }

    #[test]
    fn project_transaction_before_commit_failure_and_lost_ack_are_distinct() {
        let dir = tempfile::tempdir().unwrap();
        let db = ProjectDatabase::create(&dir.path().join("failpoint.spprj"), false).unwrap();
        let request = context(&db, "lost", 0);
        COMMIT_FAILURE.with(|f| f.set(1));
        assert!(db.commit(&request, &json!({}), |_| Ok(9)).is_err());
        assert_eq!(db.committed_revision().unwrap(), 0);
        COMMIT_FAILURE.with(|f| f.set(2));
        assert!(db.commit(&request, &json!({}), |_| Ok(9)).is_err());
        assert_eq!(db.committed_revision().unwrap(), 1);
        let replay = db
            .commit::<i32, _>(&request, &json!({}), |_| panic!("already committed"))
            .unwrap();
        assert_eq!(replay.value, 9);
    }

    #[test]
    fn project_transaction_rejects_read_only_and_canonicalizes_objects() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("readonly.spprj");
        let db = ProjectDatabase::create(&path, false).unwrap();
        let request = context(&db, "key-order", 0);
        db.commit(&request, &json!({"b":2,"a":1}), |_| Ok(7_i32))
            .unwrap();
        assert_eq!(
            db.commit::<i32, _>(&request, &json!({"a":1,"b":2}), |_| panic!("same request"))
                .unwrap()
                .value,
            7
        );
        db.shutdown().unwrap();
        let read_only = ProjectDatabase::open(&path, true).unwrap();
        assert!(read_only
            .commit(&context(&read_only, "blocked", 1), &json!({}), |_| Ok(()))
            .is_err());
    }
}
