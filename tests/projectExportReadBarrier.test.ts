import assert from "node:assert/strict";
import {mockIPC,clearMocks} from "@tauri-apps/api/mocks";
import {ioService} from "../src/services/ioService.ts";
import {useProjectStore} from "../src/stores/useProjectStore.ts";
import {createProjectPersistenceCoordinator} from "../src/projectPersistence/coordinator.ts";
Object.defineProperty(globalThis,"window",{value:globalThis,configurable:true});
const exports:any[]=[];let release:(()=>void)|undefined;let fail=false;let cleanup=false;
const queue=createProjectPersistenceCoordinator({projectId:"project",epoch:44,committedRevision:0,now:Date.now,newOperationId:()=>crypto.randomUUID(),setTimer:()=>0,clearTimer:()=>{},transport:async<T>(_operation,context)=>{
 if(!cleanup)await new Promise<void>(resolve=>{release=resolve;});if(fail)throw new Error("write failed");
 return {operationId:context.operationId,epoch:44,committedRevision:context.expectedRevision+1,value:null as T,changedDocumentRevisions:[],changedDatasetGenerations:[]};
}});
mockIPC((command,args)=>{assert.equal(command,"export_csv_authorized");exports.push(args);});
try {
 useProjectStore.getState().installPersistence(queue);
 const write=queue.submit({command:"commit_project_records",payload:{}});const exporting=ioService.exportCsvAuthorized("table","root","data.csv",false);
 await new Promise(resolve=>setImmediate(resolve));assert.equal(exports.length,0,"export must wait for edits captured when it began");
 release!();await write;await exporting;assert.deepEqual(exports[0],{datasetId:"table",rootId:"root",relativePath:"data.csv",overwriteConfirmed:false,epoch:44});
 const nextWrite=queue.submit({command:"commit_project_records",payload:{}});const switched=ioService.exportCsvAuthorized("table","root","other.csv",false);
 await new Promise(resolve=>setImmediate(resolve));useProjectStore.setState({persistence:null});release!();await nextWrite;
 await assert.rejects(switched,/project_session_stale/);assert.equal(exports.length,1);
 useProjectStore.getState().installPersistence(queue);fail=true;
 const failedWrite=queue.submit({command:"commit_project_records",payload:{}});void failedWrite.catch(()=>{});
 const failed=ioService.exportCsvAuthorized("table","root","failed.csv",false);await new Promise(resolve=>setImmediate(resolve));release!();await assert.rejects(failed,/write failed/);assert.equal(exports.length,1);
 useProjectStore.setState({persistence:null});await ioService.exportCsvAuthorized("legacy","root","legacy.csv",false);assert.deepEqual(exports[1],{datasetId:"legacy",rootId:"root",relativePath:"legacy.csv",overwriteConfirmed:false});
 console.log("CSV read barrier: waits captured writes, rejects failed/stale owner and preserves legacy dispatch");
} finally {cleanup=true;fail=false;release?.();await queue.close();useProjectStore.setState({persistence:null});clearMocks();delete (globalThis as any).window;}
