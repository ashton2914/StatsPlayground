import assert from "node:assert/strict";

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
assert.deepEqual(analysis.definition.responses, [{ name: "DIM1", type: "continuous" }]);
assert.equal("markdown" in analysis, false);
assert.equal("reportBlocks" in analysis, false);
assert.equal("graphFrames" in analysis, false);

console.log("Analysis document contract tests passed");