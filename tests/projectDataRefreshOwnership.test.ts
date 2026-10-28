import assert from "node:assert/strict";
import {mockIPC,clearMocks} from "@tauri-apps/api/mocks";
import {useDataStore} from "../src/stores/useDataStore.ts";
import {useProjectStore} from "../src/stores/useProjectStore.ts";
import {createProjectPersistenceCoordinator} from "../src/projectPersistence/coordinator.ts";
import type {DatasetMeta} from "../src/types/data.ts";
Object.defineProperty(globalThis,"window",{value:globalThis,configurable:true});
const dataset=(name:string,id="shared"):DatasetMeta=>({id,name,sourcePath:null,sourceType:"manual",rowCount:name==="A"?1:200,colCount:1,generation:1,createdAt:"today",updatedAt:"today"});
const owner=(projectId:string,epoch:number)=>createProjectPersistenceCoordinator({projectId,epoch,committedRevision:1,now:()=>0,newOperationId:()=>crypto.randomUUID(),setTimer:()=>0,clearTimer:()=>{},transport:async()=>{throw new Error("read cannot write");}});
try {
 for(const destination of ["B","closed"] as const){
  const a=owner("A",1);useProjectStore.getState().installPersistence(a);
  useDataStore.setState({datasets:[dataset("A")],activeDatasetId:"shared"});
  let resolve!:(items:DatasetMeta[])=>void;
  mockIPC(command=>{assert.equal(command,"list_datasets");return new Promise<DatasetMeta[]>(done=>{resolve=done;});});
  const delayed=useDataStore.getState().refreshDatasets();
  const b=destination==="B"?owner("B",2):null;
  useProjectStore.getState().installPersistence(b);
  const expected=destination==="B"?[dataset("B"),dataset("B-only","second")]:[];
  useDataStore.setState({datasets:expected,activeDatasetId:destination==="B"?"second":null});
  resolve([dataset("A")]);await delayed;
  assert.deepEqual(useDataStore.getState().datasets,expected,`late A metadata must not replace ${destination} tables`);
  assert.equal(useDataStore.getState().activeDatasetId,destination==="B"?"second":null);
  assert.equal(b?.snapshot().pendingSequence??0,0);
  await a.close();await b?.close();
 }
 const sameOwner=owner("same",3);useProjectStore.getState().installPersistence(sameOwner);
 const responses:Array<(items:DatasetMeta[])=>void>=[];
 mockIPC(()=>new Promise<DatasetMeta[]>(resolve=>responses.push(resolve)));
 const older=useDataStore.getState().refreshDatasets();const newer=useDataStore.getState().refreshDatasets();
 responses[1]([dataset("newer")]);await newer;responses[0]([dataset("older")]);await older;
 assert.equal(useDataStore.getState().datasets[0].name,"newer","same-owner response order cannot roll metadata back");
 await sameOwner.close();
 console.log("table metadata refresh preserves new and closed project owners and response order");
} finally {clearMocks();useProjectStore.getState().installPersistence(null);useDataStore.setState({datasets:[],activeDatasetId:null});}
