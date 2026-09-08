import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type {
  DistributionReportResponse,
  DistributionRequest,
} from "../src/types/distribution.ts";

const request: DistributionRequest = {
  datasetId: "dataset-1",
  generation: 7,
  responseColumns: ["value"],
  weightColumn: "weight",
  freqColumn: null,
  byColumns: ["batch", "site"],
  confidenceLevel: 0.95,
  specLimits: {
    value: { lsl: 0, target: 5, usl: 10 },
  },
  fitDistributions: ["normal", "gamma"],
};

const graphFrame = {
  requestId: "distribution:overview",
  datasetId: request.datasetId,
  generation: request.generation,
  sourceRows: 3,
  processedRows: 3,
  sampling: { mode: "full" as const },
  dictionaries: {},
  extents: {},
  rawChunks: [],
  aggregates: [],
  rawPointDisposition: { status: "empty" as const, validRows: 0 as const, budget: 8_000 },
};
const response: DistributionReportResponse = {
  datasetId: request.datasetId,
  generation: request.generation,
  groups: [],
  reportBlocks: [{
    schemaVersion: "1",
    blockId: "value-overall-summary",
    kind: "summary",
    titleKey: "distribution.report.summary",
    status: "unavailable",
    reasonCode: "distribution.summary.noObservations",
    chartData: null,
  }],
  graphFrames: {
    overview: graphFrame,
    boxPlot: { ...graphFrame, requestId: "distribution:boxPlot" },
    ecdf: { ...graphFrame, requestId: "distribution:ecdf" },
    normalQuantile: { ...graphFrame, requestId: "distribution:normalQuantile" },
  },
};

assert.deepEqual(Object.keys(request), [
  "datasetId",
  "generation",
  "responseColumns",
  "weightColumn",
  "freqColumn",
  "byColumns",
  "confidenceLevel",
  "specLimits",
  "fitDistributions",
]);
assert.equal(response.datasetId, request.datasetId);
assert.equal(response.generation, request.generation);
assert.deepEqual(Object.keys(response.graphFrames), [
  "overview",
  "boxPlot",
  "ecdf",
  "normalQuantile",
]);
function assertNoLifecycleFields(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(assertNoLifecycleFields);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    assert.equal(
      ["runId", "snapshotId", "cancelToken", "progress"].includes(key),
      false,
      `unexpected lifecycle field ${key}`,
    );
    assertNoLifecycleFields(child);
  }
}
assertNoLifecycleFields(request);
assertNoLifecycleFields(response);
assert.equal(response.reportBlocks[0].status, "unavailable");
assert.equal(response.reportBlocks[0].reasonCode, "distribution.summary.noObservations");

const invokeCalls: Array<{ command: string; args: unknown }> = [];
Object.assign(globalThis, {
  window: {
    __TAURI_INTERNALS__: {
      invoke: async (command: string, args: unknown = {}) => {
        invokeCalls.push({ command, args });
        if (command === "compute_distribution_report") return response;
        throw new Error(`unexpected command: ${command}`);
      },
    },
  },
});

const { distributionService } = await import("../src/services/distributionService.ts");
assert.deepEqual(await distributionService.compute(request), response);
assert.deepEqual(invokeCalls, [
  { command: "compute_distribution_report", args: { request } },
]);

const commandSource = readFileSync(
  resolve(process.cwd(), "src-tauri/src/commands/distribution_commands.rs"),
  "utf8",
);
const libSource = readFileSync(resolve(process.cwd(), "src-tauri/src/lib.rs"), "utf8");
for (const source of [commandSource, libSource]) {
  assert.equal(source.includes("start_distribution_run"), false);
  assert.equal(source.includes("execute_distribution_run"), false);
  assert.equal(source.includes("cancel_distribution_run"), false);
}
assert.match(commandSource, /pub async fn compute_distribution_report/);
assert.match(libSource, /commands::distribution_commands::compute_distribution_report/);

console.log("distribution one-shot run contract OK");