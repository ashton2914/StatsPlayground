import assert from "node:assert/strict";

import { shouldIssueDataTableLoadForCurrentDataset } from "../src/components/dataTableLoadGuards.ts";

assert.equal(
  shouldIssueDataTableLoadForCurrentDataset({
    requestedDatasetId: "dataset-a",
    currentDatasetId: "dataset-a",
  }),
  true,
  "Loads should issue when the captured dataset is still the currently rendered dataset.",
);

assert.equal(
  shouldIssueDataTableLoadForCurrentDataset({
    requestedDatasetId: "dataset-a",
    currentDatasetId: "dataset-b",
  }),
  false,
  "Loads must not issue when an async callback captured dataset A after navigation has already rendered dataset B.",
);

console.log("data table load guard contract passed");