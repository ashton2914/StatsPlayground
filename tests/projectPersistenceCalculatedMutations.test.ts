import assert from "node:assert/strict";
import {invoke} from "@tauri-apps/api/core";
import {mockIPC,clearMocks} from "@tauri-apps/api/mocks";
import {dataService} from "../src/services/dataService.ts";
import {createProjectPersistenceCoordinator} from "../src/projectPersistence/coordinator.ts";
import {useProjectStore} from "../src/stores/useProjectStore.ts";
import type {ProjectCommit} from "../src/types/projectPersistence.ts";
Object.defineProperty(globalThis,"window",{value:globalThis,configurable:true});
let native=true;let count=0;
const request={datasetId:"table",outputName:"Twice",formulaText:"[A] * 2",atIndex:null,outputColumnId:null,formulaId:null,expectedGeneration:4};
mockIPC((command,args:any)=>{
 count++;const converting=command==="convert_calculated_column_to_values";
 assert.ok(converting||command==="upsert_calculated_column");
 if(converting) {assert.equal(args.columnId,"calculated");assert.equal(args.expectedGeneration,5);} else {assert.deepEqual(args.request,request);}
 const result={columnId:"calculated",datasetGeneration:converting?6:5,changeSetId:converting?"values":"formula",warningCount:{total:0,expression:0,dependencyGraph:0,validation:0}};
 if(!native) {assert.equal(args.context,undefined);return result;}
 assert.equal(args.context.expectedEpoch,7);assert.equal(args.context.expectedProjectId,"project");assert.deepEqual(args.context.datasetGenerations,[{id:"table",generation:converting?5:4}]);
 return {operationId:args.context.operationId,epoch:7,committedRevision:converting?2:1,value:result,changedDatasetGenerations:[{id:"table",generation:result.datasetGeneration}],changedDocumentRevisions:[]};
});
const queue=createProjectPersistenceCoordinator({projectId:"project",epoch:7,committedRevision:0,now:()=>0,newOperationId:()=>crypto.randomUUID(),setTimer:()=>0,clearTimer:()=>{},transport:(operation,context)=>invoke<ProjectCommit<any>>(operation.command,{...(operation.payload as object),context})});
useProjectStore.getState().installPersistence(queue);
try {
 assert.equal((await dataService.upsertCalculatedColumn(request)).datasetGeneration,5);assert.equal(queue.snapshot().acknowledgedSequence,1);
 assert.equal((await dataService.convertCalculatedColumnToValues("table","calculated",5)).datasetGeneration,6);assert.equal(queue.snapshot().acknowledgedSequence,2);
 await queue.close();useProjectStore.getState().installPersistence(null);native=false;
 assert.equal((await dataService.upsertCalculatedColumn(request)).datasetGeneration,5);assert.equal(count,3);
 console.log("calculated mutation transport: ordered native receipts and legacy compatibility passed");
} finally {useProjectStore.getState().installPersistence(null);clearMocks();delete (globalThis as any).window;}
