import assert from "node:assert/strict";

const [
  { createDistributionItem },
  { useProjectStore },
  { useDistributionStore },
] = await Promise.all([
  import("../src/components/distribution/distributionConfig.ts"),
  import("../src/stores/useProjectStore.ts"),
  import("../src/stores/useDistributionStore.ts"),
]);

const columns = [
  { name: "height", sqlType: "DOUBLE", integerCompatible: false, field: { name: "height", type: "continuous" as const } },
  { name: "site", sqlType: "VARCHAR", integerCompatible: false, field: { name: "site", type: "nominal" as const } },
];

function item(id: string, name: string, datasetId = "dataset-1") {
  return createDistributionItem({
    id,
    name,
    sourceDatasetId: datasetId,
    responses: [columns[0]!.field],
    weight: null,
    frequency: null,
    by: [columns[1]!.field],
    columns,
    createdAt: "2026-09-02T00:00:00.000Z",
  });
}

function reset(): void {
  useProjectStore.setState({ readOnly: false });
  useDistributionStore.getState().reset();
}

reset();
assert.equal(useDistributionStore.getState().nextName(), "Distribution 1");
const created = useDistributionStore.getState().createItem({
  id: "created",
  sourceDatasetId: "dataset-1",
  responses: [columns[0]!.field],
  weight: null,
  frequency: null,
  by: [columns[1]!.field],
  columns,
  createdAt: "2026-09-02T00:00:00.000Z",
});
assert.equal(created.name, "Distribution 2");
assert.deepEqual(useDistributionStore.getState().items, [created]);

useDistributionStore.getState().addItem(item("manual", "Distribution 7", "dataset-2"));
assert.equal(useDistributionStore.getState().nextName(), "Distribution 8");
useDistributionStore.getState().updateItem("created", {
  analysis: {
    confidenceLevel: 0.9,
    specLimits: { height: { lsl: 1, target: 2, usl: 3 } },
    fitDistributions: ["normal"],
  },
});
assert.equal(useDistributionStore.getState().items[0]?.analysis.confidenceLevel, 0.9);
useDistributionStore.getState().renameItem("created", "Distribution 12");
assert.equal(useDistributionStore.getState().nextName(), "Distribution 13");
useDistributionStore.getState().deleteByDataset("dataset-2");
assert.equal(useDistributionStore.getState().items.some(({ id }) => id === "manual"), false);
useDistributionStore.getState().deleteItem("created");
assert.deepEqual(useDistributionStore.getState().items, []);

const valid = item("loaded", "Distribution 4");
const customOverview = {
  ...valid.graphs.overview,
  modeStates: {
    ...valid.graphs.overview.modeStates,
    twoD: {
      ...valid.graphs.overview.modeStates.twoD,
      xAxis: { min: 1, max: 10 },
    },
  },
};
const malformed = {
  ...item("malformed", "Malformed Distribution"),
  analysis: { confidenceLevel: 2 },
  graphs: { overview: { mode: "bogus" } },
};
const wrongGraphFamily = {
  ...item("wrong-family", "Wrong graph family"),
  graphs: {
    ...valid.graphs,
    overview: valid.graphs.boxPlot,
  },
};
const partial = {
  id: "partial",
  name: "Distribution 9",
  sourceDatasetId: "dataset-9",
  responses: [{ name: "height", type: "continuous" }],
  createdAt: "2026-09-02T00:00:00.000Z",
};
const invalidRoles = {
  ...item("invalid", "Distribution 99"),
  responses: [{ name: "site", type: "nominal" }],
};
useDistributionStore.getState().loadFromProject([
  { ...valid, graphs: { ...valid.graphs, overview: customOverview } },
  malformed,
  wrongGraphFamily,
  partial,
  invalidRoles,
]);
const loaded = useDistributionStore.getState().items;
assert.deepEqual(loaded.map(({ id }) => id), ["loaded", "malformed", "wrong-family", "partial"]);
assert.equal(loaded[0]?.graphs.overview.modeStates.twoD.xAxis?.min, 1);
assert.equal(loaded.find(({ id }) => id === "malformed")?.analysis.confidenceLevel, 0.95);
assert.deepEqual(
  loaded.find(({ id }) => id === "malformed")?.graphs.overview.modeStates.twoD.elements,
  valid.graphs.overview.modeStates.twoD.elements,
);
assert.deepEqual(
  loaded.find(({ id }) => id === "wrong-family")?.graphs.overview.modeStates.twoD.elements,
  valid.graphs.overview.modeStates.twoD.elements,
);
assert.deepEqual(loaded.find(({ id }) => id === "partial")?.by, []);
assert.equal(loaded.find(({ id }) => id === "partial")?.weight, null);
assert.equal(useDistributionStore.getState().nextName(), "Distribution 10");

const mutators = [
  () => useDistributionStore.getState().createItem({
    id: "blocked-create",
    sourceDatasetId: "dataset-1",
    responses: [columns[0]!.field],
    weight: null,
    frequency: null,
    by: [],
    columns,
    createdAt: "2026-09-02T00:00:00.000Z",
  }),
  () => useDistributionStore.getState().addItem(item("blocked-add", "Blocked")),
  () => useDistributionStore.getState().updateItem("loaded", { name: "Blocked" }),
  () => useDistributionStore.getState().renameItem("loaded", "Blocked"),
  () => useDistributionStore.getState().deleteItem("loaded"),
  () => useDistributionStore.getState().deleteByDataset("dataset-1"),
  () => useDistributionStore.getState().loadFromProject([]),
  () => useDistributionStore.getState().reset(),
  () => useDistributionStore.getState().nextName(),
];
useProjectStore.setState({ readOnly: true });
for (const mutate of mutators) {
  assert.throws(mutate, /Project is read-only while save is in progress\./);
}

useProjectStore.setState({ readOnly: false });
useDistributionStore.getState().reset();
assert.deepEqual(useDistributionStore.getState().items, []);
assert.equal(useDistributionStore.getState().counter, 0);
assert.equal("resultByAnalysisId" in useDistributionStore.getState(), false);
assert.equal("runState" in useDistributionStore.getState(), false);

console.log("distribution store contract passed");
