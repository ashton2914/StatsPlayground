//! Cross-table lifecycle manifests and event-owned connector before-images.
use std::collections::{BTreeMap,BTreeSet};
use duckdb::{params,OptionalExt};
use serde_json::Value;
use crate::{engine::duckdb_engine::DuckDbEngine,error::AppError,models::{project_persistence::*,project_topology::*}};
use super::{project_catalog::ProjectCatalog,project_table_lifecycle::{self as lifecycle,LifecycleEvent},project_table_retirement as retirement,project_transaction::CommitEffects};
fn invalid(code:&str)->AppError{AppError::InvalidParam(code.into())}
fn exists(engine:&DuckDbEngine)->Result<bool,AppError>{Ok(engine.conn().query_row("SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name='_project_cascade_members')",[],|r|r.get(0))?)}
fn storage(engine:&DuckDbEngine)->Result<(),AppError>{
    engine.conn().execute_batch("CREATE TABLE IF NOT EXISTS _project_cascade_members(root_id VARCHAR NOT NULL,ordinal UINTEGER NOT NULL,event_id VARCHAR NOT NULL UNIQUE,PRIMARY KEY(root_id,ordinal));
    CREATE TABLE IF NOT EXISTS _project_cascade_connectors(root_id VARCHAR NOT NULL,id VARCHAR NOT NULL,kind VARCHAR NOT NULL,name VARCHAR NOT NULL,folder VARCHAR NOT NULL,revision UBIGINT NOT NULL,dependencies_json VARCHAR NOT NULL,schema_version UINTEGER NOT NULL,body_json VARCHAR NOT NULL,PRIMARY KEY(root_id,id));
    CREATE TABLE IF NOT EXISTS _project_cascade_settings(root_id VARCHAR NOT NULL,key VARCHAR NOT NULL,value_json VARCHAR NOT NULL,tombstone_revision UBIGINT NOT NULL,PRIMARY KEY(root_id,key));
    CREATE TABLE IF NOT EXISTS _project_cascade_lineage(root_id VARCHAR PRIMARY KEY,nodes_json VARCHAR NOT NULL,edges_json VARCHAR NOT NULL)")?;Ok(())
}
pub(crate) fn visible(engine:&DuckDbEngine,alias:&str)->Result<String,AppError>{
    Ok(if exists(engine)?{format!("NOT EXISTS(SELECT 1 FROM _project_cascade_members g WHERE g.event_id={alias}.id AND g.root_id<>g.event_id)")}else{"TRUE".into()})
}
pub(crate) fn discard(engine:&DuckDbEngine,event_id:&str)->Result<(),AppError>{
    if !exists(engine)?{return Ok(());}
    let root:Option<String>=engine.conn().query_row("SELECT root_id FROM _project_cascade_members WHERE event_id=?",[event_id],|r|r.get(0)).optional()?;
    if let Some(root)=root {for table in ["_project_cascade_connectors","_project_cascade_settings","_project_cascade_lineage","_project_cascade_members"]{engine.conn().execute(&format!("DELETE FROM {table} WHERE root_id=?"),[&root])?;}}Ok(())
}
pub(crate) fn discard_all(engine:&DuckDbEngine)->Result<(),AppError>{
    if exists(engine)?{for table in ["_project_cascade_connectors","_project_cascade_settings","_project_cascade_lineage","_project_cascade_members"]{engine.conn().execute_batch(&format!("DELETE FROM {table}"))?;}}Ok(())
}
/// Used for confirmation and authorization; external references never silently break.
pub(crate) fn preview(engine:&DuckDbEngine,epoch:u64,table_id:&str,scope:ProjectActionScope)->Result<ProjectActionPreview,AppError>{
    action_preview(engine,epoch,table_id,scope,scope==ProjectActionScope::Descendants)
}
fn action_preview(engine:&DuckDbEngine,epoch:u64,table_id:&str,scope:ProjectActionScope,check_references:bool)->Result<ProjectActionPreview,AppError>{
    let topology=super::project_topology::read_topology(engine,epoch)?;let mut result=topology.preview(table_id,scope)?;
    if check_references {
        let removed:BTreeSet<_>=result.table_ids.iter().chain(&result.transform_ids).chain(&result.owned_document_ids).map(String::as_str).collect();
        let mut after=None;
        loop{let page=ProjectCatalog::new(engine).list(&CatalogPageRequest{after,limit:1000})?;for item in page.items {
            if !removed.contains(item.id.as_str())&&item.kind!=ProjectDocumentKind::Folder&&item.dependencies.iter().any(|d|removed.contains(d.as_str())){result.blockers.push(ProjectTopologyDiagnostic{code:"project_deletion_external_reference".into(),id:item.id});}
        }after=page.next_cursor;if after.is_none(){break;}}
        // Workflow runtime bindings are settings, not necessarily catalog dependencies.
        let mut stmt=engine.conn().prepare("SELECT key,CAST(json_extract(value_json,'$..tableDocumentId') AS VARCHAR) FROM _project_settings WHERE starts_with(key,'workflowBinding:') AND value_json<>'null'")?;
        let bindings=stmt.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,Option<String>>(1)?)))?.collect::<Result<Vec<_>,_>>()?;
        for (key,ids) in bindings {if let Some(ids)=ids {let values:Vec<Value>=serde_json::from_str(&ids).map_err(|_|invalid("project_workflow_binding_invalid"))?;if values.iter().filter_map(Value::as_str).any(|id|removed.contains(id)){result.blockers.push(ProjectTopologyDiagnostic{code:"project_deletion_external_reference".into(),id:key});}}}
    }
    Ok(result)
}
fn order(topology:&ProjectTopology,ids:&[String])->Result<Vec<String>,AppError>{
    let mut degree:BTreeMap<_,usize>=ids.iter().map(|id|(id.clone(),0)).collect();let mut next:BTreeMap<String,BTreeSet<String>>=BTreeMap::new();
    for t in &topology.transforms {for input in &t.inputs {if degree.contains_key(&input.table_id)&&degree.contains_key(&t.output_table_id)&&next.entry(input.table_id.clone()).or_default().insert(t.output_table_id.clone()){*degree.get_mut(&t.output_table_id).unwrap()+=1;}}}
    let mut ready:BTreeSet<_>=degree.iter().filter(|(_,n)|**n==0).map(|(id,_)|id.clone()).collect();let mut ordered=vec![];
    while let Some(id)=ready.pop_first(){if let Some(children)=next.get(&id){for child in children{let n=degree.get_mut(child).unwrap();*n-=1;if *n==0{ready.insert(child.clone());}}}ordered.push(id);}
    if ordered.len()!=ids.len(){return Err(invalid("project_transform_cycle"));}Ok(ordered)
}
fn filter_lineage(value:&mut Value,removed:&BTreeSet<String>)->(Vec<Value>,Vec<Value>){
    let mut node_ids=BTreeSet::new();let mut nodes=vec![];let mut edges=vec![];
    if let Some(all)=value.get_mut("nodes").and_then(Value::as_array_mut){all.retain(|node|{
        let drop=node.pointer("/documentRef/id").and_then(Value::as_str).is_some_and(|id|removed.contains(id));
        if drop{if let Some(id)=node.get("id").and_then(Value::as_str){node_ids.insert(id.to_string());}nodes.push(node.clone());}!drop
    });}
    if let Some(all)=value.get_mut("edges").and_then(Value::as_array_mut){all.retain(|edge|{
        let drop=["/source/nodeId","/target/nodeId"].iter().any(|p|edge.pointer(p).and_then(Value::as_str).is_some_and(|id|node_ids.contains(id)));
        if drop{edges.push(edge.clone());}!drop
    });}
    if let Some(fields)=value.as_object_mut(){fields.insert("graphHash".into(),Value::String(String::new()));}(nodes,edges)
}
/// Capture only removed connectors and lineage fragments; unrelated lineage is never overwritten.
fn retire_connectors(engine:&DuckDbEngine,root:&str,preview:&ProjectActionPreview)->Result<(Vec<String>,Vec<String>),AppError>{
    storage(engine)?;for table in ["_project_cascade_connectors","_project_cascade_settings","_project_cascade_lineage"]{engine.conn().execute(&format!("DELETE FROM {table} WHERE root_id=?"),[root])?;}
    let catalog=ProjectCatalog::new(engine);let mut settings=vec![];let mut writes=vec![];
    for id in &preview.transform_ids {
        engine.conn().execute("INSERT INTO _project_cascade_connectors SELECT ?,d.*,b.schema_version,b.body_json FROM _project_directory d JOIN _project_documents b ON b.id=d.id AND b.revision=d.revision WHERE d.id=?",params![root,id])?;
        let key=format!("transformBinding:{id}");let (revision,value)=catalog.get_setting(&key)?.ok_or_else(||invalid("project_transform_binding_missing"))?;
        engine.conn().execute("INSERT INTO _project_cascade_settings VALUES(?,?,?,?)",params![root,&key,value.to_string(),revision+1])?;
        writes.push(ProjectSettingWrite{key:key.clone(),expected_revision:Some(revision),value:Value::Null});settings.push(key);
    }
    let removed:BTreeSet<_>=preview.table_ids.iter().chain(&preview.transform_ids).chain(&preview.owned_document_ids).cloned().collect();
    if let Some((revision,mut value))=catalog.get_setting("lineage")?.filter(|(_,v)|!v.is_null()){
        let (nodes,edges)=filter_lineage(&mut value,&removed);
        engine.conn().execute("INSERT INTO _project_cascade_lineage VALUES(?,?,?)",params![root,serde_json::to_string(&nodes).unwrap(),serde_json::to_string(&edges).unwrap()])?;
        writes.push(ProjectSettingWrite{key:"lineage".into(),expected_revision:Some(revision),value});settings.push("lineage".into());
    }
    catalog.apply_patch(&ProjectRecordPatch{deleted_document_ids:preview.transform_ids.clone(),settings:writes,..Default::default()})?;
    Ok((preview.transform_ids.clone(),settings))
}
fn restore_connectors(engine:&DuckDbEngine,root:&str)->Result<(Vec<String>,Vec<String>),AppError>{
    let catalog=ProjectCatalog::new(engine);let mut docs=vec![];let mut settings=vec![];
    let rows=engine.conn().prepare("SELECT id,kind,name,folder,revision,dependencies_json,schema_version,body_json FROM _project_cascade_connectors WHERE root_id=? ORDER BY id")?.query_map([root],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,u64>(4)?,r.get::<_,String>(5)?,r.get::<_,u32>(6)?,r.get::<_,String>(7)?)))?.collect::<Result<Vec<_>,_>>()?;
    for (id,kind,name,folder,revision,deps,schema,body) in rows {
        let conflict:bool=engine.conn().query_row("SELECT EXISTS(SELECT 1 FROM _project_directory WHERE id=? OR (kind=? AND lower(name)=lower(?) AND folder=?))",params![&id,&kind,&name,&folder],|r|r.get(0))?;if conflict{return Err(invalid("project_retired_directory_conflict"));}
        let retained:Option<u64>=engine.conn().query_row("SELECT revision FROM _project_document_revision_watermarks WHERE id=?",[&id],|r|r.get(0)).optional()?;let next=revision.max(retained.unwrap_or(0)).checked_add(1).ok_or_else(||invalid("project_revision_exhausted"))?;
        engine.conn().execute("INSERT INTO _project_directory VALUES(?,?,?,?,?,?)",params![&id,&kind,&name,&folder,next,&deps])?;engine.conn().execute("INSERT INTO _project_documents VALUES(?,?,?,?)",params![&id,next,schema,&body])?;
        engine.conn().execute("INSERT INTO _project_document_revision_watermarks VALUES(?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision",params![&id,next])?;docs.push(id);
    }
    let rows=engine.conn().prepare("SELECT key,value_json,tombstone_revision FROM _project_cascade_settings WHERE root_id=? ORDER BY key")?.query_map([root],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,u64>(2)?)))?.collect::<Result<Vec<_>,_>>()?;
    let mut writes=vec![];
    for (key,json,tombstone) in rows {let current=catalog.get_setting(&key)?.ok_or_else(||invalid("project_setting_revision_stale"))?;if current.0!=tombstone||!current.1.is_null(){return Err(invalid("project_setting_revision_stale"));}
        writes.push(ProjectSettingWrite{key:key.clone(),expected_revision:Some(tombstone),value:serde_json::from_str(&json).map_err(|_|invalid("project_cascade_metadata_invalid"))?});settings.push(key);
    }
    let lineage:Option<(String,String)>=engine.conn().query_row("SELECT nodes_json,edges_json FROM _project_cascade_lineage WHERE root_id=?",[root],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
    if let Some((nodes,edges))=lineage {
        let old=catalog.get_setting("lineage")?;let mut value=old.as_ref().map(|(_,v)|v.clone()).unwrap_or_else(||serde_json::json!({"id":"project-lineage","name":"Project lineage","graphVersion":2,"nodes":[],"edges":[]}));
        for (field,json) in [("nodes",nodes),("edges",edges)]{
            let saved:Vec<Value>=serde_json::from_str(&json).map_err(|_|invalid("project_cascade_metadata_invalid"))?;
            let all=value.get_mut(field).and_then(Value::as_array_mut).ok_or_else(||invalid("project_lineage_invalid"))?;
            for item in saved{if all.iter().any(|n|n.get("id")==item.get("id")){return Err(invalid("project_lineage_restore_conflict"));}all.push(item);}
        }
        value.as_object_mut().ok_or_else(||invalid("project_lineage_invalid"))?.insert("graphHash".into(),Value::String(String::new()));
        writes.push(ProjectSettingWrite{key:"lineage".into(),expected_revision:old.map(|(r,_)|r),value});settings.push("lineage".into());
    }
    catalog.apply_patch(&ProjectRecordPatch{settings:writes,..Default::default()})?;Ok((docs,settings))
}
/// A fresh copied/imported component is one public creation action, not N partial undos.
pub(crate) fn group_creations(engine:&DuckDbEngine,topology:&ProjectTopology,tables:&[String],events:&[LifecycleEvent])->Result<(),AppError>{
    let ordered=order(topology,tables)?;let root=events.iter().find(|e|Some(&e.dataset_id)==ordered.first()).ok_or_else(||invalid("project_cascade_metadata_missing"))?;storage(engine)?;
    for (ordinal,table) in ordered.iter().enumerate(){let event=events.iter().find(|e|e.dataset_id==*table).ok_or_else(||invalid("project_cascade_metadata_missing"))?;engine.conn().execute("INSERT INTO _project_cascade_members VALUES(?,?,?)",params![&root.id,ordinal as u32,&event.id])?;}Ok(())
}
pub(crate) fn delete_cascade(engine:&DuckDbEngine,epoch:u64,table_id:&str)->Result<CommitEffects<()>,AppError>{
    let preview=preview(engine,epoch,table_id,ProjectActionScope::Descendants)?;if !preview.blockers.is_empty(){return Err(AppError::InvalidParam(format!("project_deletion_external_reference: {}",preview.blockers.iter().map(|b|b.id.as_str()).collect::<Vec<_>>().join(", "))));}
    let topology=super::project_topology::read_topology(engine,epoch)?;let ordered=order(&topology,&preview.table_ids)?;
    let mut events=BTreeMap::new();let mut docs=vec![];let mut settings=vec![];
    for id in ordered.iter().rev(){lifecycle::retire_storage(engine,id)?;let event=lifecycle::record_deletion(engine,id)?;let effects=retirement::retire_metadata(engine,&event)?;docs.extend(effects.document_ids);settings.extend(effects.setting_ids);events.insert(id.clone(),event);}
    let root=&events[table_id].id;storage(engine)?;
    for (ordinal,id) in ordered.iter().enumerate(){engine.conn().execute("INSERT INTO _project_cascade_members VALUES(?,?,?)",params![root,ordinal as u32,&events[id].id])?;}
    let (connectors,binding_settings)=retire_connectors(engine,root,&preview)?;docs.extend(connectors);settings.extend(binding_settings);
    Ok(CommitEffects{value:(),dataset_ids:vec![],document_ids:docs,setting_ids:settings})
}
pub(crate) fn replay(engine:&DuckDbEngine,context:&ProjectWriteContext,event:&LifecycleEvent,undo:bool)->Result<Option<CommitEffects<()>>,AppError>{
    let root=if exists(engine)?{engine.conn().query_row("SELECT root_id FROM _project_cascade_members WHERE event_id=?",[&event.id],|r|r.get::<_,String>(0)).optional()?}else{None};
    if root.as_ref().is_some_and(|id|*id!=event.id){return Err(invalid("project_cascade_child_not_public"));}
    let activate=(event.operation=="delete_table")==undo;
    // Undoing a Transform output creation retires its producing connector too.
    if root.is_none()&&!activate&&event.operation=="create_table" {
        let preview=preview(engine,context.expected_epoch,&event.dataset_id,ProjectActionScope::Descendants)?;
        if preview.table_ids.len()>1{return Err(invalid("project_dependency_undo_order"));}
        if preview.transform_ids.is_empty(){return Ok(None);}
        if !preview.blockers.is_empty(){return Err(invalid("project_deletion_external_reference"));}
        storage(engine)?;engine.conn().execute("INSERT INTO _project_cascade_members VALUES (?,0,?)",params![&event.id,&event.id])?;
    }else if root.is_none(){return Ok(None);}
    let ids=engine.conn().prepare("SELECT event_id FROM _project_cascade_members WHERE root_id=? ORDER BY ordinal")?.query_map([&event.id],|r|r.get::<_,String>(0))?.collect::<Result<Vec<_>,_>>()?;
    let mut events=vec![];for id in ids{let member=lifecycle::get_event(engine,&id)?.ok_or_else(||invalid("project_lifecycle_event_missing"))?;events.push(lifecycle::authorize_replay(engine,&id,member.revision,undo)?);}
    if events.is_empty(){return Err(invalid("project_cascade_metadata_missing"));}
    let mut docs=vec![];let mut settings=vec![];let mut datasets=vec![];
    if activate {
        for member in &events{lifecycle::restore_storage(engine,&member.dataset_id)?;let effects=retirement::restore_metadata(engine,member)?;docs.extend(effects.document_ids);settings.extend(effects.setting_ids);datasets.push(member.dataset_id.clone());}
        let (connectors,binding_settings)=restore_connectors(engine,&event.id)?;docs.extend(connectors);settings.extend(binding_settings);
        let topology=super::project_topology::read_topology(engine,context.expected_epoch)?;
        if !topology.diagnostics.is_empty(){return Err(invalid("project_cascade_parent_missing"));}
        let component=topology.preview(&event.dataset_id,ProjectActionScope::Component)?;
        let restored:BTreeSet<_>=events.iter().map(|e|e.dataset_id.as_str()).chain(docs.iter().map(String::as_str)).collect();
        let members:Vec<_>=component.table_ids.iter().chain(&component.transform_ids).chain(&component.owned_document_ids).collect();
        let catalog=ProjectCatalog::new(engine);
        let survivors=members.iter().filter(|id|!restored.contains(id.as_str())).map(|id|Ok(catalog.summary(id)?.folder)).collect::<Result<BTreeSet<_>,AppError>>()?;
        if survivors.len()>1{return Err(invalid("project_group_folder_conflict"));}
        if let Some(folder)=survivors.iter().next(){
            let moves=members.iter().filter(|id|restored.contains(id.as_str())).map(|id|{let s=catalog.summary(id)?;Ok((s.folder!=*folder).then(||DirectoryMove{id:(*id).clone(),expected_revision:s.revision,folder:folder.clone(),name:None}))}).collect::<Result<Vec<_>,AppError>>()?.into_iter().flatten().collect();
            catalog.apply_patch(&ProjectRecordPatch{directory_moves:moves,..Default::default()})?;
        }
    }else{
        let scope=if event.operation=="create_table"&&events.len()>1{ProjectActionScope::Component}else{ProjectActionScope::Descendants};
        let preview=action_preview(engine,context.expected_epoch,&event.dataset_id,scope,true)?;
        let expected:BTreeSet<_>=events.iter().map(|e|e.dataset_id.as_str()).collect();if preview.table_ids.iter().map(String::as_str).collect::<BTreeSet<_>>()!=expected||!preview.blockers.is_empty(){return Err(invalid("project_cascade_scope_changed"));}
        for member in events.iter().rev(){lifecycle::retire_storage(engine,&member.dataset_id)?;let effects=retirement::retire_metadata(engine,member)?;docs.extend(effects.document_ids);settings.extend(effects.setting_ids);}
        let (connectors,binding_settings)=retire_connectors(engine,&event.id,&preview)?;docs.extend(connectors);settings.extend(binding_settings);
    }
    for member in &events{lifecycle::mark_replayed(engine,member,undo)?;}
    Ok(Some(CommitEffects{value:(),dataset_ids:datasets,document_ids:docs,setting_ids:settings}))
}

#[cfg(all(test,feature="project-v5"))]
mod tests {
    use crate::{models::project_persistence::*,services::{project_group_operations::tests::{fixture,context,add_link},project_native_service::NativeProjectService,project_database::ProjectDatabase,project_output::ProjectSqlOutput},state::AppState};
    fn generation(db:&ProjectDatabase,id:&str)->u64{db.with_engine(|e|e.get_dataset_generation(id)).unwrap()}
    fn delete(service:&NativeProjectService<'_>,db:&ProjectDatabase,id:&str,operation:&str)->ProjectCommit<()> {
        let mut ctx=context(db,operation);ctx.dataset_generations=vec![DatasetGeneration{id:id.into(),generation:generation(db,id)}];service.delete_dataset(&ctx,id).unwrap()
    }
    #[test]
    fn project_linked_groups_review_delete_confirmation_fences_scope_and_replays_receipt(){
        let (_dir,db,ids)=fixture();let path=db.path().to_path_buf();db.shutdown().unwrap();let state=AppState::new().unwrap();let service=NativeProjectService::new(&state);let opened=service.open(&path,false).unwrap();let db=service.database(opened.epoch).unwrap();
        let confirmed=db.committed_revision().unwrap();let child=db.materialize_project_sql(&context(&db,"late-child"),&ProjectSqlOutput{name:"Late child".into(),sql:"SELECT 9 AS value".into(),folder:String::new()}).unwrap().value.id;add_link(&db,"late-link",&[&ids[1]],&child);
        let mut ctx=context(&db,"delete-after-scope-change");ctx.dataset_generations=vec![DatasetGeneration{id:ids[1].clone(),generation:generation(&db,&ids[1])}];
        assert!(service.delete_dataset_at_revision(&ctx,&ids[1],confirmed).is_err());assert_eq!(db.with_engine(|e|e.list_datasets()).unwrap().len(),4);
        let current=db.committed_revision().unwrap();ctx.operation_id="confirmed-current".into();let commit=service.delete_dataset_at_revision(&ctx,&ids[1],current).unwrap();assert!(commit.deleted_directory_ids.contains(&child));
        assert_eq!(service.delete_dataset_at_revision(&ctx,&ids[1],current).unwrap().committed_revision,commit.committed_revision,"lost reply must return the same receipt even though the preview revision is now old");
    }
    #[test]
    fn project_linked_groups_replay_restored_children_follow_surviving_parent_folder(){
        for shared in [false,true]{
            let (_dir,db,ids)=fixture();
            if shared{db.with_engine(|e|{e.conn().execute("DELETE FROM _project_directory WHERE id='ab'",[])?;e.conn().execute("DELETE FROM _project_documents WHERE id='ab'",[])?;e.conn().execute("DELETE FROM _project_settings WHERE key='transformBinding:ab'",[])?;Ok(())}).unwrap();add_link(&db,"ab",&[&ids[0],&ids[2]],&ids[1]);}
            let path=db.path().to_path_buf();db.shutdown().unwrap();let state=AppState::new().unwrap();let service=NativeProjectService::new(&state);let opened=service.open(&path,false).unwrap();let db=service.database(opened.epoch).unwrap();
            let deleted=delete(&service,&db,&ids[1],"delete-child");let root=deleted.changed_history_entries[0].id.clone();
            db.move_table_group(&context(&db,"move-parent"),&crate::models::project_topology::ProjectGroupMoveRequest{target_table_id:ids[0].clone(),destination_folder:"Moved".into(),expected_topology_revision:db.committed_revision().unwrap()}).unwrap();
            let event=service.table_lifecycle_event(opened.epoch,&root).unwrap();let restored=service.apply_table_lifecycle(&context(&db,"restore-child"),&root,event.revision,true);
            if shared{assert!(restored.is_err(),"restoring a Join cannot link surviving inputs in different folders");assert!(!service.topology(opened.epoch).unwrap().tables.iter().any(|t|t.id==ids[1]));}
            else{restored.unwrap();db.with_reader(opened.epoch,|e|{let catalog=crate::services::project_catalog::ProjectCatalog::new(e);for id in [&ids[0],&ids[1],"ab","graph-b","analysis-b","tabulate-b"]{assert_eq!(catalog.summary(id)?.folder,"Moved");}Ok(())}).unwrap();}
        }
    }
    #[test]
    fn project_linked_groups_delete_descendants_and_owned_documents_only(){
        for delete_parent in [false,true]{
            let (_dir,db,ids)=fixture();let c=db.materialize_project_sql(&context(&db,"C"),&ProjectSqlOutput{name:"C".into(),sql:"SELECT 7::BIGINT AS value".into(),folder:String::new()}).unwrap().value.id;add_link(&db,"bc",&[&ids[1]],&c);
            let path=db.path().to_path_buf();db.shutdown().unwrap();let state=AppState::new().unwrap();let service=NativeProjectService::new(&state);let opened=service.open(&path,false).unwrap();let db=service.database(opened.epoch).unwrap();
            let target=if delete_parent{&ids[0]}else{&ids[1]};let commit=delete(&service,&db,target,"cascade");
            let active=db.with_engine(|e|e.list_datasets()).unwrap();let active_ids:Vec<_>=active.iter().map(|t|t.id.as_str()).collect();
            assert!(!active_ids.contains(&ids[1].as_str()));assert!(!active_ids.contains(&c.as_str()),"dependent descendant must be deleted");assert!(active_ids.contains(&ids[2].as_str()));assert_eq!(active_ids.contains(&ids[0].as_str()),!delete_parent);
            for id in [&ids[1],&c,"graph-b","analysis-b","tabulate-b","ab","bc"] {assert!(commit.deleted_directory_ids.contains(&id.to_string()),"missing deleted ID {id}");}
            assert_eq!(commit.changed_history_entries.iter().filter(|h|h.operation=="delete_table").count(),1,"a cascade has one public undo root");
            assert!(service.topology(opened.epoch).unwrap().diagnostics.is_empty());
        }
    }
    #[test]
    fn project_linked_groups_delete_shared_input_preserves_other_input_and_sibling(){
        let (_dir,db,ids)=fixture();db.with_engine(|e|{e.conn().execute("DELETE FROM _project_directory WHERE id='ab'",[])?;e.conn().execute("DELETE FROM _project_documents WHERE id='ab'",[])?;e.conn().execute("DELETE FROM _project_settings WHERE key='transformBinding:ab'",[])?;Ok(())}).unwrap();add_link(&db,"join",&[&ids[0],&ids[2]],&ids[1]);
        let d=db.materialize_project_sql(&context(&db,"D"),&ProjectSqlOutput{name:"D".into(),sql:"SELECT 3::BIGINT AS value".into(),folder:String::new()}).unwrap().value.id;add_link(&db,"ad",&[&ids[0]],&d);
        let path=db.path().to_path_buf();db.shutdown().unwrap();let state=AppState::new().unwrap();let service=NativeProjectService::new(&state);let opened=service.open(&path,false).unwrap();let db=service.database(opened.epoch).unwrap();
        let removed=delete(&service,&db,&ids[1],"delete-output");
        let active=db.with_engine(|e|e.list_datasets()).unwrap();for id in [&ids[0],&ids[2],&d]{assert!(active.iter().any(|t|t.id==*id));}
        assert!(service.topology(opened.epoch).unwrap().diagnostics.is_empty());
        let root=&removed.changed_history_entries[0].id;let event=service.table_lifecycle_event(opened.epoch,root).unwrap();service.apply_table_lifecycle(&context(&db,"undo-output"),root,event.revision,true).unwrap();
        delete(&service,&db,&ids[0],"delete-join-input");let active=db.with_engine(|e|e.list_datasets()).unwrap();assert_eq!(active.len(),1);assert_eq!(active[0].id,ids[2],"the other Join input must survive while both A descendants are removed");
    }
    #[test]
    fn project_linked_groups_replay_exact_cascade_after_reopen_and_reject_child_event(){
        let (_dir,db,ids)=fixture();let path=db.path().to_path_buf();db.shutdown().unwrap();let state=AppState::new().unwrap();let service=NativeProjectService::new(&state);let opened=service.open(&path,false).unwrap();let db=service.database(opened.epoch).unwrap();
        let deleted=delete(&service,&db,&ids[0],"delete-root");let root=deleted.changed_history_entries.iter().find(|h|h.operation=="delete_table").unwrap().id.clone();
        drop(db);service.close(opened.epoch).unwrap();let opened=service.open(&path,false).unwrap();let db=service.database(opened.epoch).unwrap();
        let event=service.table_lifecycle_event(opened.epoch,&root).unwrap();let restored=service.apply_table_lifecycle(&context(&db,"undo"),&root,event.revision,true).unwrap();
        for id in [&ids[0],&ids[1],"ab","graph-b","analysis-b","tabulate-b"]{assert!(restored.changed_directory_entries.iter().any(|s|s.id==*id),"missing restored ID {id}");}
        assert_eq!(service.topology(opened.epoch).unwrap().component(&ids[0]).unwrap().len(),2);
        let child=db.with_engine(|e|Ok(e.conn().query_row("SELECT id FROM _project_table_lifecycle_events WHERE operation='delete_table' AND dataset_id=?",[&ids[1]],|r|r.get::<_,String>(0))?)).unwrap();let child_event=service.table_lifecycle_event(opened.epoch,&child).unwrap();let mut redo=context(&db,"redo-child");redo.dataset_generations=vec![DatasetGeneration{id:ids[1].clone(),generation:generation(&db,&ids[1])}];
        assert!(service.apply_table_lifecycle(&redo,&child,child_event.revision,false).is_err());
        let root_event=service.table_lifecycle_event(opened.epoch,&root).unwrap();let mut redo=context(&db,"redo-root");redo.dataset_generations=vec![DatasetGeneration{id:ids[0].clone(),generation:generation(&db,&ids[0])}];let retired=service.apply_table_lifecycle(&redo,&root,root_event.revision,false).unwrap();
        assert!(retired.deleted_directory_ids.contains(&ids[1]));assert!(retired.deleted_directory_ids.contains(&"analysis-b".into()));
        assert_eq!(db.with_engine(|e|e.list_datasets()).unwrap().len(),1);
    }
    #[test]
    fn project_linked_groups_delete_external_reference_blocks_without_partial_retirement(){
        let (_dir,db,ids)=fixture();db.with_engine(|e|{e.conn().execute("INSERT INTO _project_directory VALUES ('external','report','External','',1,?)",[serde_json::json!(["analysis-b"]).to_string()])?;e.conn().execute("INSERT INTO _project_documents VALUES ('external',1,1,'{}')",[])?;Ok(())}).unwrap();let path=db.path().to_path_buf();db.shutdown().unwrap();let state=AppState::new().unwrap();let service=NativeProjectService::new(&state);let opened=service.open(&path,false).unwrap();let db=service.database(opened.epoch).unwrap();
        let preview=service.preview_table_action(opened.epoch,&ids[0],crate::models::project_topology::ProjectActionScope::Descendants).unwrap();assert!(preview.blockers.iter().any(|b|b.id=="external"));
        let mut ctx=context(&db,"blocked");ctx.dataset_generations=vec![DatasetGeneration{id:ids[0].clone(),generation:generation(&db,&ids[0])}];assert!(service.delete_dataset(&ctx,&ids[0]).is_err());assert_eq!(db.with_engine(|e|e.list_datasets()).unwrap().len(),3);
    }
    #[test]
    fn project_linked_groups_replay_rejects_missing_upstream_parent(){
        let (_dir,db,ids)=fixture();let path=db.path().to_path_buf();db.shutdown().unwrap();let state=AppState::new().unwrap();let service=NativeProjectService::new(&state);let opened=service.open(&path,false).unwrap();let db=service.database(opened.epoch).unwrap();
        let child=delete(&service,&db,&ids[1],"delete-child");let child_id=child.changed_history_entries[0].id.clone();delete(&service,&db,&ids[0],"delete-parent-later");
        let child_event=service.table_lifecycle_event(opened.epoch,&child_id).unwrap();
        assert!(service.apply_table_lifecycle(&context(&db,"out-of-order-undo"),&child_id,child_event.revision,true).is_err(),"restoring a derived table must not publish a binding to a missing parent");
        assert_eq!(db.with_engine(|e|e.list_datasets()).unwrap().len(),1);
    }
    #[test]
    fn project_linked_groups_delete_workflow_binding_is_external_reference(){
        let (_dir,db,ids)=fixture();db.with_engine(|e|{e.conn().execute("INSERT INTO _project_settings VALUES ('workflowBinding:external',1,?)",[serde_json::json!({"inputs":[{"slotId":"source","tableDocumentId":ids[1]}]}).to_string()])?;Ok(())}).unwrap();
        let preview=db.with_reader(db.epoch(),|e|super::preview(e,db.epoch(),&ids[0],crate::models::project_topology::ProjectActionScope::Descendants));
        assert!(preview.unwrap().blockers.iter().any(|b|b.id=="workflowBinding:external"));
    }

    #[test]
    fn project_linked_groups_delete_rolls_back_after_descendant_retirement_and_replays_lost_ack(){
        let (_dir,db,ids)=fixture();let path=db.path().to_path_buf();
        db.with_engine(|e|{e.conn().execute_batch("CREATE TABLE _project_retired_datasets AS SELECT * FROM _meta_datasets WHERE FALSE; CREATE UNIQUE INDEX _project_retired_dataset_id ON _project_retired_datasets(id)")?;e.conn().execute("INSERT INTO _project_retired_datasets SELECT * FROM _meta_datasets WHERE id=?",[&ids[0]])?;Ok(())}).unwrap();
        db.shutdown().unwrap();let state=AppState::new().unwrap();let service=NativeProjectService::new(&state);let opened=service.open(&path,false).unwrap();let db=service.database(opened.epoch).unwrap();
        let mut ctx=context(&db,"retry-delete");ctx.dataset_generations=vec![DatasetGeneration{id:ids[0].clone(),generation:generation(&db,&ids[0])}];
        assert!(service.delete_dataset(&ctx,&ids[0]).is_err());assert_eq!(db.with_engine(|e|e.list_datasets()).unwrap().len(),3);
        assert!(service.topology(opened.epoch).unwrap().component(&ids[0]).unwrap().contains(&ids[1]));
        db.with_engine(|e|{e.conn().execute("DELETE FROM _project_retired_datasets WHERE id=?",[&ids[0]])?;Ok(())}).unwrap();
        crate::services::project_transaction::inject_commit_failure_for_test(2);assert!(service.delete_dataset(&ctx,&ids[0]).is_err());
        let replay=service.delete_dataset(&ctx,&ids[0]).unwrap();assert_eq!(replay.committed_revision,ctx.expected_revision+1);assert_eq!(db.with_engine(|e|e.list_datasets()).unwrap().len(),1);
        assert_eq!(replay.changed_history_entries.iter().filter(|h|h.operation=="delete_table").count(),1);
    }
    #[test]
    fn project_linked_groups_replay_transform_creation_keeps_connector_ownership(){
        let (_dir,db,ids)=fixture();let created=crate::services::project_group_operations::tests::create_subset(&db,&ids[0],"Created subset").unwrap();let event_id=created.changed_history_entries[0].id.clone();let output=created.value.definition.output.table_document_id;let connector=created.value.definition.id;
        let path=db.path().to_path_buf();db.shutdown().unwrap();let state=AppState::new().unwrap();let service=NativeProjectService::new(&state);let opened=service.open(&path,false).unwrap();let db=service.database(opened.epoch).unwrap();
        let event=service.table_lifecycle_event(opened.epoch,&event_id).unwrap();let mut undo=context(&db,"undo-created");undo.dataset_generations=vec![DatasetGeneration{id:output.clone(),generation:generation(&db,&output)}];
        let hidden=service.apply_table_lifecycle(&undo,&event_id,event.revision,true).unwrap();assert!(hidden.deleted_directory_ids.contains(&output));assert!(hidden.deleted_directory_ids.contains(&connector));assert!(service.topology(opened.epoch).unwrap().diagnostics.is_empty());
        let event=service.table_lifecycle_event(opened.epoch,&event_id).unwrap();service.apply_table_lifecycle(&context(&db,"redo-created"),&event_id,event.revision,false).unwrap();assert!(service.topology(opened.epoch).unwrap().component(&ids[0]).unwrap().contains(&output));
    }

}
