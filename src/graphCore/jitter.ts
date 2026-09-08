export interface JitterPoint {
  x: number | string;
  y: number;
  rowId: bigint;
}

export interface JitterOptions {
  mode: "auto" | "stacked" | "uniform" | "normal";
  limit: number;
  seed: number;
}

export interface JitterGeometry {
  plotWidth: number;
  plotHeight: number;
  xBandwidth: number;
  yMin: number;
  yMax: number;
}

export type JitterOffset = readonly [number, number];

const STACK_BUCKET_PX = 6;
const STACK_SPACING_AT_FULL_LIMIT_PX = 14;
const UINT64_MASK = (1n << 64n) - 1n;

export function estimateJitterXBandwidth(
  xValues: readonly (number | string)[],
  xType: "continuous" | "nominal" | "datetime",
  plotWidthValue: number,
  categoryCount?: number,
  axisExtent?: { min: number; max: number },
): number {
  const plotWidth = Number.isFinite(plotWidthValue) ? Math.max(0, plotWidthValue) : 0;
  if (xType === "nominal") {
    const distinctCount = new Set(
      xValues.map((value) => `${typeof value}:${String(value)}`),
    ).size;
    return plotWidth / Math.max(1, categoryCount ?? distinctCount);
  }

  const numericValues = Array.from(new Set(
    xValues.map(Number).filter(Number.isFinite),
  )).sort((left, right) => left - right);
  if (numericValues.length < 2 || plotWidth <= 0) return Math.min(450, plotWidth);

  const axisMin = Number.isFinite(axisExtent?.min) ? axisExtent!.min : numericValues[0];
  const axisMax = Number.isFinite(axisExtent?.max)
    ? axisExtent!.max
    : numericValues[numericValues.length - 1];
  const axisSpan = axisMax - axisMin;
  if (!(axisSpan > 0)) return Math.min(450, plotWidth);

  let minProjectedSpacing = Infinity;
  for (let index = 1; index < numericValues.length; index += 1) {
    const gap = numericValues[index] - numericValues[index - 1];
    if (gap > 0) {
      minProjectedSpacing = Math.min(minProjectedSpacing, (gap / axisSpan) * plotWidth);
    }
  }
  if (!Number.isFinite(minProjectedSpacing)) return Math.min(450, plotWidth);
  return Math.max(8, Math.min(450, plotWidth, minProjectedSpacing));
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function mix64(value: bigint): bigint {
  let mixed = value & UINT64_MASK;
  mixed = ((mixed ^ (mixed >> 30n)) * 0xbf58476d1ce4e5b9n) & UINT64_MASK;
  mixed = ((mixed ^ (mixed >> 27n)) * 0x94d049bb133111ebn) & UINT64_MASK;
  return (mixed ^ (mixed >> 31n)) & UINT64_MASK;
}

function stableHash(rowId: bigint, seed: number, salt: bigint): bigint {
  const seedBits = BigInt.asUintN(64, BigInt(Math.trunc(Number.isFinite(seed) ? seed : 0)));
  return mix64(BigInt.asUintN(64, rowId) ^ seedBits ^ salt);
}

function stableUnit(rowId: bigint, seed: number, salt: bigint): number {
  const hashed = stableHash(rowId, seed, salt);
  return Number(hashed >> 11n) / 0x20_0000_0000_0000;
}

function projectedYBucket(y: number, geometry: JitterGeometry): number {
  const plotHeight = Number.isFinite(geometry.plotHeight) ? Math.max(0, geometry.plotHeight) : 0;
  const yRange = geometry.yMax - geometry.yMin;
  const projected = Number.isFinite(yRange) && yRange !== 0
    ? ((y - geometry.yMin) / yRange) * plotHeight
    : 0;
  return Math.round(projected / STACK_BUCKET_PX);
}

export function computeJitterOffsets(
  points: readonly JitterPoint[],
  options: JitterOptions,
  geometry: JitterGeometry,
): ReadonlyArray<JitterOffset> {
  const offsets: JitterOffset[] = points.map(() => [0, 0] as const);
  if (points.length === 0) return offsets;

  const limit = clamp01(options.limit);
  if (limit === 0) return offsets;

  const bandWidth = Number.isFinite(geometry.xBandwidth)
    ? Math.max(0, geometry.xBandwidth)
    : 0;
  const maxSpread = bandWidth * limit;
  const mode = options.mode === "auto" ? "stacked" : options.mode;

  if (mode === "uniform" || mode === "normal") {
    const halfSpread = maxSpread / 2;
    const hashes = points.map((point) => (
      stableHash(point.rowId, options.seed, 0x243f6a8885a308d3n)
    ));
    const randomValues = points.map((point) => {
      let random = stableUnit(point.rowId, options.seed, 0x243f6a8885a308d3n) * 2 - 1;
      if (mode === "normal") {
        const first = Math.max(stableUnit(point.rowId, options.seed, 0x13198a2e03707344n), 1e-12);
        const second = stableUnit(point.rowId, options.seed, 0xa4093822299f31d0n);
        random = Math.sqrt(-2 * Math.log(first)) * Math.cos(2 * Math.PI * second) / 3;
        random = Math.max(-1, Math.min(1, random));
      }
      return random;
    });
    const mean = randomValues.reduce((sum, value) => sum + value, 0) / randomValues.length;
    let centered = randomValues.map((value) => value - mean);
    const hasBothSides = centered.some((value) => value < 0)
      && centered.some((value) => value > 0);
    if (!hasBothSides && new Set(hashes).size > 1) {
      const ordered = hashes
        .map((hash, index) => ({ hash, index }))
        .sort((left, right) => left.hash < right.hash ? -1 : left.hash > right.hash ? 1 : 0);
      centered = centered.map(() => 0);
      const midpoint = (ordered.length - 1) / 2;
      ordered.forEach((entry, rank) => {
        centered[entry.index] = rank - midpoint;
      });
    }
    const maxMagnitude = centered.reduce(
      (largest, value) => Math.max(largest, Math.abs(value)),
      0,
    );
    const scale = maxMagnitude > 1 ? halfSpread / maxMagnitude : halfSpread;
    return centered.map((value) => [value * scale, 0] as const);
  }

  const buckets = new Map<string, number[]>();
  points.forEach((point, index) => {
    const key = `${typeof point.x}:${String(point.x)}:${projectedYBucket(point.y, geometry)}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(index);
    else buckets.set(key, [index]);
  });

  for (const bucket of buckets.values()) {
    if (bucket.length < 2) continue;
    const spacing = Math.min(
      STACK_SPACING_AT_FULL_LIMIT_PX * limit,
      maxSpread / (bucket.length - 1),
    );
    const center = ((bucket.length - 1) * spacing) / 2;
    bucket.forEach((pointIndex, bucketIndex) => {
      offsets[pointIndex] = [bucketIndex * spacing - center, 0] as const;
    });
  }

  return offsets;
}