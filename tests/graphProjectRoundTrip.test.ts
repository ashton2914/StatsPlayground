import assert from "node:assert/strict";

import { createEmbeddedGraphItem, normalizeGraphBuilderItem } from "../src/components/graphBuilder/graphBuilderMode.ts";
import type { EmbeddedGraphConfig, GraphBuilderItem } from "../src/types/graphBuilder.ts";

const representative: GraphBuilderItem = normalizeGraphBuilderItem({
  id: "graph-time-series",
  name: "Saved Time Series",
  sourceDatasetId: "dataset-1",
  createdAt: "2026-09-16T00:00:00.000Z",
  mode: "2d",
  modeStates: {
    twoD: {
      encoding: {
        x: { name: "Captured", type: "nominal" },
        y: { name: "Reading", type: "continuous" },
      },
      multiX: [],
      multiY: [],
      elements: [{ kind: "timeSeries", enabled: true, options: {
        xInterpretation: { kind: "textDate", format: "usDate" },
        order: "timeAscending",
        missingValues: "break",
        connection: "line",
        markerMode: "auto",
      } }],
      smootherLambda: 0.4,
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
  sampling: { mode: "full" },
});

const savedConfig: EmbeddedGraphConfig = JSON.parse(JSON.stringify({
  mode: representative.mode,
  modeStates: representative.modeStates,
  sampling: representative.sampling,
  groupThemeSlots: representative.groupThemeSlots,
}));

const reopened = createEmbeddedGraphItem({
  id: representative.id,
  name: representative.name,
  sourceDatasetId: representative.sourceDatasetId,
  createdAt: representative.createdAt,
  config: savedConfig,
});

assert.deepEqual(reopened.modeStates.twoD.elements, representative.modeStates.twoD.elements);
assert.deepEqual(reopened.sampling, { mode: "full" });
assert.deepEqual(reopened.modeStates.twoD.elements[0]?.options, {
  xInterpretation: { kind: "textDate", format: "usDate" },
  order: "timeAscending",
  missingValues: "break",
  connection: "line",
  markerMode: "auto",
});

const oldGenericGraph = normalizeGraphBuilderItem({
  ...representative,
  id: "graph-old-line",
  modeStates: {
    ...representative.modeStates,
    twoD: {
      ...representative.modeStates.twoD,
      elements: [{ kind: "points", enabled: true }, { kind: "line", enabled: true }],
    },
  },
  sampling: { mode: "sample", size: 8000, seed: 11 },
});

assert.deepEqual(oldGenericGraph.modeStates.twoD.elements, [
  { kind: "points", enabled: true },
  { kind: "line", enabled: true },
]);
assert.deepEqual(oldGenericGraph.sampling, { mode: "sample", size: 8000, seed: 11 });

console.log("graph project round-trip tests passed");