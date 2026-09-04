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
  reset: () => void;
}

const EMPTY_LINEAGE: ProjectLineageGraph = {
  id: "project-lineage",
  name: "Project lineage",
  nodes: [],
  edges: [],
};

export const useWorkflowStore = create<WorkflowStore>((set) => ({
  workflows: [],
  logicalFolders: [],
  workflowRuns: [],
  lineageGraph: EMPTY_LINEAGE,
  loadFromProject: (data) => set(data),
  reset: () => set({
    workflows: [],
    logicalFolders: [],
    workflowRuns: [],
    lineageGraph: EMPTY_LINEAGE,
  }),
}));