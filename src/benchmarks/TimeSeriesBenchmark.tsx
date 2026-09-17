import { useEffect, useRef, useState } from "react";
import * as echarts from "echarts";

import { buildGraph, getGraphTheme, type GraphData, type GraphSpec } from "@/graphCore";
import type { GraphDataFrame } from "@/types/graphData";

interface BenchmarkScenario {
  id: string;
  points: number;
  seriesCount: number;
  markerMode: "auto" | "show";
  duplicateX: true;
  missingYRate: 0.01;
}

interface RendererMeasurement {
  scenarioId: string;
  points: number;
  seriesCount: number;
  markerMode: "auto" | "show";
  duplicateX: true;
  missingYRate: 0.01;
  run: number;
  coherentFrameMs: number;
  longestTaskMs: number | null;
  zoomSamplesMs: number[];
  panSamplesMs: number[];
  cursorSamplesMs: number[];
  cursorVerifiedSeries: string[];
  interactionProbes: InteractionProbe[];
  peakHeapMb: number | null;
  heapEvidence: ReturnType<ReturnType<typeof createHeapSampler>["finish"]>["heapEvidence"];
  inputObservations: number;
  seriesEvidence: ReturnType<typeof inspectScenarioEvidence>["seriesEvidence"];
  renderedVertices: number;
}

const POINT_COUNTS = [8_000, 50_000, 100_000, 300_000] as const;
const SERIES_COUNTS = [1, 4] as const;
const MARKER_MODES = ["auto", "show"] as const;
const RUNS_PER_CASE = 1;
const BASE_TIME = Date.UTC(2026, 0, 1);
const DAY_MS = 86_400_000;

function scenarios(): BenchmarkScenario[] {
  const matrix: BenchmarkScenario[] = [];
  for (const points of POINT_COUNTS) {
    for (const seriesCount of SERIES_COUNTS) {
      for (const markerMode of MARKER_MODES) {
        matrix.push({
          id: `${points}-points-${seriesCount}-series-marker-${markerMode}`,
          points,
          seriesCount,
          markerMode,
          duplicateX: true,
          missingYRate: 0.01,
        });
      }
    }
  }
  return matrix;
}

function validityBitmap(rowCount: number, invalidEvery?: number): Uint8Array {
  const bytes = new Uint8Array(Math.ceil(rowCount / 8));
  for (let row = 0; row < rowCount; row += 1) {
    if (invalidEvery && (row + 1) % invalidEvery === 0) continue;
    bytes[row >> 3] |= 1 << (row & 7);
  }
  return bytes;
}

export function buildScenarioFrame(scenario: BenchmarkScenario): GraphDataFrame {
  if (scenario.points % scenario.seriesCount !== 0) {
    throw new Error(`${scenario.id} does not divide evenly across series`);
  }
  const rowsPerSeries = scenario.points / scenario.seriesCount;
  const xValidity = validityBitmap(rowsPerSeries);
  const yValidity = validityBitmap(rowsPerSeries, 100);
  const sourceValidity = validityBitmap(rowsPerSeries);
  const rawChunks: GraphDataFrame["rawChunks"] = Array.from({ length: scenario.seriesCount }, (_, seriesIndex) => {
    const xValues = new Float64Array(rowsPerSeries);
    const yValues = new Float64Array(rowsPerSeries);
    const rowIds = new BigInt64Array(rowsPerSeries);
    const sourceCodes = new Uint32Array(rowsPerSeries);
    for (let row = 0; row < rowsPerSeries; row += 1) {
      xValues[row] = BASE_TIME + Math.floor(row / 2) * DAY_MS;
      yValues[row] = Math.sin(row / 37 + seriesIndex) * 12 + seriesIndex * 5 + (row % 97) / 10;
      rowIds[row] = BigInt(seriesIndex * rowsPerSeries + row + 1);
      sourceCodes[row] = seriesIndex;
    }
    return {
      chunkIndex: seriesIndex,
      rowOffset: seriesIndex * rowsPerSeries,
      rowCount: rowsPerSeries,
      xValues,
      yValues,
      rowIds,
      sourceCodes,
      validity: {
        x: xValidity,
        y: yValidity,
        source: sourceValidity,
      },
      temporalMetadata: { unit: "epochMilliseconds", kind: "date", displayZone: "utc" },
    };
  });

  return {
    requestId: scenario.id,
    datasetId: "time-series-benchmark",
    generation: 1,
    sourceRows: scenario.points,
    processedRows: scenario.points,
    sampling: { mode: "full" },
    dictionaries: {
      source: Array.from({ length: scenario.seriesCount }, (_, index) => `reading_${index + 1}`),
    },
    extents: {
      x: { min: BASE_TIME, max: BASE_TIME + Math.floor(rowsPerSeries / 2) * DAY_MS },
      y: { min: -12, max: 36 },
    },
    rawChunks,
    aggregates: [],
    rawPointDisposition: { status: "included", validRows: scenario.points, budget: 8_000 },
    timeSeriesDisposition: { status: "included", includedRows: scenario.points, invalidXRows: 0 },
  };
}

export function buildScenarioOption(scenario: BenchmarkScenario, frame: GraphDataFrame): Record<string, unknown> {
  const spec: GraphSpec = {
    encoding: {
      x: { name: "captured_at", type: "datetime" },
      y: { name: "reading", type: "continuous" },
    },
    elements: [{
      kind: "timeSeries",
      enabled: true,
      options: {
        xInterpretation: { kind: "nativeTemporal" },
        order: "timeAscending",
        missingValues: "break",
        connection: "line",
        markerMode: scenario.markerMode,
      },
    }],
  };
  const data: GraphData = { columns: ["captured_at", "reading"], rows: [] };
  const graph = buildGraph(spec, data, getGraphTheme(), undefined, frame);
  return graph.panels[0]?.option as Record<string, unknown>;
}

function waitForCoherentFrame(chart: echarts.ECharts, startedAt: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error("ECharts did not finish within 30 seconds")), 30_000);
    const renderer = chart.getZr();
    renderer.on("rendered", function onRendered() {
      renderer.off("rendered", onRendered);
      requestAnimationFrame(() => requestAnimationFrame(() => {
        clearTimeout(timeout);
        resolve(performance.now() - startedAt);
      }));
    });
  });
}

export async function waitForTooltipUpdate(
  expected: string,
  readTooltip: () => string | null,
  nextFrame: () => Promise<void>,
  now: () => number,
  startedAt: number,
  timeoutMs: number,
): Promise<number> {
  const deadline = startedAt + timeoutMs;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(
      () => reject(new Error(`Tooltip did not update within ${timeoutMs} ms`)),
      timeoutMs,
    );
  });

  const observe = async (): Promise<number> => {
    while (now() <= deadline) {
      if (readTooltip() === expected) return now() - startedAt;
      await nextFrame();
    }
    throw new Error(`Tooltip did not update within ${timeoutMs} ms`);
  };

  try {
    return await Promise.race([observe(), timeout]);
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}

interface EvidenceSeries {
  id: string;
  name: string;
  type: string;
  sampling: string;
  animation: boolean;
  progressive: number;
  showSymbol: boolean;
  showAllSymbol: boolean;
  data: Array<[number, number | null]>;
  __timeSeriesRowIds: bigint[];
  __timeSeriesSourceColumn: string;
}

interface CursorIdentity {
  source: string;
  rowId: string;
  seriesIndex: number;
  dataIndex: number;
}

interface InteractionProbe {
  id: string;
  kind: "zoom" | "pan" | "cursor";
  enabled: true;
  lookup: "axis-patch" | "zrender-pointer";
  expected: CursorIdentity | { min: number; max: number };
  observed: CursorIdentity | { min: number; max: number };
  durationMs: number;
  expectedTooltip?: string;
  observedTooltip?: string;
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function readVisibleTooltip(host: HTMLElement, className: string): string | null {
  const element = host.ownerDocument.body.getElementsByClassName(className)[0] as HTMLDivElement | undefined;
  if (!element) return null;
  const style = getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) <= 0) {
    return null;
  }
  return element.getBoundingClientRect().width > 0 && element.innerHTML.length > 0
    ? element.innerHTML
    : null;
}

function supportsLongTaskObserver(): boolean {
  return typeof PerformanceObserver !== "undefined"
    && PerformanceObserver.supportedEntryTypes?.includes("longtask") === true;
}

function jsHeapBytes(): number | null {
  const memory = (performance as Performance & { memory?: { usedJSHeapSize?: number } }).memory;
  return typeof memory?.usedJSHeapSize === "number" ? memory.usedJSHeapSize : null;
}

export function createHeapSampler(readBytes: () => number | null = jsHeapBytes) {
  const samples: Array<{ phase: string; atMs: number; bytes: number | null }> = [];
  let observedHighWaterMb: number | null = null;
  let sampleCount = 0;
  return {
    sample(phase: string) {
      const raw = readBytes();
      const bytes = typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : null;
      sampleCount += 1;
      if (bytes !== null) {
        const mb = bytes / (1024 * 1024);
        observedHighWaterMb = Math.max(observedHighWaterMb ?? 0, mb);
      }
      if (phase !== "interval" || samples.length < 512) {
        samples.push({ phase, atMs: performance.now(), bytes });
      }
    },
    finish() {
      return {
        peakHeapMb: null,
        heapEvidence: {
          supported: false,
          method: "performance.memory snapshots",
          precision: "unspecified/cached",
          coversSynchronousAllocations: false,
          cadenceMs: 16,
          sampleCount,
          observedHighWaterMb,
          samples,
          reason:
            "No trustworthy isolate high-water API exposed. Main-thread polling misses synchronous peaks, may be cached/quantized, and excludes non-JS backing storage.",
        },
      };
    },
  };
}

export async function measureColdFrame(
  build: () => Record<string, unknown>,
  draw: (option: Record<string, unknown>) => void,
  wait: (startedAt: number) => Promise<number>,
  now: () => number = () => performance.now(),
): Promise<{ option: Record<string, unknown>; coherentFrameMs: number }> {
  const startedAt = now();
  const option = build();
  const frame = wait(startedAt);
  draw(option);
  return { option, coherentFrameMs: await frame };
}

export function createAxisPatchPump(
  setOption: (patch: Record<string, unknown>, settings: { lazyUpdate: true; silent: true }) => void,
  schedule: (callback: () => void) => number = requestAnimationFrame,
) {
  let pending: Record<string, unknown> | null = null;
  let scheduled = false;
  return (patch: Record<string, unknown>) => {
    pending = patch;
    if (scheduled) return;
    scheduled = true;
    schedule(() => {
      scheduled = false;
      const latest = pending;
      pending = null;
      if (latest) {
        setOption({ ...latest, animation: false }, { lazyUpdate: true, silent: true });
      }
    });
  };
}

export function inspectScenarioEvidence(
  scenario: BenchmarkScenario,
  frame: GraphDataFrame,
  option: Record<string, unknown>,
  renderedCounts?: number[],
): {
  inputObservations: number;
  renderedVertices: number;
  seriesEvidence: Array<{
    source: string;
    inputCount: number;
    renderedCount: number;
    missingYCount: number;
    duplicateXPairs: number;
    rowIdsExact: true;
    missingYExact: true;
    type: string;
    sampling: string;
    animation: boolean;
    progressive: number;
    markerMode: "auto" | "show";
  }>;
} {
  const series = option.series as EvidenceSeries[];
  if (!Array.isArray(series) || series.length !== scenario.seriesCount) {
    throw new Error("Series count mismatch");
  }

  const seriesEvidence = series.map((item, seriesIndex) => {
    const chunk = frame.rawChunks[seriesIndex];
    const expectedCount = scenario.points / scenario.seriesCount;
    if (!chunk || chunk.rowCount !== expectedCount || item.data.length !== expectedCount || item.__timeSeriesRowIds.length !== expectedCount) {
      throw new Error("Observation count mismatch");
    }

    let missingYCount = 0;
    let duplicateXPairs = 0;
    for (let row = 0; row < expectedCount; row += 1) {
      const expectedX = BASE_TIME + Math.floor(row / 2) * DAY_MS;
      const expectedMissingY = (row + 1) % 100 === 0;
      const expectedRowId = BigInt(seriesIndex * expectedCount + row + 1);
      const actual = item.data[row];
      const actualX = actual[0];
      const actualY = actual[1];
      const yValid = (chunk.validity.y[row >> 3] & (1 << (row & 7))) !== 0;
      if (actualX !== expectedX || actualX !== chunk.xValues[row]) {
        throw new Error("X integrity mismatch");
      }
      if (expectedMissingY !== !yValid) {
        throw new Error("Y validity mismatch");
      }
      if (actualY !== (expectedMissingY ? null : chunk.yValues[row])) {
        throw new Error("Y value mismatch");
      }
      if (chunk.rowIds[row] !== expectedRowId || item.__timeSeriesRowIds[row] !== expectedRowId) {
        throw new Error("Row identity mismatch");
      }
      if (chunk.sourceCodes?.[row] !== seriesIndex) {
        throw new Error("Source identity mismatch");
      }
      if (expectedMissingY) missingYCount += 1;
      if (row % 2 === 1 && item.data[row - 1][0] === actualX) duplicateXPairs += 1;
    }

    const expectedSource = `reading_${seriesIndex + 1}`;
    const expectedShow = scenario.markerMode === "show";
    if (
      item.__timeSeriesSourceColumn !== expectedSource
      || item.type !== "line"
      || item.sampling !== "none"
      || item.animation !== false
      || item.progressive !== 0
      || item.showSymbol !== expectedShow
    ) {
      throw new Error("Renderer style integrity mismatch");
    }

    const renderedCount = renderedCounts?.[seriesIndex] ?? item.data.length;
    if (renderedCount !== expectedCount) {
      throw new Error("Rendered model count mismatch");
    }

    return {
      source: expectedSource,
      inputCount: expectedCount,
      renderedCount,
      missingYCount,
      duplicateXPairs,
      rowIdsExact: true as const,
      missingYExact: true as const,
      type: item.type,
      sampling: item.sampling,
      animation: item.animation,
      progressive: item.progressive,
      markerMode: scenario.markerMode,
    };
  });

  return {
    inputObservations: frame.rawChunks.reduce((sum, chunk) => sum + chunk.rowCount, 0),
    renderedVertices: seriesEvidence.reduce((sum, row) => sum + row.renderedCount, 0),
    seriesEvidence,
  };
}

export async function measureFramePatch(
  chart: Pick<echarts.ECharts, "setOption" | "getOption">,
  option: Record<string, unknown>,
  wait: (startedAt: number) => Promise<number> = (startedAt) => waitForCoherentFrame(chart as echarts.ECharts, startedAt),
  schedule: (callback: () => void) => number = requestAnimationFrame,
): Promise<number> {
  const startedAt = performance.now();
  return new Promise<number>((resolve, reject) => {
    const pump = createAxisPatchPump((patch, settings) => {
      const frame = wait(startedAt);
      try {
        chart.setOption(patch, settings);
      } catch (error) {
        frame.catch(() => undefined);
        reject(error);
        return;
      }
      frame.then((elapsed) => {
        try {
          const expected = option.xAxis as { min: number; max: number } | undefined;
          const xAxis = chart.getOption().xAxis as Array<{ min: number; max: number }> | undefined;
          const observed = Array.isArray(xAxis) ? xAxis[0] : undefined;
          if (
            expected
            && (!observed || observed.min !== expected.min || observed.max !== expected.max)
          ) {
            throw new Error("Axis patch did not update expected bounds");
          }
          resolve(elapsed);
        } catch (error) {
          reject(error);
        }
      }).catch(reject);
    }, schedule);
    pump(option);
    pump(option);
  });
}

export function benchmarkProvenance(): {
  dryRun: false;
  targetQualified: false;
  nativeAttestation: { supported: false; reason: string };
} {
  return {
    dryRun: false,
    targetQualified: false,
    nativeAttestation: {
      supported: false,
      reason: "Browser diagnostics have no native qualification authority",
    },
  };
}

export async function measureCursorProbe(
  chart: echarts.ECharts,
  request: { id: string; expected: CursorIdentity },
  timeoutMs = 2_000,
): Promise<InteractionProbe> {
  const option = chart.getOption();
  const series = option.series as EvidenceSeries[];
  const item = series[request.expected.seriesIndex];
  const dataPoint = item?.data?.[request.expected.dataIndex];
  if (!item || !dataPoint || dataPoint[1] === null) {
    throw new Error("Cursor probe has no finite observation");
  }

  const tooltipOption = option.tooltip as { className?: string; formatter(params: unknown): string } | Array<{ className?: string; formatter(params: unknown): string }>;
  const tooltipConfig = Array.isArray(tooltipOption) ? tooltipOption[0] : tooltipOption;
  const formatter = tooltipConfig.formatter;
  const tooltipClassName = tooltipConfig.className;
  if (typeof tooltipClassName !== "string" || tooltipClassName.length === 0) {
    throw new Error("Cursor probe requires an isolated tooltip class");
  }
  const expectedNode = document.createElement("div");
  expectedNode.innerHTML = formatter({
    seriesId: item.id,
    seriesName: item.name,
    dataIndex: request.expected.dataIndex,
    data: dataPoint,
  });
  const expectedTooltip = expectedNode.innerHTML;
  if (!expectedTooltip.includes(`Source: ${request.expected.source}<br>`) || !expectedTooltip.endsWith(`Row: ${request.expected.rowId}`)) {
    throw new Error("Expected tooltip identity mismatch");
  }

  const renderer = chart.getZr();
  const handler = renderer.handler as { dispatch: (eventName: string, payload: { zrX: number; zrY: number }) => void };
  handler.dispatch("mousemove", { zrX: -10, zrY: -10 });
  chart.dispatchAction({ type: "hideTip" });
  const hiddenStartedAt = performance.now();
  while (readVisibleTooltip(chart.getDom(), tooltipClassName) !== null) {
    if (performance.now() - hiddenStartedAt > timeoutMs) {
      throw new Error("Tooltip did not clear before pointer probe");
    }
    await nextFrame();
  }

  let observed: CursorIdentity | null = null;
  const onShowTip = (event: unknown) => {
    const payload = event as { seriesIndex?: number; dataIndex?: number; dataIndexInside?: number };
    if (!Number.isInteger(payload.seriesIndex) || !Number.isInteger(payload.dataIndex)) return;
    const seriesIndex = payload.seriesIndex as number;
    const model = (chart as unknown as {
      getModel(): { getSeriesByIndex(index: number): { getData(): { getRawIndex(index: number): number } } };
    }).getModel();
    const rawDataIndex = Number.isInteger(payload.dataIndexInside)
      ? model.getSeriesByIndex(seriesIndex).getData().getRawIndex(payload.dataIndexInside as number)
      : (payload.dataIndex as number);
    const resolvedSeries = (chart.getOption().series as EvidenceSeries[])[seriesIndex];
    const rowId = resolvedSeries?.__timeSeriesRowIds?.[rawDataIndex];
    if (rowId == null) return;
    observed = {
      source: resolvedSeries.__timeSeriesSourceColumn,
      rowId: String(rowId),
      seriesIndex,
      dataIndex: rawDataIndex,
    };
  };

  chart.on("showTip", onShowTip as (event: unknown) => void);
  const startedAt = performance.now();
  try {
    const pixel = chart.convertToPixel({ seriesIndex: request.expected.seriesIndex }, dataPoint as number[]);
    if (!Array.isArray(pixel) || pixel.length < 2 || !Number.isFinite(pixel[0]) || !Number.isFinite(pixel[1])) {
      throw new Error("Unable to resolve probe coordinate");
    }

    handler.dispatch("mousemove", { zrX: pixel[0], zrY: pixel[1] });
    const durationMs = await waitForTooltipUpdate(
      expectedTooltip,
      () => {
        if (!observed) return null;
        if (
          observed.source !== request.expected.source
          || observed.rowId !== request.expected.rowId
          || observed.seriesIndex !== request.expected.seriesIndex
          || observed.dataIndex !== request.expected.dataIndex
        ) {
          return null;
        }
        return readVisibleTooltip(chart.getDom(), tooltipClassName);
      },
      nextFrame,
      () => performance.now(),
      startedAt,
      timeoutMs,
    );

    if (!observed) {
      throw new Error("Tooltip identity was not observed");
    }
    const observedTooltip = readVisibleTooltip(chart.getDom(), tooltipClassName);
    if (observedTooltip !== expectedTooltip) {
      throw new Error("Tooltip content did not stabilize to expected identity");
    }
    return {
      id: request.id,
      kind: "cursor",
      enabled: true,
      lookup: "zrender-pointer",
      expected: request.expected,
      observed,
      durationMs,
      expectedTooltip,
      observedTooltip,
    };
  } finally {
    chart.off("showTip", onShowTip as (event: unknown) => void);
  }
}

async function measureCase(host: HTMLDivElement, scenario: BenchmarkScenario, run: number): Promise<RendererMeasurement> {
  const fixture = buildScenarioFrame(scenario);
  const heap = createHeapSampler();
  heap.sample("before-adapter");
  const heapInterval = window.setInterval(() => heap.sample("interval"), 16);

  const longTasks: number[] = [];
  const observer = supportsLongTaskObserver()
    ? new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) longTasks.push(entry.duration);
    })
    : null;
  observer?.observe({ entryTypes: ["longtask"] });

  const chart = echarts.init(host, undefined, { renderer: "canvas" });
  try {
    const { option, coherentFrameMs } = await measureColdFrame(
      () => {
        const built = buildScenarioOption(scenario, fixture);
        const tooltip = built.tooltip as Record<string, unknown>;
        tooltip.className = `sp-time-series-benchmark-tooltip-${scenario.id}-${run}`;
        heap.sample("after-option");
        return built;
      },
      (built) => {
        chart.setOption(built, { notMerge: true, lazyUpdate: false });
        heap.sample("after-setOption");
      },
      (startedAt) => waitForCoherentFrame(chart, startedAt),
    );
    heap.sample("after-coherent-frame");

    const model = (chart as unknown as { getModel(): { getSeries(): Array<{ getData(): { count(): number } }> } }).getModel();
    const evidence = inspectScenarioEvidence(
      scenario,
      fixture,
      chart.getOption() as Record<string, unknown>,
      model.getSeries().map((row) => row.getData().count()),
    );

    const zoomSamplesMs: number[] = [];
    const panSamplesMs: number[] = [];
    const interactionProbes: InteractionProbe[] = [];
    const span = scenario.points * DAY_MS / scenario.seriesCount / 2;
    for (const [minRatio, maxRatio] of [[0.05, 0.95], [0.1, 0.9], [0.2, 0.8], [0.3, 0.7], [0, 1]]) {
      const expected = { min: BASE_TIME + minRatio * span, max: BASE_TIME + maxRatio * span };
      const durationMs = await measureFramePatch(chart, { xAxis: expected });
      zoomSamplesMs.push(durationMs);
      const actual = (chart.getOption().xAxis as Array<{ min: number; max: number }>)[0];
      interactionProbes.push({
        id: `zoom-${zoomSamplesMs.length}`,
        kind: "zoom",
        enabled: true,
        lookup: "axis-patch",
        expected,
        observed: { min: actual.min, max: actual.max },
        durationMs,
      });
      heap.sample("zoom");
    }

    for (const offset of [0.1, 0.15, 0.2, 0.25, 0.3]) {
      const expected = { min: BASE_TIME + offset * span, max: BASE_TIME + (offset + 0.5) * span };
      const durationMs = await measureFramePatch(chart, { xAxis: expected });
      panSamplesMs.push(durationMs);
      const actual = (chart.getOption().xAxis as Array<{ min: number; max: number }>)[0];
      interactionProbes.push({
        id: `pan-${panSamplesMs.length}`,
        kind: "pan",
        enabled: true,
        lookup: "axis-patch",
        expected,
        observed: { min: actual.min, max: actual.max },
        durationMs,
      });
      heap.sample("pan");
    }
    await measureFramePatch(chart, { xAxis: { min: BASE_TIME, max: BASE_TIME + span } });

    const cursorSamplesMs: number[] = [];
    const cursorVerifiedSeries: string[] = [];
    const series = option.series as EvidenceSeries[];
    const indexes = [0, 17, 101, Math.max(0, Math.floor((scenario.points / scenario.seriesCount) / 2)), Math.max(0, Math.floor((scenario.points / scenario.seriesCount) * 0.95))];
    for (let seriesIndex = 0; seriesIndex < series.length; seriesIndex += 1) {
      for (const [probeIndex, dataIndex] of indexes.entries()) {
        const probe = await measureCursorProbe(chart, {
          id: `cursor-reading_${seriesIndex + 1}-${probeIndex + 1}`,
          expected: {
            source: `reading_${seriesIndex + 1}`,
            rowId: String(seriesIndex * (scenario.points / scenario.seriesCount) + dataIndex + 1),
            seriesIndex,
            dataIndex,
          },
        });
        interactionProbes.push(probe);
        cursorSamplesMs.push(probe.durationMs);
        heap.sample("cursor");
      }
      cursorVerifiedSeries.push(`reading_${seriesIndex + 1}`);
    }

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    observer?.takeRecords().forEach((entry) => longTasks.push(entry.duration));
    heap.sample("after-interactions");
    const heapResult = heap.finish();
    return {
      scenarioId: scenario.id,
      points: scenario.points,
      seriesCount: scenario.seriesCount,
      markerMode: scenario.markerMode,
      duplicateX: scenario.duplicateX,
      missingYRate: scenario.missingYRate,
      run,
      coherentFrameMs,
      longestTaskMs: observer ? Math.max(0, ...longTasks) : null,
      zoomSamplesMs,
      panSamplesMs,
      cursorSamplesMs,
      cursorVerifiedSeries,
      interactionProbes,
      peakHeapMb: heapResult.peakHeapMb,
      heapEvidence: heapResult.heapEvidence,
      inputObservations: evidence.inputObservations,
      seriesEvidence: evidence.seriesEvidence,
      renderedVertices: evidence.renderedVertices,
    };
  } finally {
    clearInterval(heapInterval);
    observer?.disconnect();
    chart.dispose();
  }
}

export function TimeSeriesBenchmark() {
  const hostRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState("Preparing Time Series benchmark...");
  const [output, setOutput] = useState("");

  useEffect(() => {
    let cancelled = false;
    const provenance = {
      ...benchmarkProvenance(),
      userAgent: navigator.userAgent,
      echartsVersion: echarts.version,
    };

    async function runBenchmark() {
      const host = hostRef.current;
      if (!host) return;
      const results: RendererMeasurement[] = [];
      for (const scenario of scenarios()) {
        for (let run = 1; run <= RUNS_PER_CASE; run += 1) {
          if (cancelled) return;
          setStatus(`${scenario.points.toLocaleString()} points, ${scenario.seriesCount} series, ${scenario.markerMode} markers`);
          results.push(await measureCase(host, scenario, run));
        }
      }
      const payload = { ...provenance, results };
      setOutput(JSON.stringify(payload, null, 2));
      setStatus("Diagnostics complete. Native qualification remains unsupported in browser harness.");
    }
    runBenchmark().catch(async (error: unknown) => {
      const message = error instanceof Error ? error.stack ?? error.message : String(error);
      setStatus(message);
      setOutput(JSON.stringify({ ...provenance, error: message }, null, 2));
    });
    return () => { cancelled = true; };
  }, []);

  return (
    <main style={{ height: "100vh", display: "grid", gridTemplateRows: "auto minmax(0, 1fr) 180px", gap: 12, padding: 16, boxSizing: "border-box", fontFamily: "sans-serif" }}>
      <strong>{status}</strong>
      <div ref={hostRef} style={{ minWidth: 0, minHeight: 0 }} />
      <textarea readOnly value={output} aria-label="Time Series benchmark JSON results" style={{ width: "100%", resize: "none", boxSizing: "border-box" }} />
    </main>
  );
}