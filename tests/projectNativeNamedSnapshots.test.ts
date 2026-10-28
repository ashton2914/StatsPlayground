import assert from "node:assert/strict";
import {mockIPC,clearMocks} from "@tauri-apps/api/mocks";
import {createProjectPersistenceCoordinator,type ProjectOperation} from "../src/projectPersistence/coordinator.ts";
import {useProjectStore} from "../src/stores/useProjectStore.ts";
import {useHistoryStore} from "../src/stores/useHistoryStore.ts";
import type {ProjectCommit,ProjectWriteContext} from "../src/types/projectPersistence.ts";
Object.defineProperty(globalThis,"window",{value:globalThis,configurable:true});
const sent:Array<{operation:ProjectOperation;context:ProjectWriteContext}>=[];const reads:string[]=[];
let descriptor:any=null;let revision=0;
mockIPC((command)=>{reads.push(command);if(command==="list_project_data_snapshots")return {items:descriptor?[descriptor]:[],nextCursor:null,committedRevision:revision};return {datasets:[]};});
const queue=createProjectPersistenceCoordinator({projectId:"project",epoch:7,committedRevision:0,now:()=>0,newOperationId:()=>crypto.randomUUID(),setTimer:()=>0,clearTimer:()=>{},transport:async<T>(operation:ProjectOperation<T>,context:ProjectWriteContext):Promise<ProjectCommit<T>>=>{
 sent.push({operation:structuredClone(operation),context:structuredClone(context)});const payload=operation.payload as any;let value:any=null;let deleted:string[]=[];
 if(operation.command==="capture_project_data_snapshot") {descriptor={id:payload.id,name:payload.name,createdAt:payload.createdAt,revision:1,tableCount:1};value=descriptor;}
 else if(operation.command==="commit_project_records") {assert.equal(payload.directoryMoves[0].expectedRevision,1);descriptor={...descriptor,name:payload.directoryMoves[0].name,revision:2};}
 else if(operation.command==="restore_project_data_snapshot") {assert.equal(payload.id,descriptor.id);assert.equal(payload.expectedRevision,2);value={kind:"dataSnapshotRestored",snapshotId:descriptor.id,tableHistoryReset:true};}
 else if(operation.command==="delete_project_data_snapshot") {deleted=[descriptor.id];descriptor=null;}
 else throw new Error(`Unexpected snapshot operation ${operation.command}`);
 revision++;
 return {operationId:context.operationId,epoch:7,committedRevision:revision,value,changedDatasetGenerations:[],changedDocumentRevisions:descriptor?[{id:descriptor.id,revision:descriptor.revision}]:[],deletedDirectoryIds:deleted};
}});
useProjectStore.getState().installPersistence(queue);
try {
 await useHistoryStore.getState().createSnapshot("Native checkpoint");
 assert.equal(sent.length,1,"native capture must use one typed project operation");
 assert.ok(!reads.includes("capture_project_snapshot"),"native snapshots cannot serialize project rows through legacy IPC");
 assert.equal(useHistoryStore.getState().snapshots.length,0,"native descriptors must not become fake legacy full snapshots");
 const id=descriptor.id;await useHistoryStore.getState().renameSnapshot(id,"Renamed checkpoint");
 assert.equal(sent.length,2);assert.equal(descriptor.name,"Renamed checkpoint");
 await useHistoryStore.getState().restoreSnapshot(id);assert.equal(sent.length,3);
 await useHistoryStore.getState().deleteSnapshot(id);assert.equal(sent.length,4);assert.equal(descriptor,null);
 assert.equal(queue.snapshot().status,"saved");await queue.close();
 console.log("native named snapshot actions: typed capture/rename/restore/delete without frontend table rows passed");
}finally{useProjectStore.getState().installPersistence(null);useHistoryStore.getState().reset();clearMocks();delete(globalThis as any).window;}
