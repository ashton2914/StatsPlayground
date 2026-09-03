import assert from "node:assert/strict";

import { createAnalysisSampleDocument } from "../src/components/analysis/analysisSample.ts";
import type { DatasetMeta } from "../src/types/data.ts";
import type { DistributionReportResponse } from "../src/types/distribution.ts";
import {
  createAnalysisExecutionController,
  createAnalysisExecutionRequest,
  distributionAnalysisDefinitionFingerprint,
  type AnalysisExecutionState,
} from "../src/components/analysis/useAnalysisExecution.ts";

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

function analysis(overrides: Record<string, unknown> = {}) {
  return {
    ...createAnalysisSampleDocument({
      datasetId: "dataset-1",
      analysisId: "analysis-1",
      analysisName: "Strength Distribution",
      createdAt: "2026-09-03T00:00:00.000Z",
    }),
    ...overrides,
  };
}

function dataset(overrides: Partial<DatasetMeta> = {}): DatasetMeta {
  return {
    id: "dataset-1",
    name: "Incoming Data",
    sourcePath: null,
    sourceType: "manual",
    rowCount: 10,
    colCount: 1,
    generation: 7,
    createdAt: "2026-09-03T00:00:00.000Z",
    updatedAt: "2026-09-03T00:00:00.000Z",
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
    graphFrames: {
      overview: frame,
      boxPlot: frame,
      ecdf: frame,
      normalQuantile: frame,
    },
  };
}

const request = createAnalysisExecutionRequest(analysis(), 7);
assert.deepEqual(request, {
  datasetId: "dataset-1",
  generation: 7,
  responseColumns: ["DIM1"],
  weightColumn: null,
  freqColumn: null,
  byColumns: [],
  confidenceLevel: 0.95,
  specLimits: {},
  fitDistributions: ["normal"],
});

const baseFingerprint = distributionAnalysisDefinitionFingerprint(analysis());
assert.notEqual(
  distributionAnalysisDefinitionFingerprint(analysis({ configRevision: 2 })),
  baseFingerprint,
);
assert.notEqual(
  distributionAnalysisDefinitionFingerprint(analysis({
    definition: {
      ...analysis().definition,
      responses: [{ name: "DIM2", type: "continuous" }],
    },
  })),
  baseFingerprint,
);
assert.equal(
  distributionAnalysisDefinitionFingerprint(analysis({
    definition: {
      ...analysis().definition,
      graphs: {
        ...analysis().definition.graphs,
        overview: {
          ...analysis().definition.graphs.overview,
          modeStates: {
            ...analysis().definition.graphs.overview.modeStates,
            twoD: {
              ...analysis().definition.graphs.overview.modeStates.twoD,
              xAxis: { min: 1, max: 4 },
            },
          },
        },
      },
    },
  })),
  baseFingerprint,
  "graph-only presentation changes must not invalidate the analysis execution request fingerprint",
);

async function testLoadingSuccessAndError(): Promise<void> {
  const states: AnalysisExecutionState[] = [];
  const controller = createAnalysisExecutionController({
    getDatasetGeneration: async () => 3,
    compute: async (nextRequest) => response(nextRequest.datasetId, nextRequest.generation),
    onStateChange: (state) => states.push(state),
  });
  await controller.load(analysis(), dataset());
  assert.equal(states[0]?.status, "loading");
  assert.equal(states.at(-1)?.status, "success");

  const failure = createAnalysisExecutionController({
    getDatasetGeneration: async () => 4,
    compute: async () => {
      throw { message: "backend failed" };
    },
  });
  await failure.load(analysis(), dataset());
  assert.equal(failure.getState().status, "error");
  assert.equal(failure.getState().status === "error" && failure.getState().error, "backend failed");
}

async function testLatestRequestAndEchoFences(): Promise<void> {
  const first = deferred<DistributionReportResponse>();
  const second = deferred<DistributionReportResponse>();
  let computeCalls = 0;
  const controller = createAnalysisExecutionController({
    getDatasetGeneration: async () => 5,
    compute: async () => (++computeCalls === 1 ? first.promise : second.promise),
  });
  const firstLoad = controller.load(analysis(), dataset({ generation: 5 }));
  await flush();
  const secondLoad = controller.load(
    analysis({ id: "analysis-2", configRevision: 2 }),
    dataset({ generation: 5 }),
  );
  await flush();
  second.resolve(response("dataset-1", 5));
  await secondLoad;
  assert.equal(controller.getState().status === "success" && controller.getState().analysisId, "analysis-2");
  first.resolve(response("dataset-1", 5));
  await firstLoad;
  assert.equal(controller.getState().status === "success" && controller.getState().analysisId, "analysis-2");

  const echoMismatch = createAnalysisExecutionController({
    getDatasetGeneration: async () => 6,
    compute: async () => response("other-dataset", 99),
  });
  await echoMismatch.load(analysis(), dataset({ generation: 6 }));
  assert.equal(echoMismatch.getState().status, "error");
}

async function testAnalysisAndDatasetFenceChecks(): Promise<void> {
  let currentAnalysis = analysis();
  let currentDataset = dataset({ generation: 8, updatedAt: "2026-09-03T10:00:00.000Z" });
  let generation = 8;

  const pending = deferred<DistributionReportResponse>();
  const controller = createAnalysisExecutionController({
    getDatasetGeneration: async () => generation,
    compute: async () => pending.promise,
    getCurrentAnalysis: () => currentAnalysis,
    getCurrentDataset: () => currentDataset,
  });
  const loading = controller.load(currentAnalysis, currentDataset);
  await flush();
  currentAnalysis = { ...currentAnalysis, configRevision: currentAnalysis.configRevision + 1 };
  pending.resolve(response("dataset-1", 8));
  await loading;
  assert.notEqual(controller.getState().status, "success");

  const sourceShift = deferred<DistributionReportResponse>();
  currentAnalysis = analysis();
  currentDataset = dataset({ generation: 8, updatedAt: "2026-09-03T10:00:00.000Z" });
  const sourceController = createAnalysisExecutionController({
    getDatasetGeneration: async () => generation,
    compute: async () => sourceShift.promise,
    getCurrentAnalysis: () => currentAnalysis,
    getCurrentDataset: () => currentDataset,
  });
  const sourceLoad = sourceController.load(currentAnalysis, currentDataset);
  await flush();
  currentDataset = { ...currentDataset, id: "dataset-2", updatedAt: "2026-09-03T10:05:00.000Z" };
  sourceShift.resolve(response("dataset-1", 8));
  await sourceLoad;
  assert.notEqual(sourceController.getState().status, "success");

  const fingerprintShift = deferred<DistributionReportResponse>();
  currentAnalysis = analysis();
  currentDataset = dataset({ generation: 8, updatedAt: "2026-09-03T10:00:00.000Z" });
  const fingerprintController = createAnalysisExecutionController({
    getDatasetGeneration: async () => generation,
    compute: async () => fingerprintShift.promise,
    getCurrentAnalysis: () => currentAnalysis,
    getCurrentDataset: () => currentDataset,
  });
  const fingerprintLoad = fingerprintController.load(currentAnalysis, currentDataset);
  await flush();
  currentAnalysis = {
    ...currentAnalysis,
    definition: {
      ...currentAnalysis.definition,
      analysis: {
        ...currentAnalysis.definition.analysis,
        confidenceLevel: 0.9,
      },
    },
  };
  fingerprintShift.resolve(response("dataset-1", 8));
  await fingerprintLoad;
  assert.notEqual(fingerprintController.getState().status, "success");

  const generationShift = deferred<DistributionReportResponse>();
  currentAnalysis = analysis();
  currentDataset = dataset({ generation: 8, updatedAt: "2026-09-03T10:00:00.000Z" });
  const generationController = createAnalysisExecutionController({
    getDatasetGeneration: async () => generation,
    compute: async () => generationShift.promise,
    getCurrentAnalysis: () => currentAnalysis,
    getCurrentDataset: () => currentDataset,
  });
  const generationLoad = generationController.load(currentAnalysis, currentDataset);
  await flush();
  generation = 9;
  generationShift.resolve(response("dataset-1", 8));
  await generationLoad;
  assert.notEqual(generationController.getState().status, "success");
}

await testLoadingSuccessAndError();
await testLatestRequestAndEchoFences();
await testAnalysisAndDatasetFenceChecks();

console.log("analysis execution contract passed");