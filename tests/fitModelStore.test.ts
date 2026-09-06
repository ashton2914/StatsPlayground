import assert from "node:assert/strict";

import { createFitModelItem } from "../src/components/fitModel/fitModelConfig.ts";
import { useProjectStore } from "../src/stores/useProjectStore.ts";
import type { FitModelItem } from "../src/types/fitModel.ts";

const { useFitModelStore } = await import("../src/stores/index.ts");

const response = { name: "Yield", type: "continuous" as const };
const temperature = { name: "Temperature", type: "continuous" as const };
const pressure = { name: "Pressure", type: "continuous" as const };
const fields = [response, temperature, pressure] as const;

function makeItem(id: string, name: string, sourceDatasetId = "dataset-1"): FitModelItem {
  return createFitModelItem({
    fields,
    id,
    name,
    sourceDatasetId,
    response,
    terms: [
      { kind: "main", columnNames: ["Temperature"] },
      { kind: "main", columnNames: ["Pressure"] },
      { kind: "interaction", columnNames: ["Pressure", "Temperature"] },
    ],
    centeringMethod: "mean",
    createdAt: "2026-09-01T00:00:00.000Z",
  });
}

function resetStore() {
  useProjectStore.setState({ readOnly: false });
  useFitModelStore.getState().reset();
}

resetStore();

const detached = makeItem("fit-detached", "Fit Model 2");
const termRef = detached.terms[0];
const responseRef = detached.response;
useFitModelStore.getState().addItem(detached);
termRef.columnNames[0] = "Corrupted";
responseRef.name = "Corrupted";
assert.equal(useFitModelStore.getState().items[0]?.terms[0]?.columnNames[0], "Temperature");
assert.equal(useFitModelStore.getState().items[0]?.response.name, "Yield");

const patch = {
  response: { name: "Yield", type: "continuous" as const },
  terms: [{ kind: "main", columnNames: ["Temperature"] }] as const,
};
useFitModelStore.getState().updateItem("fit-detached", patch);
patch.response.name = "Mutated";
patch.terms[0].columnNames[0] = "Mutated";
assert.equal(useFitModelStore.getState().items[0]?.response.name, "Yield");
assert.equal(useFitModelStore.getState().items[0]?.terms[0]?.columnNames[0], "Temperature");

useFitModelStore.getState().renameItem("fit-detached", "Fit Model 12");
assert.equal(useFitModelStore.getState().items[0]?.name, "Fit Model 12");
assert.equal(useFitModelStore.getState().nextName(), "Fit Model 13");

useFitModelStore.getState().addItem(makeItem("fit-other", "Custom Model", "dataset-2"));
useFitModelStore.getState().deleteByDataset("dataset-2");
assert.equal(useFitModelStore.getState().items.some((item) => item.id === "fit-other"), false);

useFitModelStore.getState().deleteItem("fit-detached");
assert.deepEqual(useFitModelStore.getState().items, []);

const persisted = {
  id: "fit-loaded",
  name: "Fit Model 9",
  sourceDatasetId: "dataset-loaded",
  response: { name: "Yield", type: "continuous" },
  terms: [
    { kind: "main", columnNames: ["Temperature"] },
    { kind: "main", columnNames: ["Pressure"] },
    { kind: "interaction", columnNames: ["Temperature", "Pressure"] },
    { kind: "interaction", columnNames: ["Pressure", "Temperature"] },
  ],
  centeringMethod: "none",
  createdAt: "2026-09-01T00:00:00.000Z",
  result: { kind: "fitted" },
  plotRows: [{ observed: 1 }],
  disclosureState: { section: true },
};
const invalidPowerPersisted = {
  id: "fit-invalid-power",
  name: "Fit Model 10",
  sourceDatasetId: "dataset-loaded",
  response: { name: "Yield", type: "continuous" },
  terms: [
    { kind: "main", columnNames: ["Temperature"] },
    { kind: "power", columnNames: ["Temperature"], exponent: 3 },
  ],
  centeringMethod: "mean",
  createdAt: "2026-09-01T00:00:00.000Z",
};
const malformed = {
  id: "fit-malformed",
  name: "Fit Model 100",
  sourceDatasetId: "dataset-loaded",
  response: { name: "Yield", type: "nominal" },
  terms: [{ kind: "main", columnNames: ["Temperature"] }],
  centeringMethod: "none",
  createdAt: "2026-09-01T00:00:00.000Z",
};

useProjectStore.setState({ readOnly: true });
useFitModelStore.getState().loadFromProject([persisted, invalidPowerPersisted, malformed]);
assert.equal(useFitModelStore.getState().items.length, 3);
assert.equal(useFitModelStore.getState().items[0]?.id, "fit-loaded");
assert.deepEqual(useFitModelStore.getState().items[0]?.construct, { kind: "manual" });
assert.deepEqual(useFitModelStore.getState().items[0]?.terms, [
  { kind: "main", columnNames: ["Temperature"] },
  { kind: "main", columnNames: ["Pressure"] },
  { kind: "interaction", columnNames: ["Pressure", "Temperature"] },
]);
assert.equal(useFitModelStore.getState().items[1]?.id, "fit-invalid-power");
assert.deepEqual(useFitModelStore.getState().items[1]?.construct, { kind: "manual" });
assert.equal(useFitModelStore.getState().items[1]?.centeringMethod, "mean");
assert.equal(useFitModelStore.getState().items[1]?.terms.length, 1);
assert.equal(useFitModelStore.getState().items[1]?.terms[0]?.kind, "main");
assert.equal(useFitModelStore.getState().items[1]?.loadIssue?.code, "invalidPersistedDefinition");
assert.match(useFitModelStore.getState().items[1]?.loadIssue?.detail ?? "", /invalidTerm:1/i);
assert.equal(useFitModelStore.getState().items[2]?.id, "fit-malformed");
assert.equal(useFitModelStore.getState().items[2]?.response.name, "Yield");
assert.equal(useFitModelStore.getState().items[2]?.response.type, "nominal");
assert.deepEqual(useFitModelStore.getState().items[1]?.terms, [
  { kind: "main", columnNames: ["Temperature"] },
]);
assert.equal(useFitModelStore.getState().items[2]?.centeringMethod, "none");
assert.equal(typeof useFitModelStore.getState().items[2]?.loadIssue?.code, "string");
assert.match(useFitModelStore.getState().items[2]?.loadIssue?.detail ?? "", /nonContinuousResponse/i);
assert.equal(useFitModelStore.getState().items[0]?.centeringMethod, "none");
assert.equal(Object.hasOwn(useFitModelStore.getState().items[0]!, "result"), false);
assert.equal(Object.hasOwn(useFitModelStore.getState().items[0]!, "plotRows"), false);
assert.equal(Object.hasOwn(useFitModelStore.getState().items[0]!, "disclosureState"), false);
assert.equal(useFitModelStore.getState().migrationWarnings.length, 1);
assert.match(useFitModelStore.getState().migrationWarnings[0] ?? "", /duplicate/i);

const stableIdPersisted = {
  id: "fit-stable-id",
  name: "Stable ID Model",
  sourceDatasetId: "dataset-loaded",
  response: { name: "response-id", type: "continuous" },
  construct: { kind: "fullFactorial" },
  terms: [
    { kind: "main", columnNames: ["temperature-id"] },
    { kind: "main", columnNames: ["pressure-id"] },
    { kind: "interaction", columnNames: ["temperature-id", "pressure-id"] },
  ],
  centeringMethod: "mean",
  createdAt: "2026-09-05T00:00:00.000Z",
};
useFitModelStore.getState().loadFromProject(
  [stableIdPersisted],
  new Map([
    ["dataset-loaded", [
      { columnId: "response-id", name: "Yield", sqlType: "DOUBLE" },
      { columnId: "temperature-id", name: "Temperature", sqlType: "DOUBLE" },
      { columnId: "pressure-id", name: "Pressure", sqlType: "DOUBLE" },
    ]],
  ]),
);
assert.equal(useFitModelStore.getState().items[0]?.response.name, "Yield");
assert.equal(useFitModelStore.getState().items[0]?.response.columnId, "response-id");
assert.deepEqual(useFitModelStore.getState().items[0]?.terms, [
  { kind: "main", columnNames: ["Temperature"] },
  { kind: "main", columnNames: ["Pressure"] },
  { kind: "interaction", columnNames: ["Pressure", "Temperature"] },
]);
useFitModelStore.getState().loadFromProject([persisted, invalidPowerPersisted, malformed]);

persisted.terms[0].columnNames[0] = "Mutated";
persisted.response.name = "Mutated";
assert.equal(useFitModelStore.getState().items[0]?.terms[0]?.columnNames[0], "Temperature");
assert.equal(useFitModelStore.getState().items[0]?.response.name, "Yield");

useProjectStore.setState({ readOnly: false });
assert.equal(useFitModelStore.getState().nextName(), "Fit Model 101");

useProjectStore.setState({ readOnly: true });
assert.throws(
  () => useFitModelStore.getState().addItem(makeItem("fit-blocked", "Fit Model 88")),
  /Project is read-only while save is in progress\./,
);
assert.throws(
  () => useFitModelStore.getState().updateItem("fit-loaded", { name: "Blocked" }),
  /Project is read-only while save is in progress\./,
);
assert.throws(
  () => useFitModelStore.getState().renameItem("fit-loaded", "Blocked"),
  /Project is read-only while save is in progress\./,
);
assert.throws(
  () => useFitModelStore.getState().deleteItem("fit-loaded"),
  /Project is read-only while save is in progress\./,
);
assert.throws(
  () => useFitModelStore.getState().deleteByDataset("dataset-loaded"),
  /Project is read-only while save is in progress\./,
);
assert.throws(
  () => useFitModelStore.getState().nextName(),
  /Project is read-only while save is in progress\./,
);
useProjectStore.setState({ readOnly: false });

useFitModelStore.getState().reset();
assert.deepEqual(useFitModelStore.getState().items, []);
assert.equal(useFitModelStore.getState().counter, 1);
assert.deepEqual(useFitModelStore.getState().migrationWarnings, []);

const tupleSafePersisted = {
  id: "fit-tuple-safe",
  name: "Fit Model 102",
  sourceDatasetId: "dataset-loaded",
  response: { name: "Yield", type: "continuous" },
  terms: [
    { kind: "main", columnNames: ["A"] },
    { kind: "main", columnNames: ["B*C"] },
    { kind: "main", columnNames: ["A*B"] },
    { kind: "main", columnNames: ["C"] },
    { kind: "interaction", columnNames: ["A", "B*C"] },
    { kind: "interaction", columnNames: ["A*B", "C"] },
  ],
  centeringMethod: "none",
  createdAt: "2026-09-01T00:00:00.000Z",
};
useFitModelStore.getState().loadFromProject([tupleSafePersisted]);
assert.equal(useFitModelStore.getState().items[0]?.terms.length, 6);
assert.deepEqual(useFitModelStore.getState().migrationWarnings, []);

useFitModelStore.getState().reset();

console.log("fitModel store contract passed");
