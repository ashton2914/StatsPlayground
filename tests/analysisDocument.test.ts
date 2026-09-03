import assert from "node:assert/strict";

import { DISTRIBUTION_GRAPH_ELEMENT_IDS } from "../src/types/graphData.ts";
import { createAnalysisSampleDocument } from "../src/components/analysis/analysisSample.ts";

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
  specLimits: {},
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
assert.equal("reportBlocks" in analysis, false);
assert.equal("graphFrames" in analysis, false);

console.log("Analysis document contract tests passed");