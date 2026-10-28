const counters=['archiveRestoredRows','archiveWriterCalls','fullDatabaseCopies','fullBeforeImageCopies','fullAnchorRebuilds','fullWindowCounts'];
const limits={catalog:500,window:300,scroll:100,edit:200,close:500};
const text=value=>typeof value==='string'&&value.trim().length>0;
const finite=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
const integer=value=>Number.isSafeInteger(value)&&value>=0;
const percentile=(values,fraction)=>[...values].sort((a,b)=>a-b)[Math.ceil(values.length*fraction)-1];
const median=values=>{const sorted=[...values].sort((a,b)=>a-b),middle=Math.floor(sorted.length/2);return sorted.length%2?sorted[middle]:(sorted[middle-1]+sorted[middle])/2;};

function nativeIntervalProof(sample){
 if(sample?.backendTiming!=='intervalUnion'||!integer(sample?.nativeCalls)||sample.nativeCalls<1||!Array.isArray(sample?.backendIntervalsNs)||sample.backendIntervalsNs.length!==sample.nativeCalls)return null;
 const intervals=sample.backendIntervalsNs.map(value=>Array.isArray(value)?[...value]:null);
 if(intervals.some(value=>!value||value.length!==2||!integer(value[0])||!integer(value[1])||value[1]<value[0]))return null;
 intervals.sort((a,b)=>a[0]-b[0]);let [start,end]=intervals[0],union=0,aggregate=0;
 for(const [nextStart,nextEnd] of intervals){aggregate+=nextEnd-nextStart;if(nextStart<=end)end=Math.max(end,nextEnd);else{union+=end-start;start=nextStart;end=nextEnd;}}
 union+=end-start;if(!integer(union)||!integer(aggregate))return null;
 const matches=(actual,ns)=>finite(actual)&&Math.abs(actual-ns/1000000)<=0.000001;
 return matches(sample.backendMs,union)&&matches(sample.backendAggregateMs,aggregate)&&matches(sample.backendOverlapMs,aggregate-union);
}

function foregroundPhaseProof(sample,version) {
 const phases=sample?.retention?.uiPhases;
 const focus=version===2?sample?.nativeWindowFocusedAtStart===true&&sample?.nativeWindowFocusedAtFinish===true:phases?.focusedAtStart===true&&phases?.focusedAtFinish===true;
 if(!phases||!focus||phases.visibilityAtStart!=='visible'||phases.visibilityAtFinish!=='visible'||!finite(phases.operationFinishedMs)||!finite(phases.readyObservedMs)||phases.readyObservedMs<phases.operationFinishedMs||phases.readyObservedMs>sample.uiReadyMs||!Array.isArray(phases.framesMs))return false;
 let previous=0,postReady=0;
 for(const interval of phases.framesMs){if(!Array.isArray(interval)||interval.length!==2)return false;const [start,end]=interval;if(!finite(start)||!finite(end)||start<previous||end<start||end>sample.uiReadyMs)return false;previous=end;if(start>=phases.readyObservedMs)postReady++;}
 return postReady>=2;
}

/** Missing OS/UI/profiling observations are failures, never inferred zero work. */
export function assessProjectV5Report(report) {
 const failures=[];const fail=message=>failures.push(message);
 if(report?.schemaVersion!==1)fail('unsupported report schema');
 if(!Object.hasOwn(limits,report?.scenario))fail('unsupported ordinary lifecycle scenario');
 const source=report?.source;
 if(source?.uiProbeBuild!==true)fail('instrumented native UI build required for UI qualification');
 if(source?.profile!=='release'||!/^([a-f0-9]{40}|[a-f0-9]{64})$/.test(source?.commit??'')||!/^([a-f0-9]{40}|[a-f0-9]{64})$/.test(source?.treeHash??'')||!text(source?.engineVersion)||!text(source?.storageVersion))fail('release source/build/engine provenance required');
 const fixture=report?.fixture;
 if(!text(fixture?.id)||!text(fixture?.tier)||!integer(fixture?.rows)||!integer(fixture?.columns)||fixture.columns<1||!integer(fixture?.seed))fail('fixture identity required');
 if(report?.verification?.passed!==true)fail('logical verification failed or unavailable');
 if(!text(report?.profiling?.method)||report?.profiling?.verifiedNoFullScan!==true)fail('SQL profiling evidence required');
 const cold=report?.cache?.mode==='cold';
 if(cold&&report?.scenario!=='catalog')fail('cold budget is defined only for catalog opens');
 if(cold&&report?.cache?.osCache!=='confirmed-cold')fail('cold OS cache observation required');
 if(!['cold','warm'].includes(report?.cache?.mode)||!text(report?.cache?.method))fail('cache method required');
 const samples=Array.isArray(report?.samples)?report.samples:[];
 if(samples.length<(cold?5:100))fail(cold?'at least five cold opens required':'at least 100 warm samples required');
 if(report.source?.uiObservationVersion!==undefined&&![1,2].includes(report.source.uiObservationVersion))fail('unsupported UI observation version');
 if(report.source?.nativeTimingVersion!==undefined&&report.source.nativeTimingVersion!==2)fail('unsupported native timing version');
 const backend=[],ui=[],processes=new Set();
 for(const [index,sample] of samples.entries()) {
  const prefix=`sample ${index}: `;
  if([1,2].includes(report.source?.uiObservationVersion)&&!foregroundPhaseProof(sample,report.source.uiObservationVersion))fail(prefix+'foreground UI phase proof unavailable or inconsistent');
  if(report.source?.nativeTimingVersion===2&&!nativeIntervalProof(sample))fail(prefix+'native interval timing proof unavailable or inconsistent');
  if(sample?.verification?.passed!==true)fail(prefix+'logical verification failed or unavailable');
  if(cold){
   const proof=sample?.coldCache;
   if(!text(proof?.method)||!proof.method.includes('mincore')||proof.residentPagesAfter!==0||!integer(proof?.residentPagesBefore)||!integer(proof?.pages)||proof.pages<1||proof.residentPagesBefore>proof.pages||!integer(proof?.fileBytes)||proof.fileBytes<1||!integer(proof?.pageSize)||proof.pageSize<1||proof.pages!==Math.ceil(proof.fileBytes/proof.pageSize)||!integer(proof?.device)||proof.device<1||!integer(proof?.inode)||proof.inode<1)fail(prefix+'cold file-cache residency proof unavailable or invalid');
   if(!(sample?.diskReadBytes>0))fail(prefix+'cold directory did not observe physical reads');
  }
  if(!integer(sample?.processId)||sample.processId===0)fail(prefix+'process identity required');else processes.add(sample.processId);
  for(const key of ['backendMs','uiReadyMs','rssBytes','diskReadBytes','diskWriteBytes','walBytes','checkpointBytes','transferredBytes'])if(!finite(sample?.[key]))fail(prefix+key+' unavailable or invalid');
  if(!(sample?.rssBytes>0)||!text(sample?.rssMethod))fail(prefix+'RSS observation required');
  if(!text(sample?.ioMethod))fail(prefix+'actual process IO method required');
  if(finite(sample?.backendMs))backend.push(sample.backendMs);
  if(finite(sample?.uiReadyMs))ui.push(sample.uiReadyMs);
  if(finite(sample?.uiReadyMs)&&finite(sample?.backendMs)&&sample.uiReadyMs<sample.backendMs)fail(prefix+'UI readiness precedes native completion');
  for(const key of counters)if(sample?.forbiddenWork?.[key]!==0)fail(prefix+key+' is nonzero or unavailable');
  if(['window','scroll'].includes(report?.scenario)) {
   const value=sample?.retention;
   if(!value||!integer(value.viewportRows)||value.viewportRows>5000||!integer(value.viewportBytes)||value.viewportBytes>64*1024*1024||!integer(value.aggregateRows)||value.aggregateRows>10000||!integer(value.aggregateBytes)||value.aggregateBytes>128*1024*1024||!integer(value.activeViewports)||value.activeViewports<1||value.activeViewports>2)fail(prefix+'viewport retention missing or exceeds cap');
  }
 }
 if(cold&&processes.size!==samples.length)fail('cold opens must use independent processes');
 const backendP95Ms=backend.length?percentile(backend,0.95):null,uiP95Ms=ui.length?percentile(ui,0.95):null;
 const backendMedianMs=backend.length?median(backend):null,uiMedianMs=ui.length?median(ui):null;
 const budgetMs=cold?(report?.scenario==='catalog'?1000:null):limits[report?.scenario];
 if(budgetMs!==null&&budgetMs!==undefined) {
  const nativeValue=cold?backendMedianMs:backendP95Ms,uiValue=cold?uiMedianMs:uiP95Ms;
  if(nativeValue!==null&&nativeValue>budgetMs)fail('native latency exceeds budget');
  if(uiValue!==null&&uiValue>budgetMs)fail('UI latency exceeds budget');
 }
 return {qualified:failures.length===0,failures,sampleCount:samples.length,backendP95Ms,uiP95Ms,backendMedianMs,uiMedianMs,budgetMs};
}

export function evaluateProjectV5Budget(reports) {
 const failures=[],results=[];
 if(!Array.isArray(reports)||reports.length===0)return {qualified:false,failures:['no reports'],results};
 for(const report of reports) {
  const assessment=assessProjectV5Report(report);results.push({scenario:report.scenario,fixture:report.fixture,assessment});
  failures.push(...assessment.failures.map(message=>`${report.fixture?.id??'unknown'}/${report.scenario}: ${message}`));
  if(report.source?.uiObservationVersion!==reports[0].source?.uiObservationVersion)failures.push('reports use different UI observation versions');
  if(report.source?.nativeTimingVersion!==reports[0].source?.nativeTimingVersion)failures.push('reports use different native timing versions');
  if(report.source?.treeHash!==reports[0].source?.treeHash||report.source?.commit!==reports[0].source?.commit||report.source?.engineVersion!==reports[0].source?.engineVersion)failures.push('reports do not share one frozen source/build');
 }
 for(const rows of [300000,2000000,10000000])for(const [scenario,mode] of [['catalog','cold'],...Object.keys(limits).map(scenario=>[scenario,'warm'])]) {
  if(!reports.some(report=>report.fixture?.tier==='regular'&&report.fixture.rows===rows&&report.fixture.columns===20&&report.scenario===scenario&&report.cache?.mode===mode))failures.push(`missing ${rows}x20 ${scenario}/${mode}`);
 }
 for(const tier of ['many-documents','long-strings'])if(!reports.some(report=>report.fixture?.tier===tier))failures.push(`missing ${tier} tier`);
 return {qualified:failures.length===0,failures,results};
}
