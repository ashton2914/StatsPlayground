import assert from "node:assert/strict";

import {
  predictFitModelPoint,
  scanFitModelPredictor,
} from "../src/components/fitModel/fitModelPrediction.ts";
import type { FitModelSnapshot } from "../src/types/fitModel.ts";

const snapshot: FitModelSnapshot = {
  coefficientTermIds: ["Intercept", "A", "B", "interaction:A*B", "power:A^2"],
  coefficients: [1, 2, -1, 0.5, 3],
  covariance: [
    [0.04, 0, 0, 0, 0],
    [0, 0.01, 0, 0, 0],
    [0, 0, 0.0025, 0, 0],
    [0, 0, 0, 0.01, 0],
    [0, 0, 0, 0, 0.04],
  ],
  meanSquareError: 0.25,
  errorDegreesOfFreedom: 10,
  confidenceLevel: 0.95,
  terms: [
    { termId: "A", kind: "main", columnNames: ["A"], label: "A" },
    { termId: "B", kind: "main", columnNames: ["B"], label: "B" },
    { termId: "interaction:A*B", kind: "interaction", columnNames: ["A", "B"], label: "A*B" },
    { termId: "power:A^2", kind: "power", columnNames: ["A"], label: "A^2" },
  ],
  centering: {
    method: "mean",
    centers: [
      { columnName: "A", mean: 2 },
      { columnName: "B", mean: 4 },
    ],
  },
  predictorRanges: [
    { columnName: "A", minimum: 0, maximum: 4, mean: 2 },
    { columnName: "B", minimum: 1, maximum: 7, mean: 4 },
  ],
};

function assertClose(actual: number | null, expected: number): void {
  assert.notEqual(actual, null);
  assert.ok(Math.abs((actual ?? 0) - expected) <= 1e-9 * Math.max(1, Math.abs(expected)), `${actual} != ${expected}`);
}

const prediction = predictFitModelPoint(snapshot, { A: 3, B: 6 });
assertClose(prediction.predicted, 5);
assertClose(prediction.meanConfidenceLower, 3.77959808952514);
assertClose(prediction.meanConfidenceUpper, 6.22040191047486);
assertClose(prediction.predictionLower, 3.34756800170186);
assertClose(prediction.predictionUpper, 6.65243199829814);
assert.equal(prediction.inferenceReason, null);
assert.deepEqual(prediction.extrapolatedColumns, []);

const withoutInference = predictFitModelPoint({
  ...snapshot,
  covariance: null,
  meanSquareError: null,
  errorDegreesOfFreedom: 0,
}, { A: 3, B: 6 });
assertClose(withoutInference.predicted, 5);
assert.equal(withoutInference.meanConfidenceLower, null);
assert.equal(withoutInference.predictionUpper, null);
assert.equal(withoutInference.inferenceReason, "inferenceNotEstimable");

const extrapolated = predictFitModelPoint(snapshot, { A: 99, B: 6 });
assert.deepEqual(extrapolated.extrapolatedColumns, ["A"]);

const scan = scanFitModelPredictor(snapshot, { A: 2, B: 4 }, "A", 101);
assert.equal(scan.length, 101);
assert.equal(scan[0]?.value, 0);
assert.equal(scan.at(-1)?.value, 4);
assert.ok(scan.every((point) => Number.isFinite(point.predicted)));
assert.equal(scanFitModelPredictor(snapshot, { A: 2, B: 4 }, "A", 1000).length, 101);

assert.throws(
  () => predictFitModelPoint({ ...snapshot, coefficientTermIds: ["Intercept", "B"] }, { A: 3, B: 6 }),
  /coefficient order/i,
);
assert.throws(() => predictFitModelPoint(snapshot, { A: Number.NaN, B: 6 }), /finite/i);
assert.throws(() => predictFitModelPoint(snapshot, { A: 3, B: 6, unused: Number.NaN }), /finite/i);

console.log("fitModel prediction contract passed");
