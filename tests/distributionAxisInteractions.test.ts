import assert from "node:assert/strict";

import {
  createDistributionAxisRangeController,
  getDistributionResponseAxis,
} from "../src/components/distribution/distributionAxisInteractions.ts";
import { createDistributionItem } from "../src/components/distribution/distributionConfig.ts";
import type { DistributionItem } from "../src/types/distribution.ts";

const response = { name: "height", type: "continuous" as const };
let item: DistributionItem = createDistributionItem({
  id: "distribution-1",
  name: "Distribution 1",
  sourceDatasetId: "dataset-1",
  responses: [response],
  weight: null,
  frequency: null,
  by: [],
  columns: [{
    name: response.name,
    sqlType: "DOUBLE",
    integerCompatible: false,
    field: response,
  }],
  createdAt: "2026-09-02T00:00:00.000Z",
});

item = {
  ...item,
  graphs: {
    ...item.graphs,
    boxPlot: {
      ...item.graphs.boxPlot,
      modeStates: {
        ...item.graphs.boxPlot.modeStates,
        twoD: {
          ...item.graphs.boxPlot.modeStates.twoD,
          encoding: { y: response },
        },
      },
    },
  },
};

assert.equal(getDistributionResponseAxis(item.graphs.overview, response), "x");
assert.equal(getDistributionResponseAxis(item.graphs.boxPlot, response), "y");

let commits = 0;
let readOnly = false;
const controller = createDistributionAxisRangeController({
  getItem: () => item,
  isReadOnly: () => readOnly,
  commitGraphs: (graphs) => {
    commits += 1;
    item = { ...item, graphs };
  },
});

assert.equal(controller.handleAxisRangeChange("overview", "x", 10, 20), true);
assert.equal(commits, 1, "one originating event persists both graph updates once");
assert.deepEqual(item.graphs.overview.modeStates.twoD.xAxis, { min: 10, max: 20 });
assert.deepEqual(item.graphs.boxPlot.modeStates.twoD.yAxis, { min: 10, max: 20 });

assert.equal(controller.handleAxisRangeChange("boxPlot", "y", 10, 20), false);
assert.equal(commits, 1, "the mirrored callback is a no-op instead of recursing");

assert.equal(controller.handleAxisRangeChange("boxPlot", "x", 30, 40), false);
assert.equal(commits, 1, "a non-response axis does not alter the synchronized range");

readOnly = true;
assert.equal(controller.handleAxisRangeChange("overview", "x", 30, 40), false);
assert.equal(commits, 1, "read-only views never persist axis changes");

console.log("distribution axis interactions OK");