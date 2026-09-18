import { cpus, platform, release, arch } from "node:os";
import * as fs from "node:fs/promises";
import { dirname, resolve } from "node:path";

export const TIME_SERIES_BENCHMARK_THRESHOLDS = Object.freeze({
  coherentFrameMs: 2_000,
  longestTaskMs: 200,
  zoomP95Ms: 100,
  panP95Ms: 100,
  cursorP95Ms: 50,
  peakHeapMb: 512,
});

export const TIME_SERIES_POINT_COUNTS = Object.freeze([8_000, 50_000, 100_000, 300_000]);
export const TIME_SERIES_SERIES_COUNTS = Object.freeze([1, 4]);
export const TIME_SERIES_MARKER_MODES = Object.freeze(["auto", "show"]);
export const TIME_SERIES_DEFAULT_GATE = Object.freeze({
  points: 300_000,
  seriesCount: 1,
  markerMode: "auto",
});

const METRIC_KEYS = Object.freeze(Object.keys(TIME_SERIES_BENCHMARK_THRESHOLDS));
const validMetric = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
const validSamples = (values) => Array.isArray(values) && values.length > 0 && values.every(validMetric);
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value) => typeof value === "string" && value.length > 0 && value.length <= 16_384;
const reportText = (value) => text(value) ? value.replaceAll("|", "\\|").replaceAll("\n", " ").replaceAll("\r", " ") : "unsupported";

function validReportMetadata(payload) {
  if (!record(payload) || !record(payload.environment)
    || !["userAgent", "appVersion", "appBuild", "echartsVersion", "targetQualification"].every((key) => text(payload.environment[key]))
    || typeof payload.reportDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(payload.reportDate)) return false;
  const date = new Date(`${payload.reportDate}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === payload.reportDate;
}

export function evaluateTimeSeriesCandidate(metrics) {
  const failedMetrics = [];
  for (const metric of METRIC_KEYS) {
    const value = metrics?.[metric];
    if (!validMetric(value) || value > TIME_SERIES_BENCHMARK_THRESHOLDS[metric]) {
      failedMetrics.push(metric);
    }
  }
  return {
    passed: failedMetrics.length === 0,
    failedMetrics,
  };
}

export function percentile(values, percentileRank) {
  if (!validSamples(values)) return Number.NaN;
  const finite = [...values].sort((left, right) => left - right);
  const index = Math.min(finite.length - 1, Math.max(0, Math.ceil((percentileRank / 100) * finite.length) - 1));
  return finite[index];
}

export function scenarioId({ points, seriesCount, markerMode }) {
  return `${points}-points-${seriesCount}-series-marker-${markerMode}`;
}

export function buildTimeSeriesScenarioMatrix() {
  const scenarios = [];
  for (const points of TIME_SERIES_POINT_COUNTS) {
    for (const seriesCount of TIME_SERIES_SERIES_COUNTS) {
      for (const markerMode of TIME_SERIES_MARKER_MODES) {
        scenarios.push({
          id: scenarioId({ points, seriesCount, markerMode }),
          points,
          seriesCount,
          markerMode,
          duplicateX: true,
          missingYRate: 0.01,
        });
      }
    }
  }
  return scenarios;
}

export function summarizeRendererMeasurements(measurements) {
  const coherentFrameMs = percentile(measurements.map((row) => row.coherentFrameMs), 50);
  const maximum = (values) => validSamples(values) ? Math.max(...values) : Number.NaN;
  const pooled = (key) => measurements.length > 0 && measurements.every((row) => validSamples(row[key]))
    ? measurements.flatMap((row) => row[key]) : [Number.NaN];
  const longestTaskMs = maximum(measurements.map((row) => row.longestTaskMs));
  const zoomP95Ms = percentile(pooled("zoomSamplesMs"), 95);
  const panP95Ms = percentile(pooled("panSamplesMs"), 95);
  const cursorP95Ms = percentile(pooled("cursorSamplesMs"), 95);
  const heapSamples = measurements.map((row) => row.peakHeapMb);
  const peakHeapMb = maximum(heapSamples);
  return { coherentFrameMs, longestTaskMs, zoomP95Ms, panP95Ms, cursorP95Ms, peakHeapMb };
}

export function matchesBoundRun(evidence, boundRun) {
  return !!boundRun && ["runId", "nonce", "origin", "appBuild"].every((key) =>
    typeof boundRun[key] === "string" && boundRun[key].length > 0 && evidence?.[key] === boundRun[key]);
}

function validateScenario(row, scenario) {
  if (!row) return ["missing scenario"];
  const failures = [];
  if (row.error != null || row.run !== 1) failures.push("invalid run/error");
  for (const key of ["points", "seriesCount", "markerMode", "duplicateX", "missingYRate"]) {
    if (row[key] !== scenario[key]) failures.push(key);
  }
  if (row.inputObservations !== scenario.points || row.renderedVertices !== scenario.points) failures.push("observation counts");
  const perSeries = scenario.points / scenario.seriesCount;
  const evidence = row.seriesEvidence;
  if (!Array.isArray(evidence) || evidence.length !== scenario.seriesCount || !evidence.every((series, index) =>
    series?.source === `reading_${index + 1}` && series.inputCount === perSeries && series.renderedCount === perSeries
    && series.missingYCount === perSeries / 100 && series.duplicateXPairs === perSeries / 2
    && series.rowIdsExact === true && series.missingYExact === true && series.sampling === "none"
    && series.type === "line" && series.animation === false && series.progressive === 0
    && series.markerMode === scenario.markerMode)) failures.push("series integrity");
  for (const key of ["coherentFrameMs", "longestTaskMs", "peakHeapMb"]) {
    if (!validMetric(row[key])) failures.push(key);
  }
  for (const key of ["zoomSamplesMs", "panSamplesMs", "cursorSamplesMs"]) {
    if (!validSamples(row[key])) failures.push(key);
  }
  if (!Array.isArray(row.cursorVerifiedSeries) || row.cursorVerifiedSeries.length !== scenario.seriesCount
    || row.cursorVerifiedSeries.some((source, index) => source !== `reading_${index + 1}`)) failures.push("cursor identity coverage");
  if (row.heapEvidence?.supported !== true || row.heapEvidence?.method !== "v8-isolate-high-water"
    || row.heapEvidence?.precision !== "bytes" || row.heapEvidence?.coversSynchronousAllocations !== true) failures.push("unsupported heap high-water");
  return failures;
}

export function evaluateBenchmarkPayload(payload, boundRun) {
  const failures = [];
  if (!validReportMetadata(payload)) failures.push("invalid report metadata");
  const results = Array.isArray(payload?.results) ? payload.results : [];
  const matrix = buildTimeSeriesScenarioMatrix();
  if (payload?.dryRun !== false) failures.push("dry run or absent run mode");
  if (payload?.error != null || (payload?.errors != null && (!Array.isArray(payload.errors) || payload.errors.length > 0))) failures.push("run errors");
  if (!matchesBoundRun(payload?.run, boundRun) || !matchesBoundRun(payload?.targetEvidence, boundRun)) failures.push("unbound run");
  const targetQualified = payload?.targetQualified === true && payload?.targetEvidence?.platform === "windows"
    && payload?.targetEvidence?.runtime === "webview2";
  if (!targetQualified) failures.push("target evidence not qualified");
  if (results.length !== matrix.length || new Set(results.map((row) => row?.scenarioId)).size !== matrix.length
    || results.some((row) => !matrix.some((scenario) => scenario.id === row?.scenarioId))) failures.push("incomplete or duplicate scenario matrix");
  const scenarioRows = [];
  for (const scenario of matrix) {
    const rows = results.filter((row) => row?.scenarioId === scenario.id);
    const metrics = summarizeRendererMeasurements(rows);
    const integrityFailures = rows.length === 1 ? validateScenario(rows[0], scenario) : ["expected one scenario run"];
    const isGate = Object.entries(TIME_SERIES_DEFAULT_GATE).every(([key, value]) => scenario[key] === value);
    const policy = evaluateTimeSeriesCandidate(metrics);
    if (integrityFailures.length) failures.push(`${scenario.id}: ${integrityFailures.join(", ")}`);
    scenarioRows.push({
      ...scenario,
      runs: rows.length,
      metrics,
      policy: isGate ? policy : { passed: integrityFailures.length === 0, failedMetrics: [], thresholdApplied: false },
      integrityFailures,
      isGate,
      backend: payload.backendMetrics?.find((row) => row.scenarioId === scenario.id) ?? null,
    });
  }
  const gate = scenarioRows.find((row) => row.points === TIME_SERIES_DEFAULT_GATE.points
    && row.seriesCount === TIME_SERIES_DEFAULT_GATE.seriesCount
    && row.markerMode === TIME_SERIES_DEFAULT_GATE.markerMode);
  const gatePassed = !!gate && gate.runs > 0 && gate.policy.passed;
  if (!gatePassed) failures.push("approved default-marker gate failed");
  const rendererAccepted = gatePassed && failures.length === 0;
  return {
    rendererAccepted,
    exitCode: rendererAccepted ? 0 : 1,
    failures,
    rendererDecision: rendererAccepted ? "ECharts Canvas series-line" : "PENDING TARGET WINDOWS WEBVIEW",
    gate,
    scenarios: scenarioRows,
  };
}

export function environmentSummary({ userAgent = "unreported", appVersion = "unreported", appBuild = "unavailable", echartsVersion = "unreported", targetQualification = "PENDING TARGET WINDOWS WEBVIEW" } = {}) {
  return {
    os: `${platform()} ${release()} (${arch()})`,
    cpu: `${cpus()[0]?.model ?? "unreported"} (${cpus().length} logical processors)`,
    userAgent: reportText(userAgent),
    appVersion: reportText(appVersion),
    appBuild: reportText(appBuild),
    echartsVersion: reportText(echartsVersion),
    targetQualification: reportText(targetQualification),
  };
}

export async function publishBenchmarkArtifacts(payload, { directory, boundRun, filesystem = fs }) {
  let staging;
  let evaluation = JSON.parse(JSON.stringify(evaluateBenchmarkPayload(payload, boundRun)));
  try {
    const markdown = renderMarkdownReport(payload, evaluation);
    const raw = `${JSON.stringify({ ...payload, evaluation }, null, 2)}\n`;
    await filesystem.mkdir(dirname(directory), { recursive: true });
    staging = await filesystem.mkdtemp(`${directory}.non-final-`);
    await filesystem.writeFile(resolve(staging, "raw.json"), raw, { encoding: "utf8", flag: "wx" });
    await filesystem.writeFile(resolve(staging, "report.md"), markdown, { encoding: "utf8", flag: "wx" });
    await filesystem.rename(staging, directory);
    return { published: true, directory, evaluation, exitCode: evaluation.exitCode };
  } catch (error) {
    evaluation = {
      ...evaluation,
      rendererAccepted: false,
      targetQualified: false,
      exitCode: 1,
      rendererDecision: "PENDING TARGET WINDOWS WEBVIEW",
      failures: [...(evaluation.failures ?? []), `artifact publication failed: ${String(error)}`],
    };
    if (staging) {
      try {
        await filesystem.rm(staging, { recursive: true, force: true });
        staging = undefined;
      } catch {
        evaluation.failures.push("non-final staging cleanup failed; staging is not published evidence");
      }
    }
    return { published: false, nonFinalDirectory: staging, evaluation, exitCode: 1 };
  }
}

export function createOwnedProcessCleanup(launchedProcess, { inventory, terminateProcess }) {
  const owner = Object.freeze({ ...launchedProcess });
  let terminated = false;
  return async () => {
    if (terminated) return;
    if (!Number.isInteger(owner.pid) || owner.pid <= 0 || !Number.isInteger(owner.parentPid)
      || !text(owner.startedAt)) throw new Error("Uncertain launch ownership; refusing cleanup");
    const processes = await inventory();
    if (!Array.isArray(processes) || processes.some((item) => !Number.isInteger(item?.pid)
      || !Number.isInteger(item?.parentPid) || !text(item?.startedAt))
      || new Set(processes.map((item) => item.pid)).size !== processes.length) {
      throw new Error("Invalid process inventory; refusing cleanup");
    }
    const current = processes.find((item) => item.pid === owner.pid);
    if (!current || current.startedAt !== owner.startedAt || current.parentPid !== owner.parentPid) {
      throw new Error("Launch process ownership changed; refusing cleanup");
    }
    await terminateProcess(owner.pid);
    terminated = true;
  };
}

export function formatMetric(value) {
  return Number.isFinite(value) ? Number(value).toFixed(1) : "unsupported";
}

export function renderMarkdownReport(payload, evaluation = evaluateBenchmarkPayload(payload)) {
  payload = record(payload) ? payload : {};
  const env = environmentSummary(record(payload.environment) ? payload.environment : {});
  const date = reportText(payload.reportDate);
  const thresholdRows = METRIC_KEYS
    .map((metric) => `| ${metric} | ${TIME_SERIES_BENCHMARK_THRESHOLDS[metric]} |`)
    .join("\n");
  const scenarioRows = evaluation.scenarios
    .map((row) => `| ${row.points.toLocaleString("en-US")} | ${row.seriesCount} | ${row.markerMode} | ${row.runs} | ${formatMetric(row.metrics.coherentFrameMs)} | ${formatMetric(row.metrics.longestTaskMs)} | ${formatMetric(row.metrics.zoomP95Ms)} | ${formatMetric(row.metrics.panP95Ms)} | ${formatMetric(row.metrics.cursorP95Ms)} | ${formatMetric(row.metrics.peakHeapMb)} | ${row.policy.passed ? "PASS" : `FAIL: ${row.policy.failedMetrics.join(", ") || "missing measurements"}`} |`)
    .join("\n");
  const backendRows = (payload.backendMetrics ?? [])
    .map((row) => `| ${row.scenarioId} | ${row.sourceRows} | ${row.processedRows} | ${row.chunks} | ${row.transferredBytes} | ${row.queryMs} | ${row.encodeMs} | ${row.projectionPasses} | ${row.invalidXCount} |`)
    .join("\n") || "| Not collected | | | | | | | | |";

  return `# Time Series Renderer Qualification - ${date}

Renderer decision: ${evaluation.rendererDecision}

Qualification exit code: ${evaluation.exitCode}. Dry run: ${payload.dryRun === true}.

${evaluation.failures.length ? `Evidence failures:\n${evaluation.failures.map((failure) => `- ${failure}`).join("\n")}` : "Complete bound evidence passed."}

This report measures the production Time Series option/adapter path with full-resolution ECharts Canvas line series. Unsupported metrics are recorded as unsupported and do not qualify the renderer.

## Environment

| Item | Value |
| --- | --- |
| OS | ${env.os.replaceAll("|", "\\|")} |
| CPU | ${env.cpu.replaceAll("|", "\\|")} |
| User agent | ${env.userAgent.replaceAll("|", "\\|")} |
| App version | ${env.appVersion} |
| App build | ${env.appBuild} |
| ECharts | ${env.echartsVersion} |
| Target qualification | ${env.targetQualification} |

## Hard Gate Thresholds

| Metric | Limit |
| --- | ---: |
${thresholdRows}

## Renderer Measurements

| Points | Series | Markers | Runs | Coherent frame ms | Longest avoidable task ms | Zoom p95 ms | Pan p95 ms | Cursor p95 ms | Peak JS heap MB | Result |
| ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
${scenarioRows}

## Backend Temporal Transfer

The backend harness reports process working set separately from JavaScript heap. Server-side full-frame buffering can make process peak memory include pending chunk buffers, JSON control messages, and the encoded frame before the renderer receives it; this is not a renderer heap pass criterion.

| Scenario | Source rows | Processed rows | Chunks | Bytes | Query ms | Encode ms | Projection passes | Invalid X count |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${backendRows}

## Host Limit

This run is ${process.platform === "win32" ? "eligible for target Windows WebView qualification" : "not a target Windows WebView qualification run"}. Do not mark renderer accepted from macOS host results.
`;
}