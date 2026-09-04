import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { ANALYSIS_SAMPLE_COLUMN, createAnalysisSample, createAnalysisSampleDocument } from "../src/components/analysis/analysisSample.ts";

function readSource(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), "utf8").replace(/\r\n/g, "\n");
}

const sample = createAnalysisSample(112, 4);

assert.equal(ANALYSIS_SAMPLE_COLUMN, "DIM1");
assert.deepEqual(sample.rows, [
  [92.753273497302],
  [87.1053533128719],
  [93.13746378296673],
  [114.86774275162333],
]);
assert.deepEqual(sample.values, sample.rows.map(([value]) => value));

const analysis = createAnalysisSampleDocument({
  datasetId: "dataset-112",
  analysisId: "analysis-112",
  analysisName: "DIM1 Analysis",
  createdAt: "2026-09-03T00:00:00.000Z",
});

assert.equal(analysis.name, "DIM1 Analysis");
assert.equal(analysis.source.datasetId, "dataset-112");
assert.equal(analysis.definition.kind, "distribution");
assert.equal("markdown" in analysis, false);
assert.equal("reportBlocks" in analysis, false);
assert.equal("graphFrames" in analysis, false);
assert.equal("result" in analysis, false);

const source = readSource("src/components/analysis/analysisSample.ts");
assert.equal(source.includes("createAnalysisSampleDistribution"), false, "sample helper must not expose the legacy distribution factory");

console.log("analysis sample contract passed");import assert from "node:assert/strict";

import { createAnalysisSample } from "../src/components/analysis/analysisSample.ts";

const first = createAnalysisSample(112, 200);
const repeated = createAnalysisSample(112, 200);
const different = createAnalysisSample(113, 200);

assert.deepEqual(first, repeated, "the bundled sample must be reproducible for a saved analysis");
assert.notDeepEqual(first.values, different.values, "different seeds must produce different random samples");
assert.equal(first.values.length, 200);
assert.equal(first.values.every(Number.isFinite), true);
assert.equal(first.rows.length, 200);
assert.equal(
  first.rows.every((row, index) => row.length === 1 && row[0] === first.values[index]),
  true,
);

console.log("Analysis sample contract tests passed");