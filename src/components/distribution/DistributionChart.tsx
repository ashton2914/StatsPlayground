import { useEffect, useRef } from "react";
import * as echarts from "echarts";

import {
  buildDistributionChartOption,
  buildDistributionFitDensityOption,
  buildDistributionOverviewOption,
  buildProcessCapabilityChartOption,
  type DistributionFitCurveInputV1,
} from "@/graphCore/distributionAdapter";
import type {
  DistributionChartDataV1,
  ProcessCapabilityChartDataV1,
} from "@/types/distribution";

interface DistributionChartProps {
  chart: DistributionChartDataV1;
  title: string;
}

export function DistributionChart({ chart, title }: DistributionChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const instance = echarts.init(container, undefined, { renderer: "canvas" });
    instance.setOption(buildDistributionChartOption(chart, title), { notMerge: true });
    const observer = new ResizeObserver(() => instance.resize());
    observer.observe(container);
    const themeObserver = new MutationObserver(() => {
      instance.setOption(buildDistributionChartOption(chart, title), { notMerge: true });
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme"] });
    return () => {
      observer.disconnect();
      themeObserver.disconnect();
      instance.dispose();
    };
  }, [chart, title]);

  return (
    <div
      ref={containerRef}
      className="distribution-chart"
      role="img"
      aria-label={title}
      data-chart-kind={chart.kind}
    />
  );
}

interface DistributionOverviewChartProps {
  histogram: Extract<DistributionChartDataV1, { kind: "histogramData" }>;
  boxPlot: Extract<DistributionChartDataV1, { kind: "boxPlotData" }> | null;
  title: string;
  valueAxisName?: string;
  specificationLines?: { lsl: number | null; target: number | null; usl: number | null; source: string };
}

export function DistributionOverviewChart({
  histogram,
  boxPlot,
  title,
  valueAxisName = "Value",
  specificationLines,
}: DistributionOverviewChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const instance = echarts.init(container, undefined, { renderer: "canvas" });
    const update = () => instance.setOption(
      buildDistributionOverviewOption(histogram, boxPlot, title, specificationLines, valueAxisName),
      { notMerge: true },
    );
    update();
    const observer = new ResizeObserver(() => instance.resize());
    observer.observe(container);
    const themeObserver = new MutationObserver(update);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme"] });
    return () => {
      observer.disconnect();
      themeObserver.disconnect();
      instance.dispose();
    };
  }, [histogram, boxPlot, title, valueAxisName, specificationLines]);

  return (
    <div
      ref={containerRef}
      className="distribution-chart distribution-overview-chart"
      role="img"
      aria-label={title}
      data-chart-kind="overview"
      data-axis-layout="horizontal-count"
    />
  );
}

export function DistributionFitDensityChart({
  histogram,
  curves,
  title,
  valueAxisName = "Value",
  densityAxisName = "Probability Density",
}: {
  histogram: Extract<DistributionChartDataV1, { kind: "histogramData" }>;
  curves: DistributionFitCurveInputV1[];
  title: string;
  valueAxisName?: string;
  densityAxisName?: string;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const instance = echarts.init(container, undefined, { renderer: "canvas" });
    const update = () => instance.setOption(
      buildDistributionFitDensityOption(histogram, curves, title, valueAxisName, densityAxisName),
      { notMerge: true },
    );
    update();
    const observer = new ResizeObserver(() => instance.resize());
    observer.observe(container);
    const themeObserver = new MutationObserver(update);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme"] });
    return () => {
      observer.disconnect();
      themeObserver.disconnect();
      instance.dispose();
    };
  }, [histogram, curves, title, valueAxisName, densityAxisName]);

  return (
    <div
      ref={containerRef}
      className="distribution-chart distribution-fit-density-chart"
      role="img"
      aria-label={title}
      data-chart-kind="fit-density"
    />
  );
}

export function ProcessCapabilityChart({
  chart,
  title,
  valueAxisName,
  densityAxisName,
}: {
  chart: ProcessCapabilityChartDataV1;
  title: string;
  valueAxisName?: string;
  densityAxisName?: string;
}) {
  const resolvedValueAxisName = valueAxisName ?? "Value";
  const resolvedDensityAxisName = densityAxisName ?? "Probability Density";
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const instance = echarts.init(container, undefined, { renderer: "canvas" });
    const update = () => instance.setOption(
      buildProcessCapabilityChartOption(chart, title, resolvedValueAxisName, resolvedDensityAxisName),
      { notMerge: true },
    );
    update();
    const observer = new ResizeObserver(() => instance.resize());
    observer.observe(container);
    const themeObserver = new MutationObserver(update);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme"] });
    return () => {
      observer.disconnect();
      themeObserver.disconnect();
      instance.dispose();
    };
  }, [chart, title, resolvedValueAxisName, resolvedDensityAxisName]);

  return (
    <div
      ref={containerRef}
      className="distribution-chart distribution-capability-chart"
      role="img"
      aria-label={title}
      data-chart-kind="process-capability"
    />
  );
}
