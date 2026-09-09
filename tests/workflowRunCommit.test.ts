import assert from "node:assert/strict";

import { applyWorkflowRunCommit } from "../src/components/workflow/workflowRunCommit.ts";
import { useAnalysisStore } from "../src/stores/useAnalysisStore.ts";
import { useGraphBuilderStore } from "../src/stores/useGraphBuilderStore.ts";
import { useReportStore } from "../src/stores/useReportStore.ts";
import { useTabulateStore } from "../src/stores/useTabulateStore.ts";
import { useWorkflowStore } from "../src/stores/useWorkflowStore.ts";
import type { WorkflowRunCommitPacket } from "../src/types/workflow.ts";

const timestamp = "2026-09-08T12:00:00.000Z";

function packet(reportDependencyIds = ["stable-graph"]): WorkflowRunCommitPacket {
  return {
    commitId: "run-1",
    documents: [
      {
        kind: "graph",
        id: "stable-graph",
        name: "Workflow graph",
        sourceTableId: "stable-table-c",
        document: {
          id: "stable-graph",
          name: "Workflow graph",
          sourceDatasetId: "stable-table-c",
          mode: "2d",
          modeStates: {
            twoD: { encoding: {}, multiX: [], multiY: [], elements: [], smootherLambda: 0.5 },
            threeD: { encoding: {}, elements: [], smootherLambda: 0.5 },
            multivariate: { columns: [], chartType: "correlationMatrix", correlationMethod: "pearson" },
          },
          createdAt: timestamp,
        },
        validationResultHash: "graph-hash",
      },
      {
        kind: "report",
        id: "stable-report",
        name: "Workflow report",
        markdown: `{{sp-embed kind="graph" id="${reportDependencyIds[0]}"}}`,
        dependencyIds: reportDependencyIds.map((documentId) => ({ kind: "graph", documentId })),
        validationResultHash: "report-hash",
      },
    ],
    run: {
      id: "run-1",
      workflowId: "workflow-1",
      workflowRevision: 1,
      status: "succeeded",
      inputBindings: [{ slotId: "input-1", tableDocumentId: "source-table" }],
      nodeResults: [],
      outputBindings: [
        { declarationId: "graph-output", artifactDocumentId: "stable-graph" },
        { declarationId: "report-output", artifactDocumentId: "stable-report" },
      ],
      errors: [],
    },
  };
}

function resetStores() {
  useGraphBuilderStore.setState({ items: [], counter: 0 });
  useAnalysisStore.setState({ items: [], counter: 0 });
  useTabulateStore.setState({ items: [], counter: 0 });
  useReportStore.setState({ items: [], counter: 0 });
  useWorkflowStore.setState({ workflowRuns: [] });
}

resetStores();
let refreshCount = 0;
let dirtyCount = 0;
await applyWorkflowRunCommit(packet(), {
  datasetIds: ["source-table", "stable-table-c"],
  refreshDatasets: async () => { refreshCount += 1; },
  markDirty: () => { dirtyCount += 1; },
});

assert.equal(useGraphBuilderStore.getState().items[0]?.id, "stable-graph");
assert.equal(useReportStore.getState().items[0]?.id, "stable-report");
assert.equal(useWorkflowStore.getState().workflowRuns.length, 1);
assert.equal(refreshCount, 1);
assert.equal(dirtyCount, 1);

await applyWorkflowRunCommit(packet(), {
  datasetIds: ["source-table", "stable-table-c"],
  refreshDatasets: async () => { refreshCount += 1; },
  markDirty: () => { dirtyCount += 1; },
});
assert.equal(useWorkflowStore.getState().workflowRuns.length, 1);
assert.equal(refreshCount, 1);
assert.equal(dirtyCount, 1);

resetStores();
await assert.rejects(
  applyWorkflowRunCommit(packet(["missing-graph"]), {
    datasetIds: ["source-table", "stable-table-c"],
    refreshDatasets: async () => { refreshCount += 1; },
    markDirty: () => { dirtyCount += 1; },
  }),
  /unresolved Report dependency graph:missing-graph/,
);
assert.deepEqual(useGraphBuilderStore.getState().items, []);
assert.deepEqual(useReportStore.getState().items, []);
assert.deepEqual(useWorkflowStore.getState().workflowRuns, []);

resetStores();
const failedPacket: WorkflowRunCommitPacket = {
  commitId: "run-failed",
  documents: [],
  run: {
    id: "run-failed",
    workflowId: "workflow-1",
    workflowRevision: 1,
    status: "failed",
    inputBindings: [],
    nodeResults: [],
    outputBindings: [],
    errors: [{ code: "workflowExecutionFailed", message: "Downstream analysis failed" }],
  },
};
await assert.rejects(
  applyWorkflowRunCommit(failedPacket, {
    datasetIds: [],
    refreshDatasets: async () => { refreshCount += 1; },
    markDirty: () => { dirtyCount += 1; },
  }),
  /Downstream analysis failed/,
);
assert.equal(useWorkflowStore.getState().workflowRuns[0]?.status, "failed");
assert.deepEqual(useGraphBuilderStore.getState().items, []);
assert.deepEqual(useReportStore.getState().items, []);

console.log("workflow run commit coordinator OK");