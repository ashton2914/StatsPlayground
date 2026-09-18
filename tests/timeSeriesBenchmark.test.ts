import assert from "node:assert/strict";
import { test } from "node:test";

Object.defineProperty(globalThis, "localStorage", { value: { getItem: () => null }, configurable: true });
Object.defineProperty(globalThis, "self", { value: globalThis, configurable: true });
const harness = await import("../src/benchmarks/TimeSeriesBenchmark.tsx");
const { buildTimeSeriesScenarioMatrix } = await import("../scripts/timeSeriesBenchmarkCore.mjs");

test("all 16 production fixture/options retain exact source identities and integrity", () => {
  assert.equal(typeof harness.buildScenarioFrame, "function");
  for (const scenario of buildTimeSeriesScenarioMatrix()) {
    const frame = harness.buildScenarioFrame(scenario);
    const option = harness.buildScenarioOption(scenario, frame);
    const evidence = harness.inspectScenarioEvidence(scenario, frame, option);
    assert.equal(evidence.inputObservations, scenario.points);
    assert.equal(evidence.renderedVertices, scenario.points);
    assert.equal(evidence.seriesEvidence.length, scenario.seriesCount);
    for (const series of evidence.seriesEvidence) {
      assert.equal(series.inputCount, scenario.points / scenario.seriesCount);
      assert.equal(series.renderedCount, series.inputCount);
      assert.equal(series.missingYCount, series.inputCount / 100);
      assert.equal(series.duplicateXPairs, series.inputCount / 2);
      assert.equal(series.rowIdsExact, true);
      assert.equal(series.missingYExact, true);
      assert.equal(series.markerMode, scenario.markerMode);
      assert.equal(series.sampling, "none");
    }
    const broken = { ...option, series: (option.series as unknown[]).slice(1) };
    assert.throws(() => harness.inspectScenarioEvidence(scenario, frame, broken));
  }
});

test("cold timer includes adapter/option construction and coherent frame wait", async () => {
  assert.equal(typeof harness.measureColdFrame, "function");
  let clock = 0;
  const result = await harness.measureColdFrame(
    () => { clock += 30; return {}; },
    () => { clock += 20; },
    async (startedAt: number) => { await Promise.resolve(); clock += 10; return clock - startedAt; },
    () => clock,
  );
  assert.equal(result.coherentFrameMs, 60);
});

test("patch pump coalesces latest bounds and uses production lazy/silent options", () => {
  assert.equal(typeof harness.createAxisPatchPump, "function");
  const frames: Array<() => void> = [];
  const calls: unknown[] = [];
  const pump = harness.createAxisPatchPump((...args: unknown[]) => calls.push(args), (callback: () => void) => { frames.push(callback); return frames.length; });
  pump({ xAxis: { min: 0, max: 100 } });
  pump({ xAxis: { min: 20, max: 80 } });
  assert.equal(frames.length, 1);
  frames.shift()!();
  assert.deepEqual(calls, [[{ xAxis: { min: 20, max: 80 }, animation: false }, { lazyUpdate: true, silent: true }]]);
  pump({ xAxis: { min: 30, max: 90 } });
  frames.shift()!();
  assert.equal(calls.length, 2);
});

test("heap snapshots retain diagnostics across phases but cannot masquerade as a peak", () => {
  assert.equal(typeof harness.createHeapSampler, "function");
  let bytes: number | null = 10 * 1024 * 1024;
  const sampler = harness.createHeapSampler(() => bytes);
  sampler.sample("before-adapter");
  bytes = 30 * 1024 * 1024;
  sampler.sample("after-option");
  bytes = 12 * 1024 * 1024;
  sampler.sample("after-interactions");
  const result = sampler.finish();
  assert.equal(result.peakHeapMb, null);
  assert.equal(result.heapEvidence.supported, false);
  assert.equal(result.heapEvidence.observedHighWaterMb, 30);
  assert.equal(result.heapEvidence.samples.length, 3);
  const absent = harness.createHeapSampler(() => null);
  absent.sample("before-adapter");
  assert.equal(absent.finish().heapEvidence.observedHighWaterMb, null);
});

test("cursor timing waits for exact visible tooltip update and rejects no-op/wrong identity", async () => {
  assert.equal(typeof harness.waitForTooltipUpdate, "function");
  let clock = 0;
  let content = "Source: reading_1<br>Row: 10";
  const expected = "Source: reading_4<br>Row: 225018";
  const timing = await harness.waitForTooltipUpdate(expected, () => content, async () => { clock += 10; content = expected; }, () => clock, 0, 50);
  assert.equal(timing, 10);
  for (const invalid of [null, "Source: reading_4<br>Row: 225019", "Source: reading_1<br>Row: 225018"]) {
    clock = 0;
    await assert.rejects(harness.waitForTooltipUpdate(expected, () => invalid, async () => { clock += 10; }, () => clock, 0, 50), /tooltip/i);
  }
});

test("tooltip timeout does not depend on animation frames continuing", async () => {
  const wait = harness.waitForTooltipUpdate(
    "expected",
    () => null,
    () => new Promise<void>(() => {}),
    () => performance.now(),
    performance.now(),
    20,
  );
  await assert.rejects(Promise.race([
    wait,
    new Promise((_, reject) => setTimeout(() => reject(new Error("RAF-independent guard expired")), 250)),
  ]), /Tooltip did not update/);
});

test("patch timing arms frame observation inside the flush and rejects a no-op axis update", async () => {
  assert.equal(typeof harness.measureFramePatch, "function");
  const frames: Array<() => void> = [];
  const events: string[] = [];
  const option = { xAxis: { min: 20, max: 80 } };
  let installed = { xAxis: [{ min: 0, max: 100 }] };
  const chart = {
    getOption: () => installed,
    setOption: (patch: typeof option) => { events.push("setOption"); installed = { xAxis: [patch.xAxis] }; },
  };
  const wait = async () => { events.push("wait"); await Promise.resolve(); return 1; };
  const pending = harness.measureFramePatch(chart, option, wait, (callback: () => void) => { frames.push(callback); return frames.length; });
  assert.deepEqual(events, []);
  assert.equal(frames.length, 1);
  frames.shift()!();
  assert.equal(await pending, 1);
  assert.deepEqual(events, ["wait", "setOption"]);
  installed = { xAxis: [{ min: 0, max: 100 }] };
  chart.setOption = () => {};
  const noOp = harness.measureFramePatch(chart, option, wait, (callback: () => void) => { frames.push(callback); return frames.length; });
  frames.shift()!();
  await assert.rejects(noOp, /axis patch/i);
});

test("browser diagnostic provenance cannot obtain or assert qualification authority", () => {
  assert.equal(typeof harness.benchmarkProvenance, "function");
  const provenance = harness.benchmarkProvenance();
  assert.equal(provenance.targetQualified, false);
  assert.equal(provenance.nativeAttestation.supported, false);
  assert.equal("nonce" in provenance, false);
  assert.equal("run" in provenance, false);
});

test("cursor collector exposes a coordinate-to-model-to-visible-tooltip probe", () => {
  assert.equal(typeof harness.measureCursorProbe, "function");
});