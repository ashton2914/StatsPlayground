import assert from "node:assert/strict";

const [
  { createFitYByXItem },
  { createEmbeddedGraphItem },
  { useGraphBuilderStore },
  { useProjectStore },
  { useFitYByXStore },
] = await Promise.all([
  import("../src/components/fitYByX/fitYByXConfig.ts"),
  import("../src/components/graphBuilder/graphBuilderMode.ts"),
  import("../src/stores/useGraphBuilderStore.ts"),
  import("../src/stores/useProjectStore.ts"),
  import("../src/stores/index.ts"),
]);

const response = { name: "height", type: "continuous" as const };
const factor = { name: "site", type: "nominal" as const };
const bivariateFactor = { name: "age", type: "continuous" as const };
const createdAt = "2026-08-30T00:00:00.000Z";

function fitItem(id: string, name: string, datasetId = "dataset-1") {
  return createFitYByXItem({
    id,
    name,
    sourceDatasetId: datasetId,
    response,
    factor,
    createdAt,
  });
}

function bivariateFitItem(id: string, name: string, datasetId = "dataset-1") {
  return createFitYByXItem({
    id,
    name,
    sourceDatasetId: datasetId,
    response,
    factor: bivariateFactor,
    createdAt,
  });
}

function resetStores() {
  useProjectStore.setState({ readOnly: false });
  useFitYByXStore.getState().reset();
  useGraphBuilderStore.getState().reset();
}

resetStores();

const loadedBase = fitItem("fit-2", "Fit Y by X 2");
const loadedCustom = fitItem("fit-custom", "Custom fit", "dataset-2");
const loadedBivariate = bivariateFitItem("fit-bivar", "Fit Y by X 4", "dataset-4");
const malformedBivariate = bivariateFitItem("fit-malformed-bivariate", "Malformed bivariate");
const mixedOneway = fitItem("fit-mixed-oneway", "Mixed oneway");
const mixedBivariate = bivariateFitItem("fit-mixed-bivariate", "Mixed bivariate");
const persistedGraph = {
  ...loadedBase.graph,
  mode: "2d" as const,
  groupThemeSlots: { site: { A: 0, B: 0, C: -1, D: 2 } },
  modeStates: {
    ...loadedBase.graph.modeStates,
    twoD: {
      ...loadedBase.graph.modeStates.twoD,
      smootherLambda: 0.8,
      elements: [
        { kind: "points", enabled: false },
        { kind: "boxplot", enabled: true },
      ],
      hiddenGroups: ["site:B"],
      yAxis: { min: 10, max: 20 },
    },
  },
};
const persistedBivariateGraph = {
  ...loadedBivariate.graph,
  mode: "2d" as const,
  modeStates: {
    ...loadedBivariate.graph.modeStates,
    twoD: {
      ...loadedBivariate.graph.modeStates.twoD,
      smootherLambda: 0.15,
      hiddenGroups: ["age:3"],
      xAxis: { title: { text: "Age" } },
      yAxis: { min: 2, max: 12 },
      elements: [
        { kind: "points", enabled: false },
        { kind: "fitline", enabled: true, options: { fitType: "polynomial", degree: 1, showFitCI: true } },
      ],
    },
  },
};
const expectedPersistedGraph = createEmbeddedGraphItem({
  id: "fit-y-by-x-graph:fit-2",
  name: "Fit Y by X 2",
  sourceDatasetId: "dataset-1",
  config: persistedGraph,
  createdAt,
});
const expectedPersistedBivariateGraph = createEmbeddedGraphItem({
  id: "fit-y-by-x-graph:fit-bivar",
  name: "Fit Y by X 4",
  sourceDatasetId: "dataset-4",
  config: persistedBivariateGraph,
  createdAt,
});

useFitYByXStore.getState().loadFromProject([
  { ...loadedBase, graph: persistedGraph },
  { ...loadedBivariate, graph: persistedBivariateGraph },
  {
    ...mixedOneway,
    graph: {
      ...mixedOneway.graph,
      modeStates: {
        ...mixedOneway.graph.modeStates,
        twoD: {
          ...mixedOneway.graph.modeStates.twoD,
          elements: [
            ...mixedOneway.graph.modeStates.twoD.elements,
            { kind: "fitline", enabled: true as const },
          ],
        },
      },
    },
  },
  {
    ...mixedBivariate,
    graph: {
      ...mixedBivariate.graph,
      modeStates: {
        ...mixedBivariate.graph.modeStates,
        twoD: {
          ...mixedBivariate.graph.modeStates.twoD,
          elements: [
            ...mixedBivariate.graph.modeStates.twoD.elements,
            { kind: "boxplot", enabled: true as const },
          ],
        },
      },
    },
  },
  loadedCustom,
  { ...fitItem("fit-legacy", "Legacy fit"), graph: undefined } as never,
  { ...fitItem("fit-malformed", "Malformed fit"), graph: { mode: "bogus" } } as never,
  {
    ...malformedBivariate,
    personality: "oneway",
    graph: { mode: "bogus" },
  } as never,
  {
    ...fitItem("fit-partial", "Partial fit"),
    graph: {
      mode: "2d",
      modeStates: { twoD: {}, threeD: {}, multivariate: {} },
    },
  } as never,
  {
    ...fitItem("fit-invalid-roles", "Fit Y by X 99"),
    response: factor,
  } as never,
]);

const loadedItem = useFitYByXStore.getState().items.find(({ id }) => id === "fit-2");
assert.ok(loadedItem);
assert.deepEqual(loadedItem?.graph, {
  mode: expectedPersistedGraph.mode,
  modeStates: expectedPersistedGraph.modeStates,
  filters: expectedPersistedGraph.filters,
  sampling: expectedPersistedGraph.sampling,
  groupThemeSlots: { site: { A: 0, D: 2 } },
});
assert.deepEqual(loadedItem?.response, response);
assert.deepEqual(loadedItem?.factor, factor);
assert.equal(loadedItem?.createdAt, createdAt);
const loadedBivariateItem = useFitYByXStore.getState().items.find(({ id }) => id === "fit-bivar");
assert.ok(loadedBivariateItem);
assert.equal(loadedBivariateItem?.personality, "bivariate");
assert.deepEqual(loadedBivariateItem?.graph, {
  mode: expectedPersistedBivariateGraph.mode,
  modeStates: expectedPersistedBivariateGraph.modeStates,
  filters: expectedPersistedBivariateGraph.filters,
  sampling: expectedPersistedBivariateGraph.sampling,
});
assert.deepEqual(
  useFitYByXStore.getState().items.find(({ id }) => id === "fit-mixed-oneway")?.graph,
  mixedOneway.graph,
);
assert.deepEqual(
  useFitYByXStore.getState().items.find(({ id }) => id === "fit-mixed-bivariate")?.graph,
  mixedBivariate.graph,
);
assert.deepEqual(
  useFitYByXStore.getState().items.find(({ id }) => id === "fit-legacy")?.graph,
  fitItem("fit-legacy", "Legacy fit").graph,
);
assert.equal(
  useFitYByXStore.getState().items.find(({ id }) => id === "fit-legacy")?.personality,
  "oneway",
);
assert.deepEqual(
  useFitYByXStore.getState().items.find(({ id }) => id === "fit-malformed")?.graph,
  fitItem("fit-malformed", "Malformed fit").graph,
);
assert.equal(
  useFitYByXStore.getState().items.find(({ id }) => id === "fit-malformed-bivariate")?.personality,
  "bivariate",
);
assert.deepEqual(
  useFitYByXStore.getState().items.find(({ id }) => id === "fit-malformed-bivariate")?.graph,
  malformedBivariate.graph,
);
assert.deepEqual(
  useFitYByXStore.getState().items.find(({ id }) => id === "fit-malformed-bivariate")?.graph.modeStates.twoD.elements,
  [
    { kind: "points", enabled: true },
    { kind: "fitline", enabled: true, options: { fitType: "polynomial", degree: 1, showFitCI: true } },
  ],
);
assert.deepEqual(
  useFitYByXStore.getState().items.find(({ id }) => id === "fit-partial")?.graph,
  fitItem("fit-partial", "Partial fit").graph,
);
assert.equal(
  useFitYByXStore.getState().items.some(({ id }) => id === "fit-invalid-roles"),
  false,
);
assert.equal(useFitYByXStore.getState().nextName(), "Fit Y by X 5");
assert.deepEqual(useGraphBuilderStore.getState().items, []);

useFitYByXStore.getState().addItem(fitItem("fit-8", "Fit Y by X 8"));
assert.equal(useFitYByXStore.getState().nextName(), "Fit Y by X 9");

useFitYByXStore.getState().updateItem("fit-2", {
  sourceDatasetId: "dataset-9",
  response: { name: "weight", type: "continuous" },
});
assert.equal(
  useFitYByXStore.getState().items.find(({ id }) => id === "fit-2")?.sourceDatasetId,
  "dataset-9",
);
assert.deepEqual(
  useFitYByXStore.getState().items.find(({ id }) => id === "fit-2")?.response,
  { name: "weight", type: "continuous" },
);

useFitYByXStore.getState().renameItem("fit-custom", "Fit Y by X 12");
assert.equal(useFitYByXStore.getState().nextName(), "Fit Y by X 13");

useFitYByXStore.getState().deleteByDataset("dataset-9");
assert.equal(useFitYByXStore.getState().items.some(({ id }) => id === "fit-2"), false);

useFitYByXStore.getState().deleteItem("fit-8");
assert.deepEqual(
  useFitYByXStore.getState().items.map(({ id }) => id),
  [
    "fit-bivar",
    "fit-mixed-oneway",
    "fit-mixed-bivariate",
    "fit-custom",
    "fit-legacy",
    "fit-malformed",
    "fit-malformed-bivariate",
    "fit-partial",
  ],
);

useProjectStore.setState({ readOnly: true });
assert.throws(
  () => useFitYByXStore.getState().addItem(fitItem("blocked", "Fit Y by X 99")),
  /Project is read-only while save is in progress\./,
);
assert.throws(
  () => useFitYByXStore.getState().nextName(),
  /Project is read-only while save is in progress\./,
);
useProjectStore.setState({ readOnly: false });

const unexpectedItem = fitItem("fit-unexpected", "Unexpected fit");
Object.defineProperty(unexpectedItem, "id", {
  get() {
    throw new Error("unexpected normalization failure");
  },
});
assert.throws(
  () => useFitYByXStore.getState().loadFromProject([unexpectedItem]),
  /unexpected normalization failure/,
);

useFitYByXStore.getState().reset();
assert.deepEqual(useFitYByXStore.getState().items, []);
assert.equal(useFitYByXStore.getState().counter, 0);

console.log("fitYByX store contract passed");