import { createPersistedDocumentSetter, withoutDocumentPersistence } from "./documentStore";
import { useProjectStore } from "./useProjectStore";
import { assertProjectMutable } from "../utils/saveReadOnly";
import { create } from "zustand";
import type {
  LogicalFolder,
  ProjectLineageGraph,
  WorkflowDefinition,
  WorkflowRun,
} from "@/types/workflow";

interface WorkflowStore {
  workflows: WorkflowDefinition[];
  logicalFolders: LogicalFolder[];
  workflowRuns: WorkflowRun[];
  lineageGraph: ProjectLineageGraph;
  loadFromProject: (data: {
    workflows: WorkflowDefinition[];
    logicalFolders: LogicalFolder[];
    workflowRuns: WorkflowRun[];
    lineageGraph: ProjectLineageGraph;
  }) => void;
  addWorkflow: (workflow: WorkflowDefinition) => void;
  reset: () => void;
}

const EMPTY_LINEAGE: ProjectLineageGraph = {
  id: "project-lineage",
  name: "Project lineage",
  graphVersion: 0,
  graphHash: "",
  nodes: [],
  edges: [],
};

export const useWorkflowStore = create<WorkflowStore>((rawSet, get) => {
  const set = createPersistedDocumentSetter("workflow", rawSet, get, (state) => state.workflows);
  return ({
  workflows: [],
  logicalFolders: [],
  workflowRuns: [],
  lineageGraph: EMPTY_LINEAGE,
  loadFromProject: (data) => withoutDocumentPersistence(() => set(data)),
  addWorkflow: (workflow) => {
    assertProjectMutable(useProjectStore.getState().readOnly);
    set((state) => ({ workflows: [...state.workflows, workflow] }));
  },
  reset: () => withoutDocumentPersistence(() => set({
    workflows: [],
    logicalFolders: [],
    workflowRuns: [],
    lineageGraph: EMPTY_LINEAGE,
  })),
});
});
