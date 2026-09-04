import assert from "node:assert/strict";

import { deriveGraphSpecEncoding } from "../src/components/graphBuilder/graphSpecEncoding.ts";
import { buildGraph } from "../src/graphCore/transform.ts";
import { getGraphTheme } from "../src/graphCore/theme.ts";

import type { GraphData, GraphSpec } from "../src/graphCore/types.ts";
import type { GraphBuilderItem } from "../src/types/graphBuilder.ts";

const xField = { name: "x", type: "continuous" } as const;
const yField = { name: "y", type: "continuous" } as const;
const colorField = { name: "Build", type: "nominal" } as const;
const overlayField = { name: "Overlay", type: "nominal" } as const;

const data: GraphData = {
  columns: ["x", "y", "Build", "Overlay"],
  rows: [
    [1, 10, "Alpha", "Layer A"],
    [2, 20, "Beta", "Layer B"],
    [3, 30, "Alpha", "Layer A"],
    [4, 40, "Beta", "Layer B"],
  ],
};

function pointSeriesColors(spec: GraphSpec): Record<string, string> {
  const built = buildGraph(spec, data, getGraphTheme());
  const series = built.panels[0].option.series as Array<Record<string, any>>;
  const out: Record<string, string> = {};
  for (const entry of series) {
    if (entry.type !== "scatter") continue;
    const name = String(entry.name ?? "");
    if (!name || name.includes("__")) continue;
    out[name] = String(entry.itemStyle?.color ?? "");
  }
  return out;
}

{
  const encoding = deriveGraphSpecEncoding({
    x: xField,
    y: yField,
    color: colorField,
  } satisfies GraphBuilderItem["encoding"]);

  assert.deepEqual(encoding.color, colorField, "color-only grouping must be forwarded into the renderer spec");

  const spec: GraphSpec = {
    encoding,
    elements: [{ kind: "points", enabled: true, options: { summaryStat: "none" } }],
    styles: {
      Alpha: { point: { color: "#111111", fillColor: "#111111" } },
      Beta: { point: { color: "#222222", fillColor: "#222222" } },
    },
  };

  assert.deepEqual(pointSeriesColors(spec), {
    Alpha: "#111111",
    Beta: "#222222",
  });
}

{
  const encoding = deriveGraphSpecEncoding({
    x: xField,
    y: yField,
    color: colorField,
    overlay: overlayField,
  } satisfies GraphBuilderItem["encoding"]);

  assert.equal(encoding.color, undefined, "overlay must remain the only grouping channel when both overlay and color exist");
  assert.deepEqual(encoding.overlay, overlayField);

  const spec: GraphSpec = {
    encoding,
    elements: [{ kind: "points", enabled: true, options: { summaryStat: "none" } }],
    styles: {
      "Layer A": { point: { color: "#333333", fillColor: "#333333" } },
      "Layer B": { point: { color: "#444444", fillColor: "#444444" } },
      Alpha: { point: { color: "#999999", fillColor: "#999999" } },
      Beta: { point: { color: "#aaaaaa", fillColor: "#aaaaaa" } },
    },
  };

  assert.deepEqual(pointSeriesColors(spec), {
    "Layer A": "#333333",
    "Layer B": "#444444",
  });
}

console.log("graph builder spec encoding bridge regressions passed");