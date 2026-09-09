import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createAnalysisSampleDocument } from "../src/components/analysis/analysisSample.ts";
import { createFitYByXAnalysisDocument } from "../src/components/analysis/adapters/fitYByXAnalysisAdapter.ts";
import { createFitModelAnalysisDocument } from "../src/components/analysis/adapters/fitModelAnalysisAdapter.ts";
import { createFitYByXItem } from "../src/components/fitYByX/fitYByXConfig.ts";
import type { DatasetMeta } from "../src/types/data.ts";
import type { DistributionReportResponse } from "../src/types/distribution.ts";
import type { FitYByXResponse } from "../src/types/fitYByX.ts";
import type { HypothesisTestAnalysisDocument } from "../src/types/analysis.ts";
import type { HypothesisTestResponse } from "../src/types/hypothesisTest.ts";
import {
  createAnalysisExecutionController,
  createAnalysisExecutionRequest,
  distributionAnalysisDefinitionFingerprint,
  fitModelAnalysisDefinitionFingerprint,
  fitYByXAnalysisDefinitionFingerprint,
  hypothesisTestAnalysisDefinitionFingerprint,
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

function fitAnalysis() {
  return createFitYByXAnalysisDocument({
    item: createFitYByXItem({
      id: "fit-1",
      name: "Strength by Site",
      sourceDatasetId: "dataset-1",
      response: { name: "Strength", type: "continuous" },
      factor: { name: "Site", type: "nominal" },
      createdAt: "2026-09-03T00:00:00.000Z",
    }),
    confidenceLevel: 0.95,
    updatedAt: "2026-09-03T00:00:00.000Z",
  });
}

function fitModelAnalysis() {
  return createFitModelAnalysisDocument({
    item: {
      id: "fit-model-1",
      name: "Strength Model",
      sourceDatasetId: "dataset-1",
      response: { name: "Strength", type: "continuous" },
      construct: { kind: "responseSurface" },
      terms: [
        { kind: "main", columnNames: ["Temperature"] },
        { kind: "power", columnNames: ["Temperature"], exponent: 2 },
      ],
      centeringMethod: "mean",
      createdAt: "2026-09-03T00:00:00.000Z",
    },
    confidenceLevel: 0.95,
    updatedAt: "2026-09-03T00:00:00.000Z",
  });
}

function hypothesisAnalysis(): HypothesisTestAnalysisDocument {
  return {
    schemaVersion: 1,
    documentType: "analysis",
    id: "hypothesis-1",
    name: "Strength by Site",
    analysisKind: "hypothesisTest",
    configRevision: 1,
    source: { datasetId: "dataset-1" },
    definition: {
      kind: "hypothesisTest",
      roles: {
        layout: "long",
        response: { name: "Strength", type: "continuous" },
        condition: { name: "Site", type: "nominal" },
        subject: null,
      },
      studyDesign: "independent",
      selectionMode: "automatic",
      manualSelection: null,
      alternative: "twoSided",
      alpha: 0.05,
      confidenceLevel: 0.95,
      levelOrder: [],
      referenceLevel: null,
      postHoc: "automatic",
      selectorVersion: "1",
    },
    presentation: {
      schemaVersion: 1,
      layout: "hypothesis-test-v1",
      activeResultTab: "results",
      collapsedSections: [],
      graphs: { showRawData: true, showIntervals: true, showDiagnostics: true },
      tableSort: null,
    },
    createdAt: "2026-09-03T00:00:00.000Z",
    updatedAt: "2026-09-03T00:00:00.000Z",
  };
}

function hypothesisResponse(
  request: ReturnType<typeof createAnalysisExecutionRequest>,
  overrides: Partial<HypothesisTestResponse> = {},
): HypothesisTestResponse {
  return {
    analysisKind: "hypothesisTest",
    analysisId: "hypothesis-1",
    datasetId: "dataset-1",
    generation: 7,
    configRevision: 1,
    selectorVersion: "1",
    requestFingerprint: "",
    ...request,
    ...overrides,
  } as HypothesisTestResponse;
}

function fitResponse(datasetId = "dataset-1", generation = 7): FitYByXResponse {
  return {
    datasetId,
    generation,
    result: {
      kind: "notComputable",
      personality: "oneway",
      reason: "insufficientGroups",
      usedRows: 1,
      excludedRows: 0,
      confidenceLevel: 0.95,
    },
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
  specLimits: {
    DIM1: {
      lsl: 55,
      target: 100,
      usl: 145,
    },
  },
  fitDistributions: ["normal"],
});

const fitRequest = createAnalysisExecutionRequest(fitAnalysis(), 7);
assert.deepEqual(fitRequest, {
  datasetId: "dataset-1",
  generation: 7,
  responseColumn: "Strength",
  factorColumn: "Site",
  personality: "oneway",
  confidenceLevel: 0.95,
});

const fitModelRequest = createAnalysisExecutionRequest(fitModelAnalysis(), 7);
assert.deepEqual(fitModelRequest, {
  datasetId: "dataset-1",
  generation: 7,
  responseColumn: "Strength",
  terms: [
    { kind: "main", columnNames: ["Temperature"] },
    { kind: "power", columnNames: ["Temperature"], exponent: 2 },
  ],
  centeringMethod: "mean",
  confidenceLevel: 0.95,
});

const hypothesisRequest = createAnalysisExecutionRequest(hypothesisAnalysis(), 7);
assert.equal(hypothesisRequest.analysisKind, "hypothesisTest");
assert.equal(hypothesisRequest.analysisId, "hypothesis-1");
assert.equal(hypothesisRequest.datasetId, "dataset-1");
assert.equal(hypothesisRequest.generation, 7);
assert.equal(hypothesisRequest.configRevision, 1);
assert.equal(hypothesisRequest.requestFingerprint, hypothesisTestAnalysisDefinitionFingerprint(hypothesisAnalysis()));

const hypothesisFingerprint = hypothesisTestAnalysisDefinitionFingerprint(hypothesisAnalysis());
assert.notEqual(
  hypothesisTestAnalysisDefinitionFingerprint({
    ...hypothesisAnalysis(),
    definition: { ...hypothesisAnalysis().definition, alpha: 0.01 },
  }),
  hypothesisFingerprint,
);

const fitModelFingerprint = fitModelAnalysisDefinitionFingerprint(fitModelAnalysis());
for (const changed of [
  { ...fitModelAnalysis(), configRevision: 2 },
  { ...fitModelAnalysis(), definition: { ...fitModelAnalysis().definition, response: { name: "Yield", type: "continuous" as const } } },
  { ...fitModelAnalysis(), definition: { ...fitModelAnalysis().definition, construct: { kind: "manual" as const } } },
  { ...fitModelAnalysis(), definition: { ...fitModelAnalysis().definition, terms: [{ kind: "main" as const, columnNames: ["Pressure"] as [string] }] } },
  { ...fitModelAnalysis(), definition: { ...fitModelAnalysis().definition, centeringMethod: "none" as const } },
  { ...fitModelAnalysis(), definition: { ...fitModelAnalysis().definition, confidenceLevel: 0.9 } },
]) {
  assert.notEqual(fitModelAnalysisDefinitionFingerprint(changed), fitModelFingerprint);
}

const fitFingerprint = fitYByXAnalysisDefinitionFingerprint(fitAnalysis());
assert.equal(
  fitYByXAnalysisDefinitionFingerprint({
    ...fitAnalysis(),
    presentation: {
      ...fitAnalysis().presentation,
      graph: {
        ...fitAnalysis().presentation.graph,
        modeStates: {
          ...fitAnalysis().presentation.graph.modeStates,
          twoD: {
            ...fitAnalysis().presentation.graph.modeStates.twoD,
            xAxis: { min: 1, max: 4 },
          },
        },
      },
    },
  }),
  fitFingerprint,
);
assert.notEqual(
  fitYByXAnalysisDefinitionFingerprint({
    ...fitAnalysis(),
    definition: { ...fitAnalysis().definition, confidenceLevel: 0.9 },
  }),
  fitFingerprint,
);

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

async function testFitYByXEchoFence(): Promise<void> {
  const mismatch = createAnalysisExecutionController({
    getDatasetGeneration: async () => 7,
    computeFitYByX: async () => fitResponse("other-dataset", 7),
  });
  await mismatch.load(fitAnalysis(), dataset());
  assert.equal(mismatch.getState().status, "error");
}

async function testFitModelMigrationIssueDoesNotExecute(): Promise<void> {
  let generationCalls = 0;
  let runCalls = 0;
  const item = fitModelAnalysis();
  item.definition.migrationIssue = {
    code: "invalidPersistedDefinition",
    detail: "missingMainEffect",
  };
  const controller = createAnalysisExecutionController({
    getDatasetGeneration: async () => {
      generationCalls += 1;
      return 7;
    },
    runFitModel: async () => {
      runCalls += 1;
      return { kind: "notComputable", reason: "insufficientRows", usedRows: 0, excludedRows: 0 };
    },
  });
  await controller.load(item, dataset());
  assert.equal(generationCalls, 0);
  assert.equal(runCalls, 0);
  assert.equal(controller.getState().status, "error");
}

async function testHypothesisTestIdentityAndStaleFences(): Promise<void> {
  const item = hypothesisAnalysis();
  const expectedRequest = createAnalysisExecutionRequest(item, 7);
  const success = createAnalysisExecutionController({
    getDatasetGeneration: async () => 7,
    runHypothesisTest: async (nextRequest) => hypothesisResponse(nextRequest),
  });
  await success.load(item, dataset());
  assert.equal(success.getState().status, "success");

  const mismatch = createAnalysisExecutionController({
    getDatasetGeneration: async () => 7,
    runHypothesisTest: async (nextRequest) => hypothesisResponse(nextRequest, {
      requestFingerprint: `${nextRequest.requestFingerprint}-stale`,
    }),
  });
  await mismatch.load(item, dataset());
  assert.equal(mismatch.getState().status, "error");

  let currentAnalysis = item;
  const pending = deferred<HypothesisTestResponse>();
  const stale = createAnalysisExecutionController({
    getDatasetGeneration: async () => 7,
    runHypothesisTest: async () => pending.promise,
    getCurrentAnalysis: () => currentAnalysis,
    getCurrentDataset: () => dataset(),
  });
  const loading = stale.load(item, dataset());
  await flush();
  currentAnalysis = { ...currentAnalysis, configRevision: 2 };
  pending.resolve(hypothesisResponse(expectedRequest));
  await loading;
  assert.notEqual(stale.getState().status, "success");
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
await testFitYByXEchoFence();
await testFitModelMigrationIssueDoesNotExecute();
await testHypothesisTestIdentityAndStaleFences();
await testAnalysisAndDatasetFenceChecks();

const hookSource = readFileSync(
  new URL("../src/components/analysis/useAnalysisExecution.ts", import.meta.url),
  "utf8",
);
assert.doesNotMatch(
  hookSource,
  /\buseDistributionReport\s*\(/,
  "mounted Analysis execution must use the analysis-scoped controller rather than delegating to the Distribution hook",
);

console.log("analysis execution contract passed");