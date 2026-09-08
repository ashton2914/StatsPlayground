import assert from "node:assert/strict";

import { resolveVisualGraphSlots } from "../src/components/graphBuilder/graphBuilderSlotLayout.ts";

assert.deepEqual(resolveVisualGraphSlots(false), {
  top: "groupX",
  left: "y",
  right: "groupY",
  bottom: "x",
});

assert.deepEqual(resolveVisualGraphSlots(true), {
  top: "groupY",
  left: "x",
  right: "groupX",
  bottom: "y",
});

console.log("graph builder slot layout tests passed");