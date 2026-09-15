import assert from "node:assert/strict";

import { createProjectCommandHandlers } from "@/applicationCommands/projectCommands";
import { createApplicationCommandRuntime, type CommandActor } from "@/applicationCommands/runtime";
import { createTableCommandHandlers } from "@/applicationCommands/tableCommands";
import type { ApplicationCommandRegistry, TableCreateInput } from "@/applicationCommands/types";
import type { ColumnDisplayProps, CreateManagedTableRequest, DatasetMeta } from "@/types/data";

interface ParityRunResult {
  requestPayload: string;
  result: Awaited<ReturnType<ReturnType<typeof createApplicationCommandRuntime<ApplicationCommandRegistry>>["execute"]>>;
  refreshCalls: number;
  historyEntries: string[];
  activateCalls: string[];
  dirtyTransitions: number;
  describeCalls: number;
}

function toDisplay(columns: CreateManagedTableRequest["columns"]): ColumnDisplayProps[] {
  const out: ColumnDisplayProps[] = [];
  columns.forEach((column, colIndex) => {
    if (!column.display) return;
    out.push({
      colIndex,
      width: column.display.width,
      format: column.display.format,
      extras: column.display.extras,
    });
  });
  return out;
}

async function runCreateForActor(actor: CommandActor): Promise<ParityRunResult> {
  const commandInput: TableCreateInput = {
    request: {
      name: "Managed Table",
      columns: [
        {
          name: "length",
          columnType: "DOUBLE",
          display: {
            width: 144,
            format: { kind: "currency", decimals: 3, currency: "USD" },
            extras: {
              unit: { symbol: "mm" },
              spec: { lower: 1.2, upper: 3.4 },
              range: { preferred: [1.5, 2.5] },
              notes: { text: "critical" },
              valueOrder: { values: ["EV", "DV", "PQ"] },
              opaque: { nested: { a: [1, true, "x"] } },
            },
          },
        },
        {
          name: "build",
          columnType: "VARCHAR",
          display: {
            width: 220,
            format: { kind: "asis" },
            extras: {
              valueOrder: { values: ["EV", "DV"] },
            },
          },
        },
      ],
      rows: [
        [1.234, "EV"],
        [null, "DV"],
      ],
    },
    preview: { offset: 0, limit: 2 },
  };

  const datasets: DatasetMeta[] = [];
  const columnsById = new Map<string, Array<[string, string]>>();
  const displayById = new Map<string, ColumnDisplayProps[]>();
  const generationById = new Map<string, number>();
  let refreshCalls = 0;
  let dirty = false;
  let dirtyTransitions = 0;
  const historyEntries: string[] = [];
  const activateCalls: string[] = [];
  let requestPayload = "";
  let describeCalls = 0;

  const projectHandlers = createProjectCommandHandlers({
    getProjectState: () => ({
      project: {
        name: "Task3",
        filePath: "/Users/ashton/projects/task3.spprj",
        createdAt: "2026-09-15T00:00:00.000Z",
      },
      dirty,
      readOnly: false,
      projectRevision: 7,
    }),
    listDatasets: () => datasets,
    listTableTransforms: () => [],
    listGraphs: () => [],
    listReports: () => [],
    listAnalyses: () => [],
    listTabulates: () => [],
    getColumns: async (datasetId: string) => columnsById.get(datasetId) ?? [],
    getColumnDisplayProps: async (datasetId: string) => displayById.get(datasetId) ?? [],
    getDatasetGeneration: async (datasetId: string) => generationById.get(datasetId) ?? 1,
    queryTableWindow: async (request) => {
      describeCalls += 1;
      return {
        columns: ["length", "build"],
        columnTypes: ["DOUBLE", "VARCHAR"],
        rows: [[1.234, "EV"], [null, "DV"]],
        totalRows: 2,
        start: request.start,
        generation: request.generation,
      };
    },
  });

  const tableHandlers = createTableCommandHandlers({
    createManagedTable: async (request) => {
      requestPayload = JSON.stringify(request);
      const meta: DatasetMeta = {
        id: "tbl-managed-1",
        name: request.name,
        sourcePath: null,
        sourceType: "manual",
        rowCount: request.rows.length,
        colCount: request.columns.length,
        generation: 1,
        createdAt: "2026-09-15T00:00:00.000Z",
        updatedAt: "2026-09-15T00:00:00.000Z",
      };
      datasets.splice(0, datasets.length, meta);
      columnsById.set(meta.id, request.columns.map((column) => [column.name, column.columnType]));
      displayById.set(meta.id, toDisplay(request.columns));
      generationById.set(meta.id, 1);
      return meta;
    },
    refreshDatasets: async () => {
      refreshCalls += 1;
    },
    markDirty: () => {
      if (!dirty) {
        dirtyTransitions += 1;
      }
      dirty = true;
    },
    recordAction: (description) => {
      historyEntries.push(description);
    },
    activateDataset: (datasetId) => {
      activateCalls.push(datasetId);
    },
    historyMessage: (name) => `Created table ${name}`,
    projectHandlers,
  });

  const runtime = createApplicationCommandRuntime<ApplicationCommandRegistry>({ initialRevision: 7 });
  runtime.register(
    "table.create",
    async (input) => ({
      changed: true,
      data: await tableHandlers.createTable(input),
      warnings: [],
    }),
    { mode: "mutation" },
  );

  const result = await runtime.execute({ type: "table.create", input: commandInput }, actor);
  return {
    requestPayload,
    result,
    refreshCalls,
    historyEntries,
    activateCalls,
    dirtyTransitions,
    describeCalls,
  };
}

const ui = await runCreateForActor({ kind: "ui" });
const mcp = await runCreateForActor({ kind: "mcp", sessionId: "mcp-session" });

assert.equal(ui.requestPayload, mcp.requestPayload, "UI and MCP must send byte-equivalent canonical requests");
assert.deepEqual(ui.result.data, mcp.result.data, "UI and MCP must receive equivalent normalized results");
assert.equal(ui.result.projectRevision, 8, "table.create should increment project revision exactly once");
assert.equal(mcp.result.projectRevision, 8, "table.create should increment project revision exactly once");
assert.equal(ui.refreshCalls, 1, "table.create should refresh datasets exactly once");
assert.equal(mcp.refreshCalls, 1, "table.create should refresh datasets exactly once");
assert.equal(ui.historyEntries.length, 1, "table.create should record one history entry");
assert.equal(mcp.historyEntries.length, 1, "table.create should record one history entry");
assert.equal(ui.activateCalls.length, 1, "table.create should activate created table once");
assert.equal(mcp.activateCalls.length, 1, "table.create should activate created table once");
assert.equal(ui.activateCalls[0], "tbl-managed-1");
assert.equal(mcp.activateCalls[0], "tbl-managed-1");
assert.equal(ui.dirtyTransitions, 1, "table.create should trigger one dirty transition");
assert.equal(mcp.dirtyTransitions, 1, "table.create should trigger one dirty transition");
assert.equal(ui.describeCalls, 1, "table.create should reuse describe contract exactly once");
assert.equal(mcp.describeCalls, 1, "table.create should reuse describe contract exactly once");
assert.deepEqual(ui.result.data.columns[0], {
  colIndex: 0,
  colName: "length",
  colType: "DOUBLE",
  width: 144,
  format: { kind: "currency", decimals: 3, currency: "USD" },
  extras: {
    unit: { symbol: "mm" },
    spec: { lower: 1.2, upper: 3.4 },
    range: { preferred: [1.5, 2.5] },
    notes: { text: "critical" },
    valueOrder: { values: ["EV", "DV", "PQ"] },
    opaque: { nested: { a: [1, true, "x"] } },
  },
});

console.log("application command table parity tests passed");
