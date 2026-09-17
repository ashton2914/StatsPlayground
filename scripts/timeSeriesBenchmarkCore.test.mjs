import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildTimeSeriesScenarioMatrix,
  evaluateBenchmarkPayload,
  evaluateTimeSeriesCandidate,
  renderMarkdownReport,
  TIME_SERIES_BENCHMARK_THRESHOLDS,
} from "./timeSeriesBenchmarkCore.mjs";

test("passes when every renderer metric is within the approved threshold", () => {
  assert.equal(evaluateTimeSeriesCandidate({
    coherentFrameMs: 1_900,
    longestTaskMs: 190,
    zoomP95Ms: 95,
    panP95Ms: 95,
    cursorP95Ms: 45,
    peakHeapMb: 500,
  }).passed, true);
});

test("reports each failed renderer metric independently", () => {
  assert.deepEqual(evaluateTimeSeriesCandidate({
    coherentFrameMs: 2_001,
    longestTaskMs: 190,
    zoomP95Ms: 95,
    panP95Ms: 95,
    cursorP95Ms: 45,
    peakHeapMb: 500,
  }).failedMetrics, ["coherentFrameMs"]);

  assert.deepEqual(evaluateTimeSeriesCandidate({
    coherentFrameMs: 1_900,
    longestTaskMs: 201,
    zoomP95Ms: 101,
    panP95Ms: 95,
    cursorP95Ms: 51,
    peakHeapMb: 513,
  }).failedMetrics, ["longestTaskMs", "zoomP95Ms", "cursorP95Ms", "peakHeapMb"]);
});

test("uses the approved hard-gate thresholds", () => {
  assert.deepEqual(TIME_SERIES_BENCHMARK_THRESHOLDS, {
    coherentFrameMs: 2_000,
    longestTaskMs: 200,
    zoomP95Ms: 100,
    panP95Ms: 100,
    cursorP95Ms: 50,
    peakHeapMb: 512,
  });
});

test("builds the deterministic full-resolution scenario matrix", () => {
  const scenarios = buildTimeSeriesScenarioMatrix();

  assert.equal(scenarios.length, 16);
  assert.deepEqual([...new Set(scenarios.map((scenario) => scenario.points))], [8_000, 50_000, 100_000, 300_000]);
  assert.deepEqual([...new Set(scenarios.map((scenario) => scenario.seriesCount))], [1, 4]);
  assert.deepEqual([...new Set(scenarios.map((scenario) => scenario.markerMode))], ["auto", "show"]);
  assert.equal(scenarios.every((scenario) => scenario.duplicateX === true), true);
  assert.equal(scenarios.every((scenario) => scenario.missingYRate === 0.01), true);
});

test("does not accept renderer qualification when a required metric is unsupported", () => {
  const payload = {
    reportDate: "2026-09-16",
    environment: { userAgent: "test", appVersion: "0.0.0", appBuild: "test", echartsVersion: "test" },
    backendMetrics: [],
    results: [{
      scenarioId: "300000-points-1-series-marker-auto",
      coherentFrameMs: 1_900,
      longestTaskMs: 190,
      zoomSamplesMs: [95],
      cursorSamplesMs: [45],
      peakHeapMb: Number.NaN,
    }],
  };

  const evaluation = evaluateBenchmarkPayload(payload);

  assert.equal(evaluation.rendererAccepted, false);
  assert.deepEqual(evaluation.gate.policy.failedMetrics, ["panP95Ms", "peakHeapMb"]);
  assert.match(renderMarkdownReport(payload, evaluation), /Renderer decision: PENDING TARGET WINDOWS WEBVIEW/);
});