import assert from "node:assert/strict";

import {
  discardedChangeSetIds,
  prepareArchivedHistory,
  recordIncrementalEntry,
  redoIncrementalEntry,
  undoIncrementalEntry,
  type IncrementalHistoryState,
} from "../src/utils/historyTimeline.ts";
import type { HistoryEntry, TableHistoryAction } from "../src/types/history.ts";

function entry(id: string, value: string): HistoryEntry {
  const action: TableHistoryAction = {
    kind: "cells",
    datasetId: "dataset-a",
    generation: 1,
    cells: [{ rowId: 7, columnName: "value", before: `${value}-before`, after: value }],
  };
  return { id, timestamp: "2026-08-19T00:00:00.000Z", description: id, action };
}

let state: IncrementalHistoryState = { history: [], currentIdx: 0 };
state = recordIncrementalEntry(state, entry("a", "A"), 100);
state = recordIncrementalEntry(state, entry("b", "B"), 100);
state = recordIncrementalEntry(state, entry("c", "C"), 100);
assert.deepEqual(state.history.map(({ id }) => id), ["c", "b", "a"]);
assert.equal(JSON.stringify(state.history).includes("rows"), false);

let transition = undoIncrementalEntry(state);
assert.equal(transition?.request.entryId, "c");
assert.equal(transition?.request.direction, "undo");
state = transition!.state;

transition = undoIncrementalEntry(state);
assert.equal(transition?.request.entryId, "b");
state = transition!.state;

const redo = redoIncrementalEntry(state);
assert.equal(redo?.request.entryId, "b");
assert.equal(redo?.request.direction, "redo");
state = redo!.state;

state = recordIncrementalEntry(state, entry("d", "D"), 100);
assert.deepEqual(state.history.map(({ id }) => id), ["d", "b", "a"]);
assert.equal(state.currentIdx, 0);

for (let index = 0; index < 110; index++) {
  state = recordIncrementalEntry(state, entry(`budget-${index}`, String(index)), 100);
}
assert.equal(state.history.length, 100);
assert.equal(state.history[0].id, "budget-109");

const previous: HistoryEntry[] = [
  {
    id: "paste-a",
    timestamp: "2026-08-19T00:00:00.000Z",
    description: "paste-a",
    action: { kind: "changeSet", datasetId: "dataset-a", changeSetId: "change-a" },
  },
  entry("cell", "cell"),
  {
    id: "paste-b",
    timestamp: "2026-08-19T00:00:00.000Z",
    description: "paste-b",
    action: { kind: "changeSet", datasetId: "dataset-a", changeSetId: "change-b" },
  },
];
assert.deepEqual(discardedChangeSetIds(previous, [previous[2]]), ["change-a"]);

const migrated = prepareArchivedHistory([
  previous[0],
  {
    ...previous[2],
    replayable: false,
    migrationError: "legacy snapshot is unavailable",
  },
]);
assert.equal(migrated[0].action?.kind, "changeSet");
assert.equal(migrated[1].action, undefined);
assert.equal(migrated[1].migrationError, "legacy snapshot is unavailable");

console.log("history-timeline regression passed");
