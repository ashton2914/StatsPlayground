import assert from "node:assert/strict";

import {
  createDistributionAnalysisDocument,
  createDistributionAnalysisPatch,
  describeDistributionAnalysis,
  toDistributionEditorItem,
} from "../src/components/analysis/adapters/distributionAnalysisAdapter.ts";
import { createAnalysisSampleDocument } from "../src/components/analysis/analysisSample.ts";
import type { DatasetMeta } from "../src/types/data.ts";

const document = {
  ...createAnalysisSampleDocument({
  datasetId: "dataset-1",
  analysisId: "analysis-1",
  analysisName: "DIM1 Analysis",
  createdAt: "2026-09-04T00:00:00.000Z",
  }),
  definition: {
    ...createAnalysisSampleDocument({
      datasetId: "dataset-1",
      analysisId: "analysis-1",
      analysisName: "DIM1 Analysis",
      createdAt: "2026-09-04T00:00:00.000Z",
    }).definition,
    analysis: {
      ...createAnalysisSampleDocument({
        datasetId: "dataset-1",
        analysisId: "analysis-1",
        analysisName: "DIM1 Analysis",
        createdAt: "2026-09-04T00:00:00.000Z",
      }).definition.analysis,
      specLimits: {
        DIM1: { lsl: 1, target: 2, usl: 3 },
      },
    },
    nestedSubgroup: { name: "Lot", type: "nominal" as const },
  },
};
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
  "confidenceLevel",
  "rows",
]);
assert.equal(summary.find((entry) => entry.key === "response")?.value, "DIM1");
assert.equal(summary.find((entry) => entry.key === "fit")?.value, "normal");
assert.equal(summary.find((entry) => entry.key === "confidenceLevel")?.value, "95%");
assert.equal(summary.find((entry) => entry.key === "rows")?.value, "200");

const editorItem = toDistributionEditorItem(document);
assert.equal(editorItem.id, document.id);
assert.equal(editorItem.name, document.name);
assert.equal(editorItem.sourceDatasetId, document.source.datasetId);
assert.deepEqual(editorItem.responses, document.definition.responses);
assert.deepEqual(editorItem.nestedSubgroup, document.definition.nestedSubgroup);
assert.deepEqual(editorItem.analysis, {
  ...document.definition.analysis,
  specLimits: {},
});
assert.deepEqual(editorItem.graphs, document.definition.graphs);

const submitted = structuredClone(editorItem);
submitted.name = "Ignored rename";
submitted.analysis.confidenceLevel = 0.99;
submitted.analysis.specLimits = {
  DIM1: { lsl: 10, target: 20, usl: 30 },
  DIM2: { lsl: -5, target: 0, usl: 5 },
};
submitted.responses = [{ name: "DIM2", type: "continuous" }];
submitted.nestedSubgroup = { name: "Batch", type: "ordinal" };
submitted.graphs.overview.configRevision += 1;
const patch = createDistributionAnalysisPatch(document, submitted, "2026-09-04T01:00:00.000Z");

assert.equal(patch.name, undefined);
assert.equal(patch.configRevision, document.configRevision + 1);
assert.equal(patch.updatedAt, "2026-09-04T01:00:00.000Z");
assert.deepEqual(patch.source, document.source);
assert.equal(patch.definition?.kind, "distribution");
assert.deepEqual(patch.definition?.responses, submitted.responses);
assert.deepEqual(patch.definition?.nestedSubgroup, submitted.nestedSubgroup);
assert.equal(patch.definition?.analysis.confidenceLevel, 0.99);
assert.deepEqual(patch.definition?.analysis.specLimits, {});
assert.deepEqual(patch.definition?.graphs, submitted.graphs);

const created = createDistributionAnalysisDocument({
  ...editorItem,
  analysis: {
    ...editorItem.analysis,
    specLimits: {
      DIM1: { lsl: 100, target: 200, usl: 300 },
    },
  },
}, "2026-09-06T01:00:00.000Z");
assert.equal(created.documentType, "analysis");
assert.equal(created.analysisKind, "distribution");
assert.equal(created.configRevision, 1);
assert.deepEqual(created.source, { datasetId: editorItem.sourceDatasetId });
assert.deepEqual(created.definition.analysis.specLimits, {});
assert.deepEqual(created.definition.nestedSubgroup, editorItem.nestedSubgroup);
assert.deepEqual(created.definition.graphs, editorItem.graphs);
assert.equal(created.createdAt, editorItem.createdAt);
assert.equal(created.updatedAt, "2026-09-06T01:00:00.000Z");

console.log("distribution analysis adapter OK");