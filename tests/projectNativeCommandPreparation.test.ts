import {withoutDocumentPersistence} from "../src/stores/documentStore.ts";
import {createApplicationRuntime} from "../src/applicationCommands/applicationRuntime.ts";
import assert from "node:assert/strict";
import {mockIPC,clearMocks} from "@tauri-apps/api/mocks";
import {prepareNativeDocumentAccess} from "../src/projectPersistence/catalogAccess.ts";
import {createProjectPersistenceCoordinator} from "../src/projectPersistence/coordinator.ts";
import {createProjectDocumentAdapters} from "../src/projectPersistence/documentAdapters.ts";
import {useProjectCatalogStore} from "../src/stores/useProjectCatalogStore.ts";
import {useProjectStore} from "../src/stores/useProjectStore.ts";
import {useDataStore} from "../src/stores/useDataStore.ts";
import {useReportStore} from "../src/stores/useReportStore.ts";
import {useGraphBuilderNewStore} from "../src/stores/useGraphBuilderNewStore.ts";
import type {ProjectDocumentSummary} from "../src/types/projectPersistence.ts";
const summary=(id:string,kind:ProjectDocumentSummary["kind"],name:string):ProjectDocumentSummary=>({id,kind,name,folder:"",revision:1,dependencies:[]});
const later=[summary("report","report","Report 16"),summary("new","graphNew","Graph Builder-new 1"),summary("graph","graph","Table - Graph1")];
let bodies=0,pages=0,metadata=0;let holdMetadata=false;let releaseMetadata:((value:unknown)=>void)|undefined;
Object.defineProperty(globalThis,"window",{value:globalThis,configurable:true});
mockIPC((command,args:any)=>{
 if(command==="list_project_catalog") {pages++;return {items:later,nextCursor:null,committedRevision:1};}
 if(command==="list_datasets") {metadata++;if(holdMetadata) return new Promise(resolve=>{releaseMetadata=resolve;});return [{id:"table",name:"Table",sourcePath:null,sourceType:"manual",rowCount:1000000,colCount:1,generation:1,createdAt:"today",updatedAt:"today"}];}
 if(command==="get_project_document") {bodies++;assert.equal(args.id,"report");return {summary:later[0],schemaVersion:1,body:{id:"report",name:"Report 16",schemaVersion:1,markdown:"selected",createdAt:"today",updatedAt:"today"}};}
 throw new Error(`Unexpected ${command}`);
});
const queue=createProjectPersistenceCoordinator({projectId:"project",epoch:101,committedRevision:1,now:()=>0,newOperationId:()=>crypto.randomUUID(),setTimer:()=>0,clearTimer:()=>{},transport:async()=>{throw new Error("metadata preparation must not write");}});
useProjectStore.setState({readOnly:false});useProjectStore.getState().installPersistence(queue);
useReportStore.getState().reset();useGraphBuilderNewStore.getState().reset();useDataStore.setState({datasets:[]});
const adapter=createProjectDocumentAdapters({coordinator:queue,summaries:[]});const release=adapter.activate();
useProjectCatalogStore.getState().installOpenSummary({project:{name:"Project",filePath:"project.spprj",createdAt:"today"},epoch:101,writable:true,header:{projectId:"project",formatVersion:"5.0.0",minimumReader:1,minimumWriter:1,committedRevision:1,createdAt:"today",engineVersion:"test",storageVersion:"test"},directory:{items:[],nextCursor:"more",committedRevision:1},settingsRevision:0});
try {
 const runtime=createApplicationRuntime({revision:{get:()=>1,set:()=>{},isAuthoritative:()=>true},graph:{addGraph:()=>{},activateGraph:()=>{},markDirty:()=>{},recordAction:()=>{}}});
 const created=await runtime.execute({type:"graph.create",input:{sourceDatasetId:"table"}},{kind:"ui"});
 assert.equal(created.data.item.name,"Table - Graph1-2","the public command must reserve unloaded names before creating a document");
 await runtime.shutdown();
 await prepareNativeDocumentAccess({datasetIds:["table"]});
 assert.equal(pages,1);assert.equal(metadata,1);assert.equal(bodies,0);
 assert.equal(useDataStore.getState().datasets[0].rowCount,1000000);
 assert.equal(useReportStore.getState().nextName(),"Report 17","unloaded metadata must reserve names");
 await prepareNativeDocumentAccess({documentIds:["report"],datasetIds:["table"]});
 assert.equal(bodies,1);assert.equal(metadata,1);assert.equal(pages,1);
 assert.equal(useReportStore.getState().items[0].markdown,"selected");
 assert.equal(useGraphBuilderNewStore.getState().items.length,0,"unrelated graph bodies stay unloaded");
 const graphId=withoutDocumentPersistence(()=>useGraphBuilderNewStore.getState().open("table",1));
 assert.equal(useGraphBuilderNewStore.getState().items.find(item=>item.id===graphId)?.name,"Graph Builder-new 2");
 useDataStore.setState({datasets:[]});holdMetadata=true;
 const pending=prepareNativeDocumentAccess({datasetIds:["table"]});
 while(!releaseMetadata) await new Promise(resolve=>setImmediate(resolve));
 useProjectStore.getState().installPersistence(null);releaseMetadata([]);
 await assert.rejects(pending,/session_stale/);
 assert.deepEqual(useDataStore.getState().datasets,[],"old metadata response cannot populate another project");
 useProjectStore.getState().installPersistence(queue);
 assert.equal(queue.captureBarrier(),0);
 console.log("native command preparation: complete metadata inventory, source table metadata, selected body and unloaded name reservation passed");
} finally {release();await queue.close();useProjectStore.getState().installPersistence(null);useProjectCatalogStore.getState().reset(102);useReportStore.getState().reset();useGraphBuilderNewStore.getState().reset();useDataStore.setState({datasets:[]});clearMocks();delete (globalThis as any).window;}
