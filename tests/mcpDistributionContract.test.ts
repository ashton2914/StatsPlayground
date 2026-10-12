import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createDefaultDistributionAnalysisConfig, createDefaultDistributionGraphs } from "@/components/distribution/distributionConfig";
import { createDistributionAnalysisDocument } from "@/components/analysis/distributionAnalysisMigration";

// Rust MCP response tests consume this same fixture. Check it against the real
// frontend builder so a frontend schema change cannot silently bypass those tests.
const response = { name: "normal_value", type: "continuous" as const };
const timestamp = "2026-10-12T00:00:00.000Z";
const document = createDistributionAnalysisDocument({
  id: "analysis-1", name: "Distribution acceptance", sourceDatasetId: "dataset-1",
  responses: [response], weight: null, frequency: null, by: [], nestedSubgroup: null,
  analysis: createDefaultDistributionAnalysisConfig(),
  graphs: createDefaultDistributionGraphs(response), createdAt: timestamp,
}, timestamp);
const fixture = JSON.parse(readFileSync(new URL("./fixtures/mcp-distribution-document.json", import.meta.url), "utf8"));
assert.deepEqual(document, fixture, "shared MCP fixture must match the frontend document");
console.log("MCP Distribution frontend contract passed");
