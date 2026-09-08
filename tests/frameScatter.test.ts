import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildFrameScatterItems,
  type FrameScatterInput,
} from "../src/graphCore/frameScatter.ts";
import type { GraphDataFrame } from "../src/types/graphData.ts";

const TEST_FILE_DIR = dirname(fileURLToPath(import.meta.url));
const allRows = new Uint8Array([0b11111111]);

function categoricalFrame(): GraphDataFrame {
  return {
    requestId: "frame-scatter",
    datasetId: "dataset",
    generation: 1,
    sourceRows: 8,
    processedRows: 8,
    sampling: { mode: "full" },
    dictionaries: {
      x: ["A", "B"],
      group: ["East", "West"],
      source: ["m1", "m2"],
      facetX: ["Panel 1", "Panel 2"],
    },
    extents: { y: { min: 10, max: 80 } },
    aggregates: [],
    rawChunks: [{
      chunkIndex: 0,
      rowOffset: 0,
      rowCount: 8,
      xValues: new Uint32Array([0, 0, 0, 0, 0, 0, 1, 1]),
      yValues: new Float64Array([10, 10, 10, 20, 20, 20, 70, 80]),
      rowIds: new BigInt64Array([
        101n,
        102n,
        103n,
        201n,
        202n,
        203n,
        301n,
        BigInt(Number.MAX_SAFE_INTEGER) + 1n,
      ]),
      groupCodes: new Uint32Array([0, 0, 0, 1, 1, 1, 0, 1]),
      sizeValues: new Float64Array([1, 2, 3, 4, 5, 6, 7, 8]),
      sourceCodes: new Uint32Array([1, 0, 1, 0, 1, 0, 0, 1]),
      facetXCodes: new Uint32Array([0, 0, 0, 0, 0, 0, 0, 1]),
      validity: {
        x: allRows,
        y: new Uint8Array([0b10111111]),
        group: allRows,
        size: new Uint8Array([0b11111011]),
        source: new Uint8Array([0b11111011]),
        facetX: allRows,
      },
    }],
  };
}

const baseInput: FrameScatterInput = {
  frame: categoricalFrame(),
  xCoordinate: {
    vector: "x",
    type: "nominal",
    categories: ["A", "B"],
  },
  yCoordinate: { vector: "y", column: "measurement" },
  groupOrder: ["West", "East"],
  hiddenGroups: new Set(),
  facet: { facetX: "Panel 1" },
  jitter: { mode: "stacked", limit: 0.5, seed: 11 },
  plotGeometry: { plotWidth: 600, plotHeight: 400, yMin: 0, yMax: 100 },
};

const groups = buildFrameScatterItems(baseInput);
assert.deepEqual(groups.map((group) => group.name), ["West", "East"]);
assert.deepEqual(groups.map((group) => group.groupCode), [1, 0]);
assert.deepEqual(groups.map((group) => group.items.length), [3, 3]);
assert.ok(groups.every((group) => group.items.every((item) => Array.isArray(item.value))));
assert.ok(groups.every((group) => group.items.every((item) => Array.isArray(item.symbolOffset))));
assert.ok(groups.every((group) => group.items.every((item) => item.__pick)));
assert.ok(
  groups.every((group) => group.items.some((item) => item.symbolOffset[0] !== 0)),
  "each visible group must receive its own jitter distribution",
);

const westItems = groups[0].items;
const eastItems = groups[1].items;
assert.deepEqual(westItems.map((item) => item.value), [["A", 20], ["A", 20], ["A", 20]]);
assert.deepEqual(eastItems.map((item) => item.value), [["A", 10], ["A", 10], ["A", 10]]);
assert.equal(eastItems[0].__pick?.colName, "m2");
assert.equal(eastItems[1].__pick?.colName, "m1");
assert.equal(eastItems[2].__pick?.colName, "measurement", "invalid source falls back to Y column");
assert.equal(eastItems[2].sizeValue, undefined, "invalid size values must be omitted");
assert.equal(westItems[0].sizeValue, 4);

for (const mode of ["uniform", "normal"] as const) {
  const jitteredGroups = buildFrameScatterItems({
    ...baseInput,
    jitter: { mode, limit: 0.5, seed: 11 },
  });
  for (const group of jitteredGroups) {
    const offsets = group.items.map((item) => item.symbolOffset[0]);
    assert.ok(offsets.some((offset) => offset < 0), `${mode} ${group.name} must spread left`);
    assert.ok(offsets.some((offset) => offset > 0), `${mode} ${group.name} must spread right`);
    assert.ok(
      Math.abs(offsets.reduce((sum, offset) => sum + offset, 0)) < 1e-9,
      `${mode} ${group.name} must be centered independently`,
    );
  }
}

const tenCategories = Array.from({ length: 10 }, (_, index) => `Category ${index + 1}`);
const sparseCategoryGroups = buildFrameScatterItems({
  ...baseInput,
  frame: {
    ...categoricalFrame(),
    dictionaries: {
      ...categoricalFrame().dictionaries,
      x: tenCategories,
    },
  },
  xCoordinate: {
    vector: "x",
    type: "nominal",
    categories: tenCategories,
  },
  jitter: { mode: "uniform", limit: 0.5, seed: 11 },
});
assert.ok(
  sparseCategoryGroups.every((group) => (
    group.items.every((item) => Math.abs(item.symbolOffset[0]) <= 15)
  )),
  "a group occupying one category on a ten-category axis must use the shared 60px category band",
);

const visibleOnly = buildFrameScatterItems({
  ...baseInput,
  hiddenGroups: new Set(["West"]),
});
assert.deepEqual(visibleOnly.map((group) => group.name), ["East"]);

const visibilityGeometryFrame: GraphDataFrame = {
  ...categoricalFrame(),
  sourceRows: 6,
  processedRows: 6,
  dictionaries: {
    ...categoricalFrame().dictionaries,
    x: [],
  },
  rawChunks: [{
    chunkIndex: 0,
    rowOffset: 0,
    rowCount: 6,
    xValues: new Float64Array([0, 0, 0, 0.1, 10, 10]),
    yValues: new Float64Array([10, 10.5, 11, 1000, 1000, 1000]),
    rowIds: new BigInt64Array([101n, 102n, 103n, 201n, 202n, 203n]),
    groupCodes: new Uint32Array([0, 0, 0, 1, 1, 1]),
    validity: {
      x: allRows,
      y: allRows,
      group: allRows,
    },
  }],
};

for (const mode of ["stacked", "uniform", "normal"] as const) {
  const input: FrameScatterInput = {
    ...baseInput,
    frame: visibilityGeometryFrame,
    xCoordinate: { vector: "x", type: "continuous" },
    groupOrder: ["East", "West"],
    facet: undefined,
    jitter: { mode, limit: 0.5, seed: 11 },
  };
  const allVisible = buildFrameScatterItems(input);
  const westHidden = buildFrameScatterItems({
    ...input,
    hiddenGroups: new Set(["West"]),
  });
  const eastOffsets = allVisible.find((group) => group.name === "East")?.items
    .map((item) => item.symbolOffset);
  const filteredEastOffsets = westHidden.find((group) => group.name === "East")?.items
    .map((item) => item.symbolOffset);
  assert.deepEqual(
    filteredEastOffsets,
    eastOffsets,
    `${mode} East offsets must not change when West is hidden`,
  );
}

const numericGroups = buildFrameScatterItems({
  ...baseInput,
  frame: {
    ...categoricalFrame(),
    dictionaries: { ...categoricalFrame().dictionaries, x: [] },
    rawChunks: categoricalFrame().rawChunks.map((chunk) => ({
      ...chunk,
      xValues: new Float64Array([1, 1, 1, 2, 2, 2, 7, 8]),
    })),
  },
  xCoordinate: { vector: "x", type: "continuous" },
});
assert.deepEqual(numericGroups[0].items.map((item) => item.value[0]), [2, 2, 2]);

const datetimeGroups = buildFrameScatterItems({
  ...baseInput,
  frame: {
    ...categoricalFrame(),
    dictionaries: {
      ...categoricalFrame().dictionaries,
      x: ["2026-01-01", "2026-01-02"],
    },
  },
  xCoordinate: {
    vector: "x",
    type: "datetime",
    categories: ["2026-01-01", "2026-01-02"],
  },
});
assert.equal(datetimeGroups[0].items[0].value[0], Date.parse("2026-01-01"));

const unsafeFrame = categoricalFrame();
const unsafeGroups = buildFrameScatterItems({
  ...baseInput,
  frame: unsafeFrame,
  facet: { facetX: "Panel 2" },
});
assert.deepEqual(unsafeGroups.map((group) => group.name), ["West", "East"]);
assert.equal(unsafeGroups[0].items.length, 1);
assert.equal(unsafeGroups[0].items[0].__pick, undefined, "unsafe row IDs retain visuals without pick metadata");
assert.deepEqual(unsafeGroups[1].items, [], "visible dictionary groups must remain present in empty facets");

const adapterSource = readFileSync(
  resolve(TEST_FILE_DIR, "../src/graphCore/frameScatter.ts"),
  "utf8",
);
assert.doesNotMatch(adapterSource, /GraphSpec/);
assert.doesNotMatch(adapterSource, /GraphData(?!Frame)/);
assert.doesNotMatch(adapterSource, /resolveGroupStyle/);

console.log("frame scatter tests passed");