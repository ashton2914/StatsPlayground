import assert from "node:assert/strict";

import { createDistributionReportController } from "../src/components/distribution/useDistributionReport.ts";
import { useDistributionStore } from "../src/stores/useDistributionStore.ts";
import type { DistributionItem, DistributionReportResponse } from "../src/types/distribution.ts";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

const graph = {
  mode: "2d" as const,
  modeStates: {
    twoD: { encoding: {}, multiX: [], multiY: [], elements: [], smootherLambda: 0.5 },
    threeD: { encoding: {}, elements: [], smootherLambda: 0.5 },
    multivariate: {
      columns: [],
      chartType: "correlationMatrix" as const,
      correlationMethod: "pearson" as const,
    },
  },
  filters: [],
  sampling: { mode: "full" as const },
};

function item(id: string, responseName: string): DistributionItem {
  return {
    id,
    name: id,
    sourceDatasetId: "dataset-1",
    responses: [{ name: responseName, type: "continuous" }],
    weight: null,
    frequency: null,
    by: [],
    analysis: { confidenceLevel: 0.95, specLimits: {}, fitDistributions: [] },
    graphs: { overview: graph, boxPlot: graph, ecdf: graph, normalQuantile: graph },
    createdAt: "2026-09-02T00:00:00.000Z",
  };
}

function response(generation = 4): DistributionReportResponse {
  const frame = { columns: [], rows: [], aggregatePackets: [], totalRows: 0 } as never;
  return {
    datasetId: "dataset-1",
    generation,
    groups: [],
    reportBlocks: [],
    graphFrames: { overview: frame, boxPlot: frame, ecdf: frame, normalQuantile: frame },
  };
}

const firstItem = item("distribution-1", "height");
const secondItem = item("distribution-2", "width");
useDistributionStore.getState().loadFromProject([firstItem, secondItem]);
assert.deepEqual(
  useDistributionStore.getState().items.map(({ id, responses }) => [id, responses[0]?.name]),
  [["distribution-1", "height"], ["distribution-2", "width"]],
);
assert.deepEqual(Object.keys(useDistributionStore.getState()).sort(), [
  "addItem",
  "counter",
  "createItem",
  "deleteByDataset",
  "deleteItem",
  "items",
  "loadFromProject",
  "nextName",
  "renameItem",
  "reset",
  "updateItem",
]);

const late = deferred<DistributionReportResponse>();
const firstController = createDistributionReportController({
  getDatasetGeneration: async () => 4,
  compute: async () => late.promise,
});
const secondController = createDistributionReportController({
  getDatasetGeneration: async () => 4,
  compute: async () => response(),
});
const firstLoad = firstController.load(firstItem);
await flush();
await secondController.load(secondItem);
firstController.dispose();
late.resolve(response());
await firstLoad;
assert.equal(secondController.getState().status, "success");
assert.notEqual(firstController.getState().status, "success");

let recomputes = 0;
for (let openCount = 0; openCount < 2; openCount += 1) {
  const controller = createDistributionReportController({
    getDatasetGeneration: async () => 4,
    compute: async () => {
      recomputes += 1;
      return response();
    },
  });
  await controller.load(firstItem);
  assert.equal(controller.getState().status, "success");
  controller.dispose();
}
assert.equal(recomputes, 2);

useDistributionStore.getState().reset();
console.log("distribution isolation contracts OK");