import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  analysisCommandFixtures,
  createAnalysisCommandHandlers,
} from "@/applicationCommands/analysisCommands";
import type { AnalysisCommandDependencies } from "@/applicationCommands/analysisCommands";
import { createApplicationRuntime } from "@/applicationCommands/applicationRuntime";
import type { AnalysisDocument, AnalysisKind } from "@/types/analysis";
import type { DatasetMeta } from "@/types/data";
import type { DistributionReportResponse } from "@/types/distribution";
import type { FitModelResult } from "@/types/fitModel";
import type { FitYByXResponse } from "@/types/fitYByX";
import type { HypothesisTestRequest, HypothesisTestResponse } from "@/types/hypothesisTest";

const runtimeSource = readFileSync(
  new URL("../src/applicationCommands/applicationRuntime.ts", import.meta.url),
  "utf8",
);
const workspaceSource = readFileSync(
  new URL("../src/components/Workspace.tsx", import.meta.url),
  "utf8",
);

for (const command of ["analysis.create", "analysis.update", "analysis.run"] as const) {
  assert.equal(
    (runtimeSource.match(new RegExp(`\\"${command}\\"`, "g")) ?? []).length,
    1,
    `${command} must be registered exactly once in applicationRuntime.ts`,
  );
}

assert.match(workspaceSource, /type:\s*"analysis\.create"/, "Workspace must create analyses through applicationRuntime");
assert.match(workspaceSource, /type:\s*"analysis\.update"/, "Workspace must update analyses through applicationRuntime");

const NOW = "2026-09-15T12:00:00.000Z";

function dataset(overrides: Partial<DatasetMeta> = {}): DatasetMeta {
  return {
    id: "dataset-1",
    name: "Incoming Data",
    sourcePath: null,
    sourceType: "manual",
    rowCount: 16,
    colCount: 5,
    generation: 7,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function distributionResponse(datasetId: string, generation: number): DistributionReportResponse {
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

function fitYByXResponse(request: {
  datasetId: string;
  generation: number;
  personality: "oneway" | "bivariate";
  confidenceLevel: number;
}): FitYByXResponse {
  return {
    datasetId: request.datasetId,
    generation: request.generation,
    result: {
      kind: "notComputable",
      personality: request.personality,
      reason: "insufficientGroups",
      usedRows: 1,
      excludedRows: 0,
      confidenceLevel: request.confidenceLevel,
    },
  };
}

function fitModelResult(): FitModelResult {
  return {
    kind: "notComputable",
    reason: "insufficientRows",
    usedRows: 0,
    excludedRows: 0,
  };
}

function updateDistributionOverviewGraph(document: Extract<AnalysisDocument, { analysisKind: "distribution" }>) {
  return {
    ...document.definition.graphs.overview,
    modeStates: {
      ...document.definition.graphs.overview.modeStates,
      twoD: {
        ...document.definition.graphs.overview.modeStates.twoD,
        xAxis: { min: 1, max: 4 },
      },
    },
  };
}

function hypothesisResponse(request: HypothesisTestRequest): HypothesisTestResponse {
  return {
    analysisKind: request.analysisKind,
    analysisId: request.analysisId,
    datasetId: request.datasetId,
    generation: request.generation,
    configRevision: request.configRevision,
    selectorVersion: request.definition.selectorVersion,
    requestFingerprint: request.requestFingerprint,
    retainedObservations: 8,
    plotData: {
      studyStructure: "independent",
      conditions: [],
      observations: [],
      summaries: [],
      diagnosticKind: "groupResiduals",
      diagnosticValues: [],
      qqPoints: [],
    },
    exclusions: [],
    compatibility: [],
    diagnostics: [],
    selectionDecision: {
      selectorVersion: request.definition.selectorVersion,
      recommendedMethod: "studentTwoSampleT",
      executedMethod: "studentTwoSampleT",
      certainty: "high",
      reasonCodes: [],
      overridden: false,
    },
    primaryResult: {
      state: "computed",
      methodId: "studentTwoSampleT",
      statisticName: "t",
      statistic: 0,
      degreesOfFreedom: [1],
      pValue: 1,
      direction: "none",
      conclusion: "insufficientEvidence",
      estimate: {
        estimand: "meanDifference",
        estimate: { state: "available", value: 0 },
        lower: { state: "available", value: 0 },
        upper: { state: "available", value: 0 },
        confidenceLevel: request.definition.confidenceLevel,
        simultaneous: false,
      },
      effectSize: {
        kind: "cohensD",
        estimate: { state: "available", value: 0 },
        formulaVersion: "1",
      },
      formulaVersion: "1",
    },
    sensitivityResults: [],
    postHocResult: null,
    warnings: [],
    methodAudit: {
      selectorVersion: request.definition.selectorVersion,
      methodVersion: "1",
      formulaVersion: "1",
      inferencePath: "parametric",
      correctionCodes: [],
      executedAt: NOW,
    },
  };
}

function normalizeDocument(document: AnalysisDocument): unknown {
  return JSON.parse(JSON.stringify(document, (key, value) => {
    if (key === "id" || key === "createdAt" || key === "updatedAt") {
      return undefined;
    }
    return value;
  }));
}

function createHarness(): {
  datasets: DatasetMeta[];
  analyses: AnalysisDocument[];
  historyEntries: string[];
  activated: string[];
  dirtyTransitions: number;
  dependencies: AnalysisCommandDependencies;
} {
  const datasets = [dataset()];
  const analyses: AnalysisDocument[] = [];
  const historyEntries: string[] = [];
  const activated: string[] = [];
  let dirty = false;
  let dirtyTransitions = 0;

  const dependencies = {
    listDatasets: () => datasets,
    listAnalyses: () => analyses,
    createAnalysisId: () => `analysis-${analyses.length + 1}`,
    createNowIso: () => NOW,
    getColumns: async () => [
      ["DIM1", "DOUBLE"],
      ["DIM2", "DOUBLE"],
      ["Strength", "DOUBLE"],
      ["Site", "VARCHAR"],
      ["Temperature", "DOUBLE"],
      ["Pressure", "DOUBLE"],
    ],
    getColumnDisplayProps: async () => [],
    addAnalysis: (analysis: AnalysisDocument) => {
      analyses.push(analysis);
    },
    updateAnalysis: (id: string, patch) => {
      const index = analyses.findIndex((analysis) => analysis.id === id);
      const current = analyses[index];
      analyses[index] = {
        ...current,
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.source !== undefined ? { source: patch.source } : {}),
        ...(patch.definition !== undefined ? { definition: patch.definition } : {}),
        ...(patch.presentation !== undefined ? { presentation: patch.presentation } : {}),
        ...(patch.configRevision !== undefined ? { configRevision: patch.configRevision } : {}),
        ...(patch.updatedAt !== undefined ? { updatedAt: patch.updatedAt } : {}),
      } as AnalysisDocument;
    },
    activateAnalysis: (analysisId: string) => {
      activated.push(analysisId);
    },
    markDirty: () => {
      if (!dirty) {
        dirtyTransitions += 1;
      }
      dirty = true;
    },
    recordAction: (description: string) => {
      historyEntries.push(description);
    },
    getCurrentAnalysis: (analysisId: string) => analyses.find((analysis) => analysis.id === analysisId) ?? null,
    getCurrentDataset: (datasetId: string) => datasets.find((entry) => entry.id === datasetId) ?? null,
    executionRuntime: {
      getDatasetGeneration: async (datasetId: string) => datasets.find((entry) => entry.id === datasetId)?.generation ?? 0,
      compute: async (request) => distributionResponse(request.datasetId, request.generation),
      computeFitYByX: async (request) => fitYByXResponse(request),
      runFitModel: async () => fitModelResult(),
      runHypothesisTest: async (request) => hypothesisResponse(request),
    },
  } satisfies AnalysisCommandDependencies;

  return {
    datasets,
    analyses,
    historyEntries,
    activated,
    get dirtyTransitions() {
      return dirtyTransitions;
    },
    dependencies,
  };
}

async function verifyKindLifecycle(kind: AnalysisKind): Promise<void> {
  const first = createHarness();
  const second = createHarness();
  const firstHandlers = createAnalysisCommandHandlers(first.dependencies);
  const secondHandlers = createAnalysisCommandHandlers(second.dependencies);
  const fixture = analysisCommandFixtures[kind];
  let beginCommitCount = 0;

  const createdFirst = await firstHandlers.create(fixture.create, {
    beginCommit: () => {
      beginCommitCount += 1;
    },
  });
  const createdSecond = await secondHandlers.create(fixture.create);

  assert.equal(beginCommitCount, 1, `${kind} create must enter commit exactly once`);
  assert.deepEqual(normalizeDocument(createdFirst.item), normalizeDocument(createdSecond.item));
  assert.equal(createdFirst.item.analysisKind, kind);
  assert.equal(createdFirst.item.configRevision, 1);
  assert.equal(createdFirst.item.source.datasetId, fixture.create.sourceDatasetId);
  assert.equal(first.analyses.length, 1);
  assert.equal(first.activated[0], createdFirst.item.id);
  assert.equal(first.historyEntries.length, 1);
  assert.equal(first.dirtyTransitions, 1);

  const updated = firstHandlers.update(fixture.update(createdFirst.item.id, 1), {
    beginCommit: () => {
      beginCommitCount += 1;
    },
  });
  assert.equal(updated.changed, true, `${kind} update must report real definition changes`);
  assert.equal(updated.data.item.configRevision, 2, `${kind} update must increment configRevision`);
  assert.equal(first.analyses[0]?.configRevision, 2);
  assert.equal(beginCommitCount, 2, `${kind} update must enter commit exactly once`);
  assert.equal(first.historyEntries.length, 2);

  const runResult = await firstHandlers.run(fixture.run(createdFirst.item.id));
  assert.equal(runResult.item.id, createdFirst.item.id);
  assert.equal(runResult.dataset.id, fixture.create.sourceDatasetId);
  assert.equal(runResult.state.status, "success", `${kind} run must resolve through the shared execution controller`);
  assert.deepEqual(runResult.definition, runResult.item.definition);
}

for (const kind of Object.keys(analysisCommandFixtures) as AnalysisKind[]) {
  await verifyKindLifecycle(kind);
}

{
  const harness = createHarness();
  const handlers = createAnalysisCommandHandlers({
    ...harness.dependencies,
    executionRuntime: {
      ...harness.dependencies.executionRuntime,
      compute: async (request) => {
        const active = harness.analyses[0];
        if (active?.analysisKind === "distribution") {
          harness.analyses[0] = { ...active, configRevision: active.configRevision + 1 };
        }
        return distributionResponse(request.datasetId, request.generation);
      },
    },
  });
  const created = await handlers.create(analysisCommandFixtures.distribution.create);
  const runResult = await handlers.run({ analysisId: created.item.id });
  assert.equal(runResult.state.status, "loading", "stale analysis results must be synchronously masked before paint");
}

function createRuntimeHarness() {
  const harness = createHarness();
  let projectRevision = 0;
  let clockTick = 0;
  const runtime = createApplicationRuntime({
    revision: {
      get: () => projectRevision,
      set: (nextRevision) => {
        projectRevision = nextRevision;
      },
    },
    analysis: {
      ...harness.dependencies,
      createNowIso: () => `2026-09-15T12:00:00.${String(clockTick++).padStart(3, "0")}Z`,
    },
  });
  return {
    harness,
    runtime,
    get projectRevision() {
      return projectRevision;
    },
  };
}

async function testAnalysisRuntimeNoOpAndGraphOnlyRevisionBehavior(): Promise<void> {
  const runtimeHarness = createRuntimeHarness();
  const created = await runtimeHarness.runtime.execute(
    {
      type: "analysis.create",
      input: analysisCommandFixtures.distribution.create,
    },
    { kind: "ui" },
  );
  assert.equal(created.projectRevision, 1);
  const createdItem = created.data.item as Extract<AnalysisDocument, { analysisKind: "distribution" }>;

  const graphOnly = await runtimeHarness.runtime.execute(
    {
      type: "analysis.update",
      input: {
        analysisId: createdItem.id,
        analysisKind: "distribution",
        expectedConfigRevision: createdItem.configRevision,
        draft: {
          responses: createdItem.definition.responses,
          weight: createdItem.definition.weight,
          frequency: createdItem.definition.frequency,
          by: createdItem.definition.by,
          nestedSubgroup: createdItem.definition.nestedSubgroup,
          analysis: createdItem.definition.analysis,
          graphs: {
            ...createdItem.definition.graphs,
            overview: updateDistributionOverviewGraph(createdItem),
          },
        },
      },
      control: { expectedProjectRevision: 1 },
    },
    { kind: "ui" },
  );
  assert.equal(graphOnly.changed, true);
  assert.equal(graphOnly.projectRevision, 2);
  assert.equal(graphOnly.data.item.configRevision, createdItem.configRevision);
  assert.equal(runtimeHarness.harness.analyses[0]?.configRevision, createdItem.configRevision);
  assert.notEqual(graphOnly.data.item.updatedAt, createdItem.updatedAt);

  const noOp = await runtimeHarness.runtime.execute(
    {
      type: "analysis.update",
      input: {
        analysisId: createdItem.id,
        analysisKind: "distribution",
        expectedConfigRevision: graphOnly.data.item.configRevision,
        draft: {
          responses: graphOnly.data.item.definition.responses,
          weight: graphOnly.data.item.definition.weight,
          frequency: graphOnly.data.item.definition.frequency,
          by: graphOnly.data.item.definition.by,
          nestedSubgroup: graphOnly.data.item.definition.nestedSubgroup,
          analysis: graphOnly.data.item.definition.analysis,
          graphs: graphOnly.data.item.definition.graphs,
        },
      },
      control: { expectedProjectRevision: 2 },
    },
    { kind: "ui" },
  );
  assert.equal(noOp.changed, false);
  assert.equal(noOp.projectRevision, 2);
  assert.equal(noOp.data.item.updatedAt, graphOnly.data.item.updatedAt);
  assert.equal(runtimeHarness.harness.historyEntries.length, 2);
}

async function testAnalysisRuntimeRunPreservesFitModelSettingsAndCancellation(): Promise<void> {
  const runtimeHarness = createRuntimeHarness();
  let lastRequest: import("@/types/fitModel").FitModelRequest | null = null;

  const created = await runtimeHarness.runtime.execute(
    {
      type: "analysis.create",
      input: analysisCommandFixtures.fitModel.create,
    },
    { kind: "ui" },
  );
  const updated = await runtimeHarness.runtime.execute(
    {
      type: "analysis.update",
      input: analysisCommandFixtures.fitModel.update(created.data.item.id, created.data.item.configRevision),
      control: { expectedProjectRevision: created.projectRevision },
    },
    { kind: "ui" },
  );

  runtimeHarness.harness.dependencies.executionRuntime.runFitModel = async (request) => {
    lastRequest = request;
    return fitModelResult();
  };
  const runResult = await runtimeHarness.runtime.execute(
    {
      type: "analysis.run",
      input: { analysisId: updated.data.item.id },
    },
    { kind: "ui" },
  );
  assert.equal(runResult.data.item.analysisKind, "fitModel");
  assert.equal(runResult.data.definition.kind, "fitModel");
  assert.equal(runResult.data.definition.confidenceLevel, 0.9);
  assert.equal(runResult.data.state.status, "success");
  assert.equal(runResult.data.state.status === "success" && runResult.data.state.request.confidenceLevel, 0.9);
  assert.equal(lastRequest?.confidenceLevel, 0.9);

  let resolvePending: ((result: FitModelResult) => void) | null = null;
  runtimeHarness.harness.dependencies.executionRuntime.runFitModel = async (request) => {
    lastRequest = request;
    return new Promise<FitModelResult>((resolve) => {
      resolvePending = resolve;
    });
  };
  const abortController = new AbortController();
  const cancelledRun = runtimeHarness.runtime.execute(
    {
      type: "analysis.run",
      input: { analysisId: updated.data.item.id },
    },
    { kind: "ui" },
    { signal: abortController.signal },
  );
  await Promise.resolve();
  await Promise.resolve();
  abortController.abort();
  resolvePending?.(fitModelResult());
  await assert.rejects(cancelledRun, /cancelled/i);
}

await testAnalysisRuntimeNoOpAndGraphOnlyRevisionBehavior();
await testAnalysisRuntimeRunPreservesFitModelSettingsAndCancellation();

console.log("application command analysis lifecycle OK");