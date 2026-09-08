import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { updateEmbeddedGraph2D } from "../src/components/fitYByX/fitYByXAxisInteractions.ts";
import { updateGraphBuilder2D } from "../src/components/graphBuilder/graphBuilderAxisInteractions.ts";

function readSource(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), "utf8").replace(/\r\n/g, "\n");
}

const graphBuilderSource = readSource("src/components/graphBuilder/GraphBuilderView.tsx");
const fitYByXSource = readSource("src/components/analysis/renderers/FitYByXAnalysisResults.tsx");
const axisSettingsSource = readSource("src/components/graphBuilder/AxisSettingsDialog.tsx");

assert.match(
  graphBuilderSource,
  /import \{ AxisSettingsDialog[^}]*\} from "\.\/AxisSettingsDialog";/,
  "Graph Builder must consume the shared axis settings dialog",
);

assert.match(
  fitYByXSource,
  /import \{ AxisSettingsDialog[^}]*\} from "@\/components\/graphBuilder\/AxisSettingsDialog";/,
  "Fit Y by X must consume the same axis settings dialog as Graph Builder",
);

for (const implementationMarker of [
  "DecimalTextInput",
  "GRID_LINE_THEMES",
  "GRID_LINE_PRESETS",
  "REF_LINE_PRESETS",
  "autoChips",
  "normalizeHex",
]) {
  assert.equal(
    axisSettingsSource.includes(implementationMarker),
    true,
    `The shared axis settings module must retain ${implementationMarker}`,
  );
}

for (const duplicateMarker of [
  "LegacyAxisSettingsDialog",
  "function AxisSettingsEditor",
  "function GridSettingsEditor",
  "function RefLinesEditor",
  "function normalizeHex",
]) {
  assert.equal(
    graphBuilderSource.includes(duplicateMarker),
    false,
    `Graph Builder must not retain duplicate axis-dialog code: ${duplicateMarker}`,
  );
}

for (const callback of [
  "onYAxisDblClick",
  "onXAxisDblClick",
  "onAxisRangeChange",
  "onAxisContextMenu",
]) {
  assert.equal(
    fitYByXSource.includes(`${callback}:`),
    true,
    `Fit Y by X must wire GraphRuntime ${callback}`,
  );
}

assert.match(
  fitYByXSource,
  /onAxisRangeChange: onGraphConfigChange/,
  "Fit Y by X must disable persistent zoom changes when graph editing is unavailable",
);

assert.match(
  fitYByXSource,
  /updateEmbeddedGraph2D\(item\.presentation\.graph, updater\)/,
  "Fit Y by X axis changes must update the canonical presentation graph",
);

assert.match(
  fitYByXSource,
  /onGraphConfigChange\("main",/,
  "Fit Y by X axis changes must persist through the shared Analysis graph callback",
);

const baseGraph = {
  mode: "2d" as const,
  modeStates: {
    twoD: {
      encoding: {},
      multiX: [],
      multiY: [],
      elements: [],
      smootherLambda: 0.5,
    },
    threeD: { encoding: {}, elements: [], smootherLambda: 0.5 },
    multivariate: { columns: [], chartType: "correlationMatrix" as const, correlationMethod: "pearson" as const },
  },
};

const xPanned = updateEmbeddedGraph2D(baseGraph, (current) => ({
  xAxis: { ...(current.xAxis ?? {}), min: 10, max: 20 },
}));
const xyPanned = updateEmbeddedGraph2D(xPanned, (current) => ({
  yAxis: { ...(current.yAxis ?? {}), min: 30, max: 40 },
}));

assert.deepEqual(xyPanned.modeStates.twoD.xAxis, { min: 10, max: 20 });
assert.deepEqual(xyPanned.modeStates.twoD.yAxis, { min: 30, max: 40 });

const graphBuilderItem = {
  id: "graph-1",
  name: "Graph 1",
  sourceDatasetId: "dataset-1",
  createdAt: "2026-08-31T00:00:00.000Z",
  ...baseGraph,
};
const graphBuilderXPanned = updateGraphBuilder2D(graphBuilderItem, (current) => ({
  ...current,
  xAxis: { ...(current.xAxis ?? {}), min: 10, max: 20 },
}));
const graphBuilderXYPanned = updateGraphBuilder2D(graphBuilderXPanned, (current) => ({
  ...current,
  yAxis: { ...(current.yAxis ?? {}), min: 30, max: 40 },
}));

assert.deepEqual(graphBuilderXYPanned.modeStates.twoD.xAxis, { min: 10, max: 20 });
assert.deepEqual(graphBuilderXYPanned.modeStates.twoD.yAxis, { min: 30, max: 40 });

const graphBuilderReset = updateGraphBuilder2D(
  graphBuilderXYPanned,
  baseGraph.modeStates.twoD,
);
assert.equal(graphBuilderReset.modeStates.twoD.xAxis, undefined);
assert.equal(graphBuilderReset.modeStates.twoD.yAxis, undefined);

assert.match(
  graphBuilderSource,
  /const currentItem = useGraphBuilderStore\.getState\(\)\.items\.find/,
  "Graph Builder axis changes must merge against the latest store snapshot",
);

assert.match(
  graphBuilderSource,
  /onAxisRangeChange=\{isMultivariateMode \|\| readOnly \? undefined/,
  "Graph Builder must also suppress transient axis changes in read-only mode",
);

console.log("Fit Y by X axis interaction contract passed");