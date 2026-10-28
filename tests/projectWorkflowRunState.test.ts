import assert from "node:assert/strict";
import {mockIPC,clearMocks} from "@tauri-apps/api/mocks";
import {useProjectStore} from "../src/stores/useProjectStore.ts";
import {createProjectPersistenceCoordinator} from "../src/projectPersistence/coordinator.ts";
import {resolveWorkflowOutputBindings} from "../src/projectPersistence/workflowRunState.ts";
import {nativeGraphWorkflowFixture} from "./nativeWorkflowFixture.ts";
import type {WorkflowRun} from "../src/types/workflow.ts";
Object.defineProperty(globalThis,"window",{value:globalThis,configurable:true});
const workflow=nativeGraphWorkflowFixture("workflow");let switchOwner=false;let malformed=false;
mockIPC((command,args:any)=>{assert.equal(command,"get_project_workflow_run_state");assert.deepEqual(args,{epoch:7,workflowId:"workflow",workflowRevision:1});if(switchOwner)useProjectStore.getState().installPersistence(null);return {workflowId:malformed?"other":"workflow",workflowRevision:1,committedRevision:4,totalCount:3,latestRunId:"saved-run",latestOutputBindings:[{declarationId:"output-graph",artifactDocumentId:"custom-saved-output"}]};});
const queue=createProjectPersistenceCoordinator({projectId:"p",epoch:7,committedRevision:4,now:()=>0,newOperationId:()=>crypto.randomUUID(),setTimer:()=>0,clearTimer:()=>{},transport:async()=>{throw new Error("metadata must not write");}});
try{useProjectStore.getState().installPersistence(queue);assert.deepEqual(await resolveWorkflowOutputBindings(workflow,[]),[{declarationId:"output-graph",artifactDocumentId:"custom-saved-output"}]);assert.equal(queue.captureBarrier(),0);malformed=true;await assert.rejects(resolveWorkflowOutputBindings(workflow,[]),/workflow.*state.*invalid/);malformed=false;switchOwner=true;await assert.rejects(resolveWorkflowOutputBindings(workflow,[]),/Project changed/);switchOwner=false;
 const legacy=[{id:"legacy",workflowId:workflow.id,workflowRevision:1,outputBindings:[{declarationId:"output-graph",artifactDocumentId:"legacy-output"}]}] as WorkflowRun[];assert.equal((await resolveWorkflowOutputBindings(workflow,legacy))[0].artifactDocumentId,"legacy-output");assert.equal((await resolveWorkflowOutputBindings(workflow,[]))[0].artifactDocumentId,"workflow-output-graph");await queue.close();console.log("workflow run state: saved output identity, metadata-only reads, malformed response and owner fencing passed");}finally{useProjectStore.getState().installPersistence(null);clearMocks();delete (globalThis as any).window;}
