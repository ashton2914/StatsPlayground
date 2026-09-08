import assert from "node:assert/strict";

import {
  canMaterializeSelection,
  calculatePlaceholderRange,
  calculateTableWindow,
  RequestEpoch,
  serializeTableWindowFilters,
  shouldReloadDatasetRevision,
  windowRowAt,
} from "../src/utils/tableViewport.ts";

assert.deepEqual(
  calculatePlaceholderRange(120_000, 120_032, 0, 500),
  { startIdx: 120_000, endIdx: 120_032 },
);
assert.equal(calculatePlaceholderRange(480, 520, 0, 500), null);
assert.equal(calculatePlaceholderRange(500, 500, 0, 500), null);

assert.deepEqual(
  calculateTableWindow({
    totalRows: 100_000,
    rowHeight: 27,
    scrollTop: 0,
    viewportHeight: 540,
    overscanRows: 10,
    pageSize: 500,
  }),
  { start: 0, count: 500 },
);

assert.deepEqual(
  calculateTableWindow({
    totalRows: 100_000,
    rowHeight: 27,
    scrollTop: 13_365,
    viewportHeight: 540,
    overscanRows: 10,
    pageSize: 500,
  }),
  { start: 0, count: 1_000 },
);

assert.deepEqual(
  calculateTableWindow({
    totalRows: 100_250,
    rowHeight: 27,
    scrollTop: 2_699_730,
    viewportHeight: 540,
    overscanRows: 10,
    pageSize: 500,
  }),
  { start: 99_500, count: 750 },
);

assert.deepEqual(
  calculateTableWindow({
    totalRows: 0,
    rowHeight: 27,
    scrollTop: 0,
    viewportHeight: 540,
    overscanRows: 10,
    pageSize: 500,
  }),
  { start: 0, count: 0 },
);

assert.deepEqual(
  calculateTableWindow({
    totalRows: 750,
    rowHeight: 27,
    scrollTop: 270_000,
    viewportHeight: 540,
    overscanRows: 10,
    pageSize: 500,
  }),
  { start: 500, count: 250 },
);

const row = [501, "loaded"];
assert.equal(windowRowAt({ start: 500, rows: [row] }, 500), row);
assert.equal(windowRowAt({ start: 500, rows: [row] }, 499), undefined);
assert.equal(windowRowAt({ start: 500, rows: [row] }, 501), undefined);

assert.equal(canMaterializeSelection(500, 999, 0, 19, 500, 500), true);
assert.equal(canMaterializeSelection(499, 500, 0, 0, 500, 500), false);
assert.equal(canMaterializeSelection(500, 1_000, 0, 0, 500, 500), false);
assert.equal(canMaterializeSelection(500, 999, 0, 20, 500, 500, 10_000), false);
assert.equal(canMaterializeSelection(500, 999, 0, 9, 500, 500, 5_000, 1), false);

assert.deepEqual(
  serializeTableWindowFilters([
    {
      id: "amount-filter",
      op: "AND",
      rule: {
        kind: "continuous",
        field: { name: "amount", type: "continuous" },
        min: 10,
        max: null,
      },
    },
    {
      id: "category-filter",
      op: "OR",
      rule: {
        kind: "categorical",
        field: { name: "category", type: "nominal" },
        selected: ["A"],
      },
    },
  ]),
  [
    { op: "AND", rule: { kind: "continuous", field: "amount", min: 10, max: null } },
    {
      op: "OR",
      rule: { kind: "categorical", field: "category", selected: ["A"], exclude: false },
    },
  ],
);

const epochs = new RequestEpoch();
const initialEpoch = epochs.current;
const nextEpoch = epochs.advance();
assert.equal(epochs.isCurrent(initialEpoch), false);
assert.equal(epochs.isCurrent(nextEpoch), true);
const olderViewport = epochs.track("0:500");
const latestViewport = epochs.track("500:500");
assert.equal(epochs.isLatest(olderViewport), false);
assert.equal(epochs.isLatest(latestViewport), true);

const originalRevision = { datasetId: "track", rowCount: 3_503, updatedAt: "before" };
assert.equal(shouldReloadDatasetRevision(null, originalRevision), false);
assert.equal(
  shouldReloadDatasetRevision(originalRevision, { ...originalRevision, rowCount: 7_006 }),
  true,
);
assert.equal(
  shouldReloadDatasetRevision(originalRevision, { ...originalRevision, updatedAt: "after" }),
  true,
);
assert.equal(
  shouldReloadDatasetRevision(originalRevision, { ...originalRevision, datasetId: "album" }),
  false,
);

console.log("table-viewport regression passed");
