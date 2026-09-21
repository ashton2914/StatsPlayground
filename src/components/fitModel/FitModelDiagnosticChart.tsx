import { useEffect, useRef } from "react";
import * as echarts from "echarts";
import type { EChartsOption } from "echarts";

import { createFitModelXAxisPointerBinding } from "./fitModelProfilerInteraction";

interface FitModelDiagnosticChartProps {
  option: EChartsOption;
  title: string;
  chartKind:
    | "actualByPredicted"
    | "residualByPredicted"
    | "residualQq"
    | "effectSummary"
    | "leveragePlot"
    | "predictionProfiler";
  onXAxisPointerValue?: (value: number) => void;
}

export function FitModelDiagnosticChart({
  option,
  title,
  chartKind,
  onXAxisPointerValue,
}: FitModelDiagnosticChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);
  const optionRef = useRef<EChartsOption>(option);
  const onXAxisPointerValueRef = useRef(onXAxisPointerValue);

  optionRef.current = option;
  onXAxisPointerValueRef.current = onXAxisPointerValue;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const pointerBinding = createFitModelXAxisPointerBinding();

    const createChart = () => {
      pointerBinding.dispose();
      chartRef.current?.dispose();

      const chart = echarts.init(container, undefined, { renderer: "canvas" });
      chartRef.current = chart;
      chart.setOption(optionRef.current, { notMerge: true });

      pointerBinding.replace(
        chart,
        onXAxisPointerValueRef.current
          ? () => onXAxisPointerValueRef.current
          : undefined,
      );
    };

    createChart();

    const observer = new ResizeObserver(() => {
      chartRef.current?.resize();
    });
    observer.observe(container);

    const themeObserver = new MutationObserver(() => {
      createChart();
      chartRef.current.resize();
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme"] });

    return () => {
      observer.disconnect();
      themeObserver.disconnect();
      pointerBinding.dispose();
      chartRef.current?.dispose();
      chartRef.current = null;
    };
  }, [onXAxisPointerValue !== undefined]);

  useEffect(() => {
    chartRef.current?.setOption(option, { notMerge: true });
  }, [option]);

  return (
    <div
      ref={containerRef}
      className={`sp-fit-model-diagnostic-chart sp-fit-model-diagnostic-chart-${chartKind}`}
      role="img"
      aria-label={title}
      data-chart-kind={chartKind}
    />
  );
}