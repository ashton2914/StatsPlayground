import assert from "node:assert/strict";

import {
  buildDistributionFieldInfo,
  createTableRenderLoadToken,
  shouldConsumeTablePropertyManagerRequest,
  shouldRetainTablePropertyManagerRequest,
  type TablePropertyManagerRequest,
} from "../src/components/tablePropertyManagerRequest.ts";
import type { DatasetRevision } from "../src/utils/tableViewport.ts";

const request: TablePropertyManagerRequest = {
  requestId: "request-1",
  datasetId: "dataset-2",
  colIndices: [1, 3],
  extraKinds: ["spec"],
};

const revisionV1: DatasetRevision = {
  datasetId: "dataset-2",
  generation: 1,
  rowCount: 10,
  updatedAt: "2026-09-14T00:00:00.000Z",
};

const revisionV2: DatasetRevision = {
  datasetId: "dataset-2",
  generation: 2,
  rowCount: 11,
  updatedAt: "2026-09-14T00:01:00.000Z",
};

const renderTokenV1 = createTableRenderLoadToken(revisionV1);
const renderTokenV2 = createTableRenderLoadToken(revisionV2);

assert.deepEqual(
  buildDistributionFieldInfo(
    [["A", "DOUBLE"], ["B", "VARCHAR"]],
    [{ colIndex: 1, extras: { spec: { usl: 5 } } }],
  ).map(({ colIndex, extras }) => ({ colIndex, extras })),
  [{ colIndex: 0, extras: undefined }, { colIndex: 1, extras: { spec: { usl: 5 } } }],
  "Distribution field metadata must attach display props by colIndex rather than array position.",
);

assert.equal(
  shouldConsumeTablePropertyManagerRequest(request, {
    currentRenderedLoadToken: renderTokenV1,
    loadedDataLoadToken: renderTokenV1,
    loadedDisplayPropsLoadToken: renderTokenV1,
  }, "dataset-2", null),
  true,
  "Matching current-render and loaded tokens must consume a fresh property-manager request for the currently rendered dataset.",
);

assert.equal(
  shouldConsumeTablePropertyManagerRequest(request, {
    currentRenderedLoadToken: renderTokenV1,
    loadedDataLoadToken: createTableRenderLoadToken({ ...revisionV1, datasetId: "dataset-1" }),
    loadedDisplayPropsLoadToken: createTableRenderLoadToken({ ...revisionV1, datasetId: "dataset-1" }),
  }, "dataset-2", null),
  false,
  "Requests must not be consumed by a different dataset.",
);

assert.equal(
  shouldConsumeTablePropertyManagerRequest(request, {
    currentRenderedLoadToken: renderTokenV1,
    loadedDataLoadToken: renderTokenV1,
    loadedDisplayPropsLoadToken: createTableRenderLoadToken({ ...revisionV1, datasetId: "dataset-1" }),
  }, "dataset-2", null),
  false,
  "Requests must not be consumed until both loaded tokens match the current render token.",
);

assert.equal(
  shouldConsumeTablePropertyManagerRequest(request, {
    currentRenderedLoadToken: renderTokenV1,
    loadedDataLoadToken: renderTokenV1,
    loadedDisplayPropsLoadToken: renderTokenV1,
  }, "dataset-2", "request-1"),
  false,
  "A handled request ID must not be consumed twice by the same dataset.",
);

assert.equal(
  shouldConsumeTablePropertyManagerRequest(request, {
    currentRenderedLoadToken: createTableRenderLoadToken({ ...revisionV1, datasetId: "dataset-1" }),
    loadedDataLoadToken: renderTokenV1,
    loadedDisplayPropsLoadToken: renderTokenV1,
  }, "dataset-1", null),
  false,
  "Requests must not be consumed when the currently rendered dataset is B but the request still targets dataset A.",
);

assert.equal(
  shouldConsumeTablePropertyManagerRequest(request, {
    currentRenderedLoadToken: renderTokenV2,
    loadedDataLoadToken: renderTokenV1,
    loadedDisplayPropsLoadToken: renderTokenV1,
  }, "dataset-2", null),
  false,
  "A same-dataset revision refresh must synchronously invalidate stale loaded tokens before the reload effect finishes.",
);

assert.equal(
  renderTokenV1,
  createTableRenderLoadToken({ ...revisionV1 }),
  "Equivalent dataset revisions must produce a stable deterministic load token.",
);

assert.notEqual(
  renderTokenV1,
  renderTokenV2,
  "A changed generation, row count, or updatedAt must produce a distinct load token.",
);

assert.equal(
  shouldRetainTablePropertyManagerRequest(request, ["dataset-1", "dataset-2"]),
  true,
  "Pending requests should be retained while their dataset still exists, even if another dataset is active.",
);

assert.equal(
  shouldRetainTablePropertyManagerRequest(request, ["dataset-1"]),
  false,
  "Pending requests must be discarded when their dataset no longer exists.",
);

console.log("table property manager request contract passed");