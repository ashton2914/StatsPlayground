import assert from "node:assert/strict";

import {
  compatibleHypothesisTestMethods,
  validateHypothesisTestDefinition,
} from "../src/components/hypothesisTest/hypothesisTestConfig.ts";
import {
  createHypothesisTestAnalysisDocument,
  createHypothesisTestAnalysisPatch,
  toHypothesisTestEditorItem,
} from "../src/components/analysis/adapters/hypothesisTestAnalysisAdapter.ts";
import type { HypothesisTestAnalysisDefinition } from "../src/types/hypothesisTest.ts";

function definition(): HypothesisTestAnalysisDefinition {
  return {
    kind: "hypothesisTest",
    roles: {
      layout: "long",
      response: { name: "Y", type: "continuous" },
      condition: { name: "Group", type: "nominal" },
      subject: null,
    },
    studyDesign: "independent",
    selectionMode: "automatic",
    manualSelection: null,
    alternative: "twoSided",
    alpha: 0.05,
    confidenceLevel: 0.95,
    levelOrder: ["A", "B"],
    referenceLevel: "A",
    postHoc: "automatic",
    selectorVersion: "1",
  };
}

assert.deepEqual(validateHypothesisTestDefinition(definition()), { ok: true });
assert.equal(validateHypothesisTestDefinition({
  ...definition(),
  studyDesign: "pairedOrBlocked",
}).ok, false);
assert.equal(validateHypothesisTestDefinition({
  ...definition(),
  roles: { ...definition().roles, response: { name: "Y", type: "nominal" } },
}).ok, false);
assert.equal(validateHypothesisTestDefinition({
  ...definition(),
  roles: {
    layout: "wide",
    measurements: [{ name: "A", type: "continuous" }],
    subject: null,
  },
}).ok, false);
assert.equal(validateHypothesisTestDefinition({
  ...definition(),
  selectionMode: "manual",
}).ok, false);
assert.equal(validateHypothesisTestDefinition({ ...definition(), alpha: 1 }).ok, false);
assert.equal(validateHypothesisTestDefinition({
  ...definition(),
  alternative: "greater",
  levelOrder: ["A", "B", "C"],
}).ok, false);

const compatible = compatibleHypothesisTestMethods(definition());
assert.equal(compatible.length, 10);
assert.deepEqual(
  compatible.filter((entry) => entry.compatible).map((entry) => entry.methodId),
  ["studentTwoSampleT", "welchTwoSampleT", "mannWhitneyU"],
);

const document = createHypothesisTestAnalysisDocument({
  id: "analysis-1",
  name: "Hypothesis Test 1",
  sourceDatasetId: "dataset-1",
  definition: definition(),
  createdAt: "2026-09-08T00:00:00.000Z",
});
assert.equal(document.analysisKind, "hypothesisTest");
assert.equal(document.configRevision, 1);
const editor = toHypothesisTestEditorItem(document);
editor.definition.alpha = 0.01;
assert.equal(document.definition.alpha, 0.05, "editor data must be cloned");

const presentationPatch = createHypothesisTestAnalysisPatch(document, {
  ...toHypothesisTestEditorItem(document),
  presentation: {
    ...document.presentation,
    activeResultTab: "audit",
  },
}, "2026-09-08T01:00:00.000Z");
assert.equal(presentationPatch.configRevision, 1);

const definitionPatch = createHypothesisTestAnalysisPatch(document, {
  ...toHypothesisTestEditorItem(document),
  definition: { ...document.definition, alpha: 0.01 },
}, "2026-09-08T01:00:00.000Z");
assert.equal(definitionPatch.configRevision, 2);