import assert from "node:assert/strict";

import {
  computeJitterOffsets,
  type JitterGeometry,
  type JitterPoint,
} from "../src/graphCore/jitter.ts";

const geometry: JitterGeometry = {
  plotWidth: 600,
  plotHeight: 400,
  xBandwidth: 600,
  yMin: 0,
  yMax: 100,
};

const sparseCohortGeometry = {
  ...geometry,
  xBandwidth: 60,
};
const sparseCohort: JitterPoint[] = Array.from({ length: 40 }, (_, index) => ({
  x: "A",
  y: 50,
  rowId: BigInt(index + 1),
}));
const sparseOffsets = computeJitterOffsets(
  sparseCohort,
  { mode: "uniform", limit: 0.5, seed: 23 },
  sparseCohortGeometry,
);
assert.ok(
  sparseOffsets.every(([offset]) => Math.abs(offset) <= 15),
  "a sparse group on a ten-category axis must stay within half of its shared 60px band at limit 0.5",
);

const points: JitterPoint[] = Array.from({ length: 120 }, (_, index) => ({
  x: "A",
  y: 50,
  rowId: BigInt(index + 1),
}));

assert.deepEqual(
  computeJitterOffsets(points, { mode: "normal", limit: 0.5, seed: 7 }, geometry),
  computeJitterOffsets(points, { mode: "normal", limit: 0.5, seed: 7 }, geometry),
  "normal jitter must be deterministic for stable row IDs and seed",
);

const overlappingEast: JitterPoint[] = [
  { x: "A", y: 50, rowId: 101n },
  { x: "A", y: 50, rowId: 102n },
  { x: "A", y: 50, rowId: 103n },
];
const overlappingWest: JitterPoint[] = [
  { x: "A", y: 50, rowId: 201n },
  { x: "A", y: 50, rowId: 202n },
  { x: "A", y: 50, rowId: 203n },
];
const stackedOffsets = computeJitterOffsets(
  overlappingEast,
  { mode: "stacked", limit: 0.5, seed: 7 },
  geometry,
);
const eastOffsets = computeJitterOffsets(
  overlappingEast,
  { mode: "uniform", limit: 0.5, seed: 7 },
  geometry,
);
const westOffsets = computeJitterOffsets(
  overlappingWest,
  { mode: "uniform", limit: 0.5, seed: 7 },
  geometry,
);

assert.equal(new Set(stackedOffsets.map(([x]) => x)).size, 3);
assert.ok(eastOffsets.some(([x]) => x !== 0));
assert.ok(westOffsets.some(([x]) => x !== 0));
assert.deepEqual(stackedOffsets.map(([x]) => x), [-7, 0, 7]);

for (const mode of ["uniform", "normal"] as const) {
  for (const [groupName, groupPoints] of [
    ["East", overlappingEast],
    ["West", overlappingWest],
  ] as const) {
    const offsets = computeJitterOffsets(
      groupPoints,
      { mode, limit: 0.5, seed: 7 },
      geometry,
    ).map(([x]) => x);
    assert.ok(offsets.some((offset) => offset < 0), `${mode} ${groupName} cohort must spread left`);
    assert.ok(offsets.some((offset) => offset > 0), `${mode} ${groupName} cohort must spread right`);
    assert.ok(
      Math.abs(offsets.reduce((sum, offset) => sum + offset, 0)) < 1e-9,
      `${mode} ${groupName} cohort must be centered exactly around zero`,
    );
  }
}

for (const mode of ["uniform", "normal"] as const) {
  const offsets = computeJitterOffsets(
    points,
    { mode, limit: 0.5, seed: 19 },
    geometry,
  );
  const horizontal = offsets.map(([x]) => x);
  assert.ok(horizontal.some((offset) => offset < 0), `${mode} jitter must include negative offsets`);
  assert.ok(horizontal.some((offset) => offset > 0), `${mode} jitter must include positive offsets`);
  const mean = horizontal.reduce((sum, offset) => sum + offset, 0) / horizontal.length;
  const maxMagnitude = Math.max(...horizontal.map(Math.abs));
  assert.ok(
    Math.abs(mean) <= maxMagnitude * 0.15,
    `${mode} jitter must remain centered instead of translating a whole group`,
  );
}

assert.deepEqual(
  computeJitterOffsets(
    overlappingEast,
    { mode: "auto", limit: 0.5, seed: 7 },
    geometry,
  ),
  stackedOffsets,
  "legacy auto jitter must normalize to stacked",
);

console.log("jitter tests passed");