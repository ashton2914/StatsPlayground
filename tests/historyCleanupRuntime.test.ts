import assert from "node:assert/strict";

import { dataService } from "../src/services/dataService.ts";
import { useHistoryStore } from "../src/stores/useHistoryStore.ts";

const originalDrop = dataService.dropTableChangeSet;
const dropped: string[] = [];
dataService.dropTableChangeSet = async (changeSetId: string) => {
  dropped.push(changeSetId);
  throw new Error(`cleanup failed for ${changeSetId}`);
};

try {
  useHistoryStore.getState().reset();
  for (let index = 0; index <= 100; index += 1) {
    useHistoryStore.getState().recordTable(`change ${index}`, {
      kind: "changeSet",
      datasetId: "dataset-a",
      changeSetId: `change-${index}`,
    });
  }
  await new Promise<void>((resolve) => setImmediate(resolve));

  const state = useHistoryStore.getState();
  assert.equal(state.history.length, 100);
  assert.deepEqual(dropped, ["change-0"]);
  assert.match(state.historyError ?? "", /cleanup failed for change-0/);
} finally {
  dataService.dropTableChangeSet = originalDrop;
  useHistoryStore.getState().reset();
}

console.log("history cleanup runtime regression passed");
