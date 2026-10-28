import assert from "node:assert/strict";
import {mockIPC,clearMocks} from "@tauri-apps/api/mocks";
import {tableTransformService} from "../src/services/tableTransformService.ts";
import {createProjectPersistenceCoordinator} from "../src/projectPersistence/coordinator.ts";
import {projectService} from "../src/services/projectService.ts";
import {useProjectStore} from "../src/stores/useProjectStore.ts";
import type {ProjectWriteContext} from "../src/types/projectPersistence.ts";
Object.defineProperty(globalThis,"window",{value:globalThis,configurable:true});
const result={definition:{id:"native-transform"},execution:{status:"succeeded"},lineageGraph:{nodes:[]}};
const writes:Array<Record<string,unknown>>=[];
mockIPC((command,args)=>{
  if(command==="get_dataset_generation") return 5;
  assert.equal(command,"create_table_transform");
  writes.push(structuredClone(args??{}));
  const context=args?.context as ProjectWriteContext|undefined;
  return context?{operationId:context.operationId,epoch:9,committedRevision:1,value:result,changedDatasetGenerations:[],changedDocumentRevisions:[]}:result;
});
try {
  const draft={name:"Sort",outputName:"Sorted",operation:{kind:"sort" as const,sortColumns:[{column:"value",direction:"ascending" as const}]},inputBindings:[{role:"source",tableDocumentId:"source"}]};
  const lineage={id:"lineage",name:"Lineage",nodes:[],edges:[]};
  assert.deepEqual(await tableTransformService.createAndRun(draft,lineage),result);
  const queue=createProjectPersistenceCoordinator({projectId:"project",epoch:9,committedRevision:0,now:Date.now,newOperationId:()=>crypto.randomUUID(),setTimer:()=>1,clearTimer:()=>{},transport:projectService.commitOperation});
  useProjectStore.getState().installPersistence(queue);
  assert.deepEqual(await tableTransformService.createAndRun(draft,lineage),result);
  assert.deepEqual((writes[1].context as ProjectWriteContext).datasetGenerations,[{id:"source",generation:5}]);
  assert.equal(queue.snapshot().acknowledgedSequence,1);
  await queue.close();
  console.log("transform persistence: legacy result and native creation acknowledgement passed");
} finally {useProjectStore.getState().installPersistence(null);clearMocks();delete (globalThis as {window?:unknown}).window;}
