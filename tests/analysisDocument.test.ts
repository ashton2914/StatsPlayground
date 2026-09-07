import assert from "node:assert/strict";

import { DISTRIBUTION_GRAPH_ELEMENT_IDS } from "../src/types/graphData.ts";
import { createAnalysisSampleDocument } from "../src/components/analysis/analysisSample.ts";
import { createDistributionGraphBuilderConfig } from "../src/components/analysis/distributionCompositeGraph.ts";
import { createEmbeddedGraphItem } from "../src/components/graphBuilder/graphBuilderMode.ts";
import { canExecuteGraphRequest, deriveGraphRequestParts } from "../src/components/graphBuilder/useGraphDataPipeline.ts";

const analysis = createAnalysisSampleDocument({
  datasetId: "dataset-112",
  analysisId: "analysis-112",
  analysisName: "DIM1 Analysis",
  createdAt: "2026-09-03T00:00:00.000Z",
});

assert.equal(analysis.documentType, "analysis");
assert.equal(analysis.analysisKind, "distribution");
assert.equal(analysis.source.datasetId, "dataset-112");
assert.equal(analysis.definition.kind, "distribution");
assert.deepEqual(analysis.definition.responses, [{ name: "DIM1", type: "continuous" }]);
assert.equal(analysis.definition.weight, null);
assert.equal(analysis.definition.frequency, null);
assert.deepEqual(analysis.definition.by, []);
assert.deepEqual(analysis.definition.analysis, {
  confidenceLevel: 0.95,
  specLimits: {
    DIM1: {
      lsl: 55,
      target: 100,
      usl: 145,
    },
  },
  fitDistributions: ["normal"],
});
assert.deepEqual(
  analysis.definition.graphs.overview.modeStates.twoD.elements,
  [
    { kind: "histogram", enabled: true, options: { elementId: DISTRIBUTION_GRAPH_ELEMENT_IDS.overviewHistogram } },
    { kind: "line", enabled: true, options: { elementId: DISTRIBUTION_GRAPH_ELEMENT_IDS.overviewFittedCurves } },
  ],
);
assert.deepEqual(
  analysis.definition.graphs.boxPlot.modeStates.twoD.elements,
  [
    { kind: "boxplot", enabled: true, options: { elementId: DISTRIBUTION_GRAPH_ELEMENT_IDS.boxPlot } },
  ],
);
assert.deepEqual(
  analysis.definition.graphs.ecdf.modeStates.twoD.elements,
  [
    { kind: "line", enabled: true, options: { elementId: DISTRIBUTION_GRAPH_ELEMENT_IDS.ecdf } },
  ],
);
assert.deepEqual(
  analysis.definition.graphs.normalQuantile.modeStates.twoD.elements,
  [
    { kind: "points", enabled: true, options: { elementId: DISTRIBUTION_GRAPH_ELEMENT_IDS.normalQuantilePoints } },
    { kind: "line", enabled: true, options: { elementId: DISTRIBUTION_GRAPH_ELEMENT_IDS.normalQuantileReference } },
    { kind: "line", enabled: true, options: { elementId: DISTRIBUTION_GRAPH_ELEMENT_IDS.normalQuantileLower } },
    { kind: "line", enabled: true, options: { elementId: DISTRIBUTION_GRAPH_ELEMENT_IDS.normalQuantileUpper } },
  ],
);
assert.equal("markdown" in analysis, false);

analysis.definition.graphs.boxPlot.modeStates.twoD.elements[0] = {
  kind: "boxplot",
  enabled: true,
  options: {
    elementId: DISTRIBUTION_GRAPH_ELEMENT_IDS.boxPlot,
    boxType: "range",
    outliers: false,
    fiveNumberSummary: true,
    widthProportion: 0.75,
  },
};
analysis.definition.graphs.overview.modeStates.twoD.xAxis = { min: 55, max: 145 };
analysis.definition.graphs.overview.modeStates.twoD.refLinesX = [{ x: 100, label: "Target" }];
analysis.definition.graphs.overview.modeStates.twoD.autoSpecLinesX = true;
const graphBuilderConfig = createDistributionGraphBuilderConfig(
  analysis.definition.graphs.overview,
  analysis.definition.graphs.boxPlot,
  analysis.definition.responses,
);
assert.deepEqual(graphBuilderConfig.modeStates.twoD.encoding, {});
assert.deepEqual(graphBuilderConfig.modeStates.twoD.multiY, [
  { name: "DIM1", type: "continuous" },
]);
assert.equal(graphBuilderConfig.modeStates.twoD.xAxis, undefined);
assert.deepEqual(graphBuilderConfig.modeStates.twoD.yAxis, { min: 55, max: 145 });
assert.equal(graphBuilderConfig.modeStates.twoD.refLinesX, undefined);
assert.deepEqual(graphBuilderConfig.modeStates.twoD.refLinesY, [{ y: 100, label: "Target" }]);
assert.equal(graphBuilderConfig.modeStates.twoD.autoSpecLinesX, undefined);
assert.equal(graphBuilderConfig.modeStates.twoD.autoSpecLinesY, true);
assert.deepEqual(graphBuilderConfig.modeStates.twoD.elements, [
  { kind: "histogram", enabled: true, options: {} },
  {
    kind: "normalCurve",
    enabled: true,
    options: {
      showSigmaBands: false,
      elementId: DISTRIBUTION_GRAPH_ELEMENT_IDS.overviewFittedCurves,
    },
  },
  {
  kind: "boxplot",
  enabled: true,
  options: {
    boxType: "range",
    outliers: false,
    fiveNumberSummary: true,
    widthProportion: 0.75,
  },
  },
]);
const singleResponseItem = createEmbeddedGraphItem({
  id: "analysis-graph:analysis-112:single-distributionComposite",
  name: "Distribution",
  sourceDatasetId: "dataset-112",
  config: graphBuilderConfig,
  createdAt: analysis.createdAt,
});
const singleResponseRequest = deriveGraphRequestParts(singleResponseItem);
assert.deepEqual(singleResponseRequest.fields, [{ role: "multiY0", column: "DIM1" }]);
assert.equal(canExecuteGraphRequest(singleResponseItem, singleResponseRequest.fields, singleResponseRequest.elements), true);
const multiResponseConfig = createDistributionGraphBuilderConfig(
  analysis.definition.graphs.overview,
  analysis.definition.graphs.boxPlot,
  [
    { name: "203-A1", type: "continuous" },
    { name: "203-A2", type: "continuous" },
    { name: "203-A3", type: "continuous" },
    { name: "203-A4", type: "continuous" },
  ],
);
assert.deepEqual(multiResponseConfig.modeStates.twoD.encoding, {});
assert.deepEqual(
  multiResponseConfig.modeStates.twoD.multiY.map((field) => field.name),
  ["203-A1", "203-A2", "203-A3", "203-A4"],
);
const graphBuilderItem = createEmbeddedGraphItem({
  id: "analysis-graph:analysis-112:distributionComposite",
  name: "Distribution",
  sourceDatasetId: "dataset-112",
  config: multiResponseConfig,
  createdAt: analysis.createdAt,
});
const requestParts = deriveGraphRequestParts(graphBuilderItem);
assert.deepEqual(
  requestParts.fields.map((field) => [field.role, field.column]),
  [
    ["multiY0", "203-A1"],
    ["multiY1", "203-A2"],
    ["multiY2", "203-A3"],
    ["multiY3", "203-A4"],
  ],
);
assert.deepEqual(requestParts.elements.map((element) => element.kind), ["histogram", "normalCurve", "boxplot"]);
assert.equal(canExecuteGraphRequest(graphBuilderItem, requestParts.fields, requestParts.elements), true);
assert.equal("reportBlocks" in analysis, false);
assert.equal("graphFrames" in analysis, false);

console.log("Analysis document contract tests passed");