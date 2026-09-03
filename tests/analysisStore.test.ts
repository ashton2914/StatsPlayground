import assert from "node:assert/strict";

import { createDistributionItem } from "../src/components/distribution/distributionConfig.ts";
import { useAnalysisStore } from "../src/stores/useAnalysisStore.ts";
import { useProjectStore } from "../src/stores/useProjectStore.ts";
import type { AnalysisDocument, AnalysisDocumentPatch } from "../src/types/analysis.ts";

function makeAnalysisDocument(overrides: Partial<AnalysisDocument> & Pick<AnalysisDocument, "id" | "name">): AnalysisDocument {
  const response = { name: "DIM1", type: "continuous" as const };
  const distribution = createDistributionItem({
    id: overrides.id,
    name: overrides.name,
    sourceDatasetId: "dataset-112",
    responses: [response],
    weight: null,
    frequency: null,
    by: [],
    columns: [{ name: response.name, sqlType: "DOUBLE", integerCompatible: false, field: response }],
    analysis: {
      confidenceLevel: 0.95,
      specLimits: {},
      fitDistributions: ["normal"],
    },
    createdAt: "2026-09-03T00:00:00.000Z",
  });

  return {
    schemaVersion: 1,
    documentType: "analysis",
    id: overrides.id,
    name: overrides.name,
    analysisKind: "distribution",
    configRevision: 1,
    source: { datasetId: "dataset-112" },
    definition: {
      kind: "distribution",
      responses: [response],
      weight: null,
      frequency: null,
      by: [],
      analysis: {
        confidenceLevel: 0.95,
        specLimits: {},
        fitDistributions: ["normal"],
      },
      graphs: distribution.graphs,
    },
    presentation: {
      schemaVersion: 1,
      layout: "distribution-v1",
    },
    createdAt: "2026-09-03T00:00:00.000Z",
    updatedAt: "2026-09-03T00:00:00.000Z",
    ...overrides,
  };
}

// @ts-expect-error immutable identity fields must not be accepted by analysis patches
const invalidAnalysisPatch: AnalysisDocumentPatch = {
  id: "analysis-immutable",
  schemaVersion: 2,
  documentType: "analysis",
  analysisKind: "distribution",
  createdAt: "2026-09-03T00:00:00.000Z",
};
void invalidAnalysisPatch;

function reset(): void {
  useProjectStore.setState({ readOnly: false });
  useAnalysisStore.getState().reset();
}

reset();

assert.equal(useAnalysisStore.getState().nextName(), "Analysis 1");
useAnalysisStore.getState().addAnalysis(makeAnalysisDocument({ id: "analysis-1", name: "Analysis 1" }));
assert.equal(useAnalysisStore.getState().items.length, 1);
assert.equal(useAnalysisStore.getState().counter, 1);
assert.equal(useAnalysisStore.getState().nextName(), "Analysis 2");

useAnalysisStore.getState().updateAnalysis("analysis-1", {
  name: "Analysis 7",
  definition: {
    kind: "distribution",
    responses: [{ name: "DIM1", type: "continuous" }],
    weight: null,
    frequency: null,
    by: [],
    analysis: {
      confidenceLevel: 0.9,
      specLimits: { DIM1: { lsl: 1, target: 2, usl: 3 } },
      fitDistributions: ["normal"],
    },
    graphs: makeAnalysisDocument({ id: "analysis-graph", name: "Analysis Graph" }).definition.graphs,
  },
  presentation: {
    schemaVersion: 1,
    layout: "distribution-v1",
  },
  source: { datasetId: "dataset-113" },
  configRevision: 2,
  updatedAt: "2026-09-03T01:00:00.000Z",
  id: "analysis-immutable",
  schemaVersion: 2,
  documentType: "analysis",
  analysisKind: "distribution",
  createdAt: "2026-09-03T00:00:00.000Z",
} as AnalysisDocumentPatch);
const updatedAnalysis = useAnalysisStore.getState().items[0];
assert.equal(updatedAnalysis?.name, "Analysis 7");
assert.equal(updatedAnalysis?.id, "analysis-1");
assert.equal(updatedAnalysis?.documentType, "analysis");
assert.equal(updatedAnalysis?.schemaVersion, 1);
assert.equal(updatedAnalysis?.analysisKind, "distribution");
assert.equal(updatedAnalysis?.createdAt, "2026-09-03T00:00:00.000Z");
assert.equal(updatedAnalysis?.updatedAt, "2026-09-03T01:00:00.000Z");
assert.equal(updatedAnalysis?.configRevision, 2);
assert.deepEqual(updatedAnalysis?.source, { datasetId: "dataset-113" });
assert.equal(useAnalysisStore.getState().counter, 7);

useAnalysisStore.getState().removeAnalysis("analysis-1");
assert.deepEqual(useAnalysisStore.getState().items, []);

useAnalysisStore.getState().loadAnalyses([
  makeAnalysisDocument({ id: "analysis-2", name: "Analysis 2" }),
  makeAnalysisDocument({ id: "analysis-5", name: "Analysis 5" }),
  makeAnalysisDocument({ id: "custom", name: "Notes" }),
]);
assert.deepEqual(useAnalysisStore.getState().items.map((item) => item.name), ["Analysis 2", "Analysis 5", "Notes"]);
assert.equal(useAnalysisStore.getState().counter, 5);
assert.equal(useAnalysisStore.getState().nextName(), "Analysis 6");

useProjectStore.setState({ readOnly: true });

assert.throws(() => useAnalysisStore.getState().addAnalysis(makeAnalysisDocument({ id: "blocked-add", name: "Analysis 9" })), /read-only/i);
assert.throws(() => useAnalysisStore.getState().updateAnalysis("analysis-2", { name: "Blocked" }), /read-only/i);
assert.throws(() => useAnalysisStore.getState().removeAnalysis("analysis-2"), /read-only/i);
assert.throws(() => useAnalysisStore.getState().nextName(), /read-only/i);

useProjectStore.setState({ readOnly: false });
useAnalysisStore.getState().reset();
assert.deepEqual(useAnalysisStore.getState().items, []);
assert.equal(useAnalysisStore.getState().counter, 0);

console.log("analysis store contract passed");