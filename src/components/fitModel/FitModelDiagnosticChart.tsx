import { useEffect, useRef } from "react";
import * as echarts from "echarts";
import type { EChartsOption } from "echarts";

interface FitModelDiagnosticChartProps {
  option: EChartsOption;
  title: string;
  chartKind: "actualByPredicted" | "residualByPredicted" | "residualQq" | "predictionProfiler";
}

export function FitModelDiagnosticChart({ option, title, chartKind }: FitModelDiagnosticChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);
  const optionRef = useRef<EChartsOption>(option);

  optionRef.current = option;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    chartRef.current = echarts.init(container, undefined, { renderer: "canvas" });
    chartRef.current.setOption(optionRef.current, { notMerge: true });

    const observer = new ResizeObserver(() => {
      chartRef.current?.resize();
    });
    observer.observe(container);

    return () => {
      observer.disconnect();
      chartRef.current?.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    chartRef.current?.setOption(option, { notMerge: true });
  }, [option]);

  useEffect(() => {
    const themeObserver = new MutationObserver(() => {
      const container = containerRef.current;
      if (!container) return;

      chartRef.current?.dispose();
      chartRef.current = echarts.init(container, undefined, { renderer: "canvas" });
      chartRef.current.setOption(optionRef.current, { notMerge: true });
      chartRef.current.resize();
    });

    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme"] });

    return () => {
      themeObserver.disconnect();
    };
  }, []);

  return (
    <div
      ref={containerRef}
      role="img"
      aria-label={title}
      data-chart-kind={chartKind}
      style={{
        width: "100%",
        minWidth: 0,
        boxSizing: "border-box",
        height: "clamp(220px, 30vw, 260px)",
        minHeight: "220px",
        maxHeight: "260px",
      }}
    />
  );
}