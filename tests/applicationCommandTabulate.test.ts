import assert from "node:assert/strict";

import { createApplicationRuntime } from "@/applicationCommands/applicationRuntime";
import { createTabulateCommandHandlers, fingerprintTabulateRequest, type TabulateCommandDependencies } from "@/applicationCommands/tabulateCommands";
import test from "node:test";
import { CommandExecutionError } from "@/applicationCommands/runtime";
import type { DatasetMeta } from "@/types/data";
import type { TabulateItem, TabulateRequest, TabulateResult, TabulateSessionStatus } from "@/types/tabulate";

function deferred<T>() {
  let resolve: ((value: T | PromiseLike<T>) => void) | null = null;
  let reject: ((reason?: unknown) => void) | null = null;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return {
    promise,
    resolve: (value: T) => resolve?.(value),
    reject: (reason?: unknown) => reject?.(reason),
  };
}

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

const request: Omit<TabulateRequest, "maxResultCells"> = {
  datasetId: "ds-1",
  rowFields: ["region"],
  columnFields: ["channel"],
  statistics: [{ id: "s-1", field: "value", kind: "mean" }],
  includeRowTotals: true,
  includeColumnTotals: true,
};

function readySession(generation = 8): TabulateSessionStatus {
  return { sessionId: "session-1", fingerprint: "backend-fingerprint", sourceGeneration: generation,
    state: "ready", rowMemberCount: 100000, columnMemberCount: 100000, logicalCellCount: 10000000000,
    measuredMemberIndexBytes: 1000 };
}

await test("run returns a bounded session summary and releases its automation lease", async () => {
  const released: string[] = [];
  const handlers = createTabulateCommandHandlers({
    listTabulates: () => [tabulateItem("tab-1", "ds-1")],
    getDatasetGeneration: async () => 8,
    prepareSession: async (definition) => {
      assert.equal("maxResultCells" in definition, false);
      assert.equal(definition.sourceGeneration, 8);
      return readySession();
    },
    releaseSession: async (sessionId) => { released.push(sessionId); },
  });
  const result = await handlers.run({ tabulateId: "tab-1", request });
  assert.equal(result.data.session.sessionId, "session-1");
  assert.equal(result.data.session.state, "ready");
  assert.equal(result.data.session.fingerprint, "backend-fingerprint");
  assert.equal(result.data.sourceGeneration, 8);
  assert.equal(result.data.session.logicalCellCount, 10000000000);
  assert.equal(result.data.leaseReleased, true);
  assert.equal("result" in result.data, false);
  assert.equal(Object.values(result.data).some(Array.isArray), false);
  assert.equal(Object.values(result.data.session).some(Array.isArray), false);
  assert.deepEqual(released, ["session-1"]);
});

for (const stage of ["beforePrepare", "afterPrepare", "poll"] as const) {
  await test(`run cancellation at ${stage} releases only its acquired lease`, async () => {
    const controller = new AbortController();
    const released: string[] = [];
    let prepares = 0;
    const handlers = createTabulateCommandHandlers({
      listTabulates: () => [tabulateItem("tab-1", "ds-1")],
      getDatasetGeneration: async () => 8,
      prepareSession: async () => {
        prepares += 1;
        if (stage === "afterPrepare") controller.abort();
        return { ...readySession(), state: stage === "poll" ? "preparing" : "ready" };
      },
      getSessionStatus: async () => { controller.abort(); return readySession(); },
      releaseSession: async (id) => { released.push(id); },
    });
    if (stage === "beforePrepare") controller.abort();
    await assert.rejects(handlers.run({ tabulateId: "tab-1", request }, { signal: controller.signal }),
      (error: unknown) => error instanceof CommandExecutionError && error.code === "cancelled");
    assert.equal(prepares, stage === "beforePrepare" ? 0 : 1);
    assert.deepEqual(released, stage === "beforePrepare" ? [] : ["session-1"]);
  });
}

for (const state of ["failed", "cancelled"] as const) {
  await test(`run ${state} preparation releases its lease`, async () => {
    const released: string[] = [];
    const handlers = createTabulateCommandHandlers({
      listTabulates: () => [tabulateItem("tab-1", "ds-1")], getDatasetGeneration: async () => 8,
      prepareSession: async () => ({ ...readySession(), state, failureCode: `tabulate_${state}` }),
      releaseSession: async (id) => { released.push(id); },
    });
    await assert.rejects(handlers.run({ tabulateId: "tab-1", request }),
      (error: unknown) => error instanceof CommandExecutionError && error.code === (state === "cancelled" ? "cancelled" : "execution_failed"));
    assert.deepEqual(released, ["session-1"]);
  });
}

await test("run rejects changed polling identity and releases the original lease", async () => {
  const released: string[] = [];
  const handlers = createTabulateCommandHandlers({
    listTabulates: () => [tabulateItem("tab-1", "ds-1")], getDatasetGeneration: async () => 8,
    prepareSession: async () => ({ ...readySession(), state: "preparing" }),
    getSessionStatus: async () => ({ ...readySession(), sessionId: "other-session" }),
    releaseSession: async (id) => { released.push(id); },
  });
  await assert.rejects(handlers.run({ tabulateId: "tab-1", request }), /identity changed/);
  assert.deepEqual(released, ["session-1"]);
});

await test("run reports cleanup failure without claiming the lease was released", async () => {
  const handlers = createTabulateCommandHandlers({
    listTabulates: () => [tabulateItem("tab-1", "ds-1")], getDatasetGeneration: async () => 8,
    prepareSession: async () => readySession(),
    releaseSession: async () => { throw new Error("cleanup unavailable"); },
  });
  const result = await handlers.run({ tabulateId: "tab-1", request });
  assert.equal(result.data.leaseReleased, false);
  assert.equal(result.warnings[0]?.code, "tabulate_release_failed");
});

await test("export materializes metadata directly after commit and releases its lease", async () => {
  const events: string[] = [];
  const handlers = createTabulateCommandHandlers({
    listTabulates: () => [tabulateItem("tab-1", "ds-1")],
    listDatasets: () => [dataset("ds-1", "Sales", 8)],
    getDatasetGeneration: async () => 8,
    prepareSession: async (definition) => {
      assert.equal("maxResultCells" in definition, false);
      assert.equal(definition.sourceGeneration, 8);
      events.push("prepare");
      return readySession();
    },
    materializeTable: async (input) => {
      assert.deepEqual(events, ["prepare", "commit"]);
      assert.deepEqual(input, { sessionId: "session-1", sourceGeneration: 8, fingerprint: "backend-fingerprint",
        destinationName: "Summary", missingLabel: "Missing", statisticLabels: ["Mean"] });
      events.push("materialize");
      return dataset("output", "Summary", 0);
    },
    completeMaterializedTable: async (created) => {
      events.push("complete");
      return { result: { dataset: { ...created, sourceName: null }, generation: 0, columns: [] }, warnings: [] };
    },
    releaseSession: async (sessionId) => { assert.equal(sessionId, "session-1"); events.push("release"); },
  });
  const result = await handlers.exportTable({ tabulateId: "tab-1", request, tableName: "Summary", session: readySession() }, {
    beginCommit: () => events.push("commit"),
  });
  assert.equal(result.data.reran, false);
  assert.equal(result.data.requestFingerprint, "backend-fingerprint");
  assert.equal(result.data.sourceGeneration, 8);
  assert.equal(result.data.outputTable?.dataset.id, "output");
  assert.deepEqual(events, ["prepare", "commit", "materialize", "complete", "release"]);
});

await test("legacy run fingerprint includes statistic identity", () => {
  const requestA: TabulateRequest = {
    ...request,
    maxResultCells: 10000,
    statistics: [{ id: "s-1", field: "value", kind: "mean" }],
  };
  const requestB: TabulateRequest = {
    ...request,
    maxResultCells: 10000,
    statistics: [{ id: "s-2", field: "value", kind: "mean" }],
  };

  assert.notEqual(
    fingerprintTabulateRequest(requestA),
    fingerprintTabulateRequest(requestB),
    "fingerprint must include statistic.id to avoid collisions across distinct requests",
  );
});

await test("run cancellation after generation read releases its lease", async () => {
  const datasets = [dataset("ds-1", "Sales", 3)];
  const tabulates = [tabulateItem("tab-1", "ds-1")];
  const cache = new Map<string, {
    requestFingerprint: string;
    sourceGeneration: number;
    result: TabulateResult;
    completedAt: string;
  }>();
  let runCalls = 0;
  const released: string[] = [];
  const postRunGenerationGate = deferred<number>();
  const postRunGenerationReached = deferred<void>();
  let generationReads = 0;

  const runtime = createApplicationRuntime({
    initialRevision: 9,
    project: {
      getProjectState: () => ({
        project: {
          name: "Task5",
          filePath: "/Users/ashton/projects/task5.spprj",
          createdAt: "2026-09-15T00:00:00.000Z",
        },
        dirty: false,
        readOnly: false,
        projectRevision: 9,
      }),
      listDatasets: () => datasets,
      listTableTransforms: () => [],
      listGraphs: () => [],
      listReports: () => [],
      listAnalyses: () => [],
      listTabulates: () => tabulates,
      getColumns: async () => [],
      getColumnDisplayProps: async () => [],
      getDatasetGeneration: async () => 3,
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
      isProjectReadOnly: () => false,
      prepareSession: async () => {
        runCalls += 1;
        return readySession(3);
      },
      releaseSession: async (id) => { released.push(id); },
      getDatasetGeneration: async () => {
        generationReads += 1;
        if (generationReads === 1) {
          return 3;
        }
        postRunGenerationReached.resolve(undefined);
        return postRunGenerationGate.promise;
      },
    },
  });

  const controller = new AbortController();
  const running = runtime.execute(
    {
      type: "tabulate.run",
      input: {
        tabulateId: "tab-1",
        request,
      },
    },
    { kind: "ui" },
    { signal: controller.signal },
  );

  await postRunGenerationReached.promise;
  controller.abort();
  postRunGenerationGate.resolve(3);

  await assert.rejects(
    running,
    (error: unknown) => error instanceof CommandExecutionError && error.code === "cancelled",
  );

  assert.equal(runCalls, 1);
  assert.deepEqual(released, ["session-1"]);
  assert.equal(cache.size, 0, "cancellation after run must leave latest runtime cache unchanged");
});

await test("export rejects changing source before commit and leaves revision unchanged", async () => {
  const datasets = [dataset("ds-1", "Sales", 8)];
  const tabulates = [tabulateItem("tab-1", "ds-1")];
  const cache = new Map<string, {
    requestFingerprint: string;
    sourceGeneration: number;
    result: TabulateResult;
    completedAt: string;
  }>();
  let runCalls = 0;
  let createTableCalls = 0;
  let beginCommitCalls = 0;
  const generations = [8, 9];

  const runtime = createApplicationRuntime({
    initialRevision: 30,
    project: {
      getProjectState: () => ({
        project: {
          name: "Task5",
          filePath: "/Users/ashton/projects/task5.spprj",
          createdAt: "2026-09-15T00:00:00.000Z",
        },
        dirty: false,
        readOnly: false,
        projectRevision: 30,
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
      prepareSession: async () => {
        runCalls += 1;
        return readySession();
      },
      releaseSession: async () => {},
      getDatasetGeneration: async () => generations.shift() ?? 9,
      materializeTable: async () => {
        createTableCalls += 1;
        beginCommitCalls += 1;
        throw new Error("materializeTable should not be called when the session is stale");
      },
    },
  });

  await assert.rejects(
    runtime.execute(
      {
        type: "tabulate.exportTable",
        input: {
          tabulateId: "tab-1",
          request,
          tableName: "Tabulate Export",
        },
        control: { expectedProjectRevision: 30 },
      },
      { kind: "ui" },
    ),
    (error: unknown) => {
      if (!(error instanceof CommandExecutionError)) {
        return false;
      }
      assert.equal(error.code, "execution_failed");
      assert.equal(error.retryable, true);
      assert.match(error.message, /source table changed during tabulate rerun/i);
      return true;
    },
  );

  assert.equal(runCalls, 1, "stale or missing cache must trigger rerun before export");
  assert.equal(createTableCalls, 0, "stale rerun result must reject before table.create");
  assert.equal(beginCommitCalls, 0, "stale rerun result must reject before beginCommit");
  assert.equal(cache.size, 0, "export must not retain a full-result cache");

  const postRejectInspect = await runtime.execute(
    {
      type: "project.inspect",
      input: {},
    },
    { kind: "ui" },
  );

  assert.equal(postRejectInspect.projectRevision, 30, "stale rerun rejection must not advance runtime revision");
  assert.equal(postRejectInspect.data.projectRevision, 30, "project state revision must remain unchanged after rejection");
});

await test("create retains dirty history and revision semantics", async () => {
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
      getDatasetGeneration: async () => 2,
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
});

await test("run retains its generation fence and source-change warnings", async () => {
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
      prepareSession: async (definition) => {
        runCalls += 1;
        return readySession(definition.sourceGeneration);
      },
      releaseSession: async () => {},
      getDatasetGeneration: async () => generationReadings.shift() ?? 5,
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
  assert.equal(firstRun.data.session.sourceGeneration, 3);
  assert.equal(firstRun.data.cacheValid, true);

  const changedRun = await runtime.execute(
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
  assert.equal(changedRun.data.session.sourceGeneration, 4);
  assert.equal(changedRun.data.cacheValid, false);
  assert.equal(changedRun.warnings[0]?.code, "tabulate_run_source_changed");
  assert.equal(cache.size, 0);
});

await test("export retains canonical table coordinator and sqlType contract", async () => {
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
        assert.equal(managedRequest.columns[0]?.sqlType, "VARCHAR");
        assert.equal(managedRequest.columns[1]?.name.includes("Mean - value"), true);
        assert.equal(managedRequest.columns[1]?.sqlType, "DOUBLE");
        return {
          dataset: dataset("tbl-export", managedRequest.name, 1),
          generation: 1,
          columns: managedRequest.columns.map((column, index) => ({
            colIndex: index,
            colName: column.name,
            colType: column.sqlType.toUpperCase(),
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
      prepareSession: async () => { runCalls += 1; return readySession(); },
      releaseSession: async () => {},
      materializeTable: async (input) => {
        assert.equal(input.fingerprint, "backend-fingerprint");
        const created = dataset("tbl-export", input.destinationName, 1);
        datasets.push(created);
        return created;
      },
      getDatasetGeneration: async () => datasets[0]?.generation ?? 1,
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
  assert.equal(exported.data.reran, true);
  const canonical = await runtime.execute({ type: "table.create", input: { request: {
    name: "Canonical fixture", columns: [{ name: "region", sqlType: "VARCHAR" }, { name: "Online - Mean - value", sqlType: "DOUBLE" }],
    rows: [["North", 42]],
  } } }, { kind: "ui" });
  assert.equal(canonical.data.columns[1]?.colType, "DOUBLE");
});

for (const stage of ["beforePrepare", "afterPrepare", "poll", "generation"] as const) {
  await test(`export cancellation at ${stage} never begins commit or materializes`, async () => {
    const controller = new AbortController();
    const events: string[] = [];
    let reads = 0;
    const handlers = createTabulateCommandHandlers({
      listTabulates: () => [tabulateItem("tab-1", "ds-1")],
      getDatasetGeneration: async () => { if (++reads === 2 && stage === "generation") controller.abort(); return 8; },
      prepareSession: async () => {
        events.push("prepare");
        if (stage === "afterPrepare") controller.abort();
        return { ...readySession(), state: stage === "poll" ? "preparing" : "ready" };
      },
      getSessionStatus: async () => { controller.abort(); return readySession(); },
      releaseSession: async () => { events.push("release"); },
      materializeTable: async () => { throw new Error("must not materialize"); },
    });
    if (stage === "beforePrepare") controller.abort();
    await assert.rejects(handlers.exportTable({ tabulateId: "tab-1", request, tableName: "Summary" }, {
      signal: controller.signal, beginCommit: () => events.push("commit"),
    }), (error: unknown) => error instanceof CommandExecutionError && error.code === "cancelled");
    assert.deepEqual(events, stage === "beforePrepare" ? [] : ["prepare", "release"]);
  });
}

await test("export rejects invalid names before session preparation", async () => {
  const handlers = createTabulateCommandHandlers({
    prepareSession: async () => { throw new Error("must not prepare"); },
  });
  for (const tableName of ["", "CON.txt", "../escape", "trailing.", "bad\u0000name"]) {
    await assert.rejects(handlers.exportTable({ tabulateId: "tab-1", request, tableName }),
      (error: unknown) => error instanceof CommandExecutionError && error.code === "invalid_input");
  }
});

await test("export failed preparation releases its lease without mutation", async () => {
  let releases = 0;
  const handlers = createTabulateCommandHandlers({
    listTabulates: () => [tabulateItem("tab-1", "ds-1")], getDatasetGeneration: async () => 8,
    prepareSession: async () => ({ ...readySession(), state: "failed", failureCode: "tabulate_member_index_budget" }),
    releaseSession: async () => { releases += 1; },
    materializeTable: async () => { throw new Error("must not materialize"); },
  });
  await assert.rejects(handlers.exportTable({ tabulateId: "tab-1", request, tableName: "Summary" }, {
    beginCommit: () => { throw new Error("must not commit"); },
  }), /tabulate_member_index_budget/);
  assert.equal(releases, 1);
});

await test("export preserves committed result and warnings when refresh or cleanup fail", async () => {
  const events: string[] = [];
  const controller = new AbortController();
  const source = dataset("ds-1", "Source", 8);
  const output = dataset("output", "Summary", 0);
  const tabulate: Partial<TabulateCommandDependencies> = {
    listTabulates: () => [tabulateItem("tab-1", "ds-1")], getDatasetGeneration: async () => 8,
    prepareSession: async () => readySession(),
    materializeTable: async () => { events.push("materialize"); controller.abort(); return output; },
    releaseSession: async () => { events.push("release"); throw new Error("release unavailable"); },
  };
  const runtime = createApplicationRuntime({
    project: {
      getProjectState: () => ({ project: null, dirty: false, readOnly: false, projectRevision: 0 }),
      listDatasets: () => [source], getColumns: async () => [["Mean", "DOUBLE"]],
      getColumnDisplayProps: async () => [], getDatasetGeneration: async () => 0,
    },
    table: {
      refreshDatasets: async () => { events.push("refresh"); throw new Error("refresh unavailable"); },
      markDirty: () => { events.push("dirty"); }, activateDataset: () => { events.push("activate"); },
      recordAction: () => { events.push("history"); }, historyMessage: () => "Created Summary",
    }, tabulate,
  });
  const exported = await runtime.execute({ type: "tabulate.exportTable", input: {
    tabulateId: "tab-1", request, tableName: "Summary", session: { ...readySession(), sourceGeneration: 7 },
  } }, { kind: "ui" }, { signal: controller.signal });
  assert.equal(exported.changed, true);
  assert.equal(exported.data.reran, true);
  assert.equal(exported.data.outputTable?.dataset.id, "output");
  assert.deepEqual(exported.warnings.map((warning) => warning.code), [
    "table_create_refresh_failed",
    "table_create_describe_failed",
    "tabulate_release_failed",
  ]);
  assert.deepEqual(events, ["materialize", "refresh", "dirty", "activate", "history", "release"]);
});

await test("read-only project rejects export before backend preparation", async () => {
  let prepares = 0;
  const runtime = createApplicationRuntime({
    project: {
      getProjectState: () => ({ project: null, dirty: false, readOnly: true, projectRevision: 0 }),
      listDatasets: () => [dataset("ds-1", "Source", 8)],
    },
    tabulate: {
      listTabulates: () => [tabulateItem("tab-1", "ds-1")],
      prepareSession: async () => { prepares += 1; return readySession(); },
    },
  });
  await assert.rejects(runtime.execute({ type: "tabulate.exportTable", input: {
    tabulateId: "tab-1", request, tableName: "Summary",
  } }, { kind: "ui" }), (error: unknown) => (
    error instanceof CommandExecutionError && error.code === "read_only"
  ));
  assert.equal(prepares, 0);
});

console.log("application command tabulate lifecycle OK");
