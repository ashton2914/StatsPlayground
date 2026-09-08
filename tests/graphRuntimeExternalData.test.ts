import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  selectGraphRuntimeDataState,
  type ExternalGraphDataState,
} from "../src/components/graphBuilder/useGraphDataPipeline.ts";
import type { GraphDataFrame } from "../src/types/graphData.ts";

const externalFrame = {
  requestId: "distribution-frame",
  datasetId: "dataset-1",
  generation: 4,
  sourceRows: 12,
  processedRows: 12,
  sampling: { mode: "full" },
  dictionaries: {},
  extents: {},
  rawChunks: [],
  aggregates: [],
  rawPointDisposition: { status: "empty", validRows: 0, budget: 8_000 },
} satisfies GraphDataFrame;

const internalState = {
  frame: { ...externalFrame, requestId: "internal-frame" },
  status: "error" as const,
  error: "internal failure",
  progress: { processedRows: 3, sourceRows: 12, percent: 25 },
};

const ready: ExternalGraphDataState = {
  status: "ready",
  frame: externalFrame,
  error: null,
};
assert.deepEqual(selectGraphRuntimeDataState(internalState, ready), {
  frame: externalFrame,
  status: "ready",
  error: null,
  progress: null,
});

const loading: ExternalGraphDataState = {
  status: "loading",
  frame: null,
  error: null,
};
assert.deepEqual(selectGraphRuntimeDataState(internalState, loading), {
  frame: null,
  status: "pending",
  error: null,
  progress: null,
});

const failed: ExternalGraphDataState = {
  status: "error",
  frame: null,
  error: "distribution failed",
};
assert.deepEqual(selectGraphRuntimeDataState(internalState, failed), {
  frame: null,
  status: "error",
  error: "distribution failed",
  progress: null,
});

assert.equal(selectGraphRuntimeDataState(internalState, undefined), internalState);

const runtimeSource = readFileSync(
  resolve(process.cwd(), "src/components/graphBuilder/GraphRuntime.tsx"),
  "utf8",
);
assert.match(
  runtimeSource,
  /useGraphDataPipeline\(item, dataset, viewport, externalDataState === undefined\)/,
  "GraphRuntime must always call the pipeline hook and disable it for external data",
);
assert.match(
  runtimeSource,
  /onAxisRangeChange=\{item\.mode[\s\S]*onAxisRangeChange\(screenAxis\(axis\), min, max\)/,
  "external frame support must preserve axis range callbacks",
);

const pipelineSource = readFileSync(
  resolve(process.cwd(), "src/components/graphBuilder/useGraphDataPipeline.ts"),
  "utf8",
);
const disabledGuardIndex = pipelineSource.indexOf("if (!enabled || !requestSkeleton)");
const serviceImportIndex = pipelineSource.indexOf('import("../../services/dataService")');
assert.ok(disabledGuardIndex >= 0, "disabled pipelines must have an explicit idle guard");
assert.ok(
  disabledGuardIndex < serviceImportIndex,
  "disabled pipelines must stop before graph request services are imported",
);

console.log("graphRuntime external data contract tests passed");