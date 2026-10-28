//! Opt-in native UI measurement. Never enabled by an ordinary application build.

use std::sync::{Arc,Mutex,atomic::{AtomicBool,AtomicU64,Ordering}};
use std::time::{Duration,Instant};
use serde::{Deserialize,Serialize};
use serde_json::{json,Value};
use crate::error::AppError;

#[derive(Clone,Copy,Debug,PartialEq,Eq,PartialOrd,Ord,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub(crate) enum ProbeScenario {Catalog,Window,Scroll,Edit,Close}

struct MemorySampler {
    baseline:Option<u64>,peak:Arc<AtomicU64>,stop:Arc<AtomicBool>,
    thread:Option<std::thread::JoinHandle<()>>,available:bool,
}
impl MemorySampler {
    fn start()->Self {
        let baseline=crate::perf_harness::current_working_set_bytes();
        let peak=Arc::new(AtomicU64::new(baseline.unwrap_or(0)));
        let stop=Arc::new(AtomicBool::new(false));
        let thread=baseline.and_then(|_|{
            let observed=peak.clone();let stopping=stop.clone();
            std::thread::Builder::new().name("project-v5-ui-rss".into()).spawn(move||{
                while !stopping.load(Ordering::Relaxed) {
                    if let Some(value)=crate::perf_harness::current_working_set_bytes(){observed.fetch_max(value,Ordering::Relaxed);}
                    std::thread::sleep(Duration::from_millis(5));
                }
            }).ok()
        });
        let available=thread.is_some();Self{baseline,peak,stop,thread,available}
    }
    fn stop(&mut self){
        self.stop.store(true,Ordering::Relaxed);
        if let Some(thread)=self.thread.take(){self.available &=thread.join().is_ok();}
        if let Some(value)=crate::perf_harness::current_working_set_bytes(){self.peak.fetch_max(value,Ordering::Relaxed);}
    }
    fn finish(mut self)->Option<(u64,u64)>{self.stop();self.available.then(||(self.baseline.unwrap(),self.peak.load(Ordering::Relaxed)))}
}
impl Drop for MemorySampler {fn drop(&mut self){self.stop();}}

struct ActiveSample {
    id:u64,scenario:ProbeScenario,epoch:Option<u64>,io_start:Option<(u64,u64)>,memory:MemorySampler,
    origin:Instant,native_window_focused_at_start:Option<bool>,intervals:Vec<(u128,u128)>,backend_ns:u128,native_calls:u64,in_flight:u64,bytes:u64,payload_missing:bool,
}
#[derive(Default)]
struct Inner {next_id:u64,active:Option<ActiveSample>}
#[derive(Clone)]
pub(crate) struct UiProbeState {inner:Arc<Mutex<Inner>>}
fn invalid(message:&str)->AppError {AppError::InvalidParam(message.into())}
impl UiProbeState {
    pub(crate) fn new()->Self{Self{inner:Arc::new(Mutex::new(Inner::default()))}}
    pub(crate) fn begin(&self,scenario:ProbeScenario,epoch:Option<u64>)->Result<u64,AppError>{
        let mut inner=self.inner.lock().map_err(|_|invalid("project_ui_probe_state_unavailable"))?;
        if inner.active.is_some(){return Err(invalid("project_ui_probe_sample_active"));}
        let id=inner.next_id.checked_add(1).ok_or_else(||invalid("project_ui_probe_id_exhausted"))?;
        crate::services::project_work_counters::reset();crate::perf_project_v5::reset_checkpoint_observation();
        let io_start=crate::perf_project_v5::process_io();let memory=MemorySampler::start();
        inner.active=Some(ActiveSample{id,scenario,epoch,io_start,memory,origin:Instant::now(),native_window_focused_at_start:None,intervals:Vec::new(),backend_ns:0,native_calls:0,in_flight:0,bytes:0,payload_missing:false});
        inner.next_id=id;Ok(id)
    }
    pub(crate) fn backend_span(&self,scenario:ProbeScenario,epoch:Option<u64>)->UiBackendSpan {
        let started=Instant::now();
        let sample_id=self.inner.lock().ok().and_then(|mut inner|{
            let sample=inner.active.as_mut()?;
            let matches=sample.scenario==scenario&&sample.epoch==epoch&&started>=sample.origin;
            if !matches{return None;}
            sample.in_flight=sample.in_flight.saturating_add(1);Some(sample.id)
        });
        UiBackendSpan{state:self.clone(),sample_id,started,payload_bytes:None}
    }
    pub(crate) fn finish(&self,id:u64,ui_ready_ms:Option<f64>,retention:Option<Value>,verified:bool)->Result<Value,AppError>{
        let active={
            let mut inner=self.inner.lock().map_err(|_|invalid("project_ui_probe_state_unavailable"))?;
            let active=inner.active.as_ref().ok_or_else(||invalid("project_ui_probe_sample_missing"))?;
            if active.id!=id{return Err(invalid("project_ui_probe_sample_stale"));}
            if verified&&active.in_flight>0{return Err(invalid("project_ui_probe_native_work_pending"));}
            inner.active.take().unwrap()
        };
        let io_end=crate::perf_project_v5::process_io();
        let work=crate::services::project_work_counters::snapshot();
        let checkpoint_bytes=crate::perf_project_v5::checkpoint_bytes();let checkpoint_method=crate::perf_project_v5::checkpoint_method();
        let memory=active.memory.finish();
        let union_ns=(active.native_calls>0&&active.in_flight==0&&active.intervals.len() as u64==active.native_calls)
            .then(||interval_union_ns(&active.intervals)).flatten();
        let backend_ms=union_ns.map(|value|value as f64/1_000_000.0);
        let (read_bytes,write_bytes)=match(active.io_start,io_end){(Some(before),Some(after))=>(after.0.checked_sub(before.0),after.1.checked_sub(before.1)),_=>(None,None)};
        let passed=verified&&!active.payload_missing&&active.in_flight==0&&backend_ms.zip(ui_ready_ms).is_some_and(|(backend,ui)|ui.is_finite()&&ui>=backend&&ui>=0.0);
        Ok(json!({"sampleId":id,"scenario":active.scenario,"processId":std::process::id(),"nativeWindowFocusedAtStart":active.native_window_focused_at_start,"nativeCalls":active.native_calls,"nativeCallsPending":active.in_flight,
            "backendMs":backend_ms,"backendMethod":"union of matching native operation intervals; overlapping invocations counted once; prefetch excluded",
            "backendTiming":"intervalUnion","backendIntervalsNs":active.intervals,
            "backendAggregateMs":union_ns.map(|_|active.backend_ns as f64/1_000_000.0),
            "backendOverlapMs":union_ns.and_then(|value|active.backend_ns.checked_sub(value)).map(|value|value as f64/1_000_000.0),"uiReadyMs":ui_ready_ms,
            "rssBytes":memory.map(|(_,peak)|peak),"rssBaselineBytes":memory.map(|(baseline,_)|baseline),
            "rssMethod":memory.and_then(|_|crate::perf_harness::process_memory_method()).map(|method|format!("{method}; main process sampled peak every5ms plus endpoints; WebContent process excluded")),
            "diskReadBytes":read_bytes,"diskWriteBytes":write_bytes,"ioMethod":active.io_start.map(|_|"proc_pid_rusage RUSAGE_INFO_V2 process diskio byte deltas"),
            "checkpointBytes":checkpoint_bytes,"checkpointMethod":checkpoint_method,
            "transferredBytes":(!active.payload_missing&&active.native_calls>0&&active.in_flight==0).then_some(active.bytes),
            "transferredBytesMethod":"serialized native reply payload bytes; excludes IPC envelope",
            "retention":retention,"forbiddenWork":work,"verification":{"passed":passed,"nativeObserved":active.native_calls>0}}))
    }
}

fn interval_union_ns(intervals:&[(u128,u128)])->Option<u128> {
    let mut sorted=intervals.to_vec();sorted.sort_unstable();
    let (mut start,mut end)=*sorted.first()?;if end<start{return None;}
    let mut total=0_u128;
    for &(next_start,next_end) in &sorted[1..] {
        if next_end<next_start{return None;}
        if next_start<=end {end=end.max(next_end);}else {total=total.checked_add(end-start)?;start=next_start;end=next_end;}
    }
    total.checked_add(end-start)
}

pub(crate) struct UiBackendSpan {state:UiProbeState,sample_id:Option<u64>,started:Instant,payload_bytes:Option<u64>}
impl UiBackendSpan {pub(crate) fn finish(mut self,payload_bytes:Option<u64>){self.payload_bytes=payload_bytes;}}
impl Drop for UiBackendSpan {
    fn drop(&mut self){
        let Some(id)=self.sample_id else{return;};
        let ended=Instant::now();
        if let Ok(mut inner)=self.state.inner.lock(){
            if let Some(sample)=inner.active.as_mut().filter(|sample|sample.id==id){
                sample.backend_ns=sample.backend_ns.saturating_add(ended.duration_since(self.started).as_nanos());
                if let (Some(start),Some(end))=(self.started.checked_duration_since(sample.origin),ended.checked_duration_since(sample.origin)) {
                    sample.intervals.push((start.as_nanos(),end.as_nanos()));
                }
                sample.native_calls=sample.native_calls.saturating_add(1);sample.in_flight=sample.in_flight.saturating_sub(1);
                if let Some(total)=self.payload_bytes.and_then(|bytes|sample.bytes.checked_add(bytes)){sample.bytes=total;}else{sample.payload_missing=true;}
            }
        }
    }
}

#[derive(Debug,Clone,Copy,Default,PartialEq,Eq,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub(crate) enum ProbeCacheMode {#[default] Warm,Cold}

#[cfg(target_os="macos")]
fn cold_file_cache(path:&std::path::Path)->Result<Value,AppError>{
    use std::os::{fd::AsRawFd,unix::fs::MetadataExt};
    use std::ffi::{c_void,c_char};
    unsafe extern "C" {
        fn getpagesize()->i32;
        fn mmap(address:*mut c_void,length:usize,protection:i32,flags:i32,fd:i32,offset:i64)->*mut c_void;
        fn msync(address:*mut c_void,length:usize,flags:i32)->i32;
        fn mincore(address:*mut c_void,length:usize,vector:*mut c_char)->i32;
        fn munmap(address:*mut c_void,length:usize)->i32;
    }
    struct Mapping{address:*mut c_void,length:usize}
    impl Drop for Mapping{fn drop(&mut self){unsafe{munmap(self.address,self.length);}}}
    let file=std::fs::File::open(path)?;let before=file.metadata()?;
    let length=usize::try_from(before.len()).map_err(|_|invalid("project_ui_probe_cold_file_too_large"))?;
    let page_size=unsafe{getpagesize()};
    if length==0||length>isize::MAX as usize||page_size<=0{return Err(invalid("project_ui_probe_cold_mapping_invalid"));}
    let page_size=page_size as usize;let pages=length.checked_add(page_size-1).ok_or_else(||invalid("project_ui_probe_cold_page_count_invalid"))?/page_size;
    let address=unsafe{mmap(std::ptr::null_mut(),length,1,1,file.as_raw_fd(),0)};
    if address as usize==usize::MAX{return Err(invalid("project_ui_probe_cold_mapping_failed"));}
    let mapping=Mapping{address,length};let mut vector=vec![0_i8;pages];
    let mut census=||->Result<usize,AppError>{
        if unsafe{mincore(mapping.address,mapping.length,vector.as_mut_ptr())}!=0{return Err(invalid("project_ui_probe_cold_census_failed"));}
        Ok(vector.iter().filter(|value|**value&1!=0).count())
    };
    let resident_before=census()?;
    // Apple mman.h: MS_SYNC=0x10, MS_INVALIDATE=0x02; affects this mapping/file only.
    if unsafe{msync(mapping.address,mapping.length,0x12)}!=0{return Err(invalid("project_ui_probe_cold_invalidation_failed"));}
    let resident_after=census()?;let after=std::fs::metadata(path)?;
    if resident_after!=0||before.dev()!=after.dev()||before.ino()!=after.ino()||before.len()!=after.len()||before.modified()?!=after.modified()? {
        return Err(invalid("project_ui_probe_cold_cache_unconfirmed"));
    }
    Ok(json!({"method":"owned-file MAP_SHARED + msync(MS_SYNC|MS_INVALIDATE), then mincore resident-bit census; preparation excluded from operation timing","residentPagesBefore":resident_before,"residentPagesAfter":resident_after,"pages":pages,"pageSize":page_size,"fileBytes":length,"device":before.dev(),"inode":before.ino()}))
}
#[cfg(not(target_os="macos"))]
fn cold_file_cache(_path:&std::path::Path)->Result<Value,AppError>{Err(invalid("project_ui_probe_cold_cache_unsupported"))}

#[derive(Debug,Clone,Serialize,Deserialize)]
#[serde(rename_all="kebab-case")]
pub(crate) enum ProbeFixtureTier {Regular,ManyDocuments,LongStrings}
#[derive(Debug,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(crate) struct UiProbeConfiguration {
    pub(crate) fixture_path:std::path::PathBuf,
    pub(crate) report_root:std::path::PathBuf,
    pub(crate) profile_path:std::path::PathBuf,
    pub(crate) source_tree_hash:String,
    pub(crate) tier:ProbeFixtureTier,
    pub(crate) samples:usize,
    #[serde(default)] pub(crate) cache_mode:ProbeCacheMode,
}
impl UiProbeConfiguration {
    pub(crate) fn parse(value:Value,expected_source:&str)->Result<Self,AppError>{
        let config:Self=serde_json::from_value(value).map_err(|_|invalid("project_ui_probe_configuration_invalid"))?;
        let source_valid=matches!(expected_source.len(),40|64)&&expected_source.bytes().all(|byte|byte.is_ascii_hexdigit());
        if !source_valid||config.source_tree_hash!=expected_source{return Err(invalid("project_ui_probe_source_changed"));}
        if config.cache_mode==ProbeCacheMode::Cold&&config.samples!=1{return Err(invalid("project_ui_probe_cold_requires_independent_process"));}
        if !(1..=1000).contains(&config.samples){return Err(invalid("project_ui_probe_samples_invalid"));}
        if [&config.fixture_path,&config.report_root,&config.profile_path].iter().any(|path|!path.is_absolute()){return Err(invalid("project_ui_probe_absolute_paths_required"));}
        if config.report_root==config.fixture_path||config.report_root==config.profile_path||config.fixture_path==config.profile_path{return Err(invalid("project_ui_probe_paths_overlap"));}
        Ok(config)
    }
}

pub(crate) struct UiReportWriter {root:std::path::PathBuf,template:Value}
impl UiReportWriter {
    pub(crate) fn new(root:&std::path::Path,template:Value)->Result<Self,AppError>{
        if !template.is_object(){return Err(invalid("project_ui_probe_report_metadata_invalid"));}
        std::fs::create_dir(root)?;
        Ok(Self{root:std::fs::canonicalize(root)?,template})
    }
    pub(crate) fn publish(&self,scenario:ProbeScenario,samples:&[Value])->Result<std::path::PathBuf,AppError>{
        use std::io::Write;
        let name=match scenario{ProbeScenario::Catalog=>"catalog",ProbeScenario::Window=>"window",ProbeScenario::Scroll=>"scroll",ProbeScenario::Edit=>"edit",ProbeScenario::Close=>"close"};
        let mode=self.template["cache"]["mode"].as_str().unwrap_or("warm");
        let path=self.root.join(format!("{name}-{mode}.json"));
        let mut report=self.template.clone();
        report["scenario"]=json!(scenario);if mode=="cold" {
            report["cache"]=json!({"mode":"cold","method":"owned-file msync(MS_SYNC|MS_INVALIDATE) immediately before sample, mincore confirms zero resident pages; independent App process", "osCache":if !samples.is_empty()&&samples.iter().all(|sample|sample["coldCache"]["residentPagesAfter"]==0){json!("confirmed-cold")}else{Value::Null}});
        } else {report["cache"]=json!({"mode":"warm","method":"same-process real App operations; OS cache not purged"});}
        report["samples"]=json!(samples);
        let run_failed=report.get("runError").is_some_and(|error|!error.is_null());
        report["verification"]=json!({"passed":!run_failed&&!samples.is_empty()&&samples.iter().all(|sample|sample["verification"]["passed"]==true)});
        let file=std::fs::OpenOptions::new().write(true).create_new(true).open(&path)?;
        let mut writer=std::io::BufWriter::new(file);
        serde_json::to_writer_pretty(&mut writer,&report).map_err(|error|AppError::FileIO(error.to_string()))?;
        writer.write_all(b"\n")?;writer.flush()?;writer.get_ref().sync_all()?;
        #[cfg(unix)] std::fs::File::open(&self.root)?.sync_all()?;
        Ok(path)
    }
}

pub(crate) struct UiProbeRunner {
    config:UiProbeConfiguration,fixture:Value,state:UiProbeState,writer:UiReportWriter,
    finished:Mutex<std::collections::BTreeMap<ProbeScenario,Vec<Value>>>,cold_observation:Mutex<Option<Value>>,
}
impl UiProbeRunner {
    pub(crate) fn load(value:Value)->Result<Self,AppError>{
        use std::io::Read;
        use crate::services::project_database::ProjectDatabase;
        let mut config=UiProbeConfiguration::parse(value,env!("STATSPLAYGROUND_BINARY_SOURCE_TREE_HASH"))?;
        config.fixture_path=std::fs::canonicalize(&config.fixture_path)?;
        config.profile_path=std::fs::canonicalize(&config.profile_path)?;
        if config.fixture_path==config.profile_path{return Err(invalid("project_ui_probe_paths_overlap"));}
        let mut bytes=Vec::new();std::fs::File::open(&config.profile_path)?.take(16*1024*1024+1).read_to_end(&mut bytes)?;
        if bytes.len()>16*1024*1024{return Err(invalid("project_ui_probe_profile_too_large"));}
        let profile:Value=serde_json::from_slice(&bytes).map_err(|_|invalid("project_ui_probe_profile_invalid"))?;
        let db=ProjectDatabase::open(&config.fixture_path,true)?;let header=db.header()?;
        let (dimensions,table,tier)=db.with_reader(db.epoch(),|engine|{
            let dimensions:(u64,u64,u64,u64,u64)=engine.conn().query_row("SELECT rows,columns,seed,original_revision,original_generation FROM _project_perf_fixture",[],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?)))?;
            let has_tier:u64=engine.conn().query_row("SELECT count(*) FROM information_schema.tables WHERE table_name='_project_perf_tier'",[],|row|row.get(0))?;
            let tier:String=if has_tier>0{engine.conn().query_row("SELECT tier FROM _project_perf_tier",[],|row|row.get(0))?}else{"regular".into()};
            Ok((dimensions,engine.get_dataset_meta("perf-data")?,tier))
        })?;
        if serde_json::to_value(&config.tier).ok()!=Some(json!(tier)){return Err(invalid("project_ui_probe_fixture_tier_mismatch"));}
        if dimensions.0==0||dimensions.0>i64::MAX as u64||!(1..=1000).contains(&dimensions.1)||table.row_count!=dimensions.0 as i64||table.col_count as u64!=dimensions.1||table.generation!=dimensions.4||header.committed_revision!=dimensions.3 {
            return Err(invalid("project_ui_probe_fixture_changed"));
        }
        if profile["schemaVersion"]!=1||profile["scenario"]!="profile"||profile["verification"]["passed"]!=true||profile["source"]["treeHash"]!=config.source_tree_hash||profile["source"]["commit"]!=env!("STATSPLAYGROUND_BINARY_SOURCE_COMMIT")||profile["source"]["profile"]!=env!("STATSPLAYGROUND_BINARY_BUILD_PROFILE")||profile["source"]["engineVersion"]!=header.engine_version||profile["source"]["storageVersion"]!=header.storage_version {
            return Err(invalid("project_ui_probe_profile_source_invalid"));
        }
        if profile["fixture"]["id"]!=header.project_id||profile["fixture"]["rows"]!=dimensions.0||profile["fixture"]["columns"]!=dimensions.1||profile["fixture"]["seed"]!=dimensions.2 {
            return Err(invalid("project_ui_probe_profile_fixture_invalid"));
        }
        for key in ["archiveRestoredRows","archiveWriterCalls","fullDatabaseCopies","fullBeforeImageCopies","fullAnchorRebuilds","fullWindowCounts"] {
            if profile["forbiddenWork"][key]!=0{return Err(invalid("project_ui_probe_profile_bulk_work"));}
        }
        let queries=profile["profiling"]["queries"].as_array().ok_or_else(||invalid("project_ui_probe_profile_queries_missing"))?;
        if queries.len()!=3||profile["profiling"]["verifiedNoFullScan"]!=true{return Err(invalid("project_ui_probe_profile_unqualified"));}
        let mut observations=Vec::new();
        for query in queries {
            let mut scans=Vec::new();
            let valid=crate::perf_project_v5::source_scan_rows(&query["plan"],&mut scans)&&!scans.is_empty();
            let count=scans.iter().try_fold(0_u64,|total,value|total.checked_add(*value));
            let count=count.filter(|count|valid&&*count<dimensions.0).ok_or_else(||invalid("project_ui_probe_profile_full_scan"))?;
            observations.push(count);
        }
        db.shutdown()?;
        let fixture=json!({"id":header.project_id,"rows":dimensions.0,"columns":dimensions.1,"seed":dimensions.2,"tier":config.tier});
        let template=json!({"schemaVersion":1,"cache":{"mode":config.cache_mode},"source":{"commit":env!("STATSPLAYGROUND_BINARY_SOURCE_COMMIT"),"treeHash":env!("STATSPLAYGROUND_BINARY_SOURCE_TREE_HASH"),"profile":env!("STATSPLAYGROUND_BINARY_BUILD_PROFILE"),"engineVersion":header.engine_version,"storageVersion":header.storage_version,"nativeTimingVersion":2,"uiObservationVersion":2,"uiProbeBuild":option_env!("VITE_PROJECT_V5_BENCHMARK")==Some("1")},"fixture":fixture,"profiling":{"method":profile["profiling"]["method"],"verifiedNoFullScan":true,"sourceRowsScanned":observations,"artifact":config.profile_path},"uiMethod":"real App exact visible state followed by two animation frames; not compositor presentation timing"});
        let writer=UiReportWriter::new(&config.report_root,template)?;
        config.report_root=writer.root.clone();
        Ok(Self{config,fixture,state:UiProbeState::new(),writer,finished:Mutex::new(std::collections::BTreeMap::new()),cold_observation:Mutex::new(None)})
    }
    pub(crate) fn begin(&self,state:&crate::state::AppState,scenario:ProbeScenario,epoch:Option<u64>,window_focused:bool)->Result<u64,AppError>{
        if !window_focused{return Err(invalid("project_ui_probe_window_not_focused"));}
        let finished=self.finished.lock().map_err(|_|invalid("project_ui_probe_results_unavailable"))?;
        if self.state.inner.lock().map_err(|_|invalid("project_ui_probe_state_unavailable"))?.active.is_some(){return Err(invalid("project_ui_probe_sample_active"));}
        if self.config.cache_mode==ProbeCacheMode::Cold&&(scenario!=ProbeScenario::Catalog||!finished.is_empty()){return Err(invalid("project_ui_probe_cold_catalog_only"));}
        let owner=state.project_database.read().map_err(|_|invalid("project_ui_probe_owner_unavailable"))?;
        if scenario==ProbeScenario::Catalog {
            if epoch.is_some()||owner.is_some(){return Err(invalid("project_ui_probe_catalog_requires_closed_project"));}
        } else {
            let db=owner.as_ref().ok_or_else(||invalid("project_ui_probe_project_missing"))?;
            if epoch!=Some(db.epoch())||db.path()!=self.config.fixture_path||db.header()?.project_id!=self.fixture["id"].as_str().unwrap_or("") {
                return Err(invalid("project_ui_probe_foreign_project"));
            }
            if scenario==ProbeScenario::Edit&&db.is_read_only(){return Err(invalid("project_ui_probe_writable_project_required"));}
        }
        if self.config.cache_mode==ProbeCacheMode::Cold {
            *self.cold_observation.lock().map_err(|_|invalid("project_ui_probe_cold_observation_unavailable"))?=Some(cold_file_cache(&self.config.fixture_path)?);
        }
        let id=self.state.begin(scenario,epoch)?;
        self.state.inner.lock().map_err(|_|invalid("project_ui_probe_state_unavailable"))?.active.as_mut().ok_or_else(||invalid("project_ui_probe_sample_missing"))?.native_window_focused_at_start=Some(window_focused);
        Ok(id)
    }
    pub(crate) fn finish(&self,id:u64,ui_ready_ms:Option<f64>,retention:Option<Value>,verified:bool,error:Option<String>,window_focused:bool)->Result<Value,AppError>{
        let mut finished=self.finished.lock().map_err(|_|invalid("project_ui_probe_results_unavailable"))?;
        let mut sample=self.state.finish(id,ui_ready_ms,retention,verified&&error.is_none())?;
        sample["nativeWindowFocusedAtFinish"]=json!(window_focused);
        sample["nativeWindowFocusMethod"]=json!("Tauri window.is_focused at native begin and finish; DOM input focus is separate diagnostic evidence");
        if self.config.cache_mode==ProbeCacheMode::Cold {
            sample["coldCache"]=self.cold_observation.lock().map_err(|_|invalid("project_ui_probe_cold_observation_unavailable"))?.take().unwrap_or(Value::Null);
            if sample["coldCache"]["residentPagesAfter"]!=0{sample["verification"]["passed"]=json!(false);}
        }
        let mut wal_path=self.config.fixture_path.as_os_str().to_os_string();wal_path.push(".wal");
        sample["walBytes"]=match std::fs::metadata(std::path::PathBuf::from(wal_path)) {
            Ok(metadata)=>json!(metadata.len()),Err(error) if error.kind()==std::io::ErrorKind::NotFound=>json!(0),Err(_)=>Value::Null,
        };
        sample["walMethod"]=json!("project WAL file size after operation; absent file is zero");
        if let Some(error)=error{sample["error"]=json!(error.chars().take(2048).collect::<String>());}
        let scenario=serde_json::from_value(sample["scenario"].clone()).map_err(|_|invalid("project_ui_probe_scenario_invalid"))?;
        finished.entry(scenario).or_default().push(sample.clone());Ok(sample)
    }
    pub(crate) fn publish(&self,scenario:ProbeScenario,run_error:Option<String>)->Result<std::path::PathBuf,AppError>{
        let finished=self.finished.lock().map_err(|_|invalid("project_ui_probe_results_unavailable"))?;
        let active=self.state.inner.lock().map_err(|_|invalid("project_ui_probe_state_unavailable"))?;
        if active.active.is_some(){return Err(invalid("project_ui_probe_sample_active"));}
        if self.config.cache_mode==ProbeCacheMode::Cold&&scenario!=ProbeScenario::Catalog{return Err(invalid("project_ui_probe_cold_catalog_only"));}
        let samples=finished.get(&scenario).map(Vec::as_slice).unwrap_or(&[]);
        if let Some(error)=run_error {
            let mut template=self.writer.template.clone();template["runError"]=json!(error.chars().take(2048).collect::<String>());
            UiReportWriter{root:self.writer.root.clone(),template}.publish(scenario,samples)
        } else {self.writer.publish(scenario,samples)}
    }
    pub(crate) fn configuration(&self)->Value {
        json!({"fixturePath":self.config.fixture_path,"fixtureId":self.fixture["id"],"datasetId":"perf-data","rows":self.fixture["rows"],"columns":self.fixture["columns"],"seed":self.fixture["seed"],"tier":self.fixture["tier"],"samples":self.config.samples,"cacheMode":self.config.cache_mode})
    }
}

static RUNNER:std::sync::OnceLock<Result<Option<Arc<UiProbeRunner>>,String>>=std::sync::OnceLock::new();
pub(crate) fn runtime()->Result<Option<Arc<UiProbeRunner>>,AppError>{
    RUNNER.get_or_init(||{
        if option_env!("VITE_PROJECT_V5_BENCHMARK")!=Some("1"){return Ok(None);}
        let Some(path)=std::env::var_os("STATSPG_PROJECT_V5_UI_CONFIG") else{return Ok(None);};
        (||->Result<_,AppError>{
            use std::io::Read;
            let mut bytes=Vec::new();std::fs::File::open(path)?.take(65537).read_to_end(&mut bytes)?;
            if bytes.len()>65536{return Err(invalid("project_ui_probe_configuration_too_large"));}
            let value=serde_json::from_slice(&bytes).map_err(|_|invalid("project_ui_probe_configuration_invalid"))?;
            Ok(Some(Arc::new(UiProbeRunner::load(value)?)))
        })().map_err(|error|error.to_string())
    }).clone().map_err(AppError::InvalidParam)
}
pub(crate) fn operation_span(scenario:ProbeScenario,epoch:Option<u64>,path:Option<&std::path::Path>)->Option<UiBackendSpan>{
    let runner=runtime().ok().flatten()?;
    if let Some(path)=path{if std::fs::canonicalize(path).ok().as_ref()!=Some(&runner.config.fixture_path){return None;}}
    Some(runner.state.backend_span(scenario,epoch))
}
pub(crate) fn query_span(state:&crate::state::AppState,dataset_id:&str,request_id:Option<&str>)->Option<UiBackendSpan>{
    if dataset_id!="perf-data"||request_id.is_some_and(|id|id.starts_with("table-nav-prefetch")){return None;}
    let runner=runtime().ok().flatten()?;
    let epoch=state.project_database.read().ok()?.as_ref()?.epoch();
    let scenario=runner.state.inner.lock().ok()?.active.as_ref()?.scenario;
    if !matches!(scenario,ProbeScenario::Window|ProbeScenario::Scroll|ProbeScenario::Edit){return None;}
    Some(runner.state.backend_span(scenario,Some(epoch)))
}
pub(crate) fn finish_span<T:Serialize>(span:Option<UiBackendSpan>,result:&Result<T,AppError>){
    if let Some(span)=span{span.finish(result.as_ref().ok().and_then(|value|serde_json::to_vec(value).ok()).map(|bytes|bytes.len() as u64));}
}

#[cfg(test)]
mod tests {
    use super::*;
    fn configured_probe_fixture()->(tempfile::TempDir,Value) {
        use crate::services::{project_database::ProjectDatabase,project_catalog::ProjectCatalog};
        let directory=tempfile::tempdir().unwrap();let path=directory.path().join("fixture.spprj");let profile=directory.path().join("profile.json");
        let db=ProjectDatabase::create(&path,false).unwrap();
        db.with_engine(|engine|{
            engine.create_empty_table("perf-data","Data",&["c0".into()],&["BIGINT".into()])?;
            engine.conn().execute_batch("INSERT INTO dataset_perf_data(_row_id,c0) SELECT range+1,range FROM range(5); UPDATE _meta_datasets SET row_count=5 WHERE id='perf-data'; CREATE TABLE _project_perf_fixture(rows UBIGINT,columns UBIGINT,seed UBIGINT,original_revision UBIGINT,original_generation UBIGINT); INSERT INTO _project_perf_fixture VALUES(5,1,282,0,0)")?;
            engine.rebuild_natural_anchors("perf-data",0)?;ProjectCatalog::new(engine).publish_table(&engine.get_dataset_meta("perf-data")?,"")?;Ok(())
        }).unwrap();
        let header=db.header().unwrap();db.shutdown().unwrap();
        let raw=json!({"schemaVersion":1,"scenario":"profile","source":{"treeHash":env!("STATSPLAYGROUND_BINARY_SOURCE_TREE_HASH"),"commit":env!("STATSPLAYGROUND_BINARY_SOURCE_COMMIT"),"profile":env!("STATSPLAYGROUND_BINARY_BUILD_PROFILE"),"engineVersion":header.engine_version,"storageVersion":header.storage_version},"fixture":{"id":header.project_id,"rows":5,"columns":1,"seed":282},"verification":{"passed":true},"forbiddenWork":{"archiveRestoredRows":0,"archiveWriterCalls":0,"fullDatabaseCopies":0,"fullBeforeImageCopies":0,"fullAnchorRebuilds":0,"fullWindowCounts":0},"profiling":{"method":"configuration contract fixture; not a performance measurement","verifiedNoFullScan":true,"queries":vec![json!({"plan":{"operator_type":"TABLE_SCAN","operator_rows_scanned":1,"extra_info":{"Table":"fixture.main.dataset_perf_data"}}});3]}});
        std::fs::write(&profile,serde_json::to_vec(&raw).unwrap()).unwrap();
        let config=json!({"fixturePath":path,"profilePath":profile,"reportRoot":directory.path().join("reports"),"sourceTreeHash":env!("STATSPLAYGROUND_BINARY_SOURCE_TREE_HASH"),"tier":"regular","samples":1});
        (directory,config)
    }
    #[cfg(target_os="macos")]
    #[test]
    fn cold_cache_probe_evicts_only_owned_file_and_reports_residency() {
        use std::io::Write;
        let mut file=tempfile::NamedTempFile::new().unwrap();file.write_all(&vec![7_u8;1024*1024]).unwrap();file.as_file().sync_all().unwrap();
        let observed=cold_file_cache(file.path()).unwrap();
        assert_eq!(observed["residentPagesAfter"],0);assert!(observed["pages"].as_u64().unwrap()>0);assert_eq!(std::fs::metadata(file.path()).unwrap().len(),1024*1024);
    }
    #[test]
    fn cold_ui_configuration_requires_one_sample_and_retains_mode() {
        let (_directory,mut config)=configured_probe_fixture();config["cacheMode"]=json!("cold");
        let parsed=UiProbeConfiguration::parse(config.clone(),env!("STATSPLAYGROUND_BINARY_SOURCE_TREE_HASH")).unwrap();assert_eq!(serde_json::to_value(parsed.cache_mode).unwrap(),"cold");
        config["samples"]=json!(2);assert!(UiProbeConfiguration::parse(config,env!("STATSPLAYGROUND_BINARY_SOURCE_TREE_HASH")).is_err());
    }
    #[cfg(target_os="macos")]
    #[test]
    fn cold_runner_prepares_catalog_before_timing_and_publishes_one_owned_sample() {
        let (_directory,mut config)=configured_probe_fixture();config["cacheMode"]=json!("cold");
        let runner=UiProbeRunner::load(config).unwrap();let state=crate::state::AppState::new().unwrap();
        let id=runner.begin(&state,ProbeScenario::Catalog,None,true).unwrap();let span=runner.state.backend_span(ProbeScenario::Catalog,None);span.finish(Some(1));
        let sample=runner.finish(id,Some(10000.0),None,true,None,true).unwrap();assert_eq!(sample["coldCache"]["residentPagesAfter"],0);
        assert!(runner.begin(&state,ProbeScenario::Catalog,None,true).is_err());assert!(runner.publish(ProbeScenario::Window,None).is_err());
        let path=runner.publish(ProbeScenario::Catalog,None).unwrap();assert_eq!(path.file_name().unwrap(),"catalog-cold.json");
        let report:Value=serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();assert_eq!(report["cache"]["osCache"],"confirmed-cold");
    }
    #[test]
    fn ui_probe_runner_binds_samples_to_live_fixture_epoch_and_publishes_native_observations() {
        use crate::services::project_native_service::NativeProjectService;
        let (_directory,config)=configured_probe_fixture();let runner=UiProbeRunner::load(config).unwrap();let state=crate::state::AppState::new().unwrap();
        assert!(runner.begin(&state,ProbeScenario::Window,Some(7),true).is_err());
        assert!(runner.begin(&state,ProbeScenario::Catalog,None,false).is_err());
        let id=runner.begin(&state,ProbeScenario::Catalog,None,true).unwrap();let span=runner.state.backend_span(ProbeScenario::Catalog,None);
        let native=NativeProjectService::new(&state);let opened=native.open(&runner.config.fixture_path,false).unwrap();span.finish(Some(serde_json::to_vec(&opened).unwrap().len() as u64));
        let sample=runner.finish(id,Some(10000.0),None,true,None,true).unwrap();assert_eq!(sample["verification"]["passed"],true);assert_eq!(sample["nativeCalls"],1);assert_eq!(sample["nativeWindowFocusedAtStart"],true);assert_eq!(sample["nativeWindowFocusedAtFinish"],true);
        assert!(runner.begin(&state,ProbeScenario::Window,Some(opened.epoch+1),true).is_err());
        let path=runner.publish(ProbeScenario::Catalog,None).unwrap();let report:Value=serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();assert_eq!(report["samples"].as_array().unwrap().len(),1);assert_eq!(report["samples"][0]["sampleId"],id);
        assert!(runner.publish(ProbeScenario::Catalog,None).is_err());native.close(opened.epoch).unwrap();
    }
    #[test]
    fn ui_probe_runner_validates_native_fixture_and_profile_before_creating_reports() {
        let (_directory,config)=configured_probe_fixture();let runner=UiProbeRunner::load(config.clone()).unwrap();
        let public=runner.configuration();assert_eq!(public["rows"],5);assert_eq!(public["columns"],1);assert_eq!(public["samples"],1);
        assert!(std::path::Path::new(config["reportRoot"].as_str().unwrap()).is_dir());
    }
    #[test]
    fn ui_probe_runner_rejects_forged_or_stale_profile_without_creating_reports() {
        let (_directory,config)=configured_probe_fixture();let path=std::path::Path::new(config["profilePath"].as_str().unwrap());
        let original:Value=serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        for mode in ["source","identity","logical","scan"] {
            let mut profile=original.clone();match mode {
                "source"=>profile["source"]["treeHash"]=json!("b".repeat(40)),
                "identity"=>profile["fixture"]["id"]=json!("foreign"),
                "logical"=>profile["verification"]["passed"]=json!(false),
                _=>profile["profiling"]["queries"][0]["plan"]["operator_rows_scanned"]=json!(5),
            }
            std::fs::write(path,serde_json::to_vec(&profile).unwrap()).unwrap();assert!(UiProbeRunner::load(config.clone()).is_err(),"{mode}");
            assert!(!std::path::Path::new(config["reportRoot"].as_str().unwrap()).exists());
        }
    }
    #[test]
    fn report_writer_retains_admission_error_and_never_labels_partial_run_successful() {
        let directory=tempfile::tempdir().unwrap();let root=directory.path().join("reports");
        let writer=UiReportWriter::new(&root,json!({"schemaVersion":1,"cache":{"mode":"warm"},"runError":"native window activation pending"})).unwrap();
        let path=writer.publish(ProbeScenario::Catalog,&[json!({"verification":{"passed":true}})]).unwrap();
        let report:Value=serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        assert_eq!(report["runError"],"native window activation pending");assert_eq!(report["verification"]["passed"],false);
    }
    fn probe_configuration_value()->Value {json!({"fixturePath":"/owned-fixture.spprj","reportRoot":"/owned-new-reports","profilePath":"/owned-profile.json","sourceTreeHash":"a".repeat(40),"tier":"regular","samples":100})}
    #[test]
    fn ui_probe_configuration_accepts_only_scoped_matching_source_parameters() {
        let hash="a".repeat(40);let config=UiProbeConfiguration::parse(probe_configuration_value(),&hash).unwrap();assert_eq!(config.samples,100);
        for (key,value) in [("sourceTreeHash",json!("b".repeat(40))),("samples",json!(0)),("samples",json!(1001)),("fixturePath",json!("relative.spprj")),("tier",json!("unknown")),("cacheMode",json!("unsupported"))] {
            let mut config=probe_configuration_value();config[key]=value;assert!(UiProbeConfiguration::parse(config,&hash).is_err(),"{key}");
        }
    }
    #[test]
    fn ui_probe_configuration_cannot_reuse_the_fixture_as_report_root() {
        let mut config=probe_configuration_value();config["reportRoot"]=config["fixturePath"].clone();assert!(UiProbeConfiguration::parse(config,&"a".repeat(40)).is_err());
    }
    #[test]
    fn ui_probe_reports_are_owned_and_never_overwrite_existing_evidence() {
        let directory=tempfile::tempdir().unwrap();let root=directory.path().join("owned-run");
        let writer=UiReportWriter::new(&root,json!({"schemaVersion":1,"source":{"profile":"debug"},"fixture":{"id":"fixture"}})).unwrap();
        let path=writer.publish(ProbeScenario::Window,&[json!({"verification":{"passed":true}})]).unwrap();
        assert_eq!(path.parent(),Some(root.canonicalize().unwrap().as_path()));assert_eq!(path.file_name().unwrap(),"window-warm.json");
        let retained=std::fs::read(&path).unwrap();assert!(writer.publish(ProbeScenario::Window,&[]).is_err());assert_eq!(std::fs::read(path).unwrap(),retained);
        assert!(UiReportWriter::new(&root,json!({})).is_err());
        assert!(serde_json::from_value::<ProbeScenario>(json!("../outside")).is_err());
    }
    #[test]
    fn ui_probe_empty_or_failed_report_cannot_claim_logical_success() {
        let directory=tempfile::tempdir().unwrap();let writer=UiReportWriter::new(&directory.path().join("failed-run"),json!({"schemaVersion":1})).unwrap();
        let empty=writer.publish(ProbeScenario::Catalog,&[]).unwrap();
        let failed=writer.publish(ProbeScenario::Edit,&[json!({"verification":{"passed":false}})]).unwrap();
        for path in [empty,failed] {let report:Value=serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();assert_eq!(report["verification"]["passed"],false);}
    }
    #[test]
    fn ui_probe_completion_is_owned_and_missing_native_observation_fails_closed() {
        let state=UiProbeState::new();let sample=state.begin(ProbeScenario::Catalog,None).unwrap();
        assert!(state.begin(ProbeScenario::Window,Some(7)).is_err());
        assert!(state.finish(sample+1,Some(10.0),None,true).is_err());
        let result=state.finish(sample,Some(10.0),None,true).unwrap();
        assert!(result["backendMs"].is_null());assert_eq!(result["verification"]["passed"],false);
    }
    #[test]
    fn native_interval_union_handles_nested_reversed_and_disjoint_completion() {
        assert_eq!(interval_union_ns(&[(40,45),(10,30),(22,25),(0,20),(45,50)]),Some(40));
        assert_eq!(interval_union_ns(&[(0,10),(20,30)]),Some(20));
        assert_eq!(interval_union_ns(&[(5,4)]),None);assert_eq!(interval_union_ns(&[]),None);
    }
    #[test]
    fn overlapping_native_spans_do_not_exceed_their_observed_wall_time() {
        let state=UiProbeState::new();let sample=state.begin(ProbeScenario::Edit,Some(7)).unwrap();
        let wall=Instant::now();
        let first=state.backend_span(ProbeScenario::Edit,Some(7));
        let second=state.backend_span(ProbeScenario::Edit,Some(7));
        std::thread::sleep(Duration::from_millis(20));
        first.finish(Some(100));second.finish(Some(200));
        let wall_ms=wall.elapsed().as_secs_f64()*1000.0;
        let result=state.finish(sample,Some(wall_ms*1.5),None,true).unwrap();
        assert_eq!(result["nativeCalls"],2);assert_eq!(result["transferredBytes"],300);
        assert!(result["backendMs"].as_f64().unwrap()<=wall_ms,"parallel native calls occupy one wall-clock interval");
        assert_eq!(result["verification"]["passed"],true,"visible completion after overlapping work is valid");
        assert!(result["backendAggregateMs"].as_f64().unwrap()>result["backendMs"].as_f64().unwrap());
        assert!(result["backendOverlapMs"].as_f64().unwrap()>0.0);
    }
    #[test]
    fn ui_probe_backend_spans_ignore_foreign_epoch_and_operation() {
        let state=UiProbeState::new();let sample=state.begin(ProbeScenario::Window,Some(7)).unwrap();
        state.backend_span(ProbeScenario::Edit,Some(7)).finish(Some(111));
        state.backend_span(ProbeScenario::Window,Some(8)).finish(Some(222));
        state.backend_span(ProbeScenario::Window,Some(7)).finish(Some(500));
        let result=state.finish(sample,Some(10000.0),None,true).unwrap();
        assert_eq!(result["nativeCalls"],1);assert_eq!(result["transferredBytes"],500);
        assert!(result["backendMs"].as_f64().unwrap().is_finite());assert_eq!(result["verification"]["passed"],true);
    }
    #[test]
    fn failed_ui_sample_is_retained_and_releases_its_sampler() {
        let state=UiProbeState::new();let sample=state.begin(ProbeScenario::Edit,Some(3)).unwrap();
        state.backend_span(ProbeScenario::Edit,Some(3)).finish(Some(32));
        let failed=state.finish(sample,None,None,false).unwrap();assert_eq!(failed["verification"]["passed"],false);
        let next=state.begin(ProbeScenario::Close,Some(3)).unwrap();assert!(next>sample);
        state.finish(next,None,None,false).unwrap();
    }
}
