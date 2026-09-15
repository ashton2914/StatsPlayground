import assert from "node:assert/strict";

import {
  createEmptyWorkspaceDocumentSelection,
  selectWorkspaceDocument,
  type WorkspaceDocumentSelection,
} from "@/components/analysis/analysisWorkspaceLifecycle";
import { useWorkspaceSelectionStore } from "@/stores/useWorkspaceSelectionStore";

function reset() {
  useWorkspaceSelectionStore.getState().clear();
}

reset();

assert.deepEqual(
  useWorkspaceSelectionStore.getState().selection,
  createEmptyWorkspaceDocumentSelection(),
);

useWorkspaceSelectionStore.getState().activate("analysis", "analysis-1");
assert.deepEqual(
  useWorkspaceSelectionStore.getState().selection,
  selectWorkspaceDocument("analysis", "analysis-1"),
);

useWorkspaceSelectionStore.getState().activate("dataset", "dataset-1");
assert.deepEqual(
  useWorkspaceSelectionStore.getState().selection,
  selectWorkspaceDocument("dataset", "dataset-1"),
);

const custom: WorkspaceDocumentSelection = {
  activeDatasetId: null,
  activeTableTransformId: "table-1",
  activeGraphBuilderId: null,
  activeReportId: null,
  activeAnalysisId: null,
  activeTabulateId: null,
};
useWorkspaceSelectionStore.getState().load(custom);
assert.deepEqual(useWorkspaceSelectionStore.getState().selection, custom);

useWorkspaceSelectionStore.getState().clear();
assert.deepEqual(
  useWorkspaceSelectionStore.getState().selection,
  createEmptyWorkspaceDocumentSelection(),
);

console.log("workspace selection store tests passed");