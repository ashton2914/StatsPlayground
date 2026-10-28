import {useProjectStore} from "../stores/useProjectStore";
import {projectService} from "../services/projectService";
import type {WorkflowDefinition,WorkflowRun,WorkflowOutputBinding} from "../types/workflow";

export async function readNativeWorkflowRunState(workflow:WorkflowDefinition) {
 const owner=useProjectStore.getState().persistence;
 if(owner) {
  const state=await projectService.getWorkflowRunState(owner.snapshot().epoch,workflow.id,workflow.revision);
  if(useProjectStore.getState().persistence!==owner)throw new Error("Project changed before workflow run");
  const hasLatest=typeof state.latestRunId==="string"&&state.latestRunId.length>0;
  if(state.workflowId!==workflow.id||state.workflowRevision!==workflow.revision
   ||!Number.isSafeInteger(state.committedRevision)||state.committedRevision<0
   ||!Number.isSafeInteger(state.totalCount)||state.totalCount<0
   ||(state.latestRunId!==null&&!hasLatest)
   ||(hasLatest?!Array.isArray(state.latestOutputBindings):state.latestOutputBindings!==null))throw new Error("workflow_run_state_invalid");
  if(hasLatest) {
   if(state.totalCount<1)throw new Error("workflow_run_state_invalid");
   const seen=new Set<string>();
   for(const binding of state.latestOutputBindings!) {
    if(!binding||typeof binding.declarationId!=="string"||!binding.declarationId||typeof binding.artifactDocumentId!=="string"||!binding.artifactDocumentId||seen.has(binding.declarationId))throw new Error("workflow_run_state_invalid");
    seen.add(binding.declarationId);
   }
  }
  return state;
 }
 return null;
}

export async function resolveWorkflowOutputBindings(workflow:WorkflowDefinition,previousRuns:readonly WorkflowRun[]):Promise<WorkflowOutputBinding[]> {
 const state=await readNativeWorkflowRunState(workflow);
 const latest=state?state.latestOutputBindings??undefined:[...previousRuns].reverse().find(run=>run.workflowId===workflow.id&&run.workflowRevision===workflow.revision)?.outputBindings;
 return workflow.outputDeclarations.map(declaration=>({declarationId:declaration.id,artifactDocumentId:latest?.find(binding=>binding.declarationId===declaration.id)?.artifactDocumentId??`${workflow.id}-${declaration.id}`}));
}
