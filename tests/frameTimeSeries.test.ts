import assert from "node:assert/strict";

import {
  buildFrameTimeSeries,
  type FrameTimeSeriesInput,
} from "../src/graphCore/frameTimeSeries.ts";
import type { GraphDataFrame } from "../src/types/graphData.ts";

const allRows = new Uint8Array([0b11111111]);

function frameWithChunks(): GraphDataFrame {
  return {
    requestId: "time-series-frame",
    datasetId: "dataset",
    generation: 1,
    sourceRows: 8,
    processedRows: 8,
    sampling: { mode: "full" },
    dictionaries: {
      group: ["Build", "Build"],
      source: ["height", "height"],
    },
    extents: {
      x: { min: 1_722_038_400_000, max: 1_722_297_600_000 },
      y: { min: 4.1, max: 6.2 },
    },
    rawPointDisposition: { status: "included", validRows: 8, budget: 8 },
    aggregates: [],
    rawChunks: [
      {
        chunkIndex: 0,
        rowOffset: 0,
        rowCount: 4,
        xValues: new Float64Array([
          1_722_038_400_000,
          1_722_038_400_000,
          1_722_124_800_000,
          1_722_211_200_000,
        ]),
        yValues: new Float64Array([4.1, 4.2, 0, 4.3]),
        rowIds: new BigInt64Array([11n, 12n, 13n, 14n]),
        groupCodes: new Uint32Array([0, 0, 0, 0]),
        sourceCodes: new Uint32Array([0, 0, 0, 0]),
        validity: {
          x: allRows,
          y: new Uint8Array([0b00001011]),
          group: allRows,
          source: allRows,
        },
      },
      {
        chunkIndex: 1,
        rowOffset: 4,
        rowCount: 4,
        xValues: new Float64Array([
          1_722_038_400_000,
          1_722_124_800_000,
          1_722_211_200_000,
          1_722_297_600_000,
        ]),
        yValues: new Float64Array([5.1, 5.2, 6.1, 6.2]),
        rowIds: new BigInt64Array([21n, 22n, 23n, 24n]),
        groupCodes: new Uint32Array([1, 1, 1, 1]),
        sourceCodes: new Uint32Array([0, 0, 1, 1]),
        validity: {
          x: allRows,
          y: allRows,
          group: allRows,
          source: allRows,
        },
      },
    ],
  };
}

const baseInput: FrameTimeSeriesInput = {
  frame: frameWithChunks(),
  yColumn: "measurement",
  groupOrder: ["Build"],
  hiddenGroups: new Set(),
  missingValues: "break",
};

{
  const result = buildFrameTimeSeries(baseInput);
  assert.deepEqual(result.series.map((series) => series.stableId), [
    "g:0|s:0|height",
    "g:1|s:0|height",
    "g:1|s:1|height",
  ]);
  assert.deepEqual(result.series[0].data, [
    [1_722_038_400_000, 4.1],
    [1_722_038_400_000, 4.2],
    [1_722_124_800_000, null],
    [1_722_211_200_000, 4.3],
  ]);
  assert.deepEqual(result.series[0].rowIds, [11n, 12n, 13n, 14n]);
  assert.deepEqual(result.series[0].sourceColumn, "height");
  assert.deepEqual(result.series[1].data, [
    [1_722_038_400_000, 5.1],
    [1_722_124_800_000, 5.2],
  ]);
  assert.deepEqual(result.series[2].data, [
    [1_722_211_200_000, 6.1],
    [1_722_297_600_000, 6.2],
  ]);
}

{
  const result = buildFrameTimeSeries({ ...baseInput, missingValues: "connect" });
  assert.deepEqual(result.series[0].data, [
    [1_722_038_400_000, 4.1],
    [1_722_038_400_000, 4.2],
    [1_722_211_200_000, 4.3],
  ]);
  assert.deepEqual(result.series[0].rowIds, [11n, 12n, 14n]);
}

{
  const hidden = buildFrameTimeSeries({
    ...baseInput,
    hiddenGroups: new Set(["Build"]),
  });
  assert.deepEqual(hidden.series, []);
}

console.log("frame time series tests passed");