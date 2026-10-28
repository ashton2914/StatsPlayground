import assert from "node:assert/strict";
import {invoke} from "@tauri-apps/api/core";
import {mockIPC,clearMocks} from "@tauri-apps/api/mocks";
import {dataService} from "../src/services/dataService.ts";
import {createProjectPersistenceCoordinator} from "../src/projectPersistence/coordinator.ts";
import {useProjectStore} from "../src/stores/useProjectStore.ts";
import type {ProjectCommit} from "../src/types/projectPersistence.ts";
Object.defineProperty(globalThis,"window",{value:globalThis,configurable:true});let native=true;let calls=0;
const value={changeSetId:"paste",generation:5,rowCount:100,columnCount:2};
mockIPC((command,args:any)=>{
 calls++;if(command==="get_column_descriptors")return [{columnId:"a",name:"A",sqlType:"DOUBLE"},{columnId:"b",name:"B",sqlType:"VARCHAR"}];
 assert.equal(command,"paste_at_position_with_change_set");assert.deepEqual(args.rows,[["30"],["10"]]);assert.equal(args.expectedGeneration,4);
 if(!native){assert.equal(args.context,undefined);assert.equal(args.rowIds,undefined);assert.equal(args.columnIds,undefined);return value;}
 assert.deepEqual(args.rowIds,[30,10]);assert.deepEqual(args.columnIds,["a","b"]);assert.deepEqual(args.context.datasetGenerations,[{id:"table",generation:4}]);
 return {operationId:args.context.operationId,epoch:7,committedRevision:1,value,changedDatasetGenerations:[{id:"table",generation:5}],changedDocumentRevisions:[]};
});
const queue=createProjectPersistenceCoordinator({projectId:"project",epoch:7,committedRevision:0,now:()=>0,newOperationId:()=>crypto.randomUUID(),setTimer:()=>0,clearTimer:()=>{},transport:(operation,context)=>invoke<ProjectCommit<any>>(operation.command,{...(operation.payload as object),context})});useProjectStore.getState().installPersistence(queue);
try {
 assert.deepEqual(await dataService.pasteAtPositionWithChangeSet("table",0,0,[["30"],["10"]],null,["DOUBLE"],4,[30,10]),value);assert.equal(queue.snapshot().acknowledgedSequence,1);
 await queue.close();useProjectStore.getState().installPersistence(null);native=false;
 assert.deepEqual(await dataService.pasteAtPositionWithChangeSet("table",0,0,[["30"],["10"]],null,["DOUBLE"],4,[30,10]),value);assert.equal(calls,3);
 console.log("native paste transport: stable row/column identity, one receipt and legacy compatibility passed");
}finally{useProjectStore.getState().installPersistence(null);clearMocks();delete(globalThis as any).window;}
