import assert from "node:assert/strict";

import {
  shouldApplyDistributionCreateMetadataLoad,
  shouldApplyDistributionEditMetadataLoad,
} from "../src/components/workspaceDistributionMetadata.ts";

assert.equal(
  shouldApplyDistributionCreateMetadataLoad({
    requestedDatasetId: "dataset-a",
    requestEpoch: 1,
    currentRequestEpoch: 1,
    activeDatasetId: "dataset-a",
    availableDatasetIds: ["dataset-a", "dataset-b"],
  }),
  true,
  "Create metadata should apply when the active dataset and epoch still match the request.",
);

assert.equal(
  shouldApplyDistributionCreateMetadataLoad({
    requestedDatasetId: "dataset-a",
    requestEpoch: 1,
    currentRequestEpoch: 2,
    activeDatasetId: "dataset-a",
    availableDatasetIds: ["dataset-a", "dataset-b"],
  }),
  false,
  "Create metadata must not apply after a newer create request supersedes the original request.",
);

assert.equal(
  shouldApplyDistributionCreateMetadataLoad({
    requestedDatasetId: "dataset-a",
    requestEpoch: 1,
    currentRequestEpoch: 1,
    activeDatasetId: "dataset-b",
    availableDatasetIds: ["dataset-a", "dataset-b"],
  }),
  false,
  "Create metadata must not open dataset A after the active dataset has switched to B.",
);

assert.equal(
  shouldApplyDistributionEditMetadataLoad({
    requestedAnalysisId: "analysis-a",
    requestedDatasetId: "dataset-a",
    requestEpoch: 3,
    currentRequestEpoch: 3,
    availableDatasetIds: ["dataset-a", "dataset-b"],
    analyses: [
      { id: "analysis-a", sourceDatasetId: "dataset-a" },
      { id: "analysis-b", sourceDatasetId: "dataset-b" },
    ],
  }),
  true,
  "Edit metadata should apply when the same analysis still targets the same dataset and no newer edit request exists.",
);

assert.equal(
  shouldApplyDistributionEditMetadataLoad({
    requestedAnalysisId: "analysis-a",
    requestedDatasetId: "dataset-a",
    requestEpoch: 3,
    currentRequestEpoch: 4,
    availableDatasetIds: ["dataset-a", "dataset-b"],
    analyses: [
      { id: "analysis-a", sourceDatasetId: "dataset-a" },
      { id: "analysis-b", sourceDatasetId: "dataset-b" },
    ],
  }),
  false,
  "Edit metadata must not apply after a newer edit request supersedes the original request.",
);

assert.equal(
  shouldApplyDistributionEditMetadataLoad({
    requestedAnalysisId: "analysis-a",
    requestedDatasetId: "dataset-a",
    requestEpoch: 3,
    currentRequestEpoch: 3,
    availableDatasetIds: ["dataset-b"],
    analyses: [
      { id: "analysis-a", sourceDatasetId: "dataset-a" },
      { id: "analysis-b", sourceDatasetId: "dataset-b" },
    ],
  }),
  false,
  "Edit metadata must not open when the source dataset is no longer available.",
);

assert.equal(
  shouldApplyDistributionEditMetadataLoad({
    requestedAnalysisId: "analysis-a",
    requestedDatasetId: "dataset-a",
    requestEpoch: 3,
    currentRequestEpoch: 3,
    availableDatasetIds: ["dataset-a", "dataset-b"],
    analyses: [
      { id: "analysis-b", sourceDatasetId: "dataset-b" },
    ],
  }),
  false,
  "Edit metadata must not open when the source analysis has been removed.",
);

assert.equal(
  shouldApplyDistributionEditMetadataLoad({
    requestedAnalysisId: "analysis-a",
    requestedDatasetId: "dataset-a",
    requestEpoch: 3,
    currentRequestEpoch: 3,
    availableDatasetIds: ["dataset-a", "dataset-b"],
    analyses: [
      { id: "analysis-a", sourceDatasetId: "dataset-b" },
    ],
  }),
  false,
  "Edit metadata must not open when the analysis now points at a different dataset.",
);

console.log("workspace distribution metadata fences passed");