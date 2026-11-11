import assert from "node:assert/strict";

import { dataService } from "../src/services/dataService.ts";
import { useHistoryStore } from "../src/stores/useHistoryStore.ts";
import type { HistoryEntry, TableHistoryAction } from "../src/types/history.ts";

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
const originalDrop = dataService.dropTableChangeSet;
dataService.dropTableChangeSet = async () => {};
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
  dataService.dropTableChangeSet = originalDrop;
}

const originalUpdate = dataService.updateCells;
const originalAdd = dataService.applyAddedRows;
const originalReorder = dataService.reorderColumnIfGeneration;
const generations = new Map([["dataset-a", 3], ["dataset-b", 1]]);
const values = new Map<string, string | null>([["dataset-a:1", null], ["dataset-a:2", null], ["dataset-b:1", null], ["dataset-a:3", null]]);
dataService.updateCells = async (datasetId, updates, expectedGeneration) => {
  const current = generations.get(datasetId)!;
  if (expectedGeneration !== current) throw new Error(`stale dataset generation: expected ${current}, received ${expectedGeneration}`);
  for (const update of updates) values.set(`${datasetId}:${update.rowId}`, update.value);
  generations.set(datasetId, current + 1);
  return current + 1;
};

const applyGeneration = async (datasetId: string, expectedGeneration?: number) => {
  const current = generations.get(datasetId)!;
  if (expectedGeneration !== current) throw new Error(`stale dataset generation: expected ${current}, received ${expectedGeneration}`);
  generations.set(datasetId, current + 1);
  return current + 1;
};
dataService.applyAddedRows = async (id, _rows, _undo, generation) => applyGeneration(id, generation);
dataService.reorderColumnIfGeneration = async (id, _from, _to, generation) => applyGeneration(id, generation);
dataService.applyTableChangeSet = async (_id, _undo, datasetId, expectedGeneration?: number) =>
  applyGeneration(datasetId!, expectedGeneration);

try {
  const { recordTable, undo, redo } = useHistoryStore.getState();
  for (const [datasetId, rowId, generation] of [
    ["dataset-a", 1, 1],
    ["dataset-b", 1, 1],
    ["dataset-a", 2, 2],
    ["dataset-a", 3, 3],
  ] as const) {
    recordTable("Clear cell", {
      kind: "cells", datasetId, generation,
      cells: [{ rowId, columnName: "value", before: `${datasetId}:${rowId}`, after: null }],
    });
  }

  for (let step = 0; step < 4; step += 1) {
    await undo();
    assert.equal(useHistoryStore.getState().historyError, null);
  }
  assert.deepEqual([...values.values()], ["dataset-a:1", "dataset-a:2", "dataset-b:1", "dataset-a:3"]);
  for (let step = 0; step < 4; step += 1) {
    await redo();
    assert.equal(useHistoryStore.getState().historyError, null);
  }
  assert.deepEqual([...values.values()], [null, null, null, null]);

  const recordMixedMutation = (action: TableHistoryAction) => {
    generations.set("dataset-a", generations.get("dataset-a")! + 1);
    recordTable("Mixed action", action);
  };
  let generation = generations.get("dataset-a")!;
  recordMixedMutation({ kind: "changeSet", datasetId: "dataset-a", changeSetId: "mixed", generation: ++generation });
  recordMixedMutation({ kind: "addedRows", datasetId: "dataset-a", rowIds: [3], generation: ++generation });
  recordMixedMutation({ kind: "reorderColumns", datasetId: "dataset-a", from: 0, to: 1, generation: ++generation });
  for (const replay of [undo, redo]) {
    for (let step = 0; step < 7; step += 1) {
      await replay();
      assert.equal(useHistoryStore.getState().historyError, null);
    }
  }
  const externalGeneration = generations.get("dataset-a")! + 1;
  generations.set("dataset-a", externalGeneration);
  recordMixedMutation({
    kind: "cells", datasetId: "dataset-a", generation: externalGeneration + 1,
    cells: [{ rowId: 1, columnName: "value", before: null, after: "new edit" }],
  });
  values.set("dataset-a:1", "new edit");
  await undo();
  assert.equal(useHistoryStore.getState().historyError, null);
  const previousIndex = useHistoryStore.getState().currentIdx;
  assert.equal(useHistoryStore.getState().tryBeginTableMutation(), true);
  await undo();
  assert.equal(useHistoryStore.getState().currentIdx, previousIndex);
  useHistoryStore.getState().endTableMutation();
  await undo();
  assert.match(useHistoryStore.getState().historyError ?? "", /stale dataset generation/);
  assert.equal(useHistoryStore.getState().currentIdx, previousIndex);
  assert.deepEqual([...values.values()], [null, null, null, null]);
} finally {
  dataService.updateCells = originalUpdate;
  dataService.applyAddedRows = originalAdd;
  dataService.reorderColumnIfGeneration = originalReorder;
  dataService.applyTableChangeSet = originalApply;
  dataService.dropTableChangeSet = async () => {};
  useHistoryStore.getState().reset();
  dataService.dropTableChangeSet = originalDrop;
}

console.log("history cursor runtime regression passed");
