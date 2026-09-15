import assert from "node:assert/strict";

import { createApplicationRuntime } from "@/applicationCommands/applicationRuntime";
import { CommandExecutionError } from "@/applicationCommands/runtime";
import type { DatasetMeta } from "@/types/data";

function dataset(id: string, name: string, generation: number): DatasetMeta {
  return {
    id,
    name,
    sourcePath: null,
    sourceType: "manual",
    rowCount: 2,
    colCount: 2,
    generation,
    createdAt: "2026-09-15T00:00:00.000Z",
    updatedAt: "2026-09-15T00:00:00.000Z",
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function assertNoPathLeak(value: string): void {
  assert.equal(value.includes("/Users/"), false);
  assert.equal(value.includes("/etc/"), false);
  assert.equal(value.includes("C:\\\\"), false);
  assert.equal(value.includes("\\\\\\\\"), false);
}

{
  let preflightCalls = 0;
  let createCalls = 0;
  let refreshCalls = 0;
  let dirtyCalls = 0;
  let selectionCalls = 0;
  let historyCalls = 0;
  const preflightGate = deferred<void>();
  const preflightStarted = deferred<void>();
  let revision = 40;

  const runtime = createApplicationRuntime({
    initialRevision: 40,
    revision: {
      get: () => revision,
      set: (next) => {
        revision = next;
      },
    },
    project: {
      getProjectState: () => ({
        project: {
          name: "Task4",
          filePath: "/Users/ashton/projects/task4.spprj",
          createdAt: "2026-09-15T00:00:00.000Z",
        },
        dirty: false,
        readOnly: false,
        projectRevision: revision,
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
    sql: {
      preflightCreateTableFromSqlQuery: async () => {
        preflightCalls += 1;
        preflightStarted.resolve();
        await preflightGate.promise;
      },
      createTableFromSqlQuery: async () => {
        createCalls += 1;
        return dataset("tbl-unused", "unused", 1);
      },
      refreshDatasets: async () => {
        refreshCalls += 1;
      },
      markDirty: () => {
        dirtyCalls += 1;
      },
      recordAction: () => {
        historyCalls += 1;
      },
      activateDataset: () => {
        selectionCalls += 1;
      },
      historyMessage: () => "history",
    },
  });

  const abortController = new AbortController();
  const pending = runtime.execute(
    {
      type: "sql.createTable",
      input: {
        sql: "SELECT 1 AS value",
        name: "Cancelled",
      },
      control: { expectedProjectRevision: 40 },
    },
    { kind: "ui" },
    { signal: abortController.signal },
  );

  await preflightStarted.promise;
  abortController.abort();
  preflightGate.resolve();

  await assert.rejects(
    pending,
    (error) => error instanceof CommandExecutionError && error.code === "cancelled",
  );
  assert.equal(preflightCalls, 1);
  assert.equal(createCalls, 0);
  assert.equal(refreshCalls, 0);
  assert.equal(dirtyCalls, 0);
  assert.equal(selectionCalls, 0);
  assert.equal(historyCalls, 0);
  assert.equal(revision, 40);
}

{
  const datasets: DatasetMeta[] = [dataset("tbl-source", "Sales", 1)];
  const events: string[] = [];
  let runtime!: ReturnType<typeof createApplicationRuntime>;
  let createCalls = 0;
  let refreshCalls = 0;
  let dirtyTransitions = 0;
  let dirty = false;
  let selectionCalls = 0;
  const history: string[] = [];

  runtime = createApplicationRuntime({
    initialRevision: 4,
    project: {
      getProjectState: () => ({
        project: {
          name: "Task4",
          filePath: "/Users/ashton/projects/task4.spprj",
          createdAt: "2026-09-15T00:00:00.000Z",
        },
        dirty,
        readOnly: false,
        projectRevision: 4,
      }),
      listDatasets: () => datasets,
      listTableTransforms: () => [],
      listGraphs: () => [],
      listReports: () => [],
      listAnalyses: () => [],
      listTabulates: () => [],
      getColumns: async (datasetId) => datasetId === "tbl-sql" ? [["revenue", "DOUBLE"], ["region", "VARCHAR"]] : [["id", "BIGINT"]],
      getColumnDisplayProps: async () => [{
        colIndex: 0,
        width: 144,
        format: { kind: "numeric", decimals: 2 },
        extras: { unit: { symbol: "$" } },
      }],
      getDatasetGeneration: async (datasetId) => datasetId === "tbl-sql" ? 8 : 1,
    },
    sql: {
      preflightCreateTableFromSqlQuery: async () => {
        events.push("preflight");
      },
      createTableFromSqlQuery: async (sql, name) => {
        events.push(`mutation:${runtime.snapshot()[0]?.status ?? "unknown"}`);
        createCalls += 1;
        assert.equal(sql, "SELECT revenue, region FROM Sales");
        assert.equal(name, "Revenue By Region");
        const out = dataset("tbl-sql", "Revenue By Region", 8);
        datasets.splice(0, datasets.length, dataset("tbl-source", "Sales", 1), out);
        return out;
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
        selectionCalls += 1;
      },
      historyMessage: (name) => `Create table \"${name}\" from SQL query`,
    },
  });

  const result = await runtime.execute(
    {
      type: "sql.createTable",
      input: {
        sql: "SELECT revenue, region FROM Sales",
        name: "Revenue By Region",
      },
      control: { expectedProjectRevision: 4 },
    },
    { kind: "ui" },
  );

  assert.equal(createCalls, 1);
  assert.equal(refreshCalls, 1);
  assert.equal(dirtyTransitions, 1);
  assert.equal(selectionCalls, 1);
  assert.equal(history.length, 1);
  assert.deepEqual(events, ["preflight", "mutation:committing"]);
  assert.equal(result.projectRevision, 5);
  assert.equal(result.data.datasetId, "tbl-sql");
  assert.equal(result.data.datasetName, "Revenue By Region");
  assert.equal(result.data.outputTable?.dataset.id, "tbl-sql");
  assert.equal(result.data.outputTable?.generation, 8);
  assert.deepEqual(result.data.outputTable?.columns[0], {
    colIndex: 0,
    colName: "revenue",
    colType: "DOUBLE",
    width: 144,
    format: { kind: "numeric", decimals: 2 },
    extras: { unit: { symbol: "$" } },
  });
}

{
  let createCalls = 0;
  let preflightCalls = 0;
  let refreshCalls = 0;
  let dirtyCalls = 0;
  let selectionCalls = 0;
  let historyCalls = 0;

  let revision = 9;
  const runtime = createApplicationRuntime({
    initialRevision: 9,
    revision: {
      get: () => revision,
      set: (next) => {
        revision = next;
      },
    },
    project: {
      getProjectState: () => ({
        project: {
          name: "Task4",
          filePath: "/Users/ashton/projects/task4.spprj",
          createdAt: "2026-09-15T00:00:00.000Z",
        },
        dirty: false,
        readOnly: false,
        projectRevision: revision,
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
    sql: {
      preflightCreateTableFromSqlQuery: async () => {
        preflightCalls += 1;
        throw new Error("Invalid parameter: Only a single managed-table SELECT statement is allowed");
      },
      createTableFromSqlQuery: async () => {
        createCalls += 1;
        throw new Error("Only a single managed-table SELECT statement is allowed");
      },
      refreshDatasets: async () => {
        refreshCalls += 1;
      },
      markDirty: () => {
        dirtyCalls += 1;
      },
      recordAction: () => {
        historyCalls += 1;
      },
      activateDataset: () => {
        selectionCalls += 1;
      },
      historyMessage: () => "history",
    } as any,
  });

  await assert.rejects(
    runtime.execute(
      {
        type: "sql.createTable",
        input: {
          sql: "SELECT 1; SELECT 2",
          name: "Bad",
        },
      },
      { kind: "ui" },
    ),
    (error) => error instanceof CommandExecutionError
      && error.code === "invalid_input"
      && error.message.includes("single managed-table SELECT"),
  );

  assert.equal(preflightCalls, 1);
  assert.equal(createCalls, 0);
  assert.equal(refreshCalls, 0);
  assert.equal(dirtyCalls, 0);
  assert.equal(selectionCalls, 0);
  assert.equal(historyCalls, 0);
  assert.equal(revision, 9);
}

{
  let createCalls = 0;

  const runtime = createApplicationRuntime({
    initialRevision: 2,
    project: {
      getProjectState: () => ({
        project: {
          name: "Task4",
          filePath: "/Users/ashton/projects/task4.spprj",
          createdAt: "2026-09-15T00:00:00.000Z",
        },
        dirty: false,
        readOnly: false,
        projectRevision: 2,
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
    sql: {
      preflightCreateTableFromSqlQuery: async () => {},
      createTableFromSqlQuery: async () => {
        createCalls += 1;
        throw new Error("Database error: disk I/O failed at /Users/ashton/private.db");
      },
      refreshDatasets: async () => {},
      markDirty: () => {},
      recordAction: () => {},
      activateDataset: () => {},
      historyMessage: () => "history",
    },
  });

  await assert.rejects(
    runtime.execute(
      {
        type: "sql.createTable",
        input: {
          sql: "SELECT 1 AS value",
          name: "Bad Infra",
        },
      },
      { kind: "ui" },
    ),
    (error) => error instanceof CommandExecutionError
      && error.code === "execution_failed"
      && error.message === "Command service failed",
  );

  assert.equal(createCalls, 1);
}

{
  let preflightCalls = 0;
  let createCalls = 0;

  const runtime = createApplicationRuntime({
    initialRevision: 2,
    project: {
      getProjectState: () => ({
        project: {
          name: "Task4",
          filePath: "/Users/ashton/projects/task4.spprj",
          createdAt: "2026-09-15T00:00:00.000Z",
        },
        dirty: false,
        readOnly: false,
        projectRevision: 2,
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
    sql: {
      preflightCreateTableFromSqlQuery: async () => {
        preflightCalls += 1;
        throw new Error("Database error: lock wait timeout at /etc/secret.db");
      },
      createTableFromSqlQuery: async () => {
        createCalls += 1;
        return dataset("unused", "unused", 1);
      },
      refreshDatasets: async () => {},
      markDirty: () => {},
      recordAction: () => {},
      activateDataset: () => {},
      historyMessage: () => "history",
    },
  });

  await assert.rejects(
    runtime.execute(
      {
        type: "sql.createTable",
        input: {
          sql: "SELECT 1 AS value",
          name: "Infra Preflight",
        },
      },
      { kind: "ui" },
    ),
    (error) => error instanceof CommandExecutionError
      && error.code === "execution_failed"
      && error.message === "Command service failed",
  );

  assert.equal(preflightCalls, 1);
  assert.equal(createCalls, 0);
}

{
  const pathPayloads = [
    "/Users/ashton/private/data.db",
    "/etc/passwd",
    "C:\\Users\\ashton\\secret.db",
    "\\\\server\\share\\secrets.db",
  ];

  for (const payload of pathPayloads) {
    const runtime = createApplicationRuntime({
      initialRevision: 7,
      project: {
        getProjectState: () => ({
          project: {
            name: "Task4",
            filePath: "/Users/ashton/projects/task4.spprj",
            createdAt: "2026-09-15T00:00:00.000Z",
          },
          dirty: false,
          readOnly: false,
          projectRevision: 7,
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
      sql: {
        preflightCreateTableFromSqlQuery: async () => {
          throw new Error(`Database error: denied ${payload}`);
        },
        createTableFromSqlQuery: async () => dataset("unused", "unused", 1),
        refreshDatasets: async () => {},
        markDirty: () => {},
        recordAction: () => {},
        activateDataset: () => {},
        historyMessage: () => "history",
      },
    });

    await assert.rejects(
      runtime.execute(
        {
          type: "sql.createTable",
          input: {
            sql: "SELECT 1 AS value",
            name: "No Leak",
          },
        },
        { kind: "ui" },
      ),
      (error) => {
        if (!(error instanceof CommandExecutionError)) return false;
        assert.equal(error.code, "execution_failed");
        assert.equal(error.message, "Command service failed");
        assertNoPathLeak(error.message);
        return true;
      },
    );
  }
}

{
  const datasets: DatasetMeta[] = [dataset("tbl-source", "Sales", 1)];
  let sqlArg = "";

  const runtime = createApplicationRuntime({
    initialRevision: 15,
    project: {
      getProjectState: () => ({
        project: {
          name: "Task4",
          filePath: "/Users/ashton/projects/task4.spprj",
          createdAt: "2026-09-15T00:00:00.000Z",
        },
        dirty: true,
        readOnly: false,
        projectRevision: 15,
      }),
      listDatasets: () => datasets,
      listTableTransforms: () => [],
      listGraphs: () => [],
      listReports: () => [],
      listAnalyses: () => [],
      listTabulates: () => [],
      getColumns: async () => [["x", "DOUBLE"]],
      getColumnDisplayProps: async () => [],
      getDatasetGeneration: async () => 16,
    },
    sql: {
      preflightCreateTableFromSqlQuery: async () => {},
      createTableFromSqlQuery: async (sql, name) => {
        sqlArg = sql;
        const created = dataset("tbl-sql-2", name, 16);
        datasets.splice(0, datasets.length, dataset("tbl-source", "Sales", 1), created);
        return created;
      },
      refreshDatasets: async () => {},
      markDirty: () => {},
      recordAction: () => {},
      activateDataset: () => {},
      historyMessage: () => "history",
    },
  });

  const result = await runtime.execute(
    {
      type: "sql.createTable",
      input: {
        sql: "SELECT 1 AS x",
        name: "No Preview Accepted",
        previewRows: [["fake"]],
      } as never,
    },
    { kind: "ui" },
  );

  assert.equal(sqlArg, "SELECT 1 AS x");
  assert.equal(result.data.datasetId, "tbl-sql-2");
  assert.equal(result.data.outputTable?.preview, undefined);
}

console.log("application command sql tests passed");
