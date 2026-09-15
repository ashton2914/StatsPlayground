import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createApplicationRuntime } from "@/applicationCommands/applicationRuntime";
import { CommandExecutionError } from "@/applicationCommands/runtime";
import { waitForWorkspaceCommandConfirmation } from "@/components/workspaceCommandHandlers";

const TEST_FILE_DIR = dirname(fileURLToPath(import.meta.url));
const NOW = "2026-09-15T18:00:00.000Z";

function readSource(relativePath: string): string {
  return readFileSync(resolve(TEST_FILE_DIR, relativePath), "utf8").replace(/\r\n/g, "\n");
}

function sourceBetween(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `Missing source boundary: ${start}`);
  assert.notEqual(endIndex, -1, `Missing source boundary: ${end}`);
  return source.slice(startIndex, endIndex);
}

function assertSourceIncludes(source: string, needle: string, message: string): void {
  assert.equal(source.includes(needle), true, message);
}

function assertSourceExcludes(source: string, needle: string, message: string): void {
  assert.equal(source.includes(needle), false, message);
}

const applicationRuntimeSource = readSource("../src/applicationCommands/applicationRuntime.ts");
const policySource = readSource("../src/applicationCommands/policy.ts");
const workspaceSource = readSource("../src/components/Workspace.tsx");

assertSourceIncludes(applicationRuntimeSource, '"project.save"', "Application runtime must register the shared project.save command");
assertSourceIncludes(applicationRuntimeSource, '"snapshot.create"', "Application runtime must register the shared snapshot.create command");
assertSourceIncludes(applicationRuntimeSource, '"table.exportCsv"', "Application runtime must register the shared table.exportCsv command");

assertSourceIncludes(policySource, "requireConfirmation", "Command policy must classify commands that require confirmation");
assertSourceIncludes(policySource, "requestId", "Confirmation policy must be keyed by runtime requestId rather than command input");

function assertSourceIncludesAny(source: string, needles: string[], message: string): void {
  assert.equal(needles.some((needle) => source.includes(needle)), true, message);
}

const handleSaveSource = sourceBetween(
  workspaceSource,
  "const handleSave = async () => {",
  "handleSaveRef.current = handleSave;",
);
assertSourceIncludesAny(handleSaveSource, [
  'type: "project.save"',
  '}).saveProject();',
], "Workspace save must stay wired to the shared project.save command path");
assertSourceExcludes(handleSaveSource, "await applicationRuntime.flushPendingEffects();", "Workspace save must stop compensating for shared runtime effect draining");
assertSourceExcludes(handleSaveSource, "buildSaveProjectRequest(", "Workspace save must stop building caller-supplied save payloads");
assertSourceExcludes(handleSaveSource, "request:", "Workspace save must stop passing a caller-built request into project.save");

const handleExportTablesSource = sourceBetween(
  workspaceSource,
  "const handleExportTables = async (plan: TableExportPlan) => {",
  "  // ---- Folder mutation helpers wired to the side-panel UI ----------------",
);
assertSourceIncludesAny(handleExportTablesSource, [
  'type: "table.exportCsv"',
  '}).exportCsv(plan, outputPath);',
], "Single-file CSV export must execute the shared table.exportCsv command path");
assertSourceExcludes(handleExportTablesSource, "await ioService.exportCsv(", "Workspace CSV export must stop calling ioService.exportCsv directly");

const handleCreateSnapshotSource = sourceBetween(
  workspaceSource,
  "const handleCreateSnapshot = async () => {",
  "const handleSnapshotContextMenu =",
);
assertSourceIncludesAny(handleCreateSnapshotSource, [
  'type: "snapshot.create"',
  '}).createSnapshot();',
], "Workspace snapshot creation must execute the shared snapshot.create command path");
assertSourceExcludes(handleCreateSnapshotSource, "await createSnapshot()", "Workspace snapshot creation must stop bypassing the shared command layer");

function baseProjectDependencies(filePath: string | null) {
  return {
    getProjectState: () => ({
      project: {
        name: "Task8",
        filePath,
        createdAt: NOW,
      },
      dirty: true,
      readOnly: false,
      projectRevision: 3,
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
  };
}

async function waitForInspectionResolver(
  inspectionResolvers: Array<(value: { targetExists: boolean }) => void>,
): Promise<(value: { targetExists: boolean }) => void> {
  while (inspectionResolvers.length === 0) {
    await Promise.resolve();
  }
  return inspectionResolvers.shift()!;
}

{
  const callOrder: string[] = [];
  const builtRequest = { token: "save-request" };
  const staleRequest = { token: "stale-request" };
  let capturedRequest: unknown = null;
  let capturedFilePath: string | undefined;

  const runtime = createApplicationRuntime({
    initialRevision: 3,
    project: {
      ...baseProjectDependencies("/Users/ashton/private/task8.spprj"),
      flushPendingHistory: async () => {
        callOrder.push("flush");
      },
      buildSaveProjectRequest: (filePath) => {
        callOrder.push("build");
        capturedFilePath = filePath;
        return builtRequest;
      },
      saveProjectCommand: async (request: unknown) => {
        callOrder.push("save");
        capturedRequest = request;
        return {
          name: "Task8",
          createdAt: NOW,
          fileName: "task8.spprj",
          hasProjectPath: true,
        };
      },
    },
  } as never);

  const result = await (runtime as never as {
    execute: (command: unknown, actor: { kind: "ui" }) => Promise<{
      projectRevision: number;
      data: Record<string, unknown>;
    }>;
  }).execute(
    {
      type: "project.save",
      input: {
        filePath: "/Users/ashton/private/task8.spprj",
        request: staleRequest as never,
      },
      control: { expectedProjectRevision: 3 },
    },
    { kind: "ui" },
  );

  assert.deepEqual(callOrder, ["flush", "build", "save"]);
  assert.equal(capturedRequest, builtRequest);
  assert.equal(capturedFilePath, "/Users/ashton/private/task8.spprj");
  assert.equal(result.projectRevision, 4);
  assert.equal("filePath" in result.data, false);
}

{
  const runtime = createApplicationRuntime({
    initialRevision: 3,
    project: {
      ...baseProjectDependencies(null),
    },
  } as never);

  await assert.rejects(
    (runtime as never as {
      execute: (command: unknown, actor: { kind: "ui" }) => Promise<unknown>;
    }).execute(
      {
        type: "project.save",
        input: {},
        control: { expectedProjectRevision: 3 },
      },
      { kind: "ui" },
    ),
    (error: unknown) => error instanceof CommandExecutionError && error.code === "project_path_required",
  );
}

{
  let snapshotCalls = 0;
  const runtime = createApplicationRuntime({
    io: {
      createSnapshot: async () => {
        snapshotCalls += 1;
        return { id: "snapshot-1" };
      },
    },
  } as never);

  const result = await (runtime as never as {
    execute: (command: unknown, actor: { kind: "ui" }) => Promise<{
      changed: boolean;
      projectRevision: number;
    }>;
  }).execute(
    {
      type: "snapshot.create",
      input: {},
    },
    { kind: "ui" },
  );

  assert.equal(snapshotCalls, 1);
  assert.equal(result.changed, true);
  assert.equal(result.projectRevision, 1);
}

{
  const calls: Array<{ datasetId: string; rootId: string; relativePath: string }> = [];
  const inspectionResolvers: Array<(value: { targetExists: boolean }) => void> = [];
  let exportCalls = 0;
  const runtime = createApplicationRuntime({
    io: {
      inspectCsvTarget: async () => new Promise<{ targetExists: boolean }>((resolve) => {
        inspectionResolvers.push(resolve);
      }),
      exportCsv: async (datasetId: string, rootId: string, relativePath: string) => {
        exportCalls += 1;
        calls.push({ datasetId, rootId, relativePath });
      },
    },
  } as never);

  const command = (runtime as never as {
    execute: (command: unknown, actor: { kind: "ui" }) => Promise<{
      changed: boolean;
      projectRevision: number;
    }>;
    snapshot: () => Array<{ requestId: string; command: string; status: string }>;
  }).execute(
    {
      type: "table.exportCsv",
      input: {
        datasetId: "table-1",
        rootId: "root-1",
        relativePath: "exports/table-1.csv",
      },
      control: { expectedProjectRevision: 0 },
    },
    { kind: "ui" },
  );

  const pending = (runtime as never as {
    snapshot: () => Array<{ requestId: string; command: string; status: string }>;
  }).snapshot().find((entry) => entry.command === "table.exportCsv");
  assert.equal(pending?.status, "queued", "Async target inspection alone must not surface awaiting-confirmation");

  (await waitForInspectionResolver(inspectionResolvers))({ targetExists: false });
  (await waitForInspectionResolver(inspectionResolvers))({ targetExists: false });
  const result = await command;

  assert.deepEqual(calls, [{
    datasetId: "table-1",
    rootId: "root-1",
    relativePath: "exports/table-1.csv",
  }]);
  assert.equal(exportCalls, 1);
  assert.equal(result.changed, false);
  assert.equal(result.projectRevision, 0);
}

{
  let inspectionCount = 0;
  let exportCalls = 0;
  const runtime = createApplicationRuntime({
    io: {
      inspectCsvTarget: async () => {
        inspectionCount += 1;
        return { targetExists: inspectionCount >= 2 };
      },
      exportCsv: async () => {
        exportCalls += 1;
      },
    },
  } as never);

  await assert.rejects(
    (runtime as never as {
      execute: (command: unknown, actor: { kind: "ui" }) => Promise<unknown>;
    }).execute(
      {
        type: "table.exportCsv",
        input: {
          datasetId: "table-1",
          rootId: "root-1",
          relativePath: "exports/table-1.csv",
        },
        control: { expectedProjectRevision: 0 },
      },
      { kind: "ui" },
    ),
    (error: unknown) => error instanceof CommandExecutionError && error.code === "confirmation_required",
  );

  assert.equal(exportCalls, 0, "CSV export must not overwrite after a false->true target race without request-bound confirmation");
}

{
  const waitForCommandConfirmationSource = sourceBetween(
    workspaceSource,
    "const waitForCommandConfirmation = async (",
    "  const handleCreateSnapshot = async () => {",
  );
  const executableWaitForCommandConfirmationSource = waitForCommandConfirmationSource
    .replace(": string, commandPromise: Promise<unknown>", ", commandPromise")
    .replace("new Promise<void>", "new Promise");
  const waitForCommandConfirmation = new Function(
    "waitForWorkspaceCommandConfirmation",
    "mcpManagementService",
    "window",
    `${executableWaitForCommandConfirmationSource}\nreturn waitForCommandConfirmation;`,
  )(
    waitForWorkspaceCommandConfirmation,
    {
      listCommandRequests: () => [
        { requestId: "cmd-other", command: "table.exportCsv", status: "awaiting-confirmation" },
        { requestId: "cmd-own", command: "table.exportCsv", status: "awaiting-confirmation" },
      ],
    },
    {
      requestAnimationFrame: (callback: FrameRequestCallback) => {
        queueMicrotask(() => {
          callback(0);
        });
        return 1;
      },
    },
  ) as (requestId: string, commandPromise: Promise<unknown>) => Promise<string | null>;

  let settleCommand: (() => void) | null = null;
  const commandPromise = new Promise<void>((resolve) => {
    settleCommand = resolve;
  });
  const settledPromise = commandPromise.finally(() => undefined);
  queueMicrotask(() => {
    settleCommand?.();
  });

  const requestId = await waitForCommandConfirmation("cmd-own", settledPromise);
  assert.equal(requestId, "cmd-own", "Workspace confirmation polling must bind to the launched requestId rather than the first matching command");
}

console.log("application command save/snapshot/export tests passed");