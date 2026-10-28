//! Select one executable metadata frontier without hydrating the history payload.
use crate::{engine::duckdb_engine::DuckDbEngine,error::AppError,models::project_persistence::*};

use duckdb::{params,OptionalExt};
fn has_table(engine:&DuckDbEngine,name:&str)->Result<bool,AppError> {
    Ok(engine.conn().query_row("SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name=?)",[name],|row|row.get(0))?)
}

/// Original publication owns the introduction index; replays never reorder it.
pub(crate) fn record(engine:&DuckDbEngine,revision:u64,entries:&[ProjectHistorySummary])->Result<(),AppError> {
    if entries.is_empty(){return Ok(());}
    engine.conn().execute_batch("CREATE TABLE IF NOT EXISTS _project_history_introductions(id VARCHAR PRIMARY KEY,introduced_revision UBIGINT NOT NULL); CREATE INDEX IF NOT EXISTS _project_history_introduced_revision ON _project_history_introductions(introduced_revision)")?;
    for entry in entries {
        engine.conn().execute("INSERT INTO _project_history_introductions VALUES(?,?) ON CONFLICT(id) DO NOTHING",params![&entry.id,revision])?;
    }
    Ok(())
}

pub(crate) fn forget(engine:&DuckDbEngine,ids:&[String])->Result<(),AppError> {
    if !ids.is_empty() && has_table(engine,"_project_history_introductions")? {
        for id in ids {engine.conn().execute("DELETE FROM _project_history_introductions WHERE id=?",[id])?;}
    }
    Ok(())
}

pub(crate) fn reset(engine:&DuckDbEngine)->Result<(),AppError> {
    if has_table(engine,"_project_history_introductions")?{engine.conn().execute_batch("DELETE FROM _project_history_introductions")?;}
    Ok(())
}

pub(crate) fn frontier(engine:&DuckDbEngine,dataset:Option<&str>,undo:bool)->Result<ProjectHistoryFrontier,AppError> {
    let ordinary=super::project_history_group::public_timeline(engine)?;
    let lifecycle=if has_table(engine,"_project_table_lifecycle_events")? {
        format!("SELECT h.id,h.dataset_id,h.operation,h.applied,h.generation,h.dataset_name,l.history_ordinal FROM ({}) h JOIN _project_table_lifecycle_events l ON l.id=h.id",super::project_table_lifecycle::history_source(engine)?)
    } else {"SELECT NULL::VARCHAR AS id,NULL::VARCHAR AS dataset_id,NULL::VARCHAR AS operation,FALSE AS applied,0::UBIGINT AS generation,NULL::VARCHAR AS dataset_name,0::BIGINT AS history_ordinal WHERE FALSE".into()};
    let introductions=if has_table(engine,"_project_history_introductions")? {"SELECT * FROM _project_history_introductions"} else {"SELECT NULL::VARCHAR AS id,0::UBIGINT AS introduced_revision WHERE FALSE"};
    let order=if undo {"DESC"}else{"ASC"};
    let sql=format!("WITH executable AS (
        SELECT h.change_set_id AS id,h.dataset_id,h.operation,h.applied,m.generation,m.name AS dataset_name,h.history_ordinal FROM ({ordinary}) h JOIN _meta_datasets m ON m.id=h.dataset_id
        UNION ALL {lifecycle}
    ), ranked AS (
        SELECT h.*,COALESCE(i.introduced_revision,0) AS introduced_revision,ROW_NUMBER() OVER(PARTITION BY h.dataset_id ORDER BY h.history_ordinal {order},h.id) AS position
        FROM executable h LEFT JOIN ({introductions}) i ON i.id=h.id WHERE h.applied=? AND (CAST(? AS VARCHAR) IS NULL OR h.dataset_id=?)
    ) SELECT id,dataset_id,operation,applied,generation,dataset_name FROM ranked WHERE position=1 ORDER BY introduced_revision {order},history_ordinal {order},dataset_id,id LIMIT 1");
    let entry:Option<ProjectHistorySummary>=engine.conn().query_row(&sql,params![undo,dataset,dataset],|row|Ok(ProjectHistorySummary{id:row.get(0)?,dataset_id:row.get(1)?,operation:row.get(2)?,applied:row.get(3)?,generation:row.get(4)?,dataset_name:row.get(5)?,description:None,timestamp:None})).optional()?;
    if let Some(entry)=&entry {
        if matches!(entry.operation.as_str(),"create_table"|"delete_table") {
            super::project_table_lifecycle::get_event(engine,&entry.id)?.ok_or_else(||AppError::InvalidParam("project_lifecycle_event_missing".into()))?;
        }
    }
    Ok(ProjectHistoryFrontier{entry,committed_revision:super::project_schema::read_header(engine.conn(),false)?.committed_revision})
}

#[cfg(all(test, feature="project-v5"))]
mod tests {
    use super::*;
    use crate::services::{project_database::ProjectDatabase,project_output::ProjectSqlOutput};
    fn context(db:&ProjectDatabase,id:&str)->ProjectWriteContext {
        ProjectWriteContext{operation_id:id.into(),expected_project_id:db.header().unwrap().project_id,expected_epoch:db.epoch(),expected_revision:db.committed_revision().unwrap(),request_digest:String::new(),dataset_generations:vec![],document_revisions:vec![]}
    }
    #[test]
    fn project_v5_history_frontier_new_table_prunes_other_table_redo_branch() {
        use crate::{state::AppState,services::project_native_service::NativeProjectService,models::table::CellUpdate};
        let root=tempfile::tempdir().unwrap();let path=root.path().join("global-branch.spprj");let db=ProjectDatabase::create(&path,false).unwrap();
        let first=db.materialize_project_sql(&context(&db,"first"),&ProjectSqlOutput{name:"First".into(),sql:"SELECT 1::BIGINT AS value".into(),folder:String::new()}).unwrap();db.shutdown().unwrap();
        let state=AppState::new().unwrap();let service=NativeProjectService::new(&state);let opened=service.open(&path,false).unwrap();let db=service.database(opened.epoch).unwrap();
        let mut edit=context(&db,"edit");edit.dataset_generations=first.changed_dataset_generations.clone();let changed=service.update_cells(&edit,&first.value.id,&[CellUpdate{row_id:1,column_name:"value".into(),value:Some("2".into())}],Some(0)).unwrap();
        let mut undo=context(&db,"undo");undo.dataset_generations=changed.changed_dataset_generations.clone();service.apply_change_set(&undo,&first.value.id,&changed.changed_history_entries[0].id,true).unwrap();
        db.materialize_project_sql(&context(&db,"second"),&ProjectSqlOutput{name:"Second".into(),sql:"SELECT 3::BIGINT AS value".into(),folder:String::new()}).unwrap();
        assert!(service.history_frontier(opened.epoch,None,false).unwrap().entry.is_none(),"a new action on another table must abandon the global redo branch");
    }

    #[test]
    fn project_v5_history_frontier_abandoned_creation_releases_only_its_hidden_storage() {
        use crate::{state::AppState,services::project_native_service::NativeProjectService};
        let root=tempfile::tempdir().unwrap();let path=root.path().join("abandoned-creation.spprj");let db=ProjectDatabase::create(&path,false).unwrap();
        let first=db.materialize_project_sql(&context(&db,"first"),&ProjectSqlOutput{name:"First".into(),sql:"SELECT 1::BIGINT AS value".into(),folder:String::new()}).unwrap();db.shutdown().unwrap();
        let state=AppState::new().unwrap();let service=NativeProjectService::new(&state);let opened=service.open(&path,false).unwrap();let db=service.database(opened.epoch).unwrap();
        let id=&first.changed_history_entries[0].id;let event=service.table_lifecycle_event(opened.epoch,id).unwrap();let mut undo=context(&db,"undo-create");undo.dataset_generations=first.changed_dataset_generations.clone();service.apply_table_lifecycle(&undo,id,event.revision,true).unwrap();
        let create=context(&db,"second");let output=ProjectSqlOutput{name:"Second".into(),sql:"SELECT 3::BIGINT AS value".into(),folder:String::new()};
        crate::services::project_transaction::inject_commit_failure_for_test(1);assert!(db.materialize_project_sql(&create,&output).is_err());
        assert_eq!(service.history_frontier(opened.epoch,None,false).unwrap().entry.unwrap().id,*id,"failed cleanup must retain the old redo event");
        db.with_reader(opened.epoch,|engine| {let physical=DuckDbEngine::internal_table_name(&first.value.id);let exists:bool=engine.conn().query_row("SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name=?)",[physical],|row|row.get(0))?;assert!(exists,"failed cleanup must restore hidden physical storage");assert!(engine.list_datasets()?.is_empty());Ok(())}).unwrap();
        crate::services::project_transaction::inject_commit_failure_for_test(2);assert!(db.materialize_project_sql(&create,&output).is_err());
        let second=db.materialize_project_sql(&create,&output).unwrap();

        assert!(service.table_lifecycle_event(opened.epoch,id).is_err(),"abandoned creation is no longer replayable");
        db.with_reader(opened.epoch,|engine| {
            let physical=DuckDbEngine::internal_table_name(&first.value.id);let exists:bool=engine.conn().query_row("SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name=?)",[physical],|row|row.get(0))?;assert!(!exists);
            assert_eq!(engine.list_datasets()?.len(),1);assert_eq!(engine.get_dataset_meta(&second.value.id)?.name,"Second");
            let metadata:usize=engine.conn().query_row("SELECT COUNT(*) FROM _project_retired_directory WHERE event_id=?",[id],|row|row.get(0))?;assert_eq!(metadata,0);
            assert!(crate::services::project_catalog::ProjectCatalog::new(engine).list_history(&HistoryPageRequest{dataset_id:Some(first.value.id.clone()),after:None,limit:200})?.items.is_empty());Ok(())
        }).unwrap();
    }

    #[test]
    fn project_v5_history_frontier_replays_hidden_creation_and_edits_after_reopen() {
        use crate::{state::AppState,services::project_native_service::NativeProjectService,models::table::{CreateTableFromRowsRequest,CellUpdate}};
        let root=tempfile::tempdir().unwrap();let path=root.path().join("replay.spprj");ProjectDatabase::create(&path,false).unwrap().shutdown().unwrap();
        let state=AppState::new().unwrap();let service=NativeProjectService::new(&state);let opened=service.open(&path,false).unwrap();
        let db=service.database(opened.epoch).unwrap();
        let first=service.create_table_from_rows(&context(&db,"first"),&CreateTableFromRowsRequest{name:"First".into(),column_names:vec!["value".into()],column_types:vec!["BIGINT".into()],rows:vec![vec![serde_json::json!(1)]]}).unwrap();
        let mut edit=context(&db,"edit-first");edit.dataset_generations=first.changed_dataset_generations.clone();
        let changed=service.update_cells(&edit,&first.value.id,&[CellUpdate{row_id:1,column_name:"value".into(),value:Some("2".into())}],Some(0)).unwrap();
        let change_id=changed.changed_history_entries[0].id.clone();
        let second=service.create_table_from_rows(&context(&db,"second"),&CreateTableFromRowsRequest{name:"Second".into(),column_names:vec![],column_types:vec![],rows:vec![]}).unwrap();
        let second_event=second.changed_history_entries[0].id.clone();
        assert_eq!(service.history_frontier(opened.epoch,None,true).unwrap().entry.unwrap().id,second_event);
        let event=service.table_lifecycle_event(opened.epoch,&second_event).unwrap();let mut undo=context(&db,"undo-second");undo.dataset_generations=second.changed_dataset_generations.clone();
        service.apply_table_lifecycle(&undo,&second_event,event.revision,true).unwrap();
        assert_eq!(service.history_frontier(opened.epoch,None,true).unwrap().entry.unwrap().id,change_id);
        let mut undo=context(&db,"undo-edit");undo.dataset_generations=changed.changed_dataset_generations.clone();service.apply_change_set(&undo,&first.value.id,&change_id,true).unwrap();
        assert_eq!(service.history_frontier(opened.epoch,None,false).unwrap().entry.unwrap().id,change_id,"redo the earlier edit before the later creation");
        drop(db);service.close(opened.epoch).unwrap();let reopened=service.open(&path,true).unwrap();
        assert_eq!(service.history_frontier(reopened.epoch,None,false).unwrap().entry.unwrap().id,change_id);service.close(reopened.epoch).unwrap();
        let reopened=service.open(&path,false).unwrap();let db=service.database(reopened.epoch).unwrap();let mut redo=context(&db,"redo-edit");redo.dataset_generations=vec![DatasetGeneration{id:first.value.id.clone(),generation:2}];
        service.apply_change_set(&redo,&first.value.id,&change_id,false).unwrap();
        assert_eq!(service.history_frontier(reopened.epoch,None,false).unwrap().entry.unwrap().id,second_event);
        let event=service.table_lifecycle_event(reopened.epoch,&second_event).unwrap();service.apply_table_lifecycle(&context(&db,"redo-second"),&second_event,event.revision,false).unwrap();
        assert_eq!(service.history_frontier(reopened.epoch,None,true).unwrap().entry.unwrap().id,second_event,"replay must retain original introduction order");
    }

    #[test]
    fn project_v5_history_frontier_orders_original_commits_and_reads_without_upgrade() {
        let root=tempfile::tempdir().unwrap();let path=root.path().join("history.spprj");let db=ProjectDatabase::create(&path,false).unwrap();
        let first=db.materialize_project_sql(&context(&db,"first"),&ProjectSqlOutput{name:"First".into(),sql:"SELECT 1::BIGINT AS value".into(),folder:String::new()}).unwrap();
        let second=db.materialize_project_sql(&context(&db,"second"),&ProjectSqlOutput{name:"Second".into(),sql:"SELECT 2::BIGINT AS value".into(),folder:String::new()}).unwrap();
        let selected=db.with_reader(db.epoch(),|engine|frontier(engine,None,true)).unwrap();
        assert_eq!(selected.entry.unwrap().dataset_id,second.value.id,"global undo follows introduction order, not random event UUID");
        let scoped=db.with_reader(db.epoch(),|engine|frontier(engine,Some(&first.value.id),true)).unwrap();
        assert_eq!(scoped.entry.unwrap().operation,"create_table");
        assert!(db.with_reader(db.epoch(),|engine|frontier(engine,None,false)).unwrap().entry.is_none());
        db.shutdown().unwrap();let reopened=ProjectDatabase::open(&path,true).unwrap();
        assert_eq!(reopened.with_reader(reopened.epoch(),|engine|frontier(engine,None,true)).unwrap().entry.unwrap().dataset_id,second.value.id);
        assert_eq!(reopened.committed_revision().unwrap(),2);reopened.shutdown().unwrap();
        let older=ProjectDatabase::open(&path,false).unwrap();older.with_engine(|engine| {engine.conn().execute_batch("DROP TABLE _project_history_introductions")?;Ok(())}).unwrap();older.shutdown().unwrap();
        let older=ProjectDatabase::open(&path,true).unwrap();
        older.with_reader(older.epoch(),|engine| {
            assert!(frontier(engine,Some(&first.value.id),true)?.entry.is_some());
            let exists:bool=engine.conn().query_row("SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name='_project_history_introductions')",[],|row|row.get(0))?;assert!(!exists,"old metadata reads must not upgrade the file");Ok(())
        }).unwrap();
    }
}
