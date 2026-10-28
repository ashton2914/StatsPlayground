//! Explicit fixture-process probes; never linked into ordinary application builds.
use std::{collections::HashMap,io::Write,path::PathBuf};
use serde_json::{json,Value};
use crate::{engine::duckdb_engine::DuckDbEngine,error::AppError,models::{project_persistence::*,table::CellUpdate},services::{project_catalog::ProjectCatalog,project_database::ProjectDatabase,project_native_service::NativeProjectService},state::AppState};

const DATASET:&str="perf-data";
const REPORT:&str="perf-report";

pub(crate) fn crash_point(phase:&str,operation:&str)->Result<(),AppError> {
    if !matches!(operation,"perf-cell"|"perf-report")||std::env::var("STATSPG_PROJECT_V5_CRASH_PHASE").as_deref()!=Ok(phase) {return Ok(());}
    let mut stdout=std::io::stdout().lock();
    writeln!(stdout,"{}",json!({"event":"crash-ready","phase":phase,"operation":operation,"processId":std::process::id()}))?;stdout.flush()?;
    loop {std::thread::park();}
}

struct Config {scenario:String,path:PathBuf,output:Option<PathBuf>,rows:u64,columns:usize,seed:u64,samples:usize,mutation:String,committed:bool,replay:bool,read_only:bool,marker:String,control:String,order_mode:String,tier:String}
impl Config {
    fn parse()->Result<Self,AppError> {
        let mut fields=HashMap::new();let mut args=std::env::args().skip(1);
        while let Some(key)=args.next() {
            if !["--scenario","--path","--output","--rows","--columns","--seed","--samples","--mutation","--expected-committed","--replay","--read-only","--marker","--control","--order-mode","--tier"].contains(&key.as_str()) {return Err(invalid("unknown probe option"));}
            let value=args.next().ok_or_else(||invalid("probe option requires a value"))?;
            if fields.insert(key,value).is_some(){return Err(invalid("duplicate probe option"));}
        }
        let required=|key:&str|fields.get(key).cloned().ok_or_else(||invalid("scenario and fixture path are required"));
        let number=|key:&str,default:u64|fields.get(key).map(|value|value.parse::<u64>().map_err(|_|invalid("invalid numeric probe option"))).unwrap_or(Ok(default));
        let config=Self{scenario:required("--scenario")?,path:PathBuf::from(required("--path")?),output:fields.get("--output").map(PathBuf::from),rows:number("--rows",32)?,columns:number("--columns",20)? as usize,seed:number("--seed",282)?,samples:number("--samples",1)? as usize,mutation:fields.get("--mutation").cloned().unwrap_or_else(||"cell".into()),committed:fields.get("--expected-committed").map(String::as_str)==Some("true"),replay:fields.get("--replay").map(String::as_str)==Some("true"),read_only:fields.get("--read-only").map(String::as_str)==Some("true"),marker:fields.get("--marker").cloned().unwrap_or_else(||"unmarked".into()),control:fields.get("--control").cloned().unwrap_or_default(),order_mode:fields.get("--order-mode").cloned().unwrap_or_else(||"fallback".into()),tier:fields.get("--tier").cloned().unwrap_or_else(||"regular".into())};
        if !matches!(config.tier.as_str(),"regular"|"many-documents"|"long-strings"){return Err(invalid("unsupported fixture tier"));}
        if config.tier=="long-strings"&&config.columns<2{return Err(invalid("long-string fixture requires at least two columns"));}
        if !matches!(config.order_mode.as_str(),"fallback"|"materialized"|"mixed"){return Err(invalid("unsupported fixture order mode"));}
        if config.rows==0||config.columns==0||config.columns>1000||config.samples==0 {return Err(invalid("positive fixture dimensions and samples required"));}
        if !matches!(config.mutation.as_str(),"cell"|"document"){return Err(invalid("unsupported crash mutation"));}Ok(config)
    }
}
fn invalid(message:&str)->AppError {AppError::InvalidParam(message.into())}
fn report_document(revision:u64,markdown:&str)->ProjectDocumentBody {
    ProjectDocumentBody{summary:ProjectDocumentSummary{id:REPORT.into(),kind:ProjectDocumentKind::Report,name:"Report".into(),folder:String::new(),revision,dependencies:vec![],analysis_kind:None},schema_version:1,body:json!({"id":REPORT,"name":"Report","schemaVersion":1,"markdown":markdown,"createdAt":"fixture","updatedAt":"fixture"})}
}
fn context(db:&ProjectDatabase,operation:&str,revision:u64)->Result<ProjectWriteContext,AppError> {
    Ok(ProjectWriteContext{operation_id:operation.into(),request_digest:String::new(),expected_project_id:db.header()?.project_id,expected_epoch:db.epoch(),expected_revision:revision,document_revisions:vec![],dataset_generations:vec![]})
}
fn seed(config:&Config)->Result<Value,AppError> {
    if config.path.exists(){return Err(invalid("fixture seed refuses an existing path"));}
    let db=ProjectDatabase::create(&config.path,false)?;
    db.with_engine(|engine| {
        let names=(0..config.columns).map(|index|format!("c{index}")).collect::<Vec<_>>();
        let types=(0..config.columns).map(|index|if index==0{"BIGINT"}else if config.tier=="long-strings"{"VARCHAR"}else{"DOUBLE"}.into()).collect::<Vec<_>>();
        engine.create_empty_table(DATASET,"Data",&names,&types)?;
        let table=DuckDbEngine::quote_identifier(&DuckDbEngine::internal_table_name(DATASET));
        let expressions=(0..config.columns).map(|index|if index==0{"range".into()}else if config.tier=="long-strings"{format!("repeat(md5(CAST(range AS VARCHAR)||'-{}-{index}'),16)",config.seed)}else{format!("CAST(hash(range,{}, {index}) % 1000000000 AS DOUBLE)/10.0",config.seed)}).collect::<Vec<String>>().join(",");
        let columns=names.iter().map(|name|DuckDbEngine::quote_identifier(name)).collect::<Vec<_>>().join(",");
        let stored_order="CAST(range+1 AS HUGEINT)*18446744073709551616::HUGEINT";
        let order_expression=match config.order_mode.as_str(){"materialized"=>stored_order.to_string(),"mixed"=>format!("CASE WHEN range%2=0 THEN {stored_order} ELSE NULL::HUGEINT END"),_=>"NULL::HUGEINT".into()};
        let written=engine.conn().execute(&format!("INSERT INTO {table} (_row_id,{columns},_row_order) SELECT range+1,{expressions},{order_expression} FROM range({})",config.rows),[])?;
        if written as u64!=config.rows {return Err(invalid("fixture row insertion mismatch"));}
        engine.conn().execute("UPDATE _meta_datasets SET row_count=?,next_row_id=? WHERE id=?",duckdb::params![config.rows,config.rows+1,DATASET])?;
        engine.rebuild_natural_anchors(DATASET,0)?;ProjectCatalog::new(engine).publish_table(&engine.get_dataset_meta(DATASET)?,"")?;Ok(())
    })?;
    db.commit_records(&context(&db,"seed-report",0)?,&ProjectRecordPatch{documents:vec![DocumentWrite{expected_revision:None,document:report_document(1,"initial report")}],..Default::default()})?;
    if config.tier=="many-documents" {
        db.with_engine(|engine|{
            engine.conn().execute_batch("BEGIN TRANSACTION")?;
            for index in 0..500 {
                let id=format!("stress-table-{index:04}");
                engine.create_empty_table(&id,&format!("Table {index:04}"),&["value".into()],&["BIGINT".into()])?;
                ProjectCatalog::new(engine).publish_table(&engine.get_dataset_meta(&id)?,"")?;
            }
            // Fixture construction is one initial bulk write, outside all measured operations.
            engine.conn().execute_batch("INSERT INTO _project_directory SELECT 'stress-report-'||lpad(CAST(range AS VARCHAR),5,'0'),'report','Report '||CAST(range AS VARCHAR),'',1,'[]' FROM range(10000);
                INSERT INTO _project_documents SELECT id,1,1,CAST(json_object('id',id,'name',name,'schemaVersion',1,'markdown','catalog stress document','createdAt','fixture','updatedAt','fixture') AS VARCHAR) FROM _project_directory WHERE starts_with(id,'stress-report-');
                INSERT INTO _project_document_revision_watermarks SELECT id,1 FROM _project_directory WHERE starts_with(id,'stress-report-');
                COMMIT")?;
            Ok(())
        })?;
    }
    db.with_engine(|engine|{engine.conn().execute_batch("CREATE TABLE _project_perf_tier(tier VARCHAR)")?;engine.conn().execute("INSERT INTO _project_perf_tier VALUES(?)",[&config.tier])?;Ok(())})?;
    let original_revision=db.committed_revision()?;
    db.with_engine(|engine|{engine.conn().execute_batch("CREATE TABLE _project_perf_fixture(rows UBIGINT,columns UBIGINT,seed UBIGINT,original_revision UBIGINT,original_generation UBIGINT)")?;engine.conn().execute("INSERT INTO _project_perf_fixture VALUES(?,?,?,?,?)",duckdb::params![config.rows,config.columns as u64,config.seed,original_revision,0_u64])?;Ok(())})?;
    let observations=db.with_reader(db.epoch(),|engine|{
        let tables:u64=engine.conn().query_row("SELECT COUNT(*) FROM _meta_datasets",[],|row|row.get(0))?;
        let documents:u64=engine.conn().query_row("SELECT COUNT(*) FROM _project_documents",[],|row|row.get(0))?;
        let length=if config.tier=="long-strings"{Some(engine.conn().query_row("SELECT length(c1) FROM dataset_perf_data WHERE _row_id=1",[],|row|row.get::<_,u64>(0))?)}else{None};Ok((tables,documents,length))
    })?;
    let header=db.header()?;db.shutdown()?;
    Ok(json!({"schemaVersion":1,"processId":std::process::id(),"scenario":"seed","projectId":header.project_id,"verification":{"passed":true},"fixture":{"rows":config.rows,"columns":config.columns,"seed":config.seed,"orderMode":config.order_mode,"tier":config.tier,"tableCount":observations.0,"documentCount":observations.1,"longStringChars":observations.2}}))
}

fn fixture(db:&ProjectDatabase)->Result<(u64,u64,u64,u64,u64),AppError> {
    db.with_reader(db.epoch(),|engine|Ok(engine.conn().query_row("SELECT rows,columns,seed,original_revision,original_generation FROM _project_perf_fixture",[],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?)))?))
}
fn mutate(native:&NativeProjectService<'_>,db:&ProjectDatabase,mutation:&str,revision:u64,generation:u64)->Result<Value,AppError> {
    if mutation=="cell" {
        let mut write=context(db,"perf-cell",revision)?;write.dataset_generations.push(DatasetGeneration{id:DATASET.into(),generation});
        serde_json::to_value(native.update_cells(&write,DATASET,&[CellUpdate{row_id:1,column_name:"c0".into(),value:Some("999999".into())}],Some(generation))?).map_err(|_|invalid("probe receipt serialization failed"))
    }else{
        let mut write=context(db,"perf-report",revision)?;write.document_revisions.push(DocumentRevision{id:REPORT.into(),revision:1});
        serde_json::to_value(native.commit_records(&write,&ProjectRecordPatch{documents:vec![DocumentWrite{expected_revision:Some(1),document:report_document(2,"changed in crash probe")}],..Default::default()})?).map_err(|_|invalid("probe receipt serialization failed"))
    }
}
fn verify(config:&Config,native:&NativeProjectService<'_>,db:&ProjectDatabase)->Result<Value,AppError> {
    let (_,_,_,revision,generation)=fixture(db)?;let before=db.committed_revision()?;
    let mut replayed=false;
    if config.replay {
        if !config.committed{return Err(invalid("uncommitted probes cannot request replay"));}
        let receipt=mutate(native,db,&config.mutation,revision,generation)?;
        replayed=db.committed_revision()?==before&&receipt["committedRevision"].as_u64()==Some(before);
    }
    let observed=db.with_reader(db.epoch(),|engine| {
        let table=DuckDbEngine::quote_identifier(&DuckDbEngine::internal_table_name(DATASET));
        let value:i64=engine.conn().query_row(&format!("SELECT c0 FROM {table} WHERE _row_id=1"),[],|row|row.get(0))?;
        let history:u64=engine.conn().query_row("SELECT COUNT(*) FROM _history_timeline",[],|row|row.get(0))?;
        let catalog=ProjectCatalog::new(engine);let summary=catalog.summary(REPORT)?;let document=catalog.get_document(REPORT,summary.revision)?;
        Ok((value,history,document.body["markdown"].as_str().unwrap_or("").to_owned()))
    })?;
    let expected_value=if config.committed&&config.mutation=="cell"{999999}else{0};
    let expected_history=if config.committed&&config.mutation=="cell"{1}else{0};
    let expected_markdown=if config.committed&&config.mutation=="document"{"changed in crash probe"}else{"initial report"};
    let passed=observed.0==expected_value&&observed.1==expected_history&&observed.2==expected_markdown&&(!config.replay||replayed);
    Ok(json!({"schemaVersion":1,"processId":std::process::id(),"scenario":"verify","verification":{"passed":passed,"cellValue":observed.0,"historyCount":observed.1,"reportMarkdown":observed.2,"receiptReplayed":replayed}}))
}
fn invalid_marker_probe(config:&Config)->Result<Value,AppError> {
    if !matches!(config.marker.as_str(),"unmarked"|"future"){return Err(invalid("unsupported invalid marker fixture"));}
    const APPLICATION_TABLES:&str="SELECT COUNT(*) FROM information_schema.tables WHERE starts_with(table_name,'_project_') OR starts_with(table_name,'_meta_')";
    match config.scenario.as_str() {
        "seed-invalid-marker"=>{
            if config.path.exists(){return Err(invalid("fixture seed refuses an existing path"));}
            let engine=DuckDbEngine::open_project_file(&config.path,false,false)?;
            engine.conn().execute_batch("CREATE TABLE user_data(value BIGINT); INSERT INTO user_data VALUES(0); CHECKPOINT")?;
            if config.marker=="future" {
                crate::services::project_schema::create_header(engine.conn(),&crate::services::project_schema::physical_storage_version(&config.path)?)?;
                engine.conn().execute("UPDATE _project_header SET format_version='99.0.0'",[])?;
            }
            let expected:u64=engine.conn().query_row(APPLICATION_TABLES,[],|row|row.get(0))?;
            engine.conn().execute_batch("CREATE TABLE fixture_expected(application_table_count UBIGINT)")?;
            engine.conn().execute("INSERT INTO fixture_expected VALUES(?)",[expected])?;
            Ok(json!({"processId":std::process::id(),"verification":{"passed":true}}))
        },
        "crash-invalid-marker"=>{
            let engine=DuckDbEngine::open_project_file(&config.path,false,false)?;
            let _:u64=engine.conn().query_row("SELECT application_table_count FROM fixture_expected",[],|row|row.get(0))?;
            engine.conn().execute_batch("BEGIN TRANSACTION; UPDATE user_data SET value=999; COMMIT")?;
            std::env::set_var("STATSPG_PROJECT_V5_CRASH_PHASE","after-commit");crash_point("after-commit","perf-cell")?;
            Err(invalid("invalid-marker crash pause was not reached"))
        },
        "verify-invalid-marker"=>{
            let state=AppState::new()?;let native=NativeProjectService::new(&state);
            let error=match native.open(&config.path,false) {Err(error)=>error.to_string(),Ok(summary)=>{native.close(summary.epoch)?;return Err(invalid("invalid application marker unexpectedly opened"));}};
            let installed=state.project_database.read().map_err(|_|invalid("fixture state unavailable"))?.is_some();
            let engine=DuckDbEngine::open_project_file(&config.path,false,true)?;
            let expected:u64=engine.conn().query_row("SELECT application_table_count FROM fixture_expected",[],|row|row.get(0))?;
            let observed:u64=engine.conn().query_row(APPLICATION_TABLES,[],|row|row.get(0))?;
            let value:i64=engine.conn().query_row("SELECT value FROM user_data",[],|row|row.get(0))?;
            let marker_unchanged=if config.marker=="future" {engine.conn().query_row("SELECT format_version FROM _project_header",[],|row|row.get::<_,String>(0))?=="99.0.0"}else{expected==0};
            let rejected=error.contains(if config.marker=="future"{"project_version_unsupported"}else{"project_header_missing"});
            Ok(json!({"processId":std::process::id(),"verification":{"passed":rejected&&!installed&&expected==observed&&marker_unchanged&&value==999,"applicationSchemaUnchanged":expected==observed&&marker_unchanged,"projectInstalled":installed,"sentinelValue":value}}))
        },
        _=>Err(invalid("unknown invalid marker probe")),
    }
}

fn counter_control(config:&Config)->Result<Value,AppError> {
    use crate::services::{project_work_counters as counters,table_mutation_coordinator::{execute_table_mutation,TableMutationEffects}};
    counters::reset();reset_checkpoint_observation();
    if config.control=="archive" {
        let directory=tempfile::tempdir()?;let path=directory.path().join("legacy.spprj");
        std::fs::write(&path,serde_json::to_vec(&json!({"name":"Control","version":"1.0.0","datasets":[{"id":"control","name":"Control","sourceType":"manual","columns":[{"name":"x","colType":"BIGINT"}],"rows":[[1,17],[2,23]]}]})).unwrap())?;
        let state=AppState::new()?;let service=crate::services::project_service::ProjectService::new(&state);
        service.open_project(path.to_str().ok_or_else(||invalid("fixture path not UTF8"))?,None)?;
        let request=serde_json::from_value(json!({"history":[],"snapshots":[],"graphBuilders":[],"reports":[],"tabulates":[],"folders":[],"tableFolders":{},"graphFolders":{},"reportFolders":{},"tabulateFolders":{}})).map_err(|_|invalid("archive control request invalid"))?;
        service.save_project(request,None)?;
    }else{
        let state=AppState::new()?;let native=NativeProjectService::new(&state);let opened=native.open(&config.path,false)?;let db=native.database(opened.epoch)?;
        match config.control.as_str() {
            "full-count"=>{crate::services::data_service::DataService::new(&state).query_table_window(&crate::models::table::TableWindowRequest{dataset_id:DATASET.into(),generation:0,start:0,count:2,sort:Some(crate::models::table::TableWindowSort{column:"c0".into(),descending:false}),filters:vec![]})?;native.close(opened.epoch)?;},
            "checkpoint"=>{let (_,_,_,revision,generation)=fixture(&db)?;mutate(&native,&db,"cell",revision,generation)?;native.close(opened.epoch)?;},
            "database-copy"=>{let destination=config.path.with_extension("control-copy.spprj");let outcome=native.snapshot(opened.epoch,&destination,false)?;if let Some(error)=outcome.error {return Err(invalid(&error));}native.close(outcome.active.ok_or_else(||invalid("snapshot did not install destination"))?.epoch)?;},
            "before-image"=>{db.with_engine(|engine|execute_table_mutation(engine,DATASET,None,|_|Ok(TableMutationEffects{value:(),changed_column_ids:Default::default(),change_set_id:None,recompute_column_ids:None})))?;native.close(opened.epoch)?;},
            "anchors"=>{db.with_engine(|engine|engine.rebuild_natural_anchors(DATASET,0))?;native.close(opened.epoch)?;},
            _=>return Err(invalid("unknown counter control")),
        }
    }
    Ok(json!({"processId":std::process::id(),"verification":{"passed":true},"forbiddenWork":counters::snapshot(),"checkpointBytes":checkpoint_bytes(),"checkpointMethod":checkpoint_method()}))
}

#[cfg(target_os="macos")]
#[repr(C)]
#[derive(Default)]
struct ProcessUsage {uuid:[u8;16],values:[u64;18]}
// SDK sys/resource.h rusage_info_v2: resident_size at 6, disk I/O at 16/17.
pub(crate) fn process_io()->Option<(u64,u64)> {
    #[cfg(target_os="macos")] {
        unsafe extern "C" {fn proc_pid_rusage(pid:i32,flavor:i32,buffer:*mut std::ffi::c_void)->i32;}
        let mut usage=ProcessUsage::default();
        let status=unsafe{proc_pid_rusage(std::process::id() as i32,2,(&mut usage as *mut ProcessUsage).cast())};
        (status==0).then_some((usage.values[16],usage.values[17]))
    }
    #[cfg(not(target_os="macos"))] {None}
}
static CHECKPOINT_BYTES:std::sync::atomic::AtomicU64=std::sync::atomic::AtomicU64::new(0);
static CHECKPOINT_OBSERVABLE:std::sync::atomic::AtomicBool=std::sync::atomic::AtomicBool::new(false);
pub(crate) fn reset_checkpoint_observation(){
    CHECKPOINT_BYTES.store(0,std::sync::atomic::Ordering::Relaxed);
    CHECKPOINT_OBSERVABLE.store(process_io().is_some(),std::sync::atomic::Ordering::Relaxed);
}
pub(crate) fn checkpoint_bytes()->Option<u64>{CHECKPOINT_OBSERVABLE.load(std::sync::atomic::Ordering::Relaxed).then(||CHECKPOINT_BYTES.load(std::sync::atomic::Ordering::Relaxed))}
pub(crate) fn checkpoint_method()->Option<&'static str>{checkpoint_bytes().map(|_|"proc_pid_rusage diskio byteswritten delta around explicit CHECKPOINT; process-scoped")}
pub(crate) struct CheckpointIoProbe {before:Option<u64>}
impl CheckpointIoProbe {pub(crate) fn begin()->Self{Self{before:process_io().map(|value|value.1)}}}
impl Drop for CheckpointIoProbe {
    fn drop(&mut self){
        let delta=self.before.zip(process_io().map(|value|value.1)).and_then(|(before,after)|after.checked_sub(before));
        if let Some(delta)=delta{CHECKPOINT_BYTES.fetch_add(delta,std::sync::atomic::Ordering::Relaxed);}else{CHECKPOINT_OBSERVABLE.store(false,std::sync::atomic::Ordering::Relaxed);}
    }
}

fn ordinary(config:&Config)->Result<Value,AppError> {
    use crate::services::{data_service::DataService,project_work_counters as counters};
    use crate::models::table::TableNavigationRequest;
    use std::time::Instant;
    let state=AppState::new()?;let native=NativeProjectService::new(&state);
    let initial=native.open(&config.path,false)?;let initial_db=native.database(initial.epoch)?;
    let dimensions=fixture(&initial_db)?;let initial_value=initial_db.with_reader(initial.epoch,|engine|Ok(engine.conn().query_row("SELECT c0 FROM dataset_perf_data WHERE _row_id=1",[],|row|row.get::<_,i64>(0))?))?;let header=initial_db.header()?;native.close(initial.epoch)?;drop(initial_db);
    let mut samples=Vec::new();
    for index in 0..config.samples {
        let setup=if config.scenario=="catalog"{None}else{Some(native.open(&config.path,false)?)};
        counters::reset();reset_checkpoint_observation();let io_before=process_io();
        let mut expected_edit=Some(initial_value);let mut window_start=None;
        let (measured,memory)=crate::perf_harness::measure_peak_working_set_during(||->Result<_,AppError> {
        let started=Instant::now();
        let (epoch,payload)=match config.scenario.as_str() {
            "catalog"=>{let opened=native.open(&config.path,false)?;let epoch=opened.epoch;(epoch,serde_json::to_value(opened).map_err(|_|invalid("catalog serialization failed"))?)},
            "window"|"scroll"=>{let opened=setup.as_ref().unwrap();let db=native.database(opened.epoch)?;let generation=db.with_reader(opened.epoch,|engine|engine.get_dataset_generation(DATASET))?;
                let start=if config.scenario=="scroll"{(index*997+1)%dimensions.0 as usize}else{0};window_start=Some(start);
                let column_ids=db.with_reader(opened.epoch,|engine|Ok(engine.get_table_column_descriptors(DATASET)?.into_iter().map(|column|column.column_id).collect()))?;
                let result=DataService::new(&state).query_table_navigation_window(&TableNavigationRequest{version:1,request_id:format!("perf-window-{index}"),dataset_id:DATASET.into(),start,count:500,column_ids,sort:None,filters:vec![],session_id:None,generation,include_transport_diagnostics:false})?;
                (opened.epoch,serde_json::to_value(result).map_err(|_|invalid("window serialization failed"))?)},
            "edit"=>{let opened=setup.as_ref().unwrap();let db=native.database(opened.epoch)?;let generation=db.with_reader(opened.epoch,|engine|engine.get_dataset_generation(DATASET))?;
                let mut write=context(&db,&format!("measured-edit-{}-{index}",uuid::Uuid::new_v4()),db.committed_revision()?)?;write.dataset_generations.push(DatasetGeneration{id:DATASET.into(),generation});
                let value=1000000+index as i64;expected_edit=Some(value);
                let result=native.update_cells(&write,DATASET,&[CellUpdate{row_id:1,column_name:"c0".into(),value:Some(value.to_string())}],Some(generation))?;
                (opened.epoch,serde_json::to_value(result).map_err(|_|invalid("edit serialization failed"))?)},
            "close"=>{let opened=setup.as_ref().unwrap();native.close(opened.epoch)?;(opened.epoch,Value::Null)},
            _=>return Err(invalid("unknown ordinary scenario")),
        };
        Ok((epoch,payload,started.elapsed().as_secs_f64()*1000.0))
        });
        let (epoch,payload,backend_ms)=measured?;let io_after=process_io();let work=counters::snapshot();
        let transferred=serde_json::to_vec(&payload).map_err(|_|invalid("payload encoding failed"))?.len();
        let wal={let mut path=config.path.as_os_str().to_os_string();path.push(".wal");match std::fs::metadata(path){Ok(metadata)=>Some(metadata.len()),Err(error) if error.kind()==std::io::ErrorKind::NotFound=>Some(0),Err(_)=>None}};
        let db=if config.scenario=="close" {let opened=native.open(&config.path,false)?;native.database(opened.epoch)?}else{native.database(epoch)?};
        let valid=db.with_reader(db.epoch(),|engine| {
            let meta=engine.get_dataset_meta(DATASET)?;
            let table=DuckDbEngine::quote_identifier(&DuckDbEngine::internal_table_name(DATASET));
            let observed:i64=engine.conn().query_row(&format!("SELECT c0 FROM {table} WHERE _row_id=1"),[],|row|row.get(0))?;
            let report=ProjectCatalog::new(engine).get_document(REPORT,1)?;
            let mut valid=meta.row_count==dimensions.0 as i64&&report.body["markdown"]=="initial report"&&expected_edit.is_none_or(|value|observed==value);
            if let Some(start)=window_start {
                let rows=payload["rows"].as_array().ok_or_else(||invalid("window rows missing"))?;
                let expected_count=500.min(dimensions.0 as usize-start);
                valid &= rows.len()==expected_count&&payload["totalRows"].as_i64()==Some(dimensions.0 as i64);
                for (offset,row) in rows.iter().enumerate(){let row_index=start+offset;valid &= row[0].as_i64()==Some(row_index as i64+1)&&row[1].as_i64()==Some(if row_index==0{observed}else{row_index as i64});}
            }
            if config.scenario=="catalog" {let items=payload["directory"]["items"].as_array().ok_or_else(||invalid("catalog items missing"))?;valid &=items.len()==2&&items.iter().any(|item|item["id"]==DATASET)&&items.iter().any(|item|item["id"]==REPORT);}
            Ok(valid)
        })?;
        let (read_bytes,write_bytes)=match(io_before,io_after){(Some(before),Some(after))=>(after.0.checked_sub(before.0),after.1.checked_sub(before.1)),_=>(None,None)};
        samples.push(json!({"processId":std::process::id(),"backendMs":backend_ms,"uiReadyMs":null,"rssBytes":memory.as_ref().map(|value|value.peak_working_set_bytes),"processMemory":memory,"rssMethod":crate::perf_harness::process_memory_method().map(|method|format!("{method}; sampled every 5ms plus endpoints")),"diskReadBytes":read_bytes,"diskWriteBytes":write_bytes,"ioMethod":if cfg!(target_os="macos"){Some("proc_pid_rusage RUSAGE_INFO_V2 diskio byte deltas")}else{None},"walBytes":wal,"checkpointBytes":checkpoint_bytes(),"checkpointMethod":checkpoint_method(),"transferredBytes":transferred,"retention":null,"backendRetainedRows":payload["rows"].as_array().map(Vec::len),"forbiddenWork":work,"verification":{"passed":valid}}));
        let close_epoch=db.epoch();drop(db);native.close(close_epoch)?;
        if config.scenario=="edit" {
            let reopened=native.open(&config.path,false)?;let reopened_db=native.database(reopened.epoch)?;
            let persisted=reopened_db.with_reader(reopened.epoch,|engine|Ok(engine.conn().query_row("SELECT c0 FROM dataset_perf_data WHERE _row_id=1",[],|row|row.get::<_,i64>(0))?))?;
            native.close(reopened.epoch)?;
            if Some(persisted)!=expected_edit{return Err(invalid("durable edit did not survive reopen"));}
        }
        if !valid{return Err(invalid("ordinary logical verification failed"));}
    }
    Ok(json!({"schemaVersion":1,"processId":std::process::id(),"scenario":config.scenario,"source":{"commit":env!("STATSPLAYGROUND_BINARY_SOURCE_COMMIT"),"treeHash":env!("STATSPLAYGROUND_BINARY_SOURCE_TREE_HASH"),"profile":env!("STATSPLAYGROUND_BINARY_BUILD_PROFILE"),"engineVersion":header.engine_version,"storageVersion":header.storage_version},"fixture":{"id":header.project_id,"tier":"regular","rows":dimensions.0,"columns":dimensions.1,"seed":dimensions.2},"cache":{"mode":"warm","method":"same-process reopened database; OS cache not purged; initial fixture metadata read excluded"},"profiling":{"method":null,"verifiedNoFullScan":false},"verification":{"passed":true},"samples":samples}))
}

static NAVIGATION_SQL_PROFILES:std::sync::Mutex<Vec<Value>>=std::sync::Mutex::new(Vec::new());
pub(crate) fn capture_navigation_sql_plan(connection:&duckdb::Connection,sql:&str,parameters:impl duckdb::Params)->Result<(),AppError> {
    if std::env::var("STATSPG_PROJECT_V5_SQL_PROFILE").as_deref()!=Ok("1"){return Ok(());}
    let encoded:String=connection.query_row(&format!("EXPLAIN (ANALYZE,FORMAT JSON) {sql}"),parameters,|row|row.get(1))?;
    let plan:Value=serde_json::from_str(&encoded).map_err(|_|invalid("DuckDB analyzed plan was not JSON"))?;
    NAVIGATION_SQL_PROFILES.lock().map_err(|_|invalid("SQL profile storage unavailable"))?.push(json!({"sql":sql,"plan":plan}));Ok(())
}
pub(crate) fn source_scan_rows(plan:&Value,scans:&mut Vec<u64>)->bool {
    match plan {
        Value::Object(fields)=>{
            if fields.get("operator_type").and_then(Value::as_str)==Some("TABLE_SCAN")&&plan["extra_info"]["Table"].as_str().is_some_and(|name|name.ends_with(".dataset_perf_data")) {
                let Some(rows)=plan["operator_rows_scanned"].as_u64()else{return false;};scans.push(rows);
            }
            fields.values().all(|value|source_scan_rows(value,scans))
        },
        Value::Array(values)=>values.iter().all(|value|source_scan_rows(value,scans)),
        _=>true,
    }
}

fn profile(config:&Config)->Result<Value,AppError> {
    use crate::services::{data_service::DataService,project_work_counters as counters};
    use crate::models::table::TableNavigationRequest;
    let state=AppState::new()?;let native=NativeProjectService::new(&state);let opened=native.open(&config.path,false)?;let db=native.database(opened.epoch)?;
    let dimensions=fixture(&db)?;
    if db.committed_revision()?!=dimensions.3{return Err(invalid("SQL profiling requires an unmodified seeded fixture"));}
    let (generation,column_ids)=db.with_reader(opened.epoch,|engine|Ok((engine.get_dataset_generation(DATASET)?,engine.get_table_column_descriptors(DATASET)?.into_iter().map(|column|column.column_id).collect::<Vec<_>>())))?;
    counters::reset();NAVIGATION_SQL_PROFILES.lock().map_err(|_|invalid("SQL profile storage unavailable"))?.clear();
    std::env::set_var("STATSPG_PROJECT_V5_SQL_PROFILE","1");
    let result=(||->Result<(),AppError>{
        for start in [0,dimensions.0 as usize/2,(dimensions.0 as usize).saturating_sub(500)] {
            let result=DataService::new(&state).query_table_navigation_window(&TableNavigationRequest{version:1,request_id:format!("profile-{start}"),dataset_id:DATASET.into(),generation,start,count:500,column_ids:column_ids.clone(),sort:None,filters:vec![],session_id:None,include_transport_diagnostics:false})?;
            if result.rows.len()!=500.min(dimensions.0 as usize-start)||result.total_rows!=dimensions.0 as i64{return Err(invalid("profiled window size was incorrect"));}
            for (offset,row) in result.rows.iter().enumerate(){if row[0].as_i64()!=Some((start+offset+1) as i64)||row[1].as_i64()!=Some((start+offset) as i64){return Err(invalid("profiled window value was incorrect"));}}
        }Ok(())
    })();
    std::env::remove_var("STATSPG_PROJECT_V5_SQL_PROFILE");result?;
    let queries=NAVIGATION_SQL_PROFILES.lock().map_err(|_|invalid("SQL profile storage unavailable"))?.clone();
    let mut scan_observations=Vec::new();
    let no_full_scan=queries.len()==3&&queries.iter().all(|query|{
        let mut scans=Vec::new();let valid=source_scan_rows(&query["plan"],&mut scans)&&!scans.is_empty();
        let total=scans.iter().try_fold(0_u64,|sum,value|sum.checked_add(*value));scan_observations.push(total);
        valid&&total.is_some_and(|rows|rows<dimensions.0)
    });
    let header=db.header()?;let work=counters::snapshot();native.close(opened.epoch)?;
    Ok(json!({"schemaVersion":1,"processId":std::process::id(),"scenario":"profile","verification":{"passed":true},"source":{"commit":env!("STATSPLAYGROUND_BINARY_SOURCE_COMMIT"),"treeHash":env!("STATSPLAYGROUND_BINARY_SOURCE_TREE_HASH"),"profile":env!("STATSPLAYGROUND_BINARY_BUILD_PROFILE"),"engineVersion":header.engine_version,"storageVersion":header.storage_version},"fixture":{"id":header.project_id,"rows":dimensions.0,"columns":dimensions.1,"seed":dimensions.2},"profiling":{"method":"DuckDB EXPLAIN (ANALYZE, FORMAT JSON) using canonical navigation SQL and actual bound values; separate untimed probe","queries":queries,"sourceRowsScanned":scan_observations,"verifiedNoFullScan":no_full_scan},"forbiddenWork":work}))
}

fn execute(config:&Config)->Result<Value,AppError> {
    if config.scenario=="profile" {return profile(config);}
    if config.scenario=="provenance" {return Ok(json!({"processId":std::process::id(),"source":{"treeHash":env!("STATSPLAYGROUND_BINARY_SOURCE_TREE_HASH"),"commit":env!("STATSPLAYGROUND_BINARY_SOURCE_COMMIT"),"profile":env!("STATSPLAYGROUND_BINARY_BUILD_PROFILE")}}));}
    if config.scenario=="counter-control" {return counter_control(config);}
    if config.scenario=="seed" {return seed(config);}
    if config.scenario.ends_with("invalid-marker"){return invalid_marker_probe(config);}
    if matches!(config.scenario.as_str(),"catalog"|"window"|"scroll"|"edit"|"close") {return ordinary(config);}
    let state=AppState::new()?;let native=NativeProjectService::new(&state);let opened=native.open(&config.path,config.read_only)?;let db=native.database(opened.epoch)?;
    let (_,_,_,revision,generation)=fixture(&db)?;
    let result=match config.scenario.as_str() {
        "crash-commit"|"crash-uncommitted"=>{
            std::env::set_var("STATSPG_PROJECT_V5_CRASH_PHASE",if config.scenario=="crash-commit"{"after-commit"}else{"before-commit"});
            let _=mutate(&native,&db,&config.mutation,revision,generation)?;return Err(invalid("crash probe returned without reaching its pause point"));
        },
        "verify"=>verify(config,&native,&db),
        _=>Err(invalid("ordinary measurement scenario is not implemented yet")),
    };
    native.close(opened.epoch)?;result
}
pub fn run()->Result<(),String> {
    let config=Config::parse().map_err(|error|error.to_string())?;let mut result=execute(&config).map_err(|error|error.to_string())?;
    if result.get("source").is_none(){result["source"]=json!({"treeHash":env!("STATSPLAYGROUND_BINARY_SOURCE_TREE_HASH"),"commit":env!("STATSPLAYGROUND_BINARY_SOURCE_COMMIT"),"profile":env!("STATSPLAYGROUND_BINARY_BUILD_PROFILE")});}
    let bytes=serde_json::to_vec(&result).map_err(|error|error.to_string())?;
    if let Some(path)=config.output {let mut file=std::fs::OpenOptions::new().write(true).create_new(true).open(path).map_err(|error|error.to_string())?;file.write_all(&bytes).map_err(|error|error.to_string())?;file.sync_all().map_err(|error|error.to_string())?;}
    let mut stdout=std::io::stdout().lock();stdout.write_all(&bytes).map_err(|error|error.to_string())?;writeln!(stdout).map_err(|error|error.to_string())?;Ok(())
}
