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

export const tableTransformService: TableTransformServiceClient = {
  createAndRun: (draft, lineageGraph) =>
    invoke<TableTransformCommandResult>("create_table_transform", {
      draft: {
        name: draft.name,
        outputName: draft.outputName,
        operation: draft.operation,
      },
      inputBindings: draft.inputBindings,
      lineageGraph,
    }),
  run: (definition, binding, lineageGraph) =>
    invoke<TableTransformCommandResult>("run_table_transform", {
      definition,
      binding,
      lineageGraph,
    }),
  rebindAndRun: (definition, binding, inputBindings, lineageGraph) =>
    invoke<TableTransformCommandResult>("rebind_table_transform", {
      definition,
      binding,
      inputBindings,
      lineageGraph,
    }),
};