import assert from "node:assert/strict";

import { createApplicationRuntime } from "@/applicationCommands/applicationRuntime";
import type { DatasetMeta } from "@/types/data";
import type { TabulateItem, TabulateRequest, TabulateResult } from "@/types/tabulate";

function dataset(id: string, name: string, generation: number): DatasetMeta {
  return {
    id,
    name,
    sourcePath: null,
    sourceType: "manual",
    rowCount: 4,
    colCount: 2,
    generation,
    createdAt: "2026-09-15T00:00:00.000Z",
    updatedAt: "2026-09-15T00:00:00.000Z",
  };
}

function tabulateItem(id: string, sourceDatasetId: string): TabulateItem {
  return {
    id,
    name: "Tabulate 1",
    sourceDatasetId,
    rowFields: ["region"],
    columnFields: ["channel"],
    statistics: [{ id: "s-1", field: "value", kind: "mean" }],
    includeRowTotals: true,
    includeColumnTotals: true,
    createdAt: "2026-09-15T00:00:00.000Z",
  };
}

function tabulateResult(value: number): TabulateResult {
  return {
    rowMembers: [["North"]],
    columnMembers: [["Online"]],
    statistics: [{ id: "s-1", field: "value", kind: "mean" }],
    cells: [value],
    rowTotals: [value],
    columnTotals: [value],
    grandTotals: [value],
    cellCount: 1,
    limit: 10000,
  };
}

const request: TabulateRequest = {
  datasetId: "ds-1",
  rowFields: ["region"],
  columnFields: ["channel"],
  statistics: [{ id: "s-1", field: "value", kind: "mean" }],
  includeRowTotals: true,
  includeColumnTotals: true,
  maxResultCells: 10000,
};

{
  const datasets = [dataset("ds-1", "Sales", 2)];
  const tabulates: TabulateItem[] = [];
  let dirty = false;
  let dirtyTransitions = 0;
  const history: string[] = [];

  const runtime = createApplicationRuntime({
    initialRevision: 10,
    project: {
      getProjectState: () => ({
        project: {
          name: "Task5",
          filePath: "/Users/ashton/projects/task5.spprj",
          createdAt: "2026-09-15T00:00:00.000Z",
        },
        dirty,
        readOnly: false,
        projectRevision: 10,
      }),
      listDatasets: () => datasets,
      listTableTransforms: () => [],
      listGraphs: () => [],
      listReports: () => [],
      listAnalyses: () => [],
      listTabulates: () => tabulates,
      getColumns: async () => [],
      getColumnDisplayProps: async () => [],
      getDatasetGeneration: async () => 2,
    },
    tabulate: {
      listTabulates: () => tabulates,
      listDatasets: () => datasets,
      listTabulateNamesForAllocation: () => tabulates.map((item) => item.name),
      createTabulateId: () => "tab-1",
      createNowIso: () => "2026-09-15T00:00:00.000Z",
      nextTabulateBaseName: () => "Tabulate 1",
      addTabulate: (item) => {
        tabulates.push(item);
      },
      markDirty: () => {
        if (!dirty) dirtyTransitions += 1;
        dirty = true;
      },
      recordAction: (entry) => {
        history.push(entry);
      },
      activateTabulate: () => {},
      runTabulate: async () => tabulateResult(1),
      getDatasetGeneration: async () => 2,
      setLatestResult: () => {},
      getLatestResult: () => null,
    },
  });

  const created = await runtime.execute(
    {
      type: "tabulate.create",
      input: { sourceDatasetId: "ds-1" },
      control: { expectedProjectRevision: 10 },
    },
    { kind: "ui" },
  );

  assert.equal(created.changed, true);
  assert.equal(created.projectRevision, 11);
  assert.equal(tabulates.length, 1);
  assert.equal(tabulates[0]?.name, "Tabulate 1");
  assert.deepEqual(tabulates[0]?.rowFields, []);
  assert.deepEqual(tabulates[0]?.columnFields, []);
  assert.deepEqual(tabulates[0]?.statistics, []);
  assert.equal(tabulates[0]?.includeRowTotals, true);
  assert.equal(tabulates[0]?.includeColumnTotals, true);
  assert.equal(dirtyTransitions, 1);
  assert.equal(history.length, 1);
}

{
  const datasets = [dataset("ds-1", "Sales", 3)];
  const tabulates = [tabulateItem("tab-1", "ds-1")];
  const cache = new Map<string, {
    requestFingerprint: string;
    sourceGeneration: number;
    result: TabulateResult;
    completedAt: string;
  }>();
  let runCalls = 0;
  const generationReadings = [3, 3, 4, 5];

  const runtime = createApplicationRuntime({
    initialRevision: 7,
    project: {
      getProjectState: () => ({
        project: {
          name: "Task5",
          filePath: "/Users/ashton/projects/task5.spprj",
          createdAt: "2026-09-15T00:00:00.000Z",
        },
        dirty: false,
        readOnly: false,
        projectRevision: 7,
      }),
      listDatasets: () => datasets,
      listTableTransforms: () => [],
      listGraphs: () => [],
      listReports: () => [],
      listAnalyses: () => [],
      listTabulates: () => tabulates,
      getColumns: async () => [],
      getColumnDisplayProps: async () => [],
      getDatasetGeneration: async () => datasets[0]?.generation ?? 1,
    },
    tabulate: {
      listTabulates: () => tabulates,
      listDatasets: () => datasets,
      listTabulateNamesForAllocation: () => tabulates.map((item) => item.name),
      createTabulateId: () => "tab-x",
      createNowIso: () => "2026-09-15T00:00:00.000Z",
      nextTabulateBaseName: () => "Tabulate 2",
      addTabulate: () => {},
      markDirty: () => {},
      recordAction: () => {},
      activateTabulate: () => {},
      runTabulate: async () => {
        runCalls += 1;
        return tabulateResult(runCalls);
      },
      getDatasetGeneration: async () => generationReadings.shift() ?? 5,
      setLatestResult: (tabulateId, latest) => {
        cache.set(tabulateId, latest);
      },
      getLatestResult: (tabulateId) => cache.get(tabulateId) ?? null,
    },
  });

  const firstRun = await runtime.execute(
    {
      type: "tabulate.run",
      input: {
        tabulateId: "tab-1",
        request,
      },
    },
    { kind: "ui" },
  );

  assert.equal(firstRun.changed, false);
  assert.equal(firstRun.projectRevision, 7);
  assert.equal(runCalls, 1);
  assert.equal(cache.get("tab-1")?.sourceGeneration, 3);

  await runtime.execute(
    {
      type: "tabulate.run",
      input: {
        tabulateId: "tab-1",
        request,
      },
    },
    { kind: "ui" },
  );

  assert.equal(runCalls, 2);
  assert.equal(cache.get("tab-1")?.sourceGeneration, 4, "cache must keep request start generation so source changes are stale");
}

{
  const datasets = [dataset("ds-1", "Sales", 8)];
  const tabulates = [tabulateItem("tab-1", "ds-1")];
  const cache = new Map<string, {
    requestFingerprint: string;
    sourceGeneration: number;
    result: TabulateResult;
    completedAt: string;
  }>();
  let runCalls = 0;
  let refreshCalls = 0;
  let dirtyTransitions = 0;
  let dirty = false;
  let activateDatasetCalls = 0;
  const history: string[] = [];

  const runtime = createApplicationRuntime({
    initialRevision: 20,
    project: {
      getProjectState: () => ({
        project: {
          name: "Task5",
          filePath: "/Users/ashton/projects/task5.spprj",
          createdAt: "2026-09-15T00:00:00.000Z",
        },
        dirty,
        readOnly: false,
        projectRevision: 20,
      }),
      listDatasets: () => datasets,
      listTableTransforms: () => [],
      listGraphs: () => [],
      listReports: () => [],
      listAnalyses: () => [],
      listTabulates: () => tabulates,
      getColumns: async (datasetId) => datasetId === "tbl-export"
        ? [["region", "VARCHAR"], ["Online - Mean - value", "DOUBLE"]]
        : [["region", "VARCHAR"], ["channel", "VARCHAR"], ["value", "DOUBLE"]],
      getColumnDisplayProps: async () => [],
      getDatasetGeneration: async (datasetId) => datasetId === "tbl-export" ? 1 : datasets[0]?.generation ?? 1,
    },
    table: {
      createManagedTable: async (managedRequest) => {
        assert.deepEqual(managedRequest.rows, [["North", 42]]);
        assert.equal(managedRequest.columns[0]?.name, "region");
        assert.equal(managedRequest.columns[0]?.columnType, "VARCHAR");
        assert.equal(managedRequest.columns[1]?.name.includes("Mean - value"), true);
        assert.equal(managedRequest.columns[1]?.columnType, "DOUBLE");
        return {
          dataset: dataset("tbl-export", managedRequest.name, 1),
          generation: 1,
          columns: managedRequest.columns.map((column, index) => ({
            colIndex: index,
            colName: column.name,
            colType: column.columnType.toUpperCase(),
            width: column.display?.width,
            format: column.display?.format,
            extras: column.display?.extras,
          })),
        };
      },
      refreshDatasets: async () => {
        refreshCalls += 1;
      },
      markDirty: () => {
        if (!dirty) dirtyTransitions += 1;
        dirty = true;
      },
      recordAction: (entry) => {
        history.push(entry);
      },
      activateDataset: () => {
        activateDatasetCalls += 1;
      },
      historyMessage: (name) => `Created table ${name}`,
    },
    tabulate: {
      listTabulates: () => tabulates,
      listDatasets: () => datasets,
      listTabulateNamesForAllocation: () => tabulates.map((item) => item.name),
      createTabulateId: () => "tab-x",
      createNowIso: () => "2026-09-15T00:00:00.000Z",
      nextTabulateBaseName: () => "Tabulate 2",
      addTabulate: () => {},
      markDirty: () => {},
      recordAction: () => {},
      activateTabulate: () => {},
      runTabulate: async () => {
        runCalls += 1;
        return {
          rowMembers: [["North"]],
          columnMembers: [["Online"]],
          statistics: [{ id: "s-1", field: "value", kind: "mean" }],
          cells: [42],
          rowTotals: [42],
          columnTotals: [42],
          grandTotals: [42],
          cellCount: 1,
          limit: 10000,
        } satisfies TabulateResult;
      },
      getDatasetGeneration: async () => datasets[0]?.generation ?? 1,
      setLatestResult: (tabulateId, latest) => {
        cache.set(tabulateId, latest);
      },
      getLatestResult: (tabulateId) => cache.get(tabulateId) ?? null,
    },
  });

  const staleFingerprint = JSON.stringify({ ...request, rowFields: ["region", "store"] });
  cache.set("tab-1", {
    requestFingerprint: staleFingerprint,
    sourceGeneration: 8,
    result: tabulateResult(11),
    completedAt: "2026-09-15T00:00:00.000Z",
  });

  const exported = await runtime.execute(
    {
      type: "tabulate.exportTable",
      input: {
        tabulateId: "tab-1",
        request,
        tableName: "Tabulate Export",
      },
      control: { expectedProjectRevision: 20 },
    },
    { kind: "ui" },
  );

  assert.equal(exported.changed, true);
  assert.equal(exported.projectRevision, 21);
  assert.equal(runCalls, 1, "stale or missing cache must trigger a canonical rerun before export");
  assert.equal(refreshCalls, 1, "export must use the canonical table post-create coordinator once");
  assert.equal(dirtyTransitions, 1, "export should dirty the project exactly once via table.create path");
  assert.equal(activateDatasetCalls, 1, "export should activate the created table once");
  assert.equal(history.length, 1, "export should record one table-create history entry");
  assert.equal(exported.data.outputTable?.dataset.id, "tbl-export");
}

console.log("application command tabulate lifecycle OK");
