import assert from "node:assert/strict";
import {createProjectPersistenceCoordinator,type ProjectOperation} from "../src/projectPersistence/coordinator.ts";
import type {DocumentWrite,ProjectCommit,ProjectWriteContext,ProjectRecordPatch} from "../src/types/projectPersistence.ts";
const write:DocumentWrite={expectedRevision:1,document:{schemaVersion:1,summary:{id:"report",kind:"report",name:"Report",folder:"",revision:2,dependencies:[]},body:{id:"report",name:"Report",schemaVersion:1,markdown:"keep this pending draft"}}};
for(const conflict of [false,true]) {
 let ids=0;let resolutions=0;const contexts:ProjectWriteContext[]=[];const payloads:ProjectRecordPatch[]=[];
 const queue=createProjectPersistenceCoordinator({projectId:"project",epoch:7,committedRevision:10,now:()=>0,newOperationId:()=>`op-${++ids}`,setTimer:()=>0,clearTimer:()=>{},
  resolveOperation:async context=>{resolutions++;assert.equal(context.operationId,"op-1");return {status:"cancelled",operationId:context.operationId,epoch:7,committedRevision:12};},
  transport:async<T>(operation:ProjectOperation<T>,context:ProjectWriteContext):Promise<ProjectCommit<T>>=>{
   contexts.push(structuredClone(context));payloads.push(structuredClone(operation.payload as ProjectRecordPatch));
   if(contexts.length===1)throw new Error("project_revision_stale");
   if(conflict)throw new Error("project_document_revision_stale");
   return {operationId:context.operationId,epoch:7,committedRevision:13,value:null as T,changedDatasetGenerations:[],changedDocumentRevisions:[{id:"report",revision:2}]};
  }});
 queue.enqueueDocument(write);const barrier=queue.captureBarrier();
 await assert.rejects(queue.flushThrough(barrier),/project_revision_stale/);
 if(conflict)await assert.rejects(queue.flushThrough(barrier),/project_document_revision_stale/);
 else await queue.flushThrough(barrier);
 assert.equal(resolutions,1,"retry must resolve uncertain original outcome before changing its identity");
 assert.equal(contexts[1].operationId,"op-2");assert.equal(contexts[1].expectedRevision,12);
 assert.equal(payloads[1].documents![0].expectedRevision,1,"retry may refresh project revision but cannot overwrite a newer document body");
 assert.deepEqual(payloads[1].documents![0].document.body,write.document.body);
 assert.equal(queue.snapshot().acknowledgedSequence,conflict?0:1);
 assert.equal(queue.snapshot().pendingSequence,1);
 assert.equal(queue.snapshot().status,conflict?"error":"saved");
 if(!conflict)await queue.close();
}
{
 let calls=0;let resolves=0;let savedContext!:ProjectWriteContext;
 let finishResolution!:(value:any)=>void;
 const outcome=new Promise<any>(resolve=>{finishResolution=resolve;});
 const queue=createProjectPersistenceCoordinator({projectId:"project",epoch:7,committedRevision:10,now:()=>0,newOperationId:()=>"lost-record",setTimer:()=>0,clearTimer:()=>{},
  resolveOperation:async()=>{resolves++;return outcome;},
  transport:async<T>(_operation:ProjectOperation<T>,context:ProjectWriteContext):Promise<ProjectCommit<T>>=>{calls++;savedContext=structuredClone(context);throw new Error("lost acknowledgement");}});
 queue.enqueueDocument(write);const barrier=queue.captureBarrier();await assert.rejects(queue.flushThrough(barrier),/lost acknowledgement/);
 const first=queue.flushThrough(barrier);const second=queue.flushThrough(barrier);
 assert.equal(resolves,1,"overlapping retry barriers share one outcome resolution");
 finishResolution({status:"committed",commit:{operationId:savedContext.operationId,epoch:7,committedRevision:11,value:null,changedDatasetGenerations:[],changedDocumentRevisions:[{id:"report",revision:2}]}});
 await Promise.all([first,second]);assert.equal(calls,1,"a committed document must project its receipt without another write");
 assert.equal(queue.snapshot().acknowledgedSequence,1);assert.equal(queue.snapshot().status,"saved");await queue.close();
}
console.log("record retry recovery: cancellation fencing, refreshed project revision and retained conflicting drafts passed");
