import assert from "node:assert/strict";

import type { ApplicationCommandRegistry } from "@/applicationCommands/types";
import { createWorkspaceCommandHandlers } from "@/components/workspaceCommandHandlers";
import type { TableExportPlan } from "@/components/tableExport";

function translate(key: string, options?: { defaultValue?: string; [key: string]: unknown }) {
  return options?.defaultValue ?? key;
}

function singleFileCsvPlan(fileName: string): TableExportPlan {
  return {
    format: "csv",
    mode: "single-file",
    datasetIds: ["table-1"],
    archivePaths: {},
    sqliteNames: {},
  };
}

{
  const executed: Array<unknown> = [];
  const toasts: Array<{ message: string; durationMs: number }> = [];
  let requestedPath = 0;

  const handlers = createWorkspaceCommandHandlers({
    t: translate,
    getProjectFilePath: () => null,
    getProjectRevision: () => 7,
    isSaving: () => false,
    isReadOnly: () => false,
    requestSaveProjectPath: async () => {
      requestedPath += 1;
      return "/Users/ashton/private/task8.spprj";
    },
    executeCommand: async (command) => {
      executed.push(command);
      return {
        requestId: "cmd-save",
        command: "project.save",
        changed: true,
        projectRevision: 8,
        data: {
          name: "Task8",
          createdAt: "2026-09-15T00:00:00.000Z",
          fileName: "task8.spprj",
          hasProjectPath: true,
        },
        warnings: [],
      };
    },
    showToast: (message, durationMs) => {
      toasts.push({ message, durationMs });
    },
  });

  await handlers.saveProject();

  assert.equal(requestedPath, 1);
  assert.deepEqual(executed, [{
    type: "project.save",
    input: { filePath: "/Users/ashton/private/task8.spprj" },
    control: { expectedProjectRevision: 7 },
  }]);
  assert.deepEqual(toasts, [{ message: "Saved", durationMs: 1500 }]);
}

{
  const executed: Array<unknown> = [];
  const busyMessages: Array<string | null> = [];
  let unlistenCount = 0;

  const handlers = createWorkspaceCommandHandlers({
    t: translate,
    getProjectFilePath: () => "/Users/ashton/private/task8.spprj",
    getProjectRevision: () => 3,
    isSaving: () => false,
    isReadOnly: () => false,
    listen: async (eventName) => {
      assert.equal(eventName, "snapshot-progress");
      return () => {
        unlistenCount += 1;
      };
    },
    setBusyMessage: (message) => {
      busyMessages.push(message);
    },
    executeCommand: async (command) => {
      executed.push(command);
      return {
        requestId: "cmd-snapshot",
        command: "snapshot.create",
        changed: true,
        projectRevision: 4,
        data: { snapshotId: "snapshot-1", snapshotName: null, createdAt: null },
        warnings: [],
      };
    },
  });

  await handlers.createSnapshot();

  assert.deepEqual(executed, [{ type: "snapshot.create", input: {} }]);
  assert.deepEqual(busyMessages, ["Creating snapshot", null]);
  assert.equal(unlistenCount, 1);
}

{
  const executed: Array<unknown> = [];
  const authorizations: string[] = [];
  const revocations: string[] = [];
  const confirmations: Array<{ requestId: string; allow: boolean }> = [];
  const overwriteAnswers = [true, false];
  const pendingStatus = new Set(["cmd-export-1", "cmd-export-2"]);
  let requestCount = 0;

  const handlers = createWorkspaceCommandHandlers({
    t: translate,
    getProjectFilePath: () => "/Users/ashton/private/task8.spprj",
    getProjectRevision: () => 3,
    isSaving: () => false,
    isReadOnly: () => false,
    authorizeCsvExportRoot: async (rootPath) => {
      authorizations.push(rootPath);
      requestCount += 1;
      return {
        rootId: `root-${requestCount}`,
        displayName: `root-${requestCount}`,
      };
    },
    revokeCsvExportRoot: async (rootId) => {
      revocations.push(rootId);
    },
    executeCommand: (command) => {
      executed.push(command);
      const requestId = executed.length === 1 ? "cmd-export-1" : "cmd-export-2";
      const promise = Promise.resolve({
        requestId,
        command: "table.exportCsv",
        changed: false,
        projectRevision: 3,
        data: { targetStatus: "overwriteExisting" as const },
        warnings: [],
      }) as Promise<{
        requestId: string;
        command: string;
        changed: boolean;
        projectRevision: number;
        data: { targetStatus: "overwriteExisting" };
        warnings: [];
      }> & {
        requestId?: string;
      };
      Object.defineProperty(promise, "requestId", {
        value: requestId,
        enumerable: true,
      });
      return promise as never;
    },
    listCommandRequests: () => [...pendingStatus].map((requestId) => ({
      requestId,
      command: "table.exportCsv",
      status: "awaiting-confirmation" as const,
    })),
    confirmCommandRequest: (requestId, allow) => {
      confirmations.push({ requestId, allow });
      pendingStatus.delete(requestId);
      return true;
    },
    confirmOverwrite: () => overwriteAnswers.shift() ?? false,
    waitForAnimationFrame: async () => undefined,
  });

  await Promise.all([
    handlers.exportCsv(singleFileCsvPlan("/Users/ashton/Exports/first.csv"), "/Users/ashton/Exports/first.csv"),
    handlers.exportCsv(singleFileCsvPlan("/Users/ashton/Exports/second.csv"), "/Users/ashton/Exports/second.csv"),
  ]);

  assert.deepEqual(authorizations, ["/Users/ashton/Exports", "/Users/ashton/Exports"]);
  assert.deepEqual(executed, [
    {
      type: "table.exportCsv",
      input: { datasetId: "table-1", rootId: "root-1", relativePath: "first.csv" },
    },
    {
      type: "table.exportCsv",
      input: { datasetId: "table-1", rootId: "root-2", relativePath: "second.csv" },
    },
  ]);
  assert.deepEqual(confirmations, [
    { requestId: "cmd-export-1", allow: true },
    { requestId: "cmd-export-2", allow: false },
  ]);
  assert.deepEqual(revocations, ["root-1", "root-2"]);
}

console.log("workspace command handler behavior tests passed");