import assert from "node:assert/strict";
import { useGraphBuilderNewStore } from "../src/stores/useGraphBuilderNewStore";
import { useProjectStore } from "../src/stores/useProjectStore";
const store = useGraphBuilderNewStore;
useProjectStore.setState({ readOnly: false, dirty: false });
store.getState().reset();
const id = store.getState().open("source", 1);
assert.equal(store.getState().items[0].version, 3);
assert.equal(store.getState().items[0].layers.length, 1);
assert.equal(store.getState().items[0].layers[0].options.summaryStat, "none");
store.getState().addLayer(id, "line");
const line = store.getState().items[0].layers[1];
assert.equal(line.options.summaryStat, "mean");
store.getState().setLayerOptions(id, line.id, { summaryStat: "median" });
assert.equal(store.getState().items[0].layers[0].options.summaryStat, "none");
assert.equal(store.getState().items[0].layers[1].options.summaryStat, "median");
useProjectStore.setState({ dirty: false });
store.getState().setLayerOptions(id, line.id, { summaryStat: "median" });
assert.equal(useProjectStore.getState().dirty, false);
useProjectStore.setState({ readOnly: true });
assert.throws(() => store.getState().removeLayer(id, line.id));
useProjectStore.setState({ readOnly: false });
for (const layer of store.getState().items[0].layers) store.getState().removeLayer(id, layer.id);
assert.equal(store.getState().items[0].layers.length, 0);
for (const rawMode of ["scatter", "line", "pointsLine"] as const) for (const showMean of [false, true]) {
  store.getState().loadFromProject([{ version: 2, id: "legacy", name: "Old", datasetId: "source", xColumnId: "x", yColumnId: "y", xMode: "auto", rawMode, showMean, overlayColumnId: null, hiddenOverlayGroupIds: [], camera: null }]);
  const doc = store.getState().items[0];
  assert.equal(doc.layers.length, (rawMode === "pointsLine" ? 2 : 1) + Number(showMean));
  assert.equal(doc.version, 3);
  if (showMean) { assert.equal(doc.layers.at(-1)!.options.summaryStat, "mean"); assert.equal(doc.layers.at(-1)!.options.errorInterval, "none"); }
  assert.equal("rawMode" in doc, false); assert.equal("showMean" in doc, false);
  const snapshot = JSON.stringify(doc);
  useProjectStore.setState({ dirty: false });
  store.getState().loadFromProject([JSON.parse(snapshot)]);
  assert.equal(JSON.stringify(store.getState().items[0]), snapshot);
  assert.equal(useProjectStore.getState().dirty, false);
}
console.log("graph new layers migration/store contracts passed");

store.getState().reset();const timeId=store.getState().open("source",1);store.getState().addLayer(timeId,"timeSeries");assert.equal(store.getState().items[0].xMode,"time");
