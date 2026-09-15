import assert from "node:assert/strict";

import { migrateLegacyDistributions } from "../src/components/analysis/distributionAnalysisMigration.ts";
import { createAnalysisSampleDocument } from "../src/components/analysis/analysisSample.ts";
import { createDistributionItem } from "../src/components/distribution/distributionConfig.ts";
import type { ColumnDisplayProps } from "../src/types/data";

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
  nestedSubgroup: { name: "Lot", type: "nominal" },
  columns: [
    { name: "DIM1", sqlType: "DOUBLE", integerCompatible: false, colIndex: 0, field: response },
    { name: "Cavity", sqlType: "VARCHAR", integerCompatible: false, colIndex: 1, field: { name: "Cavity", type: "nominal" } },
    { name: "Lot", sqlType: "VARCHAR", integerCompatible: false, colIndex: 2, field: { name: "Lot", type: "nominal" } },
  ],
  analysis: {
    confidenceLevel: 0.99,
    specLimits: { DIM1: { lsl: 9, target: 10, usl: 11 } },
    fitDistributions: ["normal", "weibull"],
    fitAll: false,
  },
  createdAt,
});
const legacyAnalysisSnapshot = JSON.stringify(legacy.analysis);
legacy.graphs.normalQuantile.configRevision = 7;

const legacyProjectPayload = {
  analyses: [existing],
  analysisFolders: { [existing.id]: "Analyses/Existing" },
  distributions: [legacy],
  distributionFolders: { [legacy.id]: "Analyses/Legacy" },
  tableDisplayProps: [
    { colIndex: 0, extras: { spec: { lsl: 9, target: 10, usl: 11 } } },
    { colIndex: 1, extras: { spec: { target: 5 } } },
  ] satisfies ColumnDisplayProps[],
};
const legacyProjectPayloadSnapshot = JSON.stringify(legacyProjectPayload);
const result = migrateLegacyDistributions(legacyProjectPayload);

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
assert.deepEqual(migrated.definition.nestedSubgroup, legacy.nestedSubgroup);
assert.deepEqual(migrated.definition.analysis, {
  ...legacy.analysis,
  specLimits: {},
});
assert.equal(JSON.stringify(legacy.analysis), legacyAnalysisSnapshot);
assert.equal(JSON.stringify(legacyProjectPayload), legacyProjectPayloadSnapshot);
assert.deepEqual(legacy.analysis.specLimits, { DIM1: { lsl: 9, target: 10, usl: 11 } });
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

const canonicalLegacyOverride = {
  ...existing,
  definition: {
    ...existing.definition,
    analysis: {
      ...existing.definition.analysis,
      specLimits: { DIM1: { lsl: 40, target: 100, usl: 160 } },
    },
  },
};
const unaffectedNonDistribution = {
  schemaVersion: 1 as const,
  documentType: "analysis" as const,
  id: "fit-y-by-x-1",
  name: "Strength by Site",
  analysisKind: "fitYByX" as const,
  configRevision: 1,
  source: { datasetId: "dataset-fit" },
  definition: {
    kind: "fitYByX" as const,
    response: { name: "Strength", type: "continuous" as const },
    factor: { name: "Site", type: "nominal" as const },
    personality: "oneway" as const,
    confidenceLevel: 0.95,
  },
  presentation: { schemaVersion: 1 as const, layout: "fit-y-by-x-v1" as const, graph: null },
  createdAt,
  updatedAt: createdAt,
};
const canonicalSnapshot = JSON.stringify(canonicalLegacyOverride);
const normalizedCanonical = migrateLegacyDistributions({
  analyses: [canonicalLegacyOverride, unaffectedNonDistribution],
  analysisFolders: {
    [canonicalLegacyOverride.id]: "Analyses/Canonical",
    [unaffectedNonDistribution.id]: "Analyses/Fit",
  },
  distributions: [],
  distributionFolders: {},
});

assert.equal(normalizedCanonical.migratedCount, 1);
assert.equal(normalizedCanonical.analyses.length, 2);
assert.notStrictEqual(normalizedCanonical.analyses[0], canonicalLegacyOverride);
assert.equal(normalizedCanonical.analyses[0]?.analysisKind, "distribution");
assert.deepEqual(
  normalizedCanonical.analyses[0]?.analysisKind === "distribution"
    ? normalizedCanonical.analyses[0].definition.analysis.specLimits
    : null,
  {},
);
assert.strictEqual(normalizedCanonical.analyses[1], unaffectedNonDistribution);
assert.equal(JSON.stringify(canonicalLegacyOverride), canonicalSnapshot);

const canonicalAlreadyNormalized = migrateLegacyDistributions({
  analyses: [existing, unaffectedNonDistribution],
  analysisFolders: {
    [existing.id]: "Analyses/Existing",
    [unaffectedNonDistribution.id]: "Analyses/Fit",
  },
  distributions: [],
  distributionFolders: {},
});
assert.equal(canonicalAlreadyNormalized.migratedCount, 0);
assert.strictEqual(canonicalAlreadyNormalized.analyses[0], existing);
assert.strictEqual(canonicalAlreadyNormalized.analyses[1], unaffectedNonDistribution);

const missingFitAll = structuredClone(existing) as typeof existing & {
  definition: typeof existing.definition & { analysis: Record<string, unknown> };
};
delete missingFitAll.definition.analysis.fitAll;
const normalizedMissingFitAll = migrateLegacyDistributions({
  analyses: [missingFitAll],
  analysisFolders: { [missingFitAll.id]: "Analyses/Existing" },
  distributions: [],
  distributionFolders: {},
});
assert.equal(normalizedMissingFitAll.migratedCount, 1);
assert.equal(normalizedMissingFitAll.analyses[0]?.analysisKind, "distribution");
assert.deepEqual(
  normalizedMissingFitAll.analyses[0]?.analysisKind === "distribution"
    ? normalizedMissingFitAll.analyses[0].definition.analysis
    : null,
  {
    confidenceLevel: 0.95,
    specLimits: {},
    fitDistributions: ["normal"],
    fitAll: false,
  },
);

console.log("distribution analysis migration passed");