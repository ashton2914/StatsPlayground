import assert from "node:assert/strict";
import {invoke} from "@tauri-apps/api/core";
import {mockIPC,clearMocks} from "@tauri-apps/api/mocks";
import {tabulateService} from "../src/services/tabulateService.ts";
import {useProjectStore} from "../src/stores/useProjectStore.ts";
import {createProjectPersistenceCoordinator} from "../src/projectPersistence/coordinator.ts";
import type {ProjectCommit} from "../src/types/projectPersistence.ts";
Object.defineProperty(globalThis,"window",{value:globalThis,configurable:true});
const request={sessionId:"session",sourceGeneration:4,fingerprint:"fingerprint",destinationName:"Output",missingLabel:"Missing",statisticLabels:["Mean"]};
const result={id:"output",name:"Output",sourceType:"manual",rowCount:2,colCount:2,generation:0};let native=true;
mockIPC((command,args:any)=>{assert.equal(command,"materialize_tabulate_table");assert.deepEqual(args.request,request);if(!native){assert.equal(args.context,undefined);return result;}assert.ok(args.context,"native materialization requires a project operation");assert.deepEqual(args.context.datasetGenerations,[{id:"source",generation:4}]);return {operationId:args.context.operationId,epoch:7,committedRevision:1,value:result,changedDatasetGenerations:[{id:"output",generation:0}],changedDocumentRevisions:[]};});
const queue=createProjectPersistenceCoordinator({projectId:"p",epoch:7,committedRevision:0,now:()=>0,newOperationId:()=>crypto.randomUUID(),setTimer:()=>0,clearTimer:()=>{},transport:(op,context)=>invoke<ProjectCommit<any>>(op.command,{...(op.payload as object),context})});
try{useProjectStore.getState().installPersistence(queue);assert.deepEqual(await tabulateService.materializeTable(request,"source"),result);assert.equal(queue.snapshot().acknowledgedSequence,1);await assert.rejects(tabulateService.materializeTable(request),/source.*required/);await queue.close();useProjectStore.getState().installPersistence(null);native=false;assert.deepEqual(await tabulateService.materializeTable(request),result);console.log("tabulate output: native source fence, receipt and legacy route passed");}finally{useProjectStore.getState().installPersistence(null);clearMocks();delete (globalThis as any).window;}
