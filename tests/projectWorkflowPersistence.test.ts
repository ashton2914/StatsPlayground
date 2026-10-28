import assert from "node:assert/strict";
import {mockIPC,clearMocks} from "@tauri-apps/api/mocks";
import {projectService} from "../src/services/projectService.ts";
import {createProjectPersistenceCoordinator} from "../src/projectPersistence/coordinator.ts";
import {createProjectDocumentAdapters} from "../src/projectPersistence/documentAdapters.ts";
import {useProjectStore} from "../src/stores/useProjectStore.ts";
import type {WorkflowRunRequest,WorkflowRunCommitPacket} from "../src/types/workflow.ts";
Object.defineProperty(globalThis,"window",{value:globalThis,configurable:true});
const request:WorkflowRunRequest={workflow:{id:"workflow",name:"Workflow",formatVersion:"1",revision:1,inputSlots:[],operations:[],edges:[],outputDeclarations:[]},inputBindings:[{slotId:"slot",tableDocumentId:"source"}],outputBindings:[{declarationId:"out",artifactDocumentId:"output"}],seed:42,previousRuns:[]};
const packet={commitId:"run",documents:[],run:{id:"run",workflowId:"workflow",workflowRevision:1,status:"succeeded",inputBindings:request.inputBindings,outputBindings:request.outputBindings,errors:[]}} as unknown as WorkflowRunCommitPacket;
let native=true;let acknowledged=false;let switchOnRead=false;
mockIPC((command,args:any)=>{if(command==="get_dataset_generation"){if(switchOnRead)useProjectStore.getState().installPersistence(null);return args.datasetId==="source"?4:2;}
 if(command==="acknowledge_workflow_commit"){assert.equal(native,false,"native receipts are the acknowledgement");acknowledged=true;return;}
 assert.equal(command,"run_workflow");assert.deepEqual(args.request,request);if(!native){assert.equal(args.context,undefined);return packet;}
 assert.ok(args.context,"native workflow must use the persistence queue");assert.deepEqual(args.context.datasetGenerations,[{id:"source",generation:4},{id:"output",generation:2}]);assert.deepEqual(args.context.documentRevisions,[{id:"workflow",revision:3},{id:"output",revision:7}]);
 return {operationId:args.context.operationId,epoch:7,committedRevision:1,value:packet,changedDatasetGenerations:[],changedDocumentRevisions:[]};});
const queue=createProjectPersistenceCoordinator({projectId:"project",epoch:7,committedRevision:0,now:()=>0,newOperationId:()=>crypto.randomUUID(),setTimer:()=>0,clearTimer:()=>{},transport:projectService.commitOperation});
useProjectStore.getState().installPersistence(queue);
const adapter=createProjectDocumentAdapters({coordinator:queue,summaries:[{id:"workflow",kind:"workflow",name:"Workflow",folder:"",revision:3,dependencies:[]},{id:"output",kind:"table",name:"Output",folder:"",revision:7,dependencies:[]}]});const release=adapter.activate();
try{assert.deepEqual(await projectService.runWorkflow(request),packet);assert.equal(queue.snapshot().acknowledgedSequence,1);await projectService.acknowledgeWorkflowCommit(packet.commitId);assert.equal(acknowledged,false);switchOnRead=true;await assert.rejects(projectService.runWorkflow(request),/Project changed before workflow run/);assert.equal(queue.captureBarrier(),1);switchOnRead=false;useProjectStore.getState().installPersistence(queue);await queue.close();release();useProjectStore.getState().installPersistence(null);native=false;assert.deepEqual(await projectService.runWorkflow(request),packet);await projectService.acknowledgeWorkflowCommit(packet.commitId);assert.equal(acknowledged,true);console.log("native workflow transport: source/output generations, definition CAS and durable receipt acknowledgement passed");}finally{release();useProjectStore.getState().installPersistence(null);clearMocks();delete (globalThis as any).window;}
