import assert from 'node:assert/strict';
import {test} from 'node:test';
import {assessProjectV5Report,evaluateProjectV5Budget} from './projectV5BudgetCore.mjs';
const sample=()=>({verification:{passed:true},processId:42,rssMethod:'proc_pidinfo resident_size',backendMs:10,uiReadyMs:20,rssBytes:100000000,diskReadBytes:0,diskWriteBytes:4096,ioMethod:'proc_pid_rusage diskio',walBytes:4096,checkpointBytes:0,transferredBytes:300,forbiddenWork:{archiveRestoredRows:0,archiveWriterCalls:0,fullDatabaseCopies:0,fullBeforeImageCopies:0,fullAnchorRebuilds:0,fullWindowCounts:0}});
const coldProof=()=>({method:'owned-file msync/mincore',residentPagesBefore:1,residentPagesAfter:0,pages:4,fileBytes:65536,pageSize:16384,device:1,inode:2});
const report=()=>({schemaVersion:1,scenario:'catalog',source:{uiProbeBuild:true,commit:'a'.repeat(40),treeHash:'b'.repeat(40),profile:'release',engineVersion:'test-engine',storageVersion:'test-storage'},fixture:{id:'fixture-1',tier:'regular',rows:2000000,columns:20,seed:282},cache:{mode:'warm',method:'same-process repeated open'},verification:{passed:true},profiling:{method:'DuckDB JSON profiling',verifiedNoFullScan:true},samples:Array.from({length:100},sample)});
test('warm assessment uses real sample counts and measured p95',()=>{const value=assessProjectV5Report(report());assert.equal(value.qualified,true);assert.equal(value.backendP95Ms,10);assert.equal(value.uiP95Ms,20);});
test('missing, negative and nonfinite measurements never become zero',()=>{for(const key of ['backendMs','rssBytes','diskReadBytes','diskWriteBytes','walBytes','checkpointBytes','transferredBytes'])for(const invalid of [undefined,-1,NaN,Infinity]){const value=report();value.samples[0][key]=invalid;assert.equal(assessProjectV5Report(value).qualified,false,`${key}: ${invalid}`);}});
test('native-only timing does not qualify actual UI readiness',()=>{const value=report();for(const sample of value.samples)sample.uiReadyMs=null;assert.equal(assessProjectV5Report(value).qualified,false);});
test('debug builds, missing provenance, false verification and forbidden work fail closed',()=>{for(const change of [value=>value.source.profile='debug',value=>delete value.source.treeHash,value=>value.verification.passed=false,value=>value.samples[1].forbiddenWork.archiveWriterCalls=1,value=>delete value.samples[0].ioMethod,value=>delete value.samples[0].forbiddenWork.fullAnchorRebuilds]){const value=report();change(value);assert.equal(assessProjectV5Report(value).qualified,false);}});
test('99 warm samples and four cold opens are insufficient',()=>{let value=report();value.samples.pop();assert.equal(assessProjectV5Report(value).qualified,false);value=report();value.cache={mode:'cold',method:'independent process; OS cache state recorded',osCache:'confirmed-cold'};value.samples=value.samples.slice(0,4).map((sample,index)=>({...sample,processId:index+1,coldCache:coldProof(),diskReadBytes:65536}));assert.equal(assessProjectV5Report(value).qualified,false);value.samples.push({...sample(),processId:5,coldCache:coldProof(),diskReadBytes:65536});assert.equal(assessProjectV5Report(value).qualified,true);});
test('latency failures are retained and reports are not mutated',()=>{const value=report();value.samples[0].backendMs=1000;value.samples[0].uiReadyMs=1000;const copy=structuredClone(value);assert.equal(assessProjectV5Report(value).qualified,true,'one outlier does not redefine measured p95');for(const sample of value.samples)sample.uiReadyMs=501;assert.equal(assessProjectV5Report(value).qualified,false);assert.equal(copy.samples[0].backendMs,1000);});
test('a single passing scenario cannot qualify the required fixture matrix',()=>{const result=evaluateProjectV5Budget([report()]);assert.equal(result.qualified,false);assert.ok(result.failures.length>0);});

test('cold samples require different processes and ordinary reads require SQL evidence',()=>{const value=report();value.cache.mode='cold';value.samples=value.samples.slice(0,5);assert.equal(assessProjectV5Report(value).qualified,false);const read=report();delete read.profiling;assert.equal(assessProjectV5Report(read).qualified,false);});
test('scroll qualification includes per-viewport and aggregate retention',()=>{const value=report();value.scenario='scroll';for(const sample of value.samples)sample.retention={viewportRows:5000,viewportBytes:64*1024*1024,aggregateRows:10000,aggregateBytes:128*1024*1024,activeViewports:2};assert.equal(assessProjectV5Report(value).qualified,true);value.samples[0].retention.aggregateRows++;assert.equal(assessProjectV5Report(value).qualified,false);});
test('a successful top-level report cannot hide a failed sample',()=>{const value=report();value.samples[3].verification={passed:false};assert.equal(assessProjectV5Report(value).qualified,false);});
test('independent processes alone do not prove cold operating-system cache',()=>{const value=report();value.cache={mode:'cold',method:'new processes'};value.samples=value.samples.slice(0,5).map((sample,index)=>({...sample,processId:index+1}));assert.equal(assessProjectV5Report(value).qualified,false);});
test('cold-window observations cannot evade an assigned latency budget',()=>{const value=report();value.scenario='window';value.cache={mode:'cold',method:'verified cold cache',osCache:'confirmed-cold'};value.samples=value.samples.slice(0,5).map((sample,index)=>({...sample,processId:index+1,retention:{viewportRows:500,viewportBytes:1000,aggregateRows:500,aggregateBytes:1000,activeViewports:1}}));assert.equal(assessProjectV5Report(value).qualified,false);});
test('a hidden full-window count is forbidden even when other bulk counters are zero',()=>{const value=report();value.samples[0].forbiddenWork.fullWindowCounts=1;assert.equal(assessProjectV5Report(value).qualified,false);});
test('UI timing qualification requires an explicitly instrumented native UI build',()=>{const value=report();value.source.uiProbeBuild=false;assert.equal(assessProjectV5Report(value).qualified,false);delete value.source.uiProbeBuild;assert.equal(assessProjectV5Report(value).qualified,false);});
test('confirmed-cold label still requires per-sample zero-residency evidence',()=>{
 const value=report();value.cache={mode:'cold',method:'owned-file msync/mincore',osCache:'confirmed-cold'};
 value.samples=value.samples.slice(0,5).map((sample,index)=>({...sample,processId:index+1}));
 assert.equal(assessProjectV5Report(value).qualified,false);
});

test('cold residency proof and actual read observation fail closed per sample',()=>{
 const make=()=>{const value=report();value.cache={mode:'cold',method:'owned-file msync/mincore',osCache:'confirmed-cold'};value.samples=value.samples.slice(0,5).map((sample,index)=>({...sample,processId:index+1,coldCache:coldProof(),diskReadBytes:65536}));return value;};
 assert.equal(assessProjectV5Report(make()).qualified,true);
 for(const change of [value=>value.samples[0].coldCache.residentPagesAfter=1,value=>value.samples[0].coldCache.pages=0,value=>value.samples[0].coldCache.fileBytes++,value=>value.samples[0].diskReadBytes=0,value=>delete value.samples[0].coldCache.inode]){const value=make();change(value);assert.equal(assessProjectV5Report(value).qualified,false);}
});

test('interval-union timing requires auditable native intervals and retains aggregate work',()=>{
 const make=()=>{const value=report();value.source.nativeTimingVersion=2;for(const sample of value.samples)Object.assign(sample,{nativeCalls:2,backendTiming:'intervalUnion',backendIntervalsNs:[[0,8000000],[2000000,10000000]],backendMs:10,backendAggregateMs:16,backendOverlapMs:6});return value;};
 assert.equal(assessProjectV5Report(make()).qualified,true);
 for(const change of [value=>delete value.samples[0].backendIntervalsNs,value=>value.samples[0].backendMs=9,value=>value.samples[0].backendAggregateMs=10,value=>value.samples[0].backendOverlapMs=0,value=>value.samples[0].nativeCalls=3,value=>value.samples[0].backendIntervalsNs[0]=[8,1],value=>value.samples[0].backendTiming='unsupported']){
  const value=make();change(value);assert.equal(assessProjectV5Report(value).qualified,false);
 }
});

test('one matrix cannot mix native timing definitions under the same source identity',()=>{
 const first=report(),second=report();second.source.nativeTimingVersion=2;
 assert(evaluateProjectV5Budget([first,second]).failures.includes('reports use different native timing versions'));
});


test('foreground phase evidence rejects hidden, unfocused or missing observation intervals',()=>{
 const make=()=>{const value=report();value.source.uiObservationVersion=1;for(const sample of value.samples)sample.retention={uiPhases:{operationFinishedMs:1,readyObservedMs:3,framesMs:[[1,3],[3,11],[11,19]],focusedAtStart:true,focusedAtFinish:true,visibilityAtStart:'visible',visibilityAtFinish:'visible'}};return value;};
 assert.equal(assessProjectV5Report(make()).qualified,true);
 for(const change of [v=>delete v.samples[0].retention.uiPhases,v=>v.samples[0].retention.uiPhases.focusedAtStart=false,v=>v.samples[0].retention.uiPhases.visibilityAtFinish='hidden',v=>v.samples[0].retention.uiPhases.framesMs=[[3,11]],v=>v.samples[0].retention.uiPhases.framesMs[2][1]=21,v=>v.samples[0].retention.uiPhases.operationFinishedMs=4]){const value=make();change(value);assert.equal(assessProjectV5Report(value).qualified,false);}
});
test('one matrix cannot mix foreground observation definitions',()=>{const a=report(),b=report();b.source.uiObservationVersion=1;assert(evaluateProjectV5Budget([a,b]).failures.includes('reports use different UI observation versions'));});


test('native-window focus version2 is independent of DOM input focus and rejects missing native proof',()=>{
 const make=()=>{const value=report();value.source.uiObservationVersion=2;for(const sample of value.samples){sample.nativeWindowFocusedAtStart=true;sample.nativeWindowFocusedAtFinish=true;sample.retention={uiPhases:{operationFinishedMs:1,readyObservedMs:3,framesMs:[[1,3],[3,11],[11,19]],focusedAtStart:false,focusedAtFinish:false,visibilityAtStart:'visible',visibilityAtFinish:'visible'}};}return value;};
 assert.equal(assessProjectV5Report(make()).qualified,true);
 for(const change of [v=>delete v.samples[0].nativeWindowFocusedAtStart,v=>v.samples[0].nativeWindowFocusedAtFinish=false,v=>v.samples[0].retention.uiPhases.visibilityAtFinish='hidden',v=>v.samples[0].retention.uiPhases.framesMs=[[3,11]]]){const value=make();change(value);assert.equal(assessProjectV5Report(value).qualified,false);}
 const old=make();old.source.uiObservationVersion=1;assert.equal(assessProjectV5Report(old).qualified,false,'original DOM-focus reports keep their original interpretation');
});
