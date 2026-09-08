import assert from "node:assert/strict";

import {
  applyFilters,
  createInitialCategoricalRule,
} from "../src/components/filter/filterEngine.ts";

const data = {
  columns: ["category"],
  rows: [["A"], ["B"], [null]],
};
const field = { name: "category", type: "nominal" as const };

assert.deepEqual(
  applyFilters(data, [{
    id: "pass-through",
    op: "AND",
    rule: { kind: "categorical", field, selected: [], exclude: true },
  }])?.rows,
  data.rows,
);

assert.deepEqual(
  applyFilters(data, [{
    id: "exclude-a",
    op: "AND",
    rule: { kind: "categorical", field, selected: ["A"], exclude: true },
  }])?.rows,
  [["B"], [null]],
);

assert.deepEqual(
  createInitialCategoricalRule(
    { name: "Build", type: "nominal" },
    { columns: ["Build"], rows: [] },
    "include",
  ),
  {
    kind: "categorical",
    field: { name: "Build", type: "nominal" },
    selected: [],
    exclude: true,
  },
  "schema-only graph data must seed a pass-through categorical filter",
);

console.log("filter-exclusion regression passed");