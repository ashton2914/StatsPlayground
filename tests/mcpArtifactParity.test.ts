import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createApplicationRuntime } from "@/applicationCommands/applicationRuntime";
import type {
  ApplicationCommand,
  ApplicationCommandRegistry,
  CommandActor,
  CommandResult,
} from "@/applicationCommands/types";

type Command = ApplicationCommand<ApplicationCommandRegistry>;

interface FixtureNondeterministicPolicy {
  stripFields: string[];
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
  nondeterministicPolicy: FixtureNondeterministicPolicy;
  savePayloads: {
    ui: Record<string, unknown>;
    mcp: Record<string, unknown>;
  };
}

const TEST_FILE_DIR = dirname(fileURLToPath(import.meta.url));
const UUID_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function loadFixture(): ArtifactParityFixture {
  const content = readFileSync(
    resolve(TEST_FILE_DIR, "../contracts/mcp/artifact-parity.v1.json"),
    "utf8",
  );
  return JSON.parse(content) as ArtifactParityFixture;
}

function normalizeWithPolicy(
  value: unknown,
  policy: FixtureNondeterministicPolicy,
): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    if (UUID_LIKE.test(value)) return policy.uuidLike;
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeWithPolicy(entry, policy));
  }
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (policy.stripFields.includes(key)) continue;
      output[key] = normalizeWithPolicy(child, policy);
    }
    return output;
  }
  return value;
}

function findCase(fixture: ArtifactParityFixture, id: string): FixtureProjectionCase {
  const found = fixture.projectionCases.find((entry) => entry.id === id);
  assert.ok(found, `Missing projection case in fixture: ${id}`);
  return found;
}

function toCommand(entry: FixtureProjectionCase): Command {
  const command: Command = {
    type: entry.expectedEnvelope.type as Command["type"],
    input: entry.expectedEnvelope.input as never,
    control: entry.expectedEnvelope.control as never,
  };
  return command;
}

function createRuntimeForActor(actor: CommandActor, fixture: ArtifactParityFixture) {
  let projectRevision = 21;
  const analyses: Array<{ id: string }> = [];
  const tabulates: Array<{ id: string; sourceDatasetId: string; rowFields: string[]; columnFields: string[]; statistics: Array<{ id: string; field: string; kind: string }>; includeRowTotals: boolean; includeColumnTotals: boolean; createdAt: string; name: string }> = [];
  const reports: Array<Record<string, unknown>> = [{
    schemaVersion: 1,
    id: "report-1",
    name: "Task 12 Report",
    markdown: "# Updated",
    createdAt: "2026-09-16T00:00:00.000Z",
    updatedAt: "2026-09-16T00:00:00.000Z",
  }];
  const reportRevisions = new Map<string, number>([["report-1", 2]]);
  const graphs: Array<Record<string, unknown>> = [
    {
      id: "graph-1",
      name: "Width Graph",
      sourceDatasetId: "table-main",
      mode: "2d",
      modeStates: {
        twoD: {
          encoding: {},
          multiX: [],
          multiY: [],
          elements: [{ kind: "points", enabled: true }],
          smootherLambda: 0.4,
        },
        threeD: {
          encoding: {},
          elements: [{ kind: "scatter3d", enabled: true }],
          smootherLambda: 0.4,
        },
        multivariate: {
          columns: [],
          chartType: "correlationMatrix",
          correlationMethod: "pearson",
        },
      },
      createdAt: "2026-09-16T00:00:00.000Z",
    },
  ];
  const graphRevisions = new Map<string, number>([["graph-1", 2]]);

  return createApplicationRuntime({
    initialRevision: projectRevision,
    revision: {
      get: () => projectRevision,
      set: (next) => {
        projectRevision = next;
      },
    },
    project: {
      getProjectState: () => ({
        project: {
          name: "Task12",
          filePath: "/Users/ashton/private/task12.spprj",
          createdAt: "2026-09-16T00:00:00.000Z",
        },
        dirty: true,
        readOnly: false,
        projectRevision,
      }),
      listDatasets: () => [
        {
          id: "table-main",
          name: "Main Table",
          sourceType: "manual",
          sourcePath: null,
          rowCount: 2,
          colCount: 2,
          generation: 1,
          createdAt: "2026-09-16T00:00:00.000Z",
          updatedAt: "2026-09-16T00:00:00.000Z",
        },
      ],
      listTableTransforms: () => [
        {
          id: "transform-1",
          name: "Sort width",
          formatVersion: "1",
          revision: 3,
          inputSlots: [],
          operation: {
            kind: "sort",
            sortColumns: [{ column: "width", direction: "ascending" }],
          },
          output: { tableDocumentId: "table-main", name: "Sorted width" },
        },
      ],
      listGraphs: () => [
        {
          id: "graph-1",
          name: "Width Graph",
          sourceDatasetId: "table-main",
          mode: "simple",
          modeStates: {},
          createdAt: "2026-09-16T00:00:00.000Z",
        },
      ],
      listReports: () => [
        {
          schemaVersion: 1,
          id: "report-1",
          name: "Task 12 Report",
          markdown: "# Updated",
          createdAt: "2026-09-16T00:00:00.000Z",
          updatedAt: "2026-09-16T00:00:00.000Z",
        },
      ],
      listAnalyses: () => analyses as never,
      listTabulates: () => tabulates as never,
      getColumns: async () => [["width", "DOUBLE"], ["build", "VARCHAR"]],
      getColumnDisplayProps: async () => [],
      getDatasetGeneration: async () => 1,
      buildSaveProjectRequest: () => (actor.kind === "ui" ? fixture.savePayloads.ui : fixture.savePayloads.mcp) as never,
      saveProjectCommand: async () => ({
        name: "Task12",
        createdAt: "2026-09-16T00:00:00.000Z",
        fileName: "task12.spprj",
        hasProjectPath: true,
      }),
      flushPendingHistory: async () => undefined,
    },
    table: {
      createManagedTable: async (request) => ({
        dataset: {
          id: "table-main",
          name: request.name,
          sourceType: "manual",
          sourcePath: null,
          rowCount: request.rows.length,
          colCount: request.columns.length,
          generation: 1,
          createdAt: "2026-09-16T00:00:00.000Z",
          updatedAt: "2026-09-16T00:00:00.000Z",
        },
        generation: 1,
        columns: request.columns.map((column, colIndex) => ({
          colIndex,
          colName: column.name,
          colType: column.sqlType.toUpperCase(),
          width: column.display?.width,
          format: column.display?.format,
          extras: column.display?.extras,
        })),
      }),
      refreshDatasets: async () => undefined,
      markDirty: () => undefined,
      recordAction: () => undefined,
      activateDataset: () => undefined,
      historyMessage: () => "created",
    },
    tableTransform: {
      preflightCreateAndRun: async () => undefined,
      preflightRun: async () => undefined,
      createAndRun: async () => ({
        definitionId: "transform-1",
        output: { id: "table-main", name: "Main Table" },
        runState: { outputGeneration: 1, status: "succeeded" },
      } as never),
      rerun: async () => ({
        definitionId: "transform-1",
        output: { id: "table-main", name: "Main Table" },
        runState: { outputGeneration: 1, status: "succeeded" },
      } as never),
      listDefinitions: () => [{
        id: "transform-1",
        name: "Sort width",
        formatVersion: "1",
        revision: 3,
        inputSlots: [],
        operation: {
          kind: "sort",
          sortColumns: [{ column: "width", direction: "ascending" }],
        },
        output: { tableDocumentId: "table-main", name: "Sorted width" },
      }],
      listBindings: () => [{
        definitionId: "transform-1",
        sourceDatasetId: "table-main",
        sourceGeneration: 1,
      }],
      refreshDatasets: async () => undefined,
      markDirty: () => undefined,
      recordAction: () => undefined,
      activateDataset: () => undefined,
      historyMessage: () => "transform",
    },
    sql: {
      preflightCreateTableFromSqlQuery: async () => undefined,
      createTableFromSqlQuery: async () => ({
        id: "table-main",
        name: "SQL Result",
        sourcePath: null,
        sourceType: "query",
        rowCount: 2,
        colCount: 2,
        generation: 1,
        createdAt: "2026-09-16T00:00:00.000Z",
        updatedAt: "2026-09-16T00:00:00.000Z",
      }),
      refreshDatasets: async () => undefined,
      markDirty: () => undefined,
      recordAction: () => undefined,
      activateDataset: () => undefined,
      historyMessage: () => "sql",
    },
    graph: {
      listGraphs: () => graphs as never,
      listGraphNamesForAllocation: () => graphs.map((item) => String(item.name ?? "")),
      listDatasets: () => [{
        id: "table-main",
        name: "Main Table",
      }],
      createGraphId: () => "graph-created",
      createNowIso: () => "2026-09-16T00:00:00.000Z",
      addGraph: (item) => {
        graphs.push(item as unknown as Record<string, unknown>);
      },
      replaceGraph: (item) => {
        const index = graphs.findIndex((entry) => entry.id === item.id);
        if (index >= 0) {
          graphs[index] = item as unknown as Record<string, unknown>;
        }
      },
      getDocumentRevision: (graphId) => graphRevisions.get(graphId) ?? 1,
      setDocumentRevision: (graphId, revision) => {
        graphRevisions.set(graphId, revision);
      },
      activateGraph: () => undefined,
      markDirty: () => undefined,
      recordAction: () => undefined,
      historyCreateMessage: () => "graph create",
      historyUpdateMessage: () => "graph update",
      normalizeGraph: (item) => item,
    },
    report: {
      listReports: () => reports as never,
      nextReportName: () => "Task 12 Report",
      listReportNamesForAllocation: () => reports.map((item) => String(item.name ?? "")),
      createReportId: () => "report-created",
      createNowIso: () => "2026-09-16T00:00:00.000Z",
      addReport: (item) => {
        reports.push(item as unknown as Record<string, unknown>);
      },
      updateMarkdown: (id, markdown, updatedAt) => {
        const index = reports.findIndex((item) => item.id === id);
        if (index >= 0) {
          reports[index] = { ...reports[index], markdown, updatedAt };
        }
      },
      getDocumentRevision: (reportId) => reportRevisions.get(reportId) ?? 1,
      setDocumentRevision: (reportId, revision) => {
        reportRevisions.set(reportId, revision);
      },
      activateReport: () => undefined,
      markDirty: () => undefined,
      recordAction: () => undefined,
      historyCreateMessage: () => "report create",
      historyEditMessage: () => "report edit",
      scheduleTimer: (callback) => {
        callback();
        return 0;
      },
      cancelTimer: () => undefined,
      flushPendingHistory: async () => undefined,
    },
    tabulate: {
      listTabulates: () => tabulates,
      listDatasets: () => [{ id: "table-main", name: "Main Table" }],
      listTabulateNamesForAllocation: () => [],
      createTabulateId: () => "tabulate-1",
      createNowIso: () => "2026-09-16T00:00:00.000Z",
      nextTabulateBaseName: () => "Tabulate 1",
      addTabulate: (item) => {
        tabulates.push(item);
      },
      activateTabulate: () => undefined,
      markDirty: () => undefined,
      recordAction: () => undefined,
      historyCreateMessage: () => "tabulate",
      runTabulate: async () => ({
        rowMembers: [["EV"], ["DV"]],
        columnMembers: [[]],
        statistics: [{ id: "stat-mean", field: "width", kind: "mean" }],
        cells: [10.01, 9.98],
        rowTotals: [10.01, 9.98],
        columnTotals: [9.995],
        grandTotals: [9.995],
        cellCount: 2,
        limit: 10000,
      }),
      getDatasetGeneration: async () => 1,
      setLatestResult: () => undefined,
      getLatestResult: () => null,
      createTable: async () => ({
        result: {
          dataset: {
            id: "table-main",
            name: "Tabulate Export",
            sourceType: "manual",
            sourcePath: null,
            rowCount: 2,
            colCount: 2,
            generation: 1,
            createdAt: "2026-09-16T00:00:00.000Z",
            updatedAt: "2026-09-16T00:00:00.000Z",
          },
          generation: 1,
          columns: [],
        },
        warnings: [],
      }),
      buildExportRequest: () => ({
        name: "Tabulate Export",
        columnNames: ["build", "mean(width)"],
        columnTypes: ["VARCHAR", "DOUBLE"],
        rows: [["EV", 10.01], ["DV", 9.98]],
      }),
    },
    io: {
      createSnapshot: async () => ({
        snapshotId: "11111111-1111-4111-8111-111111111111",
        snapshotName: "Task 12 Snapshot",
        createdAt: "2026-09-16T00:00:00.000Z",
      }),
      inspectCsvTarget: async () => ({ targetExists: false }),
      exportCsv: async () => undefined,
    },
  });
}

async function executeForActor(
  actor: CommandActor,
  fixture: ArtifactParityFixture,
  commandIds: string[],
): Promise<Array<CommandResult<unknown>>> {
  const runtime = createRuntimeForActor(actor, fixture);
  const results: Array<CommandResult<unknown>> = [];
  for (const commandId of commandIds) {
    const command = toCommand(findCase(fixture, commandId));
    const result = await runtime.execute(command as never, actor);
    results.push(result);
  }
  return results;
}

const fixture = loadFixture();
assert.equal(fixture.projectionCases.length, 17, "Shared artifact parity fixture must include all 17 Phase 1 mutation projections");

const commandIds = [
  "table.create",
  "tableTransform.create",
  "tableTransform.run",
  "sql.createTable",
  "tabulate.create",
  "tabulate.run",
  "tabulate.exportTable",
  "graph.create",
  "graph.update",
  "report.create",
  "report.update",
  "project.save",
  "snapshot.create",
  "table.exportCsv",
];

const uiResults = await executeForActor({ kind: "ui" }, fixture, commandIds);
const mcpResults = await executeForActor({ kind: "mcp", sessionId: "mcp-session", clientId: "client-1" }, fixture, commandIds);
assert.equal(uiResults.length, mcpResults.length);

for (let index = 0; index < uiResults.length; index += 1) {
  const ui = normalizeWithPolicy(uiResults[index], fixture.nondeterministicPolicy);
  const mcp = normalizeWithPolicy(mcpResults[index], fixture.nondeterministicPolicy);
  assert.deepEqual(
    ui,
    mcp,
    `Runtime parity mismatch at index ${index}`,
  );
}

assert.deepEqual(
  normalizeWithPolicy(fixture.savePayloads.ui, fixture.nondeterministicPolicy),
  normalizeWithPolicy(fixture.savePayloads.mcp, fixture.nondeterministicPolicy),
  "Fixture UI/MCP save payloads should align after allowed nondeterministic normalization",
);

console.log("mcp artifact parity passed");
