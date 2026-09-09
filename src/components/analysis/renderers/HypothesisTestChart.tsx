import { useEffect, useRef } from "react";
import * as echarts from "echarts";
import type { EChartsOption } from "echarts";

import "@/components/hypothesisTest/hypothesisTest.css";

interface HypothesisTestChartProps {
  option: EChartsOption;
  title: string;
  chartKind: "main" | "diagnostic" | "qq";
}

export function HypothesisTestChart({ option, title, chartKind }: HypothesisTestChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);
  const optionRef = useRef(option);
  optionRef.current = option;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const render = () => {
      chartRef.current?.dispose();
      chartRef.current = echarts.init(container, undefined, { renderer: "canvas" });
      chartRef.current.setOption(optionRef.current, { notMerge: true });
    };
    render();
    const resizeObserver = new ResizeObserver(() => chartRef.current?.resize());
    resizeObserver.observe(container);
    const themeObserver = new MutationObserver(render);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme"] });
    return () => {
      resizeObserver.disconnect();
      themeObserver.disconnect();
      chartRef.current?.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    chartRef.current?.setOption(option, { notMerge: true });
  }, [option]);

  return (
    <div
      ref={containerRef}
      className={`analysis-hypothesis-chart analysis-hypothesis-chart-${chartKind}`}
      role="img"
      aria-label={title}
      data-chart-kind={chartKind}
    />
  );
}