import assert from "node:assert/strict";
import {mockIPC,clearMocks} from "@tauri-apps/api/mocks";
import {tableTransformService} from "../src/services/tableTransformService.ts";
import {projectService} from "../src/services/projectService.ts";
import {createProjectPersistenceCoordinator} from "../src/projectPersistence/coordinator.ts";
import {createProjectDocumentAdapters} from "../src/projectPersistence/documentAdapters.ts";
import {useProjectStore} from "../src/stores/useProjectStore.ts";
import type {ProjectWriteContext} from "../src/types/projectPersistence.ts";
const definition={id:"transform",name:"Sort",formatVersion:"1",revision:1,operation:{kind:"sort" as const,sortColumns:[{column:"value",direction:"ascending" as const}]},inputSlots:[],output:{tableDocumentId:"output",name:"Sorted"}};
const binding={definitionId:"transform",definitionRevision:1,inputs:[{role:"source",tableDocumentId:"source"}],outputGeneration:2};
const lineage={id:"project-lineage",name:"",graphVersion:0,graphHash:"",nodes:[],edges:[]};
const result={definition,execution:{binding,status:"succeeded"},lineageGraph:lineage};
const calls:Array<{command:string;args:any}>=[];
Object.defineProperty(globalThis,"window",{value:globalThis,configurable:true});
mockIPC((command,args:any)=>{
 if(command==="get_dataset_generation") return args.datasetId==="output"?2:4;
 calls.push({command,args:structuredClone(args)});
 const context=args.context as ProjectWriteContext|undefined;
 return context?{operationId:context.operationId,epoch:7,committedRevision:context.expectedRevision+1,value:result,changedDocumentRevisions:[],changedDatasetGenerations:[]}:result;
});
const queue=createProjectPersistenceCoordinator({projectId:"project",epoch:7,committedRevision:0,now:Date.now,newOperationId:()=>crypto.randomUUID(),setTimer:()=>0,clearTimer:()=>{},transport:projectService.commitOperation});
useProjectStore.getState().installPersistence(queue);
const adapter=createProjectDocumentAdapters({coordinator:queue,summaries:[{id:"transform",kind:"transform",name:"Sort",folder:"",revision:3,dependencies:["source"]}]});const release=adapter.activate();
try {
 assert.deepEqual(await tableTransformService.run(definition,binding,lineage),result);
 assert.equal(calls[0].command,"run_table_transform");
 assert.deepEqual(calls[0].args.context.datasetGenerations,[{id:"source",generation:4},{id:"output",generation:2}]);
 assert.deepEqual(calls[0].args.context.documentRevisions,[{id:"transform",revision:3}]);
 assert.equal(queue.snapshot().acknowledgedSequence,1);
 const inputs=[{role:"source",tableDocumentId:"replacement"}];
 await tableTransformService.rebindAndRun(definition,binding,inputs,lineage);
 assert.equal(calls[1].command,"rebind_table_transform");
 assert.deepEqual(calls[1].args.context.datasetGenerations,[{id:"replacement",generation:4},{id:"output",generation:2}]);
 assert.equal(queue.snapshot().acknowledgedSequence,2);
 await queue.close();console.log("native transform rerun/rebind: ordered commits, source/output generations and definition body CAS passed");
} finally {release();useProjectStore.getState().installPersistence(null);clearMocks();delete (globalThis as any).window;}
