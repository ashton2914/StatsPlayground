import assert from "node:assert/strict";
import {invoke} from "@tauri-apps/api/core";
import {mockIPC,clearMocks} from "@tauri-apps/api/mocks";
import {dataService} from "../src/services/dataService.ts";
import {createProjectPersistenceCoordinator} from "../src/projectPersistence/coordinator.ts";
import {useProjectStore} from "../src/stores/useProjectStore.ts";
import type {ProjectCommit} from "../src/types/projectPersistence.ts";
const columns=[{columnId:crypto.randomUUID(),name:"New column",sqlType:"DOUBLE"}];
const value={columnIds:[columns[0].columnId],generation:1,columnCount:3,changeSetId:"history"};
const calls:any[]=[];let native=true;
Object.defineProperty(globalThis,"window",{value:globalThis,configurable:true});
mockIPC((command,args:any)=>{
 assert.ok(["add_columns_with_change_set","delete_columns_with_change_set","reorder_column_if_generation"].includes(command));calls.push(structuredClone(args));
 const reordering=command==="reorder_column_if_generation";
 const deleting=command==="delete_columns_with_change_set";
 const result=reordering?3:deleting?{...value,generation:2,columnCount:2,changeSetId:"delete-history"}:value;
 if(reordering) {assert.equal(args.from,0);assert.equal(args.to,1);} else {assert.deepEqual(args.columns,columns);assert.equal(args.atIndex,deleting?undefined:1);}
 if(!native) {assert.equal(args.context,undefined);return result;}
 assert.equal(args.context.expectedProjectId,"project");assert.equal(args.context.expectedEpoch,7);
 assert.deepEqual(args.context.datasetGenerations,[{id:"table",generation:reordering?2:deleting?1:0}]);
 return {operationId:args.context.operationId,epoch:7,committedRevision:reordering?3:deleting?2:1,value:result,changedDatasetGenerations:[{id:"table",generation:reordering?3:deleting?2:1}],changedDocumentRevisions:[]};
});
const queue=createProjectPersistenceCoordinator({projectId:"project",epoch:7,committedRevision:0,now:()=>0,newOperationId:()=>crypto.randomUUID(),setTimer:()=>0,clearTimer:()=>{},transport:(operation,context)=>invoke<ProjectCommit<any>>(operation.command,{...(operation.payload as object),context})});
useProjectStore.getState().installPersistence(queue);
try {
 assert.deepEqual(await dataService.addColumnsWithChangeSet("table",columns,1,0),value);
 assert.equal(queue.captureBarrier(),1);assert.equal(queue.snapshot().acknowledgedSequence,1);
 assert.equal((await dataService.deleteColumnsWithChangeSet("table",columns,1)).columnCount,2);
 assert.equal(queue.snapshot().acknowledgedSequence,2);
 assert.equal(await dataService.reorderColumnIfGeneration("table",0,1,2),3);
 await queue.close();useProjectStore.getState().installPersistence(null);native=false;
 assert.deepEqual(await dataService.addColumnsWithChangeSet("table",columns,1,0),value);
 assert.equal(calls.length,4);
 console.log("native columns transport: ordered context, acknowledged result and legacy compatibility passed");
} finally {useProjectStore.getState().installPersistence(null);clearMocks();delete (globalThis as any).window;}
