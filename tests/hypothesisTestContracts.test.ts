import assert from "node:assert/strict";

import type { HypothesisTestAnalysisDocument } from "../src/types/analysis.ts";
import {
  HYPOTHESIS_TEST_METHOD_IDS,
  type HypothesisTestAnalysisDefinition,
  type HypothesisTestAnalysisPresentation,
} from "../src/types/hypothesisTest.ts";

const presentation: HypothesisTestAnalysisPresentation = {
  schemaVersion: 1,
  layout: "hypothesis-test-v1",
  activeResultTab: "results",
  collapsedSections: [],
  graphs: {
    showRawData: true,
    showIntervals: true,
    showDiagnostics: true,
  },
  tableSort: null,
};

function documentWithDefinition(
  id: string,
  definition: HypothesisTestAnalysisDefinition,
): HypothesisTestAnalysisDocument {
  return {
    schemaVersion: 1,
    documentType: "analysis",
    id,
    name: "Hypothesis Test",
    analysisKind: "hypothesisTest",
    configRevision: 1,
    source: { datasetId: "dataset-1" },
    definition,
    presentation: structuredClone(presentation),
    createdAt: "2026-09-08T00:00:00Z",
    updatedAt: "2026-09-08T00:00:00Z",
  };
}

const automaticLong = documentWithDefinition("long", {
  kind: "hypothesisTest",
  roles: {
    layout: "long",
    response: { name: "Strength", type: "continuous" },
    condition: { name: "Site", type: "nominal" },
    subject: null,
  },
  studyDesign: "independent",
  selectionMode: "automatic",
  manualSelection: null,
  alternative: "twoSided",
  alpha: 0.05,
  confidenceLevel: 0.95,
  levelOrder: [],
  referenceLevel: null,
  postHoc: "automatic",
  selectorVersion: "1",
});

const manualWide = documentWithDefinition("wide", {
  kind: "hypothesisTest",
  roles: {
    layout: "wide",
    measurements: [
      { name: "Before", type: "continuous" },
      { name: "After", type: "continuous" },
    ],
    subject: { name: "Part", type: "id" },
  },
  studyDesign: "pairedOrBlocked",
  selectionMode: "manual",
  manualSelection: {
    methodId: "wilcoxonSignedRank",
    reason: "Heavy tails and influential paired differences",
  },
  alternative: "twoSided",
  alpha: 0.05,
  confidenceLevel: 0.95,
  levelOrder: ["Before", "After"],
  referenceLevel: "Before",
  postHoc: "off",
  selectorVersion: "1",
});

assert.equal(automaticLong.definition.roles.layout, "long");
assert.equal(automaticLong.definition.manualSelection, null);
assert.equal(manualWide.definition.roles.layout, "wide");
assert.equal(manualWide.definition.manualSelection?.methodId, "wilcoxonSignedRank");
assert.equal(HYPOTHESIS_TEST_METHOD_IDS.length, 10);
assert.equal(new Set(HYPOTHESIS_TEST_METHOD_IDS).size, 10);

for (const document of [automaticLong, manualWide]) {
  const persisted = JSON.parse(JSON.stringify(document)) as Record<string, unknown>;
  for (const runtimeKey of ["primaryResult", "diagnostics", "postHocResult", "sensitivityResults"]) {
    assert.equal(runtimeKey in persisted, false, `${runtimeKey} must not be persisted`);
  }
}

console.log("Hypothesis Test contracts passed");