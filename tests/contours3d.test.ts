import assert from "node:assert/strict";
import { buildContourPolylines } from "../src/graphCore/contours3d.ts";

function roundCoordinate(value: number): number {
  return Number(value.toFixed(6));
}

function normalizePoints(points: Array<[number, number, number]>): Array<[number, number, number]> {
  const rounded = points.map(([x, y, z]) => [roundCoordinate(x), roundCoordinate(y), roundCoordinate(z)] as [number, number, number]);
  const reversed = [...rounded].reverse();
  return JSON.stringify(rounded) <= JSON.stringify(reversed) ? rounded : reversed;
}

function normalizeLines(lines: ReturnType<typeof buildContourPolylines>, level: number): Array<Array<[number, number, number]>> {
  return lines
    .filter((line) => line.level === level)
    .map((line) => normalizePoints(line.points))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

const lines = buildContourPolylines({
  xs: [0, 1],
  ys: [0, 1],
  values: new Float64Array([0, 1, 1, 2]),
  zmin: 0,
  zmax: 2,
}, 3);

assert.deepEqual(lines.find((line) => line.level === 1), {
  level: 1,
  points: [[1, 0, 1], [0, 1, 1]],
});
assert.deepEqual([...new Set(lines.map((line) => line.level))], [0.5, 1, 1.5]);

const holeLines = buildContourPolylines({
  xs: [0, 1],
  ys: [0, 1],
  values: new Float64Array([0, Number.NaN, 1, 2]),
  zmin: 0,
  zmax: 2,
}, 3);
assert.deepEqual(holeLines, []);

const flatLines = buildContourPolylines({
  xs: [0, 1],
  ys: [0, 1],
  values: new Float64Array([1, 1, 1, 1]),
  zmin: 1,
  zmax: 1,
}, 3);
assert.deepEqual(flatLines, []);

const stitched = buildContourPolylines({
  xs: [0, 1, 2],
  ys: [0, 1],
  values: new Float64Array([0, 1, 2, 1, 2, 3]),
  zmin: 0,
  zmax: 3,
}, 3);
assert.deepEqual(stitched.find((line) => line.level === 1.5), {
  level: 1.5,
  points: [[0.5, 1, 1.5], [1, 0.5, 1.5], [1.5, 0, 1.5]],
});

assert.deepEqual(buildContourPolylines({
  xs: [0, 1],
  ys: [0, 1],
  values: new Float64Array([1, 0, 0, 2]),
  zmin: 0,
  zmax: 2,
}, 3).find((line) => line.level === 1), {
  level: 1,
  points: [[1, 0.5, 1], [0.5, 1, 1]],
});

const saddleA = buildContourPolylines({
  xs: [0, 1],
  ys: [0, 1],
  values: new Float64Array([1, 0, 0, 1]),
  zmin: 0,
  zmax: 1,
}, 3);
const saddleB = buildContourPolylines({
  xs: [0, 1],
  ys: [0, 1],
  values: new Float64Array([1, 0, 0, 1]),
  zmin: 0,
  zmax: 1,
}, 3);
assert.deepEqual(saddleA, saddleB);
assert.ok(saddleA.every((line) => line.points.every((point) => point.every(Number.isFinite))));

assert.deepEqual(normalizeLines(buildContourPolylines({
  xs: [0, 1],
  ys: [0, 1],
  values: new Float64Array([2, 0, 0, 3]),
  zmin: 0,
  zmax: 4,
}, 3), 1), [
  [[0, 0.5, 1], [0.333333, 1, 1]],
  [[0.5, 0, 1], [1, 0.333333, 1]],
]);

assert.deepEqual(normalizeLines(buildContourPolylines({
  xs: [0, 1],
  ys: [0, 1],
  values: new Float64Array([1.5, 0, 0, 1.5]),
  zmin: 0,
  zmax: 4,
}, 3), 1), [
  [[0, 0.333333, 1], [0.333333, 0, 1]],
  [[0.666667, 1, 1], [1, 0.666667, 1]],
]);

const clamped = buildContourPolylines({
  xs: [0, 1],
  ys: [0, 1],
  values: new Float64Array([0, 1, 1, 2]),
  zmin: 0,
  zmax: 2,
}, 99);
assert.equal([...new Set(clamped.map((line) => line.level))].length, 20);
assert.ok(clamped.every((line) => Number.isFinite(line.level)));

const segmentCapXs = Array.from({ length: 70_002 }, (_, index) => index);
const segmentCapValues = new Float64Array(segmentCapXs.length * 2);
segmentCapValues.fill(2, segmentCapXs.length);
const segmentCapA = buildContourPolylines({
  xs: segmentCapXs,
  ys: [0, 1],
  values: segmentCapValues,
  zmin: 0,
  zmax: 2,
}, 3);
const segmentCapB = buildContourPolylines({
  xs: segmentCapXs,
  ys: [0, 1],
  values: segmentCapValues,
  zmin: 0,
  zmax: 2,
}, 3);
assert.deepEqual(segmentCapA, segmentCapB);
assert.equal(segmentCapA.length, 0);

const polylineCapXs = Array.from({ length: 701 }, (_, index) => index);
const polylineCapValues = new Float64Array(polylineCapXs.length * 2);
for (let index = 0; index < polylineCapXs.length; index += 1) {
  polylineCapValues[polylineCapXs.length + index] = index % 2 === 0 ? 2 : 0;
}
const polylineCapA = buildContourPolylines({
  xs: polylineCapXs,
  ys: [0, 1],
  values: polylineCapValues,
  zmin: 0,
  zmax: 2,
}, 3);
const polylineCapB = buildContourPolylines({
  xs: polylineCapXs,
  ys: [0, 1],
  values: polylineCapValues,
  zmin: 0,
  zmax: 2,
}, 3);
assert.deepEqual(polylineCapA, polylineCapB);
assert.equal(polylineCapA.length, 351);
assert.equal(polylineCapA.filter((line) => line.level === 0.5).length, 351);
assert.equal(polylineCapA.some((line) => line.level === 1), false);
assert.equal(polylineCapA.some((line) => line.level === 1.5), false);
assert.ok(polylineCapA.every((line, index) => index === 0 || line.level >= polylineCapA[index - 1].level));
assert.ok(polylineCapA.every((line) => line.points.every((point) => point.every(Number.isFinite))));

console.log("contours3d regressions passed");