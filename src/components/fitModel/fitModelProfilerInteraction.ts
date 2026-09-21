import type { ECharts } from "echarts";

type PointerEvent = { offsetX: number; offsetY: number };

export function clampFitModelProfilerValue(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function registerFitModelXAxisPointerHandlers(
  chart: ECharts,
  getCallback: () => ((value: number) => void) | undefined,
): () => void {
  const renderer = chart.getZr();
  let dragging = false;

  const applyPointerValue = (event: PointerEvent): boolean => {
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
      getCallback()?.(value);
      return true;
    } catch {
      return false;
    }
  };
  const handleMouseDown = (event: PointerEvent) => {
    dragging = applyPointerValue(event);
  };
  const handleMouseMove = (event: PointerEvent) => {
    if (dragging) applyPointerValue(event);
  };
  const stopDragging = () => {
    dragging = false;
  };

  renderer.on("mousedown", handleMouseDown);
  renderer.on("mousemove", handleMouseMove);
  renderer.on("mouseup", stopDragging);
  renderer.on("globalout", stopDragging);

  return () => {
    renderer.off("mousedown", handleMouseDown);
    renderer.off("mousemove", handleMouseMove);
    renderer.off("mouseup", stopDragging);
    renderer.off("globalout", stopDragging);
  };
}

export function createFitModelXAxisPointerBinding() {
  let removeHandlers = () => {};

  return {
    replace(
      chart: ECharts,
      getCallback: (() => ((value: number) => void) | undefined) | undefined,
    ) {
      removeHandlers();
      removeHandlers = getCallback
        ? registerFitModelXAxisPointerHandlers(chart, getCallback)
        : () => {};
    },
    dispose() {
      removeHandlers();
      removeHandlers = () => {};
    },
  };
}
