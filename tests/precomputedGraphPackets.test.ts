import assert from "node:assert/strict";

import type { GraphTheme } from "../src/graphCore/theme.ts";
import type { GraphData, GraphSpec } from "../src/graphCore/types.ts";
import {
  isGraphAggregatePacket,
  type GraphAggregatePacket,
  type GraphDataFrame,
} from "../src/types/graphData.ts";

const localStorageState = new Map<string, string>();
const localStorageMock = {
  getItem(key: string): string | null {
    return localStorageState.has(key) ? (localStorageState.get(key) ?? null) : null;
  },
  setItem(key: string, value: string): void {
    localStorageState.set(key, value);
  },
  removeItem(key: string): void {
    localStorageState.delete(key);
  },
  clear(): void {
    localStorageState.clear();
  },
};
Object.defineProperty(globalThis, "localStorage", {
  value: localStorageMock,
  configurable: true,
});

const { buildGraph } = await import("../src/graphCore/transform.ts");

const theme: GraphTheme = {
  fgPrimary: "#111111",
  fgSecondary: "#333333",
  fgDim: "#666666",
  accent: "#1f77b4",
  gridLine: "#dddddd",
  gridLineMajor: "#bbbbbb",
  axisLine: "#999999",
  bgCanvas: "#ffffff",
  categorical: ["#1f77b4", "#ff7f0e", "#2ca02c", "#d62728"],
  sequential: ["#f0f4ff", "#1f77b4"],
};

function baseData(columns: string[]): GraphData {
  return {
    columns,
    rows: [],
  };
}

function frameWithAggregates(aggregates: readonly GraphAggregatePacket[]): GraphDataFrame {
  return {
    requestId: "req-precomputed",
    datasetId: "ds-precomputed",
    generation: 7,
    sourceRows: 0,
    processedRows: 0,
    sampling: { mode: "full" },
    dictionaries: {},
    extents: {},
    rawChunks: [],
    aggregates,
    rawPointDisposition: { status: "empty", validRows: 0, budget: 1000 },
  };
}

function seriesList(option: Record<string, unknown>): Array<Record<string, unknown>> {
  const series = option.series;
  if (!Array.isArray(series)) return [];
  return series as Array<Record<string, unknown>>;
}

const graphSpec: GraphSpec = {
  encoding: {
    x: { name: "x", type: "continuous" },
    y: { name: "y", type: "continuous" },
  },
  elements: [
    {
      kind: "points",
      enabled: true,
      options: { summaryStat: "none", elementId: "pts-main" },
    },
    {
      kind: "line",
      enabled: true,
      options: { summaryStat: "none", elementId: "curve-linear" },
    },
    {
      kind: "line",
      enabled: true,
      options: { summaryStat: "none", elementId: "curve-step" },
    },
  ],
};

const validPointPacket = {
  kind: "precomputedPoints",
  elementId: "pts-main",
  points: [
    { x: 3, y: 9, label: "P3", group: "A" },
    { x: 1, y: 1, label: "P1", group: "B" },
    { x: 2, y: 4 },
  ],
};

const validLinearCurvePacket = {
  kind: "precomputedCurve",
  elementId: "curve-linear",
  interpolation: "linear",
  points: [
    { x: 2, y: 7 },
    { x: 0, y: 0 },
    { x: 1, y: 3 },
  ],
};

const validStepCurvePacket = {
  kind: "precomputedCurve",
  elementId: "curve-step",
  interpolation: "stepEnd",
  points: [
    { x: -1, y: 5 },
    { x: 4, y: 6 },
  ],
};

assert.equal(
  isGraphAggregatePacket(validPointPacket),
  true,
  "valid precomputed point packets must pass structural validation",
);
assert.equal(
  isGraphAggregatePacket(validLinearCurvePacket),
  true,
  "valid linear precomputed curve packets must pass structural validation",
);
assert.equal(
  isGraphAggregatePacket(validStepCurvePacket),
  true,
  "valid stepped precomputed curve packets must pass structural validation",
);

assert.equal(
  isGraphAggregatePacket({
    kind: "precomputedPoints",
    elementId: "bad-point",
    points: [{ x: Number.NaN, y: 1 }],
  }),
  false,
  "non-finite point coordinates must be rejected",
);
assert.equal(
  isGraphAggregatePacket({
    kind: "precomputedPoints",
    elementId: "",
    points: [{ x: 1, y: 2 }],
  }),
  false,
  "blank element IDs must be rejected",
);
assert.equal(
  isGraphAggregatePacket({
    kind: "precomputedPoints",
    elementId: "bad-points",
    points: null,
  }),
  false,
  "non-array point payloads must be rejected",
);
assert.equal(
  isGraphAggregatePacket({
    kind: "precomputedPoints",
    elementId: "bad-label",
    points: [{ x: 1, y: 2, label: 7 }],
  }),
  false,
  "point labels must be strings when provided",
);
assert.equal(
  isGraphAggregatePacket({
    kind: "precomputedPoints",
    elementId: "bad-group",
    points: [{ x: 1, y: 2, group: 9 }],
  }),
  false,
  "point groups must be strings when provided",
);
assert.equal(
  isGraphAggregatePacket({
    kind: "precomputedCurve",
    elementId: "bad-interpolation",
    interpolation: "stepMiddle",
    points: [{ x: 1, y: 2 }],
  }),
  false,
  "only linear and stepEnd interpolation are allowed",
);
assert.equal(
  isGraphAggregatePacket({
    kind: "precomputedCurve",
    elementId: "bad-coordinate",
    interpolation: "linear",
    points: [{ x: 1, y: Number.POSITIVE_INFINITY }],
  }),
  false,
  "non-finite curve coordinates must be rejected",
);

const frame = frameWithAggregates([
  validPointPacket,
  validLinearCurvePacket,
  validStepCurvePacket,
  {
    kind: "precomputedPoints",
    elementId: "pts-ignored",
    points: [{ x: 999, y: 999 }],
  },
] as readonly GraphAggregatePacket[]);

const built = buildGraph(
  graphSpec,
  baseData(["x", "y"]),
  theme,
  undefined,
  frame,
);

assert.equal(built.panels.length, 1, "precomputed packets should render in a single panel");
const series = seriesList(built.panels[0].option as Record<string, unknown>);

const scatterSeries = series.filter((entry) => entry.type === "scatter");
const lineSeries = series.filter((entry) => entry.type === "line");
const customSeries = series.filter((entry) => entry.type === "custom");

assert.equal(scatterSeries.length, 1, "one scatter should be emitted for precomputedPoints");
assert.equal(lineSeries.length, 2, "one line should be emitted per precomputedCurve element match");
assert.equal(customSeries.length, 0, "precomputed packets should use ordinary scatter/line series");
assert.equal(scatterSeries[0].clip, true, "precomputed scatter must clip to the coordinate system");

const pointValues = scatterSeries[0].data as Array<[number, number]>;
assert.deepEqual(
  pointValues,
  [[3, 9], [1, 1], [2, 4]],
  "precomputedPoints must preserve exact coordinate order and values",
);

const linearSeries = lineSeries.find((entry) => entry.id === "curve-linear");
assert.ok(linearSeries, "linear curve should be matched by elementId");
assert.equal(linearSeries.clip, true, "linear precomputed curve must clip to the coordinate system");
assert.equal(linearSeries.showSymbol, false, "linear precomputed curve must be symbol-free");
assert.equal(linearSeries.step, undefined, "linear precomputed curve should not enable stepping");
assert.deepEqual(
  linearSeries.data,
  [[2, 7], [0, 0], [1, 3]],
  "linear precomputed curve must preserve exact coordinate order and values",
);

const stepSeries = lineSeries.find((entry) => entry.id === "curve-step");
assert.ok(stepSeries, "stepped curve should be matched by elementId");
assert.equal(stepSeries.clip, true, "stepped precomputed curve must clip to the coordinate system");
assert.equal(stepSeries.showSymbol, false, "stepped precomputed curve must be symbol-free");
assert.equal(stepSeries.step, "end", "stepEnd interpolation must map to ECharts step='end'");
assert.deepEqual(
  stepSeries.data,
  [[-1, 5], [4, 6]],
  "stepped precomputed curve must preserve exact coordinate order and values",
);

const groupedBuilt = buildGraph(
  {
    ...graphSpec,
    encoding: {
      ...graphSpec.encoding,
      color: { name: "group", type: "nominal" },
    },
  },
  baseData(["x", "y", "group"]),
  theme,
  undefined,
  {
    ...frame,
    dictionaries: { group: ["A", "B"] },
  },
);
const groupedSeries = seriesList(groupedBuilt.panels[0].option as Record<string, unknown>);
assert.equal(
  groupedSeries.filter((entry) => entry.id === "pts-main").length,
  1,
  "element-keyed point packets must render once across color groups",
);
assert.equal(
  groupedSeries.filter((entry) => entry.id === "curve-linear").length,
  1,
  "element-keyed curve packets must render once across color groups",
);

const multiSeriesBuilt = buildGraph(
  {
    encoding: graphSpec.encoding,
    elements: [
      {
        kind: "points",
        enabled: true,
        options: { summaryStat: "none", elementId: "shared-points" },
      },
      {
        kind: "line",
        enabled: true,
        options: { summaryStat: "none", elementId: "shared-curves" },
      },
    ],
  },
  baseData(["x", "y"]),
  theme,
  undefined,
  frameWithAggregates([
    {
      kind: "precomputedPoints",
      elementId: "shared-points",
      seriesId: "response-a-points",
      seriesName: "Response A",
      points: [{ x: 1, y: 10 }],
    },
    {
      kind: "precomputedPoints",
      elementId: "shared-points",
      seriesId: "response-b-points",
      seriesName: "Response B",
      points: [{ x: 2, y: 20 }],
    },
    {
      kind: "precomputedCurve",
      elementId: "shared-curves",
      seriesId: "response-a-curve",
      seriesName: "Response A",
      interpolation: "linear",
      points: [{ x: 1, y: 11 }],
    },
    {
      kind: "precomputedCurve",
      elementId: "shared-curves",
      seriesId: "response-b-curve",
      seriesName: "Response B",
      interpolation: "linear",
      points: [{ x: 2, y: 22 }],
    },
  ] as readonly GraphAggregatePacket[]),
);
const multiSeries = seriesList(multiSeriesBuilt.panels[0].option as Record<string, unknown>);
assert.deepEqual(
  multiSeries.map((entry) => entry.id),
  ["response-a-points", "response-b-points", "response-a-curve", "response-b-curve"],
  "all packets sharing a stable element role must emit distinct deterministic series",
);
assert.deepEqual(
  multiSeries.map((entry) => entry.name),
  ["Response A", "Response B", "Response A", "Response B"],
  "packet series names must flow to ordinary ECharts series",
);

const ungroupedHistogram = buildGraph(
  {
    encoding: {
      x: { name: "response", type: "continuous" },
    },
    elements: [{ kind: "histogram", enabled: true }],
  },
  baseData(["response"]),
  theme,
  undefined,
  frameWithAggregates([{
    kind: "histogram",
    bins: [
      { binStart: 0, binEnd: 1, count: 3, group: "Response A" },
      { binStart: 1, binEnd: 2, count: 5, group: "Response B" },
    ],
    totalCount: 8,
  }]),
);
const histogramSeries = seriesList(ungroupedHistogram.panels[0].option as Record<string, unknown>)
  .filter((entry) => entry.type === "bar");
const histogramCount = histogramSeries.flatMap((entry) => entry.data as Array<[number, number]>)
  .reduce((sum, point) => sum + point[1], 0);
assert.equal(
  histogramCount,
  8,
  "ungrouped histograms must aggregate named backend packet groups instead of filtering every bin",
);
