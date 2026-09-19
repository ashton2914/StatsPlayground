import assert from "node:assert/strict";
import { test } from "node:test";

import {
  TABULATE_LOGICAL_CELL_TIERS,
  TABULATE_QUALIFICATION_SOURCE_ROWS,
  buildTabulateBenchmarkMatrix,
  parseTabulateBenchmarkArgs,
  summarizeSettledSamples,
  validateTabulateBenchmarkPayload,
} from "./tabulateViewportBenchmarkCore.mjs";

function validPayload(overrides = {}) {
  return {
    sourceRows: 10_000_000,
    rowMembers: 1_000,
    columnMembers: 1_000,
    statisticCount: 1,
    logicalCells: 1_000_000,
    nonemptyGroups: 1_000_000,
    memberIndexBytes: 32_000,
    wholeProcessRssBytes: 64_000,
    preparationMs: 12,
    totalsMs: 8,
    cancellationLatencyMs: 3,
    exactReturnedCells: true,
    outcome: "completed",
    tilePayloadBytes: Array(30).fill(512),
    backendTileMs: Array.from({ length: 30 }, (_, index) => index + 1),
    ipcRoundTripMs: { status: "unmeasured", samples: [] },
    visibleInteractionMs: { status: "unmeasured", samples: [] },
    ...overrides,
  };
}

test("builds the exact 10M source qualification matrix", () => {
  assert.equal(TABULATE_QUALIFICATION_SOURCE_ROWS, 10_000_000);
  assert.deepEqual(TABULATE_LOGICAL_CELL_TIERS, [100_000, 1_000_000, 10_000_000]);
  assert.deepEqual(buildTabulateBenchmarkMatrix(), TABULATE_LOGICAL_CELL_TIERS.map((logicalCells) => ({
    sourceRows: TABULATE_QUALIFICATION_SOURCE_ROWS,
    logicalCells,
    samples: 30,
  })));
});

test("parses bounded smoke arguments without presenting them as qualification", () => {
  assert.deepEqual(parseTabulateBenchmarkArgs([
    "--source-rows=100000",
    "--logical-cells=100000",
    "--samples=3",
  ]), {
    sourceRows: 100_000,
    logicalCells: 100_000,
    samples: 3,
    qualification: false,
  });
  assert.throws(() => parseTabulateBenchmarkArgs(["--source-rows=0"]), /source rows/i);
  assert.throws(() => parseTabulateBenchmarkArgs(["--samples=301"]), /samples/i);
});

test("requires 30 settled samples before reporting P50 or P95", () => {
  assert.throws(() => summarizeSettledSamples(Array(29).fill(1)), /30 settled samples/i);
  assert.deepEqual(summarizeSettledSamples(Array.from({ length: 30 }, (_, index) => index + 1)), {
    p50: 15,
    p95: 29,
  });
});

test("validates complete measurements and keeps member bytes distinct from RSS", () => {
  const evaluation = validateTabulateBenchmarkPayload(validPayload());
  assert.equal(evaluation.valid, true);
  assert.deepEqual(evaluation.failures, []);
  assert.equal(evaluation.metrics.backendTileMs.p95, 29);
  assert.deepEqual(evaluation.memory, {
    memberIndexBytes: 32_000,
    wholeProcessRssBytes: 64_000,
  });

  assert.deepEqual(evaluation.metrics.ipcRoundTripMs, {
    status: "unmeasured",
    sampleCount: 0,
    p50: null,
    p95: null,
  });

  const missingSamples = validateTabulateBenchmarkPayload(validPayload({ ipcRoundTripMs: [] }));
  assert.equal(missingSamples.valid, false);
  assert.match(missingSamples.failures.join("\n"), /ipcRoundTripMs/);

  const missingRss = validPayload();
  delete missingRss.wholeProcessRssBytes;
  const incompleteMemory = validateTabulateBenchmarkPayload(missingRss);
  assert.equal(incompleteMemory.valid, false);
  assert.match(incompleteMemory.failures.join("\n"), /wholeProcessRssBytes/);
});

test("accepts a declared 10M controlled refusal but rejects truncation or false success", () => {
  const refusal = validateTabulateBenchmarkPayload(validPayload({
    logicalCells: 10_000_000,
    nonemptyGroups: 0,
    exactReturnedCells: false,
    outcome: "controlled_refusal",
    refusalCode: "tabulate_member_index_budget",
    tilePayloadBytes: [],
    backendTileMs: [],
  }));
  assert.equal(refusal.valid, true);
  assert.equal(refusal.qualification, false);
  assert.deepEqual(refusal.metrics.backendTileMs, { sampleCount: 0, p50: null, p95: null });

  const truncated = validateTabulateBenchmarkPayload(validPayload({
    logicalCells: 10_000_000,
    nonemptyGroups: 9_999_999,
    exactReturnedCells: false,
    outcome: "completed",
  }));
  assert.equal(truncated.valid, false);
  assert.match(truncated.failures.join("\n"), /exact returned cells/i);
});
