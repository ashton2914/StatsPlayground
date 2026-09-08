import assert from "node:assert/strict";

import {
  createFitModelAnalysisDocument,
  isFitModelAnalysisDocument,
  normalizeLegacyFitModelAnalysis,
} from "../src/components/analysis/adapters/fitModelAnalysisAdapter.ts";
import type { FitModelItem } from "../src/types/fitModel.ts";

const createdAt = "2026-09-08T00:00:00.000Z";
const updatedAt = "2026-09-08T01:00:00.000Z";
const item: FitModelItem = {
  id: "fit-model-1",
  name: "Fit Model 1",
  sourceDatasetId: "dataset-1",
  response: { name: "Yield", type: "continuous" },
  construct: { kind: "manual" },
  terms: [
    { kind: "main", columnNames: ["Temperature"] },
    { kind: "main", columnNames: ["Pressure"] },
    { kind: "interaction", columnNames: ["Temperature", "Pressure"] },
  ],
  centeringMethod: "mean",
  createdAt,
};

const document = createFitModelAnalysisDocument({ item, confidenceLevel: 0.95, updatedAt });
assert.equal(document.schemaVersion, 1);
assert.equal(document.documentType, "analysis");
assert.equal(document.analysisKind, "fitModel");
assert.equal(document.definition.kind, "fitModel");
assert.equal(document.presentation.layout, "fit-model-v1");
assert.equal(document.definition.confidenceLevel, 0.95);
assert.equal(document.configRevision, 1);
assert.equal(document.createdAt, createdAt);
assert.equal(document.updatedAt, updatedAt);
assert.equal("migrationIssue" in document.definition, false);
assert.equal("result" in document, false);
assert.equal("plotRows" in document, false);
assert.equal(isFitModelAnalysisDocument(document), true);

item.response.name = "Mutated";
item.terms[0].columnNames[0] = "Mutated";
assert.equal(document.definition.response.name, "Yield");
assert.equal(document.definition.terms[0].columnNames[0], "Temperature");

const normalized = normalizeLegacyFitModelAnalysis({
  id: "legacy-fit",
  name: "Fit Model 2",
  sourceDatasetId: "dataset-2",
  response: { name: "Strength", type: "continuous" },
  terms: [
    { kind: "main", columnNames: ["B"] },
    { kind: "main", columnNames: ["A"] },
    { kind: "interaction", columnNames: ["B", "A"] },
    { kind: "interaction", columnNames: ["A", "B"] },
  ],
  centeringMethod: "none",
  createdAt,
}, updatedAt);
assert.equal(normalized.document?.analysisKind, "fitModel");
assert.deepEqual(normalized.document?.definition.terms, [
  { kind: "main", columnNames: ["B"] },
  { kind: "main", columnNames: ["A"] },
  { kind: "interaction", columnNames: ["A", "B"] },
]);
assert.equal(normalized.warnings.length, 1);
assert.match(normalized.warnings[0] ?? "", /duplicate/i);

const invalid = normalizeLegacyFitModelAnalysis({
  id: "legacy-invalid",
  name: "Fit Model 3",
  sourceDatasetId: "dataset-3",
  response: { name: "Site", type: "nominal" },
  construct: { kind: "unsupported" },
  terms: [{ kind: "main", columnNames: ["Temperature"] }],
  centeringMethod: "bad",
  createdAt,
  result: { kind: "fitted" },
  plotRows: [{ observed: 1 }],
}, updatedAt);
assert.equal(invalid.document?.id, "legacy-invalid");
assert.equal(invalid.document?.definition.migrationIssue?.code, "invalidPersistedDefinition");
assert.match(invalid.document?.definition.migrationIssue?.detail ?? "", /invalidConstruct/);
assert.match(invalid.document?.definition.migrationIssue?.detail ?? "", /invalidCenteringMethod/);
assert.match(invalid.document?.definition.migrationIssue?.detail ?? "", /nonContinuousResponse/);
assert.equal("result" in (invalid.document ?? {}), false);
assert.equal("plotRows" in (invalid.document ?? {}), false);

assert.deepEqual(normalizeLegacyFitModelAnalysis(null, updatedAt), {
  document: null,
  warnings: [],
});

console.log("Fit Model Analysis adapter contract passed");
