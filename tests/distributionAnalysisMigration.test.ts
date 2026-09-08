import assert from "node:assert/strict";

import { migrateLegacyDistributions } from "../src/components/analysis/distributionAnalysisMigration.ts";
import { createAnalysisSampleDocument } from "../src/components/analysis/analysisSample.ts";
import { createDistributionItem } from "../src/components/distribution/distributionConfig.ts";

const createdAt = "2026-09-06T00:00:00.000Z";
const response = { name: "DIM1", type: "continuous" as const };
const existing = createAnalysisSampleDocument({
  datasetId: "dataset-existing",
  analysisId: "distribution-1",
  analysisName: "Dimension Analysis",
  createdAt,
});
const legacy = createDistributionItem({
  id: "distribution-1",
  name: "dimension analysis",
  sourceDatasetId: "dataset-legacy",
  responses: [response],
  weight: null,
  frequency: null,
  by: [{ name: "Cavity", type: "nominal" }],
  columns: [
    { name: "DIM1", sqlType: "DOUBLE", integerCompatible: false, field: response },
    { name: "Cavity", sqlType: "VARCHAR", integerCompatible: false, field: { name: "Cavity", type: "nominal" } },
  ],
  analysis: {
    confidenceLevel: 0.99,
    specLimits: { DIM1: { lsl: 9, target: 10, usl: 11 } },
    fitDistributions: ["normal", "weibull"],
  },
  createdAt,
});
legacy.graphs.normalQuantile.configRevision = 7;

const result = migrateLegacyDistributions({
  analyses: [existing],
  analysisFolders: { [existing.id]: "Analyses/Existing" },
  distributions: [legacy],
  distributionFolders: { [legacy.id]: "Analyses/Legacy" },
});

assert.equal(result.migratedCount, 1);
assert.equal(result.analyses.length, 2);
assert.strictEqual(result.analyses[0], existing);

const migrated = result.analyses[1]!;
assert.equal(migrated.id, "distribution-1-migrated-2");
assert.equal(migrated.name, "dimension analysis-2");
assert.equal(migrated.schemaVersion, 1);
assert.equal(migrated.documentType, "analysis");
assert.equal(migrated.analysisKind, "distribution");
assert.equal(migrated.configRevision, 1);
assert.deepEqual(migrated.source, { datasetId: "dataset-legacy" });
assert.equal(migrated.definition.kind, "distribution");
assert.deepEqual(migrated.definition.responses, legacy.responses);
assert.deepEqual(migrated.definition.weight, legacy.weight);
assert.deepEqual(migrated.definition.frequency, legacy.frequency);
assert.deepEqual(migrated.definition.by, legacy.by);
assert.deepEqual(migrated.definition.analysis, legacy.analysis);
assert.deepEqual(migrated.definition.graphs, legacy.graphs);
assert.notStrictEqual(migrated.definition.graphs, legacy.graphs);
assert.deepEqual(migrated.presentation, { schemaVersion: 1, layout: "distribution-v1" });
assert.equal(migrated.createdAt, createdAt);
assert.equal(migrated.updatedAt, createdAt);
assert.deepEqual(result.analysisFolders, {
  "distribution-1": "Analyses/Existing",
  "distribution-1-migrated-2": "Analyses/Legacy",
});

const identity = migrateLegacyDistributions({
  analyses: [existing],
  analysisFolders: { [existing.id]: "Analyses/Existing" },
  distributions: [],
  distributionFolders: {},
});
assert.equal(identity.migratedCount, 0);
assert.strictEqual(identity.analyses[0], existing);
assert.deepEqual(identity.analysisFolders, { [existing.id]: "Analyses/Existing" });

console.log("distribution analysis migration passed");