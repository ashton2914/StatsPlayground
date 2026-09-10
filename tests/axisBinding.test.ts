import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { FieldRef, YAxisConfig } from "../src/graphCore";
import type { GraphBuilderItem, GraphSlotKey } from "../src/types/graphBuilder.ts";
import * as axisBinding from "../src/components/graphBuilder/axisBinding.ts";

const { prepareAxisBinding } = axisBinding;
const continuous = (name: string): FieldRef => ({ name, type: "continuous" });

const rangeAndStyle: YAxisConfig = {
  min: 2,
  max: 8,
  tickInterval: 1,
  inverse: true,
  showMajorGrid: true,
};

assert.deepStrictEqual(
  prepareAxisBinding(undefined, "category", false, rangeAndStyle),
  {
    bindingChanged: true,
    axisConfig: { inverse: true, showMajorGrid: true },
  },
  "empty -> field should clear range fields and preserve display fields",
);

assert.deepStrictEqual(
  prepareAxisBinding("old", "new", false, {
    min: 1,
    max: 9,
    tickInterval: 2,
    decimals: 3,
  }),
  {
    bindingChanged: true,
    axisConfig: { decimals: 3 },
  },
  "different field -> field should clear min/max/tickInterval",
);

const unchanged: YAxisConfig = {
  min: 10,
  max: 20,
  tickInterval: 5,
  inverse: true,
};
const unchangedResult = prepareAxisBinding("same", "same", false, unchanged);
assert.strictEqual(unchangedResult.bindingChanged, false, "same field should not count as changed");
assert.strictEqual(unchangedResult.axisConfig, unchanged, "same field should preserve config object identity");

assert.deepStrictEqual(
  prepareAxisBinding("same", "same", true, {
    min: 0,
    max: 100,
    tickInterval: 10,
    showAxisLine: false,
  }),
  {
    bindingChanged: true,
    axisConfig: { showAxisLine: false },
  },
  "hadMulti should force a reset even when the field name is unchanged",
);

assert.deepStrictEqual(
  prepareAxisBinding(undefined, "field", false, undefined),
  {
    bindingChanged: true,
    axisConfig: undefined,
  },
  "undefined config should stay undefined when binding changes",
);

assert.deepStrictEqual(
  prepareAxisBinding("old", "new", false, { min: 1, max: 2, tickInterval: 0.5 }),
  {
    bindingChanged: true,
    axisConfig: undefined,
  },
  "range-only config should collapse to undefined after reset",
);

const displayOnly: YAxisConfig = {
  decimals: 4,
  inverse: true,
  minorTickCount: 6,
  showAxisLine: false,
  tickPosition: "inside",
  showMajorGrid: true,
  showMinorGrid: false,
  majorGridStyle: { color: "#123456", width: 2, style: "dotted" },
  minorGridStyle: { color: "#abcdef", width: 1, style: "dashed" },
};

assert.deepStrictEqual(
  prepareAxisBinding("old", "new", false, displayOnly),
  {
    bindingChanged: true,
    axisConfig: displayOnly,
  },
  "all non-range display fields should be preserved verbatim",
);

const bindGraphBuilderField = (axisBinding as typeof axisBinding & {
  bindGraphBuilderField?: (
    item: GraphBuilderItem,
    slot: GraphSlotKey,
    field: FieldRef,
  ) => GraphBuilderItem;
}).bindGraphBuilderField;
assert.equal(typeof bindGraphBuilderField, "function", "axis binding must expose a mode-aware state update");

const threeDItem: GraphBuilderItem = {
  id: "graph-3d-drop",
  name: "3D drop regression",
  sourceDatasetId: "dataset-1",
  mode: "3d",
  modeStates: {
    twoD: {
      encoding: { y: { name: "legacy-y", type: "continuous" } },
      multiX: [],
      multiY: [],
      elements: [],
      smootherLambda: 0.5,
      yAxis: { min: 10, max: 20, tickInterval: 2 },
    },
    threeD: {
      encoding: {},
      elements: [],
      smootherLambda: 0.5,
    },
    multivariate: {
      columns: [],
      chartType: "correlationMatrix",
      correlationMethod: "pearson",
    },
  },
  createdAt: "2026-09-10T00:00:00.000Z",
};
const withThreeDX = bindGraphBuilderField!(threeDItem, "x", continuous("height"));
const withThreeDXY = bindGraphBuilderField!(withThreeDX, "y", continuous("width"));
assert.strictEqual(withThreeDXY.modeStates.twoD, threeDItem.modeStates.twoD);
assert.deepStrictEqual(withThreeDXY.modeStates.threeD.encoding, {
  x: continuous("height"),
  y: continuous("width"),
});

const twoDItem: GraphBuilderItem = {
  ...threeDItem,
  mode: "2d",
  modeStates: {
    ...threeDItem.modeStates,
    twoD: {
      ...threeDItem.modeStates.twoD,
      multiY: [continuous("legacy-y")],
      yAxis: { min: 10, max: 20, tickInterval: 2, inverse: true },
    },
  },
};
const withTwoDY = bindGraphBuilderField!(twoDItem, "y", continuous("width"));
assert.deepStrictEqual(withTwoDY.modeStates.twoD.encoding.y, continuous("width"));
assert.deepStrictEqual(withTwoDY.modeStates.twoD.multiY, []);
assert.deepStrictEqual(withTwoDY.modeStates.twoD.yAxis, { inverse: true });
assert.strictEqual(withTwoDY.modeStates.threeD, twoDItem.modeStates.threeD);

const graphBuilderSource = readFileSync(
  new URL("../src/components/graphBuilder/GraphBuilderView.tsx", import.meta.url),
  "utf8",
).replace(/\r\n/g, "\n");
assert.ok(
  graphBuilderSource.includes("bindGraphBuilderField(currentItem, slot, field)"),
  "GraphBuilderView must bind fields against the latest store item",
);
assert.ok(
  graphBuilderSource.includes("updateItem(item.id, { modeStates: nextItem.modeStates })"),
  "GraphBuilderView must persist the mode-aware binding result",
);

console.log("axis binding helper checks passed");
