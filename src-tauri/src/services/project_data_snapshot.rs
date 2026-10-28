use super::{
    project_catalog::ProjectCatalog, project_database::ProjectDatabase,
    project_transaction::CommitEffects,
};
use crate::{engine::duckdb_engine::DuckDbEngine, error::AppError, models::project_persistence::*};
use duckdb::{params, OptionalExt};

fn invalid(code: &str) -> AppError {
    AppError::InvalidParam(code.into())
}
fn prefix(id: &str) -> Result<String, AppError> {
    let id = uuid::Uuid::parse_str(id).map_err(|_| invalid("project_snapshot_id_invalid"))?;
    Ok(format!("_project_snapshot_{}", id.simple()))
}
/// A migrated descriptor retains its public legacy ID and owns a separate UUID storage key.
fn storage_prefix(engine:&DuckDbEngine,id:&str)->Result<String,AppError> {
    let storage:Option<String>=engine.conn().query_row("SELECT json_extract_string(body_json,'$.storageId') FROM _project_documents WHERE id=?",[id],|row|row.get(0)).optional()?.flatten();
    prefix(storage.as_deref().unwrap_or(id))
}
fn quoted(name: &str) -> String {
    DuckDbEngine::quote_identifier(name)
}
fn metadata_names(engine:&DuckDbEngine,id: &str) -> Result<Vec<String>, AppError> {
    let base = storage_prefix(engine,id)?;
    Ok(
        ["datasets", "columns", "calculated", "directory", "settings"]
            .iter()
            .map(|suffix| format!("{base}_{suffix}"))
            .collect(),
    )
}
fn descriptor(
    engine: &DuckDbEngine,
    id: &str,
    revision: u64,
) -> Result<ProjectDataSnapshotDescriptor, AppError> {
    let doc = ProjectCatalog::new(engine).get_document(id, revision)?;
    if doc.summary.kind != ProjectDocumentKind::Snapshot
        || doc.body.get("storage").and_then(|v| v.as_str()) != Some("projectTables")
    {
        return Err(invalid("project_native_snapshot_required"));
    }
    Ok(ProjectDataSnapshotDescriptor {
        id: id.into(),
        name: doc.summary.name,
        revision,
        created_at: doc
            .body
            .get("createdAt")
            .and_then(|v| v.as_str())
            .ok_or_else(|| invalid("project_snapshot_metadata_invalid"))?
            .into(),
        table_count: doc
            .body
            .get("tableCount")
            .and_then(|v| v.as_u64())
            .and_then(|v| usize::try_from(v).ok())
            .ok_or_else(|| invalid("project_snapshot_metadata_invalid"))?,
    })
}
fn owned_tables(engine: &DuckDbEngine, id: &str) -> Result<Vec<(String, u32)>, AppError> {
    let base = storage_prefix(engine,id)?;
    let tables=engine.conn().prepare("SELECT dataset_id,ordinal FROM _project_snapshot_tables WHERE snapshot_id=? ORDER BY ordinal")?.query_map([id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,u32>(1)?)))?.collect::<Result<Vec<_>,_>>()?;
    for (expected, (_, ordinal)) in tables.iter().enumerate() {
        if *ordinal as usize != expected {
            return Err(invalid("project_snapshot_table_index_invalid"));
        }
    }
    // Even an empty snapshot must have its operation-owned metadata tables.
    for name in metadata_names(engine,id)?.into_iter().chain(
        tables
            .iter()
            .map(|(_, ordinal)| format!("{base}_table_{ordinal}")),
    ) {
        let exists: bool = engine.conn().query_row(
            "SELECT EXISTS(SELECT 1 FROM duckdb_tables() WHERE table_name=?)",
            [name],
            |r| r.get(0),
        )?;
        if !exists {
            return Err(invalid("project_snapshot_storage_missing"));
        }
    }
    Ok(tables)
}

/// Preserve identity watermarks when later restores recreate a deleted dataset.
pub(crate) fn retain_dataset_generation(
    engine: &DuckDbEngine,
    id: &str,
    generation: u64,
) -> Result<(), AppError> {
    let next: Option<i64> = engine
        .conn()
        .query_row(
            "SELECT next_row_id FROM _meta_datasets WHERE id=?",
            [id],
            |r| r.get(0),
        )
        .optional()?
        .flatten();
    let revision: u64 = engine
        .conn()
        .query_row(
            "SELECT revision FROM _project_directory WHERE id=? AND kind='table'",
            [id],
            |r| r.get(0),
        )
        .optional()?
        .unwrap_or(0);
    engine.conn().execute_batch("CREATE TABLE IF NOT EXISTS _project_dataset_generation_watermarks (dataset_id VARCHAR PRIMARY KEY,generation UBIGINT NOT NULL,next_row_id BIGINT,directory_revision UBIGINT NOT NULL)")?;
    engine.conn().execute("INSERT INTO _project_dataset_generation_watermarks VALUES (?,?,?,?) ON CONFLICT(dataset_id) DO UPDATE SET generation=GREATEST(_project_dataset_generation_watermarks.generation,excluded.generation),next_row_id=GREATEST(_project_dataset_generation_watermarks.next_row_id,excluded.next_row_id),directory_revision=GREATEST(_project_dataset_generation_watermarks.directory_revision,excluded.directory_revision)",params![id,generation,next,revision])?;
    Ok(())
}
fn retained_identity(engine: &DuckDbEngine, id: &str) -> Result<(u64, Option<i64>, u64), AppError> {
    let exists:bool=engine.conn().query_row("SELECT EXISTS(SELECT 1 FROM duckdb_tables() WHERE table_name='_project_dataset_generation_watermarks')",[],|r|r.get(0))?;
    if !exists {
        return Ok((0, None, 0));
    }
    Ok(engine.conn().query_row("SELECT generation,next_row_id,directory_revision FROM _project_dataset_generation_watermarks WHERE dataset_id=?",[id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?.unwrap_or((0,None,0)))
}

/// Migration owns this unpublished file. Adopt streamed tables by rename, without a second row copy.
pub(crate) fn import_legacy_snapshot(engine:&DuckDbEngine,mut value:serde_json::Value,cancelled:&dyn Fn()->bool)->Result<(),AppError> {
    use super::{project_table_import::NativeTableRestoreSink,spprj_archive::TableDoc,streaming_table_reader::TableBatchSink};
    let fields=value.as_object_mut().ok_or_else(||invalid("project_snapshot_metadata_invalid"))?;
    let id=fields.get("id").and_then(|v|v.as_str()).ok_or_else(||invalid("project_snapshot_metadata_invalid"))?.to_owned();
    let name=fields.get("name").and_then(|v|v.as_str()).ok_or_else(||invalid("project_snapshot_metadata_invalid"))?.to_owned();
    let created=fields.get("timestamp").and_then(|v|v.as_str()).ok_or_else(||invalid("project_snapshot_metadata_invalid"))?.to_owned();
    let mut snapshot=fields.remove("snapshot").ok_or_else(||invalid("project_snapshot_metadata_invalid"))?;
    let datasets=snapshot.as_object_mut().and_then(|fields|fields.remove("datasets")).ok_or_else(||invalid("project_snapshot_metadata_invalid"))?;
    let datasets:Vec<serde_json::Value>=serde_json::from_value(datasets).map_err(|_|invalid("project_snapshot_metadata_invalid"))?;
    if !engine.list_datasets()?.is_empty(){return Err(invalid("project_snapshot_migration_requires_empty_stage"));}
    let catalog=ProjectCatalog::new(engine);
    let mut ids=Vec::new();
    for mut dataset in datasets {
        if cancelled(){return Err(AppError::Cancelled("project_migration_cancelled".into()));}
        dataset.as_object_mut().ok_or_else(||invalid("project_snapshot_metadata_invalid"))?.insert("version".into(),"1".into());
        let mut doc:TableDoc=serde_json::from_value(dataset).map_err(|_|invalid("project_snapshot_metadata_invalid"))?;
        let rows=std::mem::take(&mut doc.rows);
        let mut sink=NativeTableRestoreSink::begin(engine,doc,cancelled)?;
        for batch in rows.chunks(5000){sink.append_rows(batch)?;}
        let (meta,display)=sink.finish()?;
        catalog.publish_table(&meta,"")?;
        if !display.is_empty(){catalog.apply_patch(&ProjectRecordPatch{settings:vec![ProjectSettingWrite{key:format!("display:{}",meta.id),expected_revision:None,value:super::project_column_settings::replacement(engine,&meta.id,&display)?}],..Default::default()})?;}
        ids.push(meta.id);
    }
    let storage_id=uuid::Uuid::new_v4().to_string();
    catalog.apply_patch(&ProjectRecordPatch{documents:vec![DocumentWrite{expected_revision:None,document:ProjectDocumentBody{summary:ProjectDocumentSummary{id:id.clone(),kind:ProjectDocumentKind::Snapshot,name:name.clone(),folder:String::new(),revision:1,dependencies:vec![],analysis_kind:None},schema_version:1,body:serde_json::json!({"id":id,"name":name,"createdAt":created,"storage":"projectTables","storageId":storage_id,"tableCount":ids.len()})}}],..Default::default()})?;
    let base=storage_prefix(engine,&id)?;
    let names=metadata_names(engine,&id)?;
    let conn=engine.conn();
    conn.execute_batch("CREATE TABLE IF NOT EXISTS _project_snapshot_tables(snapshot_id VARCHAR NOT NULL,dataset_id VARCHAR NOT NULL,ordinal UINTEGER NOT NULL,PRIMARY KEY(snapshot_id,dataset_id),UNIQUE(snapshot_id,ordinal))")?;
    let datasets=quoted(&names[0]);
    conn.execute_batch(&format!("CREATE TABLE {datasets} AS SELECT * FROM _meta_datasets; CREATE TABLE {} AS SELECT * FROM _meta_columns; CREATE TABLE {} AS SELECT * FROM _meta_calculated_columns; CREATE TABLE {} AS SELECT * FROM _project_directory WHERE kind='table'; CREATE TABLE {} AS SELECT * FROM _project_settings WHERE key IN (SELECT 'display:'||id FROM {datasets}) OR key IN (SELECT 'filter:'||id FROM {datasets})",quoted(&names[1]),quoted(&names[2]),quoted(&names[3]),quoted(&names[4])))?;
    for (ordinal,dataset) in ids.iter().enumerate() {
        let index=quoted(&format!("project_import_rows_{}",dataset.replace('-',"_")));
        conn.execute_batch(&format!("DROP INDEX {index}; ALTER TABLE {} RENAME TO {}",quoted(&DuckDbEngine::internal_table_name(dataset)),quoted(&format!("{base}_table_{ordinal}"))))?;
        conn.execute("INSERT INTO _project_snapshot_tables VALUES(?,?,?)",params![&id,dataset,ordinal as u32])?;
        engine.delete_dataset(dataset)?;
        conn.execute("DELETE FROM _project_directory WHERE id=? AND kind='table'",[dataset])?;
        for key in [format!("display:{dataset}"),format!("filter:{dataset}")]{conn.execute("DELETE FROM _project_settings WHERE key=?",[key])?;}
    }
    Ok(())
}

impl ProjectDatabase {
    #[cfg(any(test, feature="perf-harness"))]
    pub(crate) fn capture_data_snapshot(
        &self,
        context: &ProjectWriteContext,
        id: &str,
        name: &str,
        created_at: &str,
    ) -> Result<ProjectCommit<ProjectDataSnapshotDescriptor>, AppError> {
        self.capture_data_snapshot_with_progress(context,id,name,created_at,&|_,_,_|{})
    }

    pub(crate) fn capture_data_snapshot_with_progress(&self,context:&ProjectWriteContext,id:&str,name:&str,created_at:&str,progress:&dyn Fn(usize,usize,&str))->Result<ProjectCommit<ProjectDataSnapshotDescriptor>,AppError> {
        let base = prefix(id)?;
        let commit=self.commit_with_effects(context,&("capture_project_data_snapshot",id,name,created_at),|engine| {
            let conn=engine.conn();
            conn.execute_batch("CREATE TABLE IF NOT EXISTS _project_snapshot_tables (snapshot_id VARCHAR NOT NULL,dataset_id VARCHAR NOT NULL,ordinal UINTEGER NOT NULL,PRIMARY KEY(snapshot_id,dataset_id),UNIQUE(snapshot_id,ordinal))")?;
            let tables=conn.prepare("SELECT id FROM _project_directory WHERE kind='table' ORDER BY id")?.query_map([],|r|r.get::<_,String>(0))?.collect::<Result<Vec<_>,_>>()?;
            let names=metadata_names(engine,id)?;
            let datasets=quoted(&names[0]);
            conn.execute_batch(&format!("CREATE TABLE {datasets} AS SELECT m.* FROM _meta_datasets m JOIN _project_directory d ON d.id=m.id AND d.kind='table'; CREATE TABLE {} AS SELECT c.* FROM _meta_columns c JOIN {datasets} d ON d.id=c.dataset_id; CREATE TABLE {} AS SELECT c.* FROM _meta_calculated_columns c JOIN {datasets} d ON d.id=c.dataset_id; CREATE TABLE {} AS SELECT d.* FROM _project_directory d JOIN {datasets} m ON m.id=d.id WHERE d.kind='table'; CREATE TABLE {} AS SELECT * FROM _project_settings WHERE key IN (SELECT 'display:'||id FROM {datasets}) OR key IN (SELECT 'filter:'||id FROM {datasets})",quoted(&names[1]),quoted(&names[2]),quoted(&names[3]),quoted(&names[4])))?;
            for (ordinal,dataset) in tables.iter().enumerate() {
                progress(ordinal,tables.len(),&engine.get_dataset_meta(dataset)?.name);
                conn.execute_batch(&format!("CREATE TABLE {} AS SELECT * FROM {}",quoted(&format!("{base}_table_{ordinal}")),quoted(&DuckDbEngine::internal_table_name(dataset))))?;
                conn.execute("INSERT INTO _project_snapshot_tables VALUES (?,?,?)",params![id,dataset,ordinal as u32])?;
            }
            let value=ProjectDataSnapshotDescriptor {id:id.into(),name:name.into(),revision:1,created_at:created_at.into(),table_count:tables.len()};
            ProjectCatalog::new(engine).apply_patch(&ProjectRecordPatch {documents:vec![DocumentWrite {expected_revision:None,document:ProjectDocumentBody {summary:ProjectDocumentSummary {id:id.into(),kind:ProjectDocumentKind::Snapshot,name:name.into(),folder:String::new(),revision:1,dependencies:vec![],analysis_kind:None},schema_version:1,body:serde_json::json!({"id":id,"name":name,"storage":"projectTables","createdAt":created_at,"tableCount":tables.len()})}}],..Default::default()})?;
            Ok(CommitEffects {value,dataset_ids:vec![],document_ids:vec![id.into()],setting_ids:vec![]})
        })?;
        progress(commit.value.table_count,commit.value.table_count,"");
        Ok(commit)
    }

    pub(crate) fn list_data_snapshots(
        &self,
        epoch: u64,
        after: Option<&str>,
        limit: usize,
    ) -> Result<ProjectDataSnapshotPage, AppError> {
        if !(1..=1000).contains(&limit) {
            return Err(invalid("project_page_limit_invalid"));
        }
        self.with_reader(epoch,|engine| {
            let revision=super::project_schema::read_header(engine.conn(),false)?.committed_revision;
            let after=if let Some(cursor)=after {
                let (expected,id):(u64,String)=serde_json::from_str(cursor).map_err(|_|invalid("project_snapshot_cursor_invalid"))?;
                if expected!=revision {return Err(invalid("project_snapshot_cursor_stale"));}id
            } else {String::new()};
            let rows=engine.conn().prepare("SELECT id,revision FROM _project_directory WHERE kind='snapshot' AND id>? ORDER BY id LIMIT ?")?.query_map(params![after,(limit+1) as u64],|r|Ok((r.get::<_,String>(0)?,r.get::<_,u64>(1)?)))?.collect::<Result<Vec<_>,_>>()?;
            let more=rows.len()>limit;
            let items=rows.into_iter().take(limit).map(|(id,revision)|descriptor(engine,&id,revision)).collect::<Result<Vec<_>,_>>()?;
            let next_cursor=if more {items.last().map(|item|serde_json::to_string(&(revision,&item.id))).transpose().map_err(|_|invalid("project_snapshot_cursor_invalid"))?} else {None};
            Ok(ProjectDataSnapshotPage {items,next_cursor,committed_revision:revision})
        })
    }

    pub(crate) fn delete_data_snapshot(
        &self,
        context: &ProjectWriteContext,
        id: &str,
        expected_revision: u64,
    ) -> Result<ProjectCommit<()>, AppError> {
        self.commit_with_effects(
            context,
            &("delete_project_data_snapshot", id, expected_revision),
            |engine| {
                let info = descriptor(engine, id, expected_revision)?;
                let base=storage_prefix(engine,id)?;
                let tables = owned_tables(engine, id)?;
                if tables.len() != info.table_count {
                    return Err(invalid("project_snapshot_table_index_invalid"));
                }
                for name in metadata_names(engine,id)?.into_iter().chain(
                    tables
                        .iter()
                        .map(|(_, ordinal)| format!("{base}_table_{ordinal}")),
                ) {
                    engine
                        .conn()
                        .execute_batch(&format!("DROP TABLE {}", quoted(&name)))?;
                }
                engine.conn().execute(
                    "DELETE FROM _project_snapshot_tables WHERE snapshot_id=?",
                    [id],
                )?;
                ProjectCatalog::new(engine).apply_patch(&ProjectRecordPatch {
                    deleted_document_ids: vec![id.into()],
                    ..Default::default()
                })?;
                Ok(CommitEffects {
                    value: (),
                    dataset_ids: vec![],
                    document_ids: vec![id.into()],
                    setting_ids: vec![],
                })
            },
        )
    }

    #[cfg(any(test, feature="perf-harness"))]
    pub(crate) fn restore_data_snapshot(
        &self,
        context: &ProjectWriteContext,
        id: &str,
        expected_revision: u64,
    ) -> Result<ProjectCommit<ProjectDataSnapshotRestored>, AppError> {
        self.restore_data_snapshot_with_progress(context,id,expected_revision,&|_,_,_|{})
    }

    pub(crate) fn restore_data_snapshot_with_progress(&self,context:&ProjectWriteContext,id:&str,expected_revision:u64,progress:&dyn Fn(usize,usize,&str))->Result<ProjectCommit<ProjectDataSnapshotRestored>,AppError> {
        let commit=self.commit_with_effects(context,&("restore_project_data_snapshot",id,expected_revision),|engine| {
            let base=storage_prefix(engine,id)?;
            let info=descriptor(engine,id,expected_revision)?;
            let tables=owned_tables(engine,id)?;
            if tables.len()!=info.table_count {return Err(invalid("project_snapshot_table_index_invalid"));}
            let conn=engine.conn();let names=metadata_names(engine,id)?;
            let current=engine.list_datasets()?;
            // Retain high-water generations before replacing metadata or dropping history.
            for meta in &current {retain_dataset_generation(engine,&meta.id,meta.generation)?;}
            let retired=super::project_table_lifecycle::discard_for_snapshot(engine)?;
            let all_ids=current.iter().map(|m|m.id.clone()).chain(tables.iter().map(|(id,_)|id.clone())).chain(retired).collect::<std::collections::BTreeSet<_>>();
            let history=conn.prepare("SELECT id FROM _history_change_sets")?.query_map([],|r|r.get::<_,String>(0))?.collect::<Result<Vec<_>,_>>()?;
            for change in history {engine.drop_change_set_in_transaction(&change)?;}
            conn.execute_batch("DELETE FROM _history_dataset_state; DELETE FROM _project_output_events")?;
            for meta in &current {engine.delete_dataset(&meta.id)?;}
            for dataset in &all_ids {conn.execute("DELETE FROM _project_directory WHERE id=? AND kind='table'",[dataset])?;}
            conn.execute_batch(&format!("INSERT INTO _meta_datasets SELECT * FROM {}; INSERT INTO _meta_columns SELECT * FROM {}; INSERT INTO _meta_calculated_columns SELECT * FROM {}",quoted(&names[0]),quoted(&names[1]),quoted(&names[2])))?;
            let mut setting_writes=Vec::new();
            for dataset in &all_ids {
                for key in [format!("display:{dataset}"),format!("filter:{dataset}")] {
                    let old:Option<u64>=conn.query_row("SELECT revision FROM _project_settings WHERE key=?",[&key],|r|r.get(0)).optional()?;
                    let saved:Option<String>=conn.query_row(&format!("SELECT value_json FROM {} WHERE key=?",quoted(&names[4])),[&key],|r|r.get(0)).optional()?;
                    if old.is_some()||saved.is_some() {setting_writes.push(ProjectSettingWrite {key,expected_revision:old,value:saved.map(|s|serde_json::from_str(&s)).transpose().map_err(|_|invalid("project_snapshot_settings_invalid"))?.unwrap_or(serde_json::Value::Null)});}
                }
            }
            let setting_ids=setting_writes.iter().map(|s|s.key.clone()).collect();
            ProjectCatalog::new(engine).apply_patch(&ProjectRecordPatch {settings:setting_writes,..Default::default()})?;
            for (index,(dataset,ordinal)) in tables.iter().enumerate() {
                progress(index,tables.len(),&engine.get_dataset_meta(dataset)?.name);
                conn.execute_batch(&format!("CREATE TABLE {} AS SELECT * FROM {}",quoted(&DuckDbEngine::internal_table_name(dataset)),quoted(&format!("{base}_table_{ordinal}"))))?;
                let original=engine.get_dataset_meta(dataset)?;
                let (retained_generation,old_next,old_revision)=retained_identity(engine,dataset)?;
                let generation=original.generation.max(retained_generation).checked_add(1).ok_or_else(||invalid("project_generation_exhausted"))?;
                conn.execute("UPDATE _meta_datasets SET generation=?,updated_at=CAST(current_timestamp AS VARCHAR),next_row_id=GREATEST(COALESCE(next_row_id,1),COALESCE(?,1)) WHERE id=?",params![generation,old_next,dataset])?;
                engine.rebuild_natural_anchors(dataset,generation)?;
                let folder:String=conn.query_row(&format!("SELECT folder FROM {} WHERE id=?",quoted(&names[3])),[dataset],|r|r.get(0))?;
                ProjectCatalog::new(engine).publish_table(&engine.get_dataset_meta(dataset)?,&folder)?;
                let snapshot_revision:u64=conn.query_row(&format!("SELECT revision FROM {} WHERE id=?",quoted(&names[3])),[dataset],|r|r.get(0))?;
                let revision=old_revision.max(snapshot_revision).checked_add(1).ok_or_else(||invalid("project_revision_exhausted"))?;
                conn.execute("UPDATE _project_directory SET revision=? WHERE id=?",params![revision,dataset])?;
            }
            Ok(CommitEffects {value:ProjectDataSnapshotRestored {kind:"dataSnapshotRestored".into(),snapshot_id:id.into(),table_history_reset:true,table_count:tables.len()},dataset_ids:tables.iter().map(|(id,_)|id.clone()).collect(),document_ids:all_ids.into_iter().collect(),setting_ids})
        })?;
        progress(commit.value.table_count,commit.value.table_count,"");
        Ok(commit)
    }
}

#[cfg(test)]
mod tests {
    use crate::{
        models::project_persistence::ProjectWriteContext,
        services::{project_catalog::ProjectCatalog, project_database::ProjectDatabase},
    };
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
    fn project_v5_named_snapshot_progress_finishes_only_after_commit() {
        let dir=tempfile::tempdir().unwrap();let db=ProjectDatabase::create(&dir.path().join("progress.spprj"),false).unwrap();
        db.with_engine(|engine| {engine.create_empty_table("table","Table",&["A".into()],&["DOUBLE".into()])?;ProjectCatalog::new(engine).publish_table(&engine.get_dataset_meta("table")?,"")}).unwrap();
        let events=std::cell::RefCell::new(Vec::new());let progress=|index,total,name:&str|events.borrow_mut().push((index,total,name.to_string()));
        let id=uuid::Uuid::new_v4().to_string();
        db.capture_data_snapshot_with_progress(&context(&db,"capture",0),&id,"Progress","2026-10-21T00:00:00Z",&progress).unwrap();
        assert_eq!(*events.borrow(),vec![(0,1,"Table".to_string()),(1,1,String::new())]);events.borrow_mut().clear();
        db.restore_data_snapshot_with_progress(&context(&db,"restore",1),&id,1,&progress).unwrap();
        assert_eq!(*events.borrow(),vec![(0,1,"Table".to_string()),(1,1,String::new())]);events.borrow_mut().clear();
        crate::services::project_transaction::inject_commit_failure_for_test(1);
        assert!(db.capture_data_snapshot_with_progress(&context(&db,"failed",2),&uuid::Uuid::new_v4().to_string(),"Failed","2026-10-21T00:00:00Z",&progress).is_err());
        assert_eq!(*events.borrow(),vec![(0,1,"Table".to_string())],"a rolled-back snapshot cannot report completion");
    }

    #[test]
    #[cfg(feature="project-v5")]
    fn project_v5_named_snapshot_restores_formulas_natural_order_and_settings() {
        use crate::{state::AppState,services::{project_native_service::NativeProjectService,calculated_column_service::UpsertCalculatedColumnInput},models::{project_persistence::DatasetGeneration,table::CellUpdate}};
        let dir=tempfile::tempdir().unwrap();let path=dir.path().join("formulas-snapshot.spprj");let db=ProjectDatabase::create(&path,false).unwrap();
        db.with_engine(|engine| {engine.create_empty_table("table","Table",&["A".into()],&["DOUBLE".into()])?;engine.conn().execute("INSERT INTO dataset_table (_row_id,_row_order,A) VALUES (1,10,2),(2,5,3)",[])?;engine.conn().execute("UPDATE _meta_datasets SET row_count=2,next_row_id=3 WHERE id='table'",[])?;engine.rebuild_natural_anchors("table",0)?;ProjectCatalog::new(engine).publish_table(&engine.get_dataset_meta("table")?,"Data")}).unwrap();db.prepare_close(db.epoch()).unwrap();
        let state=AppState::new().unwrap();let service=NativeProjectService::new(&state);let opened=service.open(&path,false).unwrap();let active=service.database(opened.epoch).unwrap();
        let mut write=context(&active,"formula",0);write.dataset_generations=vec![DatasetGeneration{id:"table".into(),generation:0}];
        service.upsert_calculated_column(&write,&UpsertCalculatedColumnInput {dataset_id:"table".into(),output_name:"Twice".into(),formula_text:"[A] * 2".into(),at_index:None,output_column_id:None,formula_id:None,expected_generation:Some(0)}).unwrap();
        active.commit_records(&context(&active,"settings",1),&crate::models::project_persistence::ProjectRecordPatch {settings:vec![crate::models::project_persistence::ProjectSettingWrite {key:"display:table".into(),expected_revision:None,value:serde_json::json!([{"colIndex":0,"width":123}])},crate::models::project_persistence::ProjectSettingWrite {key:"filter:table".into(),expected_revision:None,value:serde_json::json!([{"id":"filter","op":"AND","rule":{"kind":"continuous","field":{"name":"A","type":"continuous"},"min":1,"max":null}}])}],..Default::default()}).unwrap();
        let id=uuid::Uuid::new_v4().to_string();active.capture_data_snapshot(&context(&active,"capture",2),&id,"Formula snapshot","2026-10-21T00:00:00Z").unwrap();
        write=context(&active,"rename",3);write.dataset_generations=vec![DatasetGeneration{id:"table".into(),generation:1}];service.alter_column(&write,"table","A","Renamed","DOUBLE",1).unwrap();
        write=context(&active,"change",4);write.dataset_generations=vec![DatasetGeneration{id:"table".into(),generation:2}];service.update_cells(&write,"table",&[CellUpdate {row_id:1,column_name:"Renamed".into(),value:Some("42".into())}],Some(2)).unwrap();
        active.restore_data_snapshot(&context(&active,"restore",5),&id,1).unwrap();
        let generation=active.with_reader(active.epoch(),|engine| {
            let rows=engine.conn().prepare(&format!("SELECT _row_id,A,Twice FROM dataset_table ORDER BY {},_row_id",crate::engine::duckdb_engine::NATURAL_ORDER_SQL))?.query_map([],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,f64>(1)?,r.get::<_,f64>(2)?)))?.collect::<Result<Vec<_>,_>>()?;assert_eq!(rows,vec![(2,3.0,6.0),(1,2.0,4.0)]);
            assert!(engine.get_table_column_descriptors("table")?[1].calculated.is_some());assert_eq!(super::super::project_column_settings::read(engine,"table")?[0].width,Some(123.0));
            let filters=ProjectCatalog::new(engine).get_setting("filter:table")?.unwrap().1;assert_eq!(filters[0]["rule"]["field"]["name"],"A");
            let history:i64=engine.conn().query_row("SELECT COUNT(*) FROM _history_timeline",[],|r|r.get(0))?;assert_eq!(history,0);Ok(engine.get_dataset_meta("table")?.generation)
        }).unwrap();
        write=context(&active,"edit-restored-formula",6);write.dataset_generations=vec![DatasetGeneration{id:"table".into(),generation}];service.update_cells(&write,"table",&[CellUpdate {row_id:1,column_name:"A".into(),value:Some("5".into())}],Some(generation)).unwrap();
        active.with_reader(active.epoch(),|engine| {let twice:f64=engine.conn().query_row("SELECT Twice FROM dataset_table WHERE _row_id=1",[],|r|r.get(0))?;assert_eq!(twice,10.0);Ok(())}).unwrap();
    }

    #[test]
    fn project_v5_named_snapshot_lists_in_read_only_newer_writer_file() {
        let dir=tempfile::tempdir().unwrap();let path=dir.path().join("readonly-snapshot.spprj");let db=ProjectDatabase::create(&path,false).unwrap();
        let id=uuid::Uuid::new_v4().to_string();db.capture_data_snapshot(&context(&db,"capture",0),&id,"Empty","2026-10-21T00:00:00Z").unwrap();
        db.with_engine(|engine| {engine.conn().execute("UPDATE _project_header SET minimum_writer=2",[])?;Ok(())}).unwrap();db.prepare_close(db.epoch()).unwrap();
        let reader=ProjectDatabase::open(&path,true).unwrap();assert_eq!(reader.list_data_snapshots(reader.epoch(),None,1).unwrap().items[0].id,id);
        assert!(reader.capture_data_snapshot(&context(&reader,"forbidden",1),&uuid::Uuid::new_v4().to_string(),"Forbidden","2026-10-21T00:00:00Z").is_err());
    }

    #[test]
    #[cfg(feature="project-v5")]
    fn project_v5_named_snapshot_recreates_deleted_table_with_identity_watermarks() {
        use crate::{state::AppState,services::project_native_service::NativeProjectService,models::project_persistence::DatasetGeneration};
        let dir=tempfile::tempdir().unwrap();let path=dir.path().join("deleted-snapshot.spprj");let db=ProjectDatabase::create(&path,false).unwrap();
        db.with_engine(|engine| {engine.create_empty_table("table","Table",&["A".into()],&["DOUBLE".into()])?;engine.conn().execute("INSERT INTO dataset_table (_row_id,A) VALUES (5,1)",[])?;engine.conn().execute("UPDATE _meta_datasets SET row_count=1,next_row_id=6 WHERE id='table'",[])?;engine.rebuild_natural_anchors("table",0)?;ProjectCatalog::new(engine).publish_table(&engine.get_dataset_meta("table")?,"")}).unwrap();
        let id=uuid::Uuid::new_v4().to_string();db.capture_data_snapshot(&context(&db,"capture",0),&id,"Saved table","2026-10-21T00:00:00Z").unwrap();
        db.with_engine(|engine| {engine.conn().execute("UPDATE _meta_datasets SET generation=30,next_row_id=500 WHERE id='table'",[])?;engine.conn().execute("UPDATE _project_directory SET revision=40 WHERE id='table'",[])?;Ok(())}).unwrap();db.prepare_close(db.epoch()).unwrap();
        let state=AppState::new().unwrap();let service=NativeProjectService::new(&state);let opened=service.open(&path,false).unwrap();
        let write=ProjectWriteContext {operation_id:"delete-table".into(),expected_project_id:opened.header.project_id,expected_epoch:opened.epoch,expected_revision:1,request_digest:String::new(),document_revisions:vec![],dataset_generations:vec![DatasetGeneration {id:"table".into(),generation:30}]};
        service.delete_dataset(&write,"table").unwrap();service.close(opened.epoch).unwrap();
        let reopened=ProjectDatabase::open(&path,false).unwrap();
        let event_id:String=reopened.with_reader(reopened.epoch(),|engine|Ok(engine.conn().query_row("SELECT id FROM _project_table_lifecycle_events WHERE dataset_id='table'",[],|row|row.get(0))?)).unwrap();
        let restore=context(&reopened,"restore",2);
        crate::services::project_transaction::inject_commit_failure_for_test(1);
        assert!(reopened.restore_data_snapshot(&restore,&id,1).is_err());
        reopened.with_reader(reopened.epoch(),|engine| {assert!(engine.get_dataset_meta("table").is_err());assert!(super::super::project_table_lifecycle::get_event(engine,&event_id)?.is_some());Ok(())}).unwrap();
        reopened.restore_data_snapshot(&restore,&id,1).unwrap();
        reopened.with_reader(reopened.epoch(),|engine| {assert!(super::super::project_table_lifecycle::get_event(engine,&event_id)?.is_none());let retired:usize=engine.conn().query_row("SELECT COUNT(*) FROM _project_retired_datasets",[],|row|row.get(0))?;assert_eq!(retired,0);Ok(())}).unwrap();
        reopened.with_reader(reopened.epoch(),|engine| {assert_eq!(engine.get_dataset_meta("table")?.generation,31);let next:i64=engine.conn().query_row("SELECT next_row_id FROM _meta_datasets WHERE id='table'",[],|r|r.get(0))?;assert!(next>=500);assert_eq!(ProjectCatalog::new(engine).summary("table")?.revision,41);Ok(())}).unwrap();
    }

    #[cfg(feature="project-v5")]
    #[test]
    fn project_v5_named_snapshot_empty_restore_discards_hidden_lifecycle_storage() {
        use crate::{state::AppState,services::project_native_service::NativeProjectService,models::project_persistence::DatasetGeneration};
        let root=tempfile::tempdir().unwrap();let path=root.path().join("empty-hidden.spprj");let db=ProjectDatabase::create(&path,false).unwrap();
        let snapshot=uuid::Uuid::new_v4().to_string();db.capture_data_snapshot(&context(&db,"empty",0),&snapshot,"Empty","today").unwrap();
        let created=db.materialize_project_sql(&context(&db,"source",1),&crate::services::project_output::ProjectSqlOutput{name:"Later".into(),sql:"SELECT 9007199254740993::BIGINT AS value".into(),folder:String::new()}).unwrap();
        db.shutdown().unwrap();let state=AppState::new().unwrap();let service=NativeProjectService::new(&state);let opened=service.open(&path,false).unwrap();
        let write=ProjectWriteContext{operation_id:"hide".into(),expected_project_id:opened.header.project_id,expected_epoch:opened.epoch,expected_revision:2,request_digest:String::new(),document_revisions:vec![],dataset_generations:vec![DatasetGeneration{id:created.value.id.clone(),generation:0}]};
        let deleted=service.delete_dataset(&write,&created.value.id).unwrap();let event=deleted.changed_history_entries[0].id.clone();
        let database=service.database(opened.epoch).unwrap();database.restore_data_snapshot(&ProjectWriteContext{operation_id:"restore-empty".into(),expected_revision:3,dataset_generations:vec![],..write},&snapshot,1).unwrap();
        database.with_reader(opened.epoch,|engine| {
            assert!(engine.list_datasets()?.is_empty());assert!(super::super::project_table_lifecycle::get_event(engine,&event)?.is_none());
            let physical=crate::engine::duckdb_engine::DuckDbEngine::internal_table_name(&created.value.id);
            let remains:bool=engine.conn().query_row("SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name=?)",[physical],|row|row.get(0))?;assert!(!remains);
            assert!(ProjectCatalog::new(engine).list_history(&crate::models::project_persistence::HistoryPageRequest{dataset_id:None,after:None,limit:200})?.items.is_empty());Ok(())
        }).unwrap();
    }

    #[test]
    fn project_v5_named_snapshot_retains_native_data_without_frontend_rows() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("named.spprj");
        let db = ProjectDatabase::create(&path, false).unwrap();
        db.with_engine(|engine| {
            engine.create_empty_table("table","Original",&["Amount".into(),"Label".into()],&["DECIMAL(30,6)".into(),"VARCHAR".into()])?;
            engine.conn().execute("INSERT INTO dataset_table (_row_id,Amount,Label) VALUES (7,123456789012345678901234.123456,'keep'),(2,NULL,'second')",[])?;
            engine.conn().execute("UPDATE _meta_datasets SET row_count=2,next_row_id=8 WHERE id='table'",[])?;
            engine.rebuild_natural_anchors("table",0)?;
            ProjectCatalog::new(engine).publish_table(&engine.get_dataset_meta("table")?,"Data")
        }).unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let capture = context(&db, "capture", 0);
        crate::services::project_transaction::inject_commit_failure_for_test(2);
        assert!(db
            .capture_data_snapshot(&capture, &id, "Checkpoint", "2026-10-21T00:00:00Z")
            .is_err());
        let saved = db
            .capture_data_snapshot(&capture, &id, "Checkpoint", "2026-10-21T00:00:00Z")
            .unwrap();
        assert_eq!(saved.value.table_count, 1);
        let json = serde_json::to_value(&saved).unwrap();
        assert!(json["value"].get("rows").is_none());
        assert!(json["value"].get("datasets").is_none());
        let replay = db
            .capture_data_snapshot(&capture, &id, "Checkpoint", "2026-10-21T00:00:00Z")
            .unwrap();
        assert_eq!(replay.committed_revision, saved.committed_revision);
        db.with_engine(|engine| {
            engine
                .conn()
                .execute("UPDATE dataset_table SET Amount=9,Label='changed'", [])?;
            engine.conn().execute(
                "UPDATE _meta_datasets SET generation=9,next_row_id=100 WHERE id='table'",
                [],
            )?;
            engine.conn().execute(
                "UPDATE _project_directory SET revision=50 WHERE id='table'",
                [],
            )?;
            Ok(())
        })
        .unwrap();
        db.prepare_close(db.epoch()).unwrap();
        let reopened = ProjectDatabase::open(&path, false).unwrap();
        let descriptor = reopened
            .list_data_snapshots(reopened.epoch(), None, 1)
            .unwrap();
        assert_eq!(descriptor.items.len(), 1);
        assert_eq!(descriptor.items[0].id, id);
        assert!(descriptor.next_cursor.is_none());
        crate::services::project_transaction::inject_commit_failure_for_test(1);
        assert!(reopened
            .restore_data_snapshot(
                &context(&reopened, "restore", saved.committed_revision),
                &id,
                1
            )
            .is_err());
        reopened
            .with_reader(reopened.epoch(), |engine| {
                let label: String = engine.conn().query_row(
                    "SELECT Label FROM dataset_table WHERE _row_id=7",
                    [],
                    |r| r.get(0),
                )?;
                assert_eq!(label, "changed");
                assert_eq!(engine.get_dataset_meta("table")?.generation, 9);
                Ok(())
            })
            .unwrap();
        let restore = reopened
            .restore_data_snapshot(
                &context(&reopened, "restore", saved.committed_revision),
                &id,
                1,
            )
            .unwrap();
        assert!(restore.value.table_history_reset);
        reopened
            .with_reader(reopened.epoch(), |engine| {
                let values = engine
                    .conn()
                    .prepare(
                        "SELECT CAST(Amount AS VARCHAR),Label FROM dataset_table ORDER BY _row_id",
                    )?
                    .query_map([], |r| {
                        Ok((r.get::<_, Option<String>>(0)?, r.get::<_, String>(1)?))
                    })?
                    .collect::<Result<Vec<_>, _>>()?;
                assert_eq!(
                    values,
                    vec![
                        (None, "second".into()),
                        (
                            Some("123456789012345678901234.123456".into()),
                            "keep".into()
                        )
                    ]
                );
                assert!(engine.get_dataset_meta("table")?.generation > 9);
                let next: i64 = engine.conn().query_row(
                    "SELECT next_row_id FROM _meta_datasets WHERE id='table'",
                    [],
                    |r| r.get(0),
                )?;
                assert!(
                    next >= 100,
                    "restoring a snapshot cannot reuse later row IDs"
                );
                assert!(
                    ProjectCatalog::new(engine).summary("table")?.revision > 50,
                    "table directory revisions must remain monotonic"
                );
                assert_eq!(engine.get_dataset_meta("table")?.row_count, 2);
                Ok(())
            })
            .unwrap();
        let deleted = reopened
            .delete_data_snapshot(
                &context(&reopened, "delete", restore.committed_revision),
                &id,
                1,
            )
            .unwrap();
        assert!(deleted.deleted_directory_ids.contains(&id));
        assert!(reopened
            .list_data_snapshots(reopened.epoch(), None, 10)
            .unwrap()
            .items
            .is_empty());
    }
}
