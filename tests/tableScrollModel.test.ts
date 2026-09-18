import assert from "node:assert/strict";

import {
  logicalStartFromRatio,
  moveLogicalStart,
  ratioFromLogicalStart,
  viewportSlotCount,
} from "../src/utils/tableScrollModel.ts";

assert.equal(logicalStartFromRatio(0, 10_000_000, 40), 0);
assert.equal(logicalStartFromRatio(0.5, 10_000_000, 40), 4_999_980);
assert.equal(logicalStartFromRatio(0.9, 10_000_000, 40), 8_999_964);
assert.equal(logicalStartFromRatio(0.99, 10_000_000, 40), 9_899_960);
assert.equal(logicalStartFromRatio(1, 10_000_000, 40), 9_999_960);
assert.equal(logicalStartFromRatio(-1, 10_000_000, 40), 0);
assert.equal(logicalStartFromRatio(2, 10_000_000, 40), 9_999_960);

assert.equal(logicalStartFromRatio(0.75, 0, 40), 0);
assert.equal(logicalStartFromRatio(0.75, 15, 40), 0);

const wheelStepRows = 1;
const pageStepRows = viewportSlotCount(540, 27, 2);
const homeStepRows = -1_000;
const endStepRows = 9_998_960;

assert.ok(
  Math.abs(
    logicalStartFromRatio(
      ratioFromLogicalStart(8_500_000, 10_000_000, 40),
      10_000_000,
      40,
    ) - 8_500_000,
  ) <= 1,
);

assert.equal(ratioFromLogicalStart(0, 10_000_000, 40), 0);
assert.equal(ratioFromLogicalStart(4_999_980, 10_000_000, 40), 0.5);
assert.equal(ratioFromLogicalStart(9_999_960, 10_000_000, 40), 1);
assert.equal(ratioFromLogicalStart(-10, 10_000_000, 40), 0);
assert.equal(ratioFromLogicalStart(99_999_999, 100, 40), 1);
assert.equal(ratioFromLogicalStart(8, 15, 40), 0);

assert.equal(
  moveLogicalStart(
    { totalRows: 10_000_000, visibleRows: 40, logicalStart: 1_000 },
    wheelStepRows,
  ),
  1_001,
);
assert.equal(
  moveLogicalStart(
    { totalRows: 10_000_000, visibleRows: 40, logicalStart: 1_000 },
    -wheelStepRows,
  ),
  999,
);

const zoomedViewportSlots = viewportSlotCount(540, 27, 2);
assert.equal(zoomedViewportSlots, 24);
assert.equal(viewportSlotCount(540, 54, 2), 14);
assert.equal(viewportSlotCount(540, 54, 0), 10);
assert.equal(viewportSlotCount(0, 54, 2), 0);
assert.equal(viewportSlotCount(10.8, 3.6, 0), 3);
assert.equal(viewportSlotCount(10.8, 3.6, 1), 5);

assert.equal(
  moveLogicalStart(
    { totalRows: 10_000_000, visibleRows: 40, logicalStart: 1_000 },
    pageStepRows,
  ),
  1_024,
);
assert.equal(
  moveLogicalStart(
    { totalRows: 10_000_000, visibleRows: 40, logicalStart: 1_000 },
    -pageStepRows,
  ),
  976,
);

assert.equal(
  moveLogicalStart(
    { totalRows: 10_000_000, visibleRows: 40, logicalStart: 1_000 },
    homeStepRows,
  ),
  0,
);
assert.equal(
  moveLogicalStart(
    { totalRows: 10_000_000, visibleRows: 40, logicalStart: 1_000 },
    endStepRows,
  ),
  9_999_960,
);

assert.equal(logicalStartFromRatio(Number.NaN, 10_000_000, 40), 0);
assert.equal(logicalStartFromRatio(0.5, Number.NaN, 40), 0);
assert.equal(ratioFromLogicalStart(Number.POSITIVE_INFINITY, 10_000_000, 40), 0);
assert.equal(ratioFromLogicalStart(10, Number.NaN, 40), 0);
assert.equal(
  moveLogicalStart(
    { totalRows: 100, visibleRows: 40, logicalStart: 999 },
    Number.NaN,
  ),
  60,
);
assert.equal(
  moveLogicalStart(
    { totalRows: 100, visibleRows: 40, logicalStart: 999 },
    Number.POSITIVE_INFINITY,
  ),
  60,
);
assert.equal(viewportSlotCount(Number.POSITIVE_INFINITY, 27, 2), 0);
assert.equal(viewportSlotCount(540, Number.NaN, 2), 0);
assert.equal(viewportSlotCount(540, 27, Number.NaN), 0);

console.log("table-scroll-model regression passed");