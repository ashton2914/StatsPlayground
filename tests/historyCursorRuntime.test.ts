import assert from "node:assert/strict";

import { dataService } from "../src/services/dataService.ts";
import { useHistoryStore } from "../src/stores/useHistoryStore.ts";
import type { HistoryEntry } from "../src/types/history.ts";

function change(id: string, replayable = true): HistoryEntry {
  return {
    id,
    timestamp: "2026-09-20T00:00:00.000Z",
    description: id,
    action: {
      kind: "changeSet",
      datasetId: "dataset-a",
      changeSetId: `change-${id}`,
    },
    replayable,
    migrationError: replayable ? undefined : "migration required",
  };
}

const originalApply = dataService.applyTableChangeSet;
const requests: Array<{ id: string; undo: boolean }> = [];
dataService.applyTableChangeSet = async (id, undo) => {
  requests.push({ id, undo });
};

try {
  const history = [change("c"), change("b"), change("a")];
  useHistoryStore.getState().loadFromProject([], [], 0);
  assert.equal(useHistoryStore.getState().currentIdx, -1);

  useHistoryStore.getState().loadFromProject(history, [], 0);
  assert.equal(useHistoryStore.getState().currentIdx, 0);

  useHistoryStore.getState().loadFromProject(history, [], 1);
  assert.equal(useHistoryStore.getState().currentIdx, 1);

  await useHistoryStore.getState().undo();
  assert.deepEqual(requests.shift(), { id: "change-b", undo: true });
  await useHistoryStore.getState().redo();
  assert.deepEqual(requests.shift(), { id: "change-b", undo: false });

  useHistoryStore.getState().loadFromProject(history, [], history.length);
  await useHistoryStore.getState().redo();
  assert.deepEqual(requests.shift(), { id: "change-a", undo: false });

  useHistoryStore.getState().loadFromProject(
    [change("migration", false), change("a")],
    [],
    0,
  );
  await useHistoryStore.getState().undo();
  assert.deepEqual(requests.shift(), { id: "change-a", undo: true });
} finally {
  dataService.applyTableChangeSet = originalApply;
  useHistoryStore.getState().reset();
}

console.log("history cursor runtime regression passed");
