import assert from "node:assert/strict";

import { buildGraph } from "../src/graphCore/transform.ts";
import { getGraphTheme } from "../src/graphCore/theme.ts";

import type { GraphData, GraphSpec } from "../src/graphCore/types.ts";

const data: GraphData = {
  columns: ["Part", "Height"],
  rows: [
    ["203-A8", 4.4],
    ["203-A9", 4.43],
    ["203-A6", 4.32],
    ["203-A7", 4.36],
  ],
};

const spec: GraphSpec = {
  encoding: {
    x: { name: "Part", type: "nominal" },
    y: { name: "Height", type: "continuous" },
  },
  elements: [
    { kind: "histogram", enabled: true, options: { histStyle: "shadowgram" } },
  ],
};

const built = buildGraph(spec, data, getGraphTheme());
const grid = built.panels[0].option.grid as { bottom?: number };

assert.ok(
  (grid.bottom ?? 0) >= 28,
  "an unrotated category X axis must reserve room for its tick labels",
);

console.log("graph axis label layout regression passed");