import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { projectService } from "../src/services/projectService.ts";
import type { ProjectWriteContext } from "../src/types/projectPersistence.ts";

Object.defineProperty(globalThis, "window", { value: globalThis, configurable: true });
const calls: Array<{ command: string; args: unknown }> = [];
mockIPC((command, args) => { calls.push({ command, args: structuredClone(args) }); return { marker: command }; });
const context: ProjectWriteContext = { operationId: "op", expectedProjectId: "project", expectedEpoch: 7, expectedRevision: 3 };
try {
  await projectService.openProjectV5("project.spprj", true);
  await projectService.listProjectCatalog(7, { after: null, limit: 200 });
  await projectService.getProjectDocument(7, "report", 2);
  await projectService.listProjectHistory(7, { datasetId: "table", after: null, limit: 100 });
  await projectService.commitOperation({ command: "commit_project_records", payload: { deletedDocumentIds: ["report"] } }, context);
  await projectService.getProjectPersistenceStatus(7);
  await projectService.getProjectSetting(7,"lineage");
  await projectService.checkpointProjectV5(7,3);
  await projectService.closeProjectV5(7);
  await projectService.createProjectDraftV5();
  await projectService.listRecoverableProjectDrafts();
  await projectService.recoverProjectDraftV5("opaque-id");
  await projectService.snapshotProjectV5(7,"copy.spprj",false);
  assert.deepEqual(calls, [
    { command: "open_project_v5", args: { filePath: "project.spprj", readOnly: true } },
    { command: "list_project_catalog", args: { epoch: 7, request: { after: null, limit: 200 } } },
    { command: "get_project_document", args: { epoch: 7, id: "report", expectedRevision: 2 } },
    { command: "list_project_history", args: { epoch: 7, request: { datasetId: "table", after: null, limit: 100 } } },
    { command: "commit_project_records", args: { patch: { deletedDocumentIds: ["report"] }, context } },
    { command: "get_project_persistence_status", args: { epoch: 7 } },
    { command: "get_project_setting", args: { epoch: 7,key:"lineage" } },
    { command: "checkpoint_project_v5", args: {epoch:7,expectedRevision:3} },
    { command: "close_project_v5", args: {epoch:7} },
    { command: "create_project_draft_v5", args: {} },
    { command: "list_recoverable_project_drafts", args: {} },
    { command: "recover_project_draft_v5", args: {recoveryId:"opaque-id"} },
    { command: "snapshot_project_v5", args: {epoch:7,filePath:"copy.spprj",firstNaming:false} },
  ]);
  const registration = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
  for (const { command } of calls) assert.ok(registration.includes(`commands::project_commands::${command},`), `Tauri must register ${command}`);
  console.log("project persistence IPC contracts: registered names and camelCase envelopes passed");
} finally { clearMocks(); delete (globalThis as { window?: unknown }).window; }
