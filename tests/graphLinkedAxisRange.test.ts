import assert from "node:assert/strict";

import { buildLinkedAxisRangePatch } from "../src/graphCore/linkedAxisRange.ts";

const option = {
  xAxis: [{ type: "value" }, { type: "value" }],
  yAxis: [{ type: "value" }, { type: "category" }],
};

assert.deepEqual(
  buildLinkedAxisRangePatch(option, "x", 10, 20),
  [{ min: 10, max: 20 }, { min: 10, max: 20 }],
  "a composite pan must move both aligned value X axes in the same animation frame",
);
assert.deepEqual(
  buildLinkedAxisRangePatch(option, "y", 2, 8),
  [{ min: 2, max: 8 }, {}],
  "a value Y range must not be applied to the composite category Y axis",
);
assert.deepEqual(
  buildLinkedAxisRangePatch({ xAxis: { type: "value" } }, "x", 1, 3),
  { min: 1, max: 3 },
  "ordinary one-axis graphs must retain the compact patch shape",
);