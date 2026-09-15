import assert from "node:assert/strict";

import { createApplicationRuntime } from "@/applicationCommands/applicationRuntime";
import { createTableCommandHandlers } from "@/applicationCommands/tableCommands";
import type { CommandActor } from "@/applicationCommands/runtime";
import type { ApplicationCommandRegistry, TableCreateInput } from "@/applicationCommands/types";
import type { ColumnDisplayProps, CreateManagedTableRequest, DatasetMeta } from "@/types/data";

interface ParityRunResult {
  requestPayload: string;
  result: Awaited<ReturnType<ReturnType<typeof createApplicationRuntime>["execute"]>>;
  refreshCalls: number;
  historyEntries: string[];
  activateCalls: string[];
  dirtyTransitions: number;
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
          columnType: "double",
          display: {
            width: 144,
            format: { kind: "Currency", decimals: 3, currency: "USD" },
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
  const runtime = createApplicationRuntime({
    initialRevision: 7,
    project: {
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
    },
    table: {
      createManagedTable: async (request) => {
        requestPayload = JSON.stringify(request);
        const dataset: DatasetMeta = {
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
        const columns = request.columns.map((column, colIndex) => {
          const normalizedType = colIndex === 0
            ? "DOUBLE"
            : column.columnType.toUpperCase();
          const normalizedFormat = column.display?.format
            ? {
                ...column.display.format,
                kind: column.display.format.kind.toLowerCase(),
              }
            : undefined;
          return {
            colIndex,
            colName: column.name,
            colType: normalizedType,
            width: column.display?.width,
            format: normalizedFormat,
            extras: column.display?.extras,
          };
        });
        datasets.splice(0, datasets.length, dataset);
        columnsById.set(dataset.id, columns.map((column) => [column.colName, column.colType]));
        displayById.set(dataset.id, toDisplay(request.columns));
        generationById.set(dataset.id, 1);
        return {
          dataset,
          generation: 1,
          columns,
        };
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
    },
  });
  const result = await runtime.execute({ type: "table.create", input: commandInput }, actor);
  return {
    requestPayload,
    result,
    refreshCalls,
    historyEntries,
    activateCalls,
    dirtyTransitions,
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

{
  const historyEntries: string[] = [];
  const handlers = createTableCommandHandlers({
    createManagedTable: async () => ({
      dataset: {
        id: "tbl-localized",
        name: "Localized",
        sourcePath: null,
        sourceType: "manual",
        rowCount: 0,
        colCount: 0,
        generation: 1,
        createdAt: "2026-09-15T00:00:00.000Z",
        updatedAt: "2026-09-15T00:00:00.000Z",
      },
      generation: 1,
      columns: [],
    }),
    refreshDatasets: async () => {},
    markDirty: () => {},
    recordAction: (description) => {
      historyEntries.push(description);
    },
    activateDataset: () => {},
  });

  await handlers.createTable({
    request: {
      name: "Localized",
      columns: [],
      rows: [],
    },
  });

  assert.equal(historyEntries.length, 1);
  assert.equal(historyEntries[0]?.includes("Created table"), false);
}

{
  const cases = [
    {
      stage: "refresh",
      expectedWarning: {
        code: "table_create_refresh_failed",
        message: "Table created, but dataset refresh failed",
      },
    },
    {
      stage: "dirty",
      expectedWarning: {
        code: "table_create_mark_dirty_failed",
        message: "Table created, but dirty state update failed",
      },
    },
    {
      stage: "selection",
      expectedWarning: {
        code: "table_create_activate_dataset_failed",
        message: "Table created, but dataset activation failed",
      },
    },
    {
      stage: "history",
      expectedWarning: {
        code: "table_create_history_failed",
        message: "Table created, but history recording failed",
      },
    },
  ] as const;

  for (const testCase of cases) {
    let createCalls = 0;
    let refreshCalls = 0;
    let dirty = false;
    let dirtyTransitions = 0;
    let markDirtyCalls = 0;
    let actionCalls = 0;
    let activationCalls = 0;

    const runtime = createApplicationRuntime({
      initialRevision: 11,
      project: {
        getProjectState: () => ({
          project: {
            name: "Task3",
            filePath: "/Users/ashton/projects/task3.spprj",
            createdAt: "2026-09-15T00:00:00.000Z",
          },
          dirty,
          readOnly: false,
          projectRevision: 11,
        }),
        listDatasets: () => [],
        listTableTransforms: () => [],
        listGraphs: () => [],
        listReports: () => [],
        listAnalyses: () => [],
        listTabulates: () => [],
        getColumns: async () => [],
        getColumnDisplayProps: async () => [],
        getDatasetGeneration: async () => 1,
      },
      table: {
        createManagedTable: async () => {
          createCalls += 1;
          return {
            dataset: {
              id: "tbl-created-once",
              name: "Created Once",
              sourcePath: null,
              sourceType: "manual",
              rowCount: 1,
              colCount: 1,
              generation: 2,
              createdAt: "2026-09-15T00:00:00.000Z",
              updatedAt: "2026-09-15T00:00:00.000Z",
            },
            generation: 2,
            columns: [{
              colIndex: 0,
              colName: "amount",
              colType: "DOUBLE",
              width: 120,
              format: { kind: "currency", decimals: 2, currency: "USD" },
              extras: { unit: { symbol: "$" } },
            }],
          };
        },
        refreshDatasets: async () => {
          refreshCalls += 1;
          if (testCase.stage === "refresh") {
            throw new Error("refresh boom");
          }
        },
        markDirty: () => {
          markDirtyCalls += 1;
          if (testCase.stage === "dirty") {
            throw new Error("dirty boom");
          }
          if (!dirty) dirtyTransitions += 1;
          dirty = true;
        },
        recordAction: () => {
          actionCalls += 1;
          if (testCase.stage === "history") {
            throw new Error("history boom");
          }
        },
        activateDataset: () => {
          activationCalls += 1;
          if (testCase.stage === "selection") {
            throw new Error("selection boom");
          }
        },
        historyMessage: () => "history-message",
      },
    });

    const result = await runtime.execute(
      {
        type: "table.create",
        input: {
          request: {
            name: "Created Once",
            columns: [{ name: "amount", columnType: "double" }],
            rows: [[1]],
          },
        },
      },
      { kind: "ui" },
    );

    assert.equal(result.changed, true);
    assert.equal(result.projectRevision, 12);
    assert.equal(result.data.dataset.id, "tbl-created-once");
    assert.equal(result.data.columns[0]?.colType, "DOUBLE");
    assert.equal(createCalls, 1, `${testCase.stage}: create should run exactly once`);
    assert.equal(refreshCalls, 1, `${testCase.stage}: refresh should run exactly once`);
    assert.equal(markDirtyCalls, 1, `${testCase.stage}: markDirty should be attempted once`);
    assert.equal(activationCalls, 1, `${testCase.stage}: activate should be attempted once`);
    assert.equal(actionCalls, 1, `${testCase.stage}: history should be attempted once`);
    if (testCase.stage === "dirty") {
      assert.equal(dirtyTransitions, 0, "dirty: transition should not be updated when markDirty throws");
    } else {
      assert.equal(dirtyTransitions, 1, `${testCase.stage}: dirty transition should happen exactly once`);
    }
    assert.deepEqual(result.warnings, [testCase.expectedWarning]);
  }
}

console.log("application command table parity tests passed");
