import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createFitYByXItem } from "../src/components/fitYByX/fitYByXConfig.ts";
import { createEmbeddedGraphItem, normalizeGraphBuilderItem } from "../src/components/graphBuilder/graphBuilderMode.ts";
import { buildEffectiveStyles, buildGraphRuntimeModel, deriveValueOrders } from "../src/components/graphBuilder/graphRuntimeModel.ts";
import { deriveGraphRequestParts } from "../src/components/graphBuilder/useGraphDataPipeline.ts";
import type { DatasetMeta } from "../src/types/data.ts";
import type { GraphBuilderItem } from "../src/types/graphBuilder.ts";

const dataset: DatasetMeta = {
  id: "dataset-1",
  name: "Dataset 1",
  sourcePath: null,
  sourceType: "manual",
  rowCount: 42,
  colCount: 4,
  generation: 0,
  createdAt: "2026-08-30T00:00:00.000Z",
  updatedAt: "2026-08-30T00:00:00.000Z",
};

const metadata = {
  columns: [
    { colIndex: 0, colName: "site", colType: "VARCHAR", role: "nominal" as const, missingCount: 0 },
    { colIndex: 1, colName: "height", colType: "DOUBLE", role: "continuous" as const, missingCount: 0 },
    { colIndex: 2, colName: "batch", colType: "VARCHAR", role: "ordinal" as const, missingCount: 0 },
  ],
  displayProps: [
    {
      colIndex: 0,
      extras: {
        valueOrder: { values: ["North", "South"] },
      },
    },
    {
      colIndex: 1,
      extras: {
        spec: { lsl: 10, target: 15, usl: 20 },
      },
    },
  ],
};

function makeInteractiveGraphItem(): GraphBuilderItem {
  return normalizeGraphBuilderItem({
    id: "graph-1",
    name: "Graph 1",
    sourceDatasetId: dataset.id,
    createdAt: "2026-08-30T00:00:00.000Z",
    mode: "2d",
    modeStates: {
      twoD: {
        encoding: {
          x: { name: "site", type: "nominal" },
          y: { name: "height", type: "continuous" },
          overlay: { name: "batch", type: "ordinal" },
        },
        multiX: [],
        multiY: [],
        elements: [
          { kind: "points", enabled: true },
          { kind: "boxplot", enabled: true },
        ],
        smootherLambda: 0.4,
        hiddenGroups: ["South"],
        refLinesY: [{ id: "manual-y", y: 12, label: "goal", color: "#00C853", style: "solid", width: 1 }],
        autoSpecLinesY: true,
      },
      threeD: {
        encoding: {},
        elements: [{ kind: "scatter3d", enabled: true }],
        smootherLambda: 0.4,
      },
      multivariate: {
        columns: [],
        chartType: "correlationMatrix",
        correlationMethod: "pearson",
      },
    },
    filters: [{ op: "AND", rule: { kind: "categorical", field: "site", selected: ["North"] } }],
    sampling: { mode: "full" },
  });
}

const interactiveItem = makeInteractiveGraphItem();
const transposedInteractiveItem: GraphBuilderItem = {
  ...interactiveItem,
  modeStates: {
    ...interactiveItem.modeStates,
    twoD: {
      ...interactiveItem.modeStates.twoD,
      transposed: true,
    },
  },
};

assert.deepEqual(
  deriveGraphRequestParts(transposedInteractiveItem),
  deriveGraphRequestParts(interactiveItem),
  "visual X/Y transpose must not change the backend graph request",
);

const transposedRuntimeModel = buildGraphRuntimeModel(transposedInteractiveItem, metadata);
assert.equal(transposedRuntimeModel.spec.transpose, true);
assert.deepEqual(transposedRuntimeModel.spec.encoding, buildGraphRuntimeModel(interactiveItem, metadata).spec.encoding);

const multiColumnItem: GraphBuilderItem = {
  ...interactiveItem,
  modeStates: {
    ...interactiveItem.modeStates,
    twoD: {
      ...interactiveItem.modeStates.twoD,
      encoding: {
        overlay: { name: "batch", type: "ordinal" },
      },
      multiY: [
        { name: "203-A6", type: "continuous" },
        { name: "203-A8", type: "continuous" },
        { name: "203-A9", type: "continuous" },
        { name: "203-A7", type: "continuous" },
      ],
    },
  },
};
const multiColumnModel = buildGraphRuntimeModel(multiColumnItem, metadata);
assert.deepEqual(
  deriveValueOrders(metadata, multiColumnModel.meltInfo).__sp_variable__,
  ["203-A6", "203-A8", "203-A9", "203-A7"],
  "synthetic melt categories must retain the user's multi-column order across frame rebuilds",
);

const colorOnlyItem: GraphBuilderItem = {
  ...interactiveItem,
  modeStates: {
    ...interactiveItem.modeStates,
    twoD: {
      ...interactiveItem.modeStates.twoD,
      encoding: {
        x: { name: "site", type: "nominal" },
        y: { name: "height", type: "continuous" },
        color: { name: "batch", type: "ordinal" },
      },
    },
  },
};
assert.deepEqual(
  buildGraphRuntimeModel(colorOnlyItem, metadata).spec.encoding.color,
  { name: "batch", type: "ordinal" },
  "runtime model must preserve color-only grouping for the renderer",
);

const stableRuntimeStyles = buildEffectiveStyles(
  ["Beta", "Alpha"],
  { Build: { Alpha: 0, Beta: 1 } },
  "Build",
  {},
  [],
  false,
);
assert.equal(stableRuntimeStyles.Alpha.point?.color, "#3b56c6");
assert.equal(stableRuntimeStyles.Beta.point?.color, "#bf6e2e");

const reconciledRuntimeStyles = buildEffectiveStyles(
  ["Beta", "Alpha"],
  undefined,
  "Build",
  {},
  [],
  false,
  ["Alpha", "Beta"],
);
assert.equal(reconciledRuntimeStyles.Alpha.point?.color, "#3b56c6");
assert.equal(reconciledRuntimeStyles.Beta.point?.color, "#bf6e2e");

const fitYByXItem = createFitYByXItem({
  id: "fit-1",
  name: "Fit Y by X 1",
  sourceDatasetId: dataset.id,
  response: { name: "height", type: "continuous" },
  factor: { name: "site", type: "nominal" },
  createdAt: interactiveItem.createdAt,
});
const interactiveFitYByXItem = normalizeGraphBuilderItem({
  ...fitYByXItem.graph,
  id: "fit-y-by-x-graph:interactive",
  name: "Fit Y by X Interactive",
  sourceDatasetId: fitYByXItem.sourceDatasetId,
  createdAt: fitYByXItem.createdAt,
});
const embeddedItem = createEmbeddedGraphItem({
  id: "fit-y-by-x-graph:fit-1",
  name: fitYByXItem.name,
  sourceDatasetId: fitYByXItem.sourceDatasetId,
  createdAt: fitYByXItem.createdAt,
  config: fitYByXItem.graph,
});

assert.deepEqual(
  deriveGraphRequestParts(interactiveItem),
  deriveGraphRequestParts(
    createEmbeddedGraphItem({
      id: "graph-embedded-1",
      name: interactiveItem.name,
      sourceDatasetId: interactiveItem.sourceDatasetId,
      createdAt: interactiveItem.createdAt,
      config: {
        mode: interactiveItem.mode,
        modeStates: interactiveItem.modeStates,
        filters: interactiveItem.filters,
        sampling: interactiveItem.sampling,
      },
    }),
  ),
);

assert.deepEqual(
  buildGraphRuntimeModel(interactiveItem, metadata),
  buildGraphRuntimeModel(
    createEmbeddedGraphItem({
      id: "graph-embedded-1",
      name: interactiveItem.name,
      sourceDatasetId: interactiveItem.sourceDatasetId,
      createdAt: interactiveItem.createdAt,
      config: {
        mode: interactiveItem.mode,
        modeStates: interactiveItem.modeStates,
        filters: interactiveItem.filters,
        sampling: interactiveItem.sampling,
      },
    }),
    metadata,
  ),
);

assert.deepEqual(
  deriveGraphRequestParts(interactiveFitYByXItem),
  deriveGraphRequestParts(embeddedItem),
  "interactive Fit Y by X and embedded Fit Y by X items must derive identical request parts",
);

assert.deepEqual(
  buildGraphRuntimeModel(interactiveFitYByXItem, metadata),
  buildGraphRuntimeModel(embeddedItem, metadata),
  "interactive Fit Y by X and embedded Fit Y by X items must build identical runtime models",
);

const graphRuntimeSource = readFileSync(
  resolve(process.cwd(), "src/components/graphBuilder/GraphRuntime.tsx"),
  "utf8",
);
assert.equal(
  graphRuntimeSource.includes("useGraphBuilderStore"),
  false,
  "GraphRuntime must not import or reference useGraphBuilderStore",
);
assert.equal(
  graphRuntimeSource.includes("externalDataState?: ExternalGraphDataState"),
  true,
  "GraphRuntime must expose the shared external frame contract",
);
assert.equal(
  graphRuntimeSource.includes("selectGraphRuntimeDataState(internalDataState, externalDataState)"),
  true,
  "GraphRuntime must select external state only after calling its internal pipeline hook",
);

const fitYByXViewSource = readFileSync(
  resolve(process.cwd(), "src/components/fitYByX/FitYByXView.tsx"),
  "utf8",
);
assert.equal(
  fitYByXViewSource.includes("createEmbeddedGraphItem"),
  true,
  "FitYByXView must continue to derive an embedded graph item for GraphRuntime rather than altering GraphRuntime behavior",
);
assert.equal(
  fitYByXViewSource.includes("<GraphRuntime"),
  true,
  "FitYByXView must continue rendering GraphRuntime directly for the graph section",
);

console.log("graphRuntime contract tests passed");