import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs/promises";
import { resolve } from "node:path";
import * as core from "./timeSeriesBenchmarkCore.mjs";
import { runTimeSeriesBenchmark } from "./runTimeSeriesBenchmark.mjs";

const payload = () => ({
  reportDate: "2026-09-16", dryRun: true, targetQualified: false,
  environment: { userAgent: "test", appVersion: "test", appBuild: "test", echartsVersion: "test", targetQualification: "pending" },
  backendMetrics: [], results: [],
});

test("publisher renders both artifacts before any write and atomically publishes one decision", async () => {
  assert.equal(typeof core.publishBenchmarkArtifacts, "function");
  const root = await fs.mkdtemp(resolve("test-results/benchmark-publication-"));
  try {
    const result = await core.publishBenchmarkArtifacts(payload(), { directory: resolve(root, "run") });
    assert.equal(result.published, true);
    const raw = JSON.parse(await fs.readFile(resolve(root, "run/raw.json"), "utf8"));
    const markdown = await fs.readFile(resolve(root, "run/report.md"), "utf8");
    assert.deepEqual(raw.evaluation, result.evaluation);
    assert.match(markdown, /Qualification exit code: 1/);
    assert.equal(raw.evaluation.rendererAccepted, false);
    assert.equal(result.exitCode, 1);
    assert.deepEqual(await fs.readdir(root), ["run"]);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("malformed metadata and serialization failures never leave accepted partial artifacts", async () => {
  assert.equal(typeof core.publishBenchmarkArtifacts, "function");
  const root = await fs.mkdtemp(resolve("test-results/benchmark-publication-"));
  try {
    const malformed = payload();
    malformed.environment.userAgent = {};
    const result = await core.publishBenchmarkArtifacts(malformed, { directory: resolve(root, "invalid") });
    const raw = JSON.parse(await fs.readFile(resolve(root, "invalid/raw.json"), "utf8"));
    assert.equal(result.exitCode, raw.evaluation.exitCode);
    assert.ok(raw.evaluation.failures.includes("invalid report metadata"));
    const cyclic = payload();
    cyclic.cycle = cyclic;
    const failed = await core.publishBenchmarkArtifacts(cyclic, { directory: resolve(root, "cyclic") });
    assert.equal(failed.exitCode, 1);
    assert.equal(failed.published, false);
    assert.deepEqual(await fs.readdir(root), ["invalid"]);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("each write and final rename failure leaves no final or accepted partial report", async () => {
  assert.equal(typeof core.publishBenchmarkArtifacts, "function");
  for (const failAt of ["raw.json", "report.md", "rename"]) {
    const root = await fs.mkdtemp(resolve("test-results/benchmark-publication-"));
    const filesystem = {
      ...fs,
      writeFile: async (path, ...args) => {
        if (path.endsWith(failAt)) throw new Error(`injected ${failAt} write failure`);
        return fs.writeFile(path, ...args);
      },
      rename: async (...args) => {
        if (failAt === "rename") throw new Error("injected rename failure");
        return fs.rename(...args);
      },
    };
    try {
      const result = await core.publishBenchmarkArtifacts(payload(), { directory: resolve(root, "run"), filesystem });
      assert.equal(result.published, false);
      assert.equal(result.exitCode, 1);
      assert.equal(result.evaluation.rendererAccepted, false);
      assert.match(result.evaluation.failures.join("\n"), /publication failed/);
      assert.deepEqual(await fs.readdir(root), []);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  }
});

test("publisher preserves target qualification evidence in the raw artifact", async () => {
  const root = await fs.mkdtemp(resolve("test-results/benchmark-publication-"));
  try {
    const qualified = payload();
    qualified.targetQualified = true;
    const result = await core.publishBenchmarkArtifacts(qualified, { directory: resolve(root, "run") });
    const raw = JSON.parse(await fs.readFile(resolve(root, "run/raw.json"), "utf8"));
    assert.equal(result.published, true);
    assert.equal(raw.targetQualified, true);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("owned cleanup never terminates a newly opened unrelated instance", async () => {
  assert.equal(typeof core.createOwnedProcessCleanup, "function");
  const root = { pid: 200, parentPid: 50, startedAt: "owned-start" };
  const killed = [];
  const cleanup = core.createOwnedProcessCleanup(root, {
    inventory: async () => [root, { pid: 201, parentPid: 200, startedAt: "child-start" }, { pid: 999, parentPid: 50, startedAt: "unrelated-start" }],
    terminateProcess: async (pid) => { killed.push(pid); },
  });
  await cleanup();
  assert.deepEqual(killed, [200]);
  await cleanup();
  assert.deepEqual(killed, [200]);
});

test("inventory failure or uncertain/reused ownership performs no kill", async () => {
  assert.equal(typeof core.createOwnedProcessCleanup, "function");
  const root = { pid: 200, parentPid: 50, startedAt: "owned-start" };
  for (const inventory of [
    async () => { throw new Error("inventory failed"); },
    async () => [],
    async () => [{ ...root, startedAt: "reused-pid" }],
    async () => [root, root],
    async () => [{ pid: 200 }],
  ]) {
    const killed = [];
    const cleanup = core.createOwnedProcessCleanup(root, { inventory, terminateProcess: async (pid) => killed.push(pid) });
    await assert.rejects(cleanup);
    assert.deepEqual(killed, []);
  }
});

test("runner schema/dry-run/normal decisions and publication failures agree with final artifacts", async () => {
  const root = await fs.mkdtemp(resolve("test-results/benchmark-runner-"));
  try {
    const schema = await runTimeSeriesBenchmark({ args: ["--schema"], outputRoot: root });
    assert.equal(schema.schema.scenarios.length, 16);
    assert.equal(schema.schema.nativeAttestation.supported, false);
    for (const args of [[], ["--dry-run"]]) {
      const result = await runTimeSeriesBenchmark({ args, outputRoot: root });
      const raw = JSON.parse(await fs.readFile(resolve(result.directory, "raw.json"), "utf8"));
      assert.equal(raw.targetQualified, false);
      assert.equal(raw.nativeAttestation.supported, false);
      assert.deepEqual(raw.results, []);
      assert.equal(result.qualificationExitCode, raw.evaluation.exitCode);
      assert.equal(result.exitCode, args.length ? 0 : raw.evaluation.exitCode);
      assert.match(await fs.readFile(resolve(result.directory, "report.md"), "utf8"), /Qualification exit code: 1/);
    }
    const before = await fs.readdir(root);
    const failed = await runTimeSeriesBenchmark({ args: ["--dry-run"], outputRoot: root,
      filesystem: { ...fs, rename: async () => { throw new Error("rename denied"); } } });
    assert.equal(failed.exitCode, 1);
    assert.equal(failed.published, false);
    assert.deepEqual(await fs.readdir(root), before);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("real ECharts coordinate picker resolves exact rows, includes lookup time, and rejects disabled lookup", async () => {
  const { createServer } = await import("vite");
  const { chromium } = await import("playwright");
  const server = await createServer({ configFile: false, root: resolve("."),
    cacheDir: resolve("test-results/benchmark-vite-cache"),
    resolve: { alias: { "@": resolve("src") } },
    plugins: [{
      name: "pointer-probe",
      configureServer(viteServer) {
        viteServer.middlewares.use("/pointer-probe", (_request, response) => {
          response.setHeader("content-type", "text/html");
          response.end('<!doctype html><div id="chart" style="width:1000px;height:600px"></div>');
        });
      },
    }],
    server: { host: "127.0.0.1", port: 0 }, logLevel: "error",
  });
  let browser;
  try {
    await server.listen();
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/pointer-probe`);
    const outcome = await page.evaluate(async () => {
      const harness = await import("/src/benchmarks/TimeSeriesBenchmark.tsx");
      const echarts = await import("/node_modules/echarts/index.js");
      const scenario = { id: "pointer-integration", points: 8000, seriesCount: 4, markerMode: "show", duplicateX: true, missingYRate: 0.01 };
      const option = harness.buildScenarioOption(scenario, harness.buildScenarioFrame(scenario));
      option.tooltip.className = "sp-time-series-benchmark-tooltip-pointer-integration";
      document.body.insertAdjacentHTML("beforeend", '<div class="sp-time-series-benchmark-tooltip">stale tooltip</div>');
      const selected = option.series[3].data[17];
      option.xAxis.min = selected[0] - 86_400_000;
      option.xAxis.max = selected[0] + 86_400_000;
      const chart = echarts.init(document.getElementById("chart"), undefined, { renderer: "canvas" });
      chart.setOption(option);
      await new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame)));
      const request = { id: "cursor-reading_4-2", expected: { source: "reading_4", rowId: "6018", seriesIndex: 3, dataIndex: 17 } };
      try {
        const normal = await harness.measureCursorProbe(chart, request, 1000);
        const handler = chart.getZr().handler;
        const findHover = handler.findHover;
        handler.findHover = function (...args) {
          const started = performance.now();
          while (performance.now() - started < 70) { /* Inject delay inside real picking, not the tooltip reader. */ }
          return findHover.apply(this, args);
        };
        const slow = await harness.measureCursorProbe(chart, request, 1000);
        handler.findHover = findHover;
        const dispatch = handler.dispatch;
        handler.dispatch = () => {};
        let disabled = "unexpected success";
        try { await harness.measureCursorProbe(chart, request, 250); } catch (error) { disabled = String(error); }
        handler.dispatch = dispatch;
        return { normal, slow, disabled };
      } finally { chart.dispose(); }
    });
    assert.deepEqual(outcome.normal.observed, { source: "reading_4", rowId: "6018", seriesIndex: 3, dataIndex: 17 });
    assert.equal(outcome.normal.observedTooltip, outcome.normal.expectedTooltip);
    assert.ok(outcome.slow.durationMs >= 70, `Picker work excluded: ${outcome.slow.durationMs}`);
    assert.match(outcome.disabled, /tooltip/i);
    assert.notEqual(outcome.disabled, "unexpected success");
  } finally {
    await browser?.close();
    await server.close();
  }
});