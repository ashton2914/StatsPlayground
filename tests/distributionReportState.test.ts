import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  createDistributionReportController,
  createDistributionRequest,
  distributionRequestFingerprint,
  type DistributionReportState,
} from "../src/components/distribution/useDistributionReport.ts";
import type {
  DistributionAnalysisConfig,
  DistributionItem,
  DistributionReportResponse,
} from "../src/types/distribution.ts";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  let reject!: Deferred<T>["reject"];
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

const analysis: DistributionAnalysisConfig = {
  confidenceLevel: 0.95,
  specLimits: {},
  fitDistributions: [],
};

function item(overrides: Partial<DistributionItem> = {}): DistributionItem {
  const graph = {
    mode: "2d" as const,
    modeStates: {
      twoD: { encoding: {}, multiX: [], multiY: [], elements: [], smootherLambda: 0.5 },
      threeD: { encoding: {}, elements: [], smootherLambda: 0.5 },
      multivariate: { columns: [], chartType: "correlationMatrix" as const, correlationMethod: "pearson" as const },
    },
    filters: [],
    sampling: { mode: "full" as const },
  };
  return {
    id: "distribution-1",
    name: "Distribution 1",
    sourceDatasetId: "dataset-1",
    responses: [{ name: "height", type: "continuous" }],
    weight: { name: "weight", type: "continuous" },
    frequency: { name: "count", type: "continuous" },
    by: [{ name: "site", type: "nominal" }],
    analysis,
    graphs: { overview: graph, boxPlot: graph, ecdf: graph, normalQuantile: graph },
    createdAt: "2026-09-02T00:00:00.000Z",
    ...overrides,
  };
}

function response(datasetId: string, generation: number): DistributionReportResponse {
  const frame = { columns: [], rows: [], aggregatePackets: [], totalRows: 0 } as never;
  return {
    datasetId,
    generation,
    groups: [],
    reportBlocks: [],
    graphFrames: { overview: frame, boxPlot: frame, ecdf: frame, normalQuantile: frame },
  };
}

const request = createDistributionRequest(item(), 7);
assert.deepEqual(request, {
  datasetId: "dataset-1",
  generation: 7,
  responseColumns: ["height"],
  weightColumn: "weight",
  freqColumn: "count",
  byColumns: ["site"],
  confidenceLevel: 0.95,
  specLimits: {},
  fitDistributions: [],
});

const baseFingerprint = distributionRequestFingerprint(item());
const requestAffectingMutations: Partial<DistributionItem>[] = [
  { sourceDatasetId: "dataset-2" },
  { responses: [{ name: "width", type: "continuous" }] },
  { weight: null },
  { frequency: null },
  { by: [{ name: "batch", type: "ordinal" }] },
  { analysis: { ...analysis, confidenceLevel: 0.9 } },
  { analysis: { ...analysis, specLimits: { height: { lsl: 1, target: 2, usl: 3 } } } },
  { analysis: { ...analysis, fitDistributions: ["normal"] } },
];
for (const mutation of requestAffectingMutations) {
  assert.notEqual(distributionRequestFingerprint(item(mutation)), baseFingerprint);
}
assert.equal(
  distributionRequestFingerprint(item({
    graphs: {
      ...item().graphs,
      overview: {
        ...item().graphs.overview,
        modeStates: {
          ...item().graphs.overview.modeStates,
          twoD: {
            ...item().graphs.overview.modeStates.twoD,
            xAxis: { min: 1, max: 5 },
          },
        },
      },
    },
  })),
  baseFingerprint,
  "graph-only updates must not affect the report request fingerprint",
);
assert.equal(
  distributionRequestFingerprint(item({
    analysis: {
      ...analysis,
      specLimits: {
        width: { lsl: null, target: 2, usl: 3 },
        height: { lsl: 1, target: 2, usl: null },
      },
    },
  })),
  distributionRequestFingerprint(item({
    analysis: {
      ...analysis,
      specLimits: {
        height: { usl: null, target: 2, lsl: 1 },
        width: { usl: 3, target: 2, lsl: null },
      },
    },
  })),
);

async function testLoadingSuccessAndError(): Promise<void> {
  const states: DistributionReportState[] = [];
  const controller = createDistributionReportController({
    getDatasetGeneration: async () => 3,
    compute: async (nextRequest) => response(nextRequest.datasetId, nextRequest.generation),
    onStateChange: (state) => states.push(state),
  });
  await controller.load(item());
  assert.equal(states[0]?.status, "loading");
  assert.equal(states.at(-1)?.status, "success");

  const failure = createDistributionReportController({
    getDatasetGeneration: async () => 4,
    compute: async () => { throw { message: "backend failed" }; },
  });
  await failure.load(item());
  assert.equal(failure.getState().status, "error");
  assert.equal(failure.getState().status === "error" && failure.getState().error, "backend failed");
}

async function testLatestRequestAndEchoFences(): Promise<void> {
  const first = deferred<DistributionReportResponse>();
  const second = deferred<DistributionReportResponse>();
  let computeCalls = 0;
  const controller = createDistributionReportController({
    getDatasetGeneration: async () => 5,
    compute: async () => (++computeCalls === 1 ? first.promise : second.promise),
  });
  const firstLoad = controller.load(item());
  await flush();
  const secondLoad = controller.load(item({ id: "distribution-2" }));
  await flush();
  second.resolve(response("dataset-1", 5));
  await secondLoad;
  assert.equal(controller.getState().status === "success" && controller.getState().itemId, "distribution-2");
  first.resolve(response("dataset-1", 5));
  await firstLoad;
  assert.equal(controller.getState().status === "success" && controller.getState().itemId, "distribution-2");

  const echoMismatch = createDistributionReportController({
    getDatasetGeneration: async () => 6,
    compute: async () => response("other-dataset", 99),
  });
  await echoMismatch.load(item());
  assert.equal(echoMismatch.getState().status, "error");
}

async function testMutationGenerationCancelAndDispose(): Promise<void> {
  let current = item();
  let generation = 8;
  const pending = deferred<DistributionReportResponse>();
  const controller = createDistributionReportController({
    getDatasetGeneration: async () => generation,
    compute: async () => pending.promise,
    getCurrentItem: () => current,
  });
  const loading = controller.load(current);
  await flush();
  current = { ...current, analysis: { ...current.analysis, confidenceLevel: 0.9 } };
  pending.resolve(response("dataset-1", 8));
  await loading;
  assert.notEqual(controller.getState().status, "success");

  const generationPending = deferred<DistributionReportResponse>();
  current = item();
  const generationController = createDistributionReportController({
    getDatasetGeneration: async () => generation,
    compute: async () => generationPending.promise,
    getCurrentItem: () => current,
  });
  const generationLoad = generationController.load(current);
  await flush();
  generation = 9;
  generationPending.resolve(response("dataset-1", 8));
  await generationLoad;
  assert.notEqual(generationController.getState().status, "success");

  for (const action of ["cancel", "dispose"] as const) {
    const late = deferred<DistributionReportResponse>();
    const states: DistributionReportState[] = [];
    const lateController = createDistributionReportController({
      getDatasetGeneration: async () => 10,
      compute: async () => late.promise,
      onStateChange: (state) => states.push(state),
    });
    const lateLoad = lateController.load(item());
    await flush();
    lateController[action]();
    late.resolve(response("dataset-1", 10));
    await lateLoad;
    assert.notEqual(states.at(-1)?.status, "success");
  }
}

await testLoadingSuccessAndError();
await testLatestRequestAndEchoFences();
await testMutationGenerationCancelAndDispose();

const hookSource = readFileSync(
  new URL("../src/components/distribution/useDistributionReport.ts", import.meta.url),
  "utf8",
);
assert.doesNotMatch(
  hookSource,
  /\[[^\]]*getDatasetGeneration, item\]/,
  "graph-only item identity changes must not restart the report effect",
);

console.log("distribution report state contract passed");