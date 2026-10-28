import assert from "node:assert/strict";
import {mockIPC,clearMocks} from "@tauri-apps/api/mocks";
import {dataService} from "../src/services/dataService.ts";
import {projectService} from "../src/services/projectService.ts";
import {useProjectStore} from "../src/stores/useProjectStore.ts";
import {createProjectPersistenceCoordinator} from "../src/projectPersistence/coordinator.ts";
import type {ProjectWriteContext,ProjectTableLifecycleEvent} from "../src/types/projectPersistence.ts";
Object.defineProperty(globalThis,"window",{value:globalThis,configurable:true});
const id="00000000-0000-4000-8000-000000000001";
let event:ProjectTableLifecycleEvent={id,datasetId:"table",operation:"delete_table",applied:true,revision:3,historyOrdinal:1,projectRevision:4,datasetGeneration:null};
let revision=5;let switchOwner=false;let wrongIdentity=false;
const writes:Array<{context:ProjectWriteContext;eventId:string;eventRevision:number;undo:boolean}>=[];
mockIPC((command,args:any)=>{
 if(command==="get_project_table_lifecycle_event") {assert.deepEqual(args,{epoch:7,eventId:event.id});if(switchOwner)useProjectStore.getState().installPersistence(null);return {...event,id:wrongIdentity?"wrong":event.id};}
 assert.equal(command,"apply_project_table_lifecycle");writes.push(structuredClone(args));
 const activate=(event.operation==="delete_table")===args.undo;
 event={...event,applied:!args.undo,revision:event.revision+1,datasetGeneration:activate?3:null};
 return {operationId:args.context.operationId,epoch:7,committedRevision:++revision,value:null,changedDatasetGenerations:activate?[{id:event.datasetId,generation:3}]:[],changedDocumentRevisions:[]};
});
const owner=createProjectPersistenceCoordinator({projectId:"project",epoch:7,committedRevision:5,now:()=>0,newOperationId:()=>crypto.randomUUID(),setTimer:()=>0,clearTimer:()=>{},transport:projectService.commitOperation});
try {
 useProjectStore.getState().installPersistence(owner);
 await dataService.applyTableLifecycle(id,true);
 assert.deepEqual(writes[0].context.datasetGenerations,[],"hidden-table undo must not read a nonexistent active generation");assert.equal(writes[0].eventRevision,3);assert.equal(writes[0].eventId,id);
 await dataService.applyTableLifecycle(id,false);
 assert.deepEqual(writes[1].context.datasetGenerations,[{id:"table",generation:3}]);assert.equal(writes[1].eventRevision,4);
 const emptyEvent="00000000-0000-4000-8000-000000000002";
 event={id:emptyEvent,datasetId:"empty",operation:"create_table",applied:true,revision:1,historyOrdinal:0,projectRevision:7,datasetGeneration:0};
 await dataService.applyTableLifecycle(emptyEvent,true);assert.deepEqual(writes[2].context.datasetGenerations,[{id:"empty",generation:0}],"an empty table still requires generation zero CAS");
 wrongIdentity=true;await assert.rejects(dataService.applyTableLifecycle(emptyEvent,false),/lifecycle.*invalid/);wrongIdentity=false;assert.equal(writes.length,3);
 switchOwner=true;await assert.rejects(dataService.applyTableLifecycle(emptyEvent,false),/Project changed/);assert.equal(writes.length,3);
 await owner.close();console.log("table lifecycle persistence: metadata-only undo, active generation CAS, event version and owner fences passed");
} finally {useProjectStore.getState().installPersistence(null);clearMocks();delete (globalThis as any).window;}
