import assert from "node:assert/strict";

import { addFitModelInteractionEffect } from "../src/components/fitModel/fitModelAddEffect";
import type { FitModelTerm } from "../src/types/fitModel";

const existingMains: FitModelTerm[] = ["A", "B", "C"].map((columnName) => ({
  kind: "main",
  columnNames: [columnName],
}));

assert.deepEqual(
  addFitModelInteractionEffect(existingMains, ["C", "A", "B"]),
  {
    ok: true,
    terms: [...existingMains, { kind: "interaction", columnNames: ["A", "B", "C"] }],
    addedTerm: { kind: "interaction", columnNames: ["A", "B", "C"] },
  },
);

assert.deepEqual(addFitModelInteractionEffect(existingMains, ["A"]), {
  ok: false,
  reason: "selectAtLeastTwo",
});

assert.deepEqual(addFitModelInteractionEffect(existingMains, ["A", "A"]), {
  ok: false,
  reason: "selectAtLeastTwo",
});

const existingTerms: FitModelTerm[] = [
  ...existingMains,
  { kind: "interaction", columnNames: ["A", "B"] },
];
assert.deepEqual(addFitModelInteractionEffect(existingTerms, ["B", "A"]), {
  ok: false,
  reason: "duplicateEffect",
});

const fullTermBudget: FitModelTerm[] = Array.from({ length: 256 }, (_, index) => ({
  kind: "main",
  columnNames: [`X${index}`],
}));
assert.deepEqual(addFitModelInteractionEffect(fullTermBudget, ["A", "B"]), {
  ok: false,
  reason: "tooManyTerms",
});

assert.deepEqual(existingMains, ["A", "B", "C"].map((columnName) => ({
  kind: "main",
  columnNames: [columnName],
})));

console.log("fit model add effect tests passed");
