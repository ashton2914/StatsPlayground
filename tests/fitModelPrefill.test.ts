import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  createFitModelDraft,
  createValidatedFitModelDraft,
  type FitModelFieldInfo,
} from "../src/components/fitModel/fitModelDialogState.ts";
import type { FitModelPrefill } from "../src/types/fitModel.ts";

const prefill: FitModelPrefill = {
  sourceDatasetId: "doe-table",
  response: { name: "Yield", type: "continuous" },
  predictors: [
    { name: "Temperature", type: "continuous" },
    { name: "Pressure", type: "continuous" },
  ],
  construct: { kind: "responseSurface" },
};

const draft = createFitModelDraft(prefill);
assert.equal(draft.response?.name, "Yield");
assert.equal(draft.construct.kind, "responseSurface");
assert.equal(draft.terms.filter((term) => term.kind === "power").length, 2);
assert.equal(draft.centeringMethod, "mean");

const fields: FitModelFieldInfo[] = [
  { name: "Yield", sqlType: "DOUBLE", modelingRole: "Continuous", field: prefill.response },
  { name: "Temperature", sqlType: "DOUBLE", modelingRole: "Continuous", field: prefill.predictors[0] },
  { name: "Pressure", sqlType: "DOUBLE", modelingRole: "Continuous", field: prefill.predictors[1] },
];

assert.equal(
  createValidatedFitModelDraft(prefill, "other-table", fields).validationMessage?.code,
  "prefillInvalid",
);
assert.equal(
  createValidatedFitModelDraft(prefill, "doe-table", fields.slice(0, 2)).validationMessage?.code,
  "prefillInvalid",
);
assert.equal(
  createValidatedFitModelDraft(
    { ...prefill, response: { name: "Yield", type: "nominal" } },
    "doe-table",
    fields,
  ).validationMessage?.code,
  "nonContinuousField",
);
assert.equal(
  createValidatedFitModelDraft(
    { ...prefill, predictors: [prefill.response, prefill.predictors[0]] },
    "doe-table",
    fields,
  ).validationMessage?.code,
  "prefillInvalid",
);
assert.equal(
  createValidatedFitModelDraft(
    { ...prefill, predictors: [prefill.predictors[0], prefill.predictors[0]] },
    "doe-table",
    fields,
  ).validationMessage?.code,
  "prefillInvalid",
);

const validated = createValidatedFitModelDraft(prefill, "doe-table", fields);
assert.equal(validated.validationMessage, null);
assert.deepEqual(validated.terms, draft.terms);

const identityFields: FitModelFieldInfo[] = [
  {
    name: "Yield",
    sqlType: "DOUBLE",
    modelingRole: "Continuous",
    field: { columnId: "response-id", name: "Yield", type: "continuous" },
  },
  {
    name: "Temperature",
    sqlType: "DOUBLE",
    modelingRole: "Continuous",
    field: { columnId: "temperature-id", name: "Temperature", type: "continuous" },
  },
  {
    name: "Pressure",
    sqlType: "DOUBLE",
    modelingRole: "Continuous",
    field: { columnId: "pressure-id", name: "Pressure", type: "continuous" },
  },
];
const stableIdPrefill: FitModelPrefill = {
  sourceDatasetId: "doe-table",
  response: { name: "response-id", type: "continuous" },
  predictors: [
    { name: "temperature-id", type: "continuous" },
    { name: "pressure-id", type: "continuous" },
  ],
  construct: { kind: "fullFactorial" },
};
const identityValidated = createValidatedFitModelDraft(stableIdPrefill, "doe-table", identityFields);
assert.equal(identityValidated.validationMessage, null);
assert.deepEqual(identityValidated.response, identityFields[0]?.field);
assert.deepEqual(identityValidated.terms, [
  { kind: "main", columnNames: ["Temperature"] },
  { kind: "main", columnNames: ["Pressure"] },
  { kind: "interaction", columnNames: ["Pressure", "Temperature"] },
]);

const roleDialogSource = readFileSync(
  path.resolve(process.cwd(), "src/components/fitModel/FitModelRoleDialog.tsx"),
  "utf8",
);
assert.match(roleDialogSource, /prefill\?: FitModelPrefill/);
assert.match(roleDialogSource, /createValidatedFitModelDraft\(prefill, dataset\.id/);
assert.doesNotMatch(roleDialogSource, /prefill[\s\S]{0,120}handleCreate\(\)/);
assert.match(roleDialogSource, /useEffect\(\(\) => \{\s*mountedRef\.current = true;/);

const workspaceSource = readFileSync(
  path.resolve(process.cwd(), "src/components/Workspace.tsx"),
  "utf8",
);
assert.match(workspaceSource, /openFitModel = \(prefill\?: FitModelPrefill\)/);
assert.match(workspaceSource, /<FitModelRoleDialog[\s\S]*prefill=\{fitModelPrefill\}/);

console.log("fitModel prefill contract passed");