//! Authoritative operations on connected table components.
use std::collections::BTreeSet;
use crate::{error::AppError,models::{project_persistence::*,project_topology::*},services::{project_database::ProjectDatabase,project_catalog::ProjectCatalog,project_transaction::CommitEffects}};
/// Generic record/folder patches cannot bypass whole-component organization.
pub(crate) fn validate_record_moves(engine:&crate::engine::duckdb_engine::DuckDbEngine,patch:&ProjectRecordPatch)->Result<(),AppError>{
    let relationship_write=patch.settings.iter().any(|s|s.key.starts_with("transformBinding:"))||patch.documents.iter().any(|d|d.document.summary.kind==ProjectDocumentKind::Transform)||!patch.deleted_document_ids.is_empty();
    if patch.directory_moves.is_empty()&&patch.documents.is_empty()&&!relationship_write{return Ok(());}
    let topology=super::project_topology::read_topology(engine,0)?;
    let catalog=ProjectCatalog::new(engine);
    for id in &patch.deleted_document_ids {if catalog.summary(id)?.kind==ProjectDocumentKind::Transform{return Err(AppError::InvalidParam("project_transform_requires_table_deletion".into()));}}
    for setting in &patch.settings {if let Some(id)=setting.key.strip_prefix("transformBinding:") {
        let old=catalog.get_setting(&setting.key)?.ok_or_else(||AppError::InvalidParam("project_transform_requires_typed_operation".into()))?.1;
        let inputs=|value:&serde_json::Value|->Option<BTreeSet<(String,String)>>{Some(value.get("inputs")?.as_array()?.iter().map(|v|Some((v.get("role")?.as_str()?.to_string(),v.get("tableDocumentId")?.as_str()?.to_string()))).collect::<Option<_>>()?)};
        if !topology.transforms.iter().any(|t|t.id==id)||inputs(&old).is_none()||inputs(&old)!=inputs(&setting.value){return Err(AppError::InvalidParam("project_transform_detach_not_allowed".into()));}
    }}
    let mut proposed:std::collections::BTreeMap<_,_>=patch.directory_moves.iter().map(|m|(m.id.as_str(),m.folder.as_str())).collect();
    for write in &patch.documents {
        let summary=&write.document.summary;
        proposed.insert(&summary.id,&summary.folder);
        if summary.kind==ProjectDocumentKind::Transform {
            let existing=topology.transforms.iter().find(|t|t.id==summary.id).ok_or_else(||AppError::InvalidParam("project_transform_requires_typed_operation".into()))?;
            if write.document.body.pointer("/output/tableDocumentId").and_then(serde_json::Value::as_str)!=Some(existing.output_table_id.as_str()){return Err(AppError::InvalidParam("project_transform_detach_not_allowed".into()));}
        }
        if matches!(summary.kind,ProjectDocumentKind::Graph|ProjectDocumentKind::GraphNew|ProjectDocumentKind::Analysis|ProjectDocumentKind::Tabulate) {
            if let Ok(old)=catalog.summary(&summary.id) {if old.dependencies!=summary.dependencies{return Err(AppError::InvalidParam("project_document_reparent_not_allowed".into()));}}
            if let Some(table)=summary.dependencies.first().filter(|_|summary.dependencies.len()==1) {
                let owner=catalog.summary(table)?;
                let folder=patch.directory_moves.iter().find(|m|m.id==*table).map(|m|m.folder.as_str()).unwrap_or(&owner.folder);
                if summary.folder!=folder{return Err(AppError::InvalidParam("project_document_inherits_table_folder".into()));}
            }
        }
    }
    let mut movements=patch.directory_moves.clone();
    for write in &patch.documents {
        let summary=&write.document.summary;
        if let Ok(old)=catalog.summary(&summary.id) {movements.push(DirectoryMove{id:summary.id.clone(),expected_revision:old.revision,folder:summary.folder.clone(),name:None});}
    }
    let mut validated=BTreeSet::new();
    for movement in &movements {
        let old=catalog.summary(&movement.id)?;
        if old.folder==movement.folder{continue;}
        let table=if old.kind==ProjectDocumentKind::Table{Some(old.id.as_str())}
            else{topology.owned_documents.iter().find(|d|d.id==old.id).map(|d|d.table_id.as_str()).or_else(||topology.transforms.iter().find(|t|t.id==old.id).map(|t|t.output_table_id.as_str()))};
        if let Some(table)=table {
            if validated.contains(table){continue;}
            let preview=topology.preview(table,ProjectActionScope::Component)?;
            validated.extend(preview.table_ids.iter().cloned());
            for id in preview.table_ids.iter().chain(&preview.transform_ids).chain(&preview.owned_document_ids){
                let current=catalog.summary(id)?;
                let destination=proposed.get(id.as_str()).copied().unwrap_or(&current.folder);
                if destination!=movement.folder{return Err(AppError::InvalidParam("project_group_partial_move".into()));}
            }
        }
    }
    Ok(())
}

impl ProjectDatabase {
    pub fn move_table_group(&self,context:&ProjectWriteContext,request:&ProjectGroupMoveRequest)->Result<ProjectCommit<()>,AppError>{
        self.commit_with_effects(context,&("move_project_table_group",request),|engine|{
            if request.expected_topology_revision!=context.expected_revision{return Err(AppError::InvalidParam("project_topology_revision_stale".into()));}
            let topology=super::project_topology::read_topology(engine,context.expected_epoch)?;
            let preview=topology.preview(&request.target_table_id,ProjectActionScope::Component)?;
            let ids:BTreeSet<_>=preview.table_ids.into_iter().chain(preview.transform_ids).chain(preview.owned_document_ids).collect();
            let catalog=ProjectCatalog::new(engine);
            let moves=ids.iter().map(|id|{let summary=catalog.summary(id)?;Ok(DirectoryMove{id:id.clone(),expected_revision:summary.revision,folder:request.destination_folder.clone(),name:None})}).collect::<Result<Vec<_>,AppError>>()?;
            catalog.apply_patch(&ProjectRecordPatch{directory_moves:moves,..Default::default()})?;
            Ok(CommitEffects{value:(),dataset_ids:vec![],document_ids:ids.into_iter().collect(),setting_ids:vec![]})
        })
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use crate::{error::AppError,models::{project_persistence::*,project_topology::*},services::{project_database::ProjectDatabase,project_catalog::ProjectCatalog,project_output::ProjectSqlOutput}};
    pub(crate) fn context(db:&ProjectDatabase,id:&str)->ProjectWriteContext {
        ProjectWriteContext{operation_id:id.into(),expected_project_id:db.header().unwrap().project_id,expected_epoch:db.epoch(),expected_revision:db.committed_revision().unwrap(),request_digest:String::new(),document_revisions:vec![],dataset_generations:vec![]}
    }
    pub(crate) fn fixture()->(tempfile::TempDir,ProjectDatabase,Vec<String>) {
        let dir=tempfile::tempdir().unwrap();let db=ProjectDatabase::create(&dir.path().join("groups.spprj"),false).unwrap();
        let ids=["A","B","X"].into_iter().map(|name|db.materialize_project_sql(&context(&db,name),&ProjectSqlOutput{name:name.into(),sql:"SELECT 42::BIGINT AS value".into(),folder:String::new()}).unwrap().value.id).collect::<Vec<_>>();
        add_link(&db,"ab",&[&ids[0]],&ids[1]);
        db.with_engine(|e| {for (id,kind) in [("graph-b","graph"),("analysis-b","analysis"),("tabulate-b","tabulate")] {
            e.conn().execute("INSERT INTO _project_directory VALUES (?,?,?,'',1,?)",duckdb::params![id,kind,id,serde_json::json!([ids[1]]).to_string()])?;
            e.conn().execute("INSERT INTO _project_documents VALUES (?,1,1,'{}')",[id])?;
        }Ok(())}).unwrap();
        (dir,db,ids)
    }
    pub(crate) fn add_link(db:&ProjectDatabase,id:&str,inputs:&[&str],output:&str){
        db.with_engine(|e| {
            e.conn().execute("INSERT INTO _project_directory VALUES (?,'transform',?,'',1,'[]')",duckdb::params![id,id])?;
            let roles:Vec<_>=(0..inputs.len()).map(|i|serde_json::json!({"role":format!("input{i}")})).collect();
            let body=serde_json::json!({"id":id,"name":id,"revision":1,"operation":{"kind":"subset"},"inputSlots":roles,"output":{"tableDocumentId":output}});
            e.conn().execute("INSERT INTO _project_documents VALUES (?,1,1,?)",duckdb::params![id,body.to_string()])?;
            let bindings:Vec<_>=inputs.iter().enumerate().map(|(i,id)|serde_json::json!({"role":format!("input{i}"),"tableDocumentId":id})).collect();
            e.conn().execute("INSERT INTO _project_settings VALUES (?,1,?)",duckdb::params![format!("transformBinding:{id}"),serde_json::json!({"definitionId":id,"definitionRevision":1,"inputs":bindings}).to_string()])?;Ok(())
        }).unwrap();
    }
    fn folder(db:&ProjectDatabase,id:&str)->String{db.with_reader(db.epoch(),|e|Ok(ProjectCatalog::new(e).summary(id)?.folder)).unwrap()}
    #[test]
    fn project_linked_groups_move_owned_document_cannot_change_parent_or_delete_broken_connector(){
        let (_dir,db,ids)=fixture();
        let doc=ProjectDocumentBody{summary:ProjectDocumentSummary{id:"graph-b".into(),kind:ProjectDocumentKind::Graph,name:"graph-b".into(),folder:String::new(),revision:2,dependencies:vec![ids[2].clone()],analysis_kind:None},schema_version:1,body:serde_json::json!({"id":"graph-b","name":"graph-b","sourceDatasetId":ids[2]})};
        assert!(db.commit_records(&context(&db,"reparent-child"),&ProjectRecordPatch{documents:vec![DocumentWrite{expected_revision:Some(1),document:doc}],..Default::default()}).is_err());
        db.with_engine(|e|{e.conn().execute("DELETE FROM _project_settings WHERE key='transformBinding:ab'",[])?;Ok(())}).unwrap();
        assert!(db.commit_records(&context(&db,"unlink-broken"),&ProjectRecordPatch{deleted_document_ids:vec!["ab".into()],..Default::default()}).is_err());
    }
    #[test]
    fn project_linked_groups_move_folder_rename_and_promotion_include_all_members(){
        let (_dir,db,ids)=fixture();db.move_table_group(&context(&db,"folder-source"),&ProjectGroupMoveRequest{target_table_id:ids[0].clone(),destination_folder:"F/N".into(),expected_topology_revision:3}).unwrap();
        for (name,from,to) in [("rename","F/N","G/N"),("promote","G/N","")] {
            let patch=db.with_reader(db.epoch(),|e|{let topology=super::super::project_topology::read_topology(e,db.epoch())?;let preview=topology.preview(&ids[0],ProjectActionScope::Component)?;let catalog=ProjectCatalog::new(e);Ok(ProjectRecordPatch{directory_moves:preview.table_ids.iter().chain(&preview.transform_ids).chain(&preview.owned_document_ids).map(|id|{let summary=catalog.summary(id)?;assert_eq!(summary.folder,from);Ok(DirectoryMove{id:id.clone(),expected_revision:summary.revision,folder:to.into(),name:None})}).collect::<Result<_,AppError>>()?,deleted_folders:vec![from.into()],..Default::default()})}).unwrap();
            db.commit_records(&context(&db,name),&patch).unwrap();for id in [&ids[0],&ids[1],"ab","graph-b","analysis-b","tabulate-b"]{assert_eq!(folder(&db,id),to);}assert_eq!(folder(&db,&ids[2]),"");
        }
        assert!(db.with_reader(db.epoch(),|e|super::super::project_topology::read_topology(e,db.epoch())).unwrap().diagnostics.is_empty());
    }
    #[test]
    fn project_linked_groups_move_entire_component_to_new_folder_and_root(){
        let (_dir,db,ids)=fixture();
        let req=ProjectGroupMoveRequest{target_table_id:ids[1].clone(),destination_folder:"New Folder/Nested".into(),expected_topology_revision:db.committed_revision().unwrap()};
        let ctx=context(&db,"move");let commit=db.move_table_group(&ctx,&req).unwrap();
        for id in [&ids[0],&ids[1],"ab","graph-b","analysis-b","tabulate-b"]{assert_eq!(folder(&db,id),"New Folder/Nested");assert!(commit.changed_directory_entries.iter().any(|s|s.id==id));}
        assert_eq!(folder(&db,&ids[2]),"");assert_eq!(commit.committed_revision,4);
        assert_eq!(db.move_table_group(&ctx,&req).unwrap().committed_revision,4,"lost reply must not move twice");
        assert!(db.move_table_group(&context(&db,"stale-preview"),&req).is_err());
        let req=ProjectGroupMoveRequest{destination_folder:"".into(),expected_topology_revision:4,..req};db.move_table_group(&context(&db,"root"),&req).unwrap();
        assert_eq!(folder(&db,&ids[0]),"");assert_eq!(folder(&db,"graph-b"),"");
    }
    #[test]
    fn project_linked_groups_move_rejects_partial_raw_patch(){
        let (_dir,db,ids)=fixture();
        for id in [&ids[1],"graph-b"]{
            let patch=ProjectRecordPatch{directory_moves:vec![DirectoryMove{id:id.into(),expected_revision:1,folder:"partial".into(),name:None}],..Default::default()};
            assert!(db.commit_records(&context(&db,&format!("partial-{id}")),&patch).is_err(),"partial moves must fail at the native boundary");
            assert_eq!(folder(&db,id),"");
        }
        assert_eq!(db.committed_revision().unwrap(),3);
    }
    #[test]
    fn project_linked_groups_move_rolls_back_and_fences_owners(){
        let (dir,db,ids)=fixture();let ctx=context(&db,"move-fail");let req=ProjectGroupMoveRequest{target_table_id:ids[0].clone(),destination_folder:"destination".into(),expected_topology_revision:3};
        crate::services::project_transaction::inject_commit_failure_for_test(1);
        assert!(db.move_table_group(&ctx,&req).is_err());assert_eq!(folder(&db,&ids[0]),"");assert_eq!(folder(&db,&ids[1]),"");assert_eq!(db.committed_revision().unwrap(),3);
        let mut foreign=ctx.clone();foreign.expected_epoch+=1;assert!(db.move_table_group(&foreign,&req).is_err());
        db.shutdown().unwrap();let readonly=ProjectDatabase::open(&dir.path().join("groups.spprj"),true).unwrap();
        assert!(readonly.move_table_group(&context(&readonly,"readonly"),&req).is_err());
    }
    #[test]
    fn project_linked_groups_move_rejects_document_write_and_unlink_bypasses(){
        let (_dir,db,ids)=fixture();
        let graph=ProjectDocumentBody{summary:ProjectDocumentSummary{id:"graph-b".into(),kind:ProjectDocumentKind::Graph,name:"graph-b".into(),folder:"separate".into(),revision:2,dependencies:vec![ids[1].clone()],analysis_kind:None},schema_version:1,body:serde_json::json!({"id":"graph-b","name":"graph-b","sourceDatasetId":ids[1]})};
        let patch=ProjectRecordPatch{documents:vec![DocumentWrite{expected_revision:Some(1),document:graph}],..Default::default()};
        assert!(db.commit_records(&context(&db,"body-move"),&patch).is_err(),"body writes cannot independently relocate owned documents");
        let patch=ProjectRecordPatch{deleted_document_ids:vec!["ab".into()],..Default::default()};
        assert!(db.commit_records(&context(&db,"unlink"),&patch).is_err(),"deleting a connector alone detaches its output");
        let patch=ProjectRecordPatch{settings:vec![ProjectSettingWrite{key:"transformBinding:ab".into(),expected_revision:Some(1),value:serde_json::Value::Null}],..Default::default()};
        assert!(db.commit_records(&context(&db,"unbind"),&patch).is_err());
        assert_eq!(db.committed_revision().unwrap(),3);
    }
    pub(crate) fn create_subset(db:&ProjectDatabase,source:&str,name:&str)->Result<ProjectCommit<crate::services::table_transform_service::TableTransformCommandResult>,AppError>{
        let mut ctx=context(db,name);ctx.dataset_generations=vec![DatasetGeneration{id:source.into(),generation:db.with_engine(|e|e.get_dataset_generation(source)).unwrap()}];
        db.create_project_transform(&ctx,&crate::services::project_output::ProjectTransformCreate{
            draft:serde_json::from_value(serde_json::json!({"name":name,"outputName":name,"operation":{"kind":"subset","columns":["value"]}})).unwrap(),
            inputs:vec![crate::services::table_transform_service::TableTransformInputBinding{role:"source".into(),table_document_id:source.into()}],folder:String::new(),
        })
    }
    #[test]
    fn project_linked_groups_move_new_transform_inherits_source_folder(){
        let (_dir,db,ids)=fixture();db.move_table_group(&context(&db,"organize"),&ProjectGroupMoveRequest{target_table_id:ids[0].clone(),destination_folder:"experiment".into(),expected_topology_revision:3}).unwrap();
        let added=create_subset(&db,&ids[0],"New subset").unwrap();
        assert_eq!(folder(&db,&added.value.definition.output.table_document_id),"experiment");
        assert_eq!(folder(&db,&added.value.definition.id),"experiment");
    }
    #[test]
    fn project_linked_groups_move_rebind_cannot_detach_existing_inputs(){
        let (_dir,db,ids)=fixture();let added=create_subset(&db,&ids[0],"Rebind subset").unwrap();
        let output=&added.value.definition.output.table_document_id;let mut ctx=context(&db,"rebind");
        ctx.document_revisions=vec![DocumentRevision{id:added.value.definition.id.clone(),revision:1}];
        ctx.dataset_generations=db.with_engine(|e|Ok(vec![DatasetGeneration{id:ids[2].clone(),generation:e.get_dataset_generation(&ids[2])?},DatasetGeneration{id:output.clone(),generation:e.get_dataset_generation(output)?}])).unwrap();
        let req=crate::services::project_output::ProjectTransformRun{definition:added.value.definition,binding:added.value.execution.binding,input_bindings:Some(vec![crate::services::table_transform_service::TableTransformInputBinding{role:"source".into(),table_document_id:ids[2].clone()}])};
        assert!(db.run_project_transform(&ctx,&req).is_err(),"rebinding must not leave the original upstream table detached");
    }

    #[test]
    fn project_linked_groups_move_transform_body_cannot_relocate_connector(){
        let (_dir,db,ids)=fixture();let created=create_subset(&db,&ids[0],"Body connector").unwrap();
        let body=serde_json::to_value(&created.value.definition).unwrap();let id=&created.value.definition.id;
        let patch=ProjectRecordPatch{documents:vec![DocumentWrite{expected_revision:Some(1),document:ProjectDocumentBody{summary:ProjectDocumentSummary{id:id.clone(),kind:ProjectDocumentKind::Transform,name:"Body connector".into(),folder:"separate".into(),revision:2,dependencies:vec![ids[0].clone()],analysis_kind:None},schema_version:1,body}}],..Default::default()};
        assert!(db.commit_records(&context(&db,"connector-body-move"),&patch).is_err(),"document writes must obey the same component location invariant as directory moves");
    }

}
