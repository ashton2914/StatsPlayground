import assert from "node:assert/strict";

import type { AnalysisDocument } from "../src/types/analysis.ts";
import {
  buildAnalysisProjectPayload,
  createEmptyWorkspaceDocumentSelection,
  getAnalysisCreationHistoryKey,
  getRetainedActiveAnalysisIdAfterDatasetDeletion,
  hydrateAnalysisProjectPayload,
  selectWorkspaceDocument,
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
  activeDistributionId: null,
  activeTabulateId: null,
});

assert.deepEqual(selectWorkspaceDocument("analysis", "analysis-1"), {
  activeDatasetId: null,
  activeGraphBuilderId: null,
  activeFitYByXId: null,
  activeFitModelId: null,
  activeReportId: null,
  activeAnalysisId: "analysis-1",
  activeDistributionId: null,
  activeTabulateId: null,
});

assert.deepEqual(selectWorkspaceDocument("dataset", "dataset-1"), {
  activeDatasetId: "dataset-1",
  activeGraphBuilderId: null,
  activeFitYByXId: null,
  activeFitModelId: null,
  activeReportId: null,
  activeAnalysisId: null,
  activeDistributionId: null,
  activeTabulateId: null,
});

assert.deepEqual(selectWorkspaceDocument("fitModel", "fit-model-1"), {
  activeDatasetId: null,
  activeGraphBuilderId: null,
  activeFitYByXId: null,
  activeFitModelId: "fit-model-1",
  activeReportId: null,
  activeAnalysisId: null,
  activeDistributionId: null,
  activeTabulateId: null,
});

const analysisItems = [makeAnalysis("analysis-1", "dataset-1")];
const analysisFolders = { "analysis-1": "saved/analysis" };

assert.deepEqual(
  buildAnalysisProjectPayload({ analyses: analysisItems, analysisFolders }),
  {
    analyses: analysisItems,
    analysisFolders,
  },
  "save payload must preserve saved analyses and folder assignments",
);

assert.deepEqual(
  hydrateAnalysisProjectPayload({}),
  {
    analyses: [],
    analysisFolders: {},
  },
  "open/reset hydration must default analysis payloads to empty collections",
);

assert.deepEqual(
  hydrateAnalysisProjectPayload({ analyses: analysisItems, analysisFolders }),
  {
    analyses: analysisItems,
    analysisFolders,
  },
  "open hydration must preserve saved analyses and folder assignments",
);

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