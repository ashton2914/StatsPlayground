export type ContourPoint = [number, number, number];

export interface ContourGrid {
  xs: readonly number[];
  ys: readonly number[];
  values: Float64Array | readonly number[];
  zmin: number;
  zmax: number;
}

export interface ContourPolyline {
  level: number;
  points: ContourPoint[];
}

interface SegmentPoint {
  x: number;
  y: number;
}

interface Segment {
  points: [SegmentPoint, SegmentPoint];
}

interface Intersection {
  point: SegmentPoint;
  edge: number;
  key: string;
}

const MIN_LEVELS = 3;
const MAX_LEVELS = 20;
const MAX_SEGMENTS = 20_000;
const MAX_POLYLINES = 512;

export function buildContourPolylines(grid: ContourGrid, requestedLevels: number): ContourPolyline[] {
  const levelCount = clampLevels(requestedLevels);
  const levels = buildLevels(grid.zmin, grid.zmax, levelCount);
  if (levels.length === 0) {
    return [];
  }

  const { xs, ys, values } = grid;
  if (xs.length < 2 || ys.length < 2 || values.length < xs.length * ys.length) {
    return [];
  }

  const pointKey = createPointKeyer(xs, ys);

  const output: ContourPolyline[] = [];
  let acceptedSegments = 0;
  levelLoop: for (const level of levels) {
    if (output.length >= MAX_POLYLINES) {
      break;
    }

    const remainingSegments = MAX_SEGMENTS - acceptedSegments;
    if (remainingSegments <= 0) {
      break;
    }

    const segments: Segment[] = [];
    for (let yIndex = 0; yIndex < ys.length - 1; yIndex += 1) {
      for (let xIndex = 0; xIndex < xs.length - 1; xIndex += 1) {
        const cellSegments = extractCellSegments(xs, ys, values, xIndex, yIndex, level, pointKey);
        for (const segment of cellSegments) {
          if (segments.length >= remainingSegments) {
            break levelLoop;
          }
          segments.push(segment);
        }
      }
    }

    if (segments.length === 0) {
      continue;
    }

    const polylines = stitchSegments(segments, level, pointKey);
    if (output.length + polylines.length > MAX_POLYLINES) {
      break;
    }
    acceptedSegments += segments.length;
    output.push(...polylines);
  }

  return output;
}

function clampLevels(requestedLevels: number): number {
  if (!Number.isFinite(requestedLevels)) {
    return 10;
  }
  return Math.min(MAX_LEVELS, Math.max(MIN_LEVELS, Math.trunc(requestedLevels)));
}

function buildLevels(zmin: number, zmax: number, levelCount: number): number[] {
  if (!Number.isFinite(zmin) || !Number.isFinite(zmax) || zmax <= zmin) {
    return [];
  }

  const span = zmax - zmin;
  const step = span / (levelCount + 1);
  const levels: number[] = [];
  for (let index = 1; index <= levelCount; index += 1) {
    levels.push(zmin + step * index);
  }
  return levels;
}

function extractCellSegments(
  xs: readonly number[],
  ys: readonly number[],
  values: Float64Array | readonly number[],
  xIndex: number,
  yIndex: number,
  level: number,
  pointKey: (point: SegmentPoint) => string,
): Segment[] {
  const rowWidth = xs.length;
  const bottomLeft = values[yIndex * rowWidth + xIndex];
  const bottomRight = values[yIndex * rowWidth + xIndex + 1];
  const topLeft = values[(yIndex + 1) * rowWidth + xIndex];
  const topRight = values[(yIndex + 1) * rowWidth + xIndex + 1];

  if (![bottomLeft, bottomRight, topLeft, topRight].every(Number.isFinite)) {
    return [];
  }

  const x0 = xs[xIndex];
  const x1 = xs[xIndex + 1];
  const y0 = ys[yIndex];
  const y1 = ys[yIndex + 1];

  if (![x0, x1, y0, y1].every(Number.isFinite)) {
    return [];
  }

  const intersections: Intersection[] = [];
  pushIntersection(intersections, intersectEdge(x0, y0, bottomLeft, x1, y0, bottomRight, level), 0, pointKey);
  pushIntersection(intersections, intersectEdge(x1, y0, bottomRight, x1, y1, topRight, level), 1, pointKey);
  pushIntersection(intersections, intersectEdge(x0, y1, topLeft, x1, y1, topRight, level), 2, pointKey);
  pushIntersection(intersections, intersectEdge(x0, y0, bottomLeft, x0, y1, topLeft, level), 3, pointKey);

  if (intersections.length < 2) {
    return [];
  }

  const ordered = intersections.slice().sort((left, right) => left.edge - right.edge);
  const unique = new Map<string, Intersection>();
  const counts = new Map<string, number>();
  for (const intersection of ordered) {
    if (!unique.has(intersection.key)) {
      unique.set(intersection.key, intersection);
    }
    counts.set(intersection.key, (counts.get(intersection.key) ?? 0) + 1);
  }

  const points = [...unique.values()].map((entry) => entry.point);

  if (points.length === 2) {
    return [{ points: [points[0], points[1]] }];
  }

  if (points.length === 3) {
    const repeated = ordered.find((entry) => (counts.get(entry.key) ?? 0) > 1);
    if (!repeated) {
      return [];
    }

    const nonVertex = ordered.filter((entry) => entry.key !== repeated.key);
    if (nonVertex.length !== 2) {
      return [];
    }

    return [{ points: [nonVertex[0].point, nonVertex[1].point] }];
  }

  if (points.length >= 4) {
    const centerValue = (bottomLeft + bottomRight + topLeft + topRight) / 4;
    if (centerValue >= level) {
      return [
        { points: [ordered[0].point, ordered[1].point] },
        { points: [ordered[2].point, ordered[3].point] },
      ];
    }
    return [
      { points: [ordered[1].point, ordered[2].point] },
      { points: [ordered[3].point, ordered[0].point] },
    ];
  }

  return [];
}

function pushIntersection(
  intersections: Intersection[],
  point: SegmentPoint | null,
  edge: number,
  pointKey: (point: SegmentPoint) => string,
): void {
  if (!point) {
    return;
  }
  intersections.push({ point, edge, key: pointKey(point) });
}

function intersectEdge(
  x0: number,
  y0: number,
  v0: number,
  x1: number,
  y1: number,
  v1: number,
  level: number,
): SegmentPoint | null {
  if (v0 === level && v1 === level) {
    return null;
  }
  if (v0 === level) {
    return { x: x0, y: y0 };
  }
  if (v1 === level) {
    return { x: x1, y: y1 };
  }

  const delta0 = v0 - level;
  const delta1 = v1 - level;
  if (delta0 === 0 || delta1 === 0 || delta0 * delta1 > 0) {
    return null;
  }

  const factor = delta0 / (delta0 - delta1);
  if (!Number.isFinite(factor)) {
    return null;
  }

  return {
    x: x0 + (x1 - x0) * factor,
    y: y0 + (y1 - y0) * factor,
  };
}

function stitchSegments(segments: Segment[], level: number, pointKey: (point: SegmentPoint) => string): ContourPolyline[] {
  const adjacency = new Map<string, number[]>();
  for (let index = 0; index < segments.length; index += 1) {
    const [start, end] = segments[index].points;
    addAdjacency(adjacency, pointKey(start), index);
    addAdjacency(adjacency, pointKey(end), index);
  }

  const degrees = new Map<string, number>();
  for (const [key, indexes] of adjacency) {
    degrees.set(key, indexes.length);
  }

  const visited = new Set<number>();
  const polylines: ContourPolyline[] = [];

  const openSeeds = segments
    .map((segment, index) => ({ segment, index }))
    .filter(({ segment }) => {
      const startKey = pointKey(segment.points[0]);
      const endKey = pointKey(segment.points[1]);
      return (degrees.get(startKey) ?? 0) !== 2 || (degrees.get(endKey) ?? 0) !== 2;
    });

  for (const { index } of openSeeds) {
    if (visited.has(index)) {
      continue;
    }
    const startKey = chooseStartKey(segments[index], degrees, pointKey);
    const points = walkPolyline(segments, adjacency, visited, index, startKey, pointKey);
    if (points.length >= 2) {
      polylines.push({ level, points: toContourPoints(points, level) });
    }
  }

  for (let index = 0; index < segments.length; index += 1) {
    if (visited.has(index)) {
      continue;
    }
    const points = walkPolyline(segments, adjacency, visited, index, null, pointKey);
    if (points.length >= 2) {
      polylines.push({ level, points: toContourPoints(points, level) });
    }
  }

  return polylines;
}

function chooseStartKey(segment: Segment, degrees: Map<string, number>, pointKey: (point: SegmentPoint) => string): string {
  const startKey = pointKey(segment.points[0]);
  const endKey = pointKey(segment.points[1]);
  return (degrees.get(startKey) ?? 0) !== 2 ? startKey : endKey;
}

function walkPolyline(
  segments: Segment[],
  adjacency: Map<string, number[]>,
  visited: Set<number>,
  seedIndex: number,
  startKey: string | null,
  pointKey: (point: SegmentPoint) => string,
): SegmentPoint[] {
  const seed = segments[seedIndex];
  visited.add(seedIndex);

  let points = orientSeed(seed.points, startKey, pointKey);
  while (true) {
    const currentKey = pointKey(points[points.length - 1]);
    const candidates = adjacency.get(currentKey) ?? [];
    let nextIndex: number | null = null;
    for (const candidate of candidates) {
      if (!visited.has(candidate)) {
        nextIndex = candidate;
        break;
      }
    }

    if (nextIndex === null) {
      break;
    }

    visited.add(nextIndex);
    const segment = segments[nextIndex];
    const nextPoint = pointKey(segment.points[0]) === currentKey ? segment.points[1] : segment.points[0];
    points.push(nextPoint);
    if (pointKey(nextPoint) === pointKey(points[0])) {
      break;
    }
  }

  return points;
}

function orientSeed(
  points: [SegmentPoint, SegmentPoint],
  startKey: string | null,
  pointKey: (point: SegmentPoint) => string,
): SegmentPoint[] {
  if (startKey === null) {
    return [points[0], points[1]];
  }
  if (pointKey(points[0]) === startKey) {
    return [points[0], points[1]];
  }
  return [points[1], points[0]];
}

function toContourPoints(points: SegmentPoint[], level: number): ContourPoint[] {
  return points.map((point) => [point.x, point.y, level]);
}

function addAdjacency(adjacency: Map<string, number[]>, key: string, segmentIndex: number): void {
  const existing = adjacency.get(key);
  if (existing) {
    existing.push(segmentIndex);
    return;
  }
  adjacency.set(key, [segmentIndex]);
}

function createPointKeyer(xs: readonly number[], ys: readonly number[]): (point: SegmentPoint) => string {
  const xOrigin = findMinimum(xs);
  const yOrigin = findMinimum(ys);
  const xQuantum = chooseQuantum(xs);
  const yQuantum = chooseQuantum(ys);
  return (point: SegmentPoint) => `${Math.round((point.x - xOrigin) / xQuantum)}:${Math.round((point.y - yOrigin) / yQuantum)}`;
}

function findMinimum(values: readonly number[]): number {
  let minimum = Number.POSITIVE_INFINITY;
  for (const value of values) {
    if (value < minimum) {
      minimum = value;
    }
  }

  return Number.isFinite(minimum) ? minimum : 0;
}

function chooseQuantum(values: readonly number[]): number {
  let minSpacing = Number.POSITIVE_INFINITY;
  for (let index = 1; index < values.length; index += 1) {
    const spacing = Math.abs(values[index] - values[index - 1]);
    if (spacing > 0 && spacing < minSpacing) {
      minSpacing = spacing;
    }
  }

  if (!Number.isFinite(minSpacing)) {
    const span = Math.abs(values[values.length - 1] - values[0]);
    minSpacing = span > 0 ? span : 1;
  }

  return Math.max(minSpacing / 1_000_000, Number.EPSILON);
}