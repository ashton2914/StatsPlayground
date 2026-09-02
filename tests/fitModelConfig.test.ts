import assert from "node:assert/strict";

import {
  applyFactorialDegree,
  canonicalInteraction,
  canonicalizeFitModelTerms,
  createFitModelItem,
  fitModelParameterCount,
  fitModelTermIdentityKey,
  FitModelValidationError,
  validateFitModelDefinition,
} from "../src/components/fitModel/fitModelConfig.ts";
import type { FitModelTerm } from "../src/types/fitModel.ts";

const response = { name: "Yield", type: "continuous" as const };
const temperature = { name: "Temperature", type: "continuous" as const };
const pressure = { name: "Pressure", type: "continuous" as const };
const batch = { name: "Batch", type: "nominal" as const };

const compileTimeMainTerm = {
  kind: "main",
  columnNames: ["Temperature"],
} satisfies FitModelTerm;
assert.equal(compileTimeMainTerm.kind, "main");

const compileTimeInteractionTerm = {
  kind: "interaction",
  columnNames: ["Temperature", "Pressure"],
} satisfies FitModelTerm;
assert.equal(compileTimeInteractionTerm.kind, "interaction");

const compileTimePowerTerm = {
  kind: "power",
  columnNames: ["Temperature"],
  exponent: 2,
} satisfies FitModelTerm;
assert.equal(compileTimePowerTerm.kind, "power");

// @ts-expect-error main must have exactly one column at compile time
const compileTimeInvalidMainArity: FitModelTerm = {
  kind: "main",
  columnNames: ["Temperature", "Pressure"],
};
assert.equal(compileTimeInvalidMainArity.kind, "main");

// @ts-expect-error interaction must have at least two columns at compile time
const compileTimeInvalidInteractionArity: FitModelTerm = {
  kind: "interaction",
  columnNames: ["Temperature"],
};
assert.equal(compileTimeInvalidInteractionArity.kind, "interaction");

// @ts-expect-error power exponent must be required and equal to 2 at compile time
const compileTimeMissingPowerExponent: FitModelTerm = {
  kind: "power",
  columnNames: ["Temperature"],
};
assert.equal(compileTimeMissingPowerExponent.kind, "power");

assert.deepEqual(canonicalInteraction("Temperature", "Pressure"), ["Pressure", "Temperature"]);
assert.deepEqual(
  canonicalizeFitModelTerms([{ kind: "interaction", columnNames: ["C", "A", "B"] }]),
  [{ kind: "interaction", columnNames: ["A", "B", "C"] }],
);
assert.deepEqual(applyFactorialDegree([temperature, pressure], 1), [
  { kind: "main", columnNames: ["Temperature"] },
  { kind: "main", columnNames: ["Pressure"] },
]);
assert.deepEqual(applyFactorialDegree([temperature, pressure], 2), [
  { kind: "main", columnNames: ["Temperature"] },
  { kind: "main", columnNames: ["Pressure"] },
  { kind: "interaction", columnNames: ["Pressure", "Temperature"] },
]);
assert.equal(fitModelParameterCount(applyFactorialDegree([temperature, pressure], 2)), 4);
assert.deepEqual(
  validateFitModelDefinition({
    response,
    terms: applyFactorialDegree([temperature, pressure], 2),
    fields: [response, temperature, pressure],
  }),
  { ok: true },
);
assert.deepEqual(
  validateFitModelDefinition({
    response: { name: "Y", type: "continuous" },
    terms: [
      { kind: "main", columnNames: ["A"] },
      { kind: "main", columnNames: ["B"] },
      { kind: "main", columnNames: ["C"] },
      { kind: "interaction", columnNames: ["A", "B", "C"] },
    ],
  }),
  { ok: true },
);

assert.deepEqual(
  validateFitModelDefinition({
    response,
    terms: [
      { kind: "main", columnNames: ["Temperature"] },
      { kind: "power", columnNames: ["Temperature"], exponent: 2 },
    ],
  }),
  { ok: true },
);
assert.deepEqual(
  validateFitModelDefinition({
    response,
    terms: [{ kind: "power", columnNames: ["Temperature"], exponent: 2 }],
  }),
  { ok: false, reason: "missingMainEffect", columnName: "Temperature" },
);
assert.deepEqual(
  validateFitModelDefinition({
    response,
    terms: [
      { kind: "main", columnNames: ["Temperature"] },
      { kind: "power", columnNames: ["Temperature"], exponent: 3 } as unknown as { kind: "power"; columnNames: [string]; exponent: 2 },
    ],
  }),
  { ok: false, reason: "invalidPowerExponent", columnName: "Temperature", termKind: "power" },
);
assert.equal(
  fitModelTermIdentityKey({ kind: "interaction", columnNames: ["AB", "C"] }),
  "interaction\u00002:AB\u00001:C",
);
assert.equal(
  fitModelTermIdentityKey({ kind: "interaction", columnNames: ["A", "BC"] }),
  "interaction\u00001:A\u00002:BC",
);
assert.notEqual(
  fitModelTermIdentityKey({ kind: "interaction", columnNames: ["AB", "C"] }),
  fitModelTermIdentityKey({ kind: "interaction", columnNames: ["A", "BC"] }),
);
assert.equal(
  fitModelTermIdentityKey({ kind: "power", columnNames: ["Temperature"], exponent: 2 }),
  "power\u000011:Temperature\u00002",
);

assert.deepEqual(
  validateFitModelDefinition({
    response,
    terms: [{ kind: "interaction", columnNames: ["Pressure", "Temperature"] }],
  }),
  { ok: false, reason: "missingMainEffect", columnName: "Pressure" },
);

assert.deepEqual(
  validateFitModelDefinition({ response: null, terms: [{ kind: "main", columnNames: ["Temperature"] }] }),
  { ok: false, reason: "missingResponse" },
);
assert.deepEqual(validateFitModelDefinition({ response, terms: [] }), {
  ok: false,
  reason: "missingTerms",
});
assert.deepEqual(
  validateFitModelDefinition({
    response,
    terms: [{ kind: "main", columnNames: ["Yield"] }],
  }),
  { ok: false, reason: "responseInModel", columnName: "Yield" },
);
assert.deepEqual(
  validateFitModelDefinition({
    response: { name: "Batch", type: "nominal" },
    terms: [{ kind: "main", columnNames: ["Temperature"] }],
  }),
  { ok: false, reason: "nonContinuousResponse", columnName: "Batch" },
);
assert.deepEqual(
  validateFitModelDefinition({
    response,
    terms: [{ kind: "main", columnNames: ["Batch"] }],
    fields: [response, temperature, pressure, batch],
  }),
  { ok: false, reason: "nonContinuousPredictor", columnName: "Batch" },
);
assert.deepEqual(
  validateFitModelDefinition({
    response,
    terms: [
      { kind: "main", columnNames: ["Temperature"] },
      { kind: "main", columnNames: ["Temperature"] },
    ],
  }),
  { ok: false, reason: "duplicateTerm", termKey: "main:Temperature" },
);
assert.deepEqual(
  validateFitModelDefinition({
    response,
    terms: [
      { kind: "main", columnNames: ["Temperature"] },
      { kind: "main", columnNames: ["Pressure"] },
      { kind: "interaction", columnNames: ["Temperature", "Pressure"] },
      { kind: "interaction", columnNames: ["Pressure", "Temperature"] },
    ],
  }),
  {
    ok: false,
    reason: "duplicateTerm",
    termKey: "interaction:Pressure*Temperature",
  },
);
assert.deepEqual(
  validateFitModelDefinition({
    response: { name: "Y", type: "continuous" },
    terms: [
      { kind: "main", columnNames: ["A"] },
      { kind: "main", columnNames: ["B"] },
      { kind: "main", columnNames: ["C"] },
      { kind: "main", columnNames: ["A*B"] },
      { kind: "interaction", columnNames: ["A", "B"] },
      { kind: "interaction", columnNames: ["A*B", "C"] },
    ],
  }),
  { ok: true },
);
assert.deepEqual(
  validateFitModelDefinition({
    response: { name: "Y", type: "continuous" },
    terms: [
      { kind: "main", columnNames: ["A"] },
      { kind: "main", columnNames: ["B"] },
      { kind: "main", columnNames: ["C"] },
      { kind: "main", columnNames: ["B*C"] },
      { kind: "main", columnNames: ["A*B"] },
      { kind: "interaction", columnNames: ["A*B", "C"] },
      { kind: "interaction", columnNames: ["A", "B*C"] },
    ],
  }),
  { ok: true },
);
assert.deepEqual(
  validateFitModelDefinition({
    response,
    terms: [
      {
        kind: "main",
        columnNames: ["Temperature", "Pressure"],
      } as unknown as FitModelTerm,
    ],
  }),
  { ok: false, reason: "invalidTermArity", termKind: "main" },
);
assert.deepEqual(
  validateFitModelDefinition({
    response,
    terms: [{ kind: "interaction", columnNames: ["Temperature", "Temperature"] }],
  }),
  { ok: false, reason: "sameColumnInteraction", columnName: "Temperature" },
);
assert.deepEqual(
  validateFitModelDefinition({
    response,
    terms: [
      {
        kind: "quadratic",
        columnNames: ["Temperature"],
      } as unknown as { kind: "main" | "interaction"; columnNames: string[] },
    ],
  }),
  { ok: false, reason: "invalidTermKind", termKind: "quadratic" },
);

const item = createFitModelItem({
  fields: [response, temperature, pressure],
  id: "fit-model-1",
  name: "Fit Model 1",
  sourceDatasetId: "dataset-1",
  response,
  terms: applyFactorialDegree([temperature, pressure], 2),
  centeringMethod: "mean",
  createdAt: "2026-09-01T00:00:00.000Z",
});
assert.equal(item.centeringMethod, "mean");
assert.deepEqual(item.construct, { kind: "manual" });
assert.equal(Object.hasOwn(item, "fields"), false);

const responseSurfaceItem = createFitModelItem({
  fields: [response, temperature, pressure],
  id: "fit-model-rsm",
  name: "Fit Model RSM",
  sourceDatasetId: "dataset-1",
  response,
  terms: [
    { kind: "main", columnNames: ["Temperature"] },
    { kind: "main", columnNames: ["Pressure"] },
    { kind: "power", columnNames: ["Temperature"], exponent: 2 },
  ],
  construct: { kind: "responseSurface" },
  centeringMethod: "mean",
  createdAt: "2026-09-01T00:00:00.000Z",
});
assert.deepEqual(responseSurfaceItem.construct, { kind: "responseSurface" });

assert.throws(
  () =>
    createFitModelItem({
      fields: [response, temperature, batch],
      id: "fit-model-2",
      name: "Fit Model 2",
      sourceDatasetId: "dataset-1",
      response,
      terms: [{ kind: "main", columnNames: ["Batch"] }],
      centeringMethod: "none",
      createdAt: "2026-09-01T00:00:00.000Z",
    }),
  (error: unknown) =>
    error instanceof FitModelValidationError && error.result.reason === "nonContinuousPredictor",
);

console.log("fitModelConfig contract tests passed");
