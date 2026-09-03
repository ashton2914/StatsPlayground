import assert from "node:assert/strict";

import type {
  FitModelFittedResult,
  FitModelItem,
  FitModelRequest,
  FitModelResult,
  FitModelTerm,
} from "../src/types/fitModel.ts";
import {
  createFitModelReportController,
  fitModelConfigurationKey,
  resolveFitModelReportStateForSignal,
  type FitModelReportState,
} from "../src/components/fitModel/useFitModelReport.ts";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  return Promise.resolve();
}

function createItem(overrides: Partial<FitModelItem> = {}): FitModelItem {
  return {
    id: "fit-model-1",
    name: "Fit Model 1",
    sourceDatasetId: "dataset-1",
    response: { name: "Y", type: "continuous" },
    terms: [
      { kind: "main", columnNames: ["A"] },
      { kind: "main", columnNames: ["B"] },
      { kind: "interaction", columnNames: ["A", "B"] },
    ],
    centeringMethod: "mean",
    createdAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeFittedResult(overrides: Partial<FitModelFittedResult> = {}): FitModelFittedResult {
  return {
    kind: "fitted",
    usedRows: 12,
    excludedRows: 0,
    confidenceLevel: 0.95,
    responseColumn: "Y",
    predictorColumns: ["A", "B"],
    terms: [
      {
        termId: "term-1",
        kind: "main",
        columnNames: ["A"],
        label: "A",
      },
      {
        termId: "term-2",
        kind: "main",
        columnNames: ["B"],
        label: "B",
      },
      {
        termId: "term-3",
        kind: "interaction",
        columnNames: ["A", "B"],
        label: "A*B",
      },
    ],
    centering: {
      method: "mean",
      centers: [
        { columnName: "A", mean: 1 },
        { columnName: "B", mean: 2 },
      ],
    },
    summaryOfFit: {
      rSquared: 0.9,
      adjustedRSquared: 0.88,
      rootMeanSquareError: 0.4,
      meanOfResponse: 3,
      observationCount: 12,
      modelDegreesOfFreedom: 3,
      errorDegreesOfFreedom: 8,
    },
    anova: [],
    parameterEstimates: [],
    plotRows: [],
    plotRowsSampled: false,
    warnings: [],
    ...overrides,
  };
}

function expectSuccess(state: FitModelReportState, result: FitModelResult, configurationKey: string): void {
  assert.equal(state.status, "success");
  assert.deepEqual(state.result, result);
  assert.equal(state.error, null);
  assert.equal(state.configurationKey, configurationKey);
}

function expectStale(state: FitModelReportState, result: FitModelResult, configurationKey: string, error: string | null): void {
  assert.equal(state.status, "stale");
  assert.deepEqual(state.result, result);
  assert.equal(state.error, error);
  assert.equal(state.configurationKey, configurationKey);
}

function testConfigurationKeyCanonicalization(): void {
  const first = fitModelConfigurationKey({
    responseColumn: "Y",
    terms: [{ kind: "interaction", columnNames: ["B", "A"] }],
    centeringMethod: "mean",
    confidenceLevel: 0.95,
    generation: 4,
  });

  const second = fitModelConfigurationKey({
    responseColumn: "Y",
    terms: [{ kind: "interaction", columnNames: ["A", "B"] }],
    centeringMethod: "mean",
    confidenceLevel: 0.95,
    generation: 4,
  });

  assert.equal(first, second, "interaction column order should be canonicalized");

  assert.notEqual(
    first,
    fitModelConfigurationKey({
      responseColumn: "Y2",
      terms: [{ kind: "interaction", columnNames: ["A", "B"] }],
      centeringMethod: "mean",
      confidenceLevel: 0.95,
      generation: 4,
    }),
    "changing response should change key",
  );

  assert.notEqual(
    fitModelConfigurationKey({
      responseColumn: "Y",
      terms: [
        { kind: "main", columnNames: ["A"] },
        { kind: "main", columnNames: ["B"] },
      ],
      centeringMethod: "mean",
      confidenceLevel: 0.95,
      generation: 4,
    }),
    fitModelConfigurationKey({
      responseColumn: "Y",
      terms: [
        { kind: "main", columnNames: ["B"] },
        { kind: "main", columnNames: ["A"] },
      ],
      centeringMethod: "mean",
      confidenceLevel: 0.95,
      generation: 4,
    }),
    "changing overall term order should change key",
  );

  assert.notEqual(
    first,
    fitModelConfigurationKey({
      responseColumn: "Y",
      terms: [{ kind: "interaction", columnNames: ["A", "B"] }],
      centeringMethod: "none",
      confidenceLevel: 0.95,
      generation: 4,
    }),
    "changing centering should change key",
  );

  assert.notEqual(
    first,
    fitModelConfigurationKey({
      responseColumn: "Y",
      terms: [{ kind: "interaction", columnNames: ["A", "B"] }],
      centeringMethod: "mean",
      confidenceLevel: 0.9,
      generation: 4,
    }),
    "changing confidence should change key",
  );

  assert.notEqual(
    first,
    fitModelConfigurationKey({
      responseColumn: "Y",
      terms: [{ kind: "interaction", columnNames: ["A", "B"] }],
      centeringMethod: "mean",
      confidenceLevel: 0.95,
      generation: 5,
    }),
    "changing generation should change key",
  );
}

function testGenerationSignalChangeImmediatelyMarksSuccessStale(): void {
  const result = makeFittedResult();
  const success: FitModelReportState = {
    status: "success",
    result,
    error: null,
    configurationKey: "generation-1",
  };

  assert.equal(resolveFitModelReportStateForSignal(success, "updated-1", "updated-1").status, "success");
  expectStale(
    resolveFitModelReportStateForSignal(success, "updated-1", "updated-2"),
    result,
    "generation-1",
    null,
  );
}

async function testLatestTokenWinsEvenWhenConfigurationKeyMatches(): Promise<void> {
  const item = createItem();
  const generationA = createDeferred<number>();
  const generationB = createDeferred<number>();
  const runShared = createDeferred<FitModelResult>();
  const requests: FitModelRequest[] = [];
  const states: FitModelReportState[] = [];
  let generationCalls = 0;

  const controller = createFitModelReportController({
    onStateChange: (state) => {
      states.push(state);
    },
    getDatasetGeneration: async () => {
      generationCalls += 1;
      return generationCalls === 1 ? generationA.promise : generationB.promise;
    },
    run: async (request) => {
      requests.push(request);
      return runShared.promise;
    },
  });

  const firstLoad = controller.load(item);
  const secondLoad = controller.load(item);

  generationA.resolve(7);
  generationB.resolve(7);
  await flushMicrotasks();

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.confidenceLevel, 0.95);

  const secondResult = makeFittedResult({ usedRows: 22 });
  runShared.resolve(secondResult);
  await secondLoad;

  const key = fitModelConfigurationKey({
    responseColumn: item.response.name,
    terms: item.terms,
    centeringMethod: item.centeringMethod,
    confidenceLevel: 0.95,
    generation: 7,
  });
  expectSuccess(states.at(-1)!, secondResult, key);

  await firstLoad;

  expectSuccess(states.at(-1)!, secondResult, key);
}

async function testDatasetGenerationChangeInvalidatesOlderRequestBeforeRun(): Promise<void> {
  const item = createItem();
  const generationA = createDeferred<number>();
  const generationB = createDeferred<number>();
  const runB = createDeferred<FitModelResult>();
  const requests: FitModelRequest[] = [];
  const states: FitModelReportState[] = [];
  let generationCalls = 0;

  const controller = createFitModelReportController({
    onStateChange: (state) => {
      states.push(state);
    },
    getDatasetGeneration: async () => {
      generationCalls += 1;
      return generationCalls === 1 ? generationA.promise : generationB.promise;
    },
    run: async (request) => {
      requests.push(request);
      return runB.promise;
    },
  });

  const staleLoad = controller.load(item);
  const activeLoad = controller.load(item);

  generationB.resolve(12);
  await flushMicrotasks();

  generationA.resolve(11);
  await flushMicrotasks();

  assert.equal(requests.length, 1, "stale generation resolution should not dispatch run");
  assert.equal(requests[0]?.generation, 12);

  const result = makeFittedResult({ usedRows: 33 });
  runB.resolve(result);
  await activeLoad;
  await staleLoad;

  const key = fitModelConfigurationKey({
    responseColumn: item.response.name,
    terms: item.terms,
    centeringMethod: item.centeringMethod,
    confidenceLevel: 0.95,
    generation: 12,
  });
  expectSuccess(states.at(-1)!, result, key);
}

async function testConfigurationChangeShowsStaleUntilReplacementSucceeds(): Promise<void> {
  const itemA = createItem({
    terms: [
      { kind: "main", columnNames: ["A"] },
      { kind: "main", columnNames: ["B"] },
    ],
  });
  const itemB = createItem({
    terms: [
      { kind: "main", columnNames: ["A"] },
      { kind: "main", columnNames: ["B"] },
      { kind: "interaction", columnNames: ["B", "A"] },
    ],
  });

  const generation = createDeferred<number>();
  const runFirst = createDeferred<FitModelResult>();
  const runSecond = createDeferred<FitModelResult>();
  const requests: FitModelRequest[] = [];
  const states: FitModelReportState[] = [];

  const controller = createFitModelReportController({
    onStateChange: (state) => {
      states.push(state);
    },
    getDatasetGeneration: async () => {
      return generation.promise;
    },
    run: async (request) => {
      requests.push(request);
      return requests.length === 1 ? runFirst.promise : runSecond.promise;
    },
  });

  const firstLoad = controller.load(itemA);
  generation.resolve(20);
  await flushMicrotasks();

  const firstResult = makeFittedResult({ usedRows: 41 });
  runFirst.resolve(firstResult);
  await firstLoad;

  const firstKey = fitModelConfigurationKey({
    responseColumn: itemA.response.name,
    terms: itemA.terms,
    centeringMethod: itemA.centeringMethod,
    confidenceLevel: 0.95,
    generation: 20,
  });
  expectSuccess(states.at(-1)!, firstResult, firstKey);

  const secondLoad = controller.load(itemB);
  await flushMicrotasks();

  const secondKey = fitModelConfigurationKey({
    responseColumn: itemB.response.name,
    terms: itemB.terms,
    centeringMethod: itemB.centeringMethod,
    confidenceLevel: 0.95,
    generation: 20,
  });

  expectStale(states.at(-1)!, firstResult, secondKey, null);

  const secondResult = makeFittedResult({ usedRows: 42, predictorColumns: ["A", "B", "A*B"] });
  runSecond.resolve(secondResult);
  await secondLoad;

  expectSuccess(states.at(-1)!, secondResult, secondKey);
}

async function testFailedReplacementKeepsOldResultWithCurrentError(): Promise<void> {
  const itemA = createItem({ terms: [{ kind: "main", columnNames: ["A"] }] });
  const itemB = createItem({ terms: [{ kind: "main", columnNames: ["B"] }] });

  const generation = createDeferred<number>();
  const firstRun = createDeferred<FitModelResult>();
  const secondRun = createDeferred<FitModelResult>();
  const requests: FitModelRequest[] = [];
  const states: FitModelReportState[] = [];

  const controller = createFitModelReportController({
    onStateChange: (state) => {
      states.push(state);
    },
    getDatasetGeneration: () => generation.promise,
    run: async (request) => {
      requests.push(request);
      return requests.length === 1 ? firstRun.promise : secondRun.promise;
    },
  });

  const firstLoad = controller.load(itemA);
  generation.resolve(30);
  await flushMicrotasks();

  const originalResult = makeFittedResult({ usedRows: 55 });
  firstRun.resolve(originalResult);
  await firstLoad;

  const replacement = controller.load(itemB);
  await flushMicrotasks();

  secondRun.reject({ message: "replacement failed" });
  await replacement;

  const replacementKey = fitModelConfigurationKey({
    responseColumn: itemB.response.name,
    terms: itemB.terms,
    centeringMethod: itemB.centeringMethod,
    confidenceLevel: 0.95,
    generation: 30,
  });

  expectStale(states.at(-1)!, originalResult, replacementKey, "replacement failed");
}

async function testPriorSuccessThenGenerationLookupRejectsYieldsStaleWithError(): Promise<void> {
  const itemA = createItem({ terms: [{ kind: "main", columnNames: ["A"] }] });
  const itemB = createItem({ terms: [{ kind: "main", columnNames: ["B"] }] });

  const generation = createDeferred<number>();
  const firstRun = createDeferred<FitModelResult>();
  const states: FitModelReportState[] = [];
  let generationCalls = 0;

  const controller = createFitModelReportController({
    onStateChange: (state) => {
      states.push(state);
    },
    getDatasetGeneration: async () => {
      generationCalls += 1;
      if (generationCalls === 1) {
        return generation.promise;
      }
      throw new Error("generation lookup failed");
    },
    run: async () => firstRun.promise,
  });

  const firstLoad = controller.load(itemA);
  generation.resolve(31);
  await flushMicrotasks();

  const firstResult = makeFittedResult({ usedRows: 71 });
  firstRun.resolve(firstResult);
  await firstLoad;

  const replacement = controller.load(itemB);
  await replacement;

  const replacementKey = fitModelConfigurationKey({
    responseColumn: itemB.response.name,
    terms: itemB.terms,
    centeringMethod: itemB.centeringMethod,
    confidenceLevel: 0.95,
    generation: 31,
  });
  expectStale(states.at(-1)!, firstResult, replacementKey, "generation lookup failed");
}

async function testFirstLoadGenerationLookupRejectsYieldsErrorWithNullResult(): Promise<void> {
  const item = createItem();
  const states: FitModelReportState[] = [];

  const controller = createFitModelReportController({
    onStateChange: (state) => {
      states.push(state);
    },
    getDatasetGeneration: async () => {
      throw new Error("generation lookup failed");
    },
    run: async () => {
      throw new Error("run should not be called");
    },
  });

  await controller.load(item);

  const finalState = states.at(-1)!;
  assert.equal(finalState.status, "error");
  assert.equal(finalState.result, null);
  assert.equal(finalState.error, "generation lookup failed");
  assert.equal(finalState.configurationKey, null);
}

async function testLatestConfigurationRemainsCurrentWhenOlderResolvesLast(): Promise<void> {
  const generation = createDeferred<number>();
  const runA = createDeferred<FitModelResult>();
  const runB = createDeferred<FitModelResult>();
  const requests: FitModelRequest[] = [];
  const states: FitModelReportState[] = [];

  const itemA = createItem({ terms: [{ kind: "main", columnNames: ["A"] }] });
  const itemB = createItem({ terms: [{ kind: "main", columnNames: ["B"] }] });

  const controller = createFitModelReportController({
    onStateChange: (state) => {
      states.push(state);
    },
    getDatasetGeneration: async () => generation.promise,
    run: async (request) => {
      requests.push(request);
      return requests.length === 1 ? runA.promise : runB.promise;
    },
  });

  const loadA = controller.load(itemA);
  generation.resolve(44);
  await flushMicrotasks();
  assert.equal(requests.length, 1);

  const loadB = controller.load(itemB);
  await flushMicrotasks();
  assert.equal(requests.length, 2);

  const resultB = makeFittedResult({ usedRows: 82, predictorColumns: ["B"] });
  runB.resolve(resultB);
  await loadB;

  const keyB = fitModelConfigurationKey({
    responseColumn: itemB.response.name,
    terms: itemB.terms,
    centeringMethod: itemB.centeringMethod,
    confidenceLevel: 0.95,
    generation: 44,
  });
  expectSuccess(states.at(-1)!, resultB, keyB);

  runA.resolve(makeFittedResult({ usedRows: 999, predictorColumns: ["A"] }));
  await loadA;

  expectSuccess(states.at(-1)!, resultB, keyB);
}

async function testItemSwitchAndDisposeFenceOldResults(): Promise<void> {
  const itemA = createItem({ id: "fit-a" });
  const itemB = createItem({
    id: "fit-b",
    terms: [{ kind: "main", columnNames: ["B"] }],
  });

  const generationA = createDeferred<number>();
  const generationB = createDeferred<number>();
  const runA = createDeferred<FitModelResult>();
  const runB = createDeferred<FitModelResult>();
  const states: FitModelReportState[] = [];
  let generationCalls = 0;

  const controller = createFitModelReportController({
    onStateChange: (state) => {
      states.push(state);
    },
    getDatasetGeneration: async () => {
      generationCalls += 1;
      return generationCalls === 1 ? generationA.promise : generationB.promise;
    },
    run: async (request) => {
      return request.generation === 41 ? runB.promise : runA.promise;
    },
  });

  const first = controller.load(itemA);
  const second = controller.load(itemB);

  generationA.resolve(40);
  generationB.resolve(41);
  await flushMicrotasks();

  const secondResult = makeFittedResult({ responseColumn: "Y", usedRows: 66 });
  runB.resolve(secondResult);
  await second;

  const secondKey = fitModelConfigurationKey({
    responseColumn: itemB.response.name,
    terms: itemB.terms,
    centeringMethod: itemB.centeringMethod,
    confidenceLevel: 0.95,
    generation: 41,
  });
  expectSuccess(states.at(-1)!, secondResult, secondKey);

  runA.resolve(makeFittedResult({ usedRows: 999 }));
  await first;
  expectSuccess(states.at(-1)!, secondResult, secondKey);

  const disposeGeneration = createDeferred<number>();
  const disposeRun = createDeferred<FitModelResult>();
  const disposedStates: FitModelReportState[] = [];

  const disposedController = createFitModelReportController({
    onStateChange: (state) => {
      disposedStates.push(state);
    },
    getDatasetGeneration: () => disposeGeneration.promise,
    run: () => disposeRun.promise,
  });

  const pending = disposedController.load(itemA);
  disposedController.dispose();
  disposeGeneration.resolve(50);
  await flushMicrotasks();
  disposeRun.resolve(makeFittedResult({ usedRows: 88 }));
  await pending;

  assert.equal(
    disposedStates.some((state) => state.status === "success" || state.status === "stale" || state.status === "error"),
    false,
  );
}

testConfigurationKeyCanonicalization();
testGenerationSignalChangeImmediatelyMarksSuccessStale();
await testLatestTokenWinsEvenWhenConfigurationKeyMatches();
await testDatasetGenerationChangeInvalidatesOlderRequestBeforeRun();
await testConfigurationChangeShowsStaleUntilReplacementSucceeds();
await testFailedReplacementKeepsOldResultWithCurrentError();
await testPriorSuccessThenGenerationLookupRejectsYieldsStaleWithError();
await testFirstLoadGenerationLookupRejectsYieldsErrorWithNullResult();
await testLatestConfigurationRemainsCurrentWhenOlderResolvesLast();
await testItemSwitchAndDisposeFenceOldResults();

console.log("fitModel report state contract passed");
