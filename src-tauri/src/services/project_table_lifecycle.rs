//! Table lifecycle storage retains original managed rows while a table is hidden.

use crate::{engine::duckdb_engine::DuckDbEngine, error::AppError, models::table::DatasetMeta};

pub(crate) fn is_retired(engine:&DuckDbEngine,id:&str)->Result<bool,AppError> {
    let exists:bool=engine.conn().query_row("SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name='_project_retired_datasets')",[],|row|row.get(0))?;
    if !exists {return Ok(false);}
    Ok(engine.conn().query_row("SELECT EXISTS(SELECT 1 FROM _project_retired_datasets WHERE id=?)",[id],|row|row.get(0))?)
}

/// Caller owns the transaction. Auxiliary metadata and all row storage remain
/// project-owned; only the active dataset row moves into retirement storage.
pub(crate) fn retire_storage(engine: &DuckDbEngine, id: &str) -> Result<DatasetMeta, AppError> {
    let meta = engine.get_dataset_meta(id)?;
    engine.conn().execute_batch("CREATE TABLE IF NOT EXISTS _project_retired_datasets AS SELECT * FROM _meta_datasets WHERE FALSE; CREATE UNIQUE INDEX IF NOT EXISTS _project_retired_dataset_id ON _project_retired_datasets(id)")?;
    let retained: bool = engine.conn().query_row(
        "SELECT EXISTS(SELECT 1 FROM _project_retired_datasets WHERE id=?)",
        [id],
        |row| row.get(0),
    )?;
    if retained {
        return Err(AppError::InvalidParam(
            "project_table_already_retired".into(),
        ));
    }
    super::project_data_snapshot::retain_dataset_generation(engine, id, meta.generation)?;
    engine.conn().execute(
        "INSERT INTO _project_retired_datasets SELECT * FROM _meta_datasets WHERE id=?",
        [id],
    )?;
    engine
        .conn()
        .execute("DELETE FROM _meta_datasets WHERE id=?", [id])?;
    Ok(meta)
}

/// Restore the original row storage with a fresh generation, preserving column
/// identities, row allocator, natural-order anchors and incremental edit history.
pub(crate) fn restore_storage(engine: &DuckDbEngine, id: &str) -> Result<DatasetMeta, AppError> {
    let exists:bool=engine.conn().query_row("SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name='_project_retired_datasets')",[],|row|row.get(0))?;
    if !exists {
        return Err(AppError::InvalidParam(
            "project_retired_table_missing".into(),
        ));
    }
    let name: Option<String> = engine
        .conn()
        .query_row(
            "SELECT name FROM _project_retired_datasets WHERE id=?",
            [id],
            |row| row.get(0),
        )
        .optional()?;
    let name =
        name.ok_or_else(|| AppError::InvalidParam("project_retired_table_missing".into()))?;
    engine.validate_dataset_name(&name, None)?;
    let physical = DuckDbEngine::internal_table_name(id);
    let has_rows: bool = engine.conn().query_row(
        "SELECT EXISTS(SELECT 1 FROM duckdb_tables() WHERE table_name=?)",
        [&physical],
        |row| row.get(0),
    )?;
    if !has_rows {
        return Err(AppError::Database("project_retired_storage_missing".into()));
    }
    engine.conn().execute(
        "INSERT INTO _meta_datasets SELECT * FROM _project_retired_datasets WHERE id=?",
        [id],
    )?;
    let source = engine.get_dataset_generation(id)?;
    let (retained,next):(u64,Option<i64>)=engine.conn().query_row("SELECT generation,next_row_id FROM _project_dataset_generation_watermarks WHERE dataset_id=?",[id],|row|Ok((row.get(0)?,row.get(1)?)))?;
    let generation = source
        .max(retained)
        .checked_add(1)
        .ok_or_else(|| AppError::InvalidParam("project_generation_exhausted".into()))?;
    engine.copy_natural_anchors_between_generations(id, source, generation)?;
    engine.conn().execute("UPDATE _meta_datasets SET generation=?,next_row_id=GREATEST(COALESCE(next_row_id,1),COALESCE(?,1)),updated_at=CAST(current_timestamp AS VARCHAR) WHERE id=?",duckdb::params![generation,next,id])?;
    engine.refresh_delta_history_generations_for_dataset(id)?;
    let meta = engine.get_dataset_meta(id)?;
    engine.conn().execute(
        "UPDATE _history_timeline SET current_generation=? WHERE dataset_id=?",
        duckdb::params![meta.generation, id],
    )?;
    engine
        .conn()
        .execute("DELETE FROM _project_retired_datasets WHERE id=?", [id])?;
    Ok(meta)
}
use duckdb::OptionalExt;

pub(crate) use crate::models::project_persistence::ProjectTableLifecycleEvent as LifecycleEvent;

fn has_events(engine: &DuckDbEngine) -> Result<bool, AppError> {
    Ok(engine.conn().query_row("SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name='_project_table_lifecycle_events')",[],|row|row.get(0))?)
}

pub(crate) fn get_event(
    engine: &DuckDbEngine,
    id: &str,
) -> Result<Option<LifecycleEvent>, AppError> {
    if !has_events(engine)? {
        return Ok(None);
    }
    let mut event=engine.conn().query_row("SELECT id,dataset_id,operation,applied,revision,history_ordinal,project_revision FROM _project_table_lifecycle_events WHERE id=?",[id],|row|Ok(LifecycleEvent {id:row.get(0)?,dataset_id:row.get(1)?,operation:row.get(2)?,applied:row.get(3)?,revision:row.get(4)?,history_ordinal:row.get(5)?,project_revision:row.get(6)?,dataset_generation:None})).optional()?;
    if let Some(event) = &mut event {
        let header = super::project_schema::read_header(engine.conn(), false)?;
        let next: Option<u64> = engine
            .conn()
            .query_row(
                "SELECT next_history_ordinal FROM _history_dataset_state WHERE dataset_id=?",
                [&event.dataset_id],
                |row| row.get(0),
            )
            .optional()?;
        if uuid::Uuid::parse_str(&event.id).is_err()
            || event.dataset_id.trim().is_empty()
            || event.dataset_id.len() > 256
            || !matches!(event.operation.as_str(), "create_table" | "delete_table")
            || event.revision == 0
            || event.project_revision == 0
            || event.project_revision > header.committed_revision.saturating_add(1)
            || event.history_ordinal >= next.unwrap_or(0)
        {
            return Err(AppError::InvalidParam(
                "project_lifecycle_event_invalid".into(),
            ));
        }
        event.dataset_generation = engine
            .conn()
            .query_row(
                "SELECT generation FROM _meta_datasets WHERE id=?",
                [&event.dataset_id],
                |row| row.get(0),
            )
            .optional()?;
    }
    Ok(event)
}

fn next_project_revision(engine: &DuckDbEngine) -> Result<u64, AppError> {
    super::project_schema::read_header(engine.conn(), true)?
        .committed_revision
        .checked_add(1)
        .ok_or_else(|| AppError::InvalidParam("project_revision_exhausted".into()))
}

/// Snapshot restore is an explicit bulk replacement and history reset. Retired
/// identity watermarks remain; only obsolete owned rows/history metadata go away.
pub(crate) fn discard_for_snapshot(engine: &DuckDbEngine) -> Result<Vec<String>, AppError> {
    let exists:bool=engine.conn().query_row("SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name='_project_retired_datasets')",[],|row|row.get(0))?;
    let ids = if exists {
        engine
            .conn()
            .prepare("SELECT id FROM _project_retired_datasets ORDER BY id")?
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?
    } else {
        vec![]
    };
    for id in &ids {
        engine.delete_dataset(id)?;
    }
    if exists {
        engine
            .conn()
            .execute_batch("DELETE FROM _project_retired_datasets")?;
    }
    if has_events(engine)? {
        engine
            .conn()
            .execute_batch("DELETE FROM _project_table_lifecycle_events")?;
    }
    super::project_table_retirement::discard_metadata_for_snapshot(engine)?;
    super::project_history_frontier::reset(engine)?;
    Ok(ids)
}

/// Receipt collection touches only events advanced by this commit, using its index.
pub(crate) fn committed_summaries(
    engine: &DuckDbEngine,
    revision: u64,
) -> Result<Vec<crate::models::project_persistence::ProjectHistorySummary>, AppError> {
    if !has_events(engine)? {
        return Ok(vec![]);
    }
    let events=engine.conn().prepare("SELECT id,dataset_id,operation,applied FROM _project_table_lifecycle_events WHERE project_revision=? ORDER BY id")?.query_map([revision],|row|Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?,row.get::<_,bool>(3)?)))?.collect::<Result<Vec<_>,_>>()?;
    if events.is_empty() {
        return Ok(vec![]);
    }
    let retired:bool=engine.conn().query_row("SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name='_project_retired_datasets')",[],|row|row.get(0))?;
    events
        .into_iter()
        .map(|(id, dataset_id, operation, applied)| {
            let mut metadata: Option<(u64, String)> = engine
                .conn()
                .query_row(
                    "SELECT generation,name FROM _meta_datasets WHERE id=?",
                    [&dataset_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            if metadata.is_none() && retired {
                metadata = engine
                    .conn()
                    .query_row(
                        "SELECT generation,name FROM _project_retired_datasets WHERE id=?",
                        [&dataset_id],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .optional()?;
            }
            Ok(crate::models::project_persistence::ProjectHistorySummary {
                id,
                dataset_id,
                operation,
                applied,
                generation: metadata.as_ref().map(|item| item.0).unwrap_or(0),
                dataset_name: metadata.map(|item| item.1),
                description:None,timestamp:None,
            })
        })
        .collect()
}

/// History pages contain summaries only; retired row storage is never read.
pub(crate) fn history_source(engine: &DuckDbEngine) -> Result<String, AppError> {
    if !has_events(engine)? {
        return Ok("SELECT NULL::VARCHAR AS id,NULL::VARCHAR AS dataset_id,NULL::VARCHAR AS operation,FALSE AS applied,0::UBIGINT AS generation,NULL::VARCHAR AS dataset_name WHERE FALSE".into());
    }
    let retired:bool=engine.conn().query_row("SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name='_project_retired_datasets')",[],|row|row.get(0))?;
    Ok(if retired {
        "SELECT l.id,l.dataset_id,l.operation,l.applied,COALESCE(m.generation,r.generation,0) AS generation,COALESCE(m.name,r.name) AS dataset_name FROM _project_table_lifecycle_events l LEFT JOIN _meta_datasets m ON m.id=l.dataset_id LEFT JOIN _project_retired_datasets r ON r.id=l.dataset_id"
    } else {
        "SELECT l.id,l.dataset_id,l.operation,l.applied,COALESCE(m.generation,0) AS generation,m.name AS dataset_name FROM _project_table_lifecycle_events l LEFT JOIN _meta_datasets m ON m.id=l.dataset_id"
    }.into())
}

/// A creation event may share the UUID of its existing output-publication marker.
pub(crate) fn output_history_source(engine: &DuckDbEngine) -> Result<String, AppError> {
    Ok(if has_events(engine)? {
        "SELECT e.* FROM _project_output_events e WHERE NOT EXISTS(SELECT 1 FROM _project_table_lifecycle_events l WHERE l.id=e.id AND l.operation='create_table')"
    } else {"SELECT * FROM _project_output_events"}.into())
}

/// Both ordinary edits and lifecycle mutations abandon the same redo branch.
/// The caller's transaction also owns disposal of compact history snapshots.
pub(crate) fn prune_redo(engine: &DuckDbEngine, _dataset: &str) -> Result<(), AppError> {
    if !engine.is_persistent_project() { return Ok(()); }
    let abandoned=engine.conn().prepare("SELECT change_set_id FROM _history_timeline WHERE applied=FALSE")?
        .query_map([],|row|row.get::<_,String>(0))?.collect::<Result<Vec<_>,_>>()?;
    for id in &abandoned {engine.drop_change_set_in_transaction(id)?;}
    super::project_history_frontier::forget(engine,&abandoned)?;
    if has_events(engine)? {
        let events=engine.conn().prepare("SELECT id,dataset_id,operation FROM _project_table_lifecycle_events WHERE applied=FALSE")?
            .query_map([],|row|Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?)))?.collect::<Result<Vec<_>,_>>()?;
        let has_retired:bool=engine.conn().query_row("SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name='_project_retired_datasets')",[],|row|row.get(0))?;
        for (id,dataset,operation) in &events {
            super::project_table_retirement::discard_event_metadata(engine,id)?;
            if operation=="create_table" && has_retired {
                let hidden:bool=engine.conn().query_row("SELECT EXISTS(SELECT 1 FROM _project_retired_datasets WHERE id=?) AND NOT EXISTS(SELECT 1 FROM _meta_datasets WHERE id=?)",duckdb::params![dataset,dataset],|row|row.get(0))?;
                if hidden {
                    engine.delete_dataset(dataset)?;
                    engine.conn().execute("DELETE FROM _project_retired_datasets WHERE id=?",[dataset])?;
                }
            }
            engine.conn().execute("DELETE FROM _project_output_events WHERE id=?",[id])?;
        }
        super::project_history_frontier::forget(engine,&events.iter().map(|event|event.0.clone()).collect::<Vec<_>>())?;
        engine.conn().execute_batch("DELETE FROM _project_table_lifecycle_events WHERE applied=FALSE")?;
    }
    Ok(())
}

fn record_event(
    engine: &DuckDbEngine,
    dataset: &str,
    operation: &str,
) -> Result<LifecycleEvent, AppError> {
    engine.conn().execute_batch("CREATE TABLE IF NOT EXISTS _project_table_lifecycle_events (id VARCHAR PRIMARY KEY,dataset_id VARCHAR NOT NULL,operation VARCHAR NOT NULL,applied BOOLEAN NOT NULL,revision UBIGINT NOT NULL,history_ordinal UBIGINT NOT NULL,project_revision UBIGINT NOT NULL,UNIQUE(dataset_id,history_ordinal)); CREATE INDEX IF NOT EXISTS _project_lifecycle_commits ON _project_table_lifecycle_events(project_revision)")?;
    prune_redo(engine, dataset)?;
    engine.conn().execute(
        "INSERT INTO _history_dataset_state VALUES (?,0) ON CONFLICT(dataset_id) DO NOTHING",
        [dataset],
    )?;
    let ordinal: u64 = engine.conn().query_row(
        "SELECT next_history_ordinal FROM _history_dataset_state WHERE dataset_id=?",
        [dataset],
        |row| row.get(0),
    )?;
    let next = ordinal
        .checked_add(1)
        .ok_or_else(|| AppError::InvalidParam("project_history_ordinal_exhausted".into()))?;
    engine.conn().execute(
        "UPDATE _history_dataset_state SET next_history_ordinal=? WHERE dataset_id=?",
        duckdb::params![next, dataset],
    )?;
    let dataset_generation = engine
        .conn()
        .query_row(
            "SELECT generation FROM _meta_datasets WHERE id=?",
            [dataset],
            |row| row.get(0),
        )
        .optional()?;
    let event = LifecycleEvent {
        dataset_generation,
        id: uuid::Uuid::new_v4().to_string(),
        dataset_id: dataset.into(),
        operation: operation.into(),
        applied: true,
        revision: 1,
        history_ordinal: ordinal,
        project_revision: next_project_revision(engine)?,
    };
    engine.conn().execute(
        "INSERT INTO _project_table_lifecycle_events VALUES (?,?,?,?,?,?,?)",
        duckdb::params![
            &event.id,
            &event.dataset_id,
            &event.operation,
            event.applied,
            event.revision,
            event.history_ordinal,
            event.project_revision
        ],
    )?;
    Ok(event)
}

pub(crate) fn record_creation(engine: &DuckDbEngine, id: &str) -> Result<LifecycleEvent, AppError> {
    engine.get_dataset_meta(id)?;
    if has_events(engine)? {
        let duplicate:bool=engine.conn().query_row("SELECT EXISTS(SELECT 1 FROM _project_table_lifecycle_events WHERE dataset_id=? AND operation='create_table')",[id],|row|row.get(0))?;
        if duplicate {
            return Err(AppError::InvalidParam(
                "project_table_creation_already_recorded".into(),
            ));
        }
    }
    record_event(engine, id, "create_table")
}

pub(crate) fn record_deletion(engine: &DuckDbEngine, id: &str) -> Result<LifecycleEvent, AppError> {
    let hidden:bool=engine.conn().query_row("SELECT EXISTS(SELECT 1 FROM _project_retired_datasets WHERE id=?) AND NOT EXISTS(SELECT 1 FROM _meta_datasets WHERE id=?)",duckdb::params![id,id],|row|row.get(0))?;
    if !hidden {
        return Err(AppError::InvalidParam(
            "project_retired_table_required".into(),
        ));
    }
    record_event(engine, id, "delete_table")
}

fn validate_frontier(
    engine: &DuckDbEngine,
    dataset: &str,
    expected: &str,
    undo: bool,
) -> Result<(), AppError> {
    let order = if undo { "DESC" } else { "ASC" };
    let rows=engine.conn().prepare(&format!("SELECT id,history_ordinal FROM (SELECT change_set_id AS id,history_ordinal,applied FROM _history_timeline WHERE dataset_id=? UNION ALL SELECT id,history_ordinal,applied FROM _project_table_lifecycle_events WHERE dataset_id=?) events WHERE applied=? ORDER BY history_ordinal {order} LIMIT 2"))?.query_map(duckdb::params![dataset,dataset,undo],|row|Ok((row.get::<_,String>(0)?,row.get::<_,u64>(1)?)))?.collect::<Result<Vec<_>,_>>()?;
    if rows.first().map(|row| row.0.as_str()) != Some(expected)
        || rows.get(1).is_some_and(|row| row.1 == rows[0].1)
    {
        return Err(AppError::InvalidParam(
            "project_history_cursor_stale".into(),
        ));
    }
    Ok(())
}

/// Ordinary history and lifecycle history share a single per-table cursor.
pub(crate) fn authorize_regular_replay(
    engine: &DuckDbEngine,
    dataset: &str,
    id: &str,
    undo: bool,
) -> Result<(), AppError> {
    if !engine.is_persistent_project() || !has_events(engine)? {
        return Ok(());
    }
    let children = super::project_history_group::children(engine, id)?;
    let expected = if let Some(children) = &children {
        (if undo {
            children.last()
        } else {
            children.first()
        })
        .ok_or_else(|| AppError::Database("project_history_group_empty".into()))?
        .as_str()
    } else {
        id
    };
    validate_frontier(engine, dataset, expected, undo)
}

/// Authorization is read-only and runs before the caller changes storage or catalog.
pub(crate) fn authorize_replay(
    engine: &DuckDbEngine,
    id: &str,
    revision: u64,
    undo: bool,
) -> Result<LifecycleEvent, AppError> {
    let event = get_event(engine, id)?
        .ok_or_else(|| AppError::InvalidParam("project_lifecycle_event_missing".into()))?;
    if event.revision != revision || event.applied != undo {
        return Err(AppError::InvalidParam(
            "project_lifecycle_event_stale".into(),
        ));
    }
    validate_frontier(engine, &event.dataset_id, id, undo)?;
    let active: bool = engine.conn().query_row(
        "SELECT EXISTS(SELECT 1 FROM _meta_datasets WHERE id=?)",
        [&event.dataset_id],
        |row| row.get(0),
    )?;
    if active != ((event.operation == "create_table") == event.applied) {
        return Err(AppError::InvalidParam(
            "project_lifecycle_storage_stale".into(),
        ));
    }
    Ok(event)
}

/// Caller already authorized the event, then changed storage/catalog in this transaction.
pub(crate) fn mark_replayed(
    engine: &DuckDbEngine,
    event: &LifecycleEvent,
    undo: bool,
) -> Result<(), AppError> {
    let revision = event
        .revision
        .checked_add(1)
        .ok_or_else(|| AppError::InvalidParam("project_lifecycle_revision_exhausted".into()))?;
    let changed=engine.conn().execute("UPDATE _project_table_lifecycle_events SET applied=?,revision=?,project_revision=? WHERE id=? AND revision=? AND applied=?",duckdb::params![!undo,revision,next_project_revision(engine)?,&event.id,event.revision,undo])?;
    if changed != 1 {
        return Err(AppError::InvalidParam(
            "project_lifecycle_event_stale".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        models::{project_persistence::*, table::*},
        services::{
            project_catalog::ProjectCatalog, project_database::ProjectDatabase,
            project_transaction::CommitEffects,
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
    #[test]
    fn project_v5_lifecycle_events_fence_ordinary_replay_across_create_and_delete() {
        let root = tempfile::tempdir().unwrap();
        let db = ProjectDatabase::create(&root.path().join("replay-order.spprj"), false).unwrap();
        let created = db
            .commit_with_effects(&context(&db, "create"), &"create", |engine| {
                engine.create_table_from_rows_in_transaction(
                    "retained",
                    &CreateTableFromRowsRequest {
                        name: "Retained".into(),
                        column_names: vec!["value".into()],
                        column_types: vec!["BIGINT".into()],
                        rows: vec![vec![serde_json::json!(1)]],
                    },
                )?;
                let event = record_creation(engine, "retained")?;
                Ok(CommitEffects {
                    value: event,
                    dataset_ids: vec!["retained".into()],
                    document_ids: vec![],
                    setting_ids: vec![],
                })
            })
            .unwrap();
        let edit = db
            .commit_with_effects(&context(&db, "edit"), &"edit", |engine| {
                let changed =
                    crate::services::project_cell_mutation::update_cells_compact_in_transaction(
                        engine,
                        "retained",
                        &[CellUpdate {
                            row_id: 1,
                            column_name: "value".into(),
                            value: Some("2".into()),
                        }],
                        0,
                    )?;
                Ok(CommitEffects {
                    value: changed.change_set_id.unwrap(),
                    dataset_ids: vec!["retained".into()],
                    document_ids: vec![],
                    setting_ids: vec![],
                })
            })
            .unwrap();
        let deleted = db
            .commit_with_effects(&context(&db, "delete"), &"delete", |engine| {
                retire_storage(engine, "retained")?;
                let event = record_deletion(engine, "retained")?;
                assert!(authorize_regular_replay(engine, "retained", &edit.value, true).is_err());
                Ok(CommitEffects {
                    value: event,
                    dataset_ids: vec![],
                    document_ids: vec![],
                    setting_ids: vec![],
                })
            })
            .unwrap();
        db.commit_with_effects(&context(&db, "undo-delete"), &"undo-delete", |engine| {
            let event = authorize_replay(engine, &deleted.value.id, 1, true)?;
            restore_storage(engine, "retained")?;
            mark_replayed(engine, &event, true)?;
            authorize_regular_replay(engine, "retained", &edit.value, true)?;
            engine.apply_change_set_in_transaction(&edit.value, true)?;
            Ok(CommitEffects {
                value: (),
                dataset_ids: vec!["retained".into()],
                document_ids: vec![],
                setting_ids: vec![],
            })
        })
        .unwrap();
        db.commit_with_effects(&context(&db, "undo-create"), &"undo-create", |engine| {
            let event = authorize_replay(engine, &created.value.id, 1, true)?;
            retire_storage(engine, "retained")?;
            mark_replayed(engine, &event, true)?;
            assert!(authorize_regular_replay(engine, "retained", &edit.value, false).is_err());
            Ok(CommitEffects {
                value: (),
                dataset_ids: vec![],
                document_ids: vec![],
                setting_ids: vec![],
            })
        })
        .unwrap();
        db.commit_with_effects(&context(&db, "redo-create"), &"redo-create", |engine| {
            let event = authorize_replay(engine, &created.value.id, 2, false)?;
            restore_storage(engine, "retained")?;
            mark_replayed(engine, &event, false)?;
            authorize_regular_replay(engine, "retained", &edit.value, false)?;
            engine.apply_change_set_in_transaction(&edit.value, false)?;
            assert!(authorize_regular_replay(engine, "retained", &edit.value, false).is_err());
            Ok(CommitEffects {
                value: (),
                dataset_ids: vec!["retained".into()],
                document_ids: vec![],
                setting_ids: vec![],
            })
        })
        .unwrap();
    }

    #[test]
    fn project_v5_lifecycle_events_selected_metadata_rejects_invalid_records() {
        let root = tempfile::tempdir().unwrap();
        let db = ProjectDatabase::create(&root.path().join("invalid-events.spprj"), false).unwrap();
        let created = db
            .commit_with_effects(&context(&db, "create"), &"create", |engine| {
                engine.create_table_from_rows_in_transaction(
                    "retained",
                    &CreateTableFromRowsRequest {
                        name: "Retained".into(),
                        column_names: vec!["value".into()],
                        column_types: vec!["BIGINT".into()],
                        rows: vec![],
                    },
                )?;
                let event = record_creation(engine, "retained")?;
                Ok(CommitEffects {
                    value: event,
                    dataset_ids: vec!["retained".into()],
                    document_ids: vec![],
                    setting_ids: vec![],
                })
            })
            .unwrap();
        for corruption in [
            "operation='unknown'",
            "revision=0",
            "dataset_id=''",
            "history_ordinal=100",
            "project_revision=100",
        ] {
            db.with_engine(|engine| {engine.conn().execute_batch("UPDATE _project_table_lifecycle_events SET operation='create_table',revision=1,dataset_id='retained',history_ordinal=0,project_revision=1")?;engine.conn().execute_batch(&format!("UPDATE _project_table_lifecycle_events SET {corruption}"))?;Ok(())}).unwrap();
            let result = db.with_reader(db.epoch(), |engine| get_event(engine, &created.value.id));
            assert!(
                result.is_err(),
                "invalid selected lifecycle metadata was accepted: {corruption}"
            );
        }
    }

    #[test]
    fn project_v5_lifecycle_events_new_edit_prunes_abandoned_deletion() {
        let root = tempfile::tempdir().unwrap();
        let db = ProjectDatabase::create(&root.path().join("reverse-branch.spprj"), false).unwrap();
        db.commit_with_effects(&context(&db, "create"), &"create", |engine| {
            engine.create_table_from_rows_in_transaction(
                "retained",
                &CreateTableFromRowsRequest {
                    name: "Retained".into(),
                    column_names: vec!["value".into()],
                    column_types: vec!["BIGINT".into()],
                    rows: vec![vec![serde_json::json!(1)]],
                },
            )?;
            record_creation(engine, "retained")?;
            Ok(CommitEffects {
                value: (),
                dataset_ids: vec!["retained".into()],
                document_ids: vec![],
                setting_ids: vec![],
            })
        })
        .unwrap();
        let deleted = db
            .commit_with_effects(&context(&db, "delete"), &"delete", |engine| {
                retire_storage(engine, "retained")?;
                let event = record_deletion(engine, "retained")?;
                Ok(CommitEffects {
                    value: event,
                    dataset_ids: vec![],
                    document_ids: vec![],
                    setting_ids: vec![],
                })
            })
            .unwrap();
        db.commit_with_effects(&context(&db, "undo-delete"), &"undo-delete", |engine| {
            let event = authorize_replay(engine, &deleted.value.id, 1, true)?;
            restore_storage(engine, "retained")?;
            mark_replayed(engine, &event, true)?;
            Ok(CommitEffects {
                value: (),
                dataset_ids: vec!["retained".into()],
                document_ids: vec![],
                setting_ids: vec![],
            })
        })
        .unwrap();
        db.commit_with_effects(&context(&db, "edit"), &"edit", |engine| {
            crate::services::project_cell_mutation::update_cells_compact_in_transaction(
                engine,
                "retained",
                &[CellUpdate {
                    row_id: 1,
                    column_name: "value".into(),
                    value: Some("2".into()),
                }],
                1,
            )?;
            assert!(
                get_event(engine, &deleted.value.id)?.is_none(),
                "a new ordinary edit must abandon lifecycle redo history"
            );
            Ok(CommitEffects {
                value: (),
                dataset_ids: vec!["retained".into()],
                document_ids: vec![],
                setting_ids: vec![],
            })
        })
        .unwrap();
    }

    #[test]
    fn project_v5_lifecycle_events_new_deletion_prunes_abandoned_edit() {
        let root = tempfile::tempdir().unwrap();
        let db = ProjectDatabase::create(&root.path().join("branch.spprj"), false).unwrap();
        db.commit_with_effects(&context(&db, "create"), &"create", |engine| {
            engine.create_table_from_rows_in_transaction(
                "retained",
                &CreateTableFromRowsRequest {
                    name: "Retained".into(),
                    column_names: vec!["value".into()],
                    column_types: vec!["BIGINT".into()],
                    rows: vec![vec![serde_json::json!(1)]],
                },
            )?;
            record_creation(engine, "retained")?;
            Ok(CommitEffects {
                value: (),
                dataset_ids: vec!["retained".into()],
                document_ids: vec![],
                setting_ids: vec![],
            })
        })
        .unwrap();
        let edit = db
            .commit_with_effects(&context(&db, "edit"), &"edit", |engine| {
                let changed =
                    crate::services::project_cell_mutation::update_cells_compact_in_transaction(
                        engine,
                        "retained",
                        &[CellUpdate {
                            row_id: 1,
                            column_name: "value".into(),
                            value: Some("2".into()),
                        }],
                        0,
                    )?;
                Ok(CommitEffects {
                    value: changed.change_set_id.unwrap(),
                    dataset_ids: vec!["retained".into()],
                    document_ids: vec![],
                    setting_ids: vec![],
                })
            })
            .unwrap();
        db.commit_with_effects(&context(&db, "undo-edit"), &"undo-edit", |engine| {
            engine.apply_change_set_in_transaction(&edit.value, true)?;
            Ok(CommitEffects {
                value: (),
                dataset_ids: vec!["retained".into()],
                document_ids: vec![],
                setting_ids: vec![],
            })
        })
        .unwrap();
        db.commit_with_effects(&context(&db, "delete"), &"delete", |engine| {
            retire_storage(engine, "retained")?;
            record_deletion(engine, "retained")?;
            let abandoned: usize = engine.conn().query_row(
                "SELECT COUNT(*) FROM _history_change_sets WHERE id=?",
                [&edit.value],
                |row| row.get(0),
            )?;
            assert_eq!(
                abandoned, 0,
                "a new lifecycle mutation must abandon ordinary redo history"
            );
            let snapshots: usize = engine.conn().query_row(
                "SELECT COUNT(*) FROM _project_cell_history_columns WHERE change_set_id=?",
                [&edit.value],
                |row| row.get(0),
            )?;
            assert_eq!(snapshots, 0);
            Ok(CommitEffects {
                value: (),
                dataset_ids: vec![],
                document_ids: vec![],
                setting_ids: vec![],
            })
        })
        .unwrap();
    }

    #[test]
    fn project_v5_lifecycle_events_reads_are_no_write_and_publication_rolls_back_or_replays() {
        let root = tempfile::tempdir().unwrap();
        let db = ProjectDatabase::create(&root.path().join("atomic.spprj"), false).unwrap();
        db.with_reader(db.epoch(), |engine| {
            assert!(get_event(engine, "missing")?.is_none());
            assert!(!has_events(engine)?);
            Ok(())
        })
        .unwrap();
        let create = context(&db, "create");
        crate::services::project_transaction::inject_commit_failure_for_test(1);
        let failed = db.commit_with_effects(&create, &"create", |engine| {
            engine.create_table_from_rows_in_transaction(
                "retained",
                &CreateTableFromRowsRequest {
                    name: "Retained".into(),
                    column_names: vec!["value".into()],
                    column_types: vec!["BIGINT".into()],
                    rows: vec![],
                },
            )?;
            let event = record_creation(engine, "retained")?;
            Ok(CommitEffects {
                value: event,
                dataset_ids: vec!["retained".into()],
                document_ids: vec![],
                setting_ids: vec![],
            })
        });
        assert!(failed.is_err());
        db.with_reader(db.epoch(), |engine| {
            assert!(!has_events(engine)?);
            assert!(engine.list_datasets()?.is_empty());
            Ok(())
        })
        .unwrap();
        let created = db
            .commit_with_effects(&create, &"create", |engine| {
                engine.create_table_from_rows_in_transaction(
                    "retained",
                    &CreateTableFromRowsRequest {
                        name: "Retained".into(),
                        column_names: vec!["value".into()],
                        column_types: vec!["BIGINT".into()],
                        rows: vec![],
                    },
                )?;
                let event = record_creation(engine, "retained")?;
                Ok(CommitEffects {
                    value: event,
                    dataset_ids: vec!["retained".into()],
                    document_ids: vec![],
                    setting_ids: vec![],
                })
            })
            .unwrap();
        let delete = context(&db, "delete");
        crate::services::project_transaction::inject_commit_failure_for_test(2);
        let failed = db.commit_with_effects(&delete, &"delete", |engine| {
            retire_storage(engine, "retained")?;
            let event = record_deletion(engine, "retained")?;
            Ok(CommitEffects {
                value: event,
                dataset_ids: vec![],
                document_ids: vec![],
                setting_ids: vec![],
            })
        });
        assert!(failed.is_err());
        let replay: ProjectCommit<LifecycleEvent> = db
            .commit_with_effects(&delete, &"delete", |_| {
                panic!("committed lifecycle publication reran")
            })
            .unwrap();
        assert_eq!(replay.committed_revision, 2);
        assert_eq!(replay.value.history_ordinal, 1);
        db.with_reader(db.epoch(), |engine| {
            assert!(get_event(engine, &created.value.id)?.unwrap().applied);
            let count: usize = engine.conn().query_row(
                "SELECT COUNT(*) FROM _project_table_lifecycle_events",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(count, 2);
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn project_v5_lifecycle_events_share_edit_order_and_reject_stale_replay() {
        let root = tempfile::tempdir().unwrap();
        let db = ProjectDatabase::create(&root.path().join("events.spprj"), false).unwrap();
        let created = db
            .commit_with_effects(&context(&db, "create"), &"create", |engine| {
                engine.create_table_from_rows_in_transaction(
                    "retained",
                    &CreateTableFromRowsRequest {
                        name: "Retained".into(),
                        column_names: vec!["value".into()],
                        column_types: vec!["BIGINT".into()],
                        rows: vec![vec![serde_json::json!(1)]],
                    },
                )?;
                let event = record_creation(engine, "retained")?;
                Ok(CommitEffects {
                    value: event,
                    dataset_ids: vec!["retained".into()],
                    document_ids: vec![],
                    setting_ids: vec![],
                })
            })
            .unwrap();
        assert_eq!(created.value.revision, 1);
        db.commit_with_effects(&context(&db, "edit"), &"edit", |engine| {
            crate::services::project_cell_mutation::update_cells_compact_in_transaction(
                engine,
                "retained",
                &[CellUpdate {
                    row_id: 1,
                    column_name: "value".into(),
                    value: Some("2".into()),
                }],
                0,
            )?;
            assert!(authorize_replay(engine, &created.value.id, 1, true).is_err());
            let ordinal: u64 = engine.conn().query_row(
                "SELECT history_ordinal FROM _history_timeline WHERE dataset_id='retained'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(ordinal, 1);
            Ok(CommitEffects {
                value: (),
                dataset_ids: vec!["retained".into()],
                document_ids: vec![],
                setting_ids: vec![],
            })
        })
        .unwrap();
        let deleted = db
            .commit_with_effects(&context(&db, "delete"), &"delete", |engine| {
                retire_storage(engine, "retained")?;
                let event = record_deletion(engine, "retained")?;
                assert_eq!(event.history_ordinal, 2);
                Ok(CommitEffects {
                    value: event,
                    dataset_ids: vec![],
                    document_ids: vec![],
                    setting_ids: vec![],
                })
            })
            .unwrap();
        db.commit_with_effects(&context(&db, "undo-delete"), &"undo-delete", |engine| {
            assert!(authorize_replay(engine, &deleted.value.id, 2, true).is_err());
            let event = authorize_replay(engine, &deleted.value.id, 1, true)?;
            restore_storage(engine, "retained")?;
            mark_replayed(engine, &event, true)?;
            assert!(authorize_replay(engine, &deleted.value.id, 1, false).is_err());
            assert!(authorize_replay(engine, &created.value.id, 1, true).is_err());
            let redo = authorize_replay(engine, &deleted.value.id, 2, false)?;
            assert_eq!(redo.operation, "delete_table");
            Ok(CommitEffects {
                value: (),
                dataset_ids: vec!["retained".into()],
                document_ids: vec![],
                setting_ids: vec![],
            })
        })
        .unwrap();
        assert_eq!(
            db.with_reader(db.epoch(), |engine| Ok(get_event(
                engine,
                &deleted.value.id
            )?
            .unwrap()
            .revision))
                .unwrap(),
            2
        );
    }

    #[test]
    fn project_v5_lifecycle_storage_restore_respects_identity_high_water_marks() {
        let root = tempfile::tempdir().unwrap();
        let db = ProjectDatabase::create(&root.path().join("identities.spprj"), false).unwrap();
        db.with_engine(|engine| {
            engine.create_table_from_rows(
                "retained",
                &CreateTableFromRowsRequest {
                    name: "Retained".into(),
                    column_names: vec!["value".into()],
                    column_types: vec!["BIGINT".into()],
                    rows: vec![vec![serde_json::json!(1)]],
                },
            )?;
            Ok(())
        })
        .unwrap();
        db.commit_with_effects(&context(&db,"retire"),&"retire",|engine| {
            retire_storage(engine,"retained")?;
            engine.conn().execute_batch("UPDATE _project_dataset_generation_watermarks SET generation=9,next_row_id=100 WHERE dataset_id='retained'")?;
            Ok(CommitEffects {value:(),dataset_ids:vec![],document_ids:vec![],setting_ids:vec![]})
        }).unwrap();
        let restored = db
            .commit_with_effects(&context(&db, "restore"), &"restore", |engine| {
                let meta = restore_storage(engine, "retained")?;
                assert_eq!(meta.generation, 10);
                let next: i64 = engine.conn().query_row(
                    "SELECT next_row_id FROM _meta_datasets WHERE id='retained'",
                    [],
                    |row| row.get(0),
                )?;
                assert_eq!(next, 100);
                engine.validate_natural_anchor_manifest("retained", 10, 1)?;
                Ok(CommitEffects {
                    value: meta,
                    dataset_ids: vec!["retained".into()],
                    document_ids: vec![],
                    setting_ids: vec![],
                })
            })
            .unwrap();
        assert_eq!(restored.value.row_count, 1);
    }

    #[test]
    fn project_v5_lifecycle_storage_keeps_physical_table_and_edit_history_on_reopen() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("retired.spprj");
        let db = ProjectDatabase::create(&path, false).unwrap();
        db.with_engine(|engine| {
            let meta = engine.create_table_from_rows(
                "retained",
                &CreateTableFromRowsRequest {
                    name: "Retained".into(),
                    column_names: vec!["exact".into(), "amount".into()],
                    column_types: vec!["BIGINT".into(), "DECIMAL(20,4)".into()],
                    rows: vec![
                        vec![
                            serde_json::json!(9007199254740993i64),
                            serde_json::json!("123.4500"),
                        ],
                        vec![serde_json::Value::Null, serde_json::Value::Null],
                    ],
                },
            )?;
            ProjectCatalog::new(engine).publish_table(&meta, "")?;
            Ok(())
        })
        .unwrap();
        let edit = db
            .commit_with_effects(&context(&db, "edit"), &"edit", |engine| {
                let changed =
                    crate::services::project_cell_mutation::update_cells_compact_in_transaction(
                        engine,
                        "retained",
                        &[CellUpdate {
                            row_id: 1,
                            column_name: "amount".into(),
                            value: Some("234.5600".into()),
                        }],
                        0,
                    )?;
                Ok(CommitEffects {
                    value: changed.change_set_id.unwrap(),
                    dataset_ids: vec!["retained".into()],
                    document_ids: vec![],
                    setting_ids: vec![],
                })
            })
            .unwrap();
        let oid: u64 = db
            .with_reader(db.epoch(), |engine| {
                Ok(engine.conn().query_row(
                    "SELECT table_oid FROM duckdb_tables() WHERE table_name='dataset_retained'",
                    [],
                    |row| row.get(0),
                )?)
            })
            .unwrap();
        db.with_engine(|_| {
            crate::engine::duckdb_engine::reset_full_anchor_rebuild_counter();
            crate::services::table_mutation_coordinator::reset_full_before_table_copy_counter();
            Ok(())
        })
        .unwrap();
        crate::services::project_transaction::inject_commit_failure_for_test(1);
        assert!(db
            .commit_with_effects(&context(&db, "failed-retire"), &"retire", |engine| {
                retire_storage(engine, "retained")?;
                Ok(CommitEffects {
                    value: (),
                    dataset_ids: vec![],
                    document_ids: vec![],
                    setting_ids: vec![],
                })
            })
            .is_err());
        assert_eq!(
            db.with_reader(db.epoch(), |engine| engine.list_datasets())
                .unwrap()
                .len(),
            1
        );
        db.commit_with_effects(&context(&db, "retire"), &"retire", |engine| {
            retire_storage(engine, "retained")?;
            assert!(engine.list_datasets()?.is_empty());
            assert!(engine.get_dataset_meta("retained").is_err());
            let current: u64 = engine.conn().query_row(
                "SELECT table_oid FROM duckdb_tables() WHERE table_name='dataset_retained'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(current, oid);
            Ok(CommitEffects {
                value: (),
                dataset_ids: vec![],
                document_ids: vec![],
                setting_ids: vec![],
            })
        })
        .unwrap();
        db.shutdown().unwrap();
        drop(db);
        let db = ProjectDatabase::open(&path, false).unwrap();
        let restored = db
            .commit_with_effects(&context(&db, "restore"), &"restore", |engine| {
                let meta = restore_storage(engine, "retained")?;
                assert!(meta.generation > 1);
                assert_eq!(engine.get_user_column_descriptors("retained")?.len(), 2);
                let history_count: usize = engine.conn().query_row(
                    "SELECT COUNT(*) FROM _history_timeline WHERE dataset_id='retained'",
                    [],
                    |row| row.get(0),
                )?;
                assert_eq!(history_count, 1);
                Ok(CommitEffects {
                    value: meta,
                    dataset_ids: vec!["retained".into()],
                    document_ids: vec![],
                    setting_ids: vec![],
                })
            })
            .unwrap();
        assert_eq!(restored.value.row_count, 2);
        db.with_engine(|engine| {
            engine.apply_change_set(&edit.value, true)?;
            let actual: (i64, String) = engine.conn().query_row(
                "SELECT exact,CAST(amount AS VARCHAR) FROM dataset_retained WHERE _row_id=1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            assert_eq!(actual, (9007199254740993, "123.4500".into()));
            assert_eq!(
                crate::engine::duckdb_engine::full_anchor_rebuild_counter(),
                0
            );
            assert_eq!(
                crate::services::table_mutation_coordinator::full_before_table_copy_counter(),
                0
            );
            Ok(())
        })
        .unwrap();
    }
}
