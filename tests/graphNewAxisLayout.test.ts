import assert from "node:assert/strict";

import { computeAxisLayout, strokeDashArrayForStyle } from "../src/components/graphBuilderNew/graphNewAxisLayout.ts";
import { formatGraphNewTick } from "../src/components/graphBuilderNew/GraphNewCanvas.tsx";
import type { GraphNewAxis } from "../src/services/graphNewService.ts";

const numericAxis: GraphNewAxis = {
  kind: "numeric",
  utc: false,
  ticks: [0, 25, 50, 75, 100].map((v) => ({ value: v, position: v / 100, label: String(v) })),
};

// 1. Default gridlines are OFF (classic parity); styles match defaults.
const defaultLayout = computeAxisLayout({
  axis: "y",
  axisMeta: numericAxis,
  currentMin: 0,
  currentMax: 100,
  refMin: 0,
  refMax: 100,
  formatTick: formatGraphNewTick,
});
assert.equal(defaultLayout.showMajorGrid, false);
assert.equal(defaultLayout.showMinorGrid, false);
assert.equal(defaultLayout.showAxisLine, true);
assert.equal(defaultLayout.tickPosition, "outside");
assert.equal(defaultLayout.majorGridStyle.color, "#bdbdbd");
assert.equal(defaultLayout.majorGridStyle.style, "dashed");
assert.equal(defaultLayout.majorGridStyle.width, 1);
assert.equal(defaultLayout.minorGridStyle.color, "#e2e2e2");
assert.equal(strokeDashArrayForStyle("solid"), undefined);
assert.equal(strokeDashArrayForStyle("dashed"), "4 4");
assert.equal(strokeDashArrayForStyle("dotted"), "1.5 3");

// 2. Custom tickInterval + decimals + minorTickCount + minor grid gate.
const customLayout = computeAxisLayout({
  axis: "y",
  axisMeta: numericAxis,
  currentMin: 0,
  currentMax: 100,
  refMin: 0,
  refMax: 100,
  config: {
    tickInterval: 25,
    decimals: 2,
    minorTickCount: 4,
    showMajorGrid: true,
    showMinorGrid: true,
    tickPosition: "inside",
    majorGridStyle: { color: "#1976d2", width: 2, style: "solid" },
  },
  formatTick: formatGraphNewTick,
});
assert.deepEqual(customLayout.majorTicks.map((t) => t.label), ["0.00", "25.00", "50.00", "75.00", "100.00"]);
assert.equal(customLayout.minorPositions.length, 16, "4 intervals * 4 minor ticks = 16");
assert.equal(customLayout.showMajorGrid, true);
assert.equal(customLayout.showMinorGrid, true);
assert.equal(customLayout.minorGridPositions.length, 16);
assert.equal(customLayout.tickPosition, "inside");

// Minor gridlines must be suppressed when minorTickCount is 0 or undefined.
const noMinorLayout = computeAxisLayout({
  axis: "y",
  axisMeta: numericAxis,
  currentMin: 0,
  currentMax: 100,
  refMin: 0,
  refMax: 100,
  config: { showMinorGrid: true },
  formatTick: formatGraphNewTick,
});
assert.equal(noMinorLayout.minorPositions.length, 0);
assert.equal(noMinorLayout.showMinorGrid, false);
assert.equal(noMinorLayout.minorGridPositions.length, 0);

// 3. Tiny tickInterval on huge span must cap gracefully (<= 64 ticks).
const hugeLayout = computeAxisLayout({
  axis: "y",
  axisMeta: numericAxis,
  currentMin: 0,
  currentMax: 1_000_000,
  refMin: 0,
  refMax: 1_000_000,
  config: { tickInterval: 0.001 },
  formatTick: formatGraphNewTick,
});
assert.ok(hugeLayout.majorTicks.length >= 2 && hugeLayout.majorTicks.length <= 64, `got ${hugeLayout.majorTicks.length}`);

// 3b. Extreme underflow/overflow tickInterval (span / interval > 63 * 2^128) must still emit valid ticks, never [].
const extremeIntervalLayout = computeAxisLayout({
  axis: "y",
  axisMeta: numericAxis,
  currentMin: 0,
  currentMax: 1e40,
  refMin: 0,
  refMax: 1e40,
  config: { tickInterval: 1e-40 },
  formatTick: formatGraphNewTick,
});
assert.ok(extremeIntervalLayout.majorTicks.length >= 2 && extremeIntervalLayout.majorTicks.length <= 64,
  `extreme tickInterval must cap gracefully instead of dropping all ticks, got ${extremeIntervalLayout.majorTicks.length}`);

// 3c. Strictly honor custom tickInterval whenever >= 1 multiple fits in view (e.g. 0.2 on [3.70, 4.07] -> 3.80, 4.00;
// 0.2 on [3.85, 4.15] -> 4.00 with full-span minor ticks), and only subdivide when 0 multiples fit ([4.02, 4.18]).
const exactIntervalZoomLayout = computeAxisLayout({
  axis: "y",
  axisMeta: numericAxis,
  currentMin: 3.7,
  currentMax: 4.07,
  refMin: 3,
  refMax: 5,
  config: { tickInterval: 0.2, decimals: 2, minorTickCount: 2, showMajorGrid: true, showMinorGrid: true },
  formatTick: formatGraphNewTick,
});
assert.deepEqual(exactIntervalZoomLayout.majorTicks.map((t) => t.label), ["3.80", "4.00"]);
assert.ok(exactIntervalZoomLayout.minorPositions.some((p) => p < 0.2), "minor ticks must cover lower edge below 3.80");
assert.ok(exactIntervalZoomLayout.minorPositions.some((p) => p > 0.85), "minor ticks must cover upper edge above 4.00");

const zoomedSingleTickLayout = computeAxisLayout({
  axis: "y",
  axisMeta: numericAxis,
  currentMin: 3.85,
  currentMax: 4.15,
  refMin: 3,
  refMax: 5,
  config: { tickInterval: 0.2, decimals: 2, minorTickCount: 3, showMajorGrid: true, showMinorGrid: true },
  formatTick: formatGraphNewTick,
});
assert.deepEqual(zoomedSingleTickLayout.majorTicks.map((t) => t.label), ["4.00"]);
assert.ok(zoomedSingleTickLayout.minorPositions.some((p) => p < 0.2), "minor ticks must cover lower edge of plot");
assert.ok(zoomedSingleTickLayout.minorPositions.some((p) => p > 0.8), "minor ticks must cover upper edge of plot");

const betweenMultiplesLayout = computeAxisLayout({
  axis: "y",
  axisMeta: numericAxis,
  currentMin: 4.02,
  currentMax: 4.18,
  refMin: 3,
  refMax: 5,
  config: { tickInterval: 0.2, minorTickCount: 3, showMajorGrid: true, showMinorGrid: true },
  formatTick: formatGraphNewTick,
});
assert.ok(betweenMultiplesLayout.majorTicks.length >= 2, `expected >= 2 major ticks on [4.02, 4.18], got ${betweenMultiplesLayout.majorTicks.length}`);
assert.ok(betweenMultiplesLayout.minorPositions.length > 0, "minor ticks must remain visible between custom interval multiples");
assert.ok(betweenMultiplesLayout.majorGridPositions.length >= 2, "major gridlines must remain visible");

// 4. Inverse flips screenPosition for ticks, minor ticks, gridlines, and reference lines.
const invLayout = computeAxisLayout({
  axis: "y",
  axisMeta: numericAxis,
  currentMin: 0,
  currentMax: 100,
  refMin: 0,
  refMax: 100,
  config: { tickInterval: 50, inverse: true, showMajorGrid: true },
  refLines: [{ id: "r1", y: 20, label: "Low", style: "dashed", color: "#E60000", width: 1.5 }],
  autoSpecLines: true,
  resolvedAutoSpec: { lsl: 10, target: 50, usl: 90, colName: "Y" },
  formatTick: formatGraphNewTick,
});
const tick0 = invLayout.majorTicks.find((t) => t.value === 0)!;
const tick100 = invLayout.majorTicks.find((t) => t.value === 100)!;
assert.ok(Math.abs(tick0.screenPosition - 1) < 1e-9);
assert.ok(Math.abs(tick100.screenPosition - 0) < 1e-9);
assert.equal(invLayout.refLines.length, 4);
const lowRef = invLayout.refLines.find((r) => r.id === "r1")!;
assert.ok(Math.abs(lowRef.screenPosition - 0.8) < 1e-9);
const targetRef = invLayout.refLines.find((r) => r.label === "Target")!;
assert.equal(targetRef.color, "#00C853");
assert.ok(Math.abs(targetRef.screenPosition - 0.5) < 1e-9);

// 5. Category and Time X ignore numeric tickInterval, decimals, refLinesX, autoSpecLinesX.
const catAxis: GraphNewAxis = {
  kind: "category",
  utc: false,
  ticks: [
    { value: 0, position: 0.25, label: "A" },
    { value: 1, position: 0.75, label: "B" },
  ],
};
const catLayout = computeAxisLayout({
  axis: "x",
  axisMeta: catAxis,
  currentMin: -0.5,
  currentMax: 1.5,
  refMin: -0.5,
  refMax: 1.5,
  config: { tickInterval: 0.1, decimals: 3, minorTickCount: 4, showMinorGrid: true, inverse: true },
  refLines: [{ id: "rx", x: 0.5, label: "X", style: "solid", color: "#000000", width: 1 }],
  autoSpecLines: true,
  resolvedAutoSpec: { lsl: 0, usl: 1 },
  formatTick: formatGraphNewTick,
});
assert.deepEqual(catLayout.majorTicks.map((t) => t.label), ["A", "B"]);
assert.ok(Math.abs(catLayout.majorTicks[0].screenPosition - 0.75) < 1e-9);
assert.equal(catLayout.minorPositions.length, 0);
assert.equal(catLayout.showMinorGrid, false);
assert.equal(catLayout.refLines.length, 0);

const timeAxis: GraphNewAxis = {
  kind: "time",
  utc: true,
  ticks: [
    { value: 0, position: 0, label: null },
    { value: 60, position: 1, label: null },
  ],
};
const timeLayout = computeAxisLayout({
  axis: "x",
  axisMeta: timeAxis,
  currentMin: 0,
  currentMax: 60,
  refMin: 0,
  refMax: 60,
  config: { tickInterval: 1, decimals: 2 },
  refLines: [{ id: "rt", x: 30, label: "T", style: "solid", color: "#000000", width: 1 }],
  autoSpecLines: true,
  resolvedAutoSpec: { target: 30 },
  formatTick: formatGraphNewTick,
});
assert.ok(timeLayout.majorTicks[0].label.includes("1970-01-01"), `time label should not be clobbered by decimals: ${timeLayout.majorTicks[0].label}`);
assert.equal(timeLayout.refLines.length, 0);

console.log("graphNewAxisLayout.test.ts passed");
