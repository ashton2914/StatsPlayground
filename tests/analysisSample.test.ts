import assert from "node:assert/strict";

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