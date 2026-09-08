import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  DISTRIBUTION_GRAPH_ROLES,
  mapDistributionExternalDataState,
} from "../src/graphCore/distributionAdapter.ts";
import type { DistributionReportResponse } from "../src/types/distribution.ts";

const frames = Object.fromEntries(DISTRIBUTION_GRAPH_ROLES.map((role) => [role, {
  datasetId: "dataset-1",
  generation: 7,
  columns: [],
  rows: [],
  aggregatePackets: [],
}])) as unknown as DistributionReportResponse["graphFrames"];

assert.deepEqual(DISTRIBUTION_GRAPH_ROLES, [
  "overview",
  "boxPlot",
  "ecdf",
  "normalQuantile",
]);

for (const role of DISTRIBUTION_GRAPH_ROLES) {
  assert.deepEqual(mapDistributionExternalDataState({ status: "idle" }, role), {
    status: "loading",
    frame: null,
    error: null,
  });
  assert.deepEqual(mapDistributionExternalDataState({ status: "loading" }, role), {
    status: "loading",
    frame: null,
    error: null,
  });
  assert.deepEqual(mapDistributionExternalDataState({
    status: "success",
    result: { graphFrames: frames },
  }, role), {
    status: "ready",
    frame: frames[role],
    error: null,
  });
}

assert.deepEqual(mapDistributionExternalDataState({
  status: "error",
  error: "report failed",
}, "overview"), {
  status: "error",
  frame: null,
  error: "report failed",
});

const viewSource = readFileSync(
  new URL("../src/components/distribution/DistributionView.tsx", import.meta.url),
  "utf8",
);
const presentationSource = readFileSync(
  new URL("../src/components/distribution/distributionPresentation.tsx", import.meta.url),
  "utf8",
);

assert.match(presentationSource, /import \{ GraphRuntime/);
assert.match(presentationSource, /createEmbeddedGraphItem/);
assert.match(presentationSource, /externalDataState:/);
assert.match(viewSource, /useDistributionReport\(\s*dataset \? item : null/);
assert.match(viewSource, /dataset\?\.generation \?\? null/, "report reloads must follow the authoritative dataset generation");
assert.doesNotMatch(viewSource, /dataset\?\.updatedAt/, "metadata timestamps must not proxy dataset generation");
assert.match(viewSource, /\{ getCurrentItem \}/, "view must fence reports against the latest stored item");
assert.doesNotMatch(presentationSource, /echarts|DistributionChart/);
assert.equal((presentationSource.match(/<GraphRuntime/g) ?? []).length, 1, "one mapped runtime expression renders all four roles");
assert.match(presentationSource, /DISTRIBUTION_GRAPH_ROLES\.map/);

console.log("distribution graph embedding OK");