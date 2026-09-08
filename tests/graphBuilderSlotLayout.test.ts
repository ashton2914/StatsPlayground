import assert from "node:assert/strict";

import * as slotLayout from "../src/components/graphBuilder/graphBuilderSlotLayout.ts";

const { resolveVisualGraphSlots } = slotLayout;

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

const resolveVisibleSlotField = (
  slotLayout as typeof slotLayout & {
    resolveVisibleSlotField?: (
      field: { name: string } | undefined,
      fields: Array<{ name: string }> | undefined,
    ) => { name: string } | undefined;
  }
).resolveVisibleSlotField;

assert.equal(
  typeof resolveVisibleSlotField,
  "function",
  "slot layout must expose the single multi-field fallback used by the X slot",
);
assert.deepEqual(
  resolveVisibleSlotField?.(undefined, [{ name: "203-A1" }]),
  { name: "203-A1" },
  "a lone multiX column must remain visible as a normal slot chip",
);
assert.equal(
  resolveVisibleSlotField?.(undefined, [{ name: "203-A1" }, { name: "203-A2" }]),
  undefined,
  "two or more columns must remain on the multi-column summary path",
);

console.log("graph builder slot layout tests passed");