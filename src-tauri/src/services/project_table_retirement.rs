//! Event-owned catalog before-images for native table lifecycle replay.

use super::{
    project_catalog::ProjectCatalog,
    project_table_lifecycle::{self, LifecycleEvent},
};
use crate::{engine::duckdb_engine::DuckDbEngine, error::AppError, models::project_persistence::*};
use duckdb::{params, OptionalExt};
use std::collections::BTreeSet;

pub(crate) struct MetadataEffects {
    pub document_ids: Vec<String>,
    pub setting_ids: Vec<String>,
}

fn invalid(code: &str) -> AppError {
    AppError::InvalidParam(code.into())
}

fn validate_event(engine: &DuckDbEngine, event: &LifecycleEvent) -> Result<(), AppError> {
    if uuid::Uuid::parse_str(&event.id).is_err()
        || event.dataset_id.trim().is_empty()
        || event.revision == 0
        || event.project_revision == 0
        || !matches!(event.operation.as_str(), "create_table" | "delete_table")
    {
        return Err(invalid("project_lifecycle_event_invalid"));
    }
    let current = project_table_lifecycle::get_event(engine, &event.id)?
        .ok_or_else(|| invalid("project_lifecycle_event_missing"))?;
    if current.dataset_id != event.dataset_id
        || current.revision != event.revision
        || current.applied != event.applied
        || current.operation != event.operation
    {
        return Err(invalid("project_lifecycle_event_stale"));
    }
    Ok(())
}

fn create_storage(engine: &DuckDbEngine) -> Result<(), AppError> {
    engine.conn().execute_batch("CREATE TABLE IF NOT EXISTS _project_retired_directory(event_id VARCHAR NOT NULL,id VARCHAR NOT NULL,kind VARCHAR NOT NULL,name VARCHAR NOT NULL,folder VARCHAR NOT NULL,revision UBIGINT NOT NULL,dependencies_json VARCHAR NOT NULL,PRIMARY KEY(event_id,id));
        CREATE TABLE IF NOT EXISTS _project_retired_documents(event_id VARCHAR NOT NULL,id VARCHAR NOT NULL,revision UBIGINT NOT NULL,schema_version UINTEGER NOT NULL,body_json VARCHAR NOT NULL,PRIMARY KEY(event_id,id));
        CREATE TABLE IF NOT EXISTS _project_retired_settings(event_id VARCHAR NOT NULL,key VARCHAR NOT NULL,tombstone_revision UBIGINT NOT NULL,value_json VARCHAR NOT NULL,PRIMARY KEY(event_id,key));
        CREATE TABLE IF NOT EXISTS _project_document_revision_watermarks(id VARCHAR PRIMARY KEY,revision UBIGINT NOT NULL)")?;
    Ok(())
}

/// Explicit data-snapshot restore invalidates table lifecycle before-images.
pub(crate) fn discard_metadata_for_snapshot(engine: &DuckDbEngine) -> Result<(), AppError> {
    for table in [
        "_project_retired_directory",
        "_project_retired_documents",
        "_project_retired_settings",
    ] {
        let exists: bool = engine.conn().query_row(
            "SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name=?)",
            [table],
            |row| row.get(0),
        )?;
        if exists {
            engine.conn().execute(&format!("DELETE FROM {table}"), [])?;
        }
    }
    Ok(())
}

fn clear_metadata(engine: &DuckDbEngine, event_id: &str) -> Result<(), AppError> {
    for table in [
        "_project_retired_directory",
        "_project_retired_documents",
        "_project_retired_settings",
    ] {
        engine
            .conn()
            .execute(&format!("DELETE FROM {table} WHERE event_id=?"), [event_id])?;
    }
    Ok(())
}

/// Dispose only before-images owned by a discarded redo event.
pub(crate) fn discard_event_metadata(engine:&DuckDbEngine,id:&str)->Result<(),AppError> {
    for table in ["_project_retired_directory","_project_retired_documents","_project_retired_settings"] {
        let exists:bool=engine.conn().query_row("SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name=?)",[table],|row|row.get(0))?;
        if exists {engine.conn().execute(&format!("DELETE FROM {table} WHERE event_id=?"),[id])?;}
    }
    Ok(())
}

/// Caller already retired storage and owns the encompassing project transaction.
/// Bodies move only between native metadata tables, without parsing or IPC hydration.
pub(crate) fn retire_metadata(
    engine: &DuckDbEngine,
    event: &LifecycleEvent,
) -> Result<MetadataEffects, AppError> {
    validate_event(engine, event)?;
    let catalog = ProjectCatalog::new(engine);
    if catalog.summary(&event.dataset_id)?.kind != ProjectDocumentKind::Table {
        return Err(invalid("project_table_directory_required"));
    }
    let retired:bool=engine.conn().query_row("SELECT EXISTS(SELECT 1 FROM _project_retired_datasets WHERE id=?) AND NOT EXISTS(SELECT 1 FROM _meta_datasets WHERE id=?)",params![&event.dataset_id,&event.dataset_id],|row|row.get(0))?;
    if !retired {
        return Err(invalid("project_retired_table_required"));
    }
    create_storage(engine)?;
    clear_metadata(engine, &event.id)?;
    engine.conn().execute("INSERT INTO _project_retired_directory SELECT ?,d.* FROM _project_directory d WHERE (d.id=? AND d.kind='table') OR (d.kind IN ('graph','graphNew') AND json_contains(d.dependencies_json,to_json(CAST(? AS VARCHAR))))",params![&event.id,&event.dataset_id,&event.dataset_id])?;
    engine.conn().execute("INSERT INTO _project_retired_documents SELECT ?,b.* FROM _project_documents b JOIN _project_retired_directory d ON d.id=b.id AND d.event_id=?",params![&event.id,&event.id])?;
    engine.conn().execute("INSERT INTO _project_document_revision_watermarks SELECT id,revision FROM _project_retired_directory WHERE event_id=? ON CONFLICT(id) DO UPDATE SET revision=GREATEST(_project_document_revision_watermarks.revision,excluded.revision)",[&event.id])?;
    let mut setting_ids = Vec::new();
    for key in [
        format!("filter:{}", event.dataset_id),
        format!("display:{}", event.dataset_id),
    ] {
        let prior: Option<(u64, String)> = engine
            .conn()
            .query_row(
                "SELECT revision,value_json FROM _project_settings WHERE key=?",
                [&key],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let retired_revision = prior
            .as_ref()
            .map(|item| item.0)
            .unwrap_or(0)
            .checked_add(1)
            .ok_or_else(|| invalid("project_revision_exhausted"))?;
        engine.conn().execute(
            "INSERT INTO _project_retired_settings VALUES(?,?,?,?)",
            params![
                &event.id,
                &key,
                retired_revision,
                prior.as_ref().map(|item| item.1.as_str()).unwrap_or("null")
            ],
        )?;
        catalog.apply_patch(&ProjectRecordPatch {
            settings: vec![ProjectSettingWrite {
                key: key.clone(),
                expected_revision: prior.map(|item| item.0),
                value: serde_json::Value::Null,
            }],
            ..Default::default()
        })?;
        setting_ids.push(key);
    }
    let document_ids = engine
        .conn()
        .prepare("SELECT id FROM _project_retired_directory WHERE event_id=? ORDER BY id")?
        .query_map([&event.id], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    engine.conn().execute("DELETE FROM _project_documents WHERE id IN (SELECT id FROM _project_retired_directory WHERE event_id=?)",[&event.id])?;
    engine.conn().execute("DELETE FROM _project_directory WHERE id IN (SELECT id FROM _project_retired_directory WHERE event_id=?)",[&event.id])?;
    Ok(MetadataEffects {
        document_ids,
        setting_ids,
    })
}

/// Caller restored row storage first. Conflicts abort the same transaction, so
/// the hidden table and its owned metadata remain recoverable on failure.
pub(crate) fn restore_metadata(
    engine: &DuckDbEngine,
    event: &LifecycleEvent,
) -> Result<MetadataEffects, AppError> {
    validate_event(engine, event)?;
    engine.get_dataset_meta(&event.dataset_id)?;
    let owned:bool=engine.conn().query_row("SELECT EXISTS(SELECT 1 FROM _project_retired_directory WHERE event_id=? AND id=? AND kind='table')",params![&event.id,&event.dataset_id],|row|row.get(0))?;
    if !owned {
        return Err(invalid("project_retired_metadata_missing"));
    }
    let conflict:bool=engine.conn().query_row("SELECT EXISTS(SELECT 1 FROM _project_retired_directory s JOIN _project_directory d ON d.id=s.id OR (d.kind=s.kind AND LOWER(d.name)=LOWER(s.name) AND d.folder=s.folder) WHERE s.event_id=?) OR EXISTS(SELECT 1 FROM _project_retired_directory s JOIN _project_documents d ON d.id=s.id WHERE s.event_id=?)",params![&event.id,&event.id],|row|row.get(0))?;
    if conflict {
        return Err(invalid("project_retired_directory_conflict"));
    }
    let setting_conflict:bool=engine.conn().query_row("SELECT EXISTS(SELECT 1 FROM _project_retired_settings s LEFT JOIN _project_settings current ON current.key=s.key WHERE s.event_id=? AND (current.revision IS DISTINCT FROM s.tombstone_revision OR current.value_json IS DISTINCT FROM 'null'))",[&event.id],|row|row.get(0))?;
    if setting_conflict {
        return Err(invalid("project_setting_revision_stale"));
    }
    let entries=engine.conn().prepare("SELECT id,kind,name,folder,revision,dependencies_json FROM _project_retired_directory WHERE event_id=? ORDER BY id")?.query_map([&event.id],|row|Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?,row.get::<_,String>(3)?,row.get::<_,u64>(4)?,row.get::<_,String>(5)?)))?.collect::<Result<Vec<_>,_>>()?;
    let catalog = ProjectCatalog::new(engine);
    let folders = entries
        .iter()
        .filter(|entry| !entry.3.is_empty())
        .map(|entry| entry.3.clone())
        .collect::<BTreeSet<_>>();
    catalog.apply_patch(&ProjectRecordPatch {
        created_folders: folders.iter().cloned().collect(),
        ..Default::default()
    })?;
    let mut document_ids = BTreeSet::new();
    for folder in folders {
        let mut path = String::new();
        for part in folder.split('/') {
            if !path.is_empty() {
                path.push('/');
            }
            path.push_str(part);
            document_ids.insert(format!("folder:{path}"));
        }
    }
    for (id, kind, name, folder, saved_revision, dependencies) in entries {
        let retained: u64 = engine
            .conn()
            .query_row(
                "SELECT revision FROM _project_document_revision_watermarks WHERE id=?",
                [&id],
                |row| row.get(0),
            )
            .optional()?
            .unwrap_or(0);
        let table_revision: u64 = if kind == "table" {
            engine.conn().query_row("SELECT directory_revision FROM _project_dataset_generation_watermarks WHERE dataset_id=?",[&id],|row|row.get(0)).optional()?.unwrap_or(0)
        } else {
            0
        };
        let revision = saved_revision
            .max(retained)
            .max(table_revision)
            .checked_add(1)
            .ok_or_else(|| invalid("project_revision_exhausted"))?;
        engine.conn().execute(
            "INSERT INTO _project_directory VALUES(?,?,?,?,?,?)",
            params![&id, &kind, &name, &folder, revision, &dependencies],
        )?;
        engine.conn().execute("INSERT INTO _project_documents SELECT id,?,schema_version,body_json FROM _project_retired_documents WHERE event_id=? AND id=?",params![revision,&event.id,&id])?;
        engine.conn().execute("INSERT INTO _project_document_revision_watermarks VALUES(?,?) ON CONFLICT(id) DO UPDATE SET revision=GREATEST(_project_document_revision_watermarks.revision,excluded.revision)",params![&id,revision])?;
        document_ids.insert(id);
    }
    let settings=engine.conn().prepare("SELECT key,tombstone_revision FROM _project_retired_settings WHERE event_id=? ORDER BY key")?.query_map([&event.id],|row|Ok((row.get::<_,String>(0)?,row.get::<_,u64>(1)?)))?.collect::<Result<Vec<_>,_>>()?;
    let mut setting_ids = Vec::new();
    for (key, tombstone) in settings {
        let revision = tombstone
            .checked_add(1)
            .ok_or_else(|| invalid("project_revision_exhausted"))?;
        engine.conn().execute("UPDATE _project_settings SET revision=?,value_json=(SELECT value_json FROM _project_retired_settings WHERE event_id=? AND key=?) WHERE key=? AND revision=?",params![revision,&event.id,&key,&key,tombstone])?;
        setting_ids.push(key);
    }
    clear_metadata(engine, &event.id)?;
    Ok(MetadataEffects {
        document_ids: document_ids.into_iter().collect(),
        setting_ids,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        models::{project_persistence::*, table::*},
        services::{
            project_catalog::ProjectCatalog, project_database::ProjectDatabase,
            project_table_lifecycle as lifecycle, project_transaction::CommitEffects,
        },
    };
    fn context(db: &ProjectDatabase, id: &str) -> ProjectWriteContext {
        ProjectWriteContext {
            operation_id: id.into(),
            expected_project_id: db.header().unwrap().project_id,
            expected_epoch: db.epoch(),
            expected_revision: db.committed_revision().unwrap(),
            request_digest: String::new(),
            document_revisions: vec![],
            dataset_generations: vec![],
        }
    }
    fn fixture(db: &ProjectDatabase) -> String {
        let raw = "unparsed-graph-body".repeat(100_000);
        db.commit_with_effects(&context(db,"seed"),&"seed",|engine| {
            let meta=engine.create_table_from_rows_in_transaction("retained",&CreateTableFromRowsRequest {name:"Retained".into(),column_names:vec!["value".into()],column_types:vec!["BIGINT".into()],rows:vec![vec![serde_json::json!(9007199254740993i64)]]})?;
            ProjectCatalog::new(engine).publish_table(&meta,"Data/Sub")?;
            lifecycle::record_creation(engine,"retained")?;
            engine.conn().execute_batch(r#"INSERT INTO _project_directory VALUES ('graph','graph','Graph','Data/Sub',4,'["retained"]'),('unrelated','graph','Other','',1,'[]'); INSERT INTO _project_documents VALUES ('unrelated',1,1,'unparsed-other'); INSERT INTO _project_settings VALUES ('filter:retained',1,'[]'),('display:retained',3,'[{"colIndex":0,"width":177}]')"#)?;
            engine.conn().execute("INSERT INTO _project_documents VALUES ('graph',4,1,?)",[&raw])?;
            ProjectCatalog::new(engine).validate_metadata()?;
            Ok(CommitEffects {value:(),dataset_ids:vec!["retained".into()],document_ids:vec![],setting_ids:vec![]})
        }).unwrap();
        raw
    }
    fn retire(db: &ProjectDatabase) -> lifecycle::LifecycleEvent {
        db.commit_with_effects(&context(db, "retire"), &"retire", |engine| {
            lifecycle::retire_storage(engine, "retained")?;
            let event = lifecycle::record_deletion(engine, "retained")?;
            let effects = retire_metadata(engine, &event)?;
            ProjectCatalog::new(engine).validate_metadata()?;
            Ok(CommitEffects {
                value: event,
                dataset_ids: vec![],
                document_ids: effects.document_ids,
                setting_ids: effects.setting_ids,
            })
        })
        .unwrap()
        .value
    }
    #[test]
    fn project_v5_table_retirement_absent_settings_gain_tombstones_and_reject_hidden_writes() {
        let root = tempfile::tempdir().unwrap();
        let db =
            ProjectDatabase::create(&root.path().join("absent-settings.spprj"), false).unwrap();
        fixture(&db);
        db.with_engine(|engine| {
            engine.conn().execute_batch(
                "DELETE FROM _project_settings WHERE key IN ('filter:retained','display:retained')",
            )?;
            Ok(())
        })
        .unwrap();
        retire(&db);
        for key in ["filter:retained", "display:retained"] {
            let setting = db
                .with_reader(db.epoch(), |engine| {
                    ProjectCatalog::new(engine).get_setting(key)
                })
                .unwrap()
                .unwrap();
            assert_eq!(setting, (1, serde_json::Value::Null));
            let stale = db
                .commit_records(
                    &context(&db, &format!("stale-{key}")),
                    &ProjectRecordPatch {
                        settings: vec![ProjectSettingWrite {
                            key: key.into(),
                            expected_revision: None,
                            value: serde_json::json!([]),
                        }],
                        ..Default::default()
                    },
                )
                .unwrap_err();
            assert!(stale.to_string().contains("setting_revision_stale"));
            let before = db.committed_revision().unwrap();
            let result = db.commit_records(
                &context(&db, &format!("hidden-{key}")),
                &ProjectRecordPatch {
                    settings: vec![ProjectSettingWrite {
                        key: key.into(),
                        expected_revision: Some(1),
                        value: serde_json::json!([]),
                    }],
                    ..Default::default()
                },
            );
            assert!(
                result.is_err(),
                "non-null settings must not be accepted for hidden tables"
            );
            assert!(result
                .unwrap_err()
                .to_string()
                .contains("setting_dataset_missing"));
            assert_eq!(db.committed_revision().unwrap(), before);
        }
    }

    #[test]
    fn project_v5_table_retirement_id_conflict_keeps_current_graph_and_hidden_rows() {
        let root = tempfile::tempdir().unwrap();
        let db = ProjectDatabase::create(&root.path().join("id-conflict.spprj"), false).unwrap();
        fixture(&db);
        let event = retire(&db);
        db.commit_with_effects(&context(&db,"replacement"),&"replacement",|engine| {
            engine.conn().execute_batch("INSERT INTO _project_directory VALUES ('graph','graph','Replacement','',99,'[]'); INSERT INTO _project_documents VALUES ('graph',99,1,'replacement-body')")?;
            Ok(CommitEffects {value:(),dataset_ids:vec![],document_ids:vec!["graph".into()],setting_ids:vec![]})
        }).unwrap();
        let before = db.committed_revision().unwrap();
        let error = db
            .commit_with_effects(&context(&db, "restore"), &"restore", |engine| {
                lifecycle::restore_storage(engine, "retained")?;
                let effects = restore_metadata(engine, &event)?;
                Ok(CommitEffects {
                    value: (),
                    dataset_ids: vec!["retained".into()],
                    document_ids: effects.document_ids,
                    setting_ids: effects.setting_ids,
                })
            })
            .unwrap_err();
        assert!(error.to_string().contains("directory_conflict"));
        assert_eq!(db.committed_revision().unwrap(), before);
        db.with_reader(db.epoch(), |engine| {
            assert!(engine.get_dataset_meta("retained").is_err());
            assert_eq!(
                ProjectCatalog::new(engine).summary("graph")?.name,
                "Replacement"
            );
            let body: String = engine.conn().query_row(
                "SELECT body_json FROM _project_documents WHERE id='graph'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(body, "replacement-body");
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn project_v5_table_retirement_restore_advances_past_deleted_replacement_revision() {
        let root=tempfile::tempdir().unwrap();let db=ProjectDatabase::create(&root.path().join("deleted-replacement.spprj"),false).unwrap();
        let original=fixture(&db);let event=retire(&db);
        db.commit_with_effects(&context(&db,"replacement"),&"replacement",|engine| {
            engine.conn().execute_batch("INSERT INTO _project_directory VALUES ('graph','graph','Replacement','',99,'[]'); INSERT INTO _project_documents VALUES ('graph',99,1,'replacement-body')")?;
            Ok(CommitEffects{value:(),dataset_ids:vec![],document_ids:vec!["graph".into()],setting_ids:vec![]})
        }).unwrap();
        db.commit_records(&context(&db,"delete-replacement"),&ProjectRecordPatch{deleted_document_ids:vec!["graph".into()],..Default::default()}).unwrap();
        db.commit_with_effects(&context(&db,"restore-original"),&"restore-original",|engine| {
            lifecycle::restore_storage(engine,"retained")?;let effects=restore_metadata(engine,&event)?;
            Ok(CommitEffects{value:(),dataset_ids:vec!["retained".into()],document_ids:effects.document_ids,setting_ids:effects.setting_ids})
        }).unwrap();
        db.with_reader(db.epoch(),|engine| {
            let catalog=ProjectCatalog::new(engine);assert_eq!(catalog.summary("graph")?.revision,100,"restored document must not reuse a revision preceding a deleted replacement");
            let body:String=engine.conn().query_row("SELECT body_json FROM _project_documents WHERE id='graph' AND revision=100",[],|row|row.get(0))?;assert_eq!(body,original);Ok(())
        }).unwrap();
    }

    #[test]
    fn project_v5_table_retirement_metadata_restores_raw_graphs_settings_and_folders() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("metadata.spprj");
        let db = ProjectDatabase::create(&path, false).unwrap();
        let raw = fixture(&db);
        let event = retire(&db);
        db.with_reader(db.epoch(), |engine| {
            let catalog = ProjectCatalog::new(engine);
            assert!(catalog.summary("retained").is_err());
            assert!(catalog.summary("graph").is_err());
            assert_eq!(catalog.summary("unrelated")?.name, "Other");
            let filter = catalog.get_setting("filter:retained")?.unwrap();
            assert_eq!(filter.0, 2);
            assert!(filter.1.is_null());
            let display = catalog.get_setting("display:retained")?.unwrap();
            assert_eq!(display.0, 4);
            assert!(display.1.is_null());
            Ok(())
        })
        .unwrap();
        db.commit_records(
            &context(&db, "remove-empty-folders"),
            &ProjectRecordPatch {
                deleted_folders: vec!["Data/Sub".into(), "Data".into()],
                ..Default::default()
            },
        )
        .unwrap();
        db.shutdown().unwrap();
        drop(db);
        let db = ProjectDatabase::open(&path, false).unwrap();
        let restored = db
            .commit_with_effects(&context(&db, "restore"), &"restore", |engine| {
                let event = lifecycle::authorize_replay(engine, &event.id, 1, true)?;
                lifecycle::restore_storage(engine, "retained")?;
                let effects = restore_metadata(engine, &event)?;
                lifecycle::mark_replayed(engine, &event, true)?;
                ProjectCatalog::new(engine).validate_metadata()?;
                Ok(CommitEffects {
                    value: (),
                    dataset_ids: vec!["retained".into()],
                    document_ids: effects.document_ids,
                    setting_ids: effects.setting_ids,
                })
            })
            .unwrap();
        assert!(restored
            .changed_directory_entries
            .iter()
            .any(|entry| entry.id == "folder:Data"));
        db.with_reader(db.epoch(), |engine| {
            let catalog = ProjectCatalog::new(engine);
            assert_eq!(catalog.summary("retained")?.folder, "Data/Sub");
            assert_eq!(catalog.summary("retained")?.revision, 2);
            assert_eq!(catalog.summary("graph")?.revision, 5);
            let saved: (u64, String) = engine.conn().query_row(
                "SELECT revision,body_json FROM _project_documents WHERE id='graph'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            assert_eq!(saved.0, 5);
            assert!(saved.1 == raw, "raw graph body changed");
            assert_eq!(
                catalog.get_setting("filter:retained")?.unwrap(),
                (3, serde_json::json!([]))
            );
            assert_eq!(
                catalog.get_setting("display:retained")?.unwrap(),
                (5, serde_json::json!([{"colIndex":0,"width":177}]))
            );
            let value: i64 =
                engine
                    .conn()
                    .query_row("SELECT value FROM dataset_retained", [], |row| row.get(0))?;
            assert_eq!(value, 9007199254740993);
            Ok(())
        })
        .unwrap();
    }
    #[test]
    fn project_v5_table_retirement_changed_setting_rejects_restore_without_partial_reattach() {
        let root = tempfile::tempdir().unwrap();
        let db = ProjectDatabase::create(&root.path().join("conflict.spprj"), false).unwrap();
        fixture(&db);
        let event = retire(&db);
        db.commit_with_effects(&context(&db,"conflicting-setting"),&"conflicting-setting",|engine| {engine.conn().execute_batch("UPDATE _project_settings SET revision=3,value_json='[]' WHERE key='filter:retained'")?;Ok(CommitEffects {value:(),dataset_ids:vec![],document_ids:vec![],setting_ids:vec![]})}).unwrap();
        let before = db.committed_revision().unwrap();
        let error = db
            .commit_with_effects(&context(&db, "restore"), &"restore", |engine| {
                lifecycle::restore_storage(engine, "retained")?;
                let effects = restore_metadata(engine, &event)?;
                Ok(CommitEffects {
                    value: (),
                    dataset_ids: vec!["retained".into()],
                    document_ids: effects.document_ids,
                    setting_ids: effects.setting_ids,
                })
            })
            .unwrap_err();
        assert!(
            error.to_string().contains("setting_revision_stale"),
            "{error}"
        );
        assert_eq!(db.committed_revision().unwrap(), before);
        db.with_reader(db.epoch(), |engine| {
            assert!(engine.get_dataset_meta("retained").is_err());
            assert!(ProjectCatalog::new(engine).summary("graph").is_err());
            assert!(ProjectCatalog::new(engine)
                .get_setting("filter:retained")?
                .unwrap()
                .1
                .is_array());
            Ok(())
        })
        .unwrap();
    }
}
