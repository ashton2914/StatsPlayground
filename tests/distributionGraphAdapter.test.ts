import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  DISTRIBUTION_GRAPH_ROLES,
  getDistributionCompositeGraphFrame,
  getDistributionGraphFrame,
  mapDistributionCompositeExternalDataState,
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
graphFrames.overview.aggregates = [{
  kind: "histogram",
  yColumn: "__sp_y",
  sourceColumn: "responseColumn",
  binCount: 1,
  missingCount: 0,
  binWidth: 1,
  totalCount: 1,
  bins: [{
    group: "DIM1 | A",
    category: "A",
    sourceColumn: "DIM1",
    binStart: 0,
    binEnd: 1,
    count: 1,
  }],
}, {
  kind: "precomputedCurve",
  elementId: "distribution.overview.fittedCurves",
  seriesName: "DIM1 | A - Normal",
  group: "DIM1 | A",
  category: "DIM1 | A",
  sourceColumn: "DIM1",
  interpolation: "linear",
  points: [{ x: 0, y: 0.1 }, { x: 1, y: 1 }],
}];
graphFrames.boxPlot.aggregates = [{
  kind: "boxPlot",
  yColumn: "__sp_y",
  sourceColumn: "responseColumn",
  entries: [{
    group: "DIM1 | A",
    category: "A",
    sourceColumn: "DIM1",
    count: 1,
    min: 0,
    q1: 0.2,
    median: 0.5,
    q3: 0.8,
    max: 1,
    whiskerLow: 0,
    whiskerHigh: 1,
    outliers: [],
  }],
}];

for (const role of DISTRIBUTION_GRAPH_ROLES) {
  assert.equal(getDistributionGraphFrame({ graphFrames }, role), graphFrames[role]);
  assert.equal(
    mapDistributionExternalDataState({ status: "success", result: { graphFrames } }, role).frame,
    graphFrames[role],
  );
}

const compositeFrame = getDistributionCompositeGraphFrame({ graphFrames });
assert.deepEqual(compositeFrame.aggregates.map((packet) => packet.kind), ["histogram", "precomputedCurve", "boxPlot"]);
const compositeHistogram = compositeFrame.aggregates.find((packet) => packet.kind === "histogram");
const compositeBoxPlot = compositeFrame.aggregates.find((packet) => packet.kind === "boxPlot");
assert.equal(compositeHistogram?.sourceColumn, "__sp_variable__");
assert.deepEqual(compositeHistogram?.bins.map((bin) => [bin.category, bin.group, bin.sourceColumn]), [
  ["DIM1 | A", undefined, "DIM1"],
]);
assert.equal(compositeBoxPlot?.sourceColumn, "__sp_variable__");
assert.deepEqual(compositeBoxPlot?.entries.map((entry) => [entry.category, entry.group, entry.sourceColumn]), [
  ["DIM1 | A", undefined, "DIM1"],
]);
assert.deepEqual(
  mapDistributionCompositeExternalDataState({ status: "success", result: { graphFrames } }),
  { status: "ready", frame: compositeFrame, error: null },
);

const source = readFileSync(
  new URL("../src/graphCore/distributionAdapter.ts", import.meta.url),
  "utf8",
);
assert.doesNotMatch(source, /getGraphTheme|echarts|EChartsOption/);
assert.doesNotMatch(source, /buildDistribution(?:Chart|Overview|FitDensity)|buildProcessCapabilityChart/);
assert.doesNotMatch(source, /renderItem|series\s*:/);

console.log("distribution graph adapter OK");
