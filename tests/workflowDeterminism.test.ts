import assert from "node:assert/strict";

import { applyWorkflowRunCommit } from "../src/components/workflow/workflowRunCommit.ts";
import { useAnalysisStore } from "../src/stores/useAnalysisStore.ts";
import { useGraphBuilderStore } from "../src/stores/useGraphBuilderStore.ts";
import { useReportStore } from "../src/stores/useReportStore.ts";
import { useTabulateStore } from "../src/stores/useTabulateStore.ts";
import { useWorkflowStore } from "../src/stores/useWorkflowStore.ts";
import type { WorkflowRunCommitPacket } from "../src/types/workflow.ts";

const outputFingerprints = [{
  declarationId: "graph-output",
  artifactDocumentId: "stable-graph",
  contentHash: "deterministic-graph-hash",
}];

function succeededPacket(runId: string, baselineRunId?: string): WorkflowRunCommitPacket {
  return {
    commitId: runId,
    documents: [{
      kind: "graph",
      id: "stable-graph",
      name: "Deterministic graph",
      sourceTableId: "source-table",
      document: {
        id: "stable-graph",
        name: "Deterministic graph",
        sourceDatasetId: "source-table",
        mode: "2d",
        modeStates: {
          twoD: { encoding: {}, multiX: [], multiY: [], elements: [], smootherLambda: 0.5 },
          threeD: { encoding: {}, elements: [], smootherLambda: 0.5 },
          multivariate: { columns: [], chartType: "correlationMatrix", correlationMethod: "pearson" },
        },
        createdAt: runId,
      },
      validationResultHash: "deterministic-graph-hash",
    }],
    run: {
      id: runId,
      workflowId: "workflow-deterministic",
      workflowRevision: 1,
      status: "succeeded",
      inputBindings: [{ slotId: "source", tableDocumentId: "source-table" }],
      nodeResults: [],
      outputBindings: [{ declarationId: "graph-output", artifactDocumentId: "stable-graph" }],
      errors: [],
      seed: 42,
      engineVersion: "0.1.0",
      configurationHash: "configuration-hash",
      inputFingerprints: [{
        slotId: "source",
        tableDocumentId: "source-table",
        generation: 0,
        schemaFingerprint: "schema-hash",
        contentHash: "input-hash",
      }],
      outputFingerprints,
      determinismBaselineRunId: baselineRunId,
    },
  };
}

useGraphBuilderStore.setState({ items: [], counter: 0 });
useAnalysisStore.setState({ items: [], counter: 0 });
useTabulateStore.setState({ items: [], counter: 0 });
useReportStore.setState({ items: [], counter: 0 });
useWorkflowStore.setState({ workflowRuns: [] });

let refreshCount = 0;
let dirtyCount = 0;
const commitOptions = {
  datasetIds: ["source-table"],
  refreshDatasets: async () => { refreshCount += 1; },
  markDirty: () => { dirtyCount += 1; },
};

await applyWorkflowRunCommit(succeededPacket("run-1"), commitOptions);
await applyWorkflowRunCommit(succeededPacket("run-2", "run-1"), commitOptions);

assert.deepEqual(
  useGraphBuilderStore.getState().items.map((item) => item.id),
  ["stable-graph"],
);
assert.deepEqual(
  useWorkflowStore.getState().workflowRuns.map((run) => run.id),
  ["run-1", "run-2"],
);
assert.deepEqual(
  useWorkflowStore.getState().workflowRuns.map((run) => run.outputFingerprints),
  [outputFingerprints, outputFingerprints],
);
assert.equal(
  useWorkflowStore.getState().workflowRuns[1]?.determinismBaselineRunId,
  "run-1",
);
assert.equal(refreshCount, 2);
assert.equal(dirtyCount, 2);

const violation: WorkflowRunCommitPacket = {
  commitId: "run-3",
  documents: [],
  run: {
    ...succeededPacket("run-3", "run-1").run,
    status: "failed",
    outputFingerprints: [{ ...outputFingerprints[0], contentHash: "different-hash" }],
    errors: [{
      code: "determinismViolation",
      message: "Workflow output fingerprints differ from deterministic baseline run-1",
    }],
  },
};
await assert.rejects(
  applyWorkflowRunCommit(violation, commitOptions),
  /deterministic baseline run-1/,
);
assert.deepEqual(
  useGraphBuilderStore.getState().items.map((item) => item.id),
  ["stable-graph"],
);
assert.deepEqual(
  useWorkflowStore.getState().workflowRuns.map((run) => run.status),
  ["succeeded", "succeeded", "failed"],
);
assert.equal(refreshCount, 2);
assert.equal(dirtyCount, 3);

console.log("workflow determinism contract passed");
