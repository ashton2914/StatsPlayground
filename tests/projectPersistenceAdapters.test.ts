import { useFolderStore } from "../src/stores/useFolderStore.ts";
import assert from "node:assert/strict";
import { createProjectPersistenceCoordinator, type ProjectOperation } from "../src/projectPersistence/coordinator.ts";
import { createProjectDocumentAdapters, hydrateProjectDocument, applyCommittedProjectEffects } from "../src/projectPersistence/documentAdapters.ts";
import { useHistoryStore } from "../src/stores/useHistoryStore.ts";
import { useProjectStore } from "../src/stores/useProjectStore.ts";
import { useReportStore } from "../src/stores/useReportStore.ts";
import { useGraphBuilderNewStore } from "../src/stores/useGraphBuilderNewStore.ts";
import type { ProjectCommit, ProjectDocumentBody, ProjectRecordPatch } from "../src/types/projectPersistence.ts";

useReportStore.getState().reset();
useGraphBuilderNewStore.getState().reset();
const sent: ProjectOperation<unknown>[] = [];
let revision = 1;
const coordinator = createProjectPersistenceCoordinator({ projectId: "project", epoch: 7, committedRevision: revision,
  now: () => 0, newOperationId: () => `operation-${sent.length + 1}`,
  setTimer: () => 1, clearTimer: () => undefined,
  onChange: (snapshot) => useProjectStore.getState().syncPersistence(snapshot),
  onCommit: applyCommittedProjectEffects,
  transport: async <T>(operation: ProjectOperation<T>, context) => {
    assert.equal(context.expectedRevision, revision);
    sent.push(structuredClone(operation));
    const patch = operation.payload as ProjectRecordPatch;
    return { operationId: context.operationId, epoch: 7, committedRevision: ++revision, value: null,
      changedDatasetGenerations: [], changedDocumentRevisions: (patch.documents ?? []).map((write) => ({ id: write.document.summary.id, revision: write.document.summary.revision })),
    } as ProjectCommit<T>;
  },
});
useProjectStore.getState().installPersistence(coordinator);
const adapters = createProjectDocumentAdapters({ coordinator, summaries: [] });
const dispose = adapters.activate();
const report: ProjectDocumentBody = { schemaVersion: 1,
  summary: { id: "report", kind: "report", name: "Report", folder: "", revision: 1, dependencies: [] },
  body: { id: "report", name: "Report", schemaVersion: 1, markdown: "original", createdAt: "2026-01-01", updatedAt: "2026-01-01" },
};
hydrateProjectDocument(report);
assert.equal(coordinator.snapshot().pendingSequence, 0, "hydration must not enqueue writes");
useReportStore.getState().updateMarkdown("report", "changed", "2026-01-02");
assert.equal(coordinator.snapshot().pendingSequence, 1);
hydrateProjectDocument(report);
assert.equal(useReportStore.getState().items[0].markdown, "changed", "late hydration must preserve pending edits");
await coordinator.flushThrough(coordinator.captureBarrier());
const first = sent[0].payload as ProjectRecordPatch;
assert.equal((first.documents![0].document.body as { markdown: string }).markdown, "changed");
assert.equal(first.documents![0].expectedRevision, 1);
assert.equal(adapters.getSummary("report")?.revision, 2);
useReportStore.getState().deleteItem("report");
await coordinator.flushThrough(coordinator.captureBarrier());
hydrateProjectDocument(report);
assert.equal(useReportStore.getState().items.length, 0, "late fetch must not resurrect a deleted document");
assert.deepEqual((sent[1].payload as ProjectRecordPatch).deletedDocumentIds, ["report"]);

useReportStore.getState().addItem(report.body as import("../src/types/report").ReportItem);
await coordinator.flushThrough(coordinator.captureBarrier());
const restored = (sent.at(-1)!.payload as ProjectRecordPatch).documents![0];
assert.equal(restored.expectedRevision, null, "restoring a deleted document is a new body revision");
assert.equal(restored.document.summary.revision, 1);

const id = useGraphBuilderNewStore.getState().open("table-source", 0);
useGraphBuilderNewStore.getState().setCamera(id, { xMin: 0, xMax: 10, yMin: 0, yMax: 20 });
const layer = useGraphBuilderNewStore.getState().items[0].layers[0];
useGraphBuilderNewStore.getState().setLayerOptions(id, layer.id, { jitterLimit: 0.75 });
await coordinator.flushThrough(coordinator.captureBarrier());
const graphWrite = (sent.at(-1)!.payload as ProjectRecordPatch).documents![0];
assert.equal(graphWrite.document.summary.kind, "graphNew");
assert.equal((graphWrite.document.body as { version: number }).version, 3);
assert.deepEqual((graphWrite.document.body as { layers: unknown }).layers, useGraphBuilderNewStore.getState().items[0].layers);
assert.equal("sessions" in (graphWrite.document.body as object), false);
const sequence = coordinator.snapshot().pendingSequence;
useGraphBuilderNewStore.getState().close(id);
assert.equal(coordinator.snapshot().pendingSequence, sequence, "runtime session close must not persist a document");
for (const item of [...useGraphBuilderNewStore.getState().items[0].layers]) useGraphBuilderNewStore.getState().removeLayer(id, item.id);
await coordinator.flushThrough(coordinator.captureBarrier());
assert.deepEqual(((sent.at(-1)!.payload as ProjectRecordPatch).documents![0].document.body as { layers: unknown[] }).layers, []);

// Loading another body must preserve existing renderer sessions and acknowledged revisions.
useGraphBuilderNewStore.getState().reopen(id, 0);
const liveSession = useGraphBuilderNewStore.getState().sessions[0];
const anotherGraph = structuredClone(graphWrite.document);
anotherGraph.summary = { ...anotherGraph.summary, id: "another-graph", name: "Another graph", revision: 1 };
anotherGraph.body = { ...(anotherGraph.body as object), id: "another-graph", name: "Another graph" };
hydrateProjectDocument(anotherGraph);
assert.equal(useGraphBuilderNewStore.getState().sessions[0], liveSession, "lazy body hydration must preserve unrelated live sessions");
useReportStore.getState().setDocumentRevision("report", 42);
const anotherReport = structuredClone(report);
anotherReport.summary = { ...anotherReport.summary, id: "another-report", name: "Another report", revision: 5 };
anotherReport.body = { ...(anotherReport.body as object), id: "another-report", name: "Another report" };
hydrateProjectDocument(anotherReport);
assert.equal(useReportStore.getState().getDocumentRevision("report"), 42);
assert.equal(useReportStore.getState().getDocumentRevision("another-report"), 5);
useReportStore.getState().updateMarkdown("another-report", "acknowledged", "2026-01-03");
await coordinator.flushThrough(coordinator.captureBarrier());
assert.equal(useReportStore.getState().getDocumentRevision("another-report"), 6);

useReportStore.getState().updateMarkdown("another-report", '{{sp-embed kind="graph" id="legacy-graph"}}', "2026-01-04");
await coordinator.flushThrough(coordinator.captureBarrier());
assert.deepEqual(adapters.getSummary("another-report")?.dependencies, ["legacy-graph"], "report metadata must retain its embedded document dependencies");

useFolderStore.getState().setReportFolder("another-report","Reports");
useReportStore.getState().renameItem("another-report","Renamed report");
await coordinator.flushThrough(coordinator.captureBarrier());
const namePatch=sent.at(-1)!.payload as ProjectRecordPatch;
assert.equal(namePatch.documents?.length ?? 0,0,"renaming must not serialize the report body");
assert.equal(namePatch.directoryMoves?.[0].name,"Renamed report");
assert.equal(namePatch.directoryMoves?.[0].folder,"Reports","a queued rename must retain the preceding folder move");
const afterRename=coordinator.snapshot().pendingSequence;
useReportStore.getState().renameItem("another-report","Renamed report");
assert.equal(coordinator.snapshot().pendingSequence,afterRename,"a no-op rename must not enqueue a save");

const acknowledgedHistory = { id: "backend-history", datasetId: "table", operation: "update_cells", applied: true, generation: 1 };
const receipt: ProjectCommit<unknown> = { operationId: "native-table", epoch: 7, committedRevision: revision,
  value: null, changedDatasetGenerations: [{ id: "table", generation: 1 }], changedDocumentRevisions: [], changedHistoryEntries: [acknowledgedHistory], changedDirectoryEntries: [{ id:"table",kind:"table",name:"Table",folder:"",revision:1,dependencies:[] }] };
applyCommittedProjectEffects(receipt);
assert.equal(adapters.getSummary("table")?.revision,1,"creation acknowledgements must register new directory metadata before follow-up actions");
assert.equal(useHistoryStore.getState().history.length, 1, "native receipt must project the durable change set");
assert.deepEqual(useHistoryStore.getState().history[0].action, { kind: "changeSet", datasetId: "table", changeSetId: "backend-history" });
useHistoryStore.getState().recordTable("UI cell edit", { kind: "cells", datasetId: "table", generation: 1, cells: [{ rowId: 1, columnName: "value", before: 0, after: 1 }] });
applyCommittedProjectEffects(receipt);
assert.equal(useHistoryStore.getState().history.length, 1, "UI history recording and acknowledgement replay must not duplicate native entries");
// Native history is durable; evicting the frontend cache must not delete it.
useHistoryStore.getState().reset();
for (let i = 0; i < 8; i++) await Promise.resolve();
assert.equal(useHistoryStore.getState().historyError, null, "cache reset must not invoke durable history deletion");
assert.equal(coordinator.snapshot().status, "saved");

await coordinator.close();
dispose();
useProjectStore.getState().installPersistence(null);
useReportStore.getState().reset();
useGraphBuilderNewStore.getState().reset();
useFolderStore.getState().reset();
console.log("project persistence adapters: real stores, hydration fences, deletes and graph v3 passed");
