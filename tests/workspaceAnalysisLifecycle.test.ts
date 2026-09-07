import assert from "node:assert/strict";

import type { AnalysisDocument } from "../src/types/analysis.ts";
import { createDistributionItem } from "../src/components/distribution/distributionConfig.ts";
import {
  buildAnalysisProjectPayload,
  createEmptyWorkspaceDocumentSelection,
  getAnalysisCreationHistoryKey,
  getRetainedActiveAnalysisIdAfterDatasetDeletion,
  hydrateAnalysisProjectPayload,
  selectWorkspaceDocument,
  shouldMarkAnalysisMigrationDirty,
} from "../src/components/analysis/analysisWorkspaceLifecycle.ts";

function makeAnalysis(id: string, datasetId: string): AnalysisDocument {
  return {
    schemaVersion: 1,
    documentType: "analysis",
    id,
    name: `Analysis ${id}`,
    analysisKind: "distribution",
    configRevision: 1,
    source: { datasetId },
    definition: {
      kind: "distribution",
      responses: [{ name: "DIM1", type: "continuous" }],
      weight: null,
      frequency: null,
      by: [],
      analysis: {
        confidenceLevel: 0.95,
        specLimits: {},
        fitDistributions: ["normal"],
      },
      graphs: [],
    },
    presentation: {
      schemaVersion: 1,
      layout: "distribution-v1",
    },
    createdAt: "2026-09-03T00:00:00.000Z",
    updatedAt: "2026-09-03T00:00:00.000Z",
  };
}

assert.deepEqual(createEmptyWorkspaceDocumentSelection(), {
  activeDatasetId: null,
  activeGraphBuilderId: null,
  activeFitYByXId: null,
  activeFitModelId: null,
  activeReportId: null,
  activeAnalysisId: null,
  activeTabulateId: null,
});

assert.deepEqual(selectWorkspaceDocument("analysis", "analysis-1"), {
  activeDatasetId: null,
  activeGraphBuilderId: null,
  activeFitYByXId: null,
  activeFitModelId: null,
  activeReportId: null,
  activeAnalysisId: "analysis-1",
  activeTabulateId: null,
});

assert.deepEqual(selectWorkspaceDocument("dataset", "dataset-1"), {
  activeDatasetId: "dataset-1",
  activeGraphBuilderId: null,
  activeFitYByXId: null,
  activeFitModelId: null,
  activeReportId: null,
  activeAnalysisId: null,
  activeTabulateId: null,
});

assert.deepEqual(selectWorkspaceDocument("fitModel", "fit-model-1"), {
  activeDatasetId: null,
  activeGraphBuilderId: null,
  activeFitYByXId: null,
  activeFitModelId: "fit-model-1",
  activeReportId: null,
  activeAnalysisId: null,
  activeTabulateId: null,
});

const analysisItems = [makeAnalysis("analysis-1", "dataset-1")];
const analysisFolders = { "analysis-1": "saved/analysis" };

assert.deepEqual(
  buildAnalysisProjectPayload({ analyses: analysisItems, analysisFolders }),
  {
    analyses: analysisItems,
    analysisFolders,
    distributions: [],
    distributionFolders: {},
  },
  "save payload must preserve analyses while clearing legacy Distribution collections",
);

assert.deepEqual(
  hydrateAnalysisProjectPayload({}),
  {
    analyses: [],
    analysisFolders: {},
    migratedCount: 0,
  },
  "open/reset hydration must default analysis payloads to empty collections",
);

assert.deepEqual(
  hydrateAnalysisProjectPayload({ analyses: analysisItems, analysisFolders }),
  {
    analyses: analysisItems,
    analysisFolders,
    migratedCount: 0,
  },
  "open hydration must preserve saved analyses and folder assignments",
);

const legacyDistribution = createDistributionItem({
  id: "distribution-legacy",
  name: "Legacy Distribution",
  sourceDatasetId: "dataset-legacy",
  responses: [{ name: "DIM1", type: "continuous" }],
  weight: null,
  frequency: null,
  by: [],
  columns: [{
    name: "DIM1",
    sqlType: "DOUBLE",
    integerCompatible: false,
    field: { name: "DIM1", type: "continuous" },
  }],
  analysis: {
    confidenceLevel: 0.95,
    specLimits: {},
    fitDistributions: ["normal"],
  },
  createdAt: "2026-09-03T00:00:00.000Z",
});
const migratedPayload = hydrateAnalysisProjectPayload({
  analyses: analysisItems,
  analysisFolders,
  distributions: [legacyDistribution],
  distributionFolders: { [legacyDistribution.id]: "saved/legacy" },
});
assert.equal(migratedPayload.migratedCount, 1);
assert.equal(migratedPayload.analyses.at(-1)?.documentType, "analysis");
assert.equal(migratedPayload.analyses.at(-1)?.source.datasetId, "dataset-legacy");
assert.equal(migratedPayload.analysisFolders[legacyDistribution.id], "saved/legacy");
assert.equal(shouldMarkAnalysisMigrationDirty(migratedPayload.migratedCount), true);
assert.equal(shouldMarkAnalysisMigrationDirty(0), false);

assert.equal(
  getRetainedActiveAnalysisIdAfterDatasetDeletion({
    deletedDatasetId: "dataset-1",
    activeAnalysis: analysisItems[0],
  }),
  "analysis-1",
  "deleting the source dataset must retain the saved active Analysis document",
);

assert.equal(
  getRetainedActiveAnalysisIdAfterDatasetDeletion({
    deletedDatasetId: "dataset-2",
    activeAnalysis: analysisItems[0],
  }),
  null,
  "unrelated dataset deletion must not synthesize an active Analysis selection",
);

assert.equal(getAnalysisCreationHistoryKey("sample"), "history.analysisSample");
assert.equal(getAnalysisCreationHistoryKey("generic"), "history.newAnalysis");

console.log("workspace analysis lifecycle helpers passed");