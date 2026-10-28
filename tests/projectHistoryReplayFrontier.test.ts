import assert from "node:assert/strict";
import {mockIPC,clearMocks} from "@tauri-apps/api/mocks";
import {projectService} from "../src/services/projectService.ts";
import {useProjectStore} from "../src/stores/useProjectStore.ts";
import {useHistoryStore} from "../src/stores/useHistoryStore.ts";
import {createProjectPersistenceCoordinator} from "../src/projectPersistence/coordinator.ts";
Object.defineProperty(globalThis,"window",{value:globalThis,configurable:true});
const id="00000000-0000-4000-8000-000000000001";
let revision=4;let eventRevision=1;let generation:number|null=null;let applied=true;let empty=false;let ordinary=false;let switchOwner=false;let rejectRead=false;let loseReply=false;let lastCommit:any;
const reads:string[]=[];const writes:any[]=[];
mockIPC((command,args:any)=>{
 reads.push(command);
 if(command==="get_project_history_frontier") {
  assert.deepEqual(args,{epoch:7,undo:applied});assert.equal(useHistoryStore.getState().tableMutationDepth,1,"lock edits before reading selected metadata");assert.equal(useHistoryStore.getState().tryBeginTableMutation(),false,"edits must not enter while replay metadata is being resolved");
  if(switchOwner)useProjectStore.getState().installPersistence(null);
  if(rejectRead)throw new Error("frontier unavailable");
  return {committedRevision:revision,entry:empty?null:{id,datasetId:"table",datasetName:"Retired",operation:ordinary?"cell_delta":"delete_table",applied,generation:generation??1}};
 }
 if(command==="get_project_table_lifecycle_event")return {id,datasetId:"table",operation:"delete_table",applied,revision:eventRevision,historyOrdinal:1,projectRevision:revision,datasetGeneration:generation};
 if(command==="get_dataset_generation") {assert.ok(ordinary);return generation;}
 assert.ok(["apply_project_table_lifecycle","apply_table_change_set"].includes(command),`unexpected IPC ${command}`);
 writes.push(structuredClone({command,args}));applied=!args.undo;generation=applied?null:2;eventRevision++;
 lastCommit={operationId:args.context.operationId,epoch:7,committedRevision:++revision,value:null,changedDatasetGenerations:generation===null?[]:[{id:"table",generation}],changedDocumentRevisions:[]};if(loseReply){loseReply=false;throw new Error("lost acknowledgement");}return lastCommit;
});
const owner=createProjectPersistenceCoordinator({projectId:"project",epoch:7,committedRevision:4,now:()=>0,newOperationId:()=>crypto.randomUUID(),setTimer:()=>0,clearTimer:()=>{},transport:projectService.commitOperation,resolveOperation:async()=>({status:"committed",commit:lastCommit})});
try {
 useProjectStore.getState().installPersistence(owner);useHistoryStore.getState().reset();
 useHistoryStore.setState({history:[{id:"cached-newer",timestamp:"today",description:"untrusted cached edit",action:{kind:"changeSet",datasetId:"table",changeSetId:"cached-newer"}}],currentIdx:0});
 await useHistoryStore.getState().undo();assert.equal(writes.length,1,"reopened hidden-table undo must resolve native metadata despite an empty local stack");assert.equal(useHistoryStore.getState().historyError,null);assert.equal(useHistoryStore.getState().tableMutationDepth,0);assert.equal(useHistoryStore.getState().history[0]?.id,"cached-newer","the presentation cache remains separate from native replay authority");
 await useHistoryStore.getState().redo();assert.equal(writes.length,2);assert.deepEqual(writes[1].args.context.datasetGenerations,[{id:"table",generation:2}]);
 empty=true;await useHistoryStore.getState().undo();assert.equal(writes.length,2);empty=false;
 ordinary=true;generation=3;await useHistoryStore.getState().undo();assert.equal(writes.length,3);assert.equal(writes[2].command,"apply_table_change_set");ordinary=false;
 applied=true;generation=null;loseReply=true;await useHistoryStore.getState().undo();assert.match(useHistoryStore.getState().historyError??"",/lost acknowledgement/);assert.equal(owner.snapshot().status,"error");await owner.resolveFailedOperation();await useHistoryStore.getState().redo();assert.equal(writes.length,5);assert.equal(writes[4].args.undo,false,"resolved undo must be followed by native redo, regardless of cached cursor");
 rejectRead=true;applied=true;await useHistoryStore.getState().undo();assert.match(useHistoryStore.getState().historyError??"",/frontier unavailable/);assert.equal(useHistoryStore.getState().tableMutationDepth,0);rejectRead=false;
 switchOwner=true;await useHistoryStore.getState().undo();assert.equal(writes.length,5,"a new project must never receive the old selected replay");
 assert.ok(reads.includes("get_project_history_frontier"));console.log("native reopened history: metadata frontier, lifecycle/ordinary replay, empty/read errors and owner fences passed");
} finally {useHistoryStore.setState({history:[],currentIdx:-1});await owner.close().catch(()=>undefined);useProjectStore.getState().installPersistence(null);useHistoryStore.getState().reset();clearMocks();delete (globalThis as any).window;}
