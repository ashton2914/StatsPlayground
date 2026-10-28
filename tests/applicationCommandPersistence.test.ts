import {useProjectCatalogStore} from "../src/stores/useProjectCatalogStore.ts";
import assert from "node:assert/strict";
import { createApplicationRuntime } from "../src/applicationCommands/applicationRuntime.ts";
import { createProjectPersistenceCoordinator, type ProjectOperation } from "../src/projectPersistence/coordinator.ts";
import { createProjectDocumentAdapters, applyCommittedProjectEffects } from "../src/projectPersistence/documentAdapters.ts";
import { useProjectStore } from "../src/stores/useProjectStore.ts";
import { useReportStore } from "../src/stores/useReportStore.ts";
import type { ProjectCommit, ProjectWriteContext } from "../src/types/projectPersistence.ts";

const sent: Array<{ operation: ProjectOperation; context: ProjectWriteContext; resolve(commit: ProjectCommit<unknown>): void }> = [];
const coordinator = createProjectPersistenceCoordinator({ projectId: "project", epoch: 7, committedRevision: 20,
  now: () => 0, newOperationId: () => crypto.randomUUID(), setTimer: () => 1, clearTimer: () => {},
  onChange: (snapshot) => useProjectStore.getState().syncPersistence(snapshot), onCommit: applyCommittedProjectEffects,
  transport: <T>(operation: ProjectOperation<T>, context: ProjectWriteContext) => new Promise<ProjectCommit<T>>((resolve) => sent.push({ operation, context, resolve: (commit) => resolve(commit as ProjectCommit<T>) })),
});
useProjectStore.getState().installPersistence(coordinator);
const adapters = createProjectDocumentAdapters({ coordinator, summaries: [] });
const release = adapters.activate();
useProjectCatalogStore.getState().installOpenSummary({project:{name:"Project",filePath:"project.spprj",createdAt:"today"},epoch:7,writable:true,header:{projectId:"project",formatVersion:"5.0.0",minimumReader:1,minimumWriter:1,committedRevision:20,createdAt:"today",engineVersion:"test",storageVersion:"test"},directory:{items:[],nextCursor:null,committedRevision:20},settingsRevision:0});
const runtime = createApplicationRuntime({ revision: {
  get: () => useProjectStore.getState().projectRevision,
  set: (revision) => useProjectStore.getState().setRevision(revision), isAuthoritative: () => true,
}, report: { createReportId: () => "report", createNowIso: () => "2026-01-01", activateReport: () => {}, recordAction: () => {} } });
let completed = false;
const command = runtime.execute({ type: "report.create", input: {} }, { kind: "mcp", sessionId: "test" }).then((result) => { completed = true; return result; });
for (let i = 0; i < 100; i++) await Promise.resolve();
assert.equal(completed, false, "MCP mutation must wait for its native acknowledgement");
assert.equal(sent.length, 1, "command completion must force its captured document batch");
useReportStore.getState().updateMarkdown("report", "later UI edit", "2026-01-02");
sent[0].resolve({ operationId: sent[0].context.operationId, epoch: 7, committedRevision: 21, value: null,
  changedDatasetGenerations: [], changedDocumentRevisions: [{ id: "report", revision: 1 }] });
const result = await command;
assert.equal(result.projectRevision, 21);
assert.equal(coordinator.snapshot().acknowledgedSequence, 1);
assert.equal(coordinator.snapshot().pendingSequence, 2, "later edits belong to a later barrier");
const close = coordinator.close();
for (let i = 0; i < 100; i++) await Promise.resolve();
sent[1].resolve({ operationId: sent[1].context.operationId, epoch: 7, committedRevision: 22, value: null,
  changedDatasetGenerations: [], changedDocumentRevisions: [{ id: "report", revision: 2 }] });
await close;
await runtime.shutdown();
release(); useProjectCatalogStore.getState().reset(8); useProjectStore.getState().installPersistence(null); useReportStore.getState().reset();
console.log("application command persistence: MCP completion waits for captured native acknowledgement");
