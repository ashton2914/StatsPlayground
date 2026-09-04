import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  createDistributionReportController,
  type DistributionReportState,
} from "../src/components/distribution/useDistributionReport.ts";
import type {
  DistributionItem,
  DistributionReportResponse,
} from "../src/types/distribution.ts";

const graph = {
  mode: "2d" as const,
  modeStates: {
    twoD: { encoding: {}, multiX: [], multiY: [], elements: [], smootherLambda: 0.5 },
    threeD: { encoding: {}, elements: [], smootherLambda: 0.5 },
    multivariate: {
      columns: [],
      chartType: "correlationMatrix" as const,
      correlationMethod: "pearson" as const,
    },
  },
  filters: [],
  sampling: { mode: "full" as const },
};

const item: DistributionItem = {
  id: "distribution-1",
  name: "Distribution 1",
  sourceDatasetId: "dataset-1",
  responses: [{ name: "height", type: "continuous" }],
  weight: null,
  frequency: null,
  by: [],
  analysis: { confidenceLevel: 0.95, specLimits: {}, fitDistributions: [] },
  graphs: { overview: graph, boxPlot: graph, ecdf: graph, normalQuantile: graph },
  createdAt: "2026-09-02T00:00:00.000Z",
};

function response(): DistributionReportResponse {
  const frame = { columns: [], rows: [], aggregatePackets: [], totalRows: 0 } as never;
  return {
    datasetId: item.sourceDatasetId,
    generation: 3,
    groups: [],
    reportBlocks: [],
    graphFrames: { overview: frame, boxPlot: frame, ecdf: frame, normalQuantile: frame },
  };
}

const states: DistributionReportState[] = [];
const controller = createDistributionReportController({
  getDatasetGeneration: async () => 3,
  compute: async () => response(),
  onStateChange: (state) => states.push(state),
});
await controller.load(item);
assert.equal(states[0]?.status, "loading");
assert.equal(controller.getState().status, "success");

controller.cancel();
assert.deepEqual(controller.getState(), { status: "idle" });

const storeSource = readFileSync(
  new URL("../src/stores/useDistributionStore.ts", import.meta.url),
  "utf8",
);
const projectTypesSource = readFileSync(
  new URL("../src/types/project.ts", import.meta.url),
  "utf8",
);
const distributionTypesSource = readFileSync(
  new URL("../src/types/distribution.ts", import.meta.url),
  "utf8",
);
for (const source of [storeSource, projectTypesSource]) {
  assert.doesNotMatch(source, /runState|persistedResults|snapshotId|cancelToken/);
}
assert.doesNotMatch(storeSource, /startRun|updateProgress|cancelRun/);
assert.doesNotMatch(
  distributionTypesSource,
  /AnalysisSnapshot|DistributionProgress|DistributionRun|snapshotId|cancelToken|runId/,
);

console.log("distribution transient report contracts OK");