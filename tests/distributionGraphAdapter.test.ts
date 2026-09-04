import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  DISTRIBUTION_GRAPH_ROLES,
  getDistributionGraphFrame,
  mapDistributionExternalDataState,
} from "../src/graphCore/distributionAdapter.ts";
import type { DistributionReportResponse } from "../src/types/distribution.ts";
import type { GraphDataFrame } from "../src/types/graphData.ts";

function frame(role: string): GraphDataFrame {
  return {
    requestId: role,
    datasetId: "dataset-1",
    generation: 4,
    sourceRows: 10,
    processedRows: 10,
    sampling: { mode: "full" },
    dictionaries: {},
    extents: {},
    rawChunks: [],
    aggregates: [],
    rawPointDisposition: { status: "included", validRows: 0, budget: 0 },
  };
}

const graphFrames = Object.fromEntries(
  DISTRIBUTION_GRAPH_ROLES.map((role) => [role, frame(role)]),
) as DistributionReportResponse["graphFrames"];

for (const role of DISTRIBUTION_GRAPH_ROLES) {
  assert.equal(getDistributionGraphFrame({ graphFrames }, role), graphFrames[role]);
  assert.equal(
    mapDistributionExternalDataState({ status: "success", result: { graphFrames } }, role).frame,
    graphFrames[role],
  );
}

const source = readFileSync(
  new URL("../src/graphCore/distributionAdapter.ts", import.meta.url),
  "utf8",
);
assert.doesNotMatch(source, /getGraphTheme|echarts|EChartsOption/);
assert.doesNotMatch(source, /buildDistribution(?:Chart|Overview|FitDensity)|buildProcessCapabilityChart/);
assert.doesNotMatch(source, /renderItem|series\s*:/);

console.log("distribution graph adapter OK");
