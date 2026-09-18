export interface CameraDomain { xMin: number; xMax: number; yMin: number; yMax: number }
export interface PlotRect { x: number; y: number; width: number; height: number }

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

export function isRestorableCamera(domain: CameraDomain, full: CameraDomain): boolean {
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
  return Math.abs(ratios[0] / ratios[1] - 1) <= 1e-6;
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

export function panCamera(domain: CameraDomain, full: CameraDomain, plot: PlotRect, dx: number, dy: number): CameraDomain {
  if (![dx, dy].every(Number.isFinite)) return domain;
  const [xMin, xMax] = moveAxis(domain.xMin, domain.xMax, full.xMin, full.xMax, 0, 1, clamp(-dx / plot.width, -1e6, 1e6));
  const [yMin, yMax] = moveAxis(domain.yMin, domain.yMax, full.yMin, full.yMax, 0, 1, clamp(dy / plot.height, -1e6, 1e6));
  const next = { xMin, xMax, yMin, yMax };
  return isUniformCamera(next, full) ? next : domain;
}

export function zoomCamera(domain: CameraDomain, full: CameraDomain, plot: PlotRect, pointer: { x: number; y: number }, delta: number): CameraDomain {
  if (!Number.isFinite(delta)) return domain;
  const xRatio = (domain.xMax - domain.xMin) / (full.xMax - full.xMin);
  const yRatio = (domain.yMax - domain.yMin) / (full.yMax - full.yMin);
  const precision = (min: number, max: number) => 32 * Number.EPSILON * Math.max(Math.abs(min), Math.abs(max)) / (max - min);
  const minimum = Math.min(1, Math.max(1e-6, precision(full.xMin, full.xMax), precision(full.yMin, full.yMax)));
  const factor = clamp(Math.exp(clamp(delta * 0.002, -4, 4)), minimum / Math.min(xRatio, yRatio), 4 / Math.max(xRatio, yRatio));
  const [xMin, xMax] = moveAxis(domain.xMin, domain.xMax, full.xMin, full.xMax, clamp((pointer.x - plot.x) / plot.width, 0, 1), factor, 0);
  const [yMin, yMax] = moveAxis(domain.yMin, domain.yMax, full.yMin, full.yMax, clamp(1 - (pointer.y - plot.y) / plot.height, 0, 1), factor, 0);
  const next = { xMin, xMax, yMin, yMax };
  return isUniformCamera(next, full) ? next : domain;
}

export function cameraTransform(presented: CameraDomain, current: CameraDomain, plot: PlotRect) {
  const scale = (presented.xMax - presented.xMin) / (current.xMax - current.xMin);
  return {
    scale,
    x: (presented.xMin - current.xMin) / (current.xMax - current.xMin) * plot.width,
    y: (current.yMax - presented.yMax) / (current.yMax - current.yMin) * plot.height,
  };
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