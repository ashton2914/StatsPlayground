import assert from "node:assert/strict";
import {mockIPC,clearMocks} from "@tauri-apps/api/mocks";
import {dataLinkService} from "../src/services/dataLinkService.ts";
import {useProjectStore} from "../src/stores/useProjectStore.ts";
import {createProjectPersistenceCoordinator} from "../src/projectPersistence/coordinator.ts";
import {projectService} from "../src/services/projectService.ts";
import type {ProjectWriteContext} from "../src/types/projectPersistence.ts";
Object.defineProperty(globalThis,"window",{value:globalThis,configurable:true});
const summary={status:"completed",imported:[],skipped:[],failedTable:null,error:null,totalRowsWritten:3};
const writes:Array<Record<string,unknown>>=[];
mockIPC((command,args)=>{
  if(command==="list_datasets") return [{id:"target",name:"Target",generation:4}];
  assert.ok(["import_selected_sqlite","import_server_snapshot","import_postgres_snapshot"].includes(command));
  writes.push(structuredClone(args??{}));
  const context=args?.context as ProjectWriteContext|undefined;
  return context?{operationId:context.operationId,epoch:8,committedRevision:writes.length-1,value:summary,changedDatasetGenerations:[{id:"target",generation:5}],changedDocumentRevisions:[]}:summary;
});
try {
  const selections=[{sourceName:"source",targetName:"Target",action:"append" as const}];
  assert.deepEqual(await dataLinkService.importSelectedSqlite("source.sqlite","legacy",selections),summary);
  assert.equal(writes[0].context,undefined);
  const queue=createProjectPersistenceCoordinator({projectId:"project",epoch:8,committedRevision:0,now:Date.now,newOperationId:()=>crypto.randomUUID(),setTimer:()=>1,clearTimer:()=>{},transport:projectService.commitOperation});
  useProjectStore.getState().installPersistence(queue);
  assert.deepEqual(await dataLinkService.importSelectedSqlite("source.sqlite","native",selections),summary);
  assert.deepEqual((writes[1].context as ProjectWriteContext).datasetGenerations,[{id:"target",generation:4}]);
  assert.equal(queue.snapshot().acknowledgedSequence,1);
  const definition={connector:"postgresql" as const,host:"fixture",port:5432,database:"fixture",authenticationType:"usernamePassword" as const,tlsMode:"disabled" as const,connectTimeoutSeconds:1};
  const credentials={username:"fixture",password:"unused-fixture"};
  const object={catalog:"fixture",schema:"public",name:"values",objectType:"table" as const};
  for(const importSnapshot of [dataLinkService.importServerSnapshot,dataLinkService.importPostgresSnapshot]) {
    assert.deepEqual(await importSnapshot(definition,credentials,object,"Imported"),summary);
    assert.equal((writes.at(-1)!.context as ProjectWriteContext)?.expectedProjectId,"project","server imports must join the native persistence queue");
  }
  assert.equal(queue.snapshot().acknowledgedSequence,3);
  await queue.close();
  console.log("Data link persistence: legacy envelope, native append preconditions and queued server/Postgres imports passed");
} finally {useProjectStore.getState().installPersistence(null);clearMocks();delete (globalThis as {window?:unknown}).window;}
