import assert from "node:assert/strict";

import { createTableViewportStore } from "../src/stores/useTableViewportStore";

const store = createTableViewportStore();
const position = {
  logicalStart: 120,
  logicalQuerySignature: "natural",
  scrollLeft: 640,
};

store.getState().setPosition("table-a", position);
store.getState().setPosition("table-b", {
  logicalStart: 480,
  logicalQuerySignature: "sorted",
  scrollLeft: 320,
});

store.getState().retainDatasets(["table-b"]);

assert.deepEqual(store.getState().byDataset, {
  "table-b": {
    logicalStart: 480,
    logicalQuerySignature: "sorted",
    scrollLeft: 320,
  },
});

store.getState().reset();
assert.deepEqual(store.getState().byDataset, {});

console.log("table viewport store tests passed");
