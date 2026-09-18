import assert from "node:assert/strict";

import {
  createEmptyWorkspaceDocumentSelection,
  selectWorkspaceDocument,
  type WorkspaceDocumentSelection,
} from "@/components/analysis/analysisWorkspaceLifecycle";
import {
  resolveSelectionAfterDatasetDeletion,
  useWorkspaceSelectionStore,
} from "@/stores/useWorkspaceSelectionStore";

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

{
  const selectedGraphOnly: WorkspaceDocumentSelection = {
    activeDatasetId: null,
    activeTableTransformId: null,
    activeGraphBuilderId: "graph-deleting-dataset",
    activeReportId: null,
    activeAnalysisId: null,
    activeTabulateId: null,
  };

  const cleared = resolveSelectionAfterDatasetDeletion({
    selection: selectedGraphOnly,
    deletedDatasetId: "dataset-1",
    graphItems: [{ id: "graph-deleting-dataset", sourceDatasetId: "dataset-1" }],
    retainedActiveAnalysisId: null,
  });

  assert.deepEqual(cleared, createEmptyWorkspaceDocumentSelection());

  const preserved = resolveSelectionAfterDatasetDeletion({
    selection: selectedGraphOnly,
    deletedDatasetId: "dataset-1",
    graphItems: [{ id: "graph-deleting-dataset", sourceDatasetId: "dataset-2" }],
    retainedActiveAnalysisId: null,
  });

  assert.deepEqual(preserved, selectedGraphOnly);

  const retainedAnalysis = resolveSelectionAfterDatasetDeletion({
    selection: selectWorkspaceDocument("analysis", "analysis-a"),
    deletedDatasetId: "dataset-1",
    graphItems: [],
    retainedActiveAnalysisId: "analysis-a",
  });

  assert.deepEqual(retainedAnalysis, selectWorkspaceDocument("analysis", "analysis-a"));
}

console.log("workspace selection store tests passed");