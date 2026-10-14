import assert from "node:assert/strict";
import { dataService } from "../src/services/dataService.ts";
import { useHistoryStore } from "../src/stores/useHistoryStore.ts";

const originalApply = dataService.applyTableChangeSet;
const originalDrop = dataService.dropTableChangeSet;
const originalConsoleError = console.error;
const teardownDiagnostics: unknown[][] = [];
console.error = (...args) => { teardownDiagnostics.push(args); };
dataService.applyTableChangeSet = async () => { throw new Error("replay failed"); };
dataService.dropTableChangeSet = async () => {};

async function fail(datasetId: string) {
  useHistoryStore.getState().recordTable("edit", { kind: "changeSet", datasetId, changeSetId: "edit" });
  await useHistoryStore.getState().undo();
  return useHistoryStore.getState().historyErrorNotification;
}

try {
  useHistoryStore.getState().reset();
  const first = await fail("a");
  assert.ok(first);
  assert.equal(useHistoryStore.getState().consumeHistoryError(first.id, "b"), null);
  assert.equal(useHistoryStore.getState().historyErrorNotification?.id, first.id);
  assert.equal(useHistoryStore.getState().consumeHistoryError(first.id, "a"), "Error: replay failed");
  assert.equal(useHistoryStore.getState().consumeHistoryError(first.id, "a"), null);
  assert.equal(useHistoryStore.getState().historyError, "Error: replay failed", "diagnostic record survives consumption");
  const second = await fail("a");
  assert.ok(second);
  assert.notEqual(second.id, first.id, "same-message failures are distinct events");
  assert.equal(useHistoryStore.getState().consumeHistoryError(first.id, "a"), null, "stale consumer cannot dismiss new event");
  assert.equal(useHistoryStore.getState().consumeHistoryError(second.id, "a"), "Error: replay failed");
  useHistoryStore.getState().loadFromProject([{
    id: "redo-b", timestamp: "2026-10-14T00:00:00Z", description: "redo edit",
    action: { kind: "changeSet", datasetId: "b", changeSetId: "redo-b" },
  }], [], 1);
  await useHistoryStore.getState().redo();
  const redoError = useHistoryStore.getState().historyErrorNotification;
  assert.ok(redoError);
  assert.equal(redoError.datasetId, "b");
  assert.equal(useHistoryStore.getState().consumeHistoryError(redoError.id, "a"), null);
  assert.equal(useHistoryStore.getState().consumeHistoryError(redoError.id, "b"), "Error: replay failed");
  await fail("a");
  useHistoryStore.getState().loadFromProject([], []);
  assert.equal(useHistoryStore.getState().historyErrorNotification, null);
  assert.equal(useHistoryStore.getState().historyError, null);
  let rejectReplay: (reason: Error) => void = () => {};
  dataService.applyTableChangeSet = async () => new Promise<void>((_, reject) => { rejectReplay = reject; });
  useHistoryStore.getState().recordTable("in flight", { kind: "changeSet", datasetId: "a", changeSetId: "in-flight" });
  const pendingReplay = useHistoryStore.getState().undo();
  useHistoryStore.getState().loadFromProject([], []);
  rejectReplay(new Error("obsolete replay"));
  await pendingReplay;
  assert.equal(useHistoryStore.getState().pendingAction, null);
  assert.equal(useHistoryStore.getState().historyErrorNotification, null);
  let rejectCleanup: (reason: Error) => void = () => {};
  dataService.dropTableChangeSet = async () => new Promise<void>((_, reject) => { rejectCleanup = reject; });
  useHistoryStore.getState().recordTable("old project", { kind: "changeSet", datasetId: "old", changeSetId: "old" });
  useHistoryStore.getState().reset();
  rejectCleanup(new Error("old project cleanup"));
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(useHistoryStore.getState().historyErrorNotification, null, "old cleanup must not enter a new project");
  assert.equal(useHistoryStore.getState().historyError, null);
  assert.ok(teardownDiagnostics.some(args => args.some(value => value instanceof Error && value.message === "old project cleanup")), "obsolete cleanup failure remains visible in diagnostics");
} finally {
  dataService.applyTableChangeSet = originalApply;
  dataService.dropTableChangeSet = originalDrop;
  console.error = originalConsoleError;
  useHistoryStore.getState().reset();
}
console.log("history error notification regressions passed");
