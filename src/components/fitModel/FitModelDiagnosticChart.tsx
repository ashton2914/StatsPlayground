import { useEffect, useRef } from "react";
import * as echarts from "echarts";
import type { EChartsOption } from "echarts";

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

    let removePointerHandlers = () => {};

    const createChart = () => {
      removePointerHandlers();
      chartRef.current?.dispose();

      const chart = echarts.init(container, undefined, { renderer: "canvas" });
      chartRef.current = chart;
      chart.setOption(optionRef.current, { notMerge: true });

      if (!onXAxisPointerValueRef.current) {
        removePointerHandlers = () => {};
        return;
      }

      const renderer = chart.getZr();
      let dragging = false;
      const applyPointerValue = (event: { offsetX: number; offsetY: number }): boolean => {
        const pixel: [number, number] = [event.offsetX, event.offsetY];
        try {
          if (!chart.containPixel({ gridIndex: 0 }, pixel)) return false;
          const converted = chart.convertFromPixel({ xAxisIndex: 0 }, pixel);
          const convertedValue = Array.isArray(converted) ? converted[0] : converted;
          const gridConverted = typeof convertedValue === "number" && Number.isFinite(convertedValue)
            ? convertedValue
            : chart.convertFromPixel({ gridIndex: 0 }, pixel);
          const value = Array.isArray(gridConverted) ? gridConverted[0] : gridConverted;
          if (typeof value !== "number" || !Number.isFinite(value)) return false;
          onXAxisPointerValueRef.current?.(value);
          return true;
        } catch {
          return false;
        }
      };
      const handleMouseDown = (event: { offsetX: number; offsetY: number }) => {
        dragging = applyPointerValue(event);
      };
      const handleMouseMove = (event: { offsetX: number; offsetY: number }) => {
        if (dragging) applyPointerValue(event);
      };
      const stopDragging = () => {
        dragging = false;
      };

      renderer.on("mousedown", handleMouseDown);
      renderer.on("mousemove", handleMouseMove);
      renderer.on("mouseup", stopDragging);
      renderer.on("globalout", stopDragging);
      removePointerHandlers = () => {
        renderer.off("mousedown", handleMouseDown);
        renderer.off("mousemove", handleMouseMove);
        renderer.off("mouseup", stopDragging);
        renderer.off("globalout", stopDragging);
      };
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
      removePointerHandlers();
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