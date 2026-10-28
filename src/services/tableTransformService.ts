import {useProjectStore} from "@/stores/useProjectStore";
import { invoke } from "@tauri-apps/api/core";

import type {
  TableTransformCommandResult,
  TableTransformDefinition,
  TableTransformDraft,
  TableTransformInputBinding,
  TableTransformProjectBinding,
} from "@/types/tableTransform";
import type { ProjectLineageGraph } from "@/types/workflow";

export interface TableTransformServiceClient {
  preflightCreateAndRun: (
    draft: TableTransformDraft,
    lineageGraph: ProjectLineageGraph,
  ) => Promise<void>;
  preflightRun: (
    definition: TableTransformDefinition,
    binding: TableTransformProjectBinding,
    lineageGraph: ProjectLineageGraph,
  ) => Promise<void>;
  createAndRun: (
    draft: TableTransformDraft,
    lineageGraph: ProjectLineageGraph,
  ) => Promise<TableTransformCommandResult>;
  run: (
    definition: TableTransformDefinition,
    binding: TableTransformProjectBinding,
    lineageGraph: ProjectLineageGraph,
  ) => Promise<TableTransformCommandResult>;
  rebindAndRun: (
    definition: TableTransformDefinition,
    binding: TableTransformProjectBinding,
    inputBindings: TableTransformInputBinding[],
    lineageGraph: ProjectLineageGraph,
  ) => Promise<TableTransformCommandResult>;
}

async function createTransform(args: Record<string,unknown>,inputs:TableTransformInputBinding[]):Promise<TableTransformCommandResult> {
  const persistence=useProjectStore.getState().persistence;
  if(!persistence) return invoke<TableTransformCommandResult>("create_table_transform",args);
  const datasetGenerations=await Promise.all([...new Set(inputs.map(input=>input.tableDocumentId))].map(async id=>({id,generation:await invoke<number>("get_dataset_generation",{datasetId:id})})));
  if(useProjectStore.getState().persistence!==persistence) throw new Error("Project changed before transform");
  return (await persistence.submit<TableTransformCommandResult>({command:"create_table_transform",payload:args,datasetGenerations})).value;
}

async function runTransform(command:"run_table_transform"|"rebind_table_transform",args:{definition:TableTransformDefinition;binding:TableTransformProjectBinding;inputBindings?:TableTransformInputBinding[];lineageGraph:ProjectLineageGraph}):Promise<TableTransformCommandResult> {
  const persistence=useProjectStore.getState().persistence;
  if(!persistence) return invoke<TableTransformCommandResult>(command,args);
  const {getProjectDirectorySummaries}=await import("@/projectPersistence/documentAdapters");
  const summary=getProjectDirectorySummaries(persistence.snapshot().epoch)?.find(item=>item.id===args.definition.id&&item.kind==="transform");
  if(!summary) throw new Error("project_document_metadata_required");
  const inputs=args.inputBindings??args.binding.inputs;
  const ids=[...new Set([...inputs.map(input=>input.tableDocumentId),args.definition.output.tableDocumentId])];
  const datasetGenerations=await Promise.all(ids.map(async id=>({id,generation:await invoke<number>("get_dataset_generation",{datasetId:id})})));
  if(useProjectStore.getState().persistence!==persistence) throw new Error("Project changed before transform");
  return (await persistence.submit<TableTransformCommandResult>({command,payload:args,datasetGenerations,documentRevisions:[{id:summary.id,revision:summary.revision}]})).value;
}

export const tableTransformService: TableTransformServiceClient = {
  preflightCreateAndRun: (draft, lineageGraph) =>
    invoke<void>("preflight_create_table_transform", {
      draft: {
        name: draft.name,
        outputName: draft.outputName,
        operation: draft.operation,
      },
      inputBindings: draft.inputBindings,
      lineageGraph,
    }),
  preflightRun: (definition, binding, lineageGraph) =>
    invoke<void>("preflight_run_table_transform", {
      definition,
      binding,
      lineageGraph,
    }),
  createAndRun: (draft, lineageGraph) =>
    createTransform({
      draft: {
        name: draft.name,
        outputName: draft.outputName,
        operation: draft.operation,
      },
      inputBindings: draft.inputBindings,
      lineageGraph,
    },draft.inputBindings),
  run: (definition, binding, lineageGraph) =>
    runTransform("run_table_transform", {
      definition,
      binding,
      lineageGraph,
    }),
  rebindAndRun: (definition, binding, inputBindings, lineageGraph) =>
    runTransform("rebind_table_transform", {
      definition,
      binding,
      inputBindings,
      lineageGraph,
    }),
};