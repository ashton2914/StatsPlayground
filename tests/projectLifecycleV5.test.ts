import {useProjectDataSnapshotStore} from "../src/stores/useProjectDataSnapshotStore.ts";
import assert from "node:assert/strict";
import {createProjectLifecycleV5,ProjectLifecycleRecoveryError} from "../src/projectPersistence/lifecycle.ts";
import {useProjectStore} from "../src/stores/useProjectStore.ts";
import {useReportStore} from "../src/stores/useReportStore.ts";
import {useProjectCatalogStore} from "../src/stores/useProjectCatalogStore.ts";
import type {ProjectOpenSummary,ProjectCommit} from "../src/types/projectPersistence.ts";
const opened=(id:string,epoch:number):ProjectOpenSummary=>({project:{name:id,filePath:`${id}.spprj`,createdAt:"today"},epoch,writable:true,header:{projectId:id,formatVersion:"5.0.0",minimumReader:1,minimumWriter:1,committedRevision:0,createdAt:"today",engineVersion:"test",storageVersion:"test"},directory:{items:[],nextCursor:null,committedRevision:0},settingsRevision:0});
const calls:string[]=[];let saveFails=true;let openFails=false;let closeFails=false;let listeners=0;let nextEpoch=1;let recovery:"none"|"source"|"unavailable"="none";
const lifecycle=createProjectLifecycleV5({
 open:async(path)=>{calls.push(`open:${path}`);if(path==="b") assert.throws(()=>useProjectStore.getState().persistence!.submit({command:"commit_project_records",payload:{}}),/transition/,"late callbacks cannot append writes after a lifecycle barrier");if(openFails) throw new Error("malformed project");return opened(path,++nextEpoch);},
 close:async(epoch)=>{calls.push(`close:${epoch}`);if(closeFails) throw new Error("close blocked");},
 createDraft:async()=>({...opened("draft",++nextEpoch),project:{name:"Untitled",filePath:"",createdAt:"today"}}),
 snapshot:async(epoch,path,firstNaming)=>{assert.equal(useProjectStore.getState().saving,true,"file snapshots must expose an in-progress save while copying");calls.push(`snapshot:${firstNaming}`);if(recovery!=="none") throw new ProjectLifecycleRecoveryError("snapshot publication failed",recovery==="source"?opened(useProjectCatalogStore.getState().projectId!,++nextEpoch):null,true);return opened(firstNaming?useProjectCatalogStore.getState().projectId!:"new-uuid",++nextEpoch);},
 listenCommits:async()=>{listeners++;return ()=>{listeners--;};},
 commit:async<T>(operation,context):Promise<ProjectCommit<T>>=>{
  calls.push("commit");if(saveFails) throw new Error("disk failed");
  return {operationId:context.operationId,epoch:context.expectedEpoch,committedRevision:context.expectedRevision+1,value:null as T,changedDatasetGenerations:[],changedDocumentRevisions:[]};
 },
});
try {
 await lifecycle.switchProject("a");assert.equal(useProjectStore.getState().project?.name,"a");assert.equal(listeners,1);
 useReportStore.getState().addItem({id:"report",name:"Local report",schemaVersion:1,markdown:"keep me",createdAt:"today",updatedAt:"today"});
 await assert.rejects(lifecycle.switchProject("b"),/disk failed/);
 assert.equal(useProjectStore.getState().project?.name,"a");assert.equal(useReportStore.getState().items[0].markdown,"keep me");assert.equal(useProjectStore.getState().readOnly,false);assert.equal(calls.includes("open:b"),false);
 saveFails=false;openFails=true;await assert.rejects(lifecycle.switchProject("b"),/malformed/);
 assert.equal(useProjectStore.getState().project?.name,"a");assert.equal(useReportStore.getState().items[0].markdown,"keep me");assert.equal(listeners,1);
 openFails=false;await lifecycle.switchProject("b");assert.equal(useProjectStore.getState().project?.name,"b");assert.equal(useReportStore.getState().items.length,0);assert.equal(listeners,1);
 useProjectDataSnapshotStore.getState().install(useProjectStore.getState().persistence!.snapshot().epoch,0);
 useProjectDataSnapshotStore.setState({items:[{id:"snapshot",name:"Keep on failed close",revision:1,createdAt:"today",tableCount:100}],loaded:true});
 closeFails=true;await assert.rejects(lifecycle.closeProject(),/close blocked/);assert.equal(useProjectStore.getState().project?.name,"b");assert.ok(useProjectStore.getState().persistence);
 assert.equal(useProjectDataSnapshotStore.getState().items.length,1,"failed close retains the active project's snapshot descriptors");
 closeFails=false;await lifecycle.closeProject();assert.equal(useProjectStore.getState().project,null);assert.equal(listeners,0);
 assert.equal(useProjectDataSnapshotStore.getState().epoch,null);assert.equal(useProjectDataSnapshotStore.getState().items.length,0);
 await lifecycle.createDraft();const draftId=useProjectCatalogStore.getState().projectId;
 await lifecycle.saveAs("named.spprj");assert.ok(calls.includes("snapshot:true"));assert.equal(useProjectCatalogStore.getState().projectId,draftId);
 recovery="source";const oldEpoch=useProjectStore.getState().persistence!.snapshot().epoch;
 await assert.rejects(lifecycle.saveAs("failed-copy.spprj"),/snapshot publication failed/);
 assert.equal(useProjectCatalogStore.getState().projectId,draftId);assert.notEqual(useProjectStore.getState().persistence!.snapshot().epoch,oldEpoch);assert.equal(listeners,1);assert.equal(useProjectStore.getState().readOnly,false);
 recovery="none";
 await lifecycle.saveAs("copy.spprj");assert.ok(calls.includes("snapshot:false"));assert.equal(useProjectCatalogStore.getState().projectId,"new-uuid");
 recovery="unavailable";await assert.rejects(lifecycle.saveAs("published-but-not-open.spprj"),/snapshot publication failed/);
 assert.equal(useProjectStore.getState().project,null);assert.equal(useProjectStore.getState().persistence,null);assert.equal(listeners,0);
 recovery="none";
 await lifecycle.closeProject();assert.equal(listeners,0);
 console.log("native lifecycle: failed flush/open/close preserve live state, owned listeners, first naming and Save As session replacement passed");
} finally {saveFails=false;openFails=false;closeFails=false;await lifecycle.closeProject();}

{
 const {useDataStore}=await import("../src/stores/useDataStore.ts");
 const receivers=new Set<(commit:ProjectCommit<unknown>)=>void>();let epoch=100;
 const dataset={id:"table",name:"Table",sourcePath:null,sourceType:"manual" as const,rowCount:1,colCount:1,generation:0,createdAt:"today",updatedAt:"today"};
 const table={id:"table",name:"Table",kind:"table" as const,folder:"",revision:1,dependencies:[]};
 const lifecycle=createProjectLifecycleV5({open:async path=>({...opened(path,++epoch),datasets:[dataset],directory:{items:[table],nextCursor:null,committedRevision:0}}),close:async()=>{},createDraft:async()=>opened("draft",++epoch),snapshot:async()=>opened("copy",++epoch),listenCommits:async receive=>{receivers.add(receive);return()=>{receivers.delete(receive);};},commit:async()=>{throw new Error("unexpected write");}});
 try {
  await lifecycle.switchProject("first");const previous=useProjectStore.getState().persistence!;const close=previous.close.bind(previous);
  previous.close=async()=>{
   const receipt:ProjectCommit<unknown>={operationId:"during-publication",epoch,committedRevision:1,value:null,changedDatasetGenerations:[{id:"table",generation:1}],changedDatasetMetadata:[{...dataset,rowCount:2,generation:1}],changedDocumentRevisions:[{id:"table",revision:1}],changedDirectoryEntries:[table]};
   for(const receive of receivers)receive(receipt);await close();
  };
  await lifecycle.switchProject("second");assert.equal(useProjectStore.getState().persistence!.snapshot().committedRevision,1);assert.equal(useDataStore.getState().datasets[0].rowCount,2,"new-owner receipts must wait for its stores and adapters to publish");
 } finally {await lifecycle.closeProject();}
}
