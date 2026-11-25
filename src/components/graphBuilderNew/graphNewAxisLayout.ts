import type { AutoSpec, GridLineStyle, RefLineStyle, RefLineX, RefLineY, YAxisConfig } from "@/graphCore/types";
import type { GraphNewAxis } from "@/services/graphNewService";
import {
  formatCompactNumericTick,
  normalizedAxisValue,
  projectAxisTicks,
  projectGridPositions,
  type ProjectedAxisTick,
} from "./graphNewCamera";

const DEFAULT_MAJOR_GRID_COLOR = "#bdbdbd";
const DEFAULT_MINOR_GRID_COLOR = "#e2e2e2";
const DEFAULT_GRID_STYLE: RefLineStyle = "dashed";
const DEFAULT_GRID_WIDTH = 1;
const MAX_CUSTOM_MAJOR_TICKS = 64;

export interface AxisTickMark {
  value: number;
  screenPosition: number;
  label: string;
}

export interface AxisRefLineRender {
  id: string;
  screenPosition: number;
  label: string;
  color: string;
  style: RefLineStyle;
  width: number;
}

export interface AxisLayoutResult {
  majorTicks: AxisTickMark[];
  minorPositions: number[];
  majorGridPositions: number[];
  minorGridPositions: number[];
  refLines: AxisRefLineRender[];
  showAxisLine: boolean;
  tickPosition: "outside" | "inside";
  showMajorGrid: boolean;
  showMinorGrid: boolean;
  majorGridStyle: Required<GridLineStyle>;
  minorGridStyle: Required<GridLineStyle>;
}

export function strokeDashArrayForStyle(style: RefLineStyle): string | undefined {
  if (style === "dashed") return "4 4";
  if (style === "dotted") return "1.5 3";
  return undefined;
}

function resolveGridStyle(
  style: GridLineStyle | undefined,
  defaultColor: string,
): Required<GridLineStyle> {
  return {
    color: style?.color ?? defaultColor,
    width: typeof style?.width === "number" && Number.isFinite(style.width) && style.width > 0
      ? style.width
      : DEFAULT_GRID_WIDTH,
    style: style?.style ?? DEFAULT_GRID_STYLE,
  };
}

function formatFixedDecimals(value: number, decimals: number): string {
  const fixed = value.toFixed(decimals);
  return /^-(?:0(?:\.0+)?)$/.test(fixed) ? fixed.slice(1) : fixed;
}

function computeCustomIntervalTicks(
  currentMin: number,
  currentMax: number,
  rawInterval: number,
): { ticks: ProjectedAxisTick[]; step: number } {
  const span = currentMax - currentMin;
  if (!Number.isFinite(span) || span <= 0 || !Number.isFinite(rawInterval) || rawInterval <= 0) {
    return { ticks: [], step: rawInterval };
  }
  let step = rawInterval;
  if (span / step > MAX_CUSTOM_MAJOR_TICKS - 1) {
    const minStep = span / (MAX_CUSTOM_MAJOR_TICKS - 1);
    const pow = Math.pow(10, Math.floor(Math.log10(minStep)));
    const normalizedStep = minStep / pow;
    const niceMultiplier = normalizedStep <= 1 ? 1 : normalizedStep <= 2 ? 2 : normalizedStep <= 5 ? 5 : 10;
    step = niceMultiplier * pow;
  }
  const start = Math.ceil(currentMin / step - 1e-9);
  const end = Math.floor(currentMax / step + 1e-9);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || end - start > MAX_CUSTOM_MAJOR_TICKS) {
    return { ticks: [], step };
  }
  const ticks: ProjectedAxisTick[] = [];
  for (let index = start; index <= end; index++) {
    const rawValue = index * step;
    const value = Math.abs(rawValue) <= step * 1e-12 ? 0 : rawValue;
    const position = normalizedAxisValue(value, currentMin, currentMax);
    if (position < -1e-9 || position > 1 + 1e-9) continue;
    ticks.push({
      value,
      position: Math.max(0, Math.min(1, position)),
      label: formatCompactNumericTick(value, step),
    });
  }
  return { ticks, step };
}

function computeMinorPositions(
  majorValues: number[],
  currentMin: number,
  currentMax: number,
  minorTickCount: number,
  invert: boolean,
): number[] {
  if (minorTickCount <= 0 || majorValues.length === 0) return [];
  const step = majorValues.length >= 2
    ? majorValues[1] - majorValues[0]
    : (currentMax - currentMin) / 4;
  if (!Number.isFinite(step) || step <= 0) return [];
  const segments = minorTickCount + 1;
  const subStep = step / segments;
  if (!Number.isFinite(subStep) || subStep <= 0) return [];
  const baseValues = [
    majorValues[0] - step,
    ...majorValues,
  ];
  const positions: number[] = [];
  for (const majorVal of baseValues) {
    for (let k = 1; k <= minorTickCount; k++) {
      const value = majorVal + k * subStep;
      const norm = normalizedAxisValue(value, currentMin, currentMax);
      if (norm <= 1e-9 || norm >= 1 - 1e-9) continue;
      positions.push(invert ? 1 - norm : norm);
    }
  }
  return positions;
}

export function computeAxisLayout(params: {
  axis: "x" | "y";
  axisMeta: GraphNewAxis;
  currentMin: number;
  currentMax: number;
  refMin: number;
  refMax: number;
  config?: YAxisConfig;
  refLines?: RefLineX[] | RefLineY[];
  autoSpecLines?: boolean;
  resolvedAutoSpec?: AutoSpec;
  categoryLabels?: Map<number, string>;
  formatTick: (axis: GraphNewAxis, tick: { value: number; position: number; label: string | null }) => string;
}): AxisLayoutResult {
  const {
    axis,
    axisMeta,
    currentMin,
    currentMax,
    refMin,
    refMax,
    config,
    refLines,
    autoSpecLines,
    resolvedAutoSpec,
    categoryLabels,
    formatTick,
  } = params;

  const isCategory = axisMeta.kind === "category";
  const isTime = axisMeta.kind === "time";
  const isNumeric = axisMeta.kind === "numeric";
  const allowNumericInterval = isNumeric || axisMeta.kind === "duration";
  const allowRefLines = axis === "y" || (!isCategory && !isTime);
  const invert = config?.inverse === true;
  const toScreen = (norm: number) => (invert ? 1 - norm : norm);

  const customInterval = allowNumericInterval
    && typeof config?.tickInterval === "number"
    && Number.isFinite(config.tickInterval)
    && config.tickInterval > 0
    ? config.tickInterval
    : undefined;

  let rawMajorTicks: ProjectedAxisTick[];
  let majorGridNorms: number[];

  if (customInterval !== undefined) {
    const custom = computeCustomIntervalTicks(currentMin, currentMax, customInterval);
    rawMajorTicks = custom.ticks;
    majorGridNorms = custom.ticks.map((tick) => tick.position);
  } else if (currentMin === refMin && currentMax === refMax) {
    rawMajorTicks = axisMeta.ticks;
    majorGridNorms = axisMeta.ticks.map((tick) => tick.position);
  } else {
    rawMajorTicks = projectAxisTicks(axisMeta, currentMin, currentMax, refMin, refMax, categoryLabels);
    majorGridNorms = projectGridPositions(axisMeta, currentMin, currentMax, refMin, refMax);
  }

  const fixedDecimals = isNumeric
    && typeof config?.decimals === "number"
    && Number.isFinite(config.decimals)
    && config.decimals >= 0
    ? Math.max(0, Math.min(10, Math.round(config.decimals)))
    : undefined;

  const projectedAxis: GraphNewAxis = { ...axisMeta, ticks: rawMajorTicks };
  const majorTicks: AxisTickMark[] = rawMajorTicks.map((tick) => ({
    value: tick.value,
    screenPosition: toScreen(tick.position),
    label: fixedDecimals !== undefined
      ? formatFixedDecimals(tick.value, fixedDecimals)
      : formatTick(projectedAxis, tick),
  }));

  const minorTickCount = !isCategory
    && typeof config?.minorTickCount === "number"
    && Number.isFinite(config.minorTickCount)
    && config.minorTickCount > 0
    ? Math.max(0, Math.min(20, Math.round(config.minorTickCount)))
    : 0;

  const minorPositions = computeMinorPositions(
    rawMajorTicks.map((t) => t.value),
    currentMin,
    currentMax,
    minorTickCount,
    invert,
  );

  const showMajorGrid = config?.showMajorGrid === true;
  const showMinorGrid = config?.showMinorGrid === true && minorTickCount > 0 && minorPositions.length > 0;
  const majorGridPositions = showMajorGrid ? majorGridNorms.map(toScreen) : [];
  const minorGridPositions = showMinorGrid ? minorPositions : [];

  const renderedRefLines: AxisRefLineRender[] = [];
  if (allowRefLines) {
    if (autoSpecLines && resolvedAutoSpec) {
      const specs: Array<{ key: string; value: number | undefined; label: string; color: string }> = [
        { key: "auto-lsl", value: resolvedAutoSpec.lsl, label: "LSL", color: "#E60000" },
        { key: "auto-target", value: resolvedAutoSpec.target, label: "Target", color: "#00C853" },
        { key: "auto-usl", value: resolvedAutoSpec.usl, label: "USL", color: "#E60000" },
      ];
      for (const spec of specs) {
        if (typeof spec.value !== "number" || !Number.isFinite(spec.value)) continue;
        const norm = normalizedAxisValue(spec.value, currentMin, currentMax);
        if (norm < 0 || norm > 1) continue;
        renderedRefLines.push({
          id: spec.key,
          screenPosition: toScreen(norm),
          label: spec.label,
          color: spec.color,
          style: "dashed",
          width: 1.5,
        });
      }
    }
    for (const line of refLines ?? []) {
      const value = "x" in line ? line.x : line.y;
      if (!Number.isFinite(value)) continue;
      const norm = normalizedAxisValue(value, currentMin, currentMax);
      if (norm < 0 || norm > 1) continue;
      renderedRefLines.push({
        id: line.id,
        screenPosition: toScreen(norm),
        label: line.label,
        color: line.color,
        style: line.style,
        width: line.width,
      });
    }
  }

  return {
    majorTicks,
    minorPositions,
    majorGridPositions,
    minorGridPositions,
    refLines: renderedRefLines,
    showAxisLine: config?.showAxisLine !== false,
    tickPosition: config?.tickPosition === "inside" ? "inside" : "outside",
    showMajorGrid,
    showMinorGrid,
    majorGridStyle: resolveGridStyle(config?.majorGridStyle, DEFAULT_MAJOR_GRID_COLOR),
    minorGridStyle: resolveGridStyle(config?.minorGridStyle, DEFAULT_MINOR_GRID_COLOR),
  };
}
