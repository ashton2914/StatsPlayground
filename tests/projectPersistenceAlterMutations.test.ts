import assert from "node:assert/strict";
import {invoke} from "@tauri-apps/api/core";
import {mockIPC,clearMocks} from "@tauri-apps/api/mocks";
import {dataService} from "../src/services/dataService.ts";
import {createProjectPersistenceCoordinator} from "../src/projectPersistence/coordinator.ts";
import {useProjectStore} from "../src/stores/useProjectStore.ts";
import type {ProjectCommit} from "../src/types/projectPersistence.ts";
Object.defineProperty(globalThis,"window",{value:globalThis,configurable:true});
let native=true;let count=0;
mockIPC((command,args:any)=>{
 count++;assert.ok(["alter_column_with_change_set","alter_columns_type_with_change_set"].includes(command));
 const batch=command==="alter_columns_type_with_change_set";
 assert.equal(args.datasetId,"table");assert.equal(args.newType,batch?"DOUBLE":"VARCHAR");
 if(batch)assert.deepEqual(args.columnNames,["Renamed"]);else {assert.equal(args.oldName,"A");assert.equal(args.newName,"Renamed");}
 const value=batch?"types-history":"rename-history";
 if(!native) {assert.equal(args.context,undefined);return value;}
 assert.equal(args.context.expectedEpoch,7);assert.deepEqual(args.context.datasetGenerations,[{id:"table",generation:batch?5:4}]);
 return {operationId:args.context.operationId,epoch:7,committedRevision:batch?2:1,value,changedDatasetGenerations:[{id:"table",generation:batch?6:5}],changedDocumentRevisions:[]};
});
const queue=createProjectPersistenceCoordinator({projectId:"project",epoch:7,committedRevision:0,now:()=>0,newOperationId:()=>crypto.randomUUID(),setTimer:()=>0,clearTimer:()=>{},transport:(operation,context)=>invoke<ProjectCommit<any>>(operation.command,{...(operation.payload as object),context})});
useProjectStore.getState().installPersistence(queue);
try {
 assert.equal(await dataService.alterColumnWithChangeSet("table","A","Renamed","VARCHAR",4),"rename-history");assert.equal(queue.snapshot().acknowledgedSequence,1);
 assert.equal(await dataService.alterColumnsTypeWithChangeSet("table",["Renamed"],"DOUBLE",5),"types-history");assert.equal(queue.snapshot().acknowledgedSequence,2);
 await queue.close();useProjectStore.getState().installPersistence(null);native=false;
 assert.equal(await dataService.alterColumnWithChangeSet("table","A","Renamed","VARCHAR",4),"rename-history");assert.equal(count,3);
 console.log("column alteration transport: ordered native receipts and legacy compatibility passed");
} finally {useProjectStore.getState().installPersistence(null);clearMocks();delete (globalThis as any).window;}
