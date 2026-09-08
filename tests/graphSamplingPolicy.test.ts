import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SCATTER_RENDER_BUDGET } from "../src/graphCore/scatterBudget.ts";
import {
  clampSampleSize,
  DEFAULT_GRAPH_SAMPLE_SIZE,
  getRawPointNotice,
  requiresRawGraphFrame,
  resolveEffectiveGraphSampling,
} from "../src/components/graphBuilder/graphSamplingPolicy.ts";

assert.equal(clampSampleSize(SCATTER_RENDER_BUDGET + 1), SCATTER_RENDER_BUDGET);
assert.equal(clampSampleSize(0), 1);
assert.equal(DEFAULT_GRAPH_SAMPLE_SIZE, SCATTER_RENDER_BUDGET);

assert.deepEqual(getRawPointNotice({
  status: "omitted",
  reason: "pointBudgetExceeded",
  validRows: 75_000,
  budget: 8_000,
}), {
  kind: "pointBudgetExceeded",
  validRows: 75_000,
  budget: 8_000,
});

assert.equal(getRawPointNotice({
  status: "included",
  validRows: 8_000,
  budget: 8_000,
}), null);
assert.equal(getRawPointNotice({
  status: "empty",
  validRows: 0,
  budget: 8_000,
}), null);

const testDirectory = dirname(fileURLToPath(import.meta.url));
for (const locale of ["en", "vi", "zh-CN", "zh-TW"]) {
  const messages = JSON.parse(readFileSync(
    resolve(testDirectory, `../src/i18n/locales/${locale}.json`),
    "utf8",
  )) as {
    graph?: {
      sampling?: Record<string, unknown>;
      rowStatus?: Record<string, unknown>;
    };
  };
  assert.equal(typeof messages.graph?.sampling?.pointsOmitted, "string", `${locale} pointsOmitted`);
  assert.equal(typeof messages.graph?.sampling?.pointBudgetCount, "string", `${locale} pointBudgetCount`);
  assert.equal(typeof messages.graph?.sampling?.switchToSample, "string", `${locale} switchToSample`);
  assert.equal(typeof messages.graph?.rowStatus?.pointsOmitted, "string", `${locale} row status`);
}

console.log("graph sampling policy tests passed");

// Additional TDD cases from task brief
const rawCases = [
  [{ kind: "points", summaryStat: "none" }],
  [{ kind: "line", summaryStat: "none" }],
  [{ kind: "bar", summaryStat: "none" }],
  [{ kind: "smoother", summaryStat: "none" }],
  [{ kind: "fitline", summaryStat: "none" }],
];
for (const elements of rawCases) {
  assert.equal(requiresRawGraphFrame(elements), true);
  assert.deepEqual(resolveEffectiveGraphSampling({ mode: "full" }, elements), {
    mode: "sample",
    size: SCATTER_RENDER_BUDGET,
    seed: 0,
  });
}

const aggregateOnly = [
  { kind: "histogram", summaryStat: "none" },
  { kind: "boxplot", summaryStat: "none" },
  { kind: "points", summaryStat: "mean" },
];
assert.equal(requiresRawGraphFrame(aggregateOnly), false);
assert.deepEqual(
  resolveEffectiveGraphSampling({ mode: "full" }, aggregateOnly),
  { mode: "full" },
);
assert.deepEqual(
  resolveEffectiveGraphSampling(
    { mode: "sample", size: SCATTER_RENDER_BUDGET + 1, seed: 17 },
    rawCases[0],
  ),
  { mode: "sample", size: SCATTER_RENDER_BUDGET, seed: 17 },
);
