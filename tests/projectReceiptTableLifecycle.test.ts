import assert from "node:assert/strict";
import {mockIPC,clearMocks} from "@tauri-apps/api/mocks";
import {createProjectDocumentAdapters} from "../src/projectPersistence/documentAdapters.ts";
import {createProjectPersistenceCoordinator} from "../src/projectPersistence/coordinator.ts";
import {useProjectStore} from "../src/stores/useProjectStore.ts";
import {useHistoryStore} from "../src/stores/useHistoryStore.ts";
import {useDataStore} from "../src/stores/useDataStore.ts";
import {useGraphBuilderStore} from "../src/stores/useGraphBuilderStore.ts";
import type {ProjectCommit,ProjectDocumentSummary} from "../src/types/projectPersistence.ts";
Object.defineProperty(globalThis,"window",{value:globalThis,configurable:true});
const id="00000000-0000-4000-8000-000000000001";
const dataset={id:"table",name:"Table",sourcePath:null,sourceType:"manual" as const,rowCount:1000000,colCount:1,generation:1,createdAt:"today",updatedAt:"today"};
const table:ProjectDocumentSummary={id:"table",kind:"table",name:"Table",folder:"",revision:1,dependencies:[]};
const graph:ProjectDocumentSummary={id:"graph",kind:"graph",name:"Graph",folder:"",revision:1,dependencies:["table"]};
let active=false;let eventRevision=1;let revision=2;let generation=1;let invalidated=false;const writes:any[]=[];
mockIPC((command,args:any)=>{if(command==="get_project_history_frontier")return {committedRevision:revision,entry:{id,datasetId:"table",operation:"delete_table",applied:!active,generation:active?generation:1}};assert.equal(command,"get_project_table_lifecycle_event","history replay must not hydrate graph bodies or table rows");assert.deepEqual(args,{epoch:5,eventId:id});if(invalidated)throw new Error("event_missing");return {id,datasetId:"table",operation:"delete_table",applied:!active,revision:eventRevision,historyOrdinal:1,projectRevision:revision,datasetGeneration:active?generation:null};});
let receive!:(commit:ProjectCommit<unknown>)=>void;
const owner=createProjectPersistenceCoordinator({projectId:"project",epoch:5,committedRevision:1,subscribeCommits:handler=>{receive=handler;return ()=>{};},now:()=>0,newOperationId:()=>crypto.randomUUID(),setTimer:()=>0,clearTimer:()=>{},onCommit:(commit,source)=>adapter.applyCommit(commit,source),transport:async<T>(operation,context)=>{
 assert.equal(operation.command,"apply_project_table_lifecycle");assert.equal(context.expectedRevision,revision);assert.ok(!invalidated);const payload=operation.payload as {eventRevision:number;undo:boolean};assert.equal(payload.eventRevision,eventRevision);writes.push(structuredClone({operation,context}));
 active=payload.undo;if(active)generation++;eventRevision++;revision++;
 return {operationId:context.operationId,epoch:5,committedRevision:revision,value:null as T,changedDatasetGenerations:active?[{id:"table",generation}]:[],changedDatasetMetadata:active?[{...dataset,generation}]:[],changedDocumentRevisions:active?[{id:"table",revision:eventRevision},{id:"graph",revision:eventRevision}]:[],changedDirectoryEntries:active?[{...table,revision:eventRevision},{...graph,revision:eventRevision}]:[],deletedDirectoryIds:active?[]:["table","graph"],changedHistoryEntries:[{id,datasetId:"table",datasetName:"Table",operation:"delete_table",applied:!active,generation}]};
}});
useProjectStore.getState().installPersistence(owner);useHistoryStore.setState({history:[{id:"old-edit",timestamp:"today",description:"edit",action:{kind:"changeSet",datasetId:"table",changeSetId:"old-edit"}}],currentIdx:0,pendingAction:null,tableMutationDepth:0});
useDataStore.setState({datasets:[dataset],activeDatasetId:"table"});useGraphBuilderStore.setState({items:[{id:"graph",name:"Graph",sourceDatasetId:"table"}] as any});
const adapter=createProjectDocumentAdapters({coordinator:owner,summaries:[table,graph]});const release=adapter.activate();
const deleted:ProjectCommit<null>={operationId:"delete",epoch:5,committedRevision:2,value:null,changedDatasetGenerations:[],changedDocumentRevisions:[],deletedDirectoryIds:["table","graph"],changedHistoryEntries:[{id,datasetId:"table",datasetName:"Table",operation:"delete_table",applied:true,generation:1}]};
try {
 receive(deleted);
 assert.deepEqual(useHistoryStore.getState().history.map(entry=>entry.id),[id,"old-edit"],"a lifecycle deletion preserves its executable history");
 assert.equal(useHistoryStore.getState().history[0].action?.kind,"tableLifecycle");assert.equal(useDataStore.getState().datasets.length,0);assert.equal(owner.captureBarrier(),0);
 await useHistoryStore.getState().undo();
 assert.equal(useHistoryStore.getState().historyError,null);assert.equal(useHistoryStore.getState().currentIdx,1);assert.equal(useDataStore.getState().datasets[0]?.generation,2,"restoration projects new dataset metadata without fetching every table");assert.equal(useGraphBuilderStore.getState().items.length,0,"restored graphs remain lazy");assert.equal(adapter.getSummary("graph")?.revision,2);
 adapter.applyCommit(deleted);assert.equal(useDataStore.getState().datasets[0]?.generation,2);assert.equal(useHistoryStore.getState().currentIdx,1);
 await useHistoryStore.getState().redo();assert.equal(useHistoryStore.getState().historyError,null);assert.equal(useDataStore.getState().datasets.length,0);assert.equal(useHistoryStore.getState().currentIdx,0);assert.equal(useHistoryStore.getState().history.length,2);assert.equal(writes.length,2);
 active=true;generation=3;revision=5;invalidated=true;
 adapter.applyCommit({operationId:"restore-snapshot",epoch:5,committedRevision:5,value:{kind:"dataSnapshotRestored",snapshotId:"snapshot",tableHistoryReset:true},changedDatasetGenerations:[{id:"table",generation:3}],changedDatasetMetadata:[{...dataset,generation:3}],changedDocumentRevisions:[{id:"table",revision:3}],changedDirectoryEntries:[{...table,revision:3}]});
 adapter.applyCommit(deleted);assert.equal(useHistoryStore.getState().history.length,0,"a late pre-snapshot lifecycle receipt cannot resurrect history");assert.equal(useDataStore.getState().datasets[0]?.generation,3);assert.equal(writes.length,2);
 console.log("table lifecycle receipt: retained executable history, native undo/redo, lazy restore metadata and snapshot fences passed");
} finally {release();useHistoryStore.getState().reset();await owner.close().catch(()=>undefined);useProjectStore.getState().installPersistence(null);useDataStore.setState({datasets:[]});useGraphBuilderStore.getState().reset();clearMocks();delete (globalThis as any).window;}
