import assert from "node:assert/strict";
import {
  BUDGET_CANDIDATES,
  chooseScatterBudget,
} from "../src/graphCore/scatterBudget.ts";

assert.deepEqual(BUDGET_CANDIDATES, [5_000, 8_000, 10_000, 20_000, 50_000, 100_000]);
assert.equal(chooseScatterBudget([
  { points: 5_000, coherentFrameMs: 180, longestTaskMs: 30 },
  { points: 8_000, coherentFrameMs: 240, longestTaskMs: 35 },
  { points: 10_000, coherentFrameMs: 300, longestTaskMs: 40 },
  { points: 20_000, coherentFrameMs: 700, longestTaskMs: 80 },
  { points: 50_000, coherentFrameMs: 1_700, longestTaskMs: 180 },
  { points: 100_000, coherentFrameMs: 3_000, longestTaskMs: 280 },
]), 20_000);

assert.equal(chooseScatterBudget([
  { points: 5_000, coherentFrameMs: 180, longestTaskMs: 30 },
  { points: 8_000, coherentFrameMs: 240, longestTaskMs: 35 },
  { points: 10_000, coherentFrameMs: 300, longestTaskMs: 40 },
  { points: 20_000, coherentFrameMs: 700, longestTaskMs: 240 },
]), 8_000);

assert.throws(() => chooseScatterBudget([
  { points: 5_000, coherentFrameMs: 180, longestTaskMs: 230 },
  { points: 8_000, coherentFrameMs: 240, longestTaskMs: 250 },
  { points: 10_000, coherentFrameMs: 300, longestTaskMs: 280 },
]), /No measured scatter candidate passed/);
