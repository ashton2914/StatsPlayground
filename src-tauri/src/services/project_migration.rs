//! Explicit legacy migration publishes a new native project and preserves its source.
use std::{collections::HashMap, io::{Read,Write}, path::Path};
use crate::{error::AppError, models::{project::ProjectInfo,project_persistence::*}, state::AppState,
    engine::duckdb_engine::DuckDbEngine};
use super::{project_catalog::ProjectCatalog,project_database::ProjectDatabase,
    project_native_service::NativeProjectService,project_output::SourceStamp,
    project_table_import::NativeTableRestoreSink,spprj_archive::{self,OpenProjectArchive,ProjectArchiveTableSink,TableDoc,TableEntryRef},
    streaming_table_reader::{self,StreamedTableHeader,TableBatchSink}};
use duckdb::params;
use serde::{de::{Visitor,MapAccess,IgnoredAny,Error as _},Deserializer as _};

pub(crate) type MigrationProgressCallback<'a> = dyn Fn(usize,usize,&str,usize,usize)+'a;
pub(crate) const MIGRATION_PUBLISHED_PREFIX:&str="project_migration_destination_published:";
#[derive(Clone,Copy,PartialEq,Eq)]
enum MigrationPhase {AfterPreflight,BeforePublish,AfterPublish}

pub(crate) fn finish_migration_result(result:Result<ProjectOpenSummary,AppError>)->ProjectSnapshotOutcome {
    match result {
        Ok(active)=>ProjectSnapshotOutcome{active:Some(active),error:None,destination_published:true},
        Err(error)=>{
            let published=match &error {AppError::FileIO(message)=>message.strip_prefix(MIGRATION_PUBLISHED_PREFIX),_=>None};
            ProjectSnapshotOutcome{destination_published:published.is_some(),active:None,error:Some(published.map(|message|message.trim().to_owned()).unwrap_or_else(||error.to_string()))}
        }
    }
}

type MigrationPreflight=ProjectMigrationPreflight;

/// Stop after the version field. Content validation belongs to explicit migration.
fn read_format_version(reader:impl Read,legacy_json:bool)->Result<String,AppError> {
    struct VersionVisitor<'a>(&'a mut Option<String>);
    impl<'de> Visitor<'de> for VersionVisitor<'_> {
        type Value=();
        fn expecting(&self,formatter:&mut std::fmt::Formatter)->std::fmt::Result {formatter.write_str("project metadata object")}
        fn visit_map<A:MapAccess<'de>>(self,mut map:A)->Result<(),A::Error> {
            while let Some(key)=map.next_key::<String>()? {
                if key=="version" {
                    *self.0=Some(map.next_value::<String>()?);
                    return Err(A::Error::custom("project_version_header_complete"));
                }
                map.next_value::<IgnoredAny>()?;
            }
            Ok(())
        }
    }
    let mut found=None;
    let result=serde_json::Deserializer::from_reader(std::io::BufReader::new(reader)).deserialize_map(VersionVisitor(&mut found));
    if let Some(version)=found {return Ok(if legacy_json&&version.is_empty(){"1.0.0".into()}else{version});}
    result.map_err(|error|AppError::FileIO(error.to_string()))?;
    if legacy_json {Ok("1.0.0".into())}else{Err(invalid("project_header_missing"))}
}

pub(crate) struct ProjectMigrationService<'a> {state:&'a AppState}
impl<'a> ProjectMigrationService<'a> {
    pub(crate) fn new(state:&'a AppState)->Self {Self{state}}

    pub(crate) fn preflight(source:&Path,destination:Option<&Path>)->Result<MigrationPreflight,AppError> {
        super::project_schema::require_v5_capability()?;
        let format_version=match super::project_schema::detect_project_format(source)? {
            super::project_schema::ProjectFormat::DuckDb=>return Err(invalid("project_migration_legacy_source_required")),
            super::project_schema::ProjectFormat::LegacyJson=>read_format_version(std::fs::File::open(source)?,true)?,
            super::project_schema::ProjectFormat::LegacyZip=>{
                let mut archive=zip::ZipArchive::new(std::fs::File::open(source)?).map_err(|error|AppError::FileIO(error.to_string()))?;
                let manifest=archive.by_name("manifest.json").map_err(|error|AppError::FileIO(error.to_string()))?;
                read_format_version(manifest,false)?
            }
        };
        if super::project_service::is_future_project_format(&format_version) {
            return Err(invalid("project_version_unsupported"));
        }
        let destination=destination.map(Path::to_path_buf).unwrap_or_else(||source.with_file_name(format!("{}-v5.spprj",source.file_stem().unwrap_or_default().to_string_lossy())));
        if destination.exists() && same_file::is_same_file(source,&destination)? {return Err(invalid("project_migration_source_overwrite"));}
        Ok(MigrationPreflight{format_version,destination_exists:destination.exists(),destination,required_writer:1})
    }

    #[cfg(test)]
    pub(crate) fn migrate(&self,source:&Path,destination:&Path,progress:&MigrationProgressCallback<'_>)->Result<ProjectOpenSummary,AppError> {
        self.migrate_with_cancel(source,destination,progress,&||false)
    }

    pub(crate) fn migrate_with_cancel(&self,source:&Path,destination:&Path,progress:&MigrationProgressCallback<'_>,cancelled:&dyn Fn()->bool)->Result<ProjectOpenSummary,AppError> {
        self.migrate_with_hook(source,destination,progress,cancelled,&|_|Ok(()))
    }

    fn migrate_with_hook(&self,source:&Path,destination:&Path,progress:&MigrationProgressCallback<'_>,cancelled:&dyn Fn()->bool,hook:&dyn Fn(MigrationPhase)->Result<(),AppError>)->Result<ProjectOpenSummary,AppError> {
        super::project_schema::require_v5_capability()?;
        check_cancel(cancelled)?;
        let expected_owner=self.state.project_database.read().map_err(|_|AppError::Busy("project_transition_unavailable".into()))?.as_ref().map(|database|database.epoch());
        let stamp=SourceStamp::read(source)?;
        let preflight=Self::preflight(source,Some(destination))?;
        if preflight.destination_exists {return Err(invalid("project_destination_exists"));}
        hook(MigrationPhase::AfterPreflight)?;
        let mut archive=OpenProjectArchive::open(source.to_str().ok_or_else(||invalid("project_path_invalid"))?)?;
        if super::project_service::is_future_project_format(&archive.bundle.manifest.version){return Err(invalid("project_version_unsupported"));}
        let migration=spprj_archive::migrate_legacy_graph_filters(&archive.bundle.manifest.dataset_filters,&mut archive.bundle.graphs)?;
        archive.bundle.manifest.dataset_filters=migration.dataset_filters;
        if !migration.conflicts.is_empty() {return Err(invalid("project_migration_filter_conflict"));}
        super::project_service::normalize_visible_document_names(&mut archive.bundle);
        super::project_migration_analysis::normalize(&mut archive.bundle)?;
        super::project_service::normalize_visible_document_names(&mut archive.bundle);
        spprj_archive::refresh_project_lineage_graph(&mut archive.bundle)?;
        let parent=destination.parent().filter(|p|!p.as_os_str().is_empty()).unwrap_or(Path::new("."));
        let staged_path=tempfile::Builder::new().prefix(".sp-migrate-").suffix(".spprj").tempfile_in(parent)?.into_temp_path();
        std::fs::remove_file(&staged_path)?;
        let database=ProjectDatabase::create(&staged_path,false)?;
        let snapshots=std::mem::take(&mut archive.bundle.snapshots);
        database.with_engine(|engine| {for snapshot in snapshots {super::project_data_snapshot::import_legacy_snapshot(engine,snapshot,cancelled)?;} Ok(())})?;
        let table_folders=archive.bundle.manifest.table_folders.clone().unwrap_or_else(||archive.bundle.manifest.tables.iter().map(|entry|(entry.id.clone(),entry_folder(&entry.file,"tables"))).collect());
        let total=archive.bundle.tables.len();
        database.with_engine(|engine| {
            let mut sink=MigrationTables{engine,folders:&table_folders,cancelled,progress,index:0,total};
            archive.restore_tables(&mut sink)
        })?;
        let bundle=archive.bundle;
        check_cancel(cancelled)?;
        database.with_engine(|engine| {
            restore_history(engine,&bundle)?;
            super::project_migration_order::restore(engine)?;
            restore_history_order(engine,&bundle.history)?;
            let catalog=ProjectCatalog::new(engine);
            let mut patch=ProjectRecordPatch{created_folders:bundle.manifest.folders.clone(),..Default::default()};
            for graph in &bundle.graphs {
                let mut body=graph.body.clone();
                body.insert("id".into(),graph.id.clone().into());body.insert("name".into(),graph.name.clone().into());
                let folder=bundle.manifest.graph_folders.as_ref().and_then(|f|f.get(&graph.id)).cloned().unwrap_or_else(||bundle.manifest.graphs.iter().find(|entry|entry.id==graph.id).map(|entry|entry_folder(&entry.file,"graphs")).unwrap_or_default());
                add_document(&mut patch,ProjectDocumentKind::Graph,serde_json::Value::Object(body),folder)?;
            }
            for (kind,values,folders) in [
                (ProjectDocumentKind::GraphNew,&bundle.graph_builders_new,&bundle.manifest.graph_new_folders),
                (ProjectDocumentKind::Report,&bundle.reports,&bundle.manifest.report_folders),
                (ProjectDocumentKind::Analysis,&bundle.analyses,&bundle.manifest.analysis_folders),
                (ProjectDocumentKind::Tabulate,&bundle.tabulates,&bundle.manifest.tabulate_folders),
            ] {for value in values {let id=value.get("id").and_then(serde_json::Value::as_str).ok_or_else(||invalid("project_document_id_invalid"))?;add_document(&mut patch,kind,value.clone(),folders.get(id).cloned().unwrap_or_default())?;}}
            for workflow in &bundle.workflows {add_document(&mut patch,ProjectDocumentKind::Workflow,json(workflow)?,String::new())?;}
            for transform in &bundle.table_transforms {add_document(&mut patch,ProjectDocumentKind::Transform,json(transform)?,String::new())?;}
            for (id,filters) in &bundle.manifest.dataset_filters {patch.settings.push(setting(format!("filter:{id}"),json(filters)?));}
            patch.settings.push(setting("lineage".into(),json(&bundle.manifest.lineage_graph)?));
            patch.settings.push(setting("logicalFolders".into(),json(&bundle.manifest.logical_folders)?));
            for binding in &bundle.manifest.table_transform_bindings {patch.settings.push(setting(format!("transformBinding:{}",binding.definition_id),json(binding)?));}
            for run in &bundle.manifest.workflow_runs {patch.settings.push(setting(format!("workflowRun:{}",run.id),serde_json::json!({"run":run})));}
            catalog.apply_patch(&patch)?;
            catalog.validate_metadata()?;
            check_cancel(cancelled)
        })?;
        stamp.verify(source)?;
        database.prepare_close(database.epoch())?;
        std::fs::OpenOptions::new().read(true).write(true).open(&staged_path)?.sync_all()?;
        hook(MigrationPhase::BeforePublish)?;
        check_cancel(cancelled)?;
        let result=NativeProjectService::new(self.state).publish_migrated_with_hook(staged_path,destination,ProjectInfo{name:bundle.manifest.name,file_path:destination.to_string_lossy().into_owned(),created_at:bundle.manifest.created_at},expected_owner,&||{check_cancel(cancelled)?;stamp.verify(source)},&||hook(MigrationPhase::AfterPublish))?;
        progress(total,total,"",0,0);
        Ok(result)
    }
}

fn json(value:&impl serde::Serialize)->Result<serde_json::Value,AppError>{serde_json::to_value(value).map_err(|_|invalid("project_record_invalid"))}
fn invalid(code:&str)->AppError {AppError::InvalidParam(code.into())}
fn check_cancel(cancelled:&dyn Fn()->bool)->Result<(),AppError> {if cancelled(){Err(AppError::Cancelled("project_migration_cancelled".into()))}else{Ok(())}}
fn entry_folder(file:&str,prefix:&str)->String {
    spprj_archive::parent_folder(file).map(|folder|if folder==prefix {String::new()} else {folder.strip_prefix(&format!("{prefix}/")).unwrap_or(&folder).into()}).unwrap_or_default()
}
fn setting(key:String,value:serde_json::Value)->ProjectSettingWrite {ProjectSettingWrite{key,expected_revision:None,value}}
fn add_document(patch:&mut ProjectRecordPatch,kind:ProjectDocumentKind,body:serde_json::Value,folder:String)->Result<(),AppError> {
    let id=body.get("id").and_then(serde_json::Value::as_str).ok_or_else(||invalid("project_document_id_invalid"))?.to_owned();
    let name=body.get("name").and_then(serde_json::Value::as_str).ok_or_else(||invalid("project_name_invalid"))?.to_owned();
    let source=body.get("datasetId").or_else(||body.get("sourceDatasetId")).or_else(||body.pointer("/source/datasetId")).and_then(serde_json::Value::as_str);
    let dependencies=source.map(|id|vec![id.into()]).unwrap_or_default();
    let analysis_kind=body.get("analysisKind").and_then(serde_json::Value::as_str).map(str::to_owned);
    patch.documents.push(DocumentWrite{expected_revision:None,document:ProjectDocumentBody{summary:ProjectDocumentSummary{id,kind,name,folder,revision:1,dependencies,analysis_kind},schema_version:1,body}});
    Ok(())
}

struct MigrationTables<'a>{engine:&'a DuckDbEngine,folders:&'a HashMap<String,String>,cancelled:&'a dyn Fn()->bool,progress:&'a MigrationProgressCallback<'a>,index:usize,total:usize}
impl MigrationTables<'_> {
    fn finish(&mut self,sink:NativeTableRestoreSink<'_>)->Result<(),AppError> {
        let (meta,display)=sink.finish()?;
        let catalog=ProjectCatalog::new(self.engine);
        catalog.publish_table(&meta,self.folders.get(&meta.id).map(String::as_str).unwrap_or(""))?;
        if !display.is_empty(){catalog.apply_patch(&ProjectRecordPatch{settings:vec![setting(format!("display:{}",meta.id),super::project_column_settings::replacement(self.engine,&meta.id,&display)?)],..Default::default()})?;}
        let rows=usize::try_from(meta.row_count).map_err(|_|invalid("project_row_count_invalid"))?;
        (self.progress)(self.index,self.total,&meta.name,rows,rows);
        self.index+=1;
        Ok(())
    }
}
impl ProjectArchiveTableSink for MigrationTables<'_> {
    fn restore_streamed(&mut self,_entry:&TableEntryRef,header:&StreamedTableHeader,archive_header:&StreamedTableHeader,reader:&mut dyn Read)->Result<(),AppError> {
        check_cancel(self.cancelled)?;
        let doc=TableDoc{id:header.id.clone(),name:header.name.clone(),source_type:header.source_type.clone(),version:header.version.clone(),columns:header.columns.clone(),rows:vec![]};
        let mut sink=NativeTableRestoreSink::begin(self.engine,doc,self.cancelled)?;
        streaming_table_reader::stream_table_rows_unordered(reader,archive_header,&mut sink)?;
        self.finish(sink)
    }
    fn restore_buffered(&mut self,_entry:&TableEntryRef,doc:&TableDoc)->Result<(),AppError> {
        check_cancel(self.cancelled)?;
        let metadata=TableDoc{id:doc.id.clone(),name:doc.name.clone(),source_type:doc.source_type.clone(),version:doc.version.clone(),columns:doc.columns.clone(),rows:vec![]};
        let mut sink=NativeTableRestoreSink::begin(self.engine,metadata,self.cancelled)?;
        for rows in doc.rows.chunks(5000){sink.append_rows(rows)?;}
        self.finish(sink)
    }
}

fn restore_history(engine:&DuckDbEngine,bundle:&spprj_archive::ProjectBundle)->Result<(),AppError> {
    let mut generations=bundle.manifest.dataset_generations.clone().unwrap_or_default();
    if bundle.manifest.dataset_generations.is_none() {
        if let Some(timeline)=&bundle.history_timeline {for cursor in &timeline.metadata.datasets {generations.insert(cursor.dataset_id.clone(),cursor.current_generation);}}
        else if let Some(delta)=&bundle.delta_history {for change in &delta.metadata.change_sets {let generation=change.generation.max(change.before_generation).max(change.after_generation);generations.entry(change.dataset_id.clone()).and_modify(|value|*value=(*value).max(generation)).or_insert(generation);}}
    }
    for (id,generation) in generations {engine.get_dataset_meta(&id)?;engine.conn().execute("UPDATE _meta_datasets SET generation=? WHERE id=?",params![generation,&id])?;engine.rebuild_natural_anchors(&id,generation)?;}
    if let Some(delta)=&bundle.delta_history {
        let mut files=vec![];let mut snapshots=vec![];
        for (descriptor,bytes) in &delta.snapshots {let mut file=tempfile::NamedTempFile::new()?;file.write_all(bytes)?;file.as_file_mut().sync_all()?;snapshots.push((descriptor.clone(),file.path().to_path_buf()));files.push(file);}
        engine.restore_delta_history(&delta.metadata,&snapshots)?;
    }
    if let Some(timeline)=&bundle.history_timeline {
        let mut files=vec![];let mut snapshots=vec![];
        for (id,descriptor,bytes) in &timeline.snapshots {let mut file=tempfile::NamedTempFile::new()?;file.write_all(bytes)?;file.as_file_mut().sync_all()?;snapshots.push((id.clone(),descriptor.clone(),file.path().to_path_buf()));files.push(file);}
        engine.restore_unified_history(&timeline.metadata,&snapshots)?;
    }
    Ok(())
}

fn restore_history_order(engine:&DuckDbEngine,history:&[serde_json::Value])->Result<(),AppError> {
    use duckdb::OptionalExt;
    if history.is_empty(){return Ok(());}
    let conn=engine.conn();
    // Raw legacy records remain project-owned but are never part of ordinary open or paging.
    conn.execute_batch("CREATE TABLE _project_imported_history(sequence UBIGINT PRIMARY KEY,payload_json VARCHAR NOT NULL); CREATE TABLE _project_imported_history_summary(id VARCHAR PRIMARY KEY,dataset_id VARCHAR NOT NULL,description VARCHAR NOT NULL,timestamp VARCHAR); CREATE INDEX _project_imported_history_dataset ON _project_imported_history_summary(dataset_id,id)")?;
    for (index,record) in history.iter().enumerate() {
        let revision=u64::try_from(index).ok().and_then(|value|value.checked_add(1)).ok_or_else(||invalid("project_revision_exhausted"))?;
        conn.execute("INSERT INTO _project_imported_history VALUES(?,?)",params![revision,serde_json::to_string(record).map_err(|_|invalid("project_history_invalid"))?])?;
        let executable_id=if record.pointer("/action/kind").and_then(serde_json::Value::as_str)==Some("changeSet") {
            Some(record.pointer("/action/changeSetId").and_then(serde_json::Value::as_str).ok_or_else(||invalid("project_history_invalid"))?)
        } else {None};
        let entry:Option<ProjectHistorySummary>=if let Some(id)=executable_id {conn.query_row("SELECT h.change_set_id,h.dataset_id,h.operation,h.applied,m.generation,m.name FROM _history_timeline h JOIN _meta_datasets m ON m.id=h.dataset_id WHERE h.change_set_id=?",[id],|row|Ok(ProjectHistorySummary{id:row.get(0)?,dataset_id:row.get(1)?,operation:row.get(2)?,applied:row.get(3)?,generation:row.get(4)?,dataset_name:row.get(5)?,description:None,timestamp:None})).optional()?} else {None};
        if let Some(entry)=entry {
            if record.pointer("/action/datasetId").and_then(serde_json::Value::as_str)!=Some(entry.dataset_id.as_str()){return Err(invalid("project_history_dataset_mismatch"));}
            super::project_history_frontier::record(engine,revision,&[entry])?;
        } else {
            let description=record.get("description").and_then(serde_json::Value::as_str).unwrap_or("");
            if !description.is_empty() && description!="__init__" {
                let preview:String=description.chars().take(512).collect();
                let timestamp=record.get("timestamp").and_then(serde_json::Value::as_str).map(|value|value.chars().take(128).collect::<String>());
                let dataset=record.pointer("/action/datasetId").and_then(serde_json::Value::as_str).unwrap_or("");
                conn.execute("INSERT INTO _project_imported_history_summary VALUES(?,?,?,?)",params![format!("imported:{revision:020}"),dataset,preview,timestamp])?;
            }
        }
    }
    // Imported order occupies the initial revision range; later native commits follow it.
    conn.execute("UPDATE _project_header SET committed_revision=? WHERE singleton=TRUE",[history.len() as u64])?;
    Ok(())
}

#[cfg(all(test,feature="project-v5"))]
mod tests {
    use super::*;
    use crate::{services::project_native_service::NativeProjectService, state::AppState};
    use sha2::{Digest, Sha256};

    #[test]
    fn project_v5_migration_source_replacement_after_preflight_is_never_published() {
        let dir=tempfile::tempdir().unwrap();let source=dir.path().join("source.spprj");let destination=dir.path().join("converted.spprj");
        for replace_at in [MigrationPhase::AfterPreflight,MigrationPhase::BeforePublish] {for version in ["1.0.0","9.0.0"] {
            std::fs::write(&source,br#"{"name":"Original","version":"1.0.0","datasets":[]}"#).unwrap();
            let replacement=format!(r#"{{"name":"Replacement Changed","version":"{version}","datasets":[]}}"#);
            let state=AppState::new().unwrap();
            let result=ProjectMigrationService::new(&state).migrate_with_hook(&source,&destination,&|_,_,_,_,_|{},&||false,&|phase|{
                if phase==replace_at {std::fs::write(&source,&replacement)?;}
                Ok(())
            });
            let error=result.expect_err("preflight must not authorize a different source file's content");
            assert!(error.to_string().contains(if version=="9.0.0"&&replace_at==MigrationPhase::AfterPreflight{"project_version_unsupported"}else{"import_source_changed"}));
            assert!(!destination.exists());assert!(state.project_database.read().unwrap().is_none());
            assert_eq!(std::fs::read_to_string(&source).unwrap(),replacement,"an external source replacement belongs to its author and must not be reverted");
        }}
    }

    #[test]
    fn project_v5_migration_published_copy_survives_open_failure_with_live_owner_retained() {
        let dir=tempfile::tempdir().unwrap();let live_path=dir.path().join("live.spprj");let destination=dir.path().join("converted.spprj");
        let live_db=ProjectDatabase::create(&live_path,false).unwrap();live_db.prepare_close(live_db.epoch()).unwrap();
        let state=AppState::new().unwrap();let native=NativeProjectService::new(&state);let live=native.open(&live_path,false).unwrap();
        let before=Sha256::digest(std::fs::read(&live_path).unwrap());
        let temporary=tempfile::Builder::new().prefix(".sp-migrate-").suffix(".spprj").tempfile_in(dir.path()).unwrap().into_temp_path();
        std::fs::remove_file(&temporary).unwrap();let staged=ProjectDatabase::create(&temporary,false).unwrap();staged.prepare_close(staged.epoch()).unwrap();
        let project=ProjectInfo{name:"Converted".into(),file_path:destination.to_string_lossy().into_owned(),created_at:"today".into()};
        let result=native.publish_migrated_with_hook(temporary,&destination,project,Some(live.epoch),&||Ok(()),&||{
            assert!(destination.exists());Err(AppError::FileIO("injected destination open failure".into()))
        });
        let outcome=finish_migration_result(result);
        assert!(outcome.destination_published);assert!(outcome.active.is_none());assert!(outcome.error.unwrap().contains("injected destination open failure"));
        assert_eq!(state.project_database.read().unwrap().as_ref().unwrap().epoch(),live.epoch);
        let copy=ProjectDatabase::open(&destination,true).unwrap();assert_eq!(copy.header().unwrap().format_version,"5.0.0");copy.prepare_close(copy.epoch()).unwrap();
        native.close(live.epoch).unwrap();
        assert_eq!(Sha256::digest(std::fs::read(&live_path).unwrap()),before);
        let early=finish_migration_result(Err(AppError::FileIO("destination already exists".into())));assert!(!early.destination_published);
    }

    #[test]
    fn project_v5_migration_preflight_reads_only_metadata_before_explicit_conversion() {
        let dir=tempfile::tempdir().unwrap();
        for zip_format in [false,true] {
            let source=dir.path().join(if zip_format{"legacy-zip.spprj"}else{"legacy-json.spprj"});
            if zip_format {
                let mut archive=zip::ZipWriter::new(std::fs::File::create(&source).unwrap());
                archive.start_file("manifest.json",zip::write::SimpleFileOptions::default()).unwrap();
                archive.write_all(br#"{"name":"Legacy","version":"2.0.0","createdAt":"today","tables":[{"id":"table","name":"Data","file":"tables/Data.sptb"}]}"#).unwrap();
                archive.start_file("tables/Data.sptb",zip::write::SimpleFileOptions::default()).unwrap();
                archive.write_all(b"deliberately malformed table payload").unwrap();archive.finish().unwrap();
            } else {std::fs::write(&source,br#"{"name":"Legacy","version":"1.0.0","datasets":[deliberately malformed body"#).unwrap();}
            let before=Sha256::digest(std::fs::read(&source).unwrap());
            let preflight=ProjectMigrationService::preflight(&source,None).expect("preflight must inspect the format header without loading or validating table bodies");
            assert_eq!(preflight.format_version,if zip_format{"2.0.0"}else{"1.0.0"});
            let state=AppState::new().unwrap();
            assert!(ProjectMigrationService::new(&state).migrate(&source,&preflight.destination,&|_,_,_,_,_|{}).is_err(),"explicit migration must still validate the complete source before publication");
            assert!(!preflight.destination.exists());
            assert_eq!(Sha256::digest(std::fs::read(&source).unwrap()),before);
        }
    }

    #[test]
    fn project_v5_migration_historical_nested_v2_v3_without_generation_metadata() {
        use serde_json::json;
        let dir=tempfile::tempdir().unwrap();
        for version in ["2.0.0","3.0.0"] {
            let source=dir.path().join(format!("source-{version}.spprj"));let target=dir.path().join(format!("native-{version}.spprj"));
            let table:TableDoc=serde_json::from_value(json!({"id":"table","name":"Data","sourceType":"csv","version":"1","columns":[{"name":"Big","colType":"BIGINT","width":120},{"name":"Exact","colType":"DECIMAL(28,8)"}],"rows":[[77,9007199254740993_i64,"123456789.12345678"]]})).unwrap();
            let empty=HashMap::new();let assignments=HashMap::from([("table".into(),"Tables/Legacy".into())]);
            let mut bundle=spprj_archive::build_bundle("Legacy".into(),version.into(),"yesterday".into(),vec![table],vec![],vec![],vec![],vec![],vec![],vec![],vec!["Empty".into(),"Tables".into(),"Tables/Legacy".into()],&assignments,&empty,&empty,&empty,&empty,&empty,&empty,vec![],vec![]).unwrap();
            bundle.manifest.tables[0].file="tables/Tables/Legacy/Data.sptb".into();
            bundle.manifest.table_folders=None;bundle.manifest.dataset_generations=None;
            spprj_archive::write_legacy_project_archive_for_test(&bundle,source.to_str().unwrap()).unwrap();
            // Exercise reordered historical JSON independently of the normal serializer.
            let mut input=zip::ZipArchive::new(std::io::Cursor::new(std::fs::read(&source).unwrap())).unwrap();
            let mut output=zip::ZipWriter::new(std::fs::File::create(&source).unwrap());
            for index in 0..input.len() {
                let mut entry=input.by_index(index).unwrap();let mut bytes=vec![];entry.read_to_end(&mut bytes).unwrap();
                if entry.name().ends_with(".sptb") {
                    let mut table:serde_json::Value=serde_json::from_slice(&bytes).unwrap();
                    let rows=table.as_object_mut().unwrap().remove("rows").unwrap();let header=serde_json::to_string(&table).unwrap();
                    bytes=format!("{{\"rows\":{rows},{}",&header[1..]).into_bytes();
                }
                output.start_file(entry.name(),zip::write::SimpleFileOptions::default()).unwrap();output.write_all(&bytes).unwrap();
            }
            output.finish().unwrap();
            let before=Sha256::digest(std::fs::read(&source).unwrap());
            let state=AppState::new().unwrap();let native=NativeProjectService::new(&state);
            let opened=ProjectMigrationService::new(&state).migrate(&source,&target,&|_,_,_,_,_|{}).unwrap();
            let db=native.database(opened.epoch).unwrap();
            db.with_reader(opened.epoch,|engine| {
                let values:(i64,i64,String)=engine.conn().query_row("SELECT _row_id,Big,CAST(Exact AS VARCHAR) FROM dataset_table",[],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?)))?;
                assert_eq!(values,(77,9007199254740993,"123456789.12345678".into()));
                let catalog=ProjectCatalog::new(engine);assert_eq!(catalog.summary("table")?.folder,"Tables/Legacy");assert_eq!(catalog.summary("folder:Empty")?.kind,ProjectDocumentKind::Folder);
                assert_eq!(super::super::project_column_settings::read(engine,"table")?[0].width,Some(120.0));
                Ok(())
            }).unwrap();
            native.close(opened.epoch).unwrap();
            let reopened=native.open(&target,true).unwrap();assert_eq!(reopened.datasets[0].source_type,"csv");native.close(reopened.epoch).unwrap();
            assert_eq!(Sha256::digest(std::fs::read(&source).unwrap()),before);
        }
    }

    #[test]
    fn project_v5_migration_row_history_replays_inserted_natural_order() {row_history_case(2,1,0);}

    #[test]
    fn project_v5_migration_row_history_replays_across_local_rebalance() {row_history_case(80,20,0);}

    #[test]
    fn project_v5_migration_row_history_preserves_an_undone_rebalance_cursor() {row_history_case(80,20,20);}

    fn row_history_case(inserts:usize,replay_steps:usize,saved_undo:usize) {
        use crate::{models::{table::CreateTableFromRowsRequest,save::SaveProjectRequest},services::{project_service::ProjectService,data_service::DataService}};
        use serde_json::json;
        let dir=tempfile::tempdir().unwrap();let source=dir.path().join("rows.spprj");let target=dir.path().join("native.spprj");
        let legacy=AppState::new().unwrap();let service=ProjectService::new(&legacy);
        service.create_project("Rows",source.to_str().unwrap()).unwrap();
        legacy.db.lock().unwrap().create_table_from_rows("table",&CreateTableFromRowsRequest{name:"Rows".into(),column_names:vec!["Value".into()],column_types:vec!["DOUBLE".into()],rows:vec![vec![json!(11)],vec![json!(22)]]}).unwrap();
        let mut ids=vec![];let mut generation=0;
        for _ in 0..inserts {let added=DataService::new(&legacy).add_rows("table",1,Some(2),generation).unwrap();generation=added.generation;ids.extend(added.row_ids);}
        if inserts>64 {assert!(legacy.db.lock().unwrap().archive_unified_history().unwrap().entries.iter().filter_map(|entry|entry.delta.as_ref()).any(|delta|!delta.row_order_rebalances.is_empty()),"fixture must actually cross the local row-key rebalance");}
        for _ in 0..saved_undo {
            let id=legacy.db.lock().unwrap().archive_unified_history().unwrap().entries.into_iter().filter(|entry|entry.applied).max_by_key(|entry|entry.history_ordinal).unwrap().change_set_id;
            DataService::new(&legacy).apply_change_set(&id,true).unwrap();
        }
        let expected=|count:usize|std::iter::once(1).chain(ids[..count].iter().copied()).chain(std::iter::once(2)).collect::<Vec<_>>();
        let request:SaveProjectRequest=serde_json::from_value(json!({"filePath":source,"history":[],"snapshots":[],"graphBuilders":[],"reports":[],"tabulates":[],"folders":[],"tableFolders":{},"graphFolders":{},"reportFolders":{},"tabulateFolders":{}})).unwrap();
        service.save_project(request,None).unwrap();
        let state=AppState::new().unwrap();let native=NativeProjectService::new(&state);
        let opened=ProjectMigrationService::new(&state).migrate(&source,&target,&|_,_,_,_,_|{}).unwrap();
        let db=native.database(opened.epoch).unwrap();
        let order=||db.with_reader(opened.epoch,|engine|Ok(engine.conn().prepare(&format!("SELECT _row_id FROM dataset_table ORDER BY {}",crate::engine::duckdb_engine::NATURAL_ORDER_SQL))?.query_map([],|row|row.get::<_,i64>(0))?.collect::<Result<Vec<_>,_>>()?)).unwrap();
        let mut visible=inserts-saved_undo;
        assert_eq!(order(),expected(visible));
        let directions=if saved_undo==0{[true,false]}else{[false,true]};
        for undo in directions {for step in 0..replay_steps {
            let frontier=native.history_frontier(opened.epoch,None,undo).unwrap().entry.unwrap();
            let generation=db.with_reader(opened.epoch,|engine|engine.get_dataset_generation("table")).unwrap();
            let context=ProjectWriteContext{operation_id:format!("{undo}-{step}"),request_digest:String::new(),expected_project_id:opened.header.project_id.clone(),expected_epoch:opened.epoch,expected_revision:db.committed_revision().unwrap(),document_revisions:vec![],dataset_generations:vec![DatasetGeneration{id:"table".into(),generation}]};
            native.apply_change_set(&context,"table",&frontier.id,undo).unwrap();
            visible=if undo{visible-1}else{visible+1};
            assert_eq!(order(),expected(visible));
        }}
        native.close(opened.epoch).unwrap();
    }

    #[test]
    fn project_v5_migration_restores_global_archived_history_order() {
        use crate::{models::{table::{CreateTableFromRowsRequest,CellUpdate},save::SaveProjectRequest},services::{project_service::ProjectService,data_service::DataService}};
        use serde_json::json;
        let dir=tempfile::tempdir().unwrap();let source=dir.path().join("history.spprj");let target=dir.path().join("native.spprj");
        let legacy=AppState::new().unwrap();let service=ProjectService::new(&legacy);
        service.create_project("History",source.to_str().unwrap()).unwrap();
        for id in ["a","b"] {legacy.db.lock().unwrap().create_table_from_rows(id,&CreateTableFromRowsRequest{name:id.to_uppercase(),column_names:vec!["Value".into()],column_types:vec!["DOUBLE".into()],rows:vec![vec![json!(1)]]}).unwrap();}
        let mut ui_history=vec![];let mut ids=vec![];
        for dataset in ["a","b"] {
            DataService::new(&legacy).update_cells(dataset,&[CellUpdate{row_id:1,column_name:"Value".into(),value:Some("9".into())}],Some(0)).unwrap();
            let id=legacy.db.lock().unwrap().archive_unified_history().unwrap().entries.into_iter().find(|entry|entry.dataset_id==dataset).unwrap().change_set_id;
            ui_history.push(json!({"id":format!("ui-{dataset}"),"timestamp":"today","description":"Edit","action":{"kind":"changeSet","datasetId":dataset,"changeSetId":id}}));ids.push(id);
        }
        let request:SaveProjectRequest=serde_json::from_value(json!({"filePath":source,"history":ui_history,"snapshots":[],"graphBuilders":[],"reports":[],"tabulates":[],"folders":[],"tableFolders":{},"graphFolders":{},"reportFolders":{},"tabulateFolders":{}})).unwrap();
        service.save_project(request,None).unwrap();
        let before=Sha256::digest(std::fs::read(&source).unwrap());
        let state=AppState::new().unwrap();let native=NativeProjectService::new(&state);
        let opened=ProjectMigrationService::new(&state).migrate(&source,&target,&|_,_,_,_,_|{}).unwrap();
        let db=native.database(opened.epoch).unwrap();
        let latest=native.history_frontier(opened.epoch,None,true).unwrap().entry.unwrap();
        assert_eq!(latest.id,ids[1],"archived global ordering must take precedence over per-table ordinal and alphabetical ID");
        let context=ProjectWriteContext{operation_id:"undo-b".into(),expected_project_id:opened.header.project_id,expected_epoch:opened.epoch,expected_revision:db.committed_revision().unwrap(),request_digest:String::new(),document_revisions:vec![],dataset_generations:vec![DatasetGeneration{id:"b".into(),generation:latest.generation}]};
        native.apply_change_set(&context,"b",&latest.id,true).unwrap();
        assert_eq!(native.history_frontier(opened.epoch,None,true).unwrap().entry.unwrap().id,ids[0]);
        native.close(opened.epoch).unwrap();
        let reopened=native.open(&target,true).unwrap();
        assert_eq!(native.history_frontier(reopened.epoch,None,false).unwrap().entry.unwrap().id,ids[1]);
        native.close(reopened.epoch).unwrap();
        assert_eq!(Sha256::digest(std::fs::read(&source).unwrap()),before);
    }

    #[test]
    fn project_v5_migration_archived_history_is_bounded_visible_and_never_executable() {
        use serde_json::json;
        let dir=tempfile::tempdir().unwrap();let source=dir.path().join("history.spprj");let target=dir.path().join("history-v5.spprj");
        let records=vec![json!({"id":"init","description":"__init__","timestamp":"0"}),json!({"id":"note","description":"Rename report","timestamp":"1","afterState":{"large":"x".repeat(2000000)}}),json!({"id":"old-table","description":"Legacy table change","timestamp":"2","action":{"kind":"unknown","datasetId":"table"}})];
        std::fs::write(&source,serde_json::to_vec(&json!({"name":"Old history","version":"1.0.0","datasets":[],"history":records})).unwrap()).unwrap();
        let state=AppState::new().unwrap();let native=NativeProjectService::new(&state);let opened=ProjectMigrationService::new(&state).migrate(&source,&target,&|_,_,_,_,_|{}).unwrap();
        let first=native.list_history(opened.epoch,&HistoryPageRequest{dataset_id:None,after:None,limit:1}).unwrap();
        assert_eq!(first.items.len(),1,"archived descriptions must be visible without reading stored afterState bodies");
        assert_eq!(serde_json::to_value(&first.items[0]).unwrap()["description"],"Rename report");
        assert!(serde_json::to_string(&first).unwrap().len()<1000);assert_eq!(first.items[0].operation,"archived");
        let second=native.list_history(opened.epoch,&HistoryPageRequest{dataset_id:None,after:first.next_cursor,limit:1}).unwrap();assert_eq!(second.items.len(),1);assert!(second.next_cursor.is_none());
        let filtered=native.list_history(opened.epoch,&HistoryPageRequest{dataset_id:Some("table".into()),after:None,limit:200}).unwrap();assert_eq!(filtered.items.len(),1);
        assert!(native.history_frontier(opened.epoch,None,true).unwrap().entry.is_none());
        native.database(opened.epoch).unwrap().with_reader(opened.epoch,|engine|{let raw:String=engine.conn().query_row("SELECT payload_json FROM _project_imported_history WHERE sequence=2",[],|row|row.get(0))?;assert_eq!(serde_json::from_str::<serde_json::Value>(&raw).unwrap(),records[1]);Ok(())}).unwrap();
        native.close(opened.epoch).unwrap();let reopened=native.open(&target,true).unwrap();assert_eq!(native.list_history(reopened.epoch,&HistoryPageRequest{dataset_id:None,after:None,limit:200}).unwrap().items.len(),2);native.close(reopened.epoch).unwrap();
    }

    #[test]
    fn project_v5_migration_document_domains_bindings_outputs_and_lineage_reopen() {
        use crate::{models::{save::SaveProjectRequest,table::CreateTableFromRowsRequest},services::project_service::ProjectService};
        use serde_json::{json,Value};
        let dir=tempfile::tempdir().unwrap();let source=dir.path().join("domains.spprj");let target=dir.path().join("domains-v5.spprj");
        let original=AppState::new().unwrap();let legacy=ProjectService::new(&original);
        legacy.create_project("Domains",source.to_str().unwrap()).unwrap();
        for id in ["table","output"] {
            original.db.lock().unwrap().create_table_from_rows(id,&CreateTableFromRowsRequest{name:if id=="table"{"Data"}else{"Output"}.into(),column_names:vec!["value".into()],column_types:vec!["DOUBLE".into()],rows:vec![vec![json!(42)]]}).unwrap();
        }
        let mut input:Value=serde_json::from_str(include_str!("../../../tests/fixtures/project-migration-domains.json")).unwrap();
        input["filePath"]=json!(source);
        legacy.save_project(serde_json::from_value::<SaveProjectRequest>(input).unwrap(),None).unwrap();
        let saved=spprj_archive::read_project_file(source.to_str().unwrap()).unwrap();
        let before=Sha256::digest(std::fs::read(&source).unwrap());
        let state=AppState::new().unwrap();let native=NativeProjectService::new(&state);
        let opened=ProjectMigrationService::new(&state).migrate(&source,&target,&|_,_,_,_,_|{}).unwrap();
        let verify=|epoch| {
            let database=native.database(epoch).unwrap();
            database.with_reader(epoch,|engine| {
                let catalog=ProjectCatalog::new(engine);
                for (id,expected) in [("graph-new",saved.graph_builders_new[0].clone()),("report",saved.reports[0].clone()),("tabulate",saved.tabulates[0].clone()),("workflow",json(&saved.workflows[0])?),("transform",json(&saved.table_transforms[0])?)] {
                    assert_eq!(catalog.get_document(id,1)?.body,expected,"migrated document {id}");
                }
                let mut graph=saved.graphs[0].body.clone();graph.insert("id".into(),"graph".into());graph.insert("name".into(),saved.graphs[0].name.clone().into());
                assert_eq!(catalog.get_document("graph",1)?.body,Value::Object(graph));
                assert_eq!(catalog.summary("graph-new")?.folder,"Charts");assert_eq!(catalog.summary("report")?.folder,"Reports");
                assert_eq!(catalog.summary("folder:Empty/Nested")?.kind,ProjectDocumentKind::Folder);
                assert_eq!(catalog.get_setting("filter:table")?.unwrap().1,json(&saved.manifest.dataset_filters["table"])?);
                assert_eq!(catalog.get_setting("logicalFolders")?.unwrap().1,json(&saved.manifest.logical_folders)?);
                assert_eq!(catalog.get_setting("transformBinding:transform")?.unwrap().1,json(&saved.manifest.table_transform_bindings[0])?);
                assert_eq!(catalog.get_setting("workflowRun:saved-run")?.unwrap().1["run"],json(&saved.manifest.workflow_runs[0])?);
                assert_eq!(catalog.get_setting("lineage")?.unwrap().1,json(&saved.manifest.lineage_graph)?);
                assert_eq!(engine.conn().query_row("SELECT value FROM dataset_output",[],|row|row.get::<_,f64>(0))?,42.0);
                Ok(())
            }).unwrap();
            let runs=native.workflow_run_state(epoch,"workflow",1).unwrap();assert_eq!(runs.total_count,1);assert_eq!(runs.latest_run_id.as_deref(),Some("saved-run"));assert_eq!(runs.latest_output_bindings.unwrap()[0].artifact_document_id,"graph");
        };
        verify(opened.epoch);native.close(opened.epoch).unwrap();let reopened=native.open(&target,true).unwrap();verify(reopened.epoch);native.close(reopened.epoch).unwrap();
        assert_eq!(Sha256::digest(std::fs::read(&source).unwrap()),before);
    }

    #[test]
    fn project_v5_migration_invalid_legacy_analysis_preserves_source_and_live_owner() {
        use serde_json::{json,Value};
        let fixture:Value=serde_json::from_str(include_str!("../../../tests/fixtures/project-migration-documents.json")).unwrap();
        let valid=fixture["input"]["fitYByX"][0].clone();
        let dir=tempfile::tempdir().unwrap();let live=dir.path().join("live.spprj");let db=ProjectDatabase::create(&live,false).unwrap();db.shutdown().unwrap();
        let state=AppState::new().unwrap();let native=NativeProjectService::new(&state);let owner=native.open(&live,false).unwrap();
        for case in ["valid","graph-role","malformed-graph","personality","same-field","collision","malformed-history"] {
            let source=dir.path().join(format!("{case}.spprj"));let target=dir.path().join(format!("{case}-v5.spprj"));let mut item=valid.clone();
            match case {"graph-role"=>item["graph"]["modeStates"]["twoD"]["encoding"]["x"]["name"]="Wrong field".into(),"malformed-graph"=>item["graph"]=json!({}),"personality"=>item["personality"]="invalid".into(),"same-field"=>item["response"]=item["factor"].clone(),_=>{}}
            let analyses=if case=="collision"{vec![item.clone(),item]}else{vec![item]};
            let history=if case=="malformed-history"{vec![json!({"description":"Broken","action":{"kind":"changeSet","datasetId":"table"}})]}else{vec![]};
            std::fs::write(&source,serde_json::to_vec(&json!({"name":"Legacy analysis","version":"1.0.0","datasets":[{"id":"table","name":"Data","sourceType":"manual","columns":[{"name":"X","colType":"DOUBLE"},{"name":"Y","colType":"DOUBLE"}],"rows":[[1,1,2]]}],"fitYByX":analyses,"history":history})).unwrap()).unwrap();
            let hash=Sha256::digest(std::fs::read(&source).unwrap());let previous_epoch=state.project_database.read().unwrap().as_ref().unwrap().epoch();let result=ProjectMigrationService::new(&state).migrate(&source,&target,&|_,_,_,_,_|{});
            if case=="valid" {let opened=result.unwrap();native.close(opened.epoch).unwrap();native.open(&live,false).unwrap();}
            else {assert!(result.is_err(),"invalid legacy {case} must be rejected before publication");assert!(!target.exists());assert_eq!(state.project_database.read().unwrap().as_ref().unwrap().epoch(),previous_epoch);}
            assert_eq!(Sha256::digest(std::fs::read(&source).unwrap()),hash);
        }
        // The valid control intentionally switched once; rejected conversions retain its reopened owner.
        assert!(state.project_database.read().unwrap().as_ref().unwrap().epoch()>owner.epoch);
    }

    #[test]
    fn project_v5_migration_legacy_analysis_conversion_matches_frontend_compatibility() {
        use serde_json::{Value,json};
        let fixture:Value=serde_json::from_str(include_str!("../../../tests/fixtures/project-migration-documents.json")).unwrap();
        let input=&fixture["input"];
        let values=|key:&str|input[key].as_array().unwrap().clone();
        let folders=|key:&str|serde_json::from_value::<HashMap<String,String>>(input[key].clone()).unwrap();
        let empty=HashMap::new();
        let table:TableDoc=serde_json::from_value(json!({"id":"table","name":"Data","sourceType":"manual","version":"1","columns":[{"name":"X","colType":"DOUBLE"},{"name":"Y","colType":"DOUBLE"}],"rows":[[1,1,2]]})).unwrap();
        let bundle=spprj_archive::build_bundle_with_fit_models("Analyses".into(),"4.0.0".into(),"today".into(),vec![table],vec![],values("fitYByX"),values("fitModels"),vec![],values("distributions"),vec![],vec![],vec![],&empty,&empty,&folders("fitYByXFolders"),&folders("fitModelFolders"),&empty,&folders("distributionFolders"),&empty,&empty,vec![],vec![]).unwrap();
        let dir=tempfile::tempdir().unwrap();let source=dir.path().join("legacy.spprj");let target=dir.path().join("native.spprj");
        spprj_archive::write_legacy_project_archive_for_test(&bundle,source.to_str().unwrap()).unwrap();
        let before=Sha256::digest(std::fs::read(&source).unwrap());
        let state=AppState::new().unwrap();
        let opened=ProjectMigrationService::new(&state).migrate(&source,&target,&|_,_,_,_,_|{}).unwrap();
        let native=NativeProjectService::new(&state);let db=native.database(opened.epoch).unwrap();
        db.with_reader(opened.epoch,|engine| {
            let catalog=ProjectCatalog::new(engine);
            for expected in fixture["expected"]["analyses"].as_array().unwrap() {
                let id=expected["id"].as_str().unwrap();let doc=catalog.get_document(id,1)?;
                assert_eq!(doc.summary.kind,ProjectDocumentKind::Analysis);
                assert_eq!(&doc.body,expected);
                assert_eq!(doc.summary.folder,fixture["expected"]["analysisFolders"][id].as_str().unwrap());
            }
            Ok(())
        }).unwrap();
        native.close(opened.epoch).unwrap();
        assert_eq!(Sha256::digest(std::fs::read(&source).unwrap()),before);
    }

    #[test]
    fn project_v5_migration_zip_corpus_preserves_formula_ids_folders_and_redo() {
        use crate::{models::{table::{CreateTableFromRowsRequest,CellUpdate},save::SaveProjectRequest},services::{project_service::ProjectService,data_service::DataService,calculated_column_service::{CalculatedColumnService,UpsertCalculatedColumnInput}}};
        use serde_json::json;
        let dir=tempfile::tempdir().unwrap();
        let archive_path=dir.path().join("source.spprj");
        let original=AppState::new().unwrap();
        let service=ProjectService::new(&original);
        service.create_project("Source",archive_path.to_str().unwrap()).unwrap();
        original.db.lock().unwrap().create_table_from_rows("table",&CreateTableFromRowsRequest{name:"Data".into(),column_names:vec!["value".into()],column_types:vec!["DOUBLE".into()],rows:vec![vec![json!(2)],vec![json!(3)]]}).unwrap();
        CalculatedColumnService::new(&original).upsert(&UpsertCalculatedColumnInput{dataset_id:"table".into(),output_name:"doubled".into(),formula_text:"[value] * 2".into(),at_index:None,output_column_id:None,formula_id:None,expected_generation:Some(0)}).unwrap();
        DataService::new(&original).update_cells("table",&[CellUpdate{row_id:1,column_name:"value".into(),value:Some("9".into())}],None).unwrap();
        let redo_id=original.db.lock().unwrap().archive_unified_history().unwrap().entries.last().unwrap().change_set_id.clone();
        DataService::new(&original).apply_change_set(&redo_id,true).unwrap();
        let table=service.compose_table_doc("table").unwrap();
        let generation=original.db.lock().unwrap().get_dataset_generation("table").unwrap();
        let request:SaveProjectRequest=serde_json::from_value(json!({"filePath":archive_path,"history":[],"snapshots":[],"graphBuilders":[],"reports":[{"id":"report","name":"Report","schemaVersion":1,"markdown":"**Kept**","createdAt":"today","updatedAt":"today"}],"tabulates":[],"folders":["Empty/Nested","Tables","Reports"],"tableFolders":{"table":"Tables"},"graphFolders":{},"reportFolders":{"report":"Reports"},"tabulateFolders":{}})).unwrap();
        service.save_project(request,None).unwrap();
        let saved=spprj_archive::read_project_file(archive_path.to_str().unwrap()).unwrap();
        for version in ["2.0.0","3.0.0","4.0.0"] {
            let source=dir.path().join(format!("source-{version}.spprj"));
            let target=dir.path().join(format!("native-{version}.spprj"));
            let mut input=zip::ZipArchive::new(std::fs::File::open(&archive_path).unwrap()).unwrap();
            let mut output=zip::ZipWriter::new(std::fs::File::create(&source).unwrap());
            for index in 0..input.len() {
                let mut entry=input.by_index(index).unwrap();
                let mut bytes=vec![];entry.read_to_end(&mut bytes).unwrap();
                if entry.name()=="manifest.json" {let mut manifest:serde_json::Value=serde_json::from_slice(&bytes).unwrap();manifest["version"]=version.into();bytes=serde_json::to_vec(&manifest).unwrap();}
                output.start_file(entry.name(),zip::write::SimpleFileOptions::default()).unwrap();output.write_all(&bytes).unwrap();
            }
            output.finish().unwrap();
            let before=Sha256::digest(std::fs::read(&source).unwrap());
            let state=AppState::new().unwrap();
            let opened=ProjectMigrationService::new(&state).migrate(&source,&target,&|_,_,_,_,_|{}).unwrap();
            let native=NativeProjectService::new(&state);
            let db=native.database(opened.epoch).unwrap();
            db.with_reader(opened.epoch,|engine| {
                assert_eq!(engine.get_dataset_generation("table")?,generation);
                let plans=engine.get_archive_column_plans("table")?;
                for (plan,column) in plans.iter().zip(&table.columns) {assert_eq!(Some(&plan.column_id),column.column_id.as_ref());}
                let catalog=ProjectCatalog::new(engine);
                assert_eq!(catalog.get_document("report",1)?.body["markdown"],"**Kept**");
                assert_eq!(catalog.summary("table")?.folder,"Tables");
                assert_eq!(catalog.summary("folder:Empty/Nested")?.kind,ProjectDocumentKind::Folder);
                assert_eq!(engine.archive_unified_history()?,saved.history_timeline.as_ref().unwrap().metadata);
                Ok(())
            }).unwrap();
            assert_eq!(native.history_frontier(opened.epoch,None,false).unwrap().entry.unwrap().id,redo_id);
            let context=ProjectWriteContext{operation_id:"redo".into(),request_digest:String::new(),expected_project_id:opened.header.project_id,expected_epoch:opened.epoch,expected_revision:db.committed_revision().unwrap(),document_revisions:vec![],dataset_generations:vec![DatasetGeneration{id:"table".into(),generation}]};
            native.apply_change_set(&context,"table",&redo_id,false).unwrap();
            db.with_engine(|engine|{let values:(f64,f64)=engine.conn().query_row("SELECT value,doubled FROM dataset_table WHERE _row_id=1",[],|row|Ok((row.get(0)?,row.get(1)?)))?;assert_eq!(values,(9.0,18.0));Ok(())}).unwrap();
            native.close(opened.epoch).unwrap();
            let reopened=native.open(&target,true).unwrap();
            assert!(native.history_frontier(reopened.epoch,None,false).unwrap().entry.is_none());
            native.close(reopened.epoch).unwrap();
            assert_eq!(Sha256::digest(std::fs::read(&source).unwrap()),before);
        }
    }

    #[test]
    fn project_v5_migration_preflight_preserves_original_and_rejects_collisions() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("original.spprj");
        std::fs::write(&source, r#"{"name":"Original","version":"1.0.0","datasets":[]}"#).unwrap();
        let before = Sha256::digest(std::fs::read(&source).unwrap());
        let preflight = ProjectMigrationService::preflight(&source, None).unwrap();
        assert_eq!(preflight.format_version, "1.0.0");
        assert_eq!(preflight.destination, dir.path().join("original-v5.spprj"));
        assert!(!preflight.destination_exists);
        assert_eq!(preflight.required_writer, 1);
        assert!(ProjectMigrationService::preflight(&source, Some(&source)).is_err());
        std::fs::write(&preflight.destination, b"untouched existing sibling").unwrap();
        assert!(ProjectMigrationService::preflight(&source, None).unwrap().destination_exists);
        let state = AppState::new().unwrap();
        assert!(ProjectMigrationService::new(&state).migrate(&source, &preflight.destination, &|_,_,_,_,_|{}).is_err());
        assert_eq!(std::fs::read(&preflight.destination).unwrap(), b"untouched existing sibling");
        assert_eq!(Sha256::digest(std::fs::read(&source).unwrap()), before);
    }

    #[test]
    fn project_v5_migration_preserves_legacy_named_snapshot_identity_and_values() {
        let dir=tempfile::tempdir().unwrap();
        let source=dir.path().join("snapshots.spprj");let target=dir.path().join("snapshots-v5.spprj");
        std::fs::write(&source,r#"{"name":"Snapshots","version":"1.0.0","datasets":[{"id":"table","name":"Current","sourceType":"manual","columns":[{"name":"Value","colType":"DOUBLE"}],"rows":[[1,11]]}],"snapshots":[{"id":"h_123_1","name":"Bookmark","timestamp":"yesterday","snapshot":{"datasets":[{"id":"table","name":"Prior","sourceType":"manual","columns":[{"name":"Value","colType":"DOUBLE","width":177}],"rows":[[1,99]]}]}}]}"#).unwrap();
        let before=Sha256::digest(std::fs::read(&source).unwrap());
        let state=AppState::new().unwrap();let native=NativeProjectService::new(&state);
        let opened=ProjectMigrationService::new(&state).migrate(&source,&target,&|_,_,_,_,_|{}).unwrap();
        let db=native.database(opened.epoch).unwrap();
        let page=db.list_data_snapshots(opened.epoch,None,200).unwrap();
        assert_eq!(page.items.len(),1);assert_eq!(page.items[0].id,"h_123_1");assert_eq!(page.items[0].table_count,1);
        let protected=db.with_reader(opened.epoch,|engine|ProjectCatalog::new(engine).get_document("h_123_1",1)).unwrap();
        let context=ProjectWriteContext{operation_id:"forge-snapshot-owner".into(),request_digest:String::new(),expected_project_id:opened.header.project_id.clone(),expected_epoch:opened.epoch,expected_revision:db.committed_revision().unwrap(),document_revisions:vec![],dataset_generations:vec![]};
        let mut forged=protected;forged.summary.revision=2;forged.body["storageId"]=uuid::Uuid::new_v4().to_string().into();
        assert!(db.commit_records(&context,&ProjectRecordPatch{documents:vec![DocumentWrite{expected_revision:Some(1),document:forged}],..Default::default()}).is_err(),"generic document updates must not redirect snapshot-owned storage");
        let mut deletion=context.clone();deletion.operation_id="generic-snapshot-delete".into();
        assert!(db.commit_records(&deletion,&ProjectRecordPatch{deleted_document_ids:vec!["h_123_1".into()],..Default::default()}).is_err(),"snapshot deletion must clean owned storage through its typed operation");
        db.with_reader(opened.epoch,|engine|{let value:f64=engine.conn().query_row("SELECT Value FROM dataset_table",[],|row|row.get(0))?;assert_eq!(value,11.0);Ok(())}).unwrap();
        let context=ProjectWriteContext{operation_id:"restore".into(),request_digest:String::new(),expected_project_id:opened.header.project_id,expected_epoch:opened.epoch,expected_revision:db.committed_revision().unwrap(),document_revisions:vec![],dataset_generations:vec![]};
        db.restore_data_snapshot(&context,"h_123_1",1).unwrap();
        db.with_reader(opened.epoch,|engine|{let value:f64=engine.conn().query_row("SELECT Value FROM dataset_table",[],|row|row.get(0))?;assert_eq!(value,99.0);assert_eq!(engine.get_dataset_meta("table")?.name,"Prior");assert_eq!(super::super::project_column_settings::read(engine,"table")?[0].width,Some(177.0));Ok(())}).unwrap();
        native.close(opened.epoch).unwrap();
        let reopened=native.open(&target,true).unwrap();let db=native.database(reopened.epoch).unwrap();
        assert_eq!(db.list_data_snapshots(reopened.epoch,None,200).unwrap().items[0].id,"h_123_1");
        native.close(reopened.epoch).unwrap();
        assert_eq!(Sha256::digest(std::fs::read(&source).unwrap()),before);
    }

    #[test]
    fn project_v5_migration_streams_legacy_table_into_published_native_project() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("legacy.spprj");
        let destination = dir.path().join("legacy-v5.spprj");
        std::fs::write(&source, r#"{"name":"Original","version":"1.0.0","createdAt":"yesterday","datasets":[{"id":"table","name":"Data","sourceType":"csv","columns":[{"name":"Value","colType":"DOUBLE"}],"rows":[[7,11.5],[3,null]]}]}"#).unwrap();
        let original = std::fs::read(&source).unwrap();
        let state = AppState::new().unwrap();
        let service = ProjectMigrationService::new(&state);
        let opened = service.migrate(&source, &destination, &|_,_,_,_,_|{}).unwrap();
        assert_eq!(opened.project.name, "Original");
        assert_eq!(opened.header.format_version, "5.0.0");
        assert_eq!(opened.datasets.len(), 1);
        assert_eq!(opened.datasets[0].id, "table");
        assert_eq!(opened.datasets[0].row_count, 2);
        assert_eq!(opened.datasets[0].source_type,"csv");
        state.project_database.read().unwrap().as_ref().unwrap().with_engine(|engine| {
            let rows = engine.conn().prepare("SELECT _row_id,Value FROM dataset_table ORDER BY _row_order")?.query_map([], |row| Ok((row.get::<_,i64>(0)?,row.get::<_,Option<f64>>(1)?)))?.collect::<Result<Vec<_>,_>>()?;
            assert_eq!(rows, vec![(7,Some(11.5)),(3,None)]);
            Ok(())
        }).unwrap();
        NativeProjectService::new(&state).close(opened.epoch).unwrap();
        let reopened = NativeProjectService::new(&state).open(&destination, true).unwrap();
        assert_eq!(reopened.datasets[0].row_count, 2);
        NativeProjectService::new(&state).close(reopened.epoch).unwrap();
        assert_eq!(std::fs::read(&source).unwrap(), original);
    }

    #[test]
    fn project_v5_migration_cancel_and_malformed_source_preserve_live_session() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source.spprj");
        let destination = dir.path().join("new.spprj");
        std::fs::write(&source, r#"{"name":"Original","version":"1.0.0","datasets":[]}"#).unwrap();
        let state = AppState::new().unwrap();
        let live_path = dir.path().join("live.spprj");
        let live_db = crate::services::project_database::ProjectDatabase::create(&live_path, false).unwrap();
        live_db.prepare_close(live_db.epoch()).unwrap();
        let live = NativeProjectService::new(&state).open(&live_path, false).unwrap();
        let service = ProjectMigrationService::new(&state);
        assert!(service.migrate_with_cancel(&source, &destination, &|_,_,_,_,_|{}, &|| true).is_err());
        assert!(!destination.exists());
        assert_eq!(state.project_database.read().unwrap().as_ref().unwrap().epoch(), live.epoch);
        std::fs::write(&source, r#"{"name":"Broken","version":"1.0.0","datasets":[{"id":"table","name":"Data","columns":[{"name":"Value","colType":"DOUBLE"}],"rows":[[1,3],[1,4]]}]}"#).unwrap();
        let original = std::fs::read(&source).unwrap();
        assert!(service.migrate(&source, &destination, &|_,_,_,_,_|{}).is_err());
        assert!(!destination.exists());
        assert_eq!(std::fs::read(&source).unwrap(), original);
        assert_eq!(state.project_database.read().unwrap().as_ref().unwrap().epoch(), live.epoch);
        NativeProjectService::new(&state).close(live.epoch).unwrap();
        assert!(dir.path().read_dir().unwrap().all(|entry| !entry.unwrap().file_name().to_string_lossy().starts_with(".sp-migrate-")));
    }

    #[test]
    fn project_v5_migration_late_source_collision_cancel_and_project_switch_publish_nothing() {
        use std::cell::Cell;
        let dir=tempfile::tempdir().unwrap();
        let source=dir.path().join("source.spprj");let target=dir.path().join("native.spprj");
        let bytes=r#"{"name":"Source","version":"1.0.0","datasets":[{"id":"table","name":"Data","sourceType":"manual","columns":[{"name":"V","colType":"DOUBLE"}],"rows":[[1,2]]}]}"#;
        let state=AppState::new().unwrap();let native=NativeProjectService::new(&state);
        let first=dir.path().join("first.spprj");let second=dir.path().join("second.spprj");
        for path in [&first,&second] {let db=ProjectDatabase::create(path,false).unwrap();db.prepare_close(db.epoch()).unwrap();}
        native.open(&first,false).unwrap();
        for mode in 0..4 {
            std::fs::write(&source,bytes).unwrap();
            let triggered=Cell::new(false);let cancel=Cell::new(false);let switched=Cell::new(0);
            let progress=|index:usize,total:usize,_:&str,_:usize,_:usize| {
                if index>=total || triggered.replace(true){return;}
                match mode {
                    0=>std::fs::write(&source,format!("{bytes} ")).unwrap(),
                    1=>std::fs::write(&target,b"existing destination created while importing").unwrap(),
                    2=>cancel.set(true),
                    _=>switched.set(native.open(&second,false).unwrap().epoch),
                }
            };
            assert!(ProjectMigrationService::new(&state).migrate_with_cancel(&source,&target,&progress,&||cancel.get()).is_err(),"late failure mode {mode} must reject publication");
            assert!(triggered.get());
            if mode==1 {assert_eq!(std::fs::read(&target).unwrap(),b"existing destination created while importing");std::fs::remove_file(&target).unwrap();}
            else {assert!(!target.exists(),"late failure {mode} must not publish a destination");}
            if mode==3 {assert_eq!(state.project_database.read().unwrap().as_ref().unwrap().epoch(),switched.get());}
        }
        let epoch=state.project_database.read().unwrap().as_ref().unwrap().epoch();native.close(epoch).unwrap();
    }
}
