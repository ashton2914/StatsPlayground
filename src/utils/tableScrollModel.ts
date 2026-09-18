export interface LogicalScrollMetrics {
  totalRows: number;
  visibleRows: number;
  logicalStart: number;
}

function toFiniteInteger(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  return Math.trunc(value);
}

function toFiniteNumber(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

function toNonNegativeInteger(value: number): number {
  const integerValue = toFiniteInteger(value);
  return integerValue === null ? 0 : Math.max(0, integerValue);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function maxLogicalStart(totalRows: number, visibleRows: number): number {
  return Math.max(0, toNonNegativeInteger(totalRows) - toNonNegativeInteger(visibleRows));
}

export function logicalStartFromRatio(
  ratio: number,
  totalRows: number,
  visibleRows: number,
): number {
  const maximumStart = maxLogicalStart(totalRows, visibleRows);
  const finiteRatio = toFiniteInteger(ratio);
  if (finiteRatio === null || maximumStart === 0) return 0;
  const normalizedRatio = clamp(ratio, 0, 1);
  return Math.round(normalizedRatio * maximumStart);
}

export function ratioFromLogicalStart(
  logicalStart: number,
  totalRows: number,
  visibleRows: number,
): number {
  const maximumStart = maxLogicalStart(totalRows, visibleRows);
  const finiteStart = toFiniteInteger(logicalStart);
  if (finiteStart === null || maximumStart === 0) return 0;
  const normalizedStart = clamp(finiteStart, 0, maximumStart);
  return normalizedStart / maximumStart;
}

export function moveLogicalStart(metrics: LogicalScrollMetrics, rowDelta: number): number {
  const maximumStart = maxLogicalStart(metrics.totalRows, metrics.visibleRows);
  const currentStart = toNonNegativeInteger(metrics.logicalStart);
  const finiteDelta = toFiniteInteger(rowDelta);
  if (maximumStart === 0) return 0;
  if (finiteDelta === null) return clamp(currentStart, 0, maximumStart);
  return clamp(currentStart + finiteDelta, 0, maximumStart);
}

export function viewportSlotCount(
  viewportHeight: number,
  rowHeight: number,
  overscanRows: number,
): number {
  const finiteViewportHeight = toFiniteNumber(viewportHeight);
  const finiteRowHeight = toFiniteNumber(rowHeight);
  const finiteOverscanRows = toFiniteNumber(overscanRows);
  if (
    finiteViewportHeight === null
    || finiteRowHeight === null
    || finiteOverscanRows === null
    || finiteViewportHeight <= 0
    || finiteRowHeight <= 0
  ) {
    return 0;
  }

  const visibleRows = Math.ceil(finiteViewportHeight / finiteRowHeight);
  return Math.trunc(Math.max(0, visibleRows + Math.max(0, finiteOverscanRows) * 2));
}