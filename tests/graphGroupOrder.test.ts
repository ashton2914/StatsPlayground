import assert from "node:assert/strict";

import {
  resolveStableGroupKeys,
  resolveThemeGroupKeySets,
} from "../src/components/graphBuilder/graphGroupOrder.ts";

const aggregateOrder = ["West", "Central", "East"];
const sampledDictionaryOrder = ["East", "West", "Central"];

assert.deepEqual(
  resolveStableGroupKeys(aggregateOrder, [], undefined),
  ["Central", "East", "West"],
  "aggregate-only group colors should use deterministic slots",
);

assert.deepEqual(
  resolveStableGroupKeys(aggregateOrder, sampledDictionaryOrder, undefined),
  ["Central", "East", "West"],
  "adding sampled points must not reorder existing group color slots",
);

assert.deepEqual(
  resolveStableGroupKeys(
    ["West", "", "   ", null, undefined, "Central", "West"],
    ["East", "Central", null],
    ["West", "East", "West"],
  ),
  ["West", "East", "Central"],
  "explicit Value Order should lead and remaining groups should stay deterministic",
);

assert.deepEqual(
  resolveThemeGroupKeySets([], [], undefined),
  { slotCandidateKeys: [], legendGroupKeys: [] },
  "no frame-backed discovery should not produce persistent or legend group keys",
);

assert.deepEqual(
  resolveThemeGroupKeySets(
    ["West", "Central", "East"],
    ["East", "West", "Central"],
    ["West", "East", "Central"],
  ),
  {
    slotCandidateKeys: ["Central", "East", "West"],
    legendGroupKeys: ["West", "East", "Central"],
  },
  "Value Order may reorder the legend but must not reassign initial theme slots",
);

console.log("graph group order regressions passed");
