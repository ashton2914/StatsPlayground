import assert from "node:assert/strict";

import {
  canAssignFitYByXRole,
  createDefaultFitYByXGraphConfig,
  createFitYByXItem,
  validateFitYByXRoles,
} from "../src/components/fitYByX/fitYByXConfig.ts";
import {
  createEmbeddedGraphItem,
  normalizeGraphBuilderItem,
} from "../src/components/graphBuilder/graphBuilderMode.ts";

const response = { name: "height", type: "continuous" as const };
const factor = { name: "site", type: "nominal" as const };
const continuousFactor = { name: "age", type: "continuous" as const };
const ordinal = { name: "batch", type: "ordinal" as const };
const duplicateFactor = { name: "height", type: "nominal" as const };
const invalidFactor = { name: "site", type: "datetime" as const };

assert.equal(canAssignFitYByXRole("response", response), true);
assert.equal(canAssignFitYByXRole("factor", factor), true);
assert.equal(canAssignFitYByXRole("factor", continuousFactor), true);
assert.equal(canAssignFitYByXRole("factor", ordinal), true);
assert.equal(canAssignFitYByXRole("response", factor), "invalidResponse");
assert.equal(canAssignFitYByXRole("factor", invalidFactor), "invalidFactor");
assert.equal(canAssignFitYByXRole("factor", response, response), "duplicateRole");
assert.equal(canAssignFitYByXRole("response", factor, factor), "duplicateRole");
assert.equal(canAssignFitYByXRole("response", response, response), "duplicateRole");
assert.deepEqual(validateFitYByXRoles({ response, factor }), { ok: true });
assert.deepEqual(validateFitYByXRoles({ response }), { ok: false, error: "missingFactor" });
assert.deepEqual(validateFitYByXRoles({ factor }), { ok: false, error: "missingResponse" });
assert.deepEqual(validateFitYByXRoles({ response, factor: duplicateFactor }), { ok: false, error: "duplicateRole" });
assert.deepEqual(validateFitYByXRoles({ response: factor, factor: response }), { ok: false, error: "invalidResponse" });
assert.deepEqual(validateFitYByXRoles({ response, factor: continuousFactor }), { ok: true });

const config = createDefaultFitYByXGraphConfig({ response, factor });
assert.equal(config.mode, "2d");
assert.deepEqual(config.modeStates.twoD.encoding, { x: factor, y: response });
assert.deepEqual(config.modeStates.twoD.multiX, []);
assert.deepEqual(config.modeStates.twoD.multiY, []);
assert.deepEqual(config.modeStates.twoD.elements, [
  { kind: "points", enabled: true },
  { kind: "boxplot", enabled: true },
]);
assert.deepEqual(config.filters, []);
assert.deepEqual(config.sampling, { mode: "full" });

const bivariateConfig = createDefaultFitYByXGraphConfig({ response, factor: continuousFactor });
assert.deepEqual(bivariateConfig.modeStates.twoD.encoding, { x: continuousFactor, y: response });
assert.deepEqual(bivariateConfig.modeStates.twoD.elements, [
  { kind: "points", enabled: true },
  { kind: "fitline", enabled: true, options: { fitType: "polynomial", degree: 1, showFitCI: true } },
]);

const before = structuredClone(config);
const graphItem = createEmbeddedGraphItem({
  id: "fit-y-by-x-graph:fit-1",
  name: "Fit Y by X 1",
  sourceDatasetId: "table-1",
  config,
  createdAt: "2026-08-30T00:00:00.000Z",
});
assert.deepEqual(config, before);
assert.deepEqual(normalizeGraphBuilderItem(graphItem), graphItem);

const item = createFitYByXItem({
  id: "fit-1",
  name: "Fit Y by X 1",
  sourceDatasetId: "table-1",
  response,
  factor,
  createdAt: "2026-08-30T00:00:00.000Z",
});
assert.equal(item.personality, "oneway");
assert.deepEqual(item.graph, config);

const bivariateItem = createFitYByXItem({
  id: "fit-2",
  name: "Fit Y by X 2",
  sourceDatasetId: "table-1",
  response,
  factor: continuousFactor,
  createdAt: "2026-08-30T00:00:00.000Z",
});
assert.equal(bivariateItem.personality, "bivariate");
assert.deepEqual(bivariateItem.graph, bivariateConfig);

assert.throws(
  () => createFitYByXItem({
    id: "invalid-response",
    name: "Invalid response",
    sourceDatasetId: "table-1",
    response: factor,
    factor: ordinal,
    createdAt: "2026-08-30T00:00:00.000Z",
  }),
  /invalidResponse/,
);
assert.throws(
  () => createFitYByXItem({
    id: "invalid-factor",
    name: "Invalid factor",
    sourceDatasetId: "table-1",
    response,
    factor: invalidFactor,
    createdAt: "2026-08-30T00:00:00.000Z",
  }),
  /invalidFactor/,
);
assert.throws(
  () => createFitYByXItem({
    id: "duplicate",
    name: "Duplicate",
    sourceDatasetId: "table-1",
    response,
    factor: duplicateFactor,
    createdAt: "2026-08-30T00:00:00.000Z",
  }),
  /duplicateRole/,
);

console.log("fitYByXConfig contract tests passed");