import assert from "node:assert/strict";
import {createProjectCatalogStore} from "../src/stores/useProjectCatalogStore.ts";
import type {CatalogPage,ProjectCommit,ProjectDocumentBody,ProjectDocumentSummary,ProjectOpenSummary,ProjectSettingRecord} from "../src/types/projectPersistence.ts";
function summary(id:string,revision=1):ProjectDocumentSummary {return {id,name:`Report ${id}`,kind:"report",folder:"Reports",revision,dependencies:["source"]};}
function document(item:ProjectDocumentSummary):ProjectDocumentBody {return {summary:item,schemaVersion:1,body:{id:item.id,name:item.name,markdown:`body ${item.revision}`}};}
function opened(items:ProjectDocumentSummary[],epoch=7,nextCursor:string|null=null,revision=1):ProjectOpenSummary {return {project:{name:"Large",filePath:"project.spprj",createdAt:"today"},header:{projectId:`project-${epoch}`,formatVersion:"5.0.0",minimumReader:1,minimumWriter:1,committedRevision:revision,createdAt:"today",engineVersion:"test",storageVersion:"test"},epoch,writable:true,directory:{items,nextCursor,committedRevision:revision},settingsRevision:revision};}
function commit(revision:number,entries:ProjectDocumentSummary[]=[],deleted:string[]=[]):ProjectCommit<null> {return {operationId:`operation-${revision}`,epoch:7,committedRevision:revision,value:null,changedDatasetGenerations:[],changedDocumentRevisions:entries.map(item=>({id:item.id,revision:item.revision})),changedDirectoryEntries:entries,deletedDirectoryIds:deleted};}
function deferred<T>() {let resolve!:(value:T)=>void;let reject!:(error:Error)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}

{
  const waiting=deferred<ProjectDocumentBody>();let reads=0;const hydrated:ProjectDocumentBody[]=[];
  const store=createProjectCatalogStore({service:{getProjectDocument:async()=>{reads++;return waiting.promise;},listProjectCatalog:async()=>{throw new Error("unexpected page fetch");}},onDocumentReady:(_epoch,value)=>{hydrated.push(value);}});
  const items=Array.from({length:1000},(_,index)=>summary(String(index).padStart(4,"0")));
  store.getState().installOpenSummary(opened(items));
  assert.equal(Object.keys(store.getState().summaries).length,1000);
  assert.equal(store.getState().summaries["0050"].folder,"Reports");
  assert.deepEqual(store.getState().summaries["0050"].dependencies,["source"]);
  assert.equal(reads,0,"installing a complete directory must not fetch any body");
  const first=store.getState().ensureDocument("0050");
  const second=store.getState().ensureDocument("0050");
  assert.equal(reads,1,"concurrent selection must share the body request");
  assert.equal(store.getState().bodies["0050"].status,"loading");
  waiting.resolve(document(items[50]));
  assert.deepEqual(await first,await second);
  assert.equal(hydrated.length,1);
  assert.equal(store.getState().bodies["0050"].status,"ready");
  await store.getState().ensureDocument("0050");assert.equal(reads,1);
}
{
  const requests:Array<{revision:number;waiting:ReturnType<typeof deferred<ProjectDocumentBody>>}>=[];
  const hydrated:ProjectDocumentBody[]=[];
  const store=createProjectCatalogStore({service:{getProjectDocument:(_epoch,_id,revision)=>{const waiting=deferred<ProjectDocumentBody>();requests.push({revision,waiting});return waiting.promise;},listProjectCatalog:async()=>{throw new Error("unexpected page fetch");}},onDocumentReady:(_epoch,value)=>{hydrated.push(value);}});
  store.getState().installOpenSummary(opened([summary("a")]));
  const old=store.getState().ensureDocument("a");const rejected=assert.rejects(old,/stale|revision/);
  store.getState().invalidateDocument("a",2);
  const current=store.getState().ensureDocument("a");assert.equal(requests[1].revision,2);
  requests[0].waiting.resolve(document(summary("a")));await rejected;
  assert.equal(hydrated.length,0);assert.equal(store.getState().bodies.a.status,"loading");
  requests[1].waiting.resolve(document(summary("a",2)));await current;
  assert.equal(hydrated[0].summary.revision,2);
  store.getState().applyCommit(commit(3,[{...summary("a",3),name:"Updated name"}]));
  assert.equal(store.getState().summaries.a.name,"Updated name");
  assert.equal(store.getState().bodies.a.status,"unloaded","catalog revisions must not pretend an old body is current");
}
for(const change of ["delete","switch"] as const) {
  const waiting=deferred<ProjectDocumentBody>();let hydrated=0;
  const store=createProjectCatalogStore({service:{getProjectDocument:()=>waiting.promise,listProjectCatalog:async()=>{throw new Error("unexpected page fetch");}},onDocumentReady:()=>{hydrated++;}});
  store.getState().installOpenSummary(opened([summary("a")]));
  const pending=store.getState().ensureDocument("a");const rejected=assert.rejects(pending,/stale|deleted|session/);
  if(change==="delete") store.getState().applyCommit(commit(2,[],["a"]));
  else {store.getState().reset(8);store.getState().installOpenSummary(opened([summary("a")],8));}
  waiting.resolve(document(summary("a")));await rejected;
  assert.equal(hydrated,0);
  assert.notEqual(store.getState().bodies.a?.status,"ready");
}
{
  let attempt=0;
  const store=createProjectCatalogStore({service:{getProjectDocument:async()=>{if(++attempt===1) throw new Error("temporary read failure");return document(summary("a"));},listProjectCatalog:async()=>{throw new Error("unexpected page fetch");}}});
  store.getState().installOpenSummary(opened([summary("a")]));
  await assert.rejects(store.getState().ensureDocument("a"),/temporary read failure/);
  assert.equal(store.getState().bodies.a.status,"error");
  await store.getState().ensureDocument("a");assert.equal(store.getState().bodies.a.status,"ready");
}
{
  const stale=deferred<CatalogPage>();const cursors:Array<string|null>=[];
  const store=createProjectCatalogStore({service:{getProjectDocument:async()=>{throw new Error("body fetch during paging");},listProjectCatalog:async(_epoch,page)=>{cursors.push(page.after);if(page.after==="old") return stale.promise;return {items:[summary("a",2)],nextCursor:null,committedRevision:2};}}});
  store.getState().installOpenSummary(opened([summary("a"),summary("old-tail")],7,"old"));
  const page=store.getState().loadNextPage();
  store.getState().applyCommit(commit(2,[summary("new")]));
  stale.resolve({items:[summary("stale-page")],nextCursor:null,committedRevision:1});
  await page;
  assert.deepEqual(cursors,["old",null],"an in-flight old catalog snapshot must restart from its first page");
  assert.equal(store.getState().summaries.a.revision,2);
  assert.ok(!store.getState().summaries["old-tail"]&&!store.getState().summaries["stale-page"]);
  assert.ok(store.getState().summaries.new,"the newest acknowledged entry must survive a partial catalog restart");
}
{
  const store=createProjectCatalogStore({service:{getProjectDocument:async()=>document(summary("a")),listProjectCatalog:async()=>{throw new Error("unexpected page fetch");}}});
  store.getState().installOpenSummary(opened([summary("a")]));
  store.getState().applyCommit(commit(4,[],["a"]));
  store.getState().applyCommit(commit(3,[summary("a",2)]));
  assert.equal(store.getState().summaries.a,undefined,"a delayed receipt must not resurrect a later deletion");
  store.getState().applyCommit({...commit(5,[summary("foreign")]),epoch:99});
  assert.equal(store.getState().summaries.foreign,undefined);
}
{
  let attempt=0;
  const store=createProjectCatalogStore({service:{getProjectDocument:()=>{if(++attempt===1) throw new Error("synchronous transport failure");return Promise.resolve(document(summary("a")));},listProjectCatalog:async()=>{throw new Error("unexpected page fetch");}}});
  store.getState().installOpenSummary(opened([summary("a")]));
  await assert.rejects(store.getState().ensureDocument("a"),/synchronous transport failure/);
  await store.getState().ensureDocument("a");assert.equal(attempt,2);
}
{
  const waiting:Array<ReturnType<typeof deferred<ProjectSettingRecord|null>>>=[];const keys:string[]=[];const projected:Array<string>=[];
  const store=createProjectCatalogStore({service:{getProjectDocument:async()=>{throw new Error("unexpected body fetch");},listProjectCatalog:async()=>{throw new Error("unexpected page fetch");},getProjectSetting:(_epoch,key)=>{keys.push(key);const next=deferred<ProjectSettingRecord|null>();waiting.push(next);return next.promise;}},onSettingReady:(_epoch,key)=>{projected.push(key);}});
  store.getState().installOpenSummary(opened([summary("a")]));assert.equal(keys.length,0);
  const first=store.getState().ensureSetting("lineage");const duplicate=store.getState().ensureSetting("lineage");assert.deepEqual(keys,["lineage"]);
  waiting[0].resolve({key:"lineage",revision:1,value:{nodes:[],edges:[]}});await first;await duplicate;
  assert.deepEqual(projected,["lineage"]);assert.equal(store.getState().settings.lineage.status,"ready");
  store.getState().applyCommit({...commit(2),changedSettingRevisions:[{key:"lineage",revision:2}]});
  assert.equal(store.getState().settings.lineage.status,"unloaded");
  const current=store.getState().ensureSetting("lineage");waiting[1].resolve({key:"lineage",revision:2,value:{nodes:["changed"]}});assert.equal((await current)?.revision,2);
  const stale=store.getState().ensureSetting("filter:source");const rejected=assert.rejects(stale,/stale|session/);
  store.getState().reset(8);waiting[2].resolve({key:"filter:source",revision:1,value:[]});await rejected;
  assert.deepEqual(projected,["lineage","lineage"],"a previous project's settings must never hydrate the current stores");
}
console.log("project catalog store: metadata-only open, bounded selection, stale fences and paging restart passed");
