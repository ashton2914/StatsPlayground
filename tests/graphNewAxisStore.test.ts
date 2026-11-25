import assert from "node:assert/strict";

import { normalizeGraphNewDocument, useGraphBuilderNewStore } from "../src/stores/useGraphBuilderNewStore.ts";
import { useProjectStore } from "../src/stores/useProjectStore.ts";
import type { PersistedGraphBuilderNewDocument } from "../src/types/graphBuilderNew.ts";

// 1. Legacy v1/v2/v3 documents without axis settings normalize cleanly.
const legacyV1: PersistedGraphBuilderNewDocument = {
  version: 1,
  id: "doc-v1",
  name: "Legacy 1",
  datasetId: "ds-1",
  xColumnId: "col-x",
  yColumnId: "col-y",
  showMean: false,
  xMode: "auto",
  rawMode: "scatter",
  camera: null,
};
const normV1 = normalizeGraphNewDocument(legacyV1);
assert.equal(normV1.version, 3);
assert.equal(normV1.xAxisConfig, undefined);
assert.equal(normV1.yAxisConfig, undefined);
assert.equal(normV1.refLinesX, undefined);
assert.equal(normV1.refLinesY, undefined);
assert.equal(normV1.autoSpecLinesX, undefined);
assert.equal(normV1.autoSpecLinesY, undefined);

// 2. Valid v3 axis configs, ref lines, and autoSpec flags are preserved; invalid/empty values sanitized.
const v3WithAxis: PersistedGraphBuilderNewDocument = {
  version: 3,
  id: "doc-v3",
  name: "Axis Doc",
  datasetId: "ds-1",
  xColumnId: "col-x",
  yColumnId: "col-y",
  overlayColumnId: null,
  hiddenOverlayGroupIds: [],
  xMode: "numeric",
  camera: null,
  layers: [],
  xAxisConfig: {
    min: Number.NaN,
    max: 100,
    tickInterval: -5,
    decimals: 15,
    minorTickCount: 25,
    inverse: true,
    showAxisLine: false,
    tickPosition: "inside",
    showMajorGrid: true,
    showMinorGrid: true,
    majorGridStyle: { color: "#1976d2", width: 2, style: "solid" },
    minorGridStyle: { color: "#bbdefb", width: 0.5, style: "dotted" },
  },
  yAxisConfig: {
    inverse: false,
    minorTickCount: 0,
  },
  refLinesX: [
    { id: "rx-1", x: 12.5, label: "Cut", style: "dashed", color: "#E60000", width: 1.5 },
    { id: "rx-bad", x: Number.NaN, label: "Bad", style: "solid", color: "#000000", width: 1 },
  ],
  refLinesY: [
    { id: "ry-1", y: 50, label: "Target", style: "dotted", color: "#00C853", width: 2 },
  ],
  autoSpecLinesX: false,
  autoSpecLinesY: true,
};
const normV3 = normalizeGraphNewDocument(v3WithAxis);
assert.deepEqual(normV3.xAxisConfig, {
  max: 100,
  decimals: 10,
  minorTickCount: 20,
  inverse: true,
  showAxisLine: false,
  tickPosition: "inside",
  showMajorGrid: true,
  showMinorGrid: true,
  majorGridStyle: { color: "#1976d2", width: 2, style: "solid" },
  minorGridStyle: { color: "#bbdefb", width: 0.5, style: "dotted" },
});
assert.equal(normV3.yAxisConfig, undefined, "empty yAxisConfig should be dropped");
assert.deepEqual(normV3.refLinesX, [
  { id: "rx-1", x: 12.5, label: "Cut", style: "dashed", color: "#E60000", width: 1.5 },
]);
assert.deepEqual(normV3.refLinesY, [
  { id: "ry-1", y: 50, label: "Target", style: "dotted", color: "#00C853", width: 2 },
]);
assert.equal(normV3.autoSpecLinesX, undefined);
assert.equal(normV3.autoSpecLinesY, true);

// 3. Store actions mutate items + sessions, mark project dirty, preserve across setColumns, and enforce readOnly.
useProjectStore.setState({ readOnly: false, dirty: false });
useGraphBuilderNewStore.getState().reset();
const id = useGraphBuilderNewStore.getState().open("ds-1", 1);
useGraphBuilderNewStore.getState().setColumns(id, "col-x", "col-y");
useGraphBuilderNewStore.getState().setCamera(id, { xMin: 0, xMax: 10, yMin: 0, yMax: 20 });

useProjectStore.setState({ dirty: false });
useGraphBuilderNewStore.getState().setYAxisConfig(id, { min: 0, max: 100, decimals: 2, showMajorGrid: true });
useGraphBuilderNewStore.getState().setXAxisConfig(id, { inverse: true });
useGraphBuilderNewStore.getState().setRefLinesY(id, [{ id: "r1", y: 50, label: "Mid", style: "dashed", color: "#E60000", width: 1 }]);
useGraphBuilderNewStore.getState().setRefLinesX(id, [{ id: "r2", x: 5, label: "X5", style: "solid", color: "#2962FF", width: 2 }]);
useGraphBuilderNewStore.getState().setAutoSpecLinesY(id, true);
useGraphBuilderNewStore.getState().setAutoSpecLinesX(id, true);

assert.equal(useProjectStore.getState().dirty, true);
const item = useGraphBuilderNewStore.getState().items.find((d) => d.id === id)!;
const session = useGraphBuilderNewStore.getState().sessions.find((s) => s.id === id)!;
assert.deepEqual(item.yAxisConfig, { min: 0, max: 100, decimals: 2, showMajorGrid: true });
assert.deepEqual(session.yAxisConfig, item.yAxisConfig);
assert.deepEqual(item.xAxisConfig, { inverse: true });
assert.deepEqual(session.refLinesY, item.refLinesY);
assert.equal(session.autoSpecLinesY, true);
assert.equal(session.autoSpecLinesX, true);

// Changing columns resets camera but preserves axis settings non-destructively.
useGraphBuilderNewStore.getState().setColumns(id, "col-cat", "col-y");
const afterColChange = useGraphBuilderNewStore.getState().items.find((d) => d.id === id)!;
assert.equal(afterColChange.camera, null);
assert.deepEqual(afterColChange.xAxisConfig, { inverse: true });
assert.deepEqual(afterColChange.refLinesX, [{ id: "r2", x: 5, label: "X5", style: "solid", color: "#2962FF", width: 2 }]);

// Resetting config to undefined clears it cleanly.
useGraphBuilderNewStore.getState().setYAxisConfig(id, undefined);
assert.equal(useGraphBuilderNewStore.getState().items.find((d) => d.id === id)!.yAxisConfig, undefined);

// Read-only mode blocks mutations.
useProjectStore.setState({ readOnly: true });
assert.throws(() => useGraphBuilderNewStore.getState().setYAxisConfig(id, { inverse: true }));
assert.throws(() => useGraphBuilderNewStore.getState().setRefLinesY(id, []));
assert.throws(() => useGraphBuilderNewStore.getState().setAutoSpecLinesY(id, false));

useProjectStore.setState({ readOnly: false, dirty: false });
useGraphBuilderNewStore.getState().reset();
console.log("graphNewAxisStore.test.ts passed");
