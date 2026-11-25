import type { YAxisConfig } from "@/graphCore/types";
import type { GraphNewAxisBounds } from "@/services/graphNewService";
import type { GraphNewXMode } from "@/types/graphBuilderNew";

export interface CameraDomain { xMin: number; xMax: number; yMin: number; yMax: number }
export interface PlotRect { x: number; y: number; width: number; height: number }
export interface CameraAxisInversion { invertX?: boolean; invertY?: boolean }

export function buildAxisBounds(
  xConfig?: YAxisConfig,
  yConfig?: YAxisConfig,
  xKind?: GraphNewXMode,
): GraphNewAxisBounds | undefined {
  const out: GraphNewAxisBounds = {};
  const allowX = xKind !== "category" && xKind !== "time";
  if (allowX && xConfig) {
    const xMin = typeof xConfig.min === "number" && Number.isFinite(xConfig.min) ? xConfig.min : undefined;
    const xMax = typeof xConfig.max === "number" && Number.isFinite(xConfig.max) ? xConfig.max : undefined;
    if (!(xMin !== undefined && xMax !== undefined && xMin >= xMax)) {
      if (xMin !== undefined) out.xMin = xMin;
      if (xMax !== undefined) out.xMax = xMax;
    }
  }
  if (yConfig) {
    const yMin = typeof yConfig.min === "number" && Number.isFinite(yConfig.min) ? yConfig.min : undefined;
    const yMax = typeof yConfig.max === "number" && Number.isFinite(yConfig.max) ? yConfig.max : undefined;
    if (!(yMin !== undefined && yMax !== undefined && yMin >= yMax)) {
      if (yMin !== undefined) out.yMin = yMin;
      if (yMax !== undefined) out.yMax = yMax;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function normalizedAxisValue(value: number, minimum: number, maximum: number): number {
  if (minimum === maximum) return value === minimum ? 0.5 : value < minimum ? -1 : 2;
  const span = maximum - minimum;
  return Number.isFinite(span) ? (value - minimum) / span
    : (value * 0.5 - minimum * 0.5) / (maximum * 0.5 - minimum * 0.5);
}

export function isCameraDomain(domain: CameraDomain): boolean {
  return !!domain && [domain.xMin, domain.xMax, domain.yMin, domain.yMax].every(Number.isFinite)
    && domain.xMax > domain.xMin && domain.yMax > domain.yMin
    && Number.isFinite(domain.xMax - domain.xMin) && Number.isFinite(domain.yMax - domain.yMin);
}

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

export function isRestorableCamera(domain: CameraDomain, full: CameraDomain, independentLayers = false): boolean {
  if (!isCameraDomain(domain) || !isCameraDomain(full)) return false;
  const ratios: number[] = [];
  for (const [minimum, maximum, baseMinimum, baseMaximum] of [
    [domain.xMin, domain.xMax, full.xMin, full.xMax],
    [domain.yMin, domain.yMax, full.yMin, full.yMax],
  ]) {
    const span = baseMaximum - baseMinimum;
    const ratio = (maximum - minimum) / span;
    const center = (minimum - baseMinimum) / span + ratio / 2;
    if (!Number.isFinite(ratio) || !Number.isFinite(center) || ratio < 0.999e-6 || ratio > 4.000001
      || center < -2.000001 || center > 3.000001) return false;
    ratios.push(ratio);
  }
  return independentLayers || Math.abs(ratios[0] / ratios[1] - 1) <= 1e-6;
}

function isUniformCamera(domain: CameraDomain, full: CameraDomain): boolean {
  const horizontal = (domain.xMax - domain.xMin) / (full.xMax - full.xMin);
  const vertical = (domain.yMax - domain.yMin) / (full.yMax - full.yMin);
  return isCameraDomain(domain) && Math.abs(horizontal / vertical - 1) < 1e-8;
}

function moveAxis(min: number, max: number, baseMin: number, baseMax: number, anchor: number, factor: number, shift: number): [number, number] {
  const baseSpan = baseMax - baseMin;
  const span = (max - min) / baseSpan;
  const nextSpan = span * factor;
  const start = (min - baseMin) / baseSpan + span * anchor * (1 - factor) + shift * span;
  const bounded = clamp(start, -2 - nextSpan / 2, 3 - nextSpan / 2);
  return [baseMin + bounded * baseSpan, baseMin + (bounded + nextSpan) * baseSpan];
}

export function panCamera(
  domain: CameraDomain,
  full: CameraDomain,
  plot: PlotRect,
  dx: number,
  dy: number,
  independentLayers = false,
  inversion: CameraAxisInversion = {},
): CameraDomain {
  if (![dx, dy].every(Number.isFinite)) return domain;
  const xShift = (inversion.invertX ? dx : -dx) / plot.width;
  const yShift = (inversion.invertY ? -dy : dy) / plot.height;
  const [xMin, xMax] = moveAxis(domain.xMin, domain.xMax, full.xMin, full.xMax, 0, 1, clamp(xShift, -1e6, 1e6));
  const [yMin, yMax] = moveAxis(domain.yMin, domain.yMax, full.yMin, full.yMax, 0, 1, clamp(yShift, -1e6, 1e6));
  const next = { xMin, xMax, yMin, yMax };
  return (independentLayers ? isRestorableCamera(next, full, true) : isUniformCamera(next, full)) ? next : domain;
}

export function zoomCamera(
  domain: CameraDomain,
  full: CameraDomain,
  plot: PlotRect,
  pointer: { x: number; y: number },
  delta: number,
  independentLayers = false,
  inversion: CameraAxisInversion = {},
): CameraDomain {
  if (!Number.isFinite(delta)) return domain;
  const xRatio = (domain.xMax - domain.xMin) / (full.xMax - full.xMin);
  const yRatio = (domain.yMax - domain.yMin) / (full.yMax - full.yMin);
  const precision = (min: number, max: number) => 32 * Number.EPSILON * Math.max(Math.abs(min), Math.abs(max)) / (max - min);
  const minimum = Math.min(1, Math.max(1e-6, precision(full.xMin, full.xMax), precision(full.yMin, full.yMax)));
  const factor = clamp(Math.exp(clamp(delta * 0.002, -4, 4)), minimum / Math.min(xRatio, yRatio), 4 / Math.max(xRatio, yRatio));
  const rawAnchorX = clamp((pointer.x - plot.x) / plot.width, 0, 1);
  const rawAnchorY = clamp(1 - (pointer.y - plot.y) / plot.height, 0, 1);
  const anchorX = inversion.invertX ? 1 - rawAnchorX : rawAnchorX;
  const anchorY = inversion.invertY ? 1 - rawAnchorY : rawAnchorY;
  const [xMin, xMax] = moveAxis(domain.xMin, domain.xMax, full.xMin, full.xMax, anchorX, factor, 0);
  const [yMin, yMax] = moveAxis(domain.yMin, domain.yMax, full.yMin, full.yMax, anchorY, factor, 0);
  const next = { xMin, xMax, yMin, yMax };
  return (independentLayers ? isRestorableCamera(next, full, true) : isUniformCamera(next, full)) ? next : domain;
}

export function cameraTransform(
  presented: CameraDomain,
  current: CameraDomain,
  plot: PlotRect,
  inversion: CameraAxisInversion = {},
) {
  const scale = (presented.xMax - presented.xMin) / (current.xMax - current.xMin);
  return {
    scale,
    x: (inversion.invertX
      ? (current.xMax - presented.xMax)
      : (presented.xMin - current.xMin)) / (current.xMax - current.xMin) * plot.width,
    y: (inversion.invertY
      ? (presented.yMin - current.yMin)
      : (current.yMax - presented.yMax)) / (current.yMax - current.yMin) * plot.height,
  };
}

export function shouldPreviewCameraTransform(
  presented: CameraDomain,
  current: CameraDomain,
  plot: PlotRect,
  previewDomain: CameraDomain = presented,
  inversion: CameraAxisInversion = {},
): boolean {
  const delta = cameraTransform(presented, current, plot, inversion);
  const changed = Number.isFinite(delta.scale) && Number.isFinite(delta.x) && Number.isFinite(delta.y)
    && (Math.abs(delta.scale - 1) > 1e-8 || Math.abs(delta.x) > 1e-6 || Math.abs(delta.y) > 1e-6);
  if (!changed) return false;
  const transform = cameraTransform(previewDomain, current, plot, inversion);
  const scaleY = (previewDomain.yMax - previewDomain.yMin) / (current.yMax - current.yMin);
  const uniform = Number.isFinite(transform.scale) && Number.isFinite(scaleY)
    && transform.scale > 0 && scaleY > 0
    && Math.abs(transform.scale - scaleY) <= Math.max(transform.scale, scaleY) * 1e-8;
  return uniform && transform.scale >= 1 - 1e-8;
}

export const OVERSCAN_MARGIN = 0.5;
export const MAX_OVERSCAN_WIDTH = 2560;
export const MAX_OVERSCAN_HEIGHT = 1440;

export function overscanCamera(
  presented: CameraDomain,
  full: CameraDomain,
  independentLayers = false,
  desiredMargin = OVERSCAN_MARGIN,
): { domain: CameraDomain; factor: number } | null {
  if (!isCameraDomain(presented) || !isCameraDomain(full) || !Number.isFinite(desiredMargin) || desiredMargin <= 0) {
    return null;
  }
  const xRatio = (presented.xMax - presented.xMin) / (full.xMax - full.xMin);
  const yRatio = (presented.yMax - presented.yMin) / (full.yMax - full.yMin);
  if (!Number.isFinite(xRatio) || !Number.isFinite(yRatio) || xRatio <= 0 || yRatio <= 0) return null;
  const maxFactor = Math.min(3.99 / xRatio, 3.99 / yRatio);
  const margin = Math.min(desiredMargin, (maxFactor - 1) / 2);
  if (!Number.isFinite(margin) || margin < 0.05) return null;
  const xPad = (presented.xMax - presented.xMin) * margin;
  const yPad = (presented.yMax - presented.yMin) * margin;
  const domain: CameraDomain = {
    xMin: presented.xMin - xPad,
    xMax: presented.xMax + xPad,
    yMin: presented.yMin - yPad,
    yMax: presented.yMax + yPad,
  };
  if (!isRestorableCamera(domain, full, independentLayers)) return null;
  return { domain, factor: 1 + 2 * margin };
}

export function overscanViewport(
  plot: PlotRect,
  devicePixelRatio: number,
  factor: number,
): { width: number; height: number; devicePixelRatio: number } | null {
  if (![plot.width, plot.height, devicePixelRatio, factor].every(Number.isFinite)
    || plot.width < 16 || plot.height < 16 || devicePixelRatio < 0.5 || factor <= 1) {
    return null;
  }
  const idealWidth = plot.width * factor;
  const idealHeight = plot.height * factor;
  const pixelScale = Math.min(1, MAX_OVERSCAN_WIDTH / idealWidth, MAX_OVERSCAN_HEIGHT / idealHeight);
  const targetWidth = Math.max(96, Math.min(MAX_OVERSCAN_WIDTH, Math.round(idealWidth * pixelScale)));
  const targetHeight = Math.max(64, Math.min(MAX_OVERSCAN_HEIGHT, Math.round(idealHeight * pixelScale)));
  const dpr = Math.max(0.5, Math.min(8, Math.floor(devicePixelRatio * pixelScale * 1_000_000) / 1_000_000));
  const width = Math.max(96, Math.min(Math.floor(MAX_OVERSCAN_WIDTH / dpr), Math.round(targetWidth / dpr)));
  const height = Math.max(64, Math.min(Math.floor(MAX_OVERSCAN_HEIGHT / dpr), Math.round(targetHeight / dpr)));
  if (Math.ceil(width * dpr) > 3840 || Math.ceil(height * dpr) > 2160) return null;
  return { width, height, devicePixelRatio: dpr };
}

export function formatCompactNumericTick(value: number, spacing: number): string {
  const normalizedValue = Object.is(value, -0) || Math.abs(value) <= spacing * 1e-12 ? 0 : value;
  const tolerance = Number.isFinite(spacing) && spacing > 0 ? spacing * 0.01 : 0;
  let best = normalizedValue.toExponential(12);
  for (let precision = 0; precision <= 12; precision++) {
    for (const candidate of [normalizedValue.toFixed(precision), normalizedValue.toExponential(precision)]) {
      const cleaned = candidate === "-0" ? "0" : candidate;
      if (cleaned.length < best.length) {
        const parsed = Number(cleaned);
        if (Number.isFinite(parsed) && Math.abs(parsed - normalizedValue) <= tolerance) {
          best = cleaned;
        }
      }
    }
  }
  return best;
}

export interface ProjectedAxisTick {
  value: number;
  position: number;
  label: string | null;
}

export function projectAxisTicks(
  axis: { kind: string; ticks: ProjectedAxisTick[] },
  currentMin: number,
  currentMax: number,
  refMin: number,
  refMax: number,
  categoryLabels?: Map<number, string>,
): ProjectedAxisTick[] {
  if (![currentMin, currentMax, refMin, refMax].every(Number.isFinite) || currentMax <= currentMin) {
    return axis.ticks;
  }
  if (axis.kind === "category") {
    const entries = categoryLabels && categoryLabels.size > 0
      ? [...categoryLabels.entries()].sort((a, b) => a[0] - b[0])
      : axis.ticks.map((tick): [number, string] => [tick.value, tick.label ?? ""]);
    const projected: ProjectedAxisTick[] = [];
    for (const [value, label] of entries) {
      const position = normalizedAxisValue(value, currentMin, currentMax);
      if (position >= 0 && position <= 1) {
        projected.push({ value, position, label });
      }
    }
    return projected;
  }
  const base = axis.ticks[0]?.value ?? refMin;
  let step = axis.ticks.length >= 2 ? axis.ticks[1].value - axis.ticks[0].value : (refMax - refMin) / 4;
  if (!Number.isFinite(step) || step <= 0) return axis.ticks;
  const currentSpan = currentMax - currentMin;
  let guard = 0;
  while (currentSpan / step > 10 && guard < 32) { step *= 2; guard++; }
  while (currentSpan / step < 2 && guard < 64) { step /= 2; guard++; }
  if (!Number.isFinite(step) || step <= 0) return axis.ticks;
  const start = Math.ceil((currentMin - base) / step - 1e-9);
  const end = Math.floor((currentMax - base) / step + 1e-9);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || end - start > 16) {
    return axis.ticks;
  }
  const projected: ProjectedAxisTick[] = [];
  for (let index = start; index <= end; index++) {
    const value = base + index * step;
    const position = normalizedAxisValue(value, currentMin, currentMax);
    if (position < -1e-9 || position > 1 + 1e-9) continue;
    const clampedPos = Math.max(0, Math.min(1, position));
    projected.push({
      value,
      position: clampedPos,
      label: axis.kind === "numeric" ? formatCompactNumericTick(value, step) : null,
    });
  }
  return projected;
}

export function projectGridPositions(
  axis: { kind: string; ticks: ProjectedAxisTick[] },
  currentMin: number,
  currentMax: number,
  refMin: number,
  refMax: number,
): number[] {
  if (![currentMin, currentMax, refMin, refMax].every(Number.isFinite) || currentMax <= currentMin) {
    return axis.ticks.map((tick) => tick.position);
  }
  const base = axis.ticks[0]?.value ?? refMin;
  let step = axis.ticks.length >= 2 ? axis.ticks[1].value - axis.ticks[0].value : (refMax - refMin) / 4;
  if (!Number.isFinite(step) || step <= 0) {
    step = (currentMax - currentMin) / 4;
  }
  if (!Number.isFinite(step) || step <= 0) return [];
  const currentSpan = currentMax - currentMin;
  let guard = 0;
  while (currentSpan / step > 10 && guard < 32) { step *= 2; guard++; }
  while (currentSpan / step < 2 && guard < 64) { step /= 2; guard++; }
  if (!Number.isFinite(step) || step <= 0) return [];
  const start = Math.ceil((currentMin - base) / step - 1e-9);
  const end = Math.floor((currentMax - base) / step + 1e-9);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || end - start > 16) {
    return [];
  }
  const positions: number[] = [];
  for (let index = start; index <= end; index++) {
    const position = normalizedAxisValue(base + index * step, currentMin, currentMax);
    if (position >= -1e-9 && position <= 1 + 1e-9) {
      positions.push(Math.max(0, Math.min(1, position)));
    }
  }
  return positions;
}

export function createCameraScheduler(options: {
  invalidate: () => void;
  settled: (generation: number) => void;
  setTimer?: (run: () => void, delay: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}) {
  const setTimer = options.setTimer ?? ((run, delay) => setTimeout(run, delay));
  const clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  let timer: unknown;
  let generation = 0;
  let held = false;
  let disposed = false;
  const clear = () => { if (timer !== undefined) clearTimer(timer); timer = undefined; };
  const schedule = () => { clear(); if (!held && !disposed) timer = setTimer(() => { timer = undefined; options.settled(generation); }, 75); };
  const invalidate = () => { clear(); generation++; options.invalidate(); };
  return {
    generation: () => generation,
    isCurrent: (value: number) => !disposed && generation === value,
    begin: () => { if (!disposed) { held = true; invalidate(); } },
    change: () => { if (!disposed) { invalidate(); schedule(); } },
    end: () => { held = false; schedule(); },
    dispose: () => { disposed = true; invalidate(); },
  };
}