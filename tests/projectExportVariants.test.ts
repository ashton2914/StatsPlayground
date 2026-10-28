import assert from "node:assert/strict";
import {mockIPC,clearMocks} from "@tauri-apps/api/mocks";
import {ioService} from "../src/services/ioService.ts";
import {projectService} from "../src/services/projectService.ts";
import {useProjectStore} from "../src/stores/useProjectStore.ts";
import {createProjectPersistenceCoordinator} from "../src/projectPersistence/coordinator.ts";
Object.defineProperty(globalThis,"window",{value:globalThis,configurable:true});
let release:(()=>void)|undefined;const calls:any[]=[];
const queue=createProjectPersistenceCoordinator({projectId:"project",epoch:71,committedRevision:0,now:Date.now,newOperationId:()=>crypto.randomUUID(),setTimer:()=>0,clearTimer:()=>{},transport:async<T>(_operation,context)=>{await new Promise<void>(resolve=>{release=resolve;});return {operationId:context.operationId,epoch:71,committedRevision:1,value:null as T,changedDocumentRevisions:[],changedDatasetGenerations:[]};}});
mockIPC((command,args)=>{calls.push({command,args});});
try {
 useProjectStore.getState().installPersistence(queue);
 const write=queue.submit({command:"commit_project_records",payload:{}});
 const exporting=Promise.all([
  ioService.exportCsv("table","data.csv"),ioService.exportSqlite("data.db"),ioService.exportSqliteSubset("subset.db",["table"],{table:"Data"}),
  ioService.exportCsvZip("data.zip"),ioService.exportCsvZipSubset("subset.zip",["table"],{table:"Data"}),
  projectService.exportTable("table","data.sptb"),projectService.exportTablesSptbZip(["table"],"tables.zip",{table:"Data"}),
 ]);
 await new Promise(resolve=>setImmediate(resolve));assert.equal(calls.length,0,"every external table export must await captured edits");
 release!();await write;await exporting;assert.equal(calls.length,7);for(const call of calls)assert.equal(call.args.epoch,71,call.command);
 useProjectStore.getState().installPersistence(null);await ioService.exportCsv("legacy","legacy.csv");assert.deepEqual(calls[7],{command:"export_csv",args:{datasetId:"legacy",outputPath:"legacy.csv"}});
 console.log("all table export variants wait captured edits and bind the native epoch");
} finally {release?.();await queue.close();useProjectStore.setState({persistence:null});clearMocks();delete (globalThis as any).window;}
