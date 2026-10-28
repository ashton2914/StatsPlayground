import assert from "node:assert/strict";
import {mockIPC,clearMocks} from "@tauri-apps/api/mocks";
import {projectService} from "../src/services/projectService.ts";
import {useProjectStore} from "../src/stores/useProjectStore.ts";
import {createProjectPersistenceCoordinator} from "../src/projectPersistence/coordinator.ts";
Object.defineProperty(globalThis,"window",{value:globalThis,configurable:true});
let native=true;const requests:any[]=[];
mockIPC((command,args:any)=>{
 assert.equal(command,"import_table");requests.push(structuredClone(args));
 if(!native)return {id:"legacy-import"};
 assert.ok(args.context,"native standalone import must pass through its ordered durable writer");assert.equal(args.filePath,"/virtual/source.sptb");
 return {operationId:args.context.operationId,epoch:7,committedRevision:2,value:{id:"native-import"},changedDatasetGenerations:[{id:"native-import",generation:0}],changedDocumentRevisions:[]};
});
const queue=createProjectPersistenceCoordinator({projectId:"project",epoch:7,committedRevision:1,now:()=>0,newOperationId:()=>"import-operation",setTimer:()=>0,clearTimer:()=>{},transport:projectService.commitOperation});
try {
 useProjectStore.getState().installPersistence(queue);assert.deepEqual(await projectService.importTable("/virtual/source.sptb"),{id:"native-import"});assert.equal(queue.captureBarrier(),1);assert.equal(queue.snapshot().committedRevision,2);assert.deepEqual(requests[0].context.datasetGenerations??[],[]);
 await queue.close();native=false;useProjectStore.getState().installPersistence(null);assert.deepEqual(await projectService.importTable("/virtual/source.sptb"),{id:"legacy-import"});assert.deepEqual(requests[1],{filePath:"/virtual/source.sptb"});
 console.log("standalone table import: ordered native receipt, unchanged public result and legacy compatibility passed");
} finally {useProjectStore.getState().installPersistence(null);clearMocks();delete (globalThis as any).window;}
