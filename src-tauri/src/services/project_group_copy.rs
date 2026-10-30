//! Bounded metadata snapshots and native SQL row copying with typed identity remapping.
use std::collections::{BTreeMap,BTreeSet};
use std::path::PathBuf;
use duckdb::params;
use serde::{Deserialize,Serialize};
use serde_json::Value;
use crate::{engine::duckdb_engine::DuckDbEngine,error::AppError,models::{project_persistence::*,project_topology::*}};
use super::{project_database::ProjectDatabase,project_catalog::ProjectCatalog,project_transaction::CommitEffects,spprj_archive::{self,TableDoc},project_service};
fn invalid(code:&str)->AppError{AppError::InvalidParam(code.into())}
#[derive(Clone,Serialize,Deserialize)]
pub(crate) struct GroupTableSnapshot {pub doc:TableDoc,pub row_count:i64,pub next_row_id:Option<i64>,pub source_path:Option<String>}
#[derive(Clone,Serialize,Deserialize)]
pub(crate) struct GroupRecords {pub revision:u64,pub tables:Vec<GroupTableSnapshot>,pub documents:Vec<ProjectDocumentBody>,pub settings:BTreeMap<String,Value>}
pub(crate) enum GroupRows {Native,Parquet(BTreeMap<String,PathBuf>)}

pub(crate) fn capture_group(engine:&DuckDbEngine,epoch:u64,target:&str)->Result<GroupRecords,AppError>{
    let topology=super::project_topology::read_topology(engine,epoch)?;let preview=topology.preview(target,ProjectActionScope::Component)?;let catalog=ProjectCatalog::new(engine);let mut tables=vec![];let mut documents=vec![];let mut settings=BTreeMap::new();
    for id in &preview.table_ids {
        let meta=engine.get_dataset_meta(id)?;let plans=engine.get_archive_column_plans(id)?;let display=super::project_column_settings::read(engine,id)?;
        let doc=TableDoc{id:id.clone(),name:meta.name,source_type:meta.source_type,version:"3".into(),columns:spprj_archive::project_archive_table_columns(&plans,Some(&display)),rows:vec![]};
        let next_row_id=engine.conn().query_row("SELECT next_row_id FROM _meta_datasets WHERE id=?",[id],|r|r.get(0))?;
        tables.push(GroupTableSnapshot{doc,row_count:meta.row_count,next_row_id,source_path:meta.source_path});
        for key in [format!("filter:{id}"),format!("display:{id}")]{if let Some((_,value))=catalog.get_setting(&key)?{settings.insert(key,value);}}
    }
    for id in preview.transform_ids.iter().chain(&preview.owned_document_ids){let summary=catalog.summary(id)?;documents.push(catalog.get_document(id,summary.revision)?);}
    for id in &preview.transform_ids{let key=format!("transformBinding:{id}");let value=catalog.get_setting(&key)?.ok_or_else(||invalid("project_transform_binding_missing"))?.1;settings.insert(key,value);}
    Ok(GroupRecords{revision:topology.committed_revision,tables,documents,settings})
}
fn insert_id(map:&mut BTreeMap<String,String>,old:&str,new:&str)->Result<(),AppError>{
    if map.get(old).is_some_and(|value|value!=new){return Err(invalid("project_group_identity_ambiguous"));}map.insert(old.into(),new.into());Ok(())
}
fn mapped(map:&BTreeMap<String,String>,id:&str)->Result<String,AppError>{map.get(id).cloned().ok_or_else(||invalid("project_group_reference_missing"))}
/// Only structural identity fields are remapped. Names, labels, literal values,
/// SQL, and other authored text are deliberately outside this traversal.
pub(crate) fn remap_group_records(value:&mut Value,map:&BTreeMap<String,String>){
    match value{
        Value::Object(fields)=>for (key,item) in fields.iter_mut(){
            let identity=matches!(key.as_str(),"datasetId"|"sourceDatasetId"|"tableDocumentId"|"definitionId"|"columnId"|"formulaId"|"outputColumnId")||key.ends_with("ColumnId");
            if identity{if let Some(new)=item.as_str().and_then(|id|map.get(id)){*item=Value::String(new.clone());}}
            else if key.ends_with("ColumnIds"){if let Some(ids)=item.as_array_mut(){for id in ids{if let Some(new)=id.as_str().and_then(|id|map.get(id)){*id=Value::String(new.clone());}}}}
            else if !matches!(key.as_str(),"extras"|"configurationText"|"sql"|"markdown"){remap_group_records(item,map);}
        },
        Value::Array(items)=>for item in items{remap_group_records(item,map);},_=>{}
    }
}
fn allocate_name(base:&str,used:&mut BTreeSet<String>)->String{
    let mut name=base.to_string();let mut n=2;while !used.insert(name.to_lowercase()){name=format!("{base}-{n}");n+=1;}name
}
fn formula_id(column:&spprj_archive::TableColumn)->Option<&str>{
    column.calculated.as_ref().map(|calculated|match calculated{crate::models::calculated_column::ArchivedCalculatedColumn::Ready{definition,..}=>definition.formula_id.as_str(),crate::models::calculated_column::ArchivedCalculatedColumn::Preserved{definition}=>definition.formula_id.as_str()})
}
/// Uncommitted native tables are the staging area: rows never traverse JSON/IPC.
/// The caller owns one publication transaction and checks cancellation before commit.
pub(crate) fn copy_records(engine:&DuckDbEngine,epoch:u64,records:&GroupRecords,rows:&GroupRows,folder:&str,cancelled:&dyn Fn()->bool)->Result<CommitEffects<ProjectGroupCopyResult>,AppError>{
    if cancelled(){return Err(AppError::Cancelled("project_group_copy_cancelled".into()));}
    let mut id_map=BTreeMap::new();let mut names:BTreeSet<_>=engine.list_datasets()?.iter().map(|m|m.name.to_lowercase()).collect();let mut destinations=vec![];
    for table in &records.tables {
        let mut doc=project_service::remap_imported_table_doc(&table.doc)?;doc.name=allocate_name(&doc.name,&mut names);insert_id(&mut id_map,&table.doc.id,&doc.id)?;
        for (old,new) in table.doc.columns.iter().zip(&doc.columns){insert_id(&mut id_map,old.column_id.as_deref().ok_or_else(||invalid("project_column_identity_missing"))?,new.column_id.as_deref().unwrap())?;if let (Some(old),Some(new))=(formula_id(old),formula_id(new)){insert_id(&mut id_map,old,new)?;}}
        destinations.push(doc);
    }
    for document in &records.documents{insert_id(&mut id_map,&document.summary.id,&uuid::Uuid::new_v4().to_string())?;}
    let mut document_ids=vec![];let mut setting_ids=vec![];let mut events=vec![];let catalog=ProjectCatalog::new(engine);
    for (source,doc) in records.tables.iter().zip(&destinations) {
        if cancelled(){return Err(AppError::Cancelled("project_group_copy_cancelled".into()));}
        engine.create_empty_table(&doc.id,&doc.name,&doc.columns.iter().map(|c|c.name.clone()).collect::<Vec<_>>(),&doc.columns.iter().map(|c|c.col_type.clone()).collect::<Vec<_>>())?;
        let destination=DuckDbEngine::quote_identifier(&DuckDbEngine::internal_table_name(&doc.id));
        engine.conn().execute_batch(&format!("ALTER TABLE {destination} ALTER COLUMN _row_id SET DATA TYPE BIGINT"))?;
        let columns=std::iter::once("_row_id").chain(doc.columns.iter().map(|c|c.name.as_str())).chain(std::iter::once("_row_order")).map(DuckDbEngine::quote_identifier).collect::<Vec<_>>().join(",");
        match rows {
            GroupRows::Native=>{let source_table=DuckDbEngine::quote_identifier(&DuckDbEngine::internal_table_name(&source.doc.id));engine.conn().execute_batch(&format!("INSERT INTO {destination} ({columns}) SELECT {columns} FROM {source_table}"))?;},
            GroupRows::Parquet(paths)=>{let file=paths.get(&source.doc.id).and_then(|p|p.to_str()).ok_or_else(||invalid("project_group_staging_missing"))?;engine.conn().execute(&format!("INSERT INTO {destination} ({columns}) SELECT {columns} FROM read_parquet(?)"),[file])?;}
        }
        if cancelled(){return Err(AppError::Cancelled("project_group_copy_cancelled".into()));}
        engine.conn().execute("UPDATE _meta_datasets SET row_count=?,next_row_id=?,source_type=?,source_path=? WHERE id=?",params![source.row_count,source.next_row_id,&source.doc.source_type,&source.source_path,&doc.id])?;
        let plans=project_service::table_doc_to_archive_column_plans(doc,None)?;engine.replace_archive_column_ids(&doc.id,&plans)?;engine.replace_archived_calculated_columns(&doc.id,&plans)?;
        // Roles and missing-value metadata are non-identity column properties.
        if matches!(rows,GroupRows::Native){engine.conn().execute("UPDATE _meta_columns AS target SET role=source.role,missing_count=source.missing_count FROM _meta_columns AS source WHERE source.dataset_id=? AND target.dataset_id=? AND target.col_index=source.col_index",params![&source.doc.id,&doc.id])?;}
        engine.rebuild_natural_anchors(&doc.id,0)?;events.push(catalog.publish_new_table(&engine.get_dataset_meta(&doc.id)?,folder)?);document_ids.push(doc.id.clone());
    }
    let table_names:BTreeMap<_,_>=destinations.iter().map(|d|(d.id.clone(),d.name.clone())).collect();let mut patch=ProjectRecordPatch::default();let mut transforms=vec![];
    for source in &records.documents{
        let mut document=source.clone();document.summary.id=mapped(&id_map,&source.summary.id)?;document.summary.folder=folder.into();document.summary.revision=1;document.summary.dependencies=source.summary.dependencies.iter().map(|id|mapped(&id_map,id)).collect::<Result<_,_>>()?;
        remap_group_records(&mut document.body,&id_map);document.body["id"]=Value::String(document.summary.id.clone());
        if source.summary.kind==ProjectDocumentKind::GraphNew {if let Some(layers)=document.body.get_mut("layers").and_then(Value::as_array_mut){for layer in layers{layer["id"]=Value::String(uuid::Uuid::new_v4().to_string());}}}
        if source.summary.kind==ProjectDocumentKind::Transform {
            let output=document.body.pointer("/output/tableDocumentId").and_then(Value::as_str).ok_or_else(||invalid("project_transform_output_missing"))?.to_string();
            document.body["output"]["name"]=Value::String(table_names.get(&output).ok_or_else(||invalid("project_transform_output_missing"))?.clone());
            transforms.push(serde_json::from_value::<super::table_transform_domain::TableTransformDefinition>(document.body.clone()).map_err(|_|invalid("project_transform_invalid"))?);
        }
        document_ids.push(document.summary.id.clone());patch.documents.push(DocumentWrite{expected_revision:None,document});
    }
    let mut bindings=BTreeMap::new();
    for (key,source) in &records.settings {
        let mut value=source.clone();let (key,id)=key.split_once(':').ok_or_else(||invalid("project_group_setting_invalid"))?;let new_id=mapped(&id_map,id)?;let new_key=format!("{key}:{new_id}");
        remap_group_records(&mut value,&id_map);
        if key=="transformBinding" {
            let mut binding:super::table_transform_service::PersistedTableTransformBinding=serde_json::from_value(value).map_err(|_|invalid("project_transform_binding_invalid"))?;binding.binding.output_generation=0;if let Some(last)=&mut binding.last_run{if last.output_generation.is_some(){last.output_generation=Some(0);}}
            bindings.insert(new_id,binding.binding.clone());value=serde_json::to_value(binding).map_err(|_|invalid("project_transform_binding_invalid"))?;
        }else if key=="display" {
            if let Some(columns)=value.get_mut("columns").and_then(Value::as_object_mut){let old=std::mem::take(columns);for (id,props) in old{columns.insert(id_map.get(&id).cloned().unwrap_or_else(||uuid::Uuid::new_v4().to_string()),props);}}
        }else if key=="filter" {if let Some(rules)=value.as_array_mut(){for rule in rules{rule["id"]=Value::String(uuid::Uuid::new_v4().to_string());}}}
        setting_ids.push(new_key.clone());patch.settings.push(ProjectSettingWrite{key:new_key,expected_revision:None,value});
    }
    // Preserve the destination's unrelated lineage and project the copied Transform links.
    let current=catalog.get_setting("lineage")?;let mut lineage=match current.as_ref().filter(|(_,v)|!v.is_null()){Some((_,v))=>serde_json::from_value(v.clone()).map_err(|_|invalid("project_lineage_invalid"))?,None=>super::workflow_domain::ProjectLineageGraph::default()};
    let service=super::table_transform_service::TableTransformService::new(engine);
    for definition in &transforms{lineage=service.build_lineage(definition,bindings.get(&definition.id).ok_or_else(||invalid("project_transform_binding_missing"))?,&lineage)?;}
    patch.settings.push(ProjectSettingWrite{key:"lineage".into(),expected_revision:current.map(|(r,_)|r),value:serde_json::to_value(lineage).map_err(|_|invalid("project_lineage_invalid"))?});setting_ids.push("lineage".into());
    catalog.apply_patch(&patch)?;
    let table_ids:Vec<_>=destinations.iter().map(|d|d.id.clone()).collect();let topology=super::project_topology::read_topology(engine,epoch)?;if !topology.diagnostics.is_empty(){return Err(invalid("project_topology_invalid"));}
    super::project_group_history::group_creations(engine,&topology,&table_ids,&events)?;
    if cancelled(){return Err(AppError::Cancelled("project_group_copy_cancelled".into()));}
    Ok(CommitEffects{value:ProjectGroupCopyResult{table_ids:table_ids.clone(),id_map},dataset_ids:table_ids,document_ids,setting_ids})
}
impl ProjectDatabase {
    pub fn copy_table_group(&self,context:&ProjectWriteContext,request:&ProjectGroupMoveRequest,cancelled:impl Fn()->bool)->Result<ProjectCommit<ProjectGroupCopyResult>,AppError>{
        self.commit_with_effects(context,&("copy_project_table_group",request),|engine|{
            if request.expected_topology_revision!=context.expected_revision{return Err(invalid("project_topology_revision_stale"));}
            let records=capture_group(engine,context.expected_epoch,&request.target_table_id)?;copy_records(engine,context.expected_epoch,&records,&GroupRows::Native,&request.destination_folder,&cancelled)
        })
    }
}

#[cfg(all(test,feature="project-v5"))]
pub(crate) mod tests {
    use crate::{models::project_persistence::*,services::{project_database::ProjectDatabase,project_group_operations::tests::{context,create_subset},project_output::{ProjectSqlOutput,ProjectTransformCreate},project_catalog::ProjectCatalog,table_transform_domain::TableTransformDraft,table_transform_service::TableTransformInputBinding,project_transaction::CommitEffects,calculated_column_service::{CalculatedColumnService,UpsertCalculatedColumnInput}},state::AppState};
    use serde_json::{json,Value};
    pub(crate) fn fixture()->(tempfile::TempDir,ProjectDatabase,Vec<String>){
        let dir=tempfile::tempdir().unwrap();let db=ProjectDatabase::create(&dir.path().join("copy.spprj"),false).unwrap();
        let mut ids=vec![];for (name,group) in [("A","A"),("X","B"),("unrelated","C")] {
            let sql=format!("SELECT 42::DOUBLE AS value,2::DOUBLE AS factor,'{group}' AS grp");ids.push(db.materialize_project_sql(&context(&db,name),&ProjectSqlOutput{name:name.into(),sql,folder:String::new()}).unwrap().value.id);
        }
        let state=AppState::new().unwrap();db.commit_with_effects(&context(&db,"calculated"),&"calculated",|e|{
            CalculatedColumnService::new(&state).upsert_in_transaction(e,&UpsertCalculatedColumnInput{dataset_id:ids[0].clone(),output_name:"doubled".into(),formula_text:"[value] * 2".into(),at_index:None,output_column_id:None,formula_id:None,expected_generation:Some(0)})?;
            Ok(CommitEffects{value:(),dataset_ids:vec![ids[0].clone()],document_ids:vec![],setting_ids:vec![]})
        }).unwrap();
        let mut ctx=context(&db,"join");ctx.dataset_generations=db.with_engine(|e|Ok(vec![DatasetGeneration{id:ids[0].clone(),generation:e.get_dataset_generation(&ids[0])?},DatasetGeneration{id:ids[1].clone(),generation:e.get_dataset_generation(&ids[1])?}])).unwrap();
        let joined=db.create_project_transform(&ctx,&ProjectTransformCreate{draft:serde_json::from_value::<TableTransformDraft>(json!({"name":"Join","outputName":"B","operation":{"kind":"join","joinType":"inner","leftKey":"value","rightKey":"value"}})).unwrap(),inputs:vec![TableTransformInputBinding{role:"left".into(),table_document_id:ids[0].clone()},TableTransformInputBinding{role:"right".into(),table_document_id:ids[1].clone()}],folder:String::new()}).unwrap();
        ids.push(joined.value.definition.output.table_document_id.clone());let subset=create_subset(&db,&ids[3],"C").unwrap();ids.push(subset.value.definition.output.table_document_id);
        db.with_engine(|e|{
            let columns=e.get_user_column_descriptors(&ids[3])?;let column=|name:&str|columns.iter().find(|c|c.name==name).unwrap().column_id.clone();
            let mut docs:Vec<Value>=serde_json::from_str(include_str!("../../../tests/fixtures/project-table-groups/documents.json")).unwrap();
            fn bind(value:&mut Value,table:&str,columns:&[(&str,String)]){match value{Value::String(s)=>{if s=="@table"{*s=table.into();}else if let Some((_,id))=columns.iter().find(|(key,_)|s==key){*s=id.clone();}},Value::Array(a)=>for v in a{bind(v,table,columns)},Value::Object(o)=>for v in o.values_mut(){bind(v,table,columns)},_=>{}}}
            let replacements=[("@value",column("value")),("@factor",column("factor")),("@group",column("grp"))];
            let mut patch=ProjectRecordPatch::default();
            for doc in &mut docs{bind(doc,&ids[3],&replacements);let kind=if doc.get("documentType").and_then(Value::as_str)==Some("analysis"){ProjectDocumentKind::Analysis}else{doc["name"]=json!(column("value"));ProjectDocumentKind::GraphNew};
                patch.documents.push(DocumentWrite{expected_revision:None,document:ProjectDocumentBody{summary:ProjectDocumentSummary{id:doc["id"].as_str().unwrap().into(),kind,name:doc["name"].as_str().unwrap().into(),folder:String::new(),revision:1,dependencies:vec![ids[3].clone()],analysis_kind:doc.get("analysisKind").and_then(Value::as_str).map(str::to_string)},schema_version:1,body:doc.clone()}});
            }
            patch.documents.push(DocumentWrite{expected_revision:None,document:ProjectDocumentBody{summary:ProjectDocumentSummary{id:"tabulate".into(),kind:ProjectDocumentKind::Tabulate,name:"Tabulate".into(),folder:String::new(),revision:1,dependencies:vec![ids[3].clone()],analysis_kind:None},schema_version:1,body:json!({"id":"tabulate","name":"Tabulate","sourceDatasetId":ids[3],"rowFields":[{"name":"grp","columnId":column("grp"),"type":"nominal"}],"columnFields":[],"statistics":[],"includeRowTotals":true,"includeColumnTotals":true})}});
            patch.settings=vec![ProjectSettingWrite{key:format!("filter:{}",ids[3]),expected_revision:None,value:json!([{"id":"filter-rule","op":"AND","rule":{"kind":"continuous","field":{"name":"value","columnId":column("value"),"type":"continuous"},"min":0,"max":100}}])},ProjectSettingWrite{key:format!("display:{}",ids[3]),expected_revision:None,value:json!({"version":1,"columns":{column("value"):{"width":177}}})}];
            ProjectCatalog::new(e).apply_patch(&patch)?;Ok(())
        }).unwrap();(dir,db,ids)
    }
    #[test]
    fn project_linked_groups_copy_remaps_complete_component_and_preserves_configs(){
        let (_dir,db,ids)=fixture();let request=crate::models::project_topology::ProjectGroupMoveRequest{target_table_id:ids[3].clone(),destination_folder:"copied".into(),expected_topology_revision:db.committed_revision().unwrap()};let ctx=context(&db,"copy-group");let copied=db.copy_table_group(&ctx,&request,||false).unwrap();
        assert_eq!(copied.value.table_ids.len(),4);assert!(!copied.value.id_map.contains_key(&ids[2]));assert_eq!(db.with_engine(|e|e.list_datasets()).unwrap().len(),9);
        let new_b=&copied.value.id_map[&ids[3]];let graph_id=&copied.value.id_map["graph-new"];
        db.with_reader(db.epoch(),|e|{
            let graph=ProjectCatalog::new(e).get_document(graph_id,1)?;assert_eq!(graph.body["datasetId"],new_b.as_str());assert_eq!(graph.body["camera"]["yMax"],50);assert_eq!(graph.body["hiddenOverlayGroupIds"],json!([format!("sha256:{}","a".repeat(64))]));assert_eq!(graph.body["layers"].as_array().unwrap().len(),2);assert_ne!(graph.body["layers"][0]["id"],"layer-0");
            let source_columns=e.get_user_column_descriptors(&ids[3])?;let old=source_columns.iter().find(|c|c.name=="value").unwrap();assert_eq!(graph.summary.name,old.column_id,"literal user name equal to an old ID is not an identity reference");assert_eq!(graph.body["yColumnId"],copied.value.id_map[&old.column_id]);
            for old_id in ["distribution","fit-y","fit-model","hypothesis","tabulate"]{let doc=ProjectCatalog::new(e).get_document(&copied.value.id_map[old_id],1)?;assert_eq!(doc.summary.dependencies,vec![new_b.clone()]);assert_eq!(doc.summary.folder,"copied");}
            let filter=ProjectCatalog::new(e).get_setting(&format!("filter:{new_b}"))?.unwrap().1;assert_eq!(filter[0]["rule"]["field"]["columnId"],copied.value.id_map[&old.column_id]);
            let display=ProjectCatalog::new(e).get_setting(&format!("display:{new_b}"))?.unwrap().1;assert_eq!(display["columns"][&copied.value.id_map[&old.column_id]]["width"],177);
            let value:f64=e.conn().query_row(&format!("SELECT value FROM {}",crate::engine::duckdb_engine::DuckDbEngine::quote_identifier(&crate::engine::duckdb_engine::DuckDbEngine::internal_table_name(new_b))),[],|r|r.get(0))?;assert_eq!(value,42.0);
            let plans=e.get_archive_column_plans(&copied.value.id_map[&ids[0]])?;assert!(plans.iter().find(|c|c.name=="doubled").unwrap().calculated.is_some());Ok(())
        }).unwrap();
        assert_eq!(db.copy_table_group(&ctx,&request,||false).unwrap().value.id_map,copied.value.id_map,"lost response reuses copied IDs");
        let path=db.path().to_path_buf();db.shutdown().unwrap();let reopened=ProjectDatabase::open(&path,false).unwrap();assert_eq!(reopened.with_reader(reopened.epoch(),|e|super::super::project_topology::read_topology(e,reopened.epoch())?.component(new_b)).unwrap().len(),4);
    }
    #[test]
    fn project_linked_groups_copy_cancellation_and_commit_failure_publish_nothing(){
        let (_dir,db,ids)=fixture();let req=crate::models::project_topology::ProjectGroupMoveRequest{target_table_id:ids[0].clone(),destination_folder:String::new(),expected_topology_revision:db.committed_revision().unwrap()};
        assert!(db.copy_table_group(&context(&db,"cancelled-copy"),&req,||true).is_err());assert_eq!(db.with_engine(|e|e.list_datasets()).unwrap().len(),5);
        super::super::project_transaction::inject_commit_failure_for_test(1);assert!(db.copy_table_group(&context(&db,"failed-copy"),&req,||false).is_err());assert_eq!(db.with_engine(|e|e.list_datasets()).unwrap().len(),5);
    }
    #[test]
    fn project_linked_groups_copy_undo_is_whole_component_and_respects_external_references(){
        for external in [false,true]{
            let (_dir,db,ids)=fixture();let copied=db.copy_table_group(&context(&db,"copy-undo"),&crate::models::project_topology::ProjectGroupMoveRequest{target_table_id:ids[3].clone(),destination_folder:"copied".into(),expected_topology_revision:db.committed_revision().unwrap()},||false).unwrap();
            assert_eq!(copied.changed_history_entries.iter().filter(|h|h.operation=="create_table").count(),1);
            if external {db.with_engine(|e|{e.conn().execute("INSERT INTO _project_directory VALUES ('outside-report','report','Outside','',1,?)",[json!([copied.value.id_map["graph-new"]]).to_string()])?;e.conn().execute("INSERT INTO _project_documents VALUES ('outside-report',1,1,'{}')",[])?;Ok(())}).unwrap();}
            let root=copied.changed_history_entries.iter().find(|h|h.operation=="create_table").unwrap().id.clone();let path=db.path().to_path_buf();db.shutdown().unwrap();let state=AppState::new().unwrap();let service=super::super::project_native_service::NativeProjectService::new(&state);let opened=service.open(&path,false).unwrap();let db=service.database(opened.epoch).unwrap();let event=service.table_lifecycle_event(opened.epoch,&root).unwrap();let mut undo=context(&db,"undo-copy");undo.dataset_generations=vec![DatasetGeneration{id:event.dataset_id.clone(),generation:event.dataset_generation.unwrap()}];
            let result=service.apply_table_lifecycle(&undo,&root,event.revision,true);
            if external {assert!(result.is_err(),"undoing a copy must not break an external report");assert_eq!(db.with_engine(|e|e.list_datasets()).unwrap().len(),9);}
            else{result.unwrap();assert_eq!(db.with_engine(|e|e.list_datasets()).unwrap().len(),5);let event=service.table_lifecycle_event(opened.epoch,&root).unwrap();service.apply_table_lifecycle(&context(&db,"redo-copy"),&root,event.revision,false).unwrap();assert_eq!(db.with_engine(|e|e.list_datasets()).unwrap().len(),9);}
        }
    }
    #[test]
    fn project_linked_groups_copy_formula_recomputation_and_rerun_use_copied_inputs(){
        let (_dir,db,ids)=fixture();let copied=db.copy_table_group(&context(&db,"copy-rerun"),&crate::models::project_topology::ProjectGroupMoveRequest{target_table_id:ids[3].clone(),destination_folder:"copied".into(),expected_topology_revision:db.committed_revision().unwrap()},||false).unwrap().value;
        let join_id=db.with_reader(db.epoch(),|e|Ok(super::super::project_topology::read_topology(e,db.epoch())?.transforms.into_iter().find(|t|t.output_table_id==copied.id_map[&ids[3]]).unwrap().id)).unwrap();
        let path=db.path().to_path_buf();db.shutdown().unwrap();let state=AppState::new().unwrap();let service=super::super::project_native_service::NativeProjectService::new(&state);let opened=service.open(&path,false).unwrap();let db=service.database(opened.epoch).unwrap();
        let new_a=&copied.id_map[&ids[0]];let mut edit=context(&db,"edit-copied-input");edit.dataset_generations=vec![DatasetGeneration{id:new_a.clone(),generation:0}];service.update_cells(&edit,new_a,&[crate::models::table::CellUpdate{row_id:1,column_name:"value".into(),value:Some("99".into())}],Some(0)).unwrap();
        db.with_reader(opened.epoch,|e|{let quoted=|id:&str|crate::engine::duckdb_engine::DuckDbEngine::quote_identifier(&crate::engine::duckdb_engine::DuckDbEngine::internal_table_name(id));let copied_value:f64=e.conn().query_row(&format!("SELECT doubled FROM {}",quoted(new_a)),[],|r|r.get(0))?;let original:f64=e.conn().query_row(&format!("SELECT doubled FROM {}",quoted(&ids[0])),[],|r|r.get(0))?;assert_eq!(copied_value,198.0);assert_eq!(original,84.0);Ok(())}).unwrap();
        let document=service.get_document(opened.epoch,&join_id,1).unwrap();let definition=serde_json::from_value(document.body).unwrap();let binding:super::super::table_transform_service::PersistedTableTransformBinding=serde_json::from_value(service.get_setting(opened.epoch,&format!("transformBinding:{join_id}")).unwrap().unwrap().value).unwrap();let mut run=context(&db,"rerun-copied-join");run.document_revisions=vec![DocumentRevision{id:join_id.clone(),revision:1}];run.dataset_generations=db.with_engine(|e|binding.binding.inputs.iter().map(|i|i.table_document_id.as_str()).chain(std::iter::once(copied.id_map[&ids[3]].as_str())).map(|id|Ok(DatasetGeneration{id:id.into(),generation:e.get_dataset_generation(id)?})).collect()).unwrap();
        let result=service.run_transform(&run,&definition,&binding.binding,None).unwrap();assert_eq!(result.value.execution.output.unwrap().row_count,0,"join must use edited copied A, not original A");assert_eq!(db.with_engine(|e|e.get_dataset_meta(&ids[3])).unwrap().row_count,1);
    }

}
