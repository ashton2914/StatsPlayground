import assert from "node:assert/strict";

import { buildGraph } from "../src/graphCore/transform.ts";
import { buildAxisCommon, getGraphTheme } from "../src/graphCore/theme.ts";

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
const axisDefaults = buildAxisCommon(getGraphTheme());

assert.deepEqual(
  axisDefaults.minorTick,
  {
    show: true,
    splitNumber: 5,
    lineStyle: { color: getGraphTheme().axisLine, width: 0.5 },
  },
  "all Graph Builder value axes must receive visible automatic minor ticks from the shared theme",
);

assert.ok(
  (grid.bottom ?? 0) >= 28,
  "an unrotated category X axis must reserve room for its tick labels",
);

console.log("graph axis label layout regression passed");