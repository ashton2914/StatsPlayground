import assert from "node:assert/strict";

import {
  MAX_FIT_MODEL_TERMS,
  buildFactorialToDegreeTerms,
  buildFullFactorialTerms,
  buildResponseSurfaceTerms,
  countFactorialTerms,
} from "../src/components/fitModel/fitModelConstruct.ts";

const fields = ["A", "B", "C"].map((name) => ({ name, type: "continuous" as const }));

assert.equal(MAX_FIT_MODEL_TERMS, 256);
assert.equal(countFactorialTerms(3, 3), 7);
assert.deepEqual(
  buildFullFactorialTerms(fields).map((term) => term.columnNames),
  [["A"], ["B"], ["C"], ["A", "B"], ["A", "C"], ["B", "C"], ["A", "B", "C"]],
);
assert.equal(buildFactorialToDegreeTerms(fields, 2).length, 6);
assert.deepEqual(
  buildResponseSurfaceTerms(fields).filter((term) => term.kind === "power"),
  [
    { kind: "power", columnNames: ["A"], exponent: 2 },
    { kind: "power", columnNames: ["B"], exponent: 2 },
    { kind: "power", columnNames: ["C"], exponent: 2 },
  ],
);
assert.throws(
  () =>
    buildFullFactorialTerms(
      Array.from({ length: 9 }, (_, index) => ({
        name: `X${index}`,
        type: "continuous" as const,
      })),
    ),
  /256/,
);

console.log("fitModelConstruct contract tests passed");