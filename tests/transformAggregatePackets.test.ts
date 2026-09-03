import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TEST_FILE_DIR = dirname(fileURLToPath(import.meta.url));
import type { GraphTheme } from "../src/graphCore/theme.ts";
import type { GraphData, GraphSpec } from "../src/graphCore/types.ts";
import type { GraphDataFrame } from "../src/types/graphData.ts";

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

const { buildGraph, transposeOption } = await import("../src/graphCore/transform.ts");

{
  const transformSource = readFileSync(resolve(TEST_FILE_DIR, "../src/graphCore/transform.ts"), "utf8");
  assert.match(
    transformSource,
    /function\s+buildBandRefLinesCarrier\([\s\S]*?aggregateMode[\s\S]*?\)/,
    "buildBandRefLinesCarrier must accept explicit aggregate mode context instead of free-variable references",
  );
  assert.match(
    transformSource,
    /function\s+buildAxisOverrides\([\s\S]*?aggregateMode[\s\S]*?\)/,
    "buildAxisOverrides must accept explicit aggregate mode context instead of free-variable references",
  );
}

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

function baseData(columns: string[], rows: unknown[][]): GraphData {
  return { columns, rows };
}

function baseFrame(aggregates: GraphDataFrame["aggregates"]): GraphDataFrame {
  return {
    requestId: "req-1",
    datasetId: "ds-1",
    generation: 1,
    sourceRows: 0,
    processedRows: 0,
    sampling: { mode: "full" },
    dictionaries: {},
    extents: {},
    rawChunks: [],
    aggregates,
  };
}

function panelSeries(option: Record<string, unknown>): Array<Record<string, unknown>> {
  const series = option.series;
  if (!Array.isArray(series)) return [];
  return series as Array<Record<string, unknown>>;
}

function throwOnAnyRowAccess(label: string): unknown[][] {
  return new Proxy([] as unknown[][], {
    get() {
      throw new Error(`legacy rows access is forbidden for ${label}`);
    },
  });
}

function frameBackedAggregateData(columns: string[], sourceRows = 4): GraphData {
  return baseData(columns, throwOnAnyRowAccess("frame-backed aggregate packet ownership"));
}

function frameBackedAggregateFrame(aggregates: GraphDataFrame["aggregates"], sourceRows = 4): GraphDataFrame {
  return {
    ...baseFrame(aggregates),
    sourceRows,
    processedRows: sourceRows,
  };
}

function typedNumericFrame(aggregates: GraphDataFrame["aggregates"] = []): GraphDataFrame {
  return {
    ...frameBackedAggregateFrame(aggregates, 6),
    extents: {
      x: { min: 1, max: 6 },
      y: { min: 2, max: 12 },
    },
    rawChunks: [{
      chunkIndex: 0,
      rowOffset: 0,
      rowCount: 6,
      xValues: new Float64Array([1, 2, 3, 4, 5, 6]),
      yValues: new Float64Array([2, 4, 5, 8, 9, 12]),
      rowIds: new BigInt64Array([1n, 2n, 3n, 4n, 5n, 6n]),
      validity: {
        x: new Uint8Array([0b00111111]),
        y: new Uint8Array([0b00111111]),
      },
    }],
  };
}

function typedGroupedNumericFrame(aggregates: GraphDataFrame["aggregates"] = []): GraphDataFrame {
  const frame = typedNumericFrame(aggregates);
  return {
    ...frame,
    dictionaries: { group: ["East", "West"] },
    rawChunks: frame.rawChunks.map((chunk) => ({
      ...chunk,
      groupCodes: new Uint32Array([0, 1, 0, 1, 0, 1]),
      validity: {
        ...chunk.validity,
        group: new Uint8Array([0b00111111]),
      },
    })),
  };
}

function frameScatterValues(panel: { option: unknown }): Array<{
  value: [number | string, number | string];
  __pick?: { rowId: number; colName: string };
}> {
  const scatter = panelSeries(panel.option as Record<string, unknown>)
    .find((entry) => entry.type === "scatter");
  assert.ok(scatter, "expected frame-backed scatter series");
  return scatter.data as Array<{
    value: [number | string, number | string];
    __pick?: { rowId: number; colName: string };
  }>;
}

{
  const spec: GraphSpec = {
    encoding: {
      x: { name: "x", type: "continuous" },
      y: { name: "y", type: "continuous" },
    },
    elements: [{ kind: "points", enabled: true }],
    transpose: true,
  };
  const built = buildGraph(
    spec,
    frameBackedAggregateData(["x", "y"], 6),
    theme,
    undefined,
    typedNumericFrame(),
  );

  assert.deepEqual(
    frameScatterValues(built.panels[0]).map((point) => point.value),
    [[2, 1], [4, 2], [5, 3], [8, 4], [9, 5], [12, 6]],
    "visual transpose must swap rendered coordinates without changing frame roles",
  );
}

function typedFacetedNumericFrame(): GraphDataFrame {
  const frame = typedNumericFrame();
  return {
    ...frame,
    dictionaries: { facetX: ["A", "B"] },
    rawChunks: frame.rawChunks.map((chunk) => ({
      ...chunk,
      facetXCodes: new Uint32Array([0, 0, 0, 1, 1, 1]),
      validity: {
        ...chunk.validity,
        facetX: new Uint8Array([0b00111111]),
      },
    })),
  };
}

function typedDateFrame(aggregates: GraphDataFrame["aggregates"] = []): GraphDataFrame {
  return {
    ...frameBackedAggregateFrame(aggregates, 4),
    dictionaries: { x: ["2026-01-01", "2026-01-02"] },
    extents: {
      x: { min: 0, max: 1 },
      y: { min: 2, max: 9 },
    },
    rawChunks: [{
      chunkIndex: 0,
      rowOffset: 0,
      rowCount: 4,
      xValues: new Uint32Array([0, 0, 1, 1]),
      yValues: new Float64Array([2, 5, 6, 9]),
      rowIds: new BigInt64Array([1n, 2n, 3n, 4n]),
      validity: {
        x: new Uint8Array([0b00001111]),
        y: new Uint8Array([0b00001111]),
      },
    }],
  };
}

const STYLE_MATRIX_GROUP_ORDER = ["EV", "EV1", "EV2", "TC1.6"] as const;
const STYLE_MATRIX_PANEL_ORDER = ["Panel-A", "Panel-B"] as const;
const STYLE_MATRIX_TARGET_GROUP = "TC1.6";
const STYLE_MATRIX_VALUE_ORDERS = {
  Build: [...STYLE_MATRIX_GROUP_ORDER],
  panel: [...STYLE_MATRIX_PANEL_ORDER],
  Shade: ["S-EV", "S-EV1", "S-EV2", "S-TC"],
};
const STYLE_MATRIX_STYLES: NonNullable<GraphSpec["styles"]> = {
  EV: {
    line: { color: "#a10011" },
    fill: { color: "#b10022" },
    point: { color: "#c10033", fillColor: "#c10033" },
    gradient: { color: "#d10044" },
  },
  EV1: {
    line: { color: "#115500" },
    fill: { color: "#227700" },
    point: { color: "#339900", fillColor: "#339900" },
    gradient: { color: "#44bb00" },
  },
  EV2: {
    line: { color: "#001199" },
    fill: { color: "#0022bb" },
    point: { color: "#0033dd", fillColor: "#0033dd" },
    gradient: { color: "#0044ff" },
  },
  "TC1.6": {
    line: { color: "#7a0f70" },
    fill: { color: "#c71db8" },
    point: { color: "#ff4be9", fillColor: "#ff4be9" },
    gradient: { color: "#ff8ff3" },
  },
};

function opaqueRgba(hex: string): string {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex);
  assert.ok(match, `expected hex color, received ${hex}`);
  const rgb = match![1];
  return `rgba(${parseInt(rgb.slice(0, 2), 16)}, ${parseInt(rgb.slice(2, 4), 16)}, ${parseInt(rgb.slice(4, 6), 16)}, 1)`;
}

function belongsToGroup(entry: Record<string, unknown>, groupKey: string): boolean {
  const name = typeof entry.name === "string" ? entry.name : "";
  const id = typeof entry.id === "string" ? entry.id : "";
  return name === groupKey
    || name.startsWith(`${groupKey} `)
    || name.startsWith(`${groupKey}_`)
    || id.startsWith(`${groupKey}__`)
    || id.startsWith(`${groupKey}_`);
}

function assertSeriesMatchesResolvedGroupStyle(
  entry: Record<string, unknown>,
  expected: NonNullable<GraphSpec["styles"]>[typeof STYLE_MATRIX_TARGET_GROUP],
  label: string,
): void {
  const type = String(entry.type ?? "");
  if (type === "scatter") {
    const itemStyle = entry.itemStyle as { color?: string; borderColor?: string } | undefined;
    assert.equal(itemStyle?.color, expected.point?.color, `${label} scatter fill must use point style color`);
    assert.equal(itemStyle?.borderColor, expected.point?.color, `${label} scatter border must use point style color`);
    return;
  }
  if (type === "line") {
    const lineStyle = entry.lineStyle as { color?: string } | undefined;
    const itemStyle = entry.itemStyle as { color?: string } | undefined;
    const areaStyle = entry.areaStyle as { color?: string } | undefined;
    if (lineStyle) {
      assert.equal(lineStyle.color, expected.line?.color, `${label} line stroke must use line style color`);
    }
    if (itemStyle) {
      assert.equal(itemStyle.color, expected.line?.color, `${label} line itemStyle must use line style color`);
    }
    if (areaStyle) {
      const id = typeof entry.id === "string" ? entry.id : "";
      const expectedAreaColor = id.includes("_fit") || id.endsWith("__band_hi")
        ? expected.line?.color
        : expected.fill?.color;
      assert.equal(areaStyle.color, expectedAreaColor, `${label} filled line area must use the expected group style color`);
    }
    return;
  }
  if (type === "bar" || type === "heatmap") {
    const itemStyle = entry.itemStyle as { color?: string } | undefined;
    assert.equal(itemStyle?.color, expected.fill?.color, `${label} ${type} fill must use fill style color`);
    return;
  }
  if (type === "boxplot") {
    const itemStyle = entry.itemStyle as { color?: string; borderColor?: string } | undefined;
    assert.equal(itemStyle?.color, opaqueRgba(expected.fill?.color ?? ""), `${label} box fill must use fill style color`);
    assert.equal(itemStyle?.borderColor, opaqueRgba(expected.line?.color ?? ""), `${label} box border must use line style color`);
  }
}

function assertTargetGroupSeriesStyled(
  series: Array<Record<string, unknown>>,
  label: string,
): void {
  const matching = series.filter((entry) => belongsToGroup(entry, STYLE_MATRIX_TARGET_GROUP));
  assert.ok(matching.length > 0, `${label} must emit at least one ${STYLE_MATRIX_TARGET_GROUP} series`);
  for (const entry of matching) {
    assertSeriesMatchesResolvedGroupStyle(entry, STYLE_MATRIX_STYLES[STYLE_MATRIX_TARGET_GROUP], label);
  }
}

function assertPanelKeepsMissingMiddleGap(
  series: Array<Record<string, unknown>>,
  label: string,
): void {
  assert.equal(
    series.some((entry) => belongsToGroup(entry, "EV2")),
    false,
    `${label} should keep EV2 absent in Panel-A instead of reindexing later groups`,
  );
}

function styleMatrixPointFrame(aggregates: GraphDataFrame["aggregates"] = []): GraphDataFrame {
  const bitmask = new Uint8Array([0xff, 0x03]);
  return {
    ...frameBackedAggregateFrame(aggregates, 10),
    dictionaries: {
      group: [...STYLE_MATRIX_GROUP_ORDER],
      facetX: [...STYLE_MATRIX_PANEL_ORDER],
    },
    extents: {
      x: { min: 1, max: 4 },
      y: { min: 1, max: 6.5 },
    },
    rawChunks: [{
      chunkIndex: 0,
      rowOffset: 0,
      rowCount: 10,
      xValues: new Float64Array([1, 2, 2, 3, 4, 1, 2, 2, 3, 4]),
      yValues: new Float64Array([1.1, 1.8, 2.4, 3.2, 4.1, 1.2, 2.2, 3.7, 4.8, 6.1]),
      rowIds: new BigInt64Array([1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n, 9n, 10n]),
      groupCodes: new Uint32Array([0, 1, 3, 3, 3, 0, 2, 3, 3, 3]),
      facetXCodes: new Uint32Array([0, 0, 0, 0, 0, 1, 1, 1, 1, 1]),
      validity: {
        x: bitmask,
        y: bitmask,
        group: bitmask,
        facetX: bitmask,
      },
    }],
    aggregates,
  };
}

function styleMatrixAggregateOnlyFrame(aggregates: GraphDataFrame["aggregates"]): GraphDataFrame {
  return {
    ...frameBackedAggregateFrame(aggregates, 10),
    dictionaries: {
      group: [...STYLE_MATRIX_GROUP_ORDER],
      facetX: [...STYLE_MATRIX_PANEL_ORDER],
    },
    aggregates,
  };
}

function styleMatrixBoxPlotPacket(): GraphDataFrame["aggregates"][number] {
  return {
    kind: "boxPlot",
    xColumn: "x",
    yColumn: "y",
    groupColumn: "Build",
    entries: [
      { group: "EV", facetX: "Panel-A", category: "1", count: 4, min: 1, q1: 1.1, median: 1.2, q3: 1.3, max: 1.4, whiskerLow: 1, whiskerHigh: 1.4, outliers: [] },
      { group: "EV1", facetX: "Panel-A", category: "1", count: 4, min: 1.5, q1: 1.6, median: 1.7, q3: 1.8, max: 1.9, whiskerLow: 1.5, whiskerHigh: 1.9, outliers: [] },
      { group: "TC1.6", facetX: "Panel-A", category: "1", count: 4, min: 3.1, q1: 3.3, median: 3.5, q3: 3.7, max: 3.9, whiskerLow: 3.1, whiskerHigh: 3.9, outliers: [] },
      { group: "EV", facetX: "Panel-B", category: "1", count: 4, min: 1.1, q1: 1.2, median: 1.3, q3: 1.4, max: 1.5, whiskerLow: 1.1, whiskerHigh: 1.5, outliers: [] },
      { group: "EV2", facetX: "Panel-B", category: "1", count: 4, min: 2.1, q1: 2.2, median: 2.3, q3: 2.4, max: 2.5, whiskerLow: 2.1, whiskerHigh: 2.5, outliers: [] },
      { group: "TC1.6", facetX: "Panel-B", category: "1", count: 4, min: 4.2, q1: 4.4, median: 4.6, q3: 4.8, max: 5, whiskerLow: 4.2, whiskerHigh: 5, outliers: [] },
    ],
  };
}

function styleMatrixHistogramPacket(): GraphDataFrame["aggregates"][number] {
  return {
    kind: "histogram",
    xColumn: "x",
    yColumn: "y",
    groupColumn: "Build",
    binCount: 2,
    minValue: 0,
    maxValue: 4,
    missingCount: 0,
    binWidth: 2,
    totalCount: 12,
    bins: [
      { group: "EV", facetX: "Panel-A", binStart: 0, binEnd: 2, count: 2 },
      { group: "EV1", facetX: "Panel-A", binStart: 0, binEnd: 2, count: 2 },
      { group: "TC1.6", facetX: "Panel-A", binStart: 0, binEnd: 2, count: 3 },
      { group: "TC1.6", facetX: "Panel-A", binStart: 2, binEnd: 4, count: 2 },
      { group: "EV", facetX: "Panel-B", binStart: 0, binEnd: 2, count: 2 },
      { group: "EV2", facetX: "Panel-B", binStart: 0, binEnd: 2, count: 2 },
      { group: "TC1.6", facetX: "Panel-B", binStart: 0, binEnd: 2, count: 1 },
      { group: "TC1.6", facetX: "Panel-B", binStart: 2, binEnd: 4, count: 2 },
    ],
  };
}

function styleMatrixHeatmapPacket(): GraphDataFrame["aggregates"][number] {
  return {
    kind: "heatmap",
    xColumn: "x",
    yColumn: "y",
    groupColumn: "Build",
    xBinCount: 1,
    yBinCount: 1,
    xMin: 0,
    xMax: 2,
    yMin: 0,
    yMax: 2,
    missingCount: 0,
    xBinWidth: 2,
    yBinWidth: 2,
    totalCount: 6,
    cells: [
      { group: "EV", facetX: "Panel-A", xBinIndex: 0, yBinIndex: 0, xBinStart: 0, xBinEnd: 2, yBinStart: 0, yBinEnd: 2, count: 1 },
      { group: "EV1", facetX: "Panel-A", xBinIndex: 0, yBinIndex: 0, xBinStart: 0, xBinEnd: 2, yBinStart: 0, yBinEnd: 2, count: 1 },
      { group: "TC1.6", facetX: "Panel-A", xBinIndex: 0, yBinIndex: 0, xBinStart: 0, xBinEnd: 2, yBinStart: 0, yBinEnd: 2, count: 2 },
      { group: "EV", facetX: "Panel-B", xBinIndex: 0, yBinIndex: 0, xBinStart: 0, xBinEnd: 2, yBinStart: 0, yBinEnd: 2, count: 1 },
      { group: "EV2", facetX: "Panel-B", xBinIndex: 0, yBinIndex: 0, xBinStart: 0, xBinEnd: 2, yBinStart: 0, yBinEnd: 2, count: 1 },
      { group: "TC1.6", facetX: "Panel-B", xBinIndex: 0, yBinIndex: 0, xBinStart: 0, xBinEnd: 2, yBinStart: 0, yBinEnd: 2, count: 2 },
    ],
  };
}

for (const mode of ["uniform", "normal"] as const) {
  for (const data of [
    baseData(
      ["_row_id", "category", "value"],
      [[101, "A", 10], [102, "A", 10], [103, "A", 10]],
    ),
    baseData(
      ["category", "value"],
      [["A", 10], ["A", 10], ["A", 10]],
    ),
  ]) {
    const spec: GraphSpec = {
      encoding: {
        x: { name: "category", type: "nominal" },
        y: { name: "value", type: "continuous" },
      },
      elements: [{
        kind: "points",
        enabled: true,
        options: { summaryStat: "none", jitter: mode, jitterLimit: 0.5 },
      }],
    };
    const first = JSON.stringify(buildGraph(spec, data, theme));
    const second = JSON.stringify(buildGraph(spec, data, theme));
    assert.equal(
      second,
      first,
      `repeated legacy ${mode} builds must be identical with ${data.columns.includes("_row_id") ? "row IDs" : "source-index fallback"}`,
    );
  }
}

{
  const data = frameBackedAggregateData(["event_date", "cost"], 4);
  const pointsSpec: GraphSpec = {
    encoding: {
      x: { name: "event_date", type: "datetime" },
      y: { name: "cost", type: "continuous" },
    },
    elements: [{ kind: "points", enabled: true, options: { summaryStat: "none" } }],
  };
  const built = buildGraph(pointsSpec, data, theme, undefined, typedDateFrame());
  const panel = built.panels[0];
  const xAxis = panel.option.xAxis as { type?: string; data?: string[] };
  assert.equal(xAxis.type, "time");
  assert.equal(xAxis.data, undefined);
  assert.ok(Number(xAxis.min) <= Date.parse("2026-01-01"));
  assert.ok(Number(xAxis.max) >= Date.parse("2026-01-02"));
  const pointSeries = panelSeries(panel.option as Record<string, unknown>)
    .filter((entry) => entry.type === "scatter");
  assert.equal(pointSeries.length, 1, "frame-backed date points must also emit ECharts scatter");
  const dateValues = (pointSeries[0].data as Array<{ value: [number, number] }>)
    .map((item) => item.value[0]);
  assert.deepEqual(dateValues, [
    Date.parse("2026-01-01"),
    Date.parse("2026-01-01"),
    Date.parse("2026-01-02"),
    Date.parse("2026-01-02"),
  ]);
}

{
  const spec: GraphSpec = {
    encoding: {
      x: { name: "measurement", type: "continuous" },
    },
    elements: [{ kind: "points", enabled: true, options: { summaryStat: "none" } }],
  };
  const frame: GraphDataFrame = {
    ...frameBackedAggregateFrame([], 3),
    extents: { x: { min: 11, max: 33 } },
    rawChunks: [{
      chunkIndex: 0,
      rowOffset: 0,
      rowCount: 3,
      xValues: new Float64Array([11, 22, 33]),
      yValues: new Float64Array([101, 202, 303]),
      rowIds: new BigInt64Array([1n, 2n, 3n]),
      validity: {
        x: new Uint8Array([0b00000111]),
        y: new Uint8Array([0b00000111]),
      },
    }],
  };

  const items = frameScatterValues(buildGraph(
    spec,
    frameBackedAggregateData(["measurement"], 3),
    theme,
    undefined,
    frame,
  ).panels[0]);
  assert.deepEqual(items.map((item) => item.value), [[11, ""], [22, ""], [33, ""]]);
  assert.ok(items.every((item) => item.__pick?.colName === "measurement"));
}

{
  const spec: GraphSpec = {
    encoding: {
      x: { name: "measurement", type: "continuous" },
      y: { name: "region", type: "nominal" },
    },
    elements: [{ kind: "points", enabled: true, options: { summaryStat: "none" } }],
  };
  const frame: GraphDataFrame = {
    ...frameBackedAggregateFrame([], 4),
    dictionaries: { y: ["East", "West"] },
    extents: { x: { min: 10, max: 40 } },
    rawChunks: [{
      chunkIndex: 0,
      rowOffset: 0,
      rowCount: 4,
      xValues: new Float64Array([10, 20, 30, 40]),
      yValues: new Float64Array([0, 1, 0, 1]),
      rowIds: new BigInt64Array([11n, 12n, 13n, 14n]),
      validity: {
        x: new Uint8Array([0b00001111]),
        y: new Uint8Array([0b00001111]),
      },
    }],
  };

  const items = frameScatterValues(buildGraph(
    spec,
    frameBackedAggregateData(["measurement", "region"], 4),
    theme,
    { region: ["East", "West"] },
    frame,
  ).panels[0]);
  assert.deepEqual(items.map((item) => item.value), [
    [10, "East"],
    [20, "West"],
    [30, "East"],
    [40, "West"],
  ]);
  assert.ok(items.every((item) => item.__pick?.colName === "measurement"));
}

{
  const data = frameBackedAggregateData(["event_date", "cost"], 4);
  const boxPacket: GraphDataFrame["aggregates"][number] = {
    kind: "boxPlot",
    xColumn: "event_date",
    yColumn: "cost",
    entries: [
      {
        category: "2026-01-01",
        count: 2,
        min: 2,
        q1: 2.5,
        median: 3.5,
        q3: 4.5,
        max: 5,
        whiskerLow: 2,
        whiskerHigh: 5,
        outliers: [],
      },
      {
        category: "2026-01-02",
        count: 2,
        min: 6,
        q1: 6.5,
        median: 7.5,
        q3: 8.5,
        max: 9,
        whiskerLow: 6,
        whiskerHigh: 9,
        outliers: [],
      },
    ],
  };
  const spec: GraphSpec = {
    encoding: {
      x: { name: "event_date", type: "datetime" },
      y: { name: "cost", type: "continuous" },
    },
    elements: [
      { kind: "points", enabled: true, options: { summaryStat: "none" } },
      { kind: "boxplot", enabled: true },
    ],
  };
  const panel = buildGraph(spec, data, theme, undefined, typedDateFrame([boxPacket])).panels[0];
  const series = panelSeries(panel.option as Record<string, unknown>);
  assert.ok(series.some((entry) => entry.type === "scatter" && Array.isArray(entry.data) && entry.data.length > 0));
  assert.ok(series.some((entry) => entry.type === "boxplot"));
}

for (const element of [
  { kind: "line", enabled: true, options: { summaryStat: "none" } },
  { kind: "bar", enabled: true },
  { kind: "smoother", enabled: true },
  { kind: "fitline", enabled: true, options: { degree: 1 } },
] satisfies GraphSpec["elements"]) {
  const spec: GraphSpec = {
    encoding: {
      x: { name: "x", type: "continuous" },
      y: { name: "y", type: "continuous" },
    },
    elements: [element],
  };
  const series = panelSeries(
    buildGraph(spec, frameBackedAggregateData(["x", "y"], 6), theme, undefined, typedNumericFrame())
      .panels[0].option as Record<string, unknown>,
  );
  assert.ok(series.length > 0, `frame-backed ${element.kind} must emit a renderable series`);
  assert.ok(series.some((entry) => Array.isArray(entry.data) && entry.data.length > 0));
}

{
  const spec: GraphSpec = {
    encoding: {
      x: { name: "x", type: "continuous" },
      y: { name: "y", type: "continuous" },
      color: { name: "region", type: "nominal" },
    },
    elements: [{ kind: "line", enabled: true, options: { summaryStat: "none" } }],
  };
  const series = panelSeries(
    buildGraph(
      spec,
      frameBackedAggregateData(["x", "y", "region"], 6),
      theme,
      undefined,
      typedGroupedNumericFrame(),
    ).panels[0].option as Record<string, unknown>,
  ).filter((entry) => entry.type === "line");
  assert.deepEqual(series.map((entry) => entry.name), ["East", "West"]);
  assert.ok(series.every((entry) => Array.isArray(entry.data) && entry.data.length === 3));
}

{
  const spec: GraphSpec = {
    encoding: {
      x: { name: "x", type: "continuous" },
      y: { name: "y", type: "continuous" },
      color: { name: "region", type: "nominal" },
    },
    elements: [{ kind: "points", enabled: true, options: { summaryStat: "none" } }],
    hiddenGroups: ["West"],
    styles: {
      East: { point: { color: "#123456", markerSize: 8, opacity: 1 } },
    },
  };
  const panel = buildGraph(
    spec,
    frameBackedAggregateData(["x", "y", "region"], 6),
    theme,
    undefined,
    typedGroupedNumericFrame(),
  ).panels[0];
  const pointSeries = panelSeries(panel.option as Record<string, unknown>)
    .filter((entry) => entry.type === "scatter");
  assert.deepEqual(pointSeries.map((entry) => entry.name), ["East"]);
  assert.equal(pointSeries[0].symbol, "circle");
  assert.equal(pointSeries[0].symbolSize, 8);
  assert.equal(pointSeries[0].progressive, 0);
  assert.notEqual(pointSeries[0].large, true);
  assert.deepEqual(pointSeries[0].itemStyle, {
    color: "#123456",
    borderColor: "#123456",
    opacity: 1,
  });
  const pointItems = pointSeries[0].data as Array<{
    value: [number, number];
    symbolOffset: [number, number];
    __pick: { rowId: number; colName: string };
  }>;
  assert.equal(pointItems.length, 3);
  assert.ok(pointItems.every((item) => item.__pick.colName === "y"));
  assert.ok(pointItems.every((item) => Array.isArray(item.symbolOffset)));
}

{
  const spec: GraphSpec = {
    encoding: {
      x: { name: "x", type: "continuous" },
      y: { name: "y", type: "continuous" },
      color: { name: "region", type: "nominal" },
    },
    elements: [{ kind: "points", enabled: true, options: { summaryStat: "none" } }],
    hiddenGroups: ["West"],
  };
  const rows = [
    [1, 10, "East"],
    [2, 20, "East"],
    [-1000, -2000, "West"],
    [1000, 2000, "West"],
  ];
  const frame: GraphDataFrame = {
    ...frameBackedAggregateFrame([], 4),
    dictionaries: { group: ["East", "West"] },
    extents: {
      x: { min: -1000, max: 1000 },
      y: { min: -2000, max: 2000 },
    },
    rawChunks: [{
      chunkIndex: 0,
      rowOffset: 0,
      rowCount: 4,
      xValues: new Float64Array([1, 2, -1000, 1000]),
      yValues: new Float64Array([10, 20, -2000, 2000]),
      rowIds: new BigInt64Array([1n, 2n, 3n, 4n]),
      groupCodes: new Uint32Array([0, 0, 1, 1]),
      validity: {
        x: new Uint8Array([0b00001111]),
        y: new Uint8Array([0b00001111]),
        group: new Uint8Array([0b00001111]),
      },
    }],
  };
  const legacyPanel = buildGraph(
    spec,
    baseData(["x", "y", "region"], rows),
    theme,
    { region: ["East", "West"] },
  ).panels[0];
  const framePanel = buildGraph(
    spec,
    frameBackedAggregateData(["x", "y", "region"], 4),
    theme,
    { region: ["East", "West"] },
    frame,
  ).panels[0];
  const legacyXAxis = legacyPanel.option.xAxis as { min?: number; max?: number };
  const legacyYAxis = legacyPanel.option.yAxis as { min?: number; max?: number };
  const frameXAxis = framePanel.option.xAxis as { min?: number; max?: number };
  const frameYAxis = framePanel.option.yAxis as { min?: number; max?: number };
  assert.deepEqual(
    { min: frameXAxis.min, max: frameXAxis.max },
    { min: legacyXAxis.min, max: legacyXAxis.max },
    "frame-backed point-only X bounds must match legacy hidden-group filtering",
  );
  assert.deepEqual(
    { min: frameYAxis.min, max: frameYAxis.max },
    { min: legacyYAxis.min, max: legacyYAxis.max },
    "frame-backed point-only Y bounds must match legacy hidden-group filtering",
  );
}

{
  const spec: GraphSpec = {
    encoding: {
      x: { name: "x", type: "continuous" },
      y: { name: "y", type: "continuous" },
      color: { name: "region", type: "nominal" },
    },
    elements: [{ kind: "points", enabled: true, options: { summaryStat: "none" } }],
    hiddenGroups: ["East"],
  };
  const panel = buildGraph(
    spec,
    frameBackedAggregateData(["x", "y", "region"], 6),
    theme,
    undefined,
    typedGroupedNumericFrame(),
  ).panels[0];
  const pointSeries = panelSeries(panel.option as Record<string, unknown>)
    .filter((entry) => entry.type === "scatter");
  assert.deepEqual(pointSeries.map((entry) => entry.name), ["West"]);
  assert.equal(
    (pointSeries[0].itemStyle as { color?: string }).color,
    "#cc660b",
    "hidden groups must not shift later groups into an earlier palette slot",
  );
}

{
  const spec: GraphSpec = {
    encoding: {
      x: { name: "x", type: "continuous" },
      y: { name: "y", type: "continuous" },
    },
    elements: [{
      kind: "points",
      enabled: true,
      options: { summaryStat: "none", jitter: "normal", jitterLimit: 0.75 },
    }],
  };
  const panel = buildGraph(
    spec,
    frameBackedAggregateData(["x", "y"], 6),
    theme,
    undefined,
    typedNumericFrame(),
  ).panels[0];
  const pointItems = panelSeries(panel.option as Record<string, unknown>)
    .filter((entry) => entry.type === "scatter")
    .flatMap((entry) => entry.data as Array<{ symbolOffset: [number, number] }>);
  assert.ok(pointItems.length > 0);
  assert.ok(pointItems.some((item) => item.symbolOffset[0] !== 0));
}

{
  const summaryPacket: GraphDataFrame["aggregates"][number] = {
    kind: "summary",
    xColumn: "x",
    yColumn: "y",
    summaries: [{
      category: "1",
      count: 6,
      mean: 6.67,
      median: 6.5,
      stddev: 3.6,
      min: 2,
      max: 12,
    }],
  };
  for (const kind of ["points", "line"] as const) {
    const spec: GraphSpec = {
      encoding: {
        x: { name: "x", type: "continuous" },
        y: { name: "y", type: "continuous" },
      },
      elements: [{ kind, enabled: true, options: { summaryStat: "mean", errorInterval: "none" } }],
    };
    const series = panelSeries(
      buildGraph(
        spec,
        frameBackedAggregateData(["x", "y"], 6),
        theme,
        undefined,
        typedNumericFrame([summaryPacket]),
      ).panels[0].option as Record<string, unknown>,
    );
    assert.ok(series.length > 0, `summary packet must render standalone ${kind}`);
  }
}

{
  const overlayElements: GraphSpec["elements"] = [
    { kind: "points", enabled: true, options: { summaryStat: "none" } },
    { kind: "line", enabled: true, options: { summaryStat: "none" } },
    { kind: "bar", enabled: true },
    { kind: "smoother", enabled: true },
    { kind: "fitline", enabled: true, options: { degree: 1 } },
  ];
  for (const overlay of overlayElements.slice(1)) {
    const spec: GraphSpec = {
      encoding: {
        x: { name: "x", type: "continuous" },
        y: { name: "y", type: "continuous" },
      },
      elements: [overlayElements[0], overlay],
    };
    const panel = buildGraph(
      spec,
      frameBackedAggregateData(["x", "y"], 6),
      theme,
      undefined,
      typedNumericFrame(),
    ).panels[0];
    assert.ok(
      panelSeries(panel.option as Record<string, unknown>).some(
        (entry) => entry.type === "scatter" && Array.isArray(entry.data) && entry.data.length > 0,
      ),
      `points + ${overlay.kind} must retain ECharts points`,
    );
    assert.ok(
      panelSeries(panel.option as Record<string, unknown>).some(
        (entry) => Array.isArray(entry.data) && entry.data.length > 0,
      ),
      `points + ${overlay.kind} must emit the overlay series`,
    );
  }
}

{
  const spec: GraphSpec = {
    encoding: {
      x: { name: "x", type: "continuous" },
      y: { name: "y", type: "continuous" },
      groupX: { name: "panel", type: "nominal" },
    },
    elements: [{ kind: "line", enabled: true, options: { summaryStat: "none" } }],
  };
  const built = buildGraph(
    spec,
    frameBackedAggregateData(["x", "y", "panel"], 6),
    theme,
    undefined,
    typedFacetedNumericFrame(),
  );
  assert.equal(built.panels.length, 2);
  for (const panel of built.panels) {
    const line = panelSeries(panel.option as Record<string, unknown>).find((entry) => entry.type === "line");
    assert.ok(line);
    assert.equal((line?.data as unknown[]).length, 3, `facet ${panel.title} must contain only its rows`);
  }
}

{
  const spec: GraphSpec = {
    encoding: {
      x: { name: "x", type: "continuous" },
      y: { name: "y", type: "continuous" },
      groupX: { name: "panel", type: "nominal" },
    },
    elements: [{ kind: "points", enabled: true, options: { summaryStat: "none" } }],
  };
  const built = buildGraph(
    spec,
    frameBackedAggregateData(["x", "y", "panel"], 6),
    theme,
    undefined,
    typedFacetedNumericFrame(),
  );
  assert.equal(built.panels.length, 2);
  for (const panel of built.panels) {
    const scatter = panelSeries(panel.option as Record<string, unknown>)
      .find((entry) => entry.type === "scatter");
    assert.ok(scatter, `facet ${panel.title} must emit frame-backed scatter`);
    assert.equal((scatter.data as unknown[]).length, 3, `facet ${panel.title} must contain only its points`);
  }
}

{
  const spec: GraphSpec = {
    encoding: {
      x: { name: "x", type: "continuous" },
      y: { name: "y", type: "continuous" },
      overlay: { name: "Build", type: "nominal" },
      color: { name: "Shade", type: "nominal" },
      groupX: { name: "panel", type: "nominal" },
    },
    styles: STYLE_MATRIX_STYLES,
    elements: [{ kind: "line", enabled: true, options: { summaryStat: "none" } }],
  };
  const data = baseData(
    ["panel", "x", "y", "Build", "Shade"],
    [
      ["Panel-A", 1, 1.1, "EV", "S-EV"],
      ["Panel-A", 2, 1.8, "EV1", "S-EV1"],
      ["Panel-A", 2, 2.4, "TC1.6", "S-TC"],
      ["Panel-A", 3, 3.2, "TC1.6", "S-TC"],
      ["Panel-A", 4, 4.1, "TC1.6", "S-TC"],
      ["Panel-B", 1, 1.2, "EV", "S-EV"],
      ["Panel-B", 2, 2.2, "EV2", "S-EV2"],
      ["Panel-B", 2, 3.7, "TC1.6", "S-TC"],
      ["Panel-B", 3, 4.8, "TC1.6", "S-TC"],
      ["Panel-B", 4, 6.1, "TC1.6", "S-TC"],
    ],
  );
  const panel = buildGraph(spec, data, theme, STYLE_MATRIX_VALUE_ORDERS).panels[0];
  const series = panelSeries(panel.option as Record<string, unknown>);
  assertPanelKeepsMissingMiddleGap(series, "overlay precedence panel");
  assertTargetGroupSeriesStyled(series, "overlay precedence panel");
}

{
  const styleMatrixCases: Array<{
    name: string;
    spec: GraphSpec;
    data: GraphData;
    frame?: GraphDataFrame;
    verify?: (option: Record<string, unknown>, series: Array<Record<string, unknown>>) => void;
  }> = [
    {
      name: "boxplot",
      spec: {
        encoding: {
          x: { name: "x", type: "continuous" },
          y: { name: "y", type: "continuous" },
          overlay: { name: "Build", type: "nominal" },
          groupX: { name: "panel", type: "nominal" },
        },
        styles: STYLE_MATRIX_STYLES,
        elements: [{ kind: "boxplot", enabled: true }],
      },
      data: frameBackedAggregateData(["x", "y", "Build"], 10),
      frame: styleMatrixPointFrame([styleMatrixBoxPlotPacket()]),
    },
    {
      name: "boxplot + points",
      spec: {
        encoding: {
          x: { name: "x", type: "continuous" },
          y: { name: "y", type: "continuous" },
          overlay: { name: "Build", type: "nominal" },
          groupX: { name: "panel", type: "nominal" },
        },
        styles: STYLE_MATRIX_STYLES,
        elements: [
          { kind: "boxplot", enabled: true },
          { kind: "points", enabled: true, options: { summaryStat: "none" } },
        ],
      },
      data: frameBackedAggregateData(["x", "y", "Build"], 10),
      frame: styleMatrixPointFrame([styleMatrixBoxPlotPacket()]),
    },
    {
      name: "points + boxplot",
      spec: {
        encoding: {
          x: { name: "x", type: "continuous" },
          y: { name: "y", type: "continuous" },
          overlay: { name: "Build", type: "nominal" },
          groupX: { name: "panel", type: "nominal" },
        },
        styles: STYLE_MATRIX_STYLES,
        elements: [
          { kind: "points", enabled: true, options: { summaryStat: "none" } },
          { kind: "boxplot", enabled: true },
        ],
      },
      data: frameBackedAggregateData(["x", "y", "Build"], 10),
      frame: styleMatrixPointFrame([styleMatrixBoxPlotPacket()]),
    },
    {
      name: "line + bar + smoother + fitline",
      spec: {
        encoding: {
          x: { name: "x", type: "continuous" },
          y: { name: "y", type: "continuous" },
          overlay: { name: "Build", type: "nominal" },
          color: { name: "Shade", type: "nominal" },
          groupX: { name: "panel", type: "nominal" },
        },
        styles: STYLE_MATRIX_STYLES,
        elements: [
          { kind: "line", enabled: true, options: { summaryStat: "none" } },
          { kind: "bar", enabled: true },
          { kind: "smoother", enabled: true },
          { kind: "fitline", enabled: true, options: { degree: 1, showFitCI: true, showPredCI: true } },
        ],
      },
      data: baseData(
        ["panel", "x", "y", "Build", "Shade"],
        [
          ["Panel-A", 1, 1.1, "EV", "S-EV"],
          ["Panel-A", 2, 1.8, "EV1", "S-EV1"],
          ["Panel-A", 2, 2.4, "TC1.6", "S-TC"],
          ["Panel-A", 3, 3.2, "TC1.6", "S-TC"],
          ["Panel-A", 4, 4.1, "TC1.6", "S-TC"],
          ["Panel-B", 1, 1.2, "EV", "S-EV"],
          ["Panel-B", 2, 2.2, "EV2", "S-EV2"],
          ["Panel-B", 2, 3.7, "TC1.6", "S-TC"],
          ["Panel-B", 3, 4.8, "TC1.6", "S-TC"],
          ["Panel-B", 4, 6.1, "TC1.6", "S-TC"],
        ],
      ),
    },
    {
      name: "histogram + points",
      spec: {
        encoding: {
          x: { name: "x", type: "continuous" },
          y: { name: "y", type: "continuous" },
          overlay: { name: "Build", type: "nominal" },
          groupX: { name: "panel", type: "nominal" },
        },
        styles: STYLE_MATRIX_STYLES,
        elements: [
          { kind: "histogram", enabled: true, options: { histStyle: "bar" } },
          { kind: "points", enabled: true, options: { summaryStat: "none" } },
        ],
      },
      data: frameBackedAggregateData(["x", "y", "Build"], 10),
      frame: styleMatrixAggregateOnlyFrame([styleMatrixHistogramPacket()]),
    },
    {
      name: "heatmap",
      spec: {
        encoding: {
          x: { name: "x", type: "continuous" },
          y: { name: "y", type: "continuous" },
          overlay: { name: "Build", type: "nominal" },
          groupX: { name: "panel", type: "nominal" },
        },
        styles: STYLE_MATRIX_STYLES,
        elements: [{ kind: "heatmap", enabled: true }],
      },
      data: frameBackedAggregateData(["x", "y", "Build"], 10),
      frame: styleMatrixAggregateOnlyFrame([styleMatrixHeatmapPacket()]),
      verify: (option) => {
        assert.equal(
          "visualMap" in option,
          false,
          "grouped heatmap should not expose an option-level visualMap that overrides group fill color",
        );
      },
    },
  ];

  for (const testCase of styleMatrixCases) {
    const built = buildGraph(testCase.spec, testCase.data, theme, STYLE_MATRIX_VALUE_ORDERS, testCase.frame);
    assert.equal(built.panels.length, 2, `${testCase.name} should preserve both facet panels`);
    const panel = built.panels[0];
    const option = panel.option as Record<string, unknown>;
    const series = panelSeries(option);
    assertPanelKeepsMissingMiddleGap(series, testCase.name);
    assertTargetGroupSeriesStyled(series, testCase.name);
    testCase.verify?.(option, series);
  }
}

{
  const packetOverlays: Array<{
    name: string;
    element: GraphSpec["elements"][number];
    packet: GraphDataFrame["aggregates"][number];
    seriesType: string;
  }> = [
    {
      name: "histogram",
      element: { kind: "histogram", enabled: true, options: { histStyle: "bar" } },
      packet: {
        kind: "histogram",
        xColumn: "x",
        yColumn: "y",
        binCount: 2,
        minValue: 0,
        maxValue: 12,
        missingCount: 0,
        binWidth: 6,
        totalCount: 6,
        bins: [
          { category: "A", binStart: 0, binEnd: 6, count: 2 },
          { category: "A", binStart: 6, binEnd: 12, count: 1 },
          { category: "B", binStart: 0, binEnd: 6, count: 1 },
          { category: "B", binStart: 6, binEnd: 12, count: 2 },
        ],
      },
      seriesType: "custom",
    },
    {
      name: "heatmap",
      element: { kind: "heatmap", enabled: true },
      packet: {
        kind: "heatmap",
        xColumn: "x",
        yColumn: "y",
        xBinCount: 1,
        yBinCount: 1,
        xMin: 1,
        xMax: 6,
        yMin: 2,
        yMax: 12,
        missingCount: 0,
        xBinWidth: 5,
        yBinWidth: 10,
        totalCount: 6,
        cells: [{
          xBinIndex: 0,
          yBinIndex: 0,
          xBinStart: 1,
          xBinEnd: 6,
          yBinStart: 2,
          yBinEnd: 12,
          count: 6,
        }],
      },
      seriesType: "heatmap",
    },
  ];
  for (const overlay of packetOverlays) {
    const histogramMode = overlay.name === "histogram";
    const spec: GraphSpec = {
      encoding: {
        x: { name: "x", type: histogramMode ? "nominal" : "continuous" },
        y: { name: "y", type: "continuous" },
      },
      elements: [
        { kind: "points", enabled: true, options: { summaryStat: "none" } },
        overlay.element,
      ],
    };
    const numericFrame = typedNumericFrame([overlay.packet]);
    const frame = histogramMode
      ? {
        ...numericFrame,
        dictionaries: { ...numericFrame.dictionaries, x: ["A", "B"] },
        rawChunks: numericFrame.rawChunks.map((chunk) => ({
          ...chunk,
          xValues: new Uint32Array([0, 0, 0, 1, 1, 1]),
        })),
      }
      : numericFrame;
    const panel = buildGraph(
      spec,
      frameBackedAggregateData(["x", "y"], 6),
      theme,
      undefined,
      frame,
    ).panels[0];
    assert.ok(
      panelSeries(panel.option as Record<string, unknown>).some(
        (entry) => entry.type === "scatter" && Array.isArray(entry.data) && entry.data.length > 0,
      ),
      `points + ${overlay.name} must retain ECharts points; emitted: ${panelSeries(panel.option as Record<string, unknown>)
        .map((entry) => `${String(entry.type)}:${Array.isArray(entry.data) ? entry.data.length : "?"}`)
        .join(", ")}`,
    );
    assert.ok(
      panelSeries(panel.option as Record<string, unknown>).some(
        (entry) => entry.type === overlay.seriesType && Array.isArray(entry.data) && entry.data.length > 0,
      ),
      `points + ${overlay.name} must emit the packet overlay`,
    );
    const xAxis = panel.option.xAxis as { min?: number; max?: number };
    const yAxis = panel.option.yAxis as { min?: number; max?: number };
    if (!histogramMode) {
      assert.deepEqual(
        { min: xAxis.min, max: xAxis.max },
        { min: 1, max: 6 },
        `points + ${overlay.name} must preserve the complete frame X extent`,
      );
    }
    if (overlay.name === "heatmap") {
      assert.deepEqual(
        { min: yAxis.min, max: yAxis.max },
        { min: 2, max: 12 },
        "points + heatmap must preserve the complete frame Y extent",
      );
    }
  }
}

{
  const throwingRows = new Proxy([] as unknown[][], {
    get(_target, prop) {
      if (prop === "length") return 2;
      throw new Error("frame-backed panel descriptor must not read legacy rows");
    },
  });

  const data = baseData(["x", "y", "wrapCol"], throwingRows);
  const spec: GraphSpec = {
    encoding: {
      x: { name: "x", type: "continuous" },
      y: { name: "y", type: "continuous" },
      wrap: { name: "wrapCol", type: "nominal" },
    },
    elements: [{ kind: "points", enabled: true, options: { summaryStat: "none" } }],
  };

  const frame: GraphDataFrame = {
    requestId: "req-wrap-roles",
    datasetId: "ds-wrap-roles",
    generation: 1,
    sourceRows: 2,
    processedRows: 2,
    sampling: { mode: "full" },
    dictionaries: {
      source: ["m2", "m1"],
      wrap: ["W1", "W2"],
    },
    extents: {},
    aggregates: [],
    rawChunks: [
      {
        chunkIndex: 0,
        rowOffset: 0,
        rowCount: 2,
        xValues: new Float64Array([1, 2]),
        yValues: new Float64Array([10, 20]),
        rowIds: new BigInt64Array([101n, 102n]),
        roleVectors: {
          source: new Uint32Array([1, 0]),
          wrap: new Uint32Array([0, 1]),
        },
        validity: {
          x: new Uint8Array([0b00000011]),
          y: new Uint8Array([0b00000011]),
          source: new Uint8Array([0b00000001]),
          wrap: new Uint8Array([0b00000011]),
        },
      },
    ],
  };

  const built = buildGraph(spec, data, theme, undefined, frame);
  const wrapPanel = built.panels.find((panel) => panel.title.includes("W2"));
  assert.ok(wrapPanel, "expected wrapped panel for W2 facet value");

  const scatter = panelSeries(wrapPanel?.option as Record<string, unknown>)
    .find((entry) => entry.type === "scatter");
  assert.ok(scatter);
  const scatterItems = scatter.data as Array<{ __pick?: { rowId: number; colName: string } }>;
  assert.deepEqual(scatterItems.map((item) => item.__pick), [
    { rowId: 102, colName: "y" },
  ]);
}

{
  const throwingRows = new Proxy([] as unknown[][], {
    get(_target, prop) {
      if (prop === "length") return 10;
      throw new Error("frame-backed descriptor must not read legacy rows in cross-byte test");
    },
  });

  const data = baseData(["x", "y", "wrapCol"], throwingRows);
  const spec: GraphSpec = {
    encoding: {
      x: { name: "x", type: "continuous" },
      y: { name: "y", type: "continuous" },
      wrap: { name: "wrapCol", type: "nominal" },
    },
    elements: [{ kind: "points", enabled: true, options: { summaryStat: "none" } }],
  };

  const frame: GraphDataFrame = {
    requestId: "req-wrap-cross-byte",
    datasetId: "ds-wrap-cross-byte",
    generation: 1,
    sourceRows: 10,
    processedRows: 10,
    sampling: { mode: "full" },
    dictionaries: {
      source: ["m1", "m2"],
      wrap: ["W1", "W2"],
    },
    extents: {},
    aggregates: [],
    rawChunks: [
      {
        chunkIndex: 0,
        rowOffset: 0,
        rowCount: 10,
        xValues: new Float64Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
        yValues: new Float64Array([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]),
        rowIds: new BigInt64Array([1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n, 9n, 10n]),
        roleVectors: {
          source: new Uint32Array([0, 1, 0, 1, 0, 1, 0, 1, 1, 0]),
          wrap: new Uint32Array([0, 1, 0, 1, 0, 1, 0, 1, 1, 0]),
        },
        validity: {
          x: new Uint8Array([0b00000011, 0b00000011]),
          y: new Uint8Array([0b00000011, 0b00000011]),
          source: new Uint8Array([0b00000001, 0b00000001]),
          wrap: new Uint8Array([0b00000001, 0b00000001]),
        },
      },
    ],
  };

  const built = buildGraph(spec, data, theme, undefined, frame);
  const wrapPanel = built.panels.find((panel) => panel.title.includes("W2"));
  assert.ok(wrapPanel, "expected wrapped panel for cross-byte wrap value");

  const scatter = panelSeries(wrapPanel?.option as Record<string, unknown>)
    .find((entry) => entry.type === "scatter");
  assert.ok(scatter);
  const picks = (scatter.data as Array<{ __pick?: { rowId: number; colName: string } }>)
    .map((item) => item.__pick);
  assert.deepEqual(picks, [
    { rowId: 9, colName: "m2" },
  ]);
}

{
  const data = baseData(["cat", "v"], []);
  const frame = baseFrame([
    {
      kind: "histogram",
      xColumn: "cat",
      yColumn: "v",
      groupColumn: "cat",
      sourceColumn: "__sp_variable__",
      binCount: 2,
      minValue: 0,
      maxValue: 2,
      missingCount: 0,
      binWidth: 1,
      totalCount: 3,
      bins: [
        { category: "A", binStart: 0, binEnd: 1, count: 2 },
        { category: "B", binStart: 1, binEnd: 2, count: 1 },
      ],
    },
  ]);

  for (const histStyle of ["bar", "polygon", "kde", "shadowgram"]) {
    const spec: GraphSpec = {
      encoding: {
        x: { name: "cat", type: "nominal" },
        y: { name: "v", type: "continuous" },
      },
      elements: [{ kind: "histogram", enabled: true, options: { histStyle } }],
    };

    const built = buildGraph(spec, data, theme, undefined, frame);
    const series = panelSeries(built.panels[0].option as Record<string, unknown>);
    assert.ok(series.length > 0, `histogram style ${histStyle} should be emitted from packet data even when rows are empty`);
  }
}

{
  const throwingRows = new Proxy([] as unknown[][], {
    get(target, prop, receiver) {
      if (prop === "length") return 0;
      if (
        prop === "map" ||
        prop === "forEach" ||
        prop === "filter" ||
        prop === "some" ||
        prop === Symbol.iterator
      ) {
        return () => {
          throw new Error("legacy rows access is forbidden for packet-backed histogram");
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });

  const data = baseData(["cat", "v"], throwingRows);
  const frame = baseFrame([
    {
      kind: "histogram",
      xColumn: "cat",
      yColumn: "v",
      groupColumn: null,
      sourceColumn: null,
      binCount: 2,
      minValue: 0,
      maxValue: 2,
      missingCount: 0,
      binWidth: 1,
      totalCount: 3,
      bins: [
        { category: "A", binStart: 0, binEnd: 1, count: 2 },
        { category: "B", binStart: 1, binEnd: 2, count: 1 },
      ],
    },
  ]);

  for (const histStyle of ["bar", "polygon", "kde", "shadowgram"]) {
    const spec: GraphSpec = {
      encoding: {
        x: { name: "cat", type: "nominal" },
        y: { name: "v", type: "continuous" },
      },
      elements: [{ kind: "histogram", enabled: true, options: { histStyle } }],
    };

    const built = buildGraph(spec, data, theme, undefined, frame);
    const series = panelSeries(built.panels[0].option as Record<string, unknown>);
    assert.ok(series.length > 0, `packet-backed histogram style ${histStyle} should render with unavailable legacy rows`);
    const fallbackSeries = series.filter((entry) => String(entry.id ?? "").startsWith("__hist_packet_fallback_"));
    assert.equal(
      fallbackSeries.length,
      0,
      `packet-backed histogram style ${histStyle} must emit its native style series instead of fallback bars`,
    );
    assert.ok(
      series.some((entry) => String(entry.id ?? "").startsWith("__hist_cat_")),
      `packet-backed histogram style ${histStyle} should emit category histogram series ids`,
    );
  }
}

{
  const inaccessibleRows = new Proxy([] as unknown[][], {
    get(target, prop, receiver) {
      if (
        prop === "length" ||
        prop === Symbol.iterator ||
        prop === "map" ||
        prop === "forEach" ||
        prop === "filter" ||
        prop === "some"
      ) {
        throw new Error("frame-backed histogram must not access legacy rows when packet extents are malformed");
      }
      return Reflect.get(target, prop, receiver);
    },
  });

  const data = baseData(["cat", "v"], inaccessibleRows);
  const frame = baseFrame([
    {
      kind: "histogram",
      xColumn: "cat",
      yColumn: "v",
      groupColumn: null,
      sourceColumn: null,
      binCount: 2,
      minValue: Number.NaN,
      maxValue: Number.NaN,
      missingCount: 0,
      binWidth: Number.NaN,
      totalCount: 2,
      bins: [
        { category: "A", binStart: Number.NaN, binEnd: Number.NaN, count: 1 },
        { category: "B", binStart: Number.NaN, binEnd: Number.NaN, count: 1 },
      ],
    },
  ]);

  const spec: GraphSpec = {
    encoding: {
      x: { name: "cat", type: "nominal" },
      y: { name: "v", type: "continuous" },
    },
    elements: [{ kind: "histogram", enabled: true, options: { histStyle: "bar" } }],
  };

  assert.doesNotThrow(() => {
    buildGraph(spec, data, theme, undefined, frame);
  }, "malformed frame-backed histogram extents must not trigger legacy rows fallback reads");
}

{
  const data = baseData(["x", "v", "grp"], []);
  const spec: GraphSpec = {
    encoding: {
      x: { name: "x", type: "continuous" },
      y: { name: "v", type: "continuous" },
      color: { name: "grp", type: "nominal" },
    },
    hiddenGroups: ["G"],
    elements: [{ kind: "histogram", enabled: true, options: { histStyle: "bar" } }],
  };

  const nonEmptyFrame = baseFrame([
    {
      kind: "histogram",
      xColumn: "x",
      yColumn: "v",
      groupColumn: "grp",
      sourceColumn: null,
      binCount: 2,
      minValue: 0,
      maxValue: 2,
      missingCount: 0,
      binWidth: 1,
      totalCount: 3,
      bins: [
        { group: "G", binStart: 0, binEnd: 1, count: 2 },
        { group: "G", binStart: 1, binEnd: 2, count: 1 },
      ],
    },
  ]);

  const nonEmptyBuilt = buildGraph(spec, data, theme, undefined, nonEmptyFrame);
  const nonEmptySeries = panelSeries(nonEmptyBuilt.panels[0].option as Record<string, unknown>);
  assert.equal(
    nonEmptySeries.some((entry) => String(entry.id ?? "").startsWith("__hist_packet_fallback_mode_a")),
    false,
    "non-empty packet must not synthesize mode-A fallback series",
  );

  const emptyFrame = baseFrame([
    {
      kind: "histogram",
      xColumn: "x",
      yColumn: "v",
      groupColumn: "grp",
      sourceColumn: null,
      binCount: 2,
      minValue: 0,
      maxValue: 2,
      missingCount: 0,
      binWidth: 1,
      totalCount: 0,
      bins: [
        { group: "G", binStart: 0, binEnd: 1, count: 2 },
        { group: "G", binStart: 1, binEnd: 2, count: 1 },
      ],
    },
  ]);

  const emptyBuilt = buildGraph(spec, data, theme, undefined, emptyFrame);
  const emptySeries = panelSeries(emptyBuilt.panels[0].option as Record<string, unknown>);
  assert.equal(
    emptySeries.some((entry) => String(entry.id ?? "").startsWith("__hist_packet_fallback_mode_a")),
    true,
    "empty packet may synthesize mode-A fallback series",
  );
}

{
  const data = baseData(["cat", "v", "grp"], []);
  const spec: GraphSpec = {
    encoding: {
      x: { name: "cat", type: "nominal" },
      y: { name: "v", type: "continuous" },
      color: { name: "grp", type: "nominal" },
    },
    hiddenGroups: ["__all__"],
    elements: [
      { kind: "histogram", enabled: true, options: { histStyle: "bar" } },
      { kind: "points", enabled: true, options: { summaryStat: "mean" } },
    ],
  };

  const nonEmptyFrame = baseFrame([
    {
      kind: "histogram",
      xColumn: "cat",
      yColumn: "v",
      groupColumn: "grp",
      sourceColumn: null,
      binCount: 2,
      minValue: 0,
      maxValue: 2,
      missingCount: 0,
      binWidth: 1,
      totalCount: 3,
      bins: [
        { category: "A", binStart: 0, binEnd: 1, count: 2 },
        { category: "B", binStart: 1, binEnd: 2, count: 1 },
      ],
    },
    {
      kind: "summary",
      xColumn: "cat",
      yColumn: "v",
      groupColumn: "grp",
      sourceColumn: null,
      summaries: [
        {
          category: "A",
          group: "S",
          count: 1,
          mean: 1,
          median: 1,
          stddev: 0,
          min: 1,
          max: 1,
        },
      ],
    },
  ]);

  const nonEmptyBuilt = buildGraph(spec, data, theme, undefined, nonEmptyFrame);
  const nonEmptySeries = panelSeries(nonEmptyBuilt.panels[0].option as Record<string, unknown>);
  assert.equal(
    nonEmptySeries.some((entry) => String(entry.id ?? "").startsWith("__hist_packet_fallback_final_")),
    false,
    "non-empty packet must not synthesize final histogram fallback series",
  );
}

{
  const data = baseData(["x", "y"], []);
  const spec: GraphSpec = {
    encoding: {
      x: { name: "x", type: "continuous" },
      y: { name: "y", type: "continuous" },
    },
    elements: [{ kind: "histogram", enabled: true, options: { histStyle: "bar" } }],
  };

  const frame = baseFrame([
    {
      kind: "histogram",
      xColumn: "x",
      yColumn: "y",
      binCount: 2,
      minValue: 0,
      maxValue: 2,
      missingCount: 0,
      binWidth: 1,
      totalCount: 3,
      bins: [
        { binStart: 0, binEnd: 1, count: 2 },
        { binStart: 1, binEnd: 2, count: 1 },
      ],
    },
  ]);

  const built = buildGraph(spec, data, theme, undefined, frame);
  const series = panelSeries(built.panels[0].option as Record<string, unknown>);
  assert.ok(series.length > 0, "mode A histogram should be emitted from packet bins when rows are empty");
}

{
  const matrix: Array<{
    name: string;
    data: GraphData;
    spec: GraphSpec;
    frame: GraphDataFrame;
    verify: (series: Array<Record<string, unknown>>) => void;
  }> = [
    {
      name: "histogram packet",
      data: frameBackedAggregateData(["x", "y"]),
      spec: {
        encoding: {
          x: { name: "x", type: "continuous" },
          y: { name: "y", type: "continuous" },
        },
        elements: [{ kind: "histogram", enabled: true, options: { histStyle: "bar" } }],
      },
      frame: frameBackedAggregateFrame([
        {
          kind: "histogram",
          xColumn: "x",
          yColumn: "y",
          binCount: 2,
          minValue: 0,
          maxValue: 2,
          missingCount: 0,
          binWidth: 1,
          totalCount: 3,
          bins: [
            { binStart: 0, binEnd: 1, count: 2 },
            { binStart: 1, binEnd: 2, count: 1 },
          ],
        },
      ]),
      verify: (series) => {
        assert.ok(series.length > 0, "frame-backed histogram packet should produce renderable series");
      },
    },
    {
      name: "heatmap packet",
      data: frameBackedAggregateData(["x", "y"]),
      spec: {
        encoding: {
          x: { name: "x", type: "continuous" },
          y: { name: "y", type: "continuous" },
        },
        elements: [{ kind: "heatmap" as any, enabled: true }],
      },
      frame: frameBackedAggregateFrame([
        {
          kind: "heatmap",
          xColumn: "x",
          yColumn: "y",
          xBinCount: 2,
          yBinCount: 2,
          xMin: 0,
          xMax: 2,
          yMin: 0,
          yMax: 2,
          missingCount: 0,
          xBinWidth: 1,
          yBinWidth: 1,
          totalCount: 3,
          cells: [
            { xBinIndex: 0, yBinIndex: 0, xBinStart: 0, xBinEnd: 1, yBinStart: 0, yBinEnd: 1, count: 2 },
            { xBinIndex: 1, yBinIndex: 1, xBinStart: 1, xBinEnd: 2, yBinStart: 1, yBinEnd: 2, count: 1 },
          ],
        },
      ]),
      verify: (series) => {
        const heatSeries = series.find((entry) => entry.type === "heatmap" || entry.type === "custom");
        assert.ok(heatSeries, "heatmap packet should produce a renderable series");
        const points = Array.isArray(heatSeries?.data) ? (heatSeries?.data as unknown[][]) : [];
        assert.ok(
          points.some((row) => Number(row[0]) === 0.5 && Number(row[1]) === 0.5 && Number(row[2]) === 2),
          "heatmap packet cell center/count must map to heatmap series data",
        );
      },
    },
    {
      name: "boxplot missing packet",
      data: frameBackedAggregateData(["x", "y"]),
      spec: {
        encoding: {
          x: { name: "x", type: "nominal" },
          y: { name: "y", type: "continuous" },
        },
        elements: [{ kind: "boxplot", enabled: true }],
      },
      frame: frameBackedAggregateFrame([]),
      verify: (series) => {
        assert.equal(
          series.some((entry) => entry.type === "boxplot"),
          false,
          "frame-backed boxplot must not fall back to row scan when packet is missing",
        );
      },
    },
    {
      name: "grouped boxplot packet",
      data: frameBackedAggregateData(["event_date", "cost", "region"], 300_000),
      spec: {
        encoding: {
          x: { name: "event_date", type: "datetime" },
          y: { name: "cost", type: "continuous" },
          color: { name: "region", type: "nominal" },
        },
        elements: [{ kind: "boxplot", enabled: true }],
      },
      frame: {
        ...frameBackedAggregateFrame([
          {
            kind: "boxPlot",
            xColumn: "event_date",
            yColumn: "cost",
            groupColumn: "region",
            entries: [
              {
                group: "East",
                category: "2026-01-01",
                count: 10,
                min: 1,
                q1: 2,
                median: 3,
                q3: 4,
                max: 5,
                whiskerLow: 1,
                whiskerHigh: 5,
                outliers: [],
              },
              {
                group: "West",
                category: "2026-01-01",
                count: 8,
                min: 2,
                q1: 3,
                median: 4,
                q3: 5,
                max: 6,
                whiskerLow: 2,
                whiskerHigh: 6,
                outliers: [],
              },
            ],
          },
        ], 300_000),
        dictionaries: { group: ["East", "West"] },
      },
      verify: (series) => {
        const boxes = series.filter((entry) => entry.type === "boxplot");
        assert.equal(boxes.length, 2, "packet groups must each produce a boxplot series");
        assert.deepEqual(boxes.map((entry) => entry.name), ["East", "West"]);
        assert.deepEqual(boxes.map((entry) => entry.data), [
          [[1, 2, 3, 4, 5]],
          [[2, 3, 4, 5, 6]],
        ]);
      },
    },
    {
      name: "summary missing packet",
      data: frameBackedAggregateData(["x", "y"]),
      spec: {
        encoding: {
          x: { name: "x", type: "nominal" },
          y: { name: "y", type: "continuous" },
        },
        elements: [{ kind: "points", enabled: true, options: { summaryStat: "mean" } }],
      },
      frame: frameBackedAggregateFrame([]),
      verify: (series) => {
        assert.equal(
          series.some((entry) => String(entry.id ?? "").endsWith("__summary")),
          false,
          "frame-backed summary points must not be derived from row scan when summary packet is missing",
        );
      },
    },
  ];

  for (const testCase of matrix) {
    assert.doesNotThrow(
      () => {
        const built = buildGraph(testCase.spec, testCase.data, theme, undefined, testCase.frame);
        const series = panelSeries(built.panels[0].option as Record<string, unknown>);
        testCase.verify(series);
      },
      `${testCase.name} must not reconstruct legacy rows for frame-backed packet ownership`,
    );
  }
}

{
  const throwingRows = new Proxy([] as unknown[][], {
    get(_target, prop) {
      if (prop === "length") return 0;
      throw new Error("legacy rows access is forbidden for typed melt-source mapping");
    },
  });

  const data = baseData(["_row_id", "cat", "__sp_value__", "__sp_variable__"], throwingRows);

  const spec: GraphSpec = {
    encoding: {
      x: { name: "cat", type: "nominal" },
      y: { name: "__sp_value__", type: "continuous" },
    },
    elements: [{ kind: "points", enabled: true, options: { summaryStat: "none" } }],
  };

  const frame: GraphDataFrame = {
    ...baseFrame([]),
    dictionaries: { x: ["A"], source: ["m1", "m2"] },
    rawChunks: [
      {
        chunkIndex: 0,
        rowOffset: 0,
        rowCount: 2,
        xValues: new Uint32Array([0, 0]),
        yValues: new Float64Array([10, 11]),
        rowIds: new BigInt64Array([1n, 2n]),
        sourceCodes: new Uint32Array([0, 1]),
        validity: {
          x: new Uint8Array([0b00000011]),
          y: new Uint8Array([0b00000011]),
          source: new Uint8Array([0b00000011]),
        },
      },
    ],
  };

  const built = buildGraph(spec, data, theme, undefined, frame);
  const scatter = panelSeries(built.panels[0].option as Record<string, unknown>)
    .find((entry) => entry.type === "scatter");
  assert.ok(scatter);
  const colNames = new Set(
    (scatter.data as Array<{ __pick?: { colName: string } }>)
      .map((item) => item.__pick?.colName),
  );
  assert.deepEqual(colNames, new Set(["m1", "m2"]), "ECharts point picks must preserve typed melted source identity from source codes");
}

{
  const throwingRows = new Proxy([] as unknown[][], {
    get(_target, prop) {
      if (prop === "length") return 0;
      throw new Error("legacy rows access is forbidden for frame-backed facets");
    },
  });

  const data = baseData(["cat", "v"], throwingRows);
  const frame: GraphDataFrame = {
    ...baseFrame([
      {
        kind: "histogram",
        xColumn: "cat",
        yColumn: "v",
        binCount: 1,
        minValue: 0,
        maxValue: 1,
        missingCount: 0,
        binWidth: 1,
        totalCount: 4,
        bins: [
          { category: "A", facetX: "L", facetY: "Top", binStart: 0, binEnd: 1, count: 1 },
          { category: "A", facetX: "R", facetY: "Top", binStart: 0, binEnd: 1, count: 1 },
          { category: "A", facetX: "L", facetY: "Bottom", binStart: 0, binEnd: 1, count: 1 },
          { category: "A", facetX: "R", facetY: "Bottom", binStart: 0, binEnd: 1, count: 1 },
        ],
      },
    ]),
    dictionaries: {
      x: ["A"],
      facetX: ["L", "R"],
      facetY: ["Top", "Bottom"],
    },
    rawChunks: [
      {
        chunkIndex: 0,
        rowOffset: 0,
        rowCount: 4,
        xValues: new Uint32Array([0, 0, 0, 0]),
        yValues: new Float64Array([1, 2, 3, 4]),
        rowIds: new BigInt64Array([1n, 2n, 3n, 4n]),
        facetXCodes: new Uint32Array([0, 1, 0, 1]),
        facetYCodes: new Uint32Array([0, 0, 1, 1]),
        validity: {
          x: new Uint8Array([0b00001111]),
          y: new Uint8Array([0b00001111]),
          facetX: new Uint8Array([0b00001111]),
          facetY: new Uint8Array([0b00001111]),
        },
      },
    ],
  };

  const spec: GraphSpec = {
    encoding: {
      x: { name: "cat", type: "nominal" },
      y: { name: "v", type: "continuous" },
      groupX: { name: "fx", type: "nominal" },
      groupY: { name: "fy", type: "nominal" },
    },
    elements: [
      { kind: "histogram", enabled: true, options: { histStyle: "bar" } },
      { kind: "points", enabled: true, options: { summaryStat: "none" } },
    ],
  };

  const built = buildGraph(spec, data, theme, undefined, frame);
  assert.equal(built.cols, 2);
  assert.equal(built.rows, 2);
  for (const panel of built.panels) {
    const series = panelSeries(panel.option as Record<string, unknown>);
    assert.ok(series.length > 0, "facet panel should render packet-backed series");
    const scatter = series.find((entry) => entry.type === "scatter");
    assert.ok(scatter);
    assert.equal((scatter.data as unknown[]).length, 1, "each facet panel should keep only its local typed points");
  }
}

{
  const spec: GraphSpec = {
    encoding: {
      x: { name: "x", type: "continuous" },
      y: { name: "y", type: "continuous" },
      groupX: { name: "columnFacet", type: "nominal" },
      groupY: { name: "rowFacet", type: "nominal" },
    },
    elements: [{ kind: "points", enabled: true }],
    transpose: true,
  };
  const data = baseData(
    ["x", "y", "columnFacet", "rowFacet"],
    [
      [1, 10, "Left", "Top"],
      [2, 20, "Right", "Top"],
      [3, 30, "Left", "Middle"],
      [4, 40, "Right", "Middle"],
      [5, 50, "Left", "Bottom"],
      [6, 60, "Right", "Bottom"],
    ],
  );

  const built = buildGraph(spec, data, theme);
  assert.equal(built.cols, 3);
  assert.equal(built.rows, 2);
  assert.deepEqual(
    built.panels.map((panel) => [panel.groupXValue, panel.groupYValue, panel.title]),
    [
      ["Top", "Left", "columnFacet=Left | rowFacet=Top"],
      ["Middle", "Left", "columnFacet=Left | rowFacet=Middle"],
      ["Bottom", "Left", "columnFacet=Left | rowFacet=Bottom"],
      ["Top", "Right", "columnFacet=Right | rowFacet=Top"],
      ["Middle", "Right", "columnFacet=Right | rowFacet=Middle"],
      ["Bottom", "Right", "columnFacet=Right | rowFacet=Bottom"],
    ],
  );
}

{
  const transposed = transposeOption({
    xAxis: { type: "value" },
    yAxis: { type: "value" },
    series: [{
      type: "scatter",
      data: [[1, 2]],
      markPoint: {
        data: [
          { xAxis: 3, yAxis: 4 },
          { coord: [5, 6], name: "peak" },
        ],
      },
    }],
  });
  const series = (transposed.series as Array<Record<string, unknown>>)[0];
  assert.deepEqual((series.markPoint as { data: unknown[] }).data, [
    { xAxis: 4, yAxis: 3 },
    { coord: [6, 5], name: "peak" },
  ]);
}

{
  const data = frameBackedAggregateData(["alpha", "beta", "gamma"]);
  const spec: GraphSpec = {
    encoding: {
      x: { name: "alpha", type: "continuous" },
      y: { name: "beta", type: "continuous" },
    },
    elements: [{ kind: "correlationMatrix", enabled: true }],
  };

  const frame = frameBackedAggregateFrame([
    {
      kind: "correlationMatrix",
      method: "spearman",
      columns: ["alpha", "beta", "gamma"],
      cells: [
        { xIndex: 0, yIndex: 0, coefficient: 1, sampleCount: 24 },
        { xIndex: 1, yIndex: 0, coefficient: 0, sampleCount: 24 },
        { xIndex: 2, yIndex: 0, coefficient: -0.4321, sampleCount: 24 },
        { xIndex: 0, yIndex: 1, coefficient: 0, sampleCount: 24 },
        { xIndex: 1, yIndex: 1, coefficient: 1, sampleCount: 24 },
        { xIndex: 2, yIndex: 1, coefficient: null, sampleCount: 24, unavailableReason: "zeroVariance" },
        { xIndex: 0, yIndex: 2, coefficient: -0.4321, sampleCount: 24 },
        { xIndex: 1, yIndex: 2, coefficient: null, sampleCount: 24, unavailableReason: "insufficientData" },
        { xIndex: 2, yIndex: 2, coefficient: 1, sampleCount: 24 },
      ],
    },
  ]);

  const built = buildGraph(spec, data, theme, undefined, frame);
  assert.equal(built.panels.length, 1, "correlation matrix must render as a dedicated single panel");

  const option = built.panels[0].option as Record<string, unknown>;
  const xAxis = option.xAxis as Record<string, unknown>;
  const yAxis = option.yAxis as Record<string, unknown>;
  assert.deepEqual(xAxis.data, ["alpha", "beta", "gamma"]);
  assert.deepEqual(yAxis.data, ["alpha", "beta", "gamma"]);

  const series = panelSeries(option);
  assert.equal(series.length > 0, true, "correlation matrix should emit at least one series");
  const matrixSeries = series[0];
  assert.equal(matrixSeries.type, "heatmap");

  const visualMap = option.visualMap as Record<string, unknown>;
  assert.deepEqual(visualMap.min, -1);
  assert.deepEqual(visualMap.max, 1);

  const matrixData = Array.isArray(matrixSeries.data)
    ? (matrixSeries.data as Array<Record<string, unknown>>)
    : [];
  assert.equal(matrixData.length, 9);

  const zeroCell = matrixData.find((entry) => {
    const value = Array.isArray(entry.value) ? entry.value : [];
    return Number(value[0]) === 1 && Number(value[1]) === 0;
  });
  assert.ok(zeroCell, "zero coefficient cell should exist");
  assert.equal(Array.isArray(zeroCell?.value) ? Number((zeroCell?.value as unknown[])[2]) : NaN, 0);

  const unavailableCell = matrixData.find((entry) => {
    const value = Array.isArray(entry.value) ? entry.value : [];
    return Number(value[0]) === 2 && Number(value[1]) === 1;
  });
  assert.ok(unavailableCell, "unavailable coefficient cell should exist");
  assert.ok(
    typeof unavailableCell?.itemStyle === "object" && unavailableCell?.itemStyle !== null,
    "unavailable cell should carry explicit unavailable styling",
  );
  assert.equal(
    (unavailableCell?.label as Record<string, unknown> | undefined)?.show,
    false,
    "unavailable cell label should be hidden",
  );

  const tooltip = option.tooltip as Record<string, unknown>;
  const formatter = tooltip.formatter as ((params: unknown) => string);
  assert.equal(typeof formatter, "function");

  const tooltipText = formatter({ data: unavailableCell });
  assert.match(tooltipText, /alpha|beta|gamma/);
  assert.match(tooltipText, /Method\s*[:=]\s*Spearman/i);
  assert.match(tooltipText, /n\s*[:=]\s*24/i);
  assert.match(tooltipText, /Pair\s*[:=]\s*gamma\s*×\s*beta/i);
  assert.match(tooltipText, /Unavailable\s*[:=]\s*Zero variance/i);
  assert.doesNotMatch(tooltipText, /graph\.correlation\./i);
}

{
  const spec: GraphSpec = {
    encoding: { x: { name: "measurement", type: "continuous" } },
    elements: [
      { kind: "histogram", enabled: true, options: { histStyle: "bar" } },
      { kind: "normalCurve", enabled: true },
    ],
  };
  const frame = baseFrame([
    {
      kind: "histogram",
      yColumn: "measurement",
      binCount: 8,
      minValue: -4,
      maxValue: 4,
      missingCount: 0,
      binWidth: 1,
      totalCount: 100,
      bins: Array.from({ length: 8 }, (_, index) => ({
        binStart: index - 4,
        binEnd: index - 3,
        count: [0, 2, 14, 34, 34, 14, 2, 0][index],
      })),
    },
    {
      kind: "summary",
      yColumn: "measurement",
      summaries: [{
        count: 100,
        mean: 0,
        median: 0,
        stddev: 1,
        min: -4,
        max: 4,
      }],
    },
  ]);

  const option = buildGraph(spec, baseData(["measurement"], []), theme, undefined, frame)
    .panels[0].option as Record<string, unknown>;
  const series = panelSeries(option);
  assert.ok(series.some((entry) => entry.type === "bar"), "histogram bars should remain visible");
  const normal = series.find((entry) => String(entry.id ?? "").startsWith("__normal_curve_"));
  assert.ok(normal, "Normal layer should emit an independent series");
  assert.equal(normal.type, "line");
  assert.equal(normal.smooth, true);
  const points = normal.data as Array<[number, number]>;
  assert.equal(points.length, 201);
  assert.ok(points[100][1] > points[0][1], "the fitted density must peak above its left tail");
  assert.ok(points[100][1] > points[200][1], "the fitted density must peak above its right tail");
}

{
  const spec: GraphSpec = {
    encoding: { x: { name: "measurement", type: "continuous" } },
    elements: [{ kind: "normalCurve", enabled: true }],
  };
  const frame = baseFrame([{
    kind: "summary",
    yColumn: "measurement",
    summaries: [{
      count: 40,
      mean: 10,
      median: 10,
      stddev: 2,
      min: 2,
      max: 18,
    }],
  }]);

  const option = buildGraph(spec, baseData(["measurement"], []), theme, undefined, frame)
    .panels[0].option as Record<string, unknown>;
  const series = panelSeries(option);
  assert.equal(series.some((entry) => entry.type === "bar"), false);
  assert.ok(
    series.some((entry) => String(entry.id ?? "").startsWith("__normal_curve_")),
    "Normal layer must render without a Histogram layer",
  );
}

{
  const spec: GraphSpec = {
    encoding: {
      x: { name: "category", type: "nominal" },
      y: { name: "measurement", type: "continuous" },
    },
    elements: [{ kind: "normalCurve", enabled: true }],
  };
  const frame: GraphDataFrame = {
    ...baseFrame([{
      kind: "summary",
      xColumn: "category",
      yColumn: "measurement",
      summaries: [
        { category: "A", count: 50, mean: 0, median: 0, stddev: 1, min: -4, max: 4 },
        { category: "B", count: 12, mean: 3, median: 3, stddev: 0, min: 3, max: 3 },
      ],
    }]),
    dictionaries: { x: ["A", "B"] },
  };

  const option = buildGraph(
    spec,
    frameBackedAggregateData(["category", "measurement"], 62),
    theme,
    undefined,
    frame,
  ).panels[0].option as Record<string, unknown>;
  const normalSeries = panelSeries(option).filter((entry) =>
    String(entry.id ?? "").startsWith("__normal_cat_")
  );
  assert.equal(normalSeries.length, 1, "zero-variance categories must be skipped");
  assert.equal(normalSeries[0].type, "custom");
  assert.equal(normalSeries[0].clip, true);
  const yAxis = option.yAxis as Record<string, unknown>;
  assert.ok(Number(yAxis.min) <= -4);
  assert.ok(Number(yAxis.max) >= 4);
  const renderItem = normalSeries[0].renderItem as (params: unknown, api: unknown) => {
    type: string;
    shape: { points: number[][] };
  };
  const shape = renderItem(
    { dataIndex: 0, seriesId: "__normal_cat___default__" },
    {
      coord: ([, value]: [string, number]) => [50, 100 - value * 10],
      size: () => [100, 100],
    },
  );
  assert.equal(shape.type, "polyline");
  const middle = shape.shape.points[Math.floor(shape.shape.points.length / 2)];
  assert.ok(middle[0] > shape.shape.points[0][0]);
  assert.ok(middle[0] > shape.shape.points.at(-1)![0]);
}

{
  const spec: GraphSpec = {
    encoding: {
      x: { name: "category", type: "nominal" },
      y: { name: "measurement", type: "continuous" },
    },
    elements: [{ kind: "normalCurve", enabled: true }],
  };
  const mean = 4.43;
  const stddev = 0.05;
  const expectedCurveMin = mean - 4 * stddev;
  const expectedCurveMax = mean + 4 * stddev;
  const frame: GraphDataFrame = {
    ...baseFrame([{
      kind: "summary",
      xColumn: "category",
      yColumn: "measurement",
      summaries: [{
        category: "A",
        count: 50,
        mean,
        median: mean,
        stddev,
        min: 4.28,
        max: 4.57,
      }],
    }]),
    dictionaries: { x: ["A"] },
    extents: { y: { min: 4.28, max: 4.57 } },
  };

  const option = buildGraph(
    spec,
    frameBackedAggregateData(["category", "measurement"], 50),
    theme,
    undefined,
    frame,
  ).panels[0].option as Record<string, unknown>;
  const yAxis = option.yAxis as Record<string, unknown>;
  assert.ok(
    Number(yAxis.min) <= expectedCurveMin,
    "the value axis must include the fitted normal curve's lower tail",
  );
  assert.ok(
    Number(yAxis.max) >= expectedCurveMax,
    "the value axis must include the fitted normal curve's upper tail",
  );

  const pinnedOption = buildGraph(
    { ...spec, yAxis: { min: 4.3, max: 4.55 } },
    frameBackedAggregateData(["category", "measurement"], 50),
    theme,
    undefined,
    frame,
  ).panels[0].option as Record<string, unknown>;
  const pinnedYAxis = pinnedOption.yAxis as Record<string, unknown>;
  assert.equal(pinnedYAxis.min, 4.3, "an explicit lower axis pin must override automatic tail expansion");
  assert.equal(pinnedYAxis.max, 4.55, "an explicit upper axis pin must override automatic tail expansion");
}

{
  const spec: GraphSpec = {
    encoding: {
      x: { name: "category", type: "nominal" },
      y: { name: "measurement", type: "continuous" },
    },
    elements: [
      { kind: "histogram", enabled: true },
      { kind: "normalCurve", enabled: true },
    ],
  };
  const frame: GraphDataFrame = {
    ...baseFrame([
      {
        kind: "histogram",
        xColumn: "category",
        yColumn: "measurement",
        binCount: 20,
        minValue: -4,
        maxValue: 4,
        missingCount: 0,
        binWidth: 0.4,
        totalCount: 100,
        bins: [{ category: "A", binStart: -0.2, binEnd: 0.2, count: 40 }],
      },
      {
        kind: "summary",
        xColumn: "category",
        yColumn: "measurement",
        summaries: [{ category: "A", count: 100, mean: 0, median: 0, stddev: 1, min: -4, max: 4 }],
      },
    ]),
    dictionaries: { x: ["A"] },
    extents: { y: { min: -4, max: 4 } },
  };
  const option = buildGraph(
    spec,
    frameBackedAggregateData(["category", "measurement"], 100),
    theme,
    undefined,
    frame,
  ).panels[0].option as Record<string, unknown>;
  const normal = panelSeries(option).find((entry) => String(entry.id ?? "").startsWith("__normal_cat_"))!;
  const shape = (normal.renderItem as (params: unknown, api: unknown) => { shape: { points: number[][] } })(
    { dataIndex: 0, seriesId: "__normal_cat___default__" },
    {
      coord: ([, value]: [string, number]) => [50, 100 - value * 10],
      size: () => [100, 100],
    },
  );
  const peakX = Math.max(...shape.shape.points.map((point) => point[0]));
  assert.ok(peakX > 30 && peakX < 45, `count-scaled peak should occupy about 40% of the slot, got ${peakX}`);
}

{
  const transposed = transposeOption({
    xAxis: { type: "category" },
    yAxis: { type: "value" },
    series: [{
      id: "__normal_cat___default__",
      type: "custom",
      data: [["A", 0]],
    }],
  });
  const normal = (transposed.series as Array<Record<string, unknown>>)[0];
  assert.equal(normal.id, "__normal_cat___default____t");
  assert.deepEqual(normal.data, [[0, "A"]]);
}

{
  const spec: GraphSpec = {
    encoding: {
      x: { name: "category", type: "nominal" },
      y: { name: "measurement", type: "continuous" },
      groupX: { name: "side", type: "nominal" },
      groupY: { name: "zone", type: "nominal" },
    },
    elements: [{ kind: "normalCurve", enabled: true }],
  };
  const summaries = [
    ["L", "Top", 0],
    ["R", "Top", 1],
    ["L", "Bottom", 2],
    ["R", "Bottom", 3],
  ].map(([facetX, facetY, mean]) => ({
    category: "A",
    facetX: String(facetX),
    facetY: String(facetY),
    count: 20,
    mean: Number(mean),
    median: Number(mean),
    stddev: 1,
    min: Number(mean) - 4,
    max: Number(mean) + 4,
  }));
  const frame = baseFrame([{
    kind: "summary",
    xColumn: "category",
    yColumn: "measurement",
    summaries,
  }]);

  const built = buildGraph(
    spec,
    frameBackedAggregateData(["category", "measurement", "side", "zone"], 80),
    theme,
    undefined,
    frame,
  );
  assert.equal(built.cols, 2);
  assert.equal(built.rows, 2);
  assert.deepEqual(
    built.panels.map((panel) => [panel.groupXValue, panel.groupYValue]),
    [["L", "Top"], ["R", "Top"], ["L", "Bottom"], ["R", "Bottom"]],
  );
  for (const panel of built.panels) {
    assert.ok(
      panelSeries(panel.option as Record<string, unknown>)
        .some((entry) => String(entry.id ?? "").startsWith("__normal_cat_")),
      "each Summary-only facet should render its Normal curve",
    );
  }
}
