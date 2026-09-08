import { useEffect, useRef, useState } from "react";
import * as echarts from "echarts";

import {
  BUDGET_CANDIDATES,
  type ScatterBudgetMeasurement,
} from "@/graphCore/scatterBudget";

interface ScatterBenchmarkResult extends ScatterBudgetMeasurement {
  scenario: "ungrouped" | "two-group" | "four-facet";
  run: number;
  grouped: boolean;
  faceted: boolean;
  setOptionMs: number;
  zoomPatchMs: number;
  brushMs: number;
}

interface BenchmarkPayload {
  userAgent: string;
  results: ScatterBenchmarkResult[];
}

interface BenchmarkFailure {
  userAgent: string;
  error: string;
}

interface BenchmarkScenario {
  name: ScatterBenchmarkResult["scenario"];
  groups: number;
  facets: number;
}

const SCENARIOS: readonly BenchmarkScenario[] = [
  { name: "ungrouped", groups: 1, facets: 1 },
  { name: "two-group", groups: 2, facets: 1 },
  { name: "four-facet", groups: 1, facets: 4 },
];
const RUNS_PER_CASE = 3;

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

function makeOption(points: number, scenario: BenchmarkScenario): echarts.EChartsOption {
  const grids = Array.from({ length: scenario.facets }, (_, index) => ({
    left: `${4 + (index % 2) * 50}%`,
    top: `${5 + Math.floor(index / 2) * 50}%`,
    width: "44%",
    height: scenario.facets === 1 ? "88%" : "39%",
    containLabel: true,
  }));
  const xAxis = grids.map((_, index) => ({ type: "value" as const, min: 0, max: 1, gridIndex: index }));
  const yAxis = grids.map((_, index) => ({ type: "value" as const, min: 0, max: 1, gridIndex: index }));
  const series: echarts.ScatterSeriesOption[] = [];
  const seriesCount = scenario.groups * scenario.facets;

  for (let seriesIndex = 0; seriesIndex < seriesCount; seriesIndex += 1) {
    const facetIndex = Math.floor(seriesIndex / scenario.groups);
    const seriesPoints = Math.floor(points / seriesCount) + (seriesIndex < points % seriesCount ? 1 : 0);
    const data = new Array<[number, number]>(seriesPoints);
    for (let pointIndex = 0; pointIndex < seriesPoints; pointIndex += 1) {
      const globalIndex = pointIndex * seriesCount + seriesIndex;
      const x = ((globalIndex * 16807) % 2147483647) / 2147483647;
      const y = ((globalIndex * 48271 + 1) % 2147483647) / 2147483647;
      data[pointIndex] = [x, y];
    }
    series.push({
      type: "scatter",
      name: scenario.groups > 1 ? `Group ${seriesIndex + 1}` : undefined,
      xAxisIndex: facetIndex,
      yAxisIndex: facetIndex,
      symbolSize: 4,
      animation: false,
      progressive: 0,
      data,
    });
  }

  return {
    animation: false,
    grid: grids,
    xAxis,
    yAxis,
    brush: { toolbox: ["rect"], brushMode: "single" },
    series,
  };
}

async function measureCase(
  host: HTMLDivElement,
  points: number,
  scenario: BenchmarkScenario,
  run: number,
): Promise<ScatterBenchmarkResult> {
  const longTasks: number[] = [];
  const observer = typeof PerformanceObserver === "undefined"
    ? null
    : new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) longTasks.push(entry.duration);
    });
  observer?.observe({ entryTypes: ["longtask"] });

  const chart = echarts.init(host, undefined, { renderer: "canvas" });
  try {
    const option = makeOption(points, scenario);
    const frameStartedAt = performance.now();
    const framePromise = waitForCoherentFrame(chart, frameStartedAt);
    const setOptionStartedAt = performance.now();
    chart.setOption(option, { notMerge: true, lazyUpdate: false });
    const setOptionMs = performance.now() - setOptionStartedAt;
    const coherentFrameMs = await framePromise;

    const zoomStartedAt = performance.now();
    const zoomFrame = waitForCoherentFrame(chart, zoomStartedAt);
    chart.setOption({
      xAxis: Array.from({ length: scenario.facets }, () => ({ min: 0.1, max: 0.9 })),
      yAxis: Array.from({ length: scenario.facets }, () => ({ min: 0.1, max: 0.9 })),
    });
    const zoomPatchMs = await zoomFrame;

    const brushStartedAt = performance.now();
    chart.dispatchAction({
      type: "brush",
      areas: [{
        brushType: "rect",
        range: [
          [host.clientWidth * 0.25, host.clientWidth * 0.75],
          [host.clientHeight * 0.25, host.clientHeight * 0.75],
        ],
      }],
    });
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const brushMs = performance.now() - brushStartedAt;

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    observer?.takeRecords().forEach((entry) => longTasks.push(entry.duration));
    return {
      points,
      scenario: scenario.name,
      run,
      grouped: scenario.groups > 1,
      faceted: scenario.facets > 1,
      setOptionMs,
      coherentFrameMs,
      longestTaskMs: Math.max(0, ...longTasks),
      zoomPatchMs,
      brushMs,
    };
  } finally {
    observer?.disconnect();
    chart.dispose();
  }
}

async function postResults(payload: BenchmarkPayload | BenchmarkFailure): Promise<void> {
  const callbackUrl = import.meta.env.VITE_SCATTER_BENCHMARK_CALLBACK;
  if (!callbackUrl) throw new Error("VITE_SCATTER_BENCHMARK_CALLBACK is required");
  const response = await fetch(callbackUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`Result receiver returned ${response.status}`);
}

export function ScatterBudgetBenchmark() {
  const hostRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState("Preparing benchmark...");
  const [output, setOutput] = useState("");

  useEffect(() => {
    let cancelled = false;

    async function runBenchmark() {
      const host = hostRef.current;
      if (!host) return;
      const results: ScatterBenchmarkResult[] = [];
      for (const points of BUDGET_CANDIDATES) {
        for (const scenario of SCENARIOS) {
          for (let run = 1; run <= RUNS_PER_CASE; run += 1) {
            if (cancelled) return;
            setStatus(`${scenario.name}: ${points.toLocaleString()} points, run ${run}/${RUNS_PER_CASE}`);
            results.push(await measureCase(host, points, scenario, run));
          }
        }
      }

      const payload = { userAgent: navigator.userAgent, results };
      setOutput(JSON.stringify(payload, null, 2));
      setStatus("Posting results...");
      await postResults(payload);
      setStatus("Benchmark complete. The runner is writing the report.");
    }

    runBenchmark().catch(async (error: unknown) => {
      const message = error instanceof Error ? error.stack ?? error.message : String(error);
      setStatus(message);
      setOutput(JSON.stringify({ userAgent: navigator.userAgent, error: message }, null, 2));
      try {
        await postResults({ userAgent: navigator.userAgent, error: message });
      } catch (postError) {
        setStatus(`${message}\nUnable to report failure: ${String(postError)}`);
      }
    });
    return () => { cancelled = true; };
  }, []);

  return (
    <main style={{ height: "100vh", display: "grid", gridTemplateRows: "auto minmax(0, 1fr) 180px", gap: 12, padding: 16, boxSizing: "border-box", fontFamily: "sans-serif" }}>
      <strong>{status}</strong>
      <div ref={hostRef} style={{ minWidth: 0, minHeight: 0 }} />
      <textarea readOnly value={output} aria-label="Scatter benchmark JSON results" style={{ width: "100%", resize: "none", boxSizing: "border-box" }} />
    </main>
  );
}