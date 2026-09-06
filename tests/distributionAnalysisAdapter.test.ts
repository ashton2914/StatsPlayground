import assert from "node:assert/strict";

import {
  createDistributionAnalysisPatch,
  describeDistributionAnalysis,
  toDistributionEditorItem,
} from "../src/components/analysis/adapters/distributionAnalysisAdapter.ts";
import { createAnalysisSampleDocument } from "../src/components/analysis/analysisSample.ts";
import type { DatasetMeta } from "../src/types/data.ts";

const document = createAnalysisSampleDocument({
  datasetId: "dataset-1",
  analysisId: "analysis-1",
  analysisName: "DIM1 Analysis",
  createdAt: "2026-09-04T00:00:00.000Z",
});
const dataset: DatasetMeta = {
  id: "dataset-1",
  name: "DIM1 Sample",
  sourcePath: null,
  sourceType: "manual",
  rowCount: 200,
  colCount: 1,
  generation: 1,
  createdAt: "2026-09-04T00:00:00.000Z",
  updatedAt: "2026-09-04T00:00:00.000Z",
};
const translate = (key: string, values?: Record<string, unknown>) => (
  values?.defaultValue as string | undefined ?? key
);

const summary = describeDistributionAnalysis(document, dataset, translate);
assert.deepEqual(summary.map((entry) => entry.key), [
  "analysis",
  "response",
  "fit",
  "specificationLimits",
  "confidenceLevel",
  "rows",
]);
assert.equal(summary.find((entry) => entry.key === "response")?.value, "DIM1");
assert.equal(summary.find((entry) => entry.key === "fit")?.value, "normal");
assert.equal(summary.find((entry) => entry.key === "specificationLimits")?.value, "55 / 100 / 145");
assert.equal(summary.find((entry) => entry.key === "confidenceLevel")?.value, "95%");
assert.equal(summary.find((entry) => entry.key === "rows")?.value, "200");

const editorItem = toDistributionEditorItem(document);
assert.equal(editorItem.id, document.id);
assert.equal(editorItem.name, document.name);
assert.equal(editorItem.sourceDatasetId, document.source.datasetId);
assert.deepEqual(editorItem.responses, document.definition.responses);
assert.deepEqual(editorItem.analysis, document.definition.analysis);
assert.deepEqual(editorItem.graphs, document.definition.graphs);

const submitted = structuredClone(editorItem);
submitted.name = "Ignored rename";
submitted.analysis.confidenceLevel = 0.99;
submitted.responses = [{ name: "DIM2", type: "continuous" }];
submitted.graphs.overview.configRevision += 1;
const patch = createDistributionAnalysisPatch(document, submitted, "2026-09-04T01:00:00.000Z");

assert.equal(patch.name, undefined);
assert.equal(patch.configRevision, document.configRevision + 1);
assert.equal(patch.updatedAt, "2026-09-04T01:00:00.000Z");
assert.deepEqual(patch.source, document.source);
assert.equal(patch.definition?.kind, "distribution");
assert.deepEqual(patch.definition?.responses, submitted.responses);
assert.equal(patch.definition?.analysis.confidenceLevel, 0.99);
assert.deepEqual(patch.definition?.graphs, submitted.graphs);

console.log("distribution analysis adapter OK");