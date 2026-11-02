//! Self-contained native group files built from a consistent selected-data snapshot.
use std::{collections::BTreeMap,path::Path};
use crate::{engine::duckdb_engine::DuckDbEngine,error::AppError,models::{project_persistence::*,project_topology::*}};
use super::{project_database::ProjectDatabase,project_group_copy::{self,GroupRecords,GroupRows}};
fn invalid(code:&str)->AppError{AppError::InvalidParam(code.into())}
fn cancelled(check:&dyn Fn()->bool)->Result<(),AppError>{if check(){Err(AppError::Cancelled("project_group_transfer_cancelled".into()))}else{Ok(())}}
fn literal(path:&Path)->Result<String,AppError>{Ok(format!("'{}'",path.to_str().ok_or_else(||invalid("project_path_invalid"))?.replace('\'',"''")))}
/// Only selected managed rows enter owned staging. Non-scalar values use the
/// existing lossless archive cell representation, never Parquet's implicit casts.
fn stage_rows(engine:&DuckDbEngine,records:&GroupRecords,root:&Path,check:&dyn Fn()->bool)->Result<GroupRows,AppError>{
    let mut paths=BTreeMap::new();
    for (index,table) in records.tables.iter().enumerate(){
        cancelled(check)?;let file=root.join(format!("table-{index}.parquet"));let file_sql=literal(&file)?;
        let physical=DuckDbEngine::quote_identifier(&DuckDbEngine::internal_table_name(&table.doc.id));
        let encoded=std::iter::once("\"_row_id\"".to_string()).chain(table.doc.columns.iter().map(|c|format!("{} AS {}",super::archive_cell::archive_export_expression(&c.name,&c.col_type),DuckDbEngine::quote_identifier(&c.name)))).chain(std::iter::once("CAST(\"_row_order\" AS VARCHAR) AS \"_row_order\"".into())).collect::<Vec<_>>().join(",");
        let count:i64=engine.conn().query_row(&format!("COPY (SELECT {encoded} FROM {physical}) TO {file_sql} (FORMAT PARQUET,COMPRESSION ZSTD)"),[],|r|r.get(0))?;
        if count!=table.row_count{return Err(invalid("project_group_table_count_inconsistent"));}
        cancelled(check)?;
        let columns=std::iter::once("_row_id").chain(table.doc.columns.iter().map(|c|c.name.as_str())).chain(std::iter::once("_row_order")).map(DuckDbEngine::quote_identifier).collect::<Vec<_>>().join(",");
        let restored=project_group_copy::restore_projection(engine,&table.doc)?;
        let original=format!("SELECT {columns} FROM {physical}");let decoded=format!("SELECT {restored} FROM read_parquet({file_sql})");
        // Verify exact multiset equivalence (including row identities/order) in
        // both directions. Unsupported round trips fail before publication.
        let different:bool=engine.conn().query_row(&format!("SELECT EXISTS(SELECT 1 FROM (({original} EXCEPT ALL {decoded}) UNION ALL ({decoded} EXCEPT ALL {original})) AS differences)"),[],|r|r.get(0))?;
        if different{return Err(invalid("project_group_type_not_lossless"));}paths.insert(table.doc.id.clone(),file);
    }
    Ok(GroupRows::Parquet(paths))
}
fn internal_context(database:&ProjectDatabase)->Result<ProjectWriteContext,AppError>{
    Ok(ProjectWriteContext{operation_id:uuid::Uuid::new_v4().to_string(),expected_project_id:database.header()?.project_id,expected_epoch:database.epoch(),expected_revision:database.committed_revision()?,request_digest:String::new(),document_revisions:vec![],dataset_generations:vec![]})
}
impl ProjectDatabase {
    pub fn export_table_group(&self,epoch:u64,request:&ProjectGroupExportRequest,check:impl Fn()->bool)->Result<ProjectGroupTransferResult,AppError>{
        cancelled(&check)?;let destination=Path::new(&request.file_path);if destination.exists(){return Err(invalid("project_destination_exists"));}
        let parent=destination.parent().filter(|p|!p.as_os_str().is_empty()).unwrap_or(Path::new("."));let workspace=tempfile::Builder::new().prefix(".sp-group-").tempdir_in(parent)?;
        let (records,rows)=self.with_reader(epoch,|engine|{
            let records=project_group_copy::capture_group(engine,epoch,&request.target_table_id)?;
            if records.revision!=request.expected_topology_revision{return Err(invalid("project_topology_revision_stale"));}
            let rows=stage_rows(engine,&records,workspace.path(),&check)?;Ok((records,rows))
        })?;
        cancelled(&check)?;let staged=workspace.path().join("group.spprj");let database=ProjectDatabase::create(&staged,false)?;let context=internal_context(&database)?;
        database.commit_with_effects(&context,&("export_project_table_group",request),|engine|project_group_copy::copy_records(engine,database.epoch(),&records,&rows,"",&check))?;
        database.with_reader(database.epoch(),|engine|super::project_catalog::ProjectCatalog::new(engine).validate_metadata())?;database.prepare_close(database.epoch())?;
        cancelled(&check)?;std::fs::File::open(&staged)?.sync_all()?;
        // Same-parent staging permits atomic no-clobber publication; no source
        // project copy or overwrite is ever used as an export shortcut.
        std::fs::hard_link(&staged,destination)?;
        #[cfg(unix)] std::fs::File::open(parent)?.sync_all()?;
        Ok(ProjectGroupTransferResult{file_path:request.file_path.clone(),table_count:records.tables.len(),source_revision:records.revision})
    }
    pub fn import_table_group(&self,context:&ProjectWriteContext,request:&ProjectGroupImportRequest,check:impl Fn()->bool)->Result<ProjectCommit<ProjectGroupCopyResult>,AppError>{
        let operation=("import_project_table_group",request);
        if let Some(receipt)=self.preflight_commit::<ProjectGroupCopyResult,_>(context,&operation)?{return Ok(receipt);}
        cancelled(&check)?;let path=Path::new(&request.file_path);
        if same_file::is_same_file(path,self.path())?{return Err(invalid("project_group_import_source_is_destination"));}
        let source=ProjectDatabase::open(path,true)?;let workspace=tempfile::Builder::new().prefix("sp-group-import-").tempdir()?;
        let staged=source.with_reader(source.epoch(),|engine|{
            let topology=super::project_topology::read_topology(engine,source.epoch())?;let first=topology.tables.first().ok_or_else(||invalid("project_group_import_empty"))?;
            if topology.component(&first.id)?.len()!=topology.tables.len(){return Err(invalid("project_group_import_requires_single_component"));}
            let unsupported:i64=engine.conn().query_row("SELECT count(*) FROM _project_directory WHERE kind NOT IN ('table','transform','graph','graphNew','analysis','tabulate','folder')",[],|r|r.get(0))?;
            if unsupported!=0{return Err(invalid("project_group_contains_project_records"));}
            let records=project_group_copy::capture_group(engine,source.epoch(),&first.id)?;let rows=stage_rows(engine,&records,workspace.path(),&check)?;Ok((records,rows))
        });source.shutdown()?;let (records,rows)=staged?;cancelled(&check)?;
        self.commit_with_effects(context,&operation,|engine|project_group_copy::copy_records(engine,context.expected_epoch,&records,&rows,&request.destination_folder,&check))
    }
}

#[cfg(all(test,feature="project-v5"))]
mod tests {
    use crate::{models::project_persistence::*,services::{project_database::ProjectDatabase,project_group_copy::tests::fixture,project_group_operations::tests::context,project_output::ProjectSqlOutput}};
    #[test]
    fn project_linked_groups_transfer_native_roundtrip_excludes_unrelated_tables(){
        let (dir,source,ids)=fixture();let target=dir.path().join("group.spprj");let request=crate::models::project_topology::ProjectGroupExportRequest{target_table_id:ids[3].clone(),file_path:target.to_str().unwrap().into(),expected_topology_revision:source.committed_revision().unwrap()};
        let exported=source.export_table_group(source.epoch(),&request,||false).unwrap();assert_eq!(exported.table_count,4);
        let packaged=ProjectDatabase::open(&target,true).unwrap();packaged.with_reader(packaged.epoch(),|e|{let tables=e.list_datasets()?;assert_eq!(tables.len(),4);assert!(!tables.iter().any(|t|t.name=="unrelated"));let topology=crate::services::project_topology::read_topology(e,packaged.epoch())?;assert!(topology.diagnostics.is_empty());assert_eq!(topology.transforms.len(),2);assert_eq!(topology.owned_documents.len(),6);Ok(())}).unwrap();let packaged_b=packaged.with_reader(packaged.epoch(),|e|Ok(e.list_datasets()?.into_iter().find(|t|t.name.starts_with("B")).unwrap().id)).unwrap();packaged.shutdown().unwrap();
        let destination=ProjectDatabase::create(&dir.path().join("destination.spprj"),false).unwrap();destination.materialize_project_sql(&context(&destination,"collision"),&ProjectSqlOutput{name:"A".into(),sql:"SELECT 1 AS value".into(),folder:String::new()}).unwrap();
        let request=crate::models::project_topology::ProjectGroupImportRequest{file_path:target.to_str().unwrap().into(),destination_folder:"imported".into()};let ctx=context(&destination,"import");let imported=destination.import_table_group(&ctx,&request,||false).unwrap();assert_eq!(imported.value.table_ids.len(),4);assert_eq!(destination.with_engine(|e|e.list_datasets()).unwrap().len(),5);
        assert_eq!(destination.import_table_group(&ctx,&request,||false).unwrap().value.id_map,imported.value.id_map);
        assert_eq!(source.with_engine(|e|e.list_datasets()).unwrap().len(),5);
        let imported_b=imported.value.id_map[&packaged_b].clone();
        let path=destination.path().to_path_buf();destination.shutdown().unwrap();
        let state=crate::state::AppState::new().unwrap();let service=crate::services::project_native_service::NativeProjectService::new(&state);let opened=service.open(&path,false).unwrap();let db=service.database(opened.epoch).unwrap();
        let topology=db.with_reader(opened.epoch,|e|crate::services::project_topology::read_topology(e,opened.epoch)).unwrap();let link=topology.transforms.iter().find(|t|t.output_table_id==imported_b).unwrap();
        let definition=serde_json::from_value(service.get_document(opened.epoch,&link.id,link.revision).unwrap().body).unwrap();
        let binding:crate::services::table_transform_service::PersistedTableTransformBinding=serde_json::from_value(service.get_setting(opened.epoch,&format!("transformBinding:{}",link.id)).unwrap().unwrap().value).unwrap();
        let mut run=context(&db,"rerun-imported");run.document_revisions=vec![DocumentRevision{id:link.id.clone(),revision:link.revision}];run.dataset_generations=db.with_engine(|e|binding.binding.inputs.iter().map(|i|i.table_document_id.as_str()).chain(std::iter::once(imported_b.as_str())).map(|id|Ok(DatasetGeneration{id:id.into(),generation:e.get_dataset_generation(id)?})).collect()).unwrap();
        assert_eq!(service.run_transform(&run,&definition,&binding.binding,None).unwrap().value.execution.output.unwrap().row_count,1);

    }
    #[test]
    fn project_linked_groups_transfer_preserves_exact_non_scalar_values_and_column_roles(){
        let dir=tempfile::tempdir().unwrap();let source=ProjectDatabase::create(&dir.path().join("types.spprj"),false).unwrap();let table=source.materialize_project_sql(&context(&source,"types"),&ProjectSqlOutput{name:"Exact types".into(),sql:"SELECT 170141183460469231731687303715884105727::HUGEINT AS huge,12345678901234567890.123456789012345678::DECIMAL(38,18) AS amount,INTERVAL '1 year 2 days 3 microseconds' AS duration,from_hex('0001ff') AS bytes,[1,NULL,3]::INTEGER[] AS numbers,struct_pack(label:='a''b',score:=7) AS info".into(),folder:String::new()}).unwrap().value.id;
        source.with_engine(|e|{e.conn().execute("UPDATE _meta_columns SET role='ordinal' WHERE dataset_id=? AND col_index=0",[&table])?;Ok(())}).unwrap();
        let target=dir.path().join("typed-group.spprj");source.export_table_group(source.epoch(),&crate::models::project_topology::ProjectGroupExportRequest{target_table_id:table.clone(),file_path:target.to_str().unwrap().into(),expected_topology_revision:source.committed_revision().unwrap()},||false).unwrap();
        let packaged=ProjectDatabase::open(&target,true).unwrap();packaged.with_reader(packaged.epoch(),|e|{let id=e.list_datasets()?[0].id.clone();let sql=format!("SELECT CAST(huge AS VARCHAR),CAST(amount AS VARCHAR),hex(bytes),numbers[2] IS NULL,info.label FROM {}",crate::engine::duckdb_engine::DuckDbEngine::quote_identifier(&crate::engine::duckdb_engine::DuckDbEngine::internal_table_name(&id)));let values:(String,String,String,bool,String)=e.conn().query_row(&sql,[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?)))?;assert_eq!(values,("170141183460469231731687303715884105727".into(),"12345678901234567890.123456789012345678".into(),"0001FF".into(),true,"a'b".into()));let role:String=e.conn().query_row("SELECT role FROM _meta_columns WHERE dataset_id=? AND col_index=0",[&id],|r|r.get(0))?;assert_eq!(role,"ordinal");Ok(())}).unwrap();
    }
    #[test]
    fn project_linked_groups_transfer_cancel_collision_stale_and_readonly(){
        let (dir,source,ids)=fixture();let file=dir.path().join("cancel.spprj");let mut request=crate::models::project_topology::ProjectGroupExportRequest{target_table_id:ids[0].clone(),file_path:file.to_str().unwrap().into(),expected_topology_revision:source.committed_revision().unwrap()};
        assert!(source.export_table_group(source.epoch(),&request,||true).is_err());assert!(!file.exists());
        request.expected_topology_revision-=1;assert!(source.export_table_group(source.epoch(),&request,||false).is_err());assert!(!file.exists());request.expected_topology_revision+=1;
        std::fs::write(&file,b"existing user file").unwrap();assert!(source.export_table_group(source.epoch(),&request,||false).is_err());assert_eq!(std::fs::read(&file).unwrap(),b"existing user file");
        let source_path=source.path().to_path_buf();source.shutdown().unwrap();let readonly=ProjectDatabase::open(&source_path,true).unwrap();request.file_path=dir.path().join("readonly-export.spprj").to_str().unwrap().into();readonly.export_table_group(readonly.epoch(),&request,||false).unwrap();
        let import=crate::models::project_topology::ProjectGroupImportRequest{file_path:request.file_path,destination_folder:String::new()};let destination=ProjectDatabase::create(&dir.path().join("cancel-import.spprj"),false).unwrap();assert!(destination.import_table_group(&context(&destination,"cancel-import"),&import,||true).is_err());assert!(destination.with_engine(|e|e.list_datasets()).unwrap().is_empty());
    }
    #[test]
    fn project_linked_groups_transfer_legacy_table_export_cannot_split_linked_component(){
        let (dir,source,ids)=fixture();let path=source.path().to_path_buf();source.shutdown().unwrap();let state=crate::state::AppState::new().unwrap();let native=crate::services::project_native_service::NativeProjectService::new(&state);native.open(&path,false).unwrap();let service=crate::services::project_service::ProjectService::new(&state);let out=dir.path().join("partial.sptb");
        assert!(service.export_table(&ids[3],out.to_str().unwrap()).is_err());assert!(!out.exists());
        let zip=dir.path().join("partial.zip");assert!(service.export_tables_sptb_zip(&[ids[0].clone(),ids[3].clone()],&std::collections::HashMap::new(),zip.to_str().unwrap()).is_err());assert!(!zip.exists());
    }
    #[test]
    fn project_linked_groups_transfer_invalid_future_and_dangling_sources_do_not_publish(){
        let (dir,source,ids)=fixture();let native=dir.path().join("valid.spprj");source.export_table_group(source.epoch(),&crate::models::project_topology::ProjectGroupExportRequest{target_table_id:ids[0].clone(),file_path:native.to_str().unwrap().into(),expected_topology_revision:source.committed_revision().unwrap()},||false).unwrap();
        let destination=ProjectDatabase::create(&dir.path().join("invalid-destination.spprj"),false).unwrap();let invalid=dir.path().join("invalid.spprj");std::fs::write(&invalid,b"not a database").unwrap();
        let future=dir.path().join("future.spprj");std::fs::copy(&native,&future).unwrap();let db=ProjectDatabase::open(&future,false).unwrap();db.with_engine(|e|{e.conn().execute("UPDATE _project_header SET format_version='99.0.0'",[])?;Ok(())}).unwrap();db.shutdown().unwrap();
        let broken=dir.path().join("dangling.spprj");std::fs::copy(&native,&broken).unwrap();let db=ProjectDatabase::open(&broken,false).unwrap();db.with_engine(|e|{let (key,json):(String,String)=e.conn().query_row("SELECT key,value_json FROM _project_settings WHERE starts_with(key,'transformBinding:') LIMIT 1",[],|r|Ok((r.get(0)?,r.get(1)?)))?;let mut value:serde_json::Value=serde_json::from_str(&json).unwrap();value["inputs"][0]["tableDocumentId"]=serde_json::json!("missing");e.conn().execute("UPDATE _project_settings SET value_json=? WHERE key=?",duckdb::params![value.to_string(),key])?;Ok(())}).unwrap();db.shutdown().unwrap();
        for (index,file) in [invalid,future,broken].iter().enumerate(){let before=std::fs::read(file).unwrap();let req=crate::models::project_topology::ProjectGroupImportRequest{file_path:file.to_str().unwrap().into(),destination_folder:String::new()};assert!(destination.import_table_group(&context(&destination,&format!("invalid-{index}")),&req,||false).is_err());assert_eq!(std::fs::read(file).unwrap(),before);assert!(destination.with_engine(|e|e.list_datasets()).unwrap().is_empty());}
    }

}
