import assert from "node:assert/strict";

import type { GraphTheme } from "../src/graphCore/theme.ts";
import type { GraphData, GraphSpec } from "../src/graphCore/types.ts";
import type { GraphDataFrame } from "../src/types/graphData.ts";

Object.defineProperty(globalThis, "localStorage", {
  value: {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  },
});

const { build3DOption, build3DPanels } = await import("../src/graphCore/threeD.ts");
const { collectFrame3DPoints } = await import("../src/graphCore/threeDFrame.ts");
const { buildGraph } = await import("../src/graphCore/transform.ts");

const theme: GraphTheme = {
  fgPrimary: "#111111",
  fgSecondary: "#333333",
  fgDim: "#666666",
  accent: "#0066cc",
  gridLine: "#eeeeee",
  gridLineMajor: "#dddddd",
  axisLine: "#999999",
  bgCanvas: "#ffffff",
  categorical: ["#0066cc"],
  sequential: ["#eeeeee", "#0066cc"],
};

const themed3DStyles: NonNullable<GraphSpec["styles"]> = {
  EV: {
    gradient: { color: "#9b1c31" },
    line: { color: "#5a1020" },
    point: { color: "#f28ca0", fillColor: "#f28ca0" },
    fill: { color: "#f6c7d1" },
  },
  EV1: {
    gradient: { color: "#227c5b" },
    line: { color: "#124734" },
    point: { color: "#7fdbb5", fillColor: "#7fdbb5" },
    fill: { color: "#c7f2e1" },
  },
  EV2: {
    gradient: { color: "#3659b8" },
    line: { color: "#1c2e63" },
    point: { color: "#9eb6ff", fillColor: "#9eb6ff" },
    fill: { color: "#d5e0ff" },
  },
  "TC1.6": {
    gradient: { color: "#f38b00" },
    line: { color: "#0c7a6b" },
    point: { color: "#7a1f8a", fillColor: "#7a1f8a" },
    fill: { color: "#ffd9a3" },
  },
};

const frameBackedGrouped3DData: GraphData = {
  columns: ["x", "y", "z", "group"],
  rows: new Proxy([] as unknown[][], {
    get(_target, prop) {
      if (prop === "length") return 0;
      throw new Error("legacy rows access is forbidden for grouped frame-backed 3D");
    },
  }),
};

function buildGroupedIdentityFrame(dictionaryOrder: string[], chunkOrder: string[]): GraphDataFrame {
  const codeByGroup = new Map(dictionaryOrder.map((group, index) => [group, index]));
  const rawChunks = chunkOrder.map((group, chunkIndex) => {
    const code = codeByGroup.get(group);
    assert.notEqual(code, undefined);
    const base = (chunkIndex + 1) * 100;
    return {
      chunkIndex,
      rowOffset: chunkIndex * 8,
      rowCount: 8,
      xValues: new Float64Array([0, 0, 1, 1, 0, 0, 1, 1]),
      yValues: new Float64Array([0, 0, 0, 0, 1, 1, 1, 1]),
      zValues: new Float64Array([
        base + 10,
        base + 14,
        base + 20,
        base + 24,
        base + 30,
        base + 34,
        base + 40,
        base + 44,
      ]),
      groupCodes: new Uint32Array(new Array(8).fill(code)),
      rowIds: new BigInt64Array([
        BigInt(chunkIndex * 8 + 1),
        BigInt(chunkIndex * 8 + 2),
        BigInt(chunkIndex * 8 + 3),
        BigInt(chunkIndex * 8 + 4),
        BigInt(chunkIndex * 8 + 5),
        BigInt(chunkIndex * 8 + 6),
        BigInt(chunkIndex * 8 + 7),
        BigInt(chunkIndex * 8 + 8),
      ]),
      validity: {
        x: new Uint8Array([0xff]),
        y: new Uint8Array([0xff]),
        z: new Uint8Array([0xff]),
        group: new Uint8Array([0xff]),
      },
    };
  });
  return {
    requestId: `req-${dictionaryOrder.join("-")}`,
    datasetId: `ds-${chunkOrder.join("-")}`,
    generation: 1,
    sourceRows: rawChunks.length * 8,
    processedRows: rawChunks.length * 8,
    sampling: { mode: "full" },
    dictionaries: { group: dictionaryOrder },
    extents: {},
    aggregates: [],
    rawChunks,
  };
}

function buildGrouped3DSpec(
  kinds: Array<"surface" | "scatter3d" | "contour3d">,
  intervalStyle: "errorBar" | "band" = "errorBar",
): GraphSpec {
  return {
    encoding: {
      x: { name: "x", type: "quantitative" },
      y: { name: "y", type: "quantitative" },
      z: { name: "z", type: "quantitative" },
      overlay: { name: "group", type: "nominal" },
      color: { name: "colorShouldNotWin", type: "nominal" },
    },
    elements: kinds.map((kind) => {
      if (kind === "scatter3d") {
        return {
          kind,
          options: {
            summaryStat: "mean",
            errorInterval: "stdErr",
            intervalStyle,
          },
        };
      }
      if (kind === "surface") {
        return { kind, options: { stat: "mean", smoothness: 0 } };
      }
      return { kind, options: { stat: "mean", smoothness: 0, levels: 3 } };
    }),
    styles: themed3DStyles,
  };
}

function collect3DColorMarks(option: Record<string, unknown>) {
  const series = option.series as Array<Record<string, any>>;
  const marks = {
    surface: {} as Record<string, string>,
    scatter3d: {} as Record<string, string>,
    contour3d: {} as Record<string, string>,
    error3d: {} as Record<string, string>,
  };
  for (const item of series) {
    const name = String(item.name ?? "");
    if (item.type === "surface") {
      marks.surface[name] = String(item.itemStyle?.color ?? "");
      continue;
    }
    if (item.type === "scatter3D") {
      marks.scatter3d[name] = String(item.itemStyle?.color ?? "");
      continue;
    }
    if (item.type !== "line3D") continue;
    if (name.includes("__contour_")) {
      marks.contour3d[name.split("__contour_")[0]] = String(item.lineStyle?.color ?? "");
      continue;
    }
    if (name.includes("__err_")) {
      marks.error3d[name.split("__err_")[0]] = String(item.lineStyle?.color ?? "");
    }
  }
  return marks;
}

function collect2DGroupedPointColors(spec: GraphSpec, data: GraphData): Record<string, { fill: string; stroke: string }> {
  const built = buildGraph(spec, data, theme);
  const panel = built.panels[0];
  assert.ok(panel);
  const series = panel.option.series as Array<Record<string, any>>;
  const out: Record<string, { fill: string; stroke: string }> = {};
  for (const item of series) {
    if (item.type !== "scatter") continue;
    const name = String(item.name ?? "");
    if (!name || name.includes("__")) continue;
    out[name] = {
      fill: String(item.itemStyle?.color ?? ""),
      stroke: String(item.itemStyle?.borderColor ?? ""),
    };
  }
  return out;
}

const spec: GraphSpec = {
  encoding: {
    x: { name: "x", type: "quantitative" },
    y: { name: "y", type: "quantitative" },
    z: { name: "z", type: "quantitative" },
  },
  elements: [{
    kind: "scatter3d",
    options: {
      summaryStat: "mean",
      errorInterval: "stdErr",
      intervalStyle: "errorBar",
    },
  }],
};

const data: GraphData = {
  columns: ["x", "y", "z"],
  rows: [
    [1, 2, 10],
    [1, 2, 14],
  ],
};

const result = build3DOption(spec, data, theme);
assert.ok(result.option);

const series = result.option.series as Array<Record<string, unknown>>;
assert.equal(series.some((item) => item.type === "lines3D"), false);

const intervalSeries = series.filter((item) => item.type === "line3D");
assert.equal(intervalSeries.length, 1);
assert.deepEqual(intervalSeries[0].data, [[1, 2, 10], [1, 2, 14]]);

const throwingRows = new Proxy([] as unknown[][], {
  get(_target, prop) {
    if (prop === "length") return 2;
    throw new Error("legacy rows access is forbidden for frame-backed 3D");
  },
});

const frame3dData: GraphData = {
  columns: ["x", "y", "z"],
  rows: throwingRows,
};

const frame3d: GraphDataFrame = {
  requestId: "req-3d",
  datasetId: "ds-3d",
  generation: 1,
  sourceRows: 2,
  processedRows: 2,
  sampling: { mode: "full" },
  dictionaries: {},
  extents: {},
  aggregates: [],
  rawChunks: [
    {
      chunkIndex: 0,
      rowOffset: 0,
      rowCount: 2,
      xValues: new Float64Array([1, 1]),
      yValues: new Float64Array([2, 2]),
      zValues: new Float64Array([10, 14]),
      rowIds: new BigInt64Array([1n, 2n]),
      validity: {
        x: new Uint8Array([0b00000011]),
        y: new Uint8Array([0b00000011]),
        z: new Uint8Array([0b00000011]),
      },
    },
  ],
};

const frameResult = build3DOption(spec, frame3dData, theme, frame3d);
assert.ok(frameResult.option);
const frameSeries = frameResult.option.series as Array<Record<string, unknown>>;
assert.equal(frameSeries.some((item) => item.type === "scatter3D"), true);

const facetedSpec: GraphSpec = {
  ...spec,
  encoding: {
    ...spec.encoding,
    groupX: { name: "Column", type: "nominal" },
    groupY: { name: "Row", type: "nominal" },
  },
};
const facetedFrame: GraphDataFrame = {
  ...frame3d,
  requestId: "req-3d-facets",
  sourceRows: 4,
  processedRows: 4,
  dictionaries: {
    facetX: ["Left", "Right"],
    facetY: ["Top", "Bottom"],
  },
  rawChunks: [{
    chunkIndex: 0,
    rowOffset: 0,
    rowCount: 4,
    xValues: new Float64Array([1, 2, 3, 4]),
    yValues: new Float64Array([11, 12, 13, 14]),
    zValues: new Float64Array([21, 22, 23, 24]),
    facetXCodes: new Uint32Array([0, 1, 0, 1]),
    facetYCodes: new Uint32Array([0, 0, 1, 1]),
    rowIds: new BigInt64Array([1n, 2n, 3n, 4n]),
    validity: {
      x: new Uint8Array([0b00001111]),
      y: new Uint8Array([0b00001111]),
      z: new Uint8Array([0b00001111]),
      facetX: new Uint8Array([0b00001111]),
      facetY: new Uint8Array([0b00001111]),
    },
  }],
};
const facetedResult = build3DPanels(facetedSpec, frame3dData, theme, facetedFrame);
assert.equal(facetedResult.cols, 2);
assert.equal(facetedResult.rows, 2);
assert.deepEqual(
  facetedResult.panels.map((panel) => panel.title),
  [
    "Column=Left | Row=Top",
    "Column=Right | Row=Top",
    "Column=Left | Row=Bottom",
    "Column=Right | Row=Bottom",
  ],
);
assert.deepEqual(
  facetedResult.panels.map((panel) => {
    const scatter = (panel.option?.series as Array<Record<string, unknown>>)
      .find((item) => item.type === "scatter3D");
    return scatter?.data;
  }),
  [
    [[1, 11, 21]],
    [[2, 12, 22]],
    [[3, 13, 23]],
    [[4, 14, 24]],
  ],
);
assert.ok(facetedResult.panels.every((panel) => {
  const option = panel.option as Record<string, any>;
  return option.xAxis3D.min === 1
    && option.xAxis3D.max === 4
    && option.yAxis3D.min === 11
    && option.yAxis3D.max === 14
    && option.zAxis3D.min === 21
    && option.zAxis3D.max === 24;
}));

const dictionaryStableFrame: GraphDataFrame = {
  ...facetedFrame,
  dictionaries: {
    facetX: ["Unused", "Right", "Left"],
    facetY: ["Top", "Bottom"],
  },
  rawChunks: facetedFrame.rawChunks.map((chunk) => ({
    ...chunk,
    facetXCodes: new Uint32Array([2, 1, 2, 1]),
  })),
};
const dictionaryStableResult = build3DPanels(
  facetedSpec,
  frame3dData,
  theme,
  dictionaryStableFrame,
);
assert.equal(dictionaryStableResult.cols, 3);
assert.deepEqual(
  dictionaryStableResult.panels.slice(0, 3).map((panel) => panel.groupXValue),
  ["Unused", "Right", "Left"],
);

const rowFacetedData: GraphData = {
  columns: ["x", "y", "z", "Column", "Row"],
  rows: [
    [1, 11, 21, "Left", "Top"],
    [2, 12, 22, "Right", "Top"],
    ["bad", 13, 23, "Invalid", "Bottom"],
  ],
};
const rowFacetedResult = build3DPanels(facetedSpec, rowFacetedData, theme);
assert.equal(rowFacetedResult.cols, 2);
assert.equal(rowFacetedResult.rows, 1);
assert.deepEqual(
  rowFacetedResult.panels.map((panel) => panel.title),
  ["Column=Left | Row=Top", "Column=Right | Row=Top"],
);

const hiddenOutlierSpec: GraphSpec = {
  ...facetedSpec,
  encoding: {
    ...facetedSpec.encoding,
    overlay: { name: "Group", type: "nominal" },
  },
  hiddenGroups: ["Outlier"],
};
const hiddenOutlierData: GraphData = {
  columns: ["x", "y", "z", "Column", "Row", "Group"],
  rows: [
    [1, 11, 21, "Left", "Top", "Visible"],
    [2, 12, 22, "Right", "Top", "Visible"],
    [999, 999, 999, "Right", "Top", "Outlier"],
  ],
};
const hiddenOutlierResult = build3DPanels(hiddenOutlierSpec, hiddenOutlierData, theme);
assert.ok(hiddenOutlierResult.panels.every((panel) => {
  const option = panel.option as Record<string, any>;
  return option.xAxis3D.max === 2
    && option.yAxis3D.max === 12
    && option.zAxis3D.max === 22;
}));

const crossByteFrame: GraphDataFrame = {
  requestId: "req-3d-cross-byte",
  datasetId: "ds-3d-cross-byte",
  generation: 1,
  sourceRows: 10,
  processedRows: 10,
  sampling: { mode: "full" },
  dictionaries: { group: ["G0", "G1"] },
  extents: {},
  aggregates: [],
  rawChunks: [
    {
      chunkIndex: 0,
      rowOffset: 0,
      rowCount: 10,
      xValues: new Float64Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
      yValues: new Float64Array([11, 12, 13, 14, 15, 16, 17, 18, 19, 20]),
      zValues: new Float64Array([21, 22, 23, 24, 25, 26, 27, 28, 29, 30]),
      groupCodes: new Uint32Array([0, 1, 0, 1, 0, 1, 0, 1, 0, 1]),
      rowIds: new BigInt64Array([1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n, 9n, 10n]),
      validity: {
        x: new Uint8Array([0b00000001, 0b00000001]),
        y: new Uint8Array([0b00000001, 0b00000010]),
        z: new Uint8Array([0b00000001, 0b00000011]),
        group: new Uint8Array([0b00000001, 0b00000011]),
      },
    },
  ],
};

const crossByteResult = build3DOption(spec, frame3dData, theme, crossByteFrame);
const crossByteSeries = (crossByteResult.option.series as Array<Record<string, unknown>>)
  .find((item) => item.type === "scatter3D");
assert.ok(crossByteSeries);
const crossBytePoints = crossByteSeries.data as number[][];
assert.equal(crossBytePoints.length, 1);
assert.deepEqual(crossBytePoints[0], [1, 11, 21]);

const frameWithTruncatedRowIds: GraphDataFrame = {
  requestId: "req-3d-truncated-rowids",
  datasetId: "ds-3d-truncated-rowids",
  generation: 1,
  sourceRows: 3,
  processedRows: 3,
  sampling: { mode: "full" },
  dictionaries: {},
  extents: {},
  aggregates: [],
  rawChunks: [
    {
      chunkIndex: 0,
      rowOffset: 0,
      rowCount: 3,
      xValues: new Float64Array([1, 2, 3]),
      yValues: new Float64Array([10, 20, 30]),
      zValues: new Float64Array([100, 200, 300]),
      rowIds: new BigInt64Array([]),
      validity: {
        x: new Uint8Array([0b00000111]),
        y: new Uint8Array([0b00000111]),
        z: new Uint8Array([0b00000111]),
      },
    },
  ],
};

const loose3dPoints = collectFrame3DPoints(frameWithTruncatedRowIds);
assert.equal(loose3dPoints.length, 3);
assert.deepEqual(loose3dPoints.map((point) => [point.x, point.y, point.z]), [
  [1, 10, 100],
  [2, 20, 200],
  [3, 30, 300],
]);

const surfaceData: GraphData = {
  columns: ["x", "y", "z"],
  rows: [
    [0, 0, 0], [1, 0, 0], [2, 0, 0],
    [0, 1, 0], [1, 1, 80], [1, 1, 120], [2, 1, 0],
    [0, 2, 0], [1, 2, 0],
  ],
};

const buildSurface = (smoothness?: number) => build3DOption({
  encoding: spec.encoding,
  elements: [{
    kind: "surface",
    options: {
      stat: "mean",
      ...(smoothness === undefined ? {} : { smoothness }),
    },
  }],
}, surfaceData, theme);

const rawSurface = buildSurface();
assert.ok(rawSurface.option);
const rawSeries = (rawSurface.option.series as Array<Record<string, unknown>>)
  .find((item) => item.type === "surface");
assert.ok(rawSeries);
assert.deepEqual(rawSeries.dataShape, [3, 3]);

const rawVertices = rawSeries.data as number[][];
assert.equal(rawVertices.length, 9);
assert.equal(rawVertices[4][2], 100);
assert.equal(Number.isNaN(rawVertices[8][2]), true);

// Previously smoothing modified geometry; now smoothing is visual-only.
const smoothSurface = buildSurface(1);
assert.ok(smoothSurface.option);
const smoothSeries = (smoothSurface.option.series as Array<Record<string, unknown>>)
  .find((item) => item.type === "surface");
assert.ok(smoothSeries);
const smoothVertices = smoothSeries.data as number[][];
// Geometry must be identical, hole preserved.
assert.deepEqual(rawVertices, smoothVertices);
assert.equal(Number.isNaN(smoothVertices[8][2]), true);

// Both surface series use Lambert shading and grid3D light intensities map to
// visual smoothness: s=0 -> (1.2,0.3), s=1 -> (0.3,0.9).
assert.equal((rawSeries as any).shading, "lambert");
assert.equal((smoothSeries as any).shading, "lambert");
const rawLight = (rawSurface.option as any).grid3D.light as any;
const smoothLight = (smoothSurface.option as any).grid3D.light as any;
const EPS = 1e-12;
assert.ok(Math.abs(rawLight.main.intensity - 1.2) < EPS);
assert.ok(Math.abs(rawLight.ambient.intensity - 0.3) < EPS);
assert.ok(Math.abs(smoothLight.main.intensity - 0.3) < EPS);
assert.ok(Math.abs(smoothLight.ambient.intensity - 0.9) < EPS);

// New: visualMap configuration must remain for emitted Lambert Surface.
// It should be an array of continuous visualMaps with dimension 2, include
// the surface series index, and preserve the color gradient array.
const vmap = (smoothSurface.option as any).visualMap as any[] | undefined;
assert.ok(Array.isArray(vmap));
const firstVM = vmap[0];
assert.equal(firstVM.type, "continuous");
assert.equal(firstVM.dimension, 2);
// seriesIndex may be an array — ensure it contains the surface series index.
const vmSeriesIndex = firstVM.seriesIndex as number[] | number;
const surfaceIndex = (smoothSurface.option as any).series.findIndex((s: any) => s.type === "surface");
assert.ok(Array.isArray(vmSeriesIndex) ? vmSeriesIndex.includes(surfaceIndex) : vmSeriesIndex === surfaceIndex);
// Color gradient retained — compare shape and approximate colors via toString
assert.ok(Array.isArray(firstVM.inRange?.color) && firstVM.inRange.color.length === 3);

// Scatter-only scene keeps main/ambient defaults 1.2/0.3
const scatterOnly = build3DOption({ encoding: spec.encoding, elements: [spec.elements[0]] }, data, theme);
assert.ok(scatterOnly.option);
const scatterLight = (scatterOnly.option as any).grid3D.light as any;
assert.ok(Math.abs(scatterLight.main.intensity - 1.2) < EPS);
assert.ok(Math.abs(scatterLight.ambient.intensity - 0.3) < EPS);

// Smoothness normalization: below 0 -> 0, above 1 -> 1, non-finite -> 0
const below = buildSurface(-0.5);
const above = buildSurface(2);
const nan = buildSurface(Number.NaN);
const inf = buildSurface(Infinity);
const belowLight = (below.option as any).grid3D.light as any;
const aboveLight = (above.option as any).grid3D.light as any;
const nanLight = (nan.option as any).grid3D.light as any;
const infLight = (inf.option as any).grid3D.light as any;
// below equals s=0
assert.ok(Math.abs(belowLight.main.intensity - rawLight.main.intensity) < EPS);
assert.ok(Math.abs(belowLight.ambient.intensity - rawLight.ambient.intensity) < EPS);
// above equals s=1
assert.ok(Math.abs(aboveLight.main.intensity - smoothLight.main.intensity) < EPS);
assert.ok(Math.abs(aboveLight.ambient.intensity - smoothLight.ambient.intensity) < EPS);
// non-finite -> treated as 0
assert.ok(Math.abs(nanLight.main.intensity - rawLight.main.intensity) < EPS);
assert.ok(Math.abs(nanLight.ambient.intensity - rawLight.ambient.intensity) < EPS);
assert.ok(Math.abs(infLight.main.intensity - rawLight.main.intensity) < EPS);
assert.ok(Math.abs(infLight.ambient.intensity - rawLight.ambient.intensity) < EPS);

const contourData: GraphData = {
  columns: ["x", "y", "z"],
  rows: [
    [0, 0, 0], [1, 0, 1], [2, 0, 2],
    [0, 1, 1], [1, 1, 2], [2, 1, 3],
    [0, 2, 2], [1, 2, 3], [2, 2, 4],
  ],
};

const contourResult = build3DOption({
  encoding: spec.encoding,
  elements: [{
    kind: "contour3d",
    options: { stat: "mean", smoothness: 0, levels: 3 },
  }],
}, contourData, theme);
assert.ok(contourResult.option);
const contourSeries = (contourResult.option.series as Array<Record<string, unknown>>)
  .filter((item) => String(item.name).includes("__contour_"));
assert.equal(contourSeries.length, 3);
assert.ok(contourSeries.every((item) => item.type === "line3D"));
assert.ok(contourSeries.every((item) => {
  const points = item.data as number[][];
  return points.length >= 2 && points.every((point) => point.every(Number.isFinite));
}));
const contourLevels = contourSeries.map((item) => Number(String(item.name).split("__contour_")[1]?.split("_")[0]));
assert.deepEqual(contourLevels, [1, 2, 3]);
assert.ok(contourSeries.every((item, index) => {
  const points = item.data as number[][];
  return points.every((point) => point[2] > contourLevels[index]);
}));

const groupedContourData: GraphData = {
  columns: ["x", "y", "z", "group"],
  rows: [
    ...contourData.rows.map((row) => [...row, "A"]),
    ...contourData.rows.map((row) => [row[0], row[1], Number(row[2]) + 10, "B"]),
  ],
};
const groupedContourResult = build3DOption({
  encoding: {
    ...spec.encoding,
    overlay: { name: "group", type: "nominal" },
  },
  elements: [
    { kind: "surface", options: { stat: "mean", smoothness: 0 } },
    { kind: "contour3d", options: { stat: "mean", smoothness: 0, levels: 3 } },
  ],
  styles: {
    A: { gradient: { color: "#cc0000" } },
    B: { gradient: { color: "#0000cc" } },
  },
  hiddenGroups: ["B"],
}, groupedContourData, theme);
assert.ok(groupedContourResult.option);
const groupedSeries = groupedContourResult.option.series as Array<Record<string, unknown>>;
const visibleContours = groupedSeries.filter((item) => String(item.name).includes("__contour_"));
assert.equal(visibleContours.length, 3);
assert.ok(visibleContours.every((item) => String(item.name).startsWith("A__contour_")));
assert.ok(visibleContours.every((item) => (item.lineStyle as Record<string, unknown>).color === "#cc0000"));
assert.equal(groupedSeries.filter((item) => item.type === "surface").length, 1);
const contourIndexes = new Set(groupedSeries
  .map((item, index) => String(item.name).includes("__contour_") ? index : -1)
  .filter((index) => index >= 0));
const visualMaps = groupedContourResult.option.visualMap as Array<Record<string, unknown>>;
assert.ok(visualMaps.every((visualMap) =>
  (visualMap.seriesIndex as number[]).every((index) => !contourIndexes.has(index))));

const frameContour: GraphDataFrame = {
  requestId: "req-3d-contour",
  datasetId: "ds-3d-contour",
  generation: 1,
  sourceRows: 18,
  processedRows: 18,
  sampling: { mode: "full" },
  dictionaries: { group: ["A", "B"] },
  extents: {},
  aggregates: [],
  rawChunks: [{
    chunkIndex: 0,
    rowOffset: 0,
    rowCount: 18,
    xValues: new Float64Array([0, 1, 2, 0, 1, 2, 0, 1, 2, 0, 1, 2, 0, 1, 2, 0, 1, 2]),
    yValues: new Float64Array([0, 0, 0, 1, 1, 1, 2, 2, 2, 0, 0, 0, 1, 1, 1, 2, 2, 2]),
    zValues: new Float64Array([0, 1, 2, 1, 2, 3, 2, 3, 4, 10, 11, 12, 11, 12, 13, 12, 13, 14]),
    groupCodes: new Uint32Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1]),
    rowIds: new BigInt64Array([]),
    validity: {
      x: new Uint8Array([0xff, 0xff, 0x03]),
      y: new Uint8Array([0xff, 0xff, 0x03]),
      z: new Uint8Array([0xff, 0xff, 0x03]),
      group: new Uint8Array([0xff, 0xff, 0x03]),
    },
  }],
};
const frameContourResult = build3DOption({
  encoding: {
    ...spec.encoding,
    overlay: { name: "group", type: "nominal" },
  },
  elements: [{ kind: "contour3d", options: { levels: 3 } }],
  styles: {
    A: { gradient: { color: "#cc0000" } },
    B: { gradient: { color: "#0000cc" } },
  },
  hiddenGroups: ["B"],
}, frame3dData, theme, frameContour);
assert.ok(frameContourResult.option);
const frameContours = (frameContourResult.option.series as Array<Record<string, unknown>>)
  .filter((item) => String(item.name).includes("__contour_"));
assert.equal(frameContours.length, 3);
assert.ok(frameContours.every((item) => item.type === "line3D"));
assert.ok(frameContours.every((item) => String(item.name).startsWith("A__contour_")));
assert.ok(frameContours.every((item) => (item.lineStyle as Record<string, unknown>).color === "#cc0000"));
assert.ok(frameContours.every((item) =>
  (item.data as number[][]).length >= 2
    && (item.data as number[][]).every((point) => point.every(Number.isFinite))));

const fullIdentityFrame = buildGroupedIdentityFrame(
  ["EV", "EV1", "EV2", "TC1.6"],
  ["EV", "EV1", "EV2", "TC1.6"],
);
const reorderedMissingIdentityFrame = buildGroupedIdentityFrame(
  ["TC1.6", "EV1", "EV"],
  ["TC1.6", "EV1", "EV"],
);

for (const config of [
  ["scatter3d"],
  ["surface"],
  ["contour3d"],
  ["surface", "scatter3d"],
  ["scatter3d", "surface", "contour3d"],
] as const) {
  const spec3d = buildGrouped3DSpec([...config]);
  const fullBuilt = build3DOption(spec3d, frameBackedGrouped3DData, theme, fullIdentityFrame);
  const missingBuilt = build3DOption(spec3d, frameBackedGrouped3DData, theme, reorderedMissingIdentityFrame);
  assert.ok(fullBuilt.option, `expected 3D option for ${config.join(",")}`);
  assert.ok(missingBuilt.option, `expected reordered 3D option for ${config.join(",")}`);
  const fullMarks = collect3DColorMarks(fullBuilt.option!);
  const missingMarks = collect3DColorMarks(missingBuilt.option!);
  if (config.includes("scatter3d")) {
    assert.equal(fullMarks.scatter3d["TC1.6"], themed3DStyles["TC1.6"].gradient?.color);
    assert.equal(missingMarks.scatter3d["TC1.6"], themed3DStyles["TC1.6"].gradient?.color);
    assert.equal(fullMarks.error3d["TC1.6"], themed3DStyles["TC1.6"].line?.color);
    assert.equal(missingMarks.error3d["TC1.6"], themed3DStyles["TC1.6"].line?.color);
  }
  if (config.includes("surface")) {
    assert.equal(fullMarks.surface["TC1.6"], themed3DStyles["TC1.6"].gradient?.color);
    assert.equal(missingMarks.surface["TC1.6"], themed3DStyles["TC1.6"].gradient?.color);
  }
  if (config.includes("contour3d")) {
    assert.equal(fullMarks.contour3d["TC1.6"], themed3DStyles["TC1.6"].line?.color);
    assert.equal(missingMarks.contour3d["TC1.6"], themed3DStyles["TC1.6"].line?.color);
  }
}

const groupedBandSpec = buildGrouped3DSpec(["scatter3d"], "band");
const groupedBandResult = build3DOption(groupedBandSpec, frameBackedGrouped3DData, theme, reorderedMissingIdentityFrame);
assert.ok(groupedBandResult.option);
const groupedBandMarks = collect3DColorMarks(groupedBandResult.option!);
assert.equal(groupedBandMarks.scatter3d["TC1.6"], themed3DStyles["TC1.6"].gradient?.color);
assert.equal(groupedBandMarks.error3d["TC1.6"], themed3DStyles["TC1.6"].line?.color);

const sharedIdentityStyles: NonNullable<GraphSpec["styles"]> = structuredClone(themed3DStyles);
const grouped2DSpec: GraphSpec = {
  encoding: {
    x: { name: "x", type: "quantitative" },
    y: { name: "y", type: "quantitative" },
    overlay: { name: "group", type: "nominal" },
    color: { name: "colorShouldNotWin", type: "nominal" },
  },
  elements: [{ kind: "points" }],
  styles: sharedIdentityStyles,
};
const grouped2DData: GraphData = {
  columns: ["x", "y", "group"],
  rows: [
    [0, 1, "EV"],
    [1, 2, "EV1"],
    [2, 3, "TC1.6"],
  ],
};
const colorsBefore3D = collect2DGroupedPointColors(grouped2DSpec, grouped2DData);
assert.deepEqual(colorsBefore3D, {
  EV: { fill: "#f28ca0", stroke: "#f28ca0" },
  EV1: { fill: "#7fdbb5", stroke: "#7fdbb5" },
  "TC1.6": { fill: "#7a1f8a", stroke: "#7a1f8a" },
});
build3DOption(buildGrouped3DSpec(["scatter3d", "surface", "contour3d"]), frameBackedGrouped3DData, theme, reorderedMissingIdentityFrame);
const colorsAfter3D = collect2DGroupedPointColors(grouped2DSpec, grouped2DData);
assert.deepEqual(colorsAfter3D, colorsBefore3D);

console.log("threeD regressions passed");