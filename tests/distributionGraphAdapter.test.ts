import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  DISTRIBUTION_GRAPH_ROLES,
  filterDistributionFitCurvePackets,
  getDistributionCompositeGraphFrame,
  getDistributionFitSelectionKey,
  getDistributionGraphFrame,
  getDistributionGroupName,
  getDistributionResponseCompositeGraphFrame,
  getProcessCapabilityGraphFrame,
  mapDistributionCompositeExternalDataState,
  mapDistributionExternalDataState,
} from "../src/graphCore/distributionAdapter.ts";
import type {
  DistributionGroupResult,
  DistributionReportResponse,
  ProcessCapabilityDataV1,
} from "../src/types/distribution.ts";
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
const overallGroup: DistributionGroupResult = {
  groupKey: [],
  groupNames: [],
  yResults: [],
};
const siteAGroup: DistributionGroupResult = {
  groupKey: [{ kind: "text", value: "A" }],
  groupNames: ["Site"],
  yResults: [],
};
const siteBGroup: DistributionGroupResult = {
  groupKey: [{ kind: "text", value: "B" }],
  groupNames: ["Site"],
  yResults: [],
};
graphFrames.overview.aggregates = [{
  kind: "histogram",
  yColumn: "__sp_y",
  sourceColumn: "responseColumn",
  binCount: 1,
  missingCount: 0,
  binWidth: 1,
  totalCount: 1,
  bins: [{
    group: "DIM1",
    category: "Overall",
    sourceColumn: "DIM1",
    binStart: 0,
    binEnd: 1,
    count: 1,
  }],
}, {
  kind: "precomputedCurve",
  elementId: "distribution.overview.fittedCurves",
  seriesName: "DIM1 - Normal",
  group: "DIM1",
  category: "Overall",
  sourceColumn: "DIM1",
  interpolation: "linear",
  points: [{ x: 0, y: 0.1 }, { x: 1, y: 1 }],
}, {
  kind: "histogram",
  yColumn: "__sp_y",
  sourceColumn: "responseColumn",
  binCount: 1,
  missingCount: 0,
  binWidth: 1,
  totalCount: 1,
  bins: [{
    group: "DIM2 | Site=A",
    category: "Site=A",
    sourceColumn: "DIM2",
    binStart: 1,
    binEnd: 2,
    count: 1,
  }],
}, {
  kind: "precomputedCurve",
  elementId: "distribution.overview.fittedCurves",
  seriesName: "DIM2 | Site=A - Normal",
  group: "DIM2 | Site=A",
  category: "Site=A",
  sourceColumn: "DIM2",
  interpolation: "linear",
  points: [{ x: 1, y: 0.1 }, { x: 2, y: 1 }],
}];
graphFrames.boxPlot.aggregates = [{
  kind: "boxPlot",
  yColumn: "__sp_y",
  sourceColumn: "responseColumn",
  entries: [{
    group: "DIM1",
    category: "Overall",
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
  }, {
    group: "DIM2 | Site=A",
    category: "Site=A",
    sourceColumn: "DIM2",
    count: 1,
    min: 1,
    q1: 1.2,
    median: 1.5,
    q3: 1.8,
    max: 2,
    whiskerLow: 1,
    whiskerHigh: 2,
    outliers: [],
  }],
}];

const originalGraphFrames = structuredClone(graphFrames);

const multiFitGraphFrames = structuredClone(graphFrames);
multiFitGraphFrames.overview.aggregates.splice(2, 0, {
  kind: "precomputedCurve",
  elementId: "distribution.overview.fittedCurves",
  seriesId: "DIM1:fit:cauchy",
  seriesName: "DIM1 - Cauchy",
  group: "DIM1",
  category: "Overall",
  sourceColumn: "DIM1",
  interpolation: "linear",
  points: [{ x: 0, y: 0.2 }, { x: 1, y: 0.8 }],
});

const duplicateNameGraphFrames = structuredClone(graphFrames);
duplicateNameGraphFrames.overview.aggregates = [{
  kind: "histogram",
  yColumn: "__sp_y",
  sourceColumn: "responseColumn",
  binCount: 2,
  missingCount: 0,
  binWidth: 1,
  totalCount: 2,
  bins: [{
    group: "Length",
    category: "Overall",
    sourceColumn: "col-a",
    binStart: 0,
    binEnd: 1,
    count: 1,
  }, {
    group: "Length",
    category: "Overall",
    sourceColumn: "col-b",
    binStart: 10,
    binEnd: 11,
    count: 1,
  }],
}, {
  kind: "precomputedCurve",
  elementId: "distribution.overview.fittedCurves",
  seriesName: "Length - Normal",
  group: "Length",
  category: "Overall",
  sourceColumn: "col-a",
  interpolation: "linear",
  points: [{ x: 0, y: 0.1 }, { x: 1, y: 1 }],
}, {
  kind: "precomputedCurve",
  elementId: "distribution.overview.fittedCurves",
  seriesName: "Length - Normal",
  group: "Length",
  category: "Overall",
  sourceColumn: "col-b",
  interpolation: "linear",
  points: [{ x: 10, y: 0.1 }, { x: 11, y: 1 }],
}];
duplicateNameGraphFrames.boxPlot.aggregates = [{
  kind: "boxPlot",
  yColumn: "__sp_y",
  sourceColumn: "responseColumn",
  entries: [{
    group: "Length",
    category: "Overall",
    sourceColumn: "col-a",
    count: 1,
    min: 0,
    q1: 0.2,
    median: 0.5,
    q3: 0.8,
    max: 1,
    whiskerLow: 0,
    whiskerHigh: 1,
    outliers: [{ value: 1.5, sourceColumn: "col-a" }],
  }, {
    group: "Length",
    category: "Overall",
    sourceColumn: "col-b",
    count: 1,
    min: 10,
    q1: 10.2,
    median: 10.5,
    q3: 10.8,
    max: 11,
    whiskerLow: 10,
    whiskerHigh: 11,
    outliers: [{ value: 11.5, sourceColumn: "col-b" }],
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
assert.deepEqual(compositeFrame.aggregates.map((packet) => packet.kind), [
  "histogram",
  "precomputedCurve",
  "histogram",
  "precomputedCurve",
  "boxPlot",
]);
const compositeHistograms = compositeFrame.aggregates.filter((packet) => packet.kind === "histogram");
const compositeCurves = compositeFrame.aggregates.filter((packet) => packet.kind === "precomputedCurve");
const compositeBoxPlots = compositeFrame.aggregates.filter((packet) => packet.kind === "boxPlot");
assert.deepEqual(compositeHistograms.map((packet) => [packet.sourceColumn, packet.bins[0]?.category, packet.bins[0]?.group]), [
  ["__sp_variable__", "DIM1", undefined],
  ["__sp_variable__", "DIM2 | Site=A", undefined],
]);
assert.deepEqual(compositeCurves.map((packet) => [packet.sourceColumn, packet.category, packet.group, packet.seriesName]), [
  ["DIM1", "Overall", "DIM1", "DIM1 - Normal"],
  ["DIM2", "Site=A", "DIM2 | Site=A", "DIM2 | Site=A - Normal"],
]);
assert.deepEqual(compositeBoxPlots.map((packet) => [packet.sourceColumn, packet.entries.map((entry) => entry.category), packet.entries.map((entry) => entry.group)]), [
  ["__sp_variable__", ["DIM1", "DIM2 | Site=A"], [undefined, undefined]],
]);
assert.deepEqual(
  mapDistributionCompositeExternalDataState({ status: "success", result: { graphFrames } }),
  { status: "ready", frame: compositeFrame, error: null },
);

assert.equal(getDistributionGroupName(overallGroup), "Overall");
assert.equal(getDistributionGroupName(siteAGroup), "Site=A");

const selectedFrame = getDistributionResponseCompositeGraphFrame({ graphFrames }, "DIM2", siteAGroup);
assert.equal(selectedFrame.aggregates.length, 3);
assert.deepEqual(selectedFrame.aggregates.map((packet) => packet.kind), ["histogram", "precomputedCurve", "boxPlot"]);

const selectedHistogram = selectedFrame.aggregates.find((packet) => packet.kind === "histogram");
const selectedCurve = selectedFrame.aggregates.find((packet) => packet.kind === "precomputedCurve");
const selectedBoxPlot = selectedFrame.aggregates.find((packet) => packet.kind === "boxPlot");

assert.equal(selectedHistogram?.sourceColumn, "__sp_variable__");
assert.equal(selectedBoxPlot?.sourceColumn, "__sp_variable__");
assert.deepEqual(selectedHistogram?.bins.map((bin) => [bin.sourceColumn, bin.category, bin.group]), [
  ["DIM2", "DIM2 | Site=A", undefined],
]);
assert.deepEqual(selectedBoxPlot?.entries.map((entry) => [entry.sourceColumn, entry.category, entry.group]), [
  ["DIM2", "DIM2 | Site=A", undefined],
]);
assert.equal(selectedCurve?.sourceColumn, "DIM2");
assert.deepEqual(selectedCurve && [selectedCurve.group, selectedCurve.category, selectedCurve.seriesName], [
  "DIM2 | Site=A",
  "Site=A",
  "DIM2 | Site=A - Normal",
]);

const missingFrame = getDistributionResponseCompositeGraphFrame({ graphFrames }, "DIM2", siteBGroup);
assert.equal(missingFrame.aggregates.length, 0);

const selectedCauchyFrame = getDistributionResponseCompositeGraphFrame(
  { graphFrames: multiFitGraphFrames },
  "DIM1",
  overallGroup,
  { selectedDistributionId: "cauchy" } as never,
);
assert.deepEqual(
  selectedCauchyFrame.aggregates
    .filter((packet) => packet.kind === "precomputedCurve")
    .map((packet) => packet.seriesName),
  ["DIM1 - Cauchy"],
);

const legacyViewCauchyFrame = filterDistributionFitCurvePackets(
  multiFitGraphFrames.overview,
  {
    [getDistributionFitSelectionKey("DIM1", "DIM1")]: "cauchy",
  },
);
assert.deepEqual(
  legacyViewCauchyFrame.aggregates
    .filter((packet) => packet.kind === "precomputedCurve")
    .map((packet) => packet.seriesName),
  ["DIM1 - Cauchy", "DIM2 | Site=A - Normal"],
  "legacy DistributionView filtering must only change the selected response curve",
);

const legacyGraphFrames = structuredClone(graphFrames);
legacyGraphFrames.overview.aggregates = [{
  kind: "histogram",
  yColumn: "__sp_y",
  sourceColumn: "responseColumn",
  binCount: 1,
  missingCount: 0,
  binWidth: 1,
  totalCount: 1,
  bins: [{
    binStart: 0,
    binEnd: 1,
    count: 1,
  }],
}, {
  kind: "precomputedCurve",
  elementId: "distribution.overview.fittedCurves",
  seriesName: "DIM1 - Normal",
  interpolation: "linear",
  points: [{ x: 0, y: 0.1 }, { x: 1, y: 1 }],
}];
legacyGraphFrames.boxPlot.aggregates = [{
  kind: "boxPlot",
  yColumn: "__sp_y",
  sourceColumn: "responseColumn",
  entries: [{
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

const legacyOverallFrame = getDistributionResponseCompositeGraphFrame(
  { graphFrames: legacyGraphFrames },
  "DIM1",
  overallGroup,
  { allowLegacyOverallFallback: true },
);
assert.deepEqual(legacyOverallFrame.aggregates.map((packet) => packet.kind), ["histogram", "precomputedCurve", "boxPlot"]);

const selectedLegacyNormalFrame = getDistributionResponseCompositeGraphFrame(
  { graphFrames: legacyGraphFrames },
  "DIM1",
  overallGroup,
  { allowLegacyOverallFallback: true, selectedDistributionId: "normal" },
);
assert.deepEqual(
  selectedLegacyNormalFrame.aggregates.map((packet) => packet.kind),
  ["histogram", "precomputedCurve", "boxPlot"],
  "selected Normal must preserve a legacy curve packet without a series ID",
);

const selectedLegacyCauchyFrame = getDistributionResponseCompositeGraphFrame(
  { graphFrames: legacyGraphFrames },
  "DIM1",
  overallGroup,
  { allowLegacyOverallFallback: true, selectedDistributionId: "cauchy" },
);
assert.deepEqual(
  selectedLegacyCauchyFrame.aggregates.map((packet) => packet.kind),
  ["histogram", "boxPlot"],
  "a legacy Normal curve must not render for another selected model",
);

const legacyNonMatchingResponseFrame = getDistributionResponseCompositeGraphFrame(
  { graphFrames: legacyGraphFrames },
  "DIM2",
  overallGroup,
  { allowLegacyOverallFallback: false },
);
assert.equal(legacyNonMatchingResponseFrame.aggregates.length, 0);

const duplicateNameAFrame = getDistributionResponseCompositeGraphFrame(
  { graphFrames: duplicateNameGraphFrames },
  { sourceColumn: "col-a", seriesName: "Length" },
  overallGroup,
);
const duplicateNameBFrame = getDistributionResponseCompositeGraphFrame(
  { graphFrames: duplicateNameGraphFrames },
  { sourceColumn: "col-b", seriesName: "Length" },
  overallGroup,
);
for (const [sourceColumn, selected] of [["col-a", duplicateNameAFrame], ["col-b", duplicateNameBFrame]] as const) {
  assert.equal(selected.aggregates.length, 3);
  const selectedHistogram = selected.aggregates.find((packet) => packet.kind === "histogram");
  const selectedCurve = selected.aggregates.find((packet) => packet.kind === "precomputedCurve");
  const selectedBoxPlot = selected.aggregates.find((packet) => packet.kind === "boxPlot");

  assert.deepEqual(selectedHistogram?.bins.map((bin) => [bin.sourceColumn, bin.category, bin.group]), [
    [sourceColumn, "Length", undefined],
  ]);
  assert.deepEqual(selectedBoxPlot?.entries.map((entry) => [entry.sourceColumn, entry.category, entry.group]), [
    [sourceColumn, "Length", undefined],
  ]);
  assert.equal(selectedCurve?.sourceColumn, sourceColumn);
  assert.deepEqual(selectedCurve && [selectedCurve.group, selectedCurve.category, selectedCurve.seriesName], [
    "Length",
    "Overall",
    "Length - Normal",
  ]);
}

assert.deepEqual(graphFrames, originalGraphFrames);

const capabilityData = {
  processSummary: {
    n: 4,
  },
  chartData: {
    bins: [
      { lower: 0, upper: 2, count: 1, probability: 0.25, density: 0.125, belowCount: 0, aboveCount: 0 },
      { lower: 2, upper: 4, count: 3, probability: 0.75, density: 0.375, belowCount: 0, aboveCount: 0 },
    ],
    specificationLines: { lsl: 0.5, target: 2, usl: 3.5, source: "columnProperty" },
    overallDensity: {
      state: "available",
      reasonCode: null,
      coordinates: [{ x: 0, y: 0.1 }, { x: 4, y: 0.2 }],
    },
    withinDensity: {
      state: "available",
      reasonCode: null,
      coordinates: [{ x: 0, y: 0.15 }, { x: 4, y: 0.25 }],
    },
    provenance: {
      capabilityMethod: "capability.normal.individuals",
      normalDensityMethod: "normal.pdf.closedForm.v1",
      computationId: "capability-computation-1",
      specFingerprint: "spec:sha256:test",
    },
  },
} as ProcessCapabilityDataV1;

const capabilityFrame = getProcessCapabilityGraphFrame(
  capabilityData,
  { datasetId: "dataset-1", generation: 4, responseColumn: "DIM1" },
);
assert.equal(capabilityFrame.requestId, "capability-computation-1:process-capability");
assert.equal(capabilityFrame.sourceRows, 4);
assert.equal(capabilityFrame.processedRows, 4);
assert.deepEqual(capabilityFrame.aggregates.map((packet) => packet.kind), [
  "histogram",
  "precomputedCurve",
  "precomputedCurve",
]);
const capabilityHistogram = capabilityFrame.aggregates.find((packet) => packet.kind === "histogram");
const capabilityCurves = capabilityFrame.aggregates.filter((packet) => packet.kind === "precomputedCurve");
assert.deepEqual(capabilityHistogram && {
  binPolicy: capabilityHistogram.binPolicy,
  sourceColumn: capabilityHistogram.sourceColumn,
  yColumn: capabilityHistogram.yColumn,
  binCount: capabilityHistogram.binCount,
  binWidth: capabilityHistogram.binWidth,
  totalCount: capabilityHistogram.totalCount,
  bins: capabilityHistogram.bins,
}, {
  binPolicy: "preserve",
  sourceColumn: "DIM1",
  yColumn: "Count",
  binCount: 2,
  binWidth: 2,
  totalCount: 4,
  bins: [
    { sourceColumn: "DIM1", binStart: 0, binEnd: 2, count: 1 },
    { sourceColumn: "DIM1", binStart: 2, binEnd: 4, count: 3 },
  ],
});
assert.deepEqual(capabilityCurves.map((packet) => ({
  seriesId: packet.seriesId,
  seriesName: packet.seriesName,
  sourceColumn: packet.sourceColumn,
  points: packet.points,
})), [
  {
    seriesId: "capability-computation-1:overall",
    seriesName: "Overall Normal",
    sourceColumn: "DIM1",
    points: [{ x: 0, y: 0.8 }, { x: 4, y: 1.6 }],
  },
  {
    seriesId: "capability-computation-1:within",
    seriesName: "Within Normal",
    sourceColumn: "DIM1",
    points: [{ x: 0, y: 1.2 }, { x: 4, y: 2 }],
  },
]);

const source = readFileSync(
  new URL("../src/graphCore/distributionAdapter.ts", import.meta.url),
  "utf8",
);
assert.doesNotMatch(source, /getGraphTheme|echarts|EChartsOption/);
assert.doesNotMatch(source, /buildDistribution(?:Chart|Overview|FitDensity)|buildProcessCapabilityChart/);
assert.doesNotMatch(source, /renderItem|series\s*:/);

console.log("distribution graph adapter OK");
