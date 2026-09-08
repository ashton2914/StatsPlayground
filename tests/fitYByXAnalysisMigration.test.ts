import assert from "node:assert/strict";

import { createAnalysisSampleDocument } from "../src/components/analysis/analysisSample.ts";
import { migrateLegacyFitYByX } from "../src/components/analysis/fitYByXAnalysisMigration.ts";
import { createFitYByXItem } from "../src/components/fitYByX/fitYByXConfig.ts";

const createdAt = "2026-09-07T00:00:00.000Z";
const legacy = createFitYByXItem({
  id: "fit-1",
  name: "Strength by Site",
  sourceDatasetId: "dataset-1",
  response: { name: "Strength", type: "continuous" },
  factor: { name: "Site", type: "nominal" },
  createdAt,
});
const input = {
  analyses: [],
  analysisFolders: {},
  fitYByX: [legacy],
  fitYByXFolders: { [legacy.id]: "Analyses/Legacy" },
};

const migrated = migrateLegacyFitYByX(input);
assert.equal(migrated.migratedCount, 1);
assert.equal(migrated.analyses[0]?.id, legacy.id);
assert.equal(migrated.analyses[0]?.name, legacy.name);
assert.equal(migrated.analyses[0]?.source.datasetId, legacy.sourceDatasetId);
assert.equal(migrated.analyses[0]?.createdAt, legacy.createdAt);
const migratedDocument = migrated.analyses[0];
assert.equal(migratedDocument?.analysisKind, "fitYByX");
if (migratedDocument?.analysisKind !== "fitYByX") {
  throw new Error("Expected migrated Fit Y by X Analysis document");
}
assert.deepEqual(migratedDocument.definition.response, legacy.response);
assert.deepEqual(migratedDocument.definition.factor, legacy.factor);
assert.equal(migratedDocument.definition.personality, legacy.personality);
assert.equal(migratedDocument.definition.confidenceLevel, 0.95);
assert.deepEqual(migratedDocument.presentation.graph, legacy.graph);
assert.equal(migrated.analysisFolders[legacy.id], "Analyses/Legacy");

const sameIdAnalysis = createAnalysisSampleDocument({
  datasetId: "dataset-2",
  analysisId: legacy.id,
  analysisName: "Existing Analysis",
  createdAt,
});
assert.throws(
  () => migrateLegacyFitYByX({ ...input, analyses: [sameIdAnalysis] }),
  /fit-1/,
);

const invalidRoles = {
  ...legacy,
  factor: { name: "Strength", type: "nominal" as const },
};
assert.throws(() => migrateLegacyFitYByX({ ...input, fitYByX: [invalidRoles] }));

const invalidPersonality = { ...legacy, personality: "bivariate" as const };
assert.throws(() => migrateLegacyFitYByX({ ...input, fitYByX: [invalidPersonality] }));

const invalidGraph = { ...legacy, graph: { ...legacy.graph, mode: "polar" } };
assert.throws(() => migrateLegacyFitYByX({
  ...input,
  fitYByX: [invalidGraph as unknown as typeof legacy],
}));

console.log("Fit Y by X Analysis migration tests passed");