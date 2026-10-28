import assert from "node:assert/strict";
import {invoke} from "@tauri-apps/api/core";
import {mockIPC,clearMocks} from "@tauri-apps/api/mocks";
import {fitModelService} from "../src/services/fitModelService.ts";
import {useProjectStore} from "../src/stores/useProjectStore.ts";
import {createProjectPersistenceCoordinator} from "../src/projectPersistence/coordinator.ts";
import type {ProjectCommit} from "../src/types/projectPersistence.ts";
Object.defineProperty(globalThis,"window",{value:globalThis,configurable:true});
const request={datasetId:"data",expectedGeneration:4,modelName:"Fit",responseColumn:"Y",terms:[{kind:"main" as const,columnNames:["X"] as [string]}],centeringMethod:"none" as const,confidenceLevel:0.95 as const,metrics:["predicted" as const,"residual" as const]};
const result={changeSetId:"history",generation:5,columns:[{metric:"predicted",columnName:"Fit Predicted"},{metric:"residual",columnName:"Fit Residual"}]};
let native=true;let calls=0;
mockIPC((command,args:any)=>{calls++;assert.equal(command,"save_fit_model_columns");assert.deepEqual(args.request,request);
 if(!native){assert.equal(args.context,undefined);return result;}
 assert.ok(args.context,"native fitting must use the project queue");assert.deepEqual(args.context.datasetGenerations,[{id:"data",generation:4}]);assert.equal(args.context.expectedEpoch,9);
 return {operationId:args.context.operationId,epoch:9,committedRevision:1,value:result,changedDatasetGenerations:[{id:"data",generation:5}],changedDocumentRevisions:[]};});
const queue=createProjectPersistenceCoordinator({projectId:"p",epoch:9,committedRevision:0,now:()=>0,newOperationId:()=>crypto.randomUUID(),setTimer:()=>0,clearTimer:()=>{},transport:(op,context)=>invoke<ProjectCommit<any>>(op.command,{...(op.payload as object),context})});
try{useProjectStore.getState().installPersistence(queue);assert.deepEqual(await fitModelService.saveColumns(request),result);assert.equal(queue.snapshot().acknowledgedSequence,1);await queue.close();useProjectStore.getState().installPersistence(null);native=false;assert.deepEqual(await fitModelService.saveColumns(request),result);assert.equal(calls,2);console.log("fit saved columns: native queue receipt and legacy route passed");}finally{useProjectStore.getState().installPersistence(null);clearMocks();delete (globalThis as any).window;}
