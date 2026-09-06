import assert from "node:assert/strict";

import { buildNumericFitModelEquation } from "../src/components/fitModel/fitModelEquation.ts";
import type { FitModelFittedResult } from "../src/types/fitModel.ts";

const result = {
  kind: "fitted",
  responseColumn: "Yield",
  terms: [
    { termId: "A", kind: "main", columnNames: ["A"], label: "A" },
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
  parameterEstimates: [
    { termId: "Intercept", termLabel: "Intercept", estimate: 1.5 },
    { termId: "A", termLabel: "A", estimate: -2 },
    { termId: "interaction:A*B", termLabel: "A*B", estimate: 0.25 },
    { termId: "power:A^2", termLabel: "A^2", estimate: -0.5 },
  ],
} as FitModelFittedResult;

assert.deepEqual(buildNumericFitModelEquation(result), {
  response: "Yield",
  parts: [
    { coefficient: 1.5, featureLabel: null },
    { coefficient: -2, featureLabel: "A" },
    { coefficient: 0.25, featureLabel: "(A - 2) * (B - 4)" },
    { coefficient: -0.5, featureLabel: "(A - 2)^2" },
  ],
});

const invalid = {
  ...result,
  parameterEstimates: [
    ...result.parameterEstimates.slice(0, 3),
    { ...result.parameterEstimates[3], estimate: Number.NaN },
  ],
} as FitModelFittedResult;
assert.equal(buildNumericFitModelEquation(invalid), null);

console.log("fit model numeric equation tests passed");
