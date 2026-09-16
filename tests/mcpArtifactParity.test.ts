import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { analysisCommandFixtures } from "@/applicationCommands/analysisCommands";
import { createApplicationRuntime } from "@/applicationCommands/applicationRuntime";
import { buildSaveProjectRequest as productionBuildSaveProjectRequest } from "@/applicationCommands/projectCommands";
import type {
  TableCreateResult,
  AnalysisCreateInput,
  AnalysisUpdateInput,
  ApplicationCommand,
  ApplicationCommandRegistry,
  CommandActor,
  MutationControl,
} from "@/applicationCommands/types";
import {
  createWorkspaceCommandHandlers,
} from "@/components/workspaceCommandHandlers";
import {
  hydrateAnalysisProjectPayload,
} from "@/components/analysis/analysisWorkspaceLifecycle";
import type { SaveProjectRequest } from "@/services/projectService";
import { useAnalysisStore } from "@/stores/useAnalysisStore";
import { useDataStore } from "@/stores/useDataStore";
import { useDatasetFilterStore } from "@/stores/useDatasetFilterStore";
import { useFolderStore } from "@/stores/useFolderStore";
import { useGraphBuilderStore } from "@/stores/useGraphBuilderStore";
import { useHistoryStore } from "@/stores/useHistoryStore";
import { useProjectStore } from "@/stores/useProjectStore";
import { useReportStore } from "@/stores/useReportStore";
import { useTabulateStore } from "@/stores/useTabulateStore";
import { useTableTransformStore } from "@/stores/useTableTransformStore";
import { useWorkflowStore } from "@/stores/useWorkflowStore";
import { useWorkspaceSelectionStore } from "@/stores/useWorkspaceSelectionStore";
import type { AnalysisKind } from "@/types/analysis";
import type {
  ColumnDisplayProps,
  CreateManagedTableRequest,
  DatasetMeta,
  ManagedTableCreateResult,
  TableWindowRequest,
} from "@/types/data";
import type { GraphBuilderItem } from "@/types/graphBuilder";
import type { NamedSnapshot } from "@/types/history";
import type { OpenProjectResult } from "@/types/project";
import type { TabulateItem } from "@/types/tabulate";
import type {
  TableTransformDefinition,
  TableTransformExecutionResult,
  TableTransformProjectBinding,
} from "@/types/tableTransform";

type CommandType = Extract<keyof ApplicationCommandRegistry, string>;
type Command<TType extends CommandType = CommandType> = ApplicationCommand<ApplicationCommandRegistry, TType>;

interface FixtureNondeterministicPolicy {
  stripPaths: string[];
  uuidLikePaths: string[];
  uuidLike: string;
}

interface FixtureProjectionCase {
  id: string;
  expectedEnvelope: {
    type: string;
    input: Record<string, unknown>;
    control?: Record<string, unknown>;
  };
}

interface ArtifactParityFixture {
  projectionCases: FixtureProjectionCase[];
  datasetIdToken: string;
  tableSeed: CreateManagedTableRequest;
  documents: {
    tableTransform: TableTransformDefinition;
    tabulate: {
      id: string;
      name: string;
      sourceDatasetId: string;
      rowFields: string[];
      columnFields: string[];
      statistics: Array<{ id: string; field: string; kind: string }>;
      includeRowTotals: boolean;
      includeColumnTotals: boolean;
      createdAt: string;
    };
  };
  nondeterministicPolicy: FixtureNondeterministicPolicy;
  canonicalSavePayload: Record<string, unknown>;
}

interface CanonicalOpenProjectResultFixture {
  canonicalOpenProjectResult: OpenProjectResult;
}

interface DatasetRecord {
  meta: DatasetMeta;
  columns: Array<[string, string]>;
  display: ColumnDisplayProps[];
  rows: unknown[][];
}

interface OperationCounters {
  tableTransformRun: number;
  tabulateRun: number;
  tabulateExport: number;
  graphUpdate: number;
  reportUpdate: number;
  sqlToTable: number;
  snapshotCreate: number;
  exportCsv: number;
  analysisUpdate: Record<AnalysisKind, number>;
  analysisRun: Record<AnalysisKind, number>;
}

interface SaveBuilderTableDependenciesCapture {
  getColumns: Array<{ datasetId: string; columns: Array<[string, string]> }>;
  getColumnDisplayProps: Array<{ datasetId: string; display: ColumnDisplayProps[] }>;
  queryTableWindow: Array<{
    request: TableWindowRequest;
    result: {
      columns: string[];
      columnTypes: string[];
      rows: unknown[][];
      totalRows: number;
      start: number;
      generation: number;
    };
  }>;
}

const TEST_FILE_DIR = dirname(fileURLToPath(import.meta.url));
const UUID_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NOW = "2026-09-16T00:00:00.000Z";

function loadFixture(): ArtifactParityFixture {
  const content = readFileSync(
    resolve(TEST_FILE_DIR, "../contracts/mcp/artifact-parity.v1.json"),
    "utf8",
  );
  const parsed: unknown = JSON.parse(content);
  assert.ok(parsed && typeof parsed === "object", "Artifact fixture must be an object");
  const fixture = parsed as ArtifactParityFixture;
  assert.ok(Array.isArray(fixture.projectionCases), "Fixture must include projectionCases");
  assert.ok(Array.isArray(fixture.tableSeed.columns), "Fixture must include tableSeed columns");
  return fixture;
}

function loadCanonicalOpenResultFixture(): OpenProjectResult {
  const content = readFileSync(
    resolve(TEST_FILE_DIR, "../contracts/mcp/artifact-parity-open-result.v1.json"),
    "utf8",
  );
  const parsed: unknown = JSON.parse(content);
  assert.ok(parsed && typeof parsed === "object", "Canonical open-result fixture must be an object");
  const fixture = parsed as CanonicalOpenProjectResultFixture;
  assert.ok(fixture.canonicalOpenProjectResult, "Canonical open-result fixture must include canonicalOpenProjectResult");
  return fixture.canonicalOpenProjectResult;
}

function jsonPath(path: Array<string | number>, wildcardArrayIndexes: boolean): string {
  let out = "$";
  for (const segment of path) {
    if (typeof segment === "number") {
      out += wildcardArrayIndexes ? "[*]" : `[${segment}]`;
      continue;
    }
    out += `.${segment}`;
  }
  return out;
}

function matchesPathRule(path: Array<string | number>, rules: readonly string[]): boolean {
  const exact = jsonPath(path, false);
  const wildcard = jsonPath(path, true);
  return rules.some((rule) => rule === exact || rule === wildcard);
}

function normalizeWithPolicy(
  value: unknown,
  policy: FixtureNondeterministicPolicy,
  path: Array<string | number> = [],
): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    if (UUID_LIKE.test(value) && matchesPathRule(path, policy.uuidLikePaths)) {
      return policy.uuidLike;
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => normalizeWithPolicy(entry, policy, [...path, index]));
  }
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const childPath = [...path, key];
      if (matchesPathRule(childPath, policy.stripPaths)) continue;
      output[key] = normalizeWithPolicy(child, policy, childPath);
    }
    return output;
  }
  return value;
}

function toJsonSafe<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function seedColumns(seed: CreateManagedTableRequest): Array<[string, string]> {
  return seed.columns.map((column) => [column.name, column.sqlType.toUpperCase()]);
}

function seedDisplay(seed: CreateManagedTableRequest): ColumnDisplayProps[] {
  return seed.columns.map((column, colIndex) => ({
    colIndex,
    width: column.display?.width,
    format: column.display?.format,
    extras: column.display?.extras,
  }));
}

function assertSaveBuilderPreservedTableSeed(
  capture: SaveBuilderTableDependenciesCapture,
  fixtureSeed: CreateManagedTableRequest,
  actorLabel: string,
): void {
  const expectedColumns = seedColumns(fixtureSeed);
  const expectedDisplay = seedDisplay(fixtureSeed);

  const columnsCall = capture.getColumns.find((entry) => entry.datasetId === "table-main");
  assert.ok(columnsCall, `${actorLabel} save builder must call getColumns for table-main`);
  assert.deepEqual(
    columnsCall.columns,
    expectedColumns,
    `${actorLabel} save builder must preserve seeded column order and sqlType`,
  );

  const displayCall = capture.getColumnDisplayProps.find((entry) => entry.datasetId === "table-main");
  assert.ok(displayCall, `${actorLabel} save builder must call getColumnDisplayProps for table-main`);
  assert.deepEqual(
    displayCall.display,
    expectedDisplay,
    `${actorLabel} save builder must preserve seeded display width/format/extras`,
  );

  const tableWindows = capture.queryTableWindow.filter((entry) => entry.request.datasetId === "table-main");
  for (const windowCall of tableWindows) {
    assert.deepEqual(
      windowCall.result.columns,
      fixtureSeed.columns.map((column) => column.name),
      `${actorLabel} table snapshot columns must preserve order`,
    );
    assert.deepEqual(
      windowCall.result.columnTypes,
      expectedColumns.map(([, type]) => type),
      `${actorLabel} table snapshot must preserve column sqlType`,
    );
    assert.deepEqual(
      windowCall.result.rows,
      fixtureSeed.rows.slice(windowCall.request.start, windowCall.request.start + windowCall.request.count),
      `${actorLabel} table snapshot rows must match the seeded table slice`,
    );
    assert.equal(
      windowCall.result.totalRows,
      fixtureSeed.rows.length,
      `${actorLabel} table snapshot totalRows must match seeded table`,
    );
  }
}

function findCase(fixture: ArtifactParityFixture, id: string): FixtureProjectionCase {
  const found = fixture.projectionCases.find((entry) => entry.id === id);
  assert.ok(found, `Missing projection case in fixture: ${id}`);
  return found;
}

function fixtureEnvelopeToCommand<TType extends CommandType>(
  fixture: ArtifactParityFixture,
  id: string,
  expectedType: TType,
): Command<TType> {
  const entry = findCase(fixture, id);
  assert.equal(entry.expectedEnvelope.type, expectedType, `Projection case ${id} type mismatch`);
  return {
    type: expectedType,
    input: entry.expectedEnvelope.input as ApplicationCommandRegistry[TType]["input"],
    control: entry.expectedEnvelope.control as MutationControl | undefined,
  };
}

function resetStores(): void {
  useAnalysisStore.getState().reset();
  useDatasetFilterStore.getState().reset();
  useFolderStore.getState().reset();
  useGraphBuilderStore.getState().reset();
  useHistoryStore.getState().reset();
  useReportStore.getState().reset();
  useTabulateStore.getState().reset();
  useTableTransformStore.getState().reset();
  useWorkflowStore.getState().reset();

  useWorkspaceSelectionStore.getState().clear();
  useDataStore.setState({ activeDatasetId: null, datasets: [], statusInfo: null });
  useProjectStore.setState({
    project: { name: "Task12", filePath: "/Users/ashton/private/task12.spprj", createdAt: NOW },
    loading: false,
    dirty: false,
    saving: false,
    readOnly: false,
    saveProgress: null,
    saveError: null,
    projectRevision: 21,
  });
}

function newCounters(): OperationCounters {
  return {
    tableTransformRun: 0,
    tabulateRun: 0,
    tabulateExport: 0,
    graphUpdate: 0,
    reportUpdate: 0,
    sqlToTable: 0,
    snapshotCreate: 0,
    exportCsv: 0,
    analysisUpdate: { distribution: 0, fitYByX: 0, fitModel: 0, hypothesisTest: 0 },
    analysisRun: { distribution: 0, fitYByX: 0, fitModel: 0, hypothesisTest: 0 },
  };
}

async function awaitWithTimeout<T>(
  promise: Promise<T>,
  label: string,
  runtime: ReturnType<typeof createApplicationRuntime>,
): Promise<T> {
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => {
      reject(new Error(`Timed out at ${label}. Runtime snapshot: ${JSON.stringify(runtime.snapshot())}`));
    }, 3000);
  });
  return Promise.race([promise, timeout]);
}

function createScenarioRuntime(actor: CommandActor, fixture: ArtifactParityFixture) {
  let projectRevision = 21;
  let buildSaveCalls = 0;
  let capturedSaveRequest: Record<string, unknown> | null = null;
  let analysisCounter = 0;
  const counters = newCounters();
  const datasets = new Map<string, DatasetRecord>();
  const saveBuilderCapture: SaveBuilderTableDependenciesCapture = {
    getColumns: [],
    getColumnDisplayProps: [],
    queryTableWindow: [],
  };

  const syncDatasets = () => {
    useDataStore.setState({
      datasets: Array.from(datasets.values()).map((entry) => entry.meta),
    });
  };

  const createManaged = (request: CreateManagedTableRequest): ManagedTableCreateResult => {
    const datasetId = "table-main";
    const meta: DatasetMeta = {
      id: datasetId,
      name: request.name,
      sourceType: "manual",
      sourcePath: null,
      rowCount: request.rows.length,
      colCount: request.columns.length,
      generation: (datasets.get(datasetId)?.meta.generation ?? 0) + 1,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const columns = request.columns.map((column, colIndex) => ({
      colIndex,
      colName: column.name,
      colType: column.sqlType.toUpperCase(),
      width: column.display?.width,
      format: column.display?.format,
      extras: column.display?.extras,
    }));
    datasets.set(datasetId, {
      meta,
      columns: request.columns.map((column) => [column.name, column.sqlType.toUpperCase()]),
      display: columns.map((column) => ({
        colIndex: column.colIndex,
        width: column.width,
        format: column.format,
        extras: column.extras,
      })),
      rows: request.rows,
    });
    syncDatasets();
    return {
      dataset: meta,
      generation: meta.generation,
      columns,
    };
  };

  let runtime!: ReturnType<typeof createApplicationRuntime>;
  runtime = createApplicationRuntime({
    initialRevision: projectRevision,
    revision: {
      get: () => projectRevision,
      set: (next) => {
        projectRevision = next;
        useProjectStore.getState().setRevision(next);
      },
    },
    project: {
      getProjectState: () => ({
        project: useProjectStore.getState().project,
        dirty: useProjectStore.getState().dirty,
        readOnly: useProjectStore.getState().readOnly,
        projectRevision,
      }),
      listDatasets: () => useDataStore.getState().datasets,
      listTableTransforms: () => useTableTransformStore.getState().definitions,
      listGraphs: () => useGraphBuilderStore.getState().items,
      listReports: () => useReportStore.getState().items,
      listAnalyses: () => useAnalysisStore.getState().items,
      listTabulates: () => useTabulateStore.getState().items,
      getColumns: async (datasetId: string) => {
        const columns = datasets.get(datasetId)?.columns ?? [];
        saveBuilderCapture.getColumns.push({ datasetId, columns: toJsonSafe(columns) });
        return columns;
      },
      getColumnDisplayProps: async (datasetId: string) => {
        const display = datasets.get(datasetId)?.display ?? [];
        saveBuilderCapture.getColumnDisplayProps.push({ datasetId, display: toJsonSafe(display) });
        return display;
      },
      getDatasetGeneration: async (datasetId: string) => datasets.get(datasetId)?.meta.generation ?? 0,
      queryTableWindow: async (request: TableWindowRequest) => {
        const record = datasets.get(request.datasetId);
        const rows = record ? record.rows.slice(request.start, request.start + request.count) : [];
        const result = {
          columns: record?.columns.map(([name]) => name) ?? [],
          columnTypes: record?.columns.map(([, type]) => type) ?? [],
          rows,
          totalRows: record?.rows.length ?? 0,
          start: request.start,
          generation: record?.meta.generation ?? 0,
        };
        saveBuilderCapture.queryTableWindow.push({
          request: toJsonSafe(request),
          result: toJsonSafe(result),
        });
        return result;
      },
      buildSaveProjectRequest: (filePath?: string) => {
        buildSaveCalls += 1;
        return productionBuildSaveProjectRequest(filePath);
      },
      saveProjectCommand: async (request) => {
        capturedSaveRequest = request as Record<string, unknown>;
        return {
          name: "Task12",
          createdAt: NOW,
          fileName: "task12.spprj",
          hasProjectPath: true,
        };
      },
      flushPendingHistory: async () => undefined,
    },
    table: {
      createManagedTable: async (request: CreateManagedTableRequest): Promise<ManagedTableCreateResult> => {
        return createManaged(request);
      },
      refreshDatasets: async () => syncDatasets(),
    },
    tableTransform: {
      preflightCreateAndRun: async () => undefined,
      preflightRun: async () => undefined,
      createAndRun: async () => {
        const definition = fixture.documents.tableTransform;
        const binding: TableTransformProjectBinding = {
          definitionId: definition.id,
          definitionRevision: definition.revision,
          inputs: [{ role: "source", tableDocumentId: "table-main" }],
          outputGeneration: datasets.get("table-main")?.meta.generation ?? 1,
        };
        useTableTransformStore.getState().loadFromProject([definition], [binding]);
        return {
          definitionId: definition.id,
          status: "succeeded",
          output: datasets.get("table-main")?.meta,
          schemaReports: [],
          binding,
          runState: {
            definitionRevision: definition.revision,
            status: "succeeded",
            outputGeneration: datasets.get("table-main")?.meta.generation ?? 1,
          },
        } satisfies TableTransformExecutionResult;
      },
      rerun: async (transformId: string) => {
        counters.tableTransformRun += 1;
        const definition = useTableTransformStore.getState().definitions.find((entry) => entry.id === transformId);
        const binding = useTableTransformStore.getState().bindings.find((entry) => entry.definitionId === transformId);
        assert.ok(definition, "Transform definition must exist");
        assert.ok(binding, "Transform binding must exist");
        return {
          definitionId: transformId,
          status: "succeeded",
          output: datasets.get("table-main")?.meta,
          schemaReports: [],
          binding,
          runState: {
            definitionRevision: definition.revision,
            status: "succeeded",
            outputGeneration: datasets.get("table-main")?.meta.generation ?? 1,
          },
        } satisfies TableTransformExecutionResult;
      },
      listDefinitions: () => useTableTransformStore.getState().definitions,
      listBindings: () => useTableTransformStore.getState().bindings,
      refreshDatasets: async () => syncDatasets(),
    },
    analysis: {
      createAnalysisId: () => {
        analysisCounter += 1;
        return `analysis-${analysisCounter}`;
      },
      createNowIso: () => NOW,
      getColumns: async () => [
        ["width", "DOUBLE"],
        ["build", "VARCHAR"],
        ["Strength", "DOUBLE"],
        ["Site", "VARCHAR"],
        ["Temperature", "DOUBLE"],
        ["Pressure", "DOUBLE"],
      ],
      getColumnDisplayProps: async () => [],
      executionRuntime: {
        getDatasetGeneration: async (datasetId: string) => datasets.get(datasetId)?.meta.generation ?? 1,
        compute: async (request) => ({
          datasetId: request.datasetId,
          generation: request.generation,
          groups: [],
          reportBlocks: [],
          graphFrames: {
            overview: { columns: [], rows: [], aggregatePackets: [], totalRows: 0 },
            boxPlot: { columns: [], rows: [], aggregatePackets: [], totalRows: 0 },
            ecdf: { columns: [], rows: [], aggregatePackets: [], totalRows: 0 },
            normalQuantile: { columns: [], rows: [], aggregatePackets: [], totalRows: 0 },
          },
        }),
        computeFitYByX: async (request) => ({
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
        }),
        runFitModel: async () => ({
          kind: "notComputable",
          reason: "insufficientRows",
          usedRows: 0,
          excludedRows: 0,
        }),
        runHypothesisTest: async (request) => ({
          analysisKind: request.analysisKind,
          analysisId: request.analysisId,
          datasetId: request.datasetId,
          generation: request.generation,
          configRevision: request.configRevision,
          selectorVersion: request.definition.selectorVersion,
          requestFingerprint: request.requestFingerprint,
          retainedObservations: 1,
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
        }),
      },
    },
    tabulate: {
      createTabulateId: () => fixture.documents.tabulate.id,
      createNowIso: () => fixture.documents.tabulate.createdAt,
      runTabulate: async () => {
        counters.tabulateRun += 1;
        return {
          rowMembers: [["EV"], ["DV"]],
          columnMembers: [[]],
          statistics: [{ id: "stat-mean", field: "width", kind: "mean" }],
          cells: [10.01, 9.98],
          rowTotals: [10.01, 9.98],
          columnTotals: [9.995],
          grandTotals: [9.995],
          cellCount: 2,
          limit: 10000,
        };
      },
      getDatasetGeneration: async (datasetId: string) => datasets.get(datasetId)?.meta.generation ?? 1,
      createTable: async (input) => {
        counters.tabulateExport += 1;
        const created = createManaged(input.request);
        const result: TableCreateResult = {
          dataset: {
            id: created.dataset.id,
            name: created.dataset.name,
            sourceType: created.dataset.sourceType,
            sourceName: null,
            rowCount: created.dataset.rowCount,
            colCount: created.dataset.colCount,
            generation: created.dataset.generation,
            createdAt: created.dataset.createdAt,
            updatedAt: created.dataset.updatedAt,
          },
          generation: created.generation,
          columns: created.columns,
        };
        return { result, warnings: [] };
      },
    },
    graph: {
      createGraphId: () => "graph-1",
      createNowIso: () => NOW,
    },
    report: {
      createReportId: () => "report-1",
      createNowIso: () => NOW,
      scheduleTimer: (callback) => {
        callback();
        return 0;
      },
      cancelTimer: () => undefined,
    },
    sql: {
      preflightCreateTableFromSqlQuery: async () => undefined,
      createTableFromSqlQuery: async (_sql: string, name: string) => {
        counters.sqlToTable += 1;
        const id = `sql-${counters.sqlToTable}`;
        const existing = datasets.get("table-main");
        const meta: DatasetMeta = {
          id,
          name,
          sourceType: "query",
          sourcePath: null,
          rowCount: existing?.rows.length ?? 0,
          colCount: existing?.columns.length ?? 0,
          generation: 1,
          createdAt: NOW,
          updatedAt: NOW,
        };
        datasets.set(id, {
          meta,
          columns: existing?.columns ?? [],
          display: existing?.display ?? [],
          rows: existing?.rows ?? [],
        });
        syncDatasets();
        return meta;
      },
      refreshDatasets: async () => syncDatasets(),
    },
    io: {
      createSnapshot: async (name?: string) => {
        counters.snapshotCreate += 1;
        return { id: "11111111-1111-4111-8111-111111111111", name: name ?? "Task 12 Snapshot", createdAt: NOW };
      },
      inspectCsvTarget: async () => ({ targetExists: false }),
      exportCsv: async () => {
        counters.exportCsv += 1;
      },
    },
  });

  return {
    runtime,
    counters,
    capturedSaveRequest: () => capturedSaveRequest,
    buildSaveCalls: () => buildSaveCalls,
    saveBuilderCapture: () => toJsonSafe(saveBuilderCapture),
  };
}

async function runAnalysisLifecycle(
  runtime: ReturnType<typeof createApplicationRuntime>,
  actor: CommandActor,
  datasetId: string,
  counters: OperationCounters,
): Promise<void> {
  const folderAssignments: Record<string, string> = {};

  for (const kind of Object.keys(analysisCommandFixtures) as AnalysisKind[]) {
    const fixture = analysisCommandFixtures[kind];
    const createInput = {
      ...(fixture.create as AnalysisCreateInput),
      sourceDatasetId: datasetId,
    } as AnalysisCreateInput;

    if (kind === "distribution") {
      createInput.draft.responses = [{ name: "width", type: "continuous" }];
      createInput.draft.graphs = {
        ...createInput.draft.graphs,
        overview: {
          ...createInput.draft.graphs?.overview,
          response: { name: "width", type: "continuous" },
          factor: { name: "width", type: "continuous" },
        },
      };
    }
    if (kind === "fitYByX") {
      createInput.draft.response = { name: "width", type: "continuous" };
      createInput.draft.factor = { name: "build", type: "nominal" };
    }
    if (kind === "fitModel") {
      createInput.draft.response = { name: "Strength", type: "continuous" };
      createInput.draft.terms = [{ kind: "main", columnNames: ["width"] }];
    }
    if (kind === "hypothesisTest") {
      createInput.draft.definition.roles = {
        layout: "long",
        response: { name: "width", type: "continuous" },
        condition: { name: "build", type: "nominal" },
        subject: null,
      };
    }

    const created = await runtime.execute({
      type: "analysis.create",
      input: createInput,
    }, actor);

    const analysisId = created.data.item.id;
    folderAssignments[analysisId] = "Analysis";

    counters.analysisUpdate[kind] += 1;
    const updateInput = fixture.update(analysisId, 1) as AnalysisUpdateInput;
    if (kind === "distribution") {
      updateInput.draft.responses = [{ name: "width", type: "continuous" }];
    }
    if (kind === "fitYByX") {
      updateInput.draft.response = { name: "width", type: "continuous" };
      updateInput.draft.factor = { name: "build", type: "nominal" };
    }
    if (kind === "fitModel") {
      updateInput.draft.response = { name: "Strength", type: "continuous" };
      updateInput.draft.terms = [{ kind: "main", columnNames: ["width"] }];
    }
    if (kind === "hypothesisTest") {
      updateInput.draft.definition.roles = {
        layout: "long",
        response: { name: "width", type: "continuous" },
        condition: { name: "build", type: "nominal" },
        subject: null,
      };
    }

    await runtime.execute({
      type: "analysis.update",
      input: updateInput,
    }, actor);

    counters.analysisRun[kind] += 1;
    await runtime.execute({
      type: "analysis.run",
      input: fixture.run(analysisId),
    }, actor);
  }

  useFolderStore.getState().loadFromProject({
    folders: ["Analysis"],
    tableFolders: { "table-main": "Analysis" },
    graphFolders: { "graph-1": "Analysis" },
    tabulateFolders: { "tabulate-1": "Analysis" },
    fitYByXFolders: {},
    fitModelFolders: {},
    reportFolders: { "report-1": "Analysis" },
    distributionFolders: {},
    analysisFolders: folderAssignments,
  });
}

async function runUiScenario(fixture: ArtifactParityFixture): Promise<{
  saveRequest: Record<string, unknown>;
  buildSaveCalls: number;
  counters: OperationCounters;
  saveBuilderCapture: SaveBuilderTableDependenciesCapture;
}> {
  resetStores();
  const actor: CommandActor = { kind: "ui" };
  const scenario = createScenarioRuntime(actor, fixture);

  await awaitWithTimeout(scenario.runtime.execute(fixtureEnvelopeToCommand(fixture, "table.create", "table.create"), actor), "ui.table.create", scenario.runtime);
  await awaitWithTimeout(scenario.runtime.execute(fixtureEnvelopeToCommand(fixture, "tableTransform.create", "tableTransform.create"), actor), "ui.tableTransform.create", scenario.runtime);
  await awaitWithTimeout(scenario.runtime.execute(fixtureEnvelopeToCommand(fixture, "tableTransform.run", "tableTransform.run"), actor), "ui.tableTransform.run", scenario.runtime);

  await awaitWithTimeout(scenario.runtime.execute(fixtureEnvelopeToCommand(fixture, "tabulate.create", "tabulate.create"), actor), "ui.tabulate.create", scenario.runtime);
  useTabulateStore.getState().updateItem(fixture.documents.tabulate.id, {
    name: fixture.documents.tabulate.name,
    rowFields: fixture.documents.tabulate.rowFields,
    columnFields: fixture.documents.tabulate.columnFields,
    statistics: fixture.documents.tabulate.statistics,
    includeRowTotals: fixture.documents.tabulate.includeRowTotals,
    includeColumnTotals: fixture.documents.tabulate.includeColumnTotals,
  });
  await awaitWithTimeout(scenario.runtime.execute(fixtureEnvelopeToCommand(fixture, "tabulate.run", "tabulate.run"), actor), "ui.tabulate.run", scenario.runtime);
  await awaitWithTimeout(scenario.runtime.execute(fixtureEnvelopeToCommand(fixture, "tabulate.exportTable", "tabulate.exportTable"), actor), "ui.tabulate.exportTable", scenario.runtime);

  await awaitWithTimeout(scenario.runtime.execute(fixtureEnvelopeToCommand(fixture, "graph.create", "graph.create"), actor), "ui.graph.create", scenario.runtime);
  useGraphBuilderStore.getState().setDocumentRevision("graph-1", 2);
  scenario.counters.graphUpdate += 1;
  await awaitWithTimeout(scenario.runtime.execute(fixtureEnvelopeToCommand(fixture, "graph.update", "graph.update"), actor), "ui.graph.update", scenario.runtime);

  await awaitWithTimeout(scenario.runtime.execute(fixtureEnvelopeToCommand(fixture, "report.create", "report.create"), actor), "ui.report.create", scenario.runtime);
  useReportStore.getState().setDocumentRevision("report-1", 2);
  scenario.counters.reportUpdate += 1;
  await awaitWithTimeout(scenario.runtime.execute(fixtureEnvelopeToCommand(fixture, "report.update", "report.update"), actor), "ui.report.update", scenario.runtime);

  await awaitWithTimeout(runAnalysisLifecycle(scenario.runtime, actor, "table-main", scenario.counters), "ui.analysis.lifecycle", scenario.runtime);

  const handlers = createWorkspaceCommandHandlers({
    t: (key, options) => options?.defaultValue ?? key,
    getProjectFilePath: () => "/Users/ashton/private/task12.spprj",
    getProjectRevision: () => useProjectStore.getState().projectRevision,
    isSaving: () => false,
    isReadOnly: () => false,
    executeCommand: scenario.runtime.execute.bind(scenario.runtime),
    authorizeCsvExportRoot: async () => ({ rootId: "root-1", displayName: "root-1" }),
    revokeCsvExportRoot: async () => undefined,
    waitForCommandConfirmation: async () => null,
  });

  await awaitWithTimeout(handlers.createSnapshot(), "ui.snapshot.create", scenario.runtime);
  await awaitWithTimeout(handlers.exportCsv({
    format: "csv",
    mode: "single-file",
    datasetIds: ["table-main"],
    archivePaths: {},
    sqliteNames: {},
  }, "/Users/ashton/private/exports/main.csv"), "ui.table.exportCsv", scenario.runtime);
  await awaitWithTimeout(handlers.saveProject(), "ui.project.save", scenario.runtime);

  const saveRequest = scenario.capturedSaveRequest();
  assert.ok(saveRequest, "UI scenario must call project.save");

  return {
    saveRequest,
    buildSaveCalls: scenario.buildSaveCalls(),
    counters: scenario.counters,
    saveBuilderCapture: scenario.saveBuilderCapture(),
  };
}

async function runMcpScenario(fixture: ArtifactParityFixture): Promise<{
  saveRequest: Record<string, unknown>;
  buildSaveCalls: number;
  counters: OperationCounters;
  saveBuilderCapture: SaveBuilderTableDependenciesCapture;
}> {
  resetStores();
  const actor: CommandActor = { kind: "mcp", sessionId: "mcp-session", clientId: "client-1" };
  const scenario = createScenarioRuntime(actor, fixture);

  const mcpCommands: Command[] = [
    fixtureEnvelopeToCommand(fixture, "table.create", "table.create"),
    fixtureEnvelopeToCommand(fixture, "tableTransform.create", "tableTransform.create"),
    fixtureEnvelopeToCommand(fixture, "tableTransform.run", "tableTransform.run"),
    fixtureEnvelopeToCommand(fixture, "tabulate.create", "tabulate.create"),
    fixtureEnvelopeToCommand(fixture, "tabulate.run", "tabulate.run"),
    fixtureEnvelopeToCommand(fixture, "tabulate.exportTable", "tabulate.exportTable"),
    fixtureEnvelopeToCommand(fixture, "graph.create", "graph.create"),
    fixtureEnvelopeToCommand(fixture, "graph.update", "graph.update"),
    fixtureEnvelopeToCommand(fixture, "report.create", "report.create"),
    fixtureEnvelopeToCommand(fixture, "report.update", "report.update"),
    fixtureEnvelopeToCommand(fixture, "snapshot.create", "snapshot.create"),
    fixtureEnvelopeToCommand(fixture, "table.exportCsv", "table.exportCsv"),
  ];

  for (const command of mcpCommands) {
    if (command.type === "graph.update") scenario.counters.graphUpdate += 1;
    if (command.type === "report.update") scenario.counters.reportUpdate += 1;
    try {
      await scenario.runtime.execute(command, actor);
    } catch (error) {
      throw new Error(`mcp scenario command ${command.type} failed: ${String(error)}`);
    }
    if (command.type === "graph.create") {
      useGraphBuilderStore.getState().setDocumentRevision("graph-1", 2);
    }
    if (command.type === "tabulate.create") {
      useTabulateStore.getState().updateItem(fixture.documents.tabulate.id, {
        name: fixture.documents.tabulate.name,
        rowFields: fixture.documents.tabulate.rowFields,
        columnFields: fixture.documents.tabulate.columnFields,
        statistics: fixture.documents.tabulate.statistics,
        includeRowTotals: fixture.documents.tabulate.includeRowTotals,
        includeColumnTotals: fixture.documents.tabulate.includeColumnTotals,
      });
    }
    if (command.type === "report.create") {
      useReportStore.getState().setDocumentRevision("report-1", 2);
    }
  }

  await runAnalysisLifecycle(scenario.runtime, actor, "table-main", scenario.counters);
  const saveCommand = fixtureEnvelopeToCommand(fixture, "project.save", "project.save");
  saveCommand.control = {
    ...(saveCommand.control ?? {}),
    expectedProjectRevision: useProjectStore.getState().projectRevision,
  };
  await scenario.runtime.execute(saveCommand, actor);

  const saveRequest = scenario.capturedSaveRequest();
  assert.ok(saveRequest, "MCP scenario must call project.save");

  return {
    saveRequest,
    buildSaveCalls: scenario.buildSaveCalls(),
    counters: scenario.counters,
    saveBuilderCapture: scenario.saveBuilderCapture(),
  };
}

function hydrateFromOpenResult(result: OpenProjectResult): void {
  useDatasetFilterStore.getState().loadFromProject(result.datasetFilters);
  const analysisPayload = hydrateAnalysisProjectPayload({
    analyses: result.analyses,
    analysisFolders: result.analysisFolders,
    distributions: result.distributions,
    distributionFolders: result.distributionFolders,
    fitYByX: result.fitYByX,
    fitYByXFolders: result.fitYByXFolders,
    fitModels: result.fitModels ?? [],
    fitModelFolders: result.fitModelFolders ?? {},
  });

  useHistoryStore.getState().loadFromProject([], result.snapshots as NamedSnapshot[]);
  useGraphBuilderStore.getState().loadFromProject(result.graphBuilders as GraphBuilderItem[]);
  useReportStore.getState().loadFromProject(result.reports);
  useAnalysisStore.getState().loadAnalyses(analysisPayload.analyses);
  useTabulateStore.getState().loadFromProject(result.tabulates as TabulateItem[]);
  useWorkflowStore.getState().loadFromProject({
    workflows: result.workflows,
    logicalFolders: result.logicalFolders,
    workflowRuns: result.workflowRuns,
    lineageGraph: result.lineageGraph,
  });
  useTableTransformStore.getState().loadFromProject(result.tableTransforms, result.tableTransformBindings);
  useFolderStore.getState().loadFromProject({
    folders: result.folders,
    tableFolders: result.tableFolders,
    graphFolders: result.graphFolders,
    tabulateFolders: result.tabulateFolders,
    fitYByXFolders: result.fitYByXFolders,
    fitModelFolders: result.fitModelFolders ?? {},
    reportFolders: result.reportFolders,
    distributionFolders: result.distributionFolders,
    analysisFolders: analysisPayload.analysisFolders,
  });
}

async function verifyReopenRuntimeExecution(
  fixture: ArtifactParityFixture,
  canonicalOpenProjectResult: OpenProjectResult,
  actor: CommandActor,
): Promise<{ normalizedPayload: unknown; counters: OperationCounters }> {
  resetStores();
  const scenario = createScenarioRuntime(actor, fixture);
  await scenario.runtime.execute(fixtureEnvelopeToCommand(fixture, "table.create", "table.create"), actor);

  assert.equal(useTableTransformStore.getState().definitions.length, 0);
  assert.equal(useTabulateStore.getState().items.length, 0);
  assert.equal(useGraphBuilderStore.getState().items.length, 0);
  assert.equal(useReportStore.getState().items.length, 0);
  assert.equal(useAnalysisStore.getState().items.length, 0);

  hydrateFromOpenResult(toJsonSafe(canonicalOpenProjectResult));

  assert.equal(useTableTransformStore.getState().definitions.length > 0, true);
  assert.equal(useTabulateStore.getState().items.length > 0, true);
  assert.equal(useGraphBuilderStore.getState().items.length > 0, true);
  assert.equal(useReportStore.getState().items.length > 0, true);
  const hydratedKinds = new Set(useAnalysisStore.getState().items.map((entry) => entry.analysisKind));
  for (const kind of ["distribution", "fitYByX", "fitModel", "hypothesisTest"] as const) {
    assert.equal(hydratedKinds.has(kind), true);
  }

  await scenario.runtime.execute(fixtureEnvelopeToCommand(fixture, "tableTransform.run", "tableTransform.run"), actor);
  try {
    await scenario.runtime.execute(fixtureEnvelopeToCommand(fixture, "tabulate.run", "tabulate.run"), actor);
  } catch (error) {
    throw new Error(`reopen tabulate.run failed: ${String(error)}`);
  }
  try {
    await scenario.runtime.execute(fixtureEnvelopeToCommand(fixture, "tabulate.exportTable", "tabulate.exportTable"), actor);
  } catch (error) {
    throw new Error(`reopen tabulate.exportTable failed: ${String(error)}`);
  }
  useGraphBuilderStore.getState().setDocumentRevision("graph-1", 2);
  scenario.counters.graphUpdate += 1;
  await scenario.runtime.execute(fixtureEnvelopeToCommand(fixture, "graph.update", "graph.update"), actor);
  useReportStore.getState().setDocumentRevision("report-1", 2);
  scenario.counters.reportUpdate += 1;
  await scenario.runtime.execute(fixtureEnvelopeToCommand(fixture, "report.update", "report.update"), actor);

  for (const kind of Object.keys(analysisCommandFixtures) as AnalysisKind[]) {
    const document = useAnalysisStore.getState().items.find((entry) => entry.analysisKind === kind);
    assert.ok(document, `Reopened ${kind} analysis must exist`);
    scenario.counters.analysisUpdate[kind] += 1;
    await scenario.runtime.execute({
      type: "analysis.update",
      input: analysisCommandFixtures[kind].update(document.id, document.configRevision),
    }, actor);
    scenario.counters.analysisRun[kind] += 1;
    await scenario.runtime.execute({ type: "analysis.run", input: { analysisId: document.id } }, actor);
  }

  await scenario.runtime.execute(fixtureEnvelopeToCommand(fixture, "sql.createTable", "sql.createTable"), actor);
  await scenario.runtime.execute(fixtureEnvelopeToCommand(fixture, "snapshot.create", "snapshot.create"), actor);
  await scenario.runtime.execute(fixtureEnvelopeToCommand(fixture, "table.exportCsv", "table.exportCsv"), actor);

  const hydratedPayload: SaveProjectRequest = productionBuildSaveProjectRequest("/Users/ashton/private/task12.spprj");
  const normalizedHydrated = normalizeWithPolicy(hydratedPayload, fixture.nondeterministicPolicy);
  assert.equal(((hydratedPayload.analyses as unknown[]) ?? []).length, 4);
  assert.equal(((hydratedPayload.tableTransforms as unknown[]) ?? []).length, 1);
  assert.equal(((hydratedPayload.tableTransformBindings as unknown[]) ?? []).length, 1);

  assert.equal(scenario.counters.tableTransformRun > 0, true);
  assert.equal(scenario.counters.tabulateRun > 0, true);
  assert.equal(scenario.counters.tabulateExport > 0, true);
  assert.equal(scenario.counters.graphUpdate > 0, true);
  assert.equal(scenario.counters.reportUpdate > 0, true);
  assert.equal(scenario.counters.sqlToTable > 0, true);
  assert.equal(scenario.counters.snapshotCreate > 0, true);
  assert.equal(scenario.counters.exportCsv > 0, true);
  for (const kind of ["distribution", "fitYByX", "fitModel", "hypothesisTest"] as const) {
    assert.equal(scenario.counters.analysisUpdate[kind] > 0, true);
    assert.equal(scenario.counters.analysisRun[kind] > 0, true);
  }

  return {
    normalizedPayload: normalizedHydrated,
    counters: scenario.counters,
  };
}

const fixture = loadFixture();
const canonicalOpenProjectResult = loadCanonicalOpenResultFixture();
assert.equal(fixture.projectionCases.length, 17, "Shared artifact parity fixture must include all 17 projection cases");

const ui = await runUiScenario(fixture);
const mcp = await runMcpScenario(fixture);

assertSaveBuilderPreservedTableSeed(ui.saveBuilderCapture, fixture.tableSeed, "UI");
assertSaveBuilderPreservedTableSeed(mcp.saveBuilderCapture, fixture.tableSeed, "MCP");

assert.ok(ui.buildSaveCalls > 0, "UI scenario must call production buildSaveProjectRequest");
assert.ok(mcp.buildSaveCalls > 0, "MCP scenario must call production buildSaveProjectRequest");

const normalizedUi = toJsonSafe(normalizeWithPolicy(ui.saveRequest, fixture.nondeterministicPolicy));
const normalizedMcp = toJsonSafe(normalizeWithPolicy(mcp.saveRequest, fixture.nondeterministicPolicy));
const normalizedCanonical = toJsonSafe(normalizeWithPolicy(fixture.canonicalSavePayload, fixture.nondeterministicPolicy));
assert.deepEqual(normalizedUi, normalizedCanonical, "UI scenario must match canonical save payload");
assert.deepEqual(normalizedMcp, normalizedCanonical, "MCP scenario must match canonical save payload");

const normalizedOpen = toJsonSafe(normalizeWithPolicy(canonicalOpenProjectResult, fixture.nondeterministicPolicy));
const changedBusinessCreatedAt = toJsonSafe(canonicalOpenProjectResult);
assert.ok(changedBusinessCreatedAt.project, "Open result fixture must include project");
changedBusinessCreatedAt.project.createdAt = "2031-01-01T00:00:00.000Z";
assert.notDeepEqual(
  toJsonSafe(normalizeWithPolicy(changedBusinessCreatedAt, fixture.nondeterministicPolicy)),
  normalizedOpen,
  "Business createdAt must remain comparison-significant",
);

const changedNestedFilePath = toJsonSafe(canonicalOpenProjectResult);
assert.ok(changedNestedFilePath.project, "Open result fixture must include project");
changedNestedFilePath.project.filePath = "/Users/ashton/private/altered.spprj";
assert.notDeepEqual(
  toJsonSafe(normalizeWithPolicy(changedNestedFilePath, fixture.nondeterministicPolicy)),
  normalizedOpen,
  "Nested project.filePath must remain comparison-significant",
);

const changedLineageGraph = toJsonSafe(canonicalOpenProjectResult);
assert.ok(changedLineageGraph.lineageGraph, "Open result fixture must include lineageGraph");
changedLineageGraph.lineageGraph.graphHash = `${changedLineageGraph.lineageGraph.graphHash}-changed`;
assert.notDeepEqual(
  toJsonSafe(normalizeWithPolicy(changedLineageGraph, fixture.nondeterministicPolicy)),
  normalizedOpen,
  "Lineage graph mutations must remain comparison-significant",
);

const uiAnalyses = (ui.saveRequest.analyses as unknown[]) ?? [];
const uiTransforms = (ui.saveRequest.tableTransforms as unknown[]) ?? [];
const uiTransformBindings = (ui.saveRequest.tableTransformBindings as unknown[]) ?? [];
assert.equal(uiAnalyses.length, 4, "Save payload must persist all four analysis kinds");
assert.equal(uiTransforms.length, 1, "Save payload must persist the table transform definition");
assert.equal(uiTransformBindings.length, 1, "Save payload must persist the table transform binding");

const uiReopen = await verifyReopenRuntimeExecution(fixture, canonicalOpenProjectResult, { kind: "ui" });
const mcpReopen = await verifyReopenRuntimeExecution(fixture, canonicalOpenProjectResult, { kind: "mcp", sessionId: "mcp-reopen", clientId: "client-reopen" });
assert.deepEqual(uiReopen.normalizedPayload, mcpReopen.normalizedPayload, "UI and MCP reopened payloads must remain equivalent after runtime execution");

console.log("mcp artifact parity passed");
