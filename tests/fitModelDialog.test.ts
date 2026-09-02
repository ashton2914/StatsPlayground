import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { FitModelCenteringMethod } from "../src/types/fitModel.ts";
import {
  beginFitModelFieldLoad,
  FIT_MODEL_DIALOG_FIELD_DRAG_MIME,
  assignFitModelResponse,
  canCreateFitModel,
  createFitModelSubmitCoordinator,
  createAssignResponseAction,
  createFitModelDropAction,
  createFitModelDraft,
  createFitModelFieldLoadSnapshot,
  createToggleInteractionAction,
  createToggleMainEffectAction,
  filterFitModelFields,
  hasFitModelDragType,
  parseFitModelDragPayload,
  reduceFitModelDraft,
  resolveFitModelFieldLoadError,
  resolveFitModelFieldLoadSuccess,
  termsFromDraft,
  toFitModelFieldInfo,
  type FitModelDraft,
  type FitModelFieldInfo,
} from "../src/components/fitModel/fitModelDialogState.ts";

const fitModelBarrelSource = readFileSync(
  resolve(process.cwd(), "src/components/fitModel/index.ts"),
  "utf8",
);

assert.equal(
  fitModelBarrelSource.includes("FitModelRoleDialog") && fitModelBarrelSource.includes("./FitModelRoleDialog"),
  true,
  "Fit Model barrel must export FitModelRoleDialog",
);
assert.equal(
  fitModelBarrelSource.includes("fitModelDialogState")
    && fitModelBarrelSource.includes("createFitModelDraft")
    && fitModelBarrelSource.includes("canCreateFitModel"),
  true,
  "Fit Model barrel must export dialog-state helpers",
);

assert.equal(FIT_MODEL_DIALOG_FIELD_DRAG_MIME, "application/x-statsplayground-fit-model-field");
assert.equal(hasFitModelDragType(["text/plain", FIT_MODEL_DIALOG_FIELD_DRAG_MIME]), true);
assert.equal(hasFitModelDragType(["text/plain"]), false);
assert.deepEqual(parseFitModelDragPayload(""), null);
assert.deepEqual(parseFitModelDragPayload("{\"fieldName\":\"Temperature\"}"), { fieldName: "Temperature" });
assert.deepEqual(parseFitModelDragPayload("{\"fieldName\":42}"), null);

const response: FitModelFieldInfo = {
  name: "Yield",
  sqlType: "DOUBLE",
  modelingRole: "Continuous",
  field: { name: "Yield", type: "continuous" },
};
const temperature: FitModelFieldInfo = {
  name: "Temperature",
  sqlType: "DOUBLE",
  modelingRole: "Continuous",
  field: { name: "Temperature", type: "continuous" },
};
const pressure: FitModelFieldInfo = {
  name: "Pressure",
  sqlType: "DOUBLE",
  modelingRole: "Continuous",
  field: { name: "Pressure", type: "continuous" },
};
const nominalField: FitModelFieldInfo = {
  name: "Batch",
  sqlType: "VARCHAR",
  modelingRole: "Nominal",
  field: { name: "Batch", type: "nominal" },
};
const ordinalField: FitModelFieldInfo = {
  name: "Lot",
  sqlType: "VARCHAR",
  modelingRole: "Ordinal",
  field: { name: "Lot", type: "ordinal" },
};
const datetimeField: FitModelFieldInfo = {
  name: "CollectedAt",
  sqlType: "TIMESTAMP",
  modelingRole: "Datetime",
  field: { name: "CollectedAt", type: "datetime" },
};
const idField: FitModelFieldInfo = {
  name: "RowId",
  sqlType: "BIGINT",
  modelingRole: "Id",
  field: { name: "RowId", type: "id" },
};

const visibleByName = filterFitModelFields([response, temperature, pressure], "press");
assert.deepEqual(visibleByName.map((field) => field.name), ["Pressure"]);

const visibleBySqlType = filterFitModelFields([response, temperature, pressure], "double");
assert.deepEqual(visibleBySqlType.map((field) => field.name), ["Yield", "Temperature", "Pressure"]);

const visibleByRole = filterFitModelFields([response, nominalField, ordinalField], "ordinal");
assert.deepEqual(visibleByRole.map((field) => field.name), ["Lot"]);

const fieldsByName = new Map<string, FitModelFieldInfo>([
  [response.name, response],
  [temperature.name, temperature],
  [pressure.name, pressure],
]);
assert.deepEqual(
  createFitModelDropAction("response", { fieldName: response.name }, fieldsByName),
  createAssignResponseAction(response),
);
assert.deepEqual(
  createFitModelDropAction("mainEffects", { fieldName: temperature.name }, fieldsByName),
  createToggleMainEffectAction(temperature),
);
assert.equal(createFitModelDropAction("response", { fieldName: "Unknown" }, fieldsByName), null);

let draft = createFitModelDraft();
assert.deepEqual(draft, {
  response: null,
  predictors: [],
  construct: { kind: "manual" },
  terms: [],
  centeringMethod: "none",
  validationMessage: null,
});
assert.equal(canCreateFitModel(draft), false);

const nonContinuousResponse = assignFitModelResponse(draft, nominalField);
assert.equal(nonContinuousResponse.response, null);
assert.equal(nonContinuousResponse.validationMessage?.code, "nonContinuousField");

draft = assignFitModelResponse(draft, response);
assert.deepEqual(draft.response, response.field);

const addNominalMain = reduceFitModelDraft(draft, {
  type: "toggleMainEffect",
  field: nominalField,
});
assert.equal(addNominalMain.predictors.length, 0);
assert.equal(addNominalMain.validationMessage?.code, "nonContinuousField");

const addOrdinalMain = reduceFitModelDraft(draft, {
  type: "toggleMainEffect",
  field: ordinalField,
});
assert.equal(addOrdinalMain.predictors.length, 0);
assert.equal(addOrdinalMain.validationMessage?.code, "nonContinuousField");

const addDatetimeMain = reduceFitModelDraft(draft, {
  type: "toggleMainEffect",
  field: datetimeField,
});
assert.equal(addDatetimeMain.predictors.length, 0);
assert.equal(addDatetimeMain.validationMessage?.code, "nonContinuousField");

const addIdMain = reduceFitModelDraft(draft, {
  type: "toggleMainEffect",
  field: idField,
});
assert.equal(addIdMain.predictors.length, 0);
assert.equal(addIdMain.validationMessage?.code, "nonContinuousField");

draft = reduceFitModelDraft(draft, {
  type: "toggleMainEffect",
  field: temperature,
});
assert.deepEqual(draft.predictors, [temperature.field]);

const responseCollision = assignFitModelResponse(draft, temperature);
assert.equal(responseCollision.response?.name, "Yield");
assert.equal(responseCollision.validationMessage?.code, "responseCollision");

draft = reduceFitModelDraft(draft, {
  type: "toggleMainEffect",
  field: pressure,
});
assert.deepEqual(draft.predictors.map((field) => field.name), ["Temperature", "Pressure"]);

draft = reduceFitModelDraft(draft, {
  type: "addInteraction",
  leftName: "Temperature",
  rightName: "Pressure",
});
assert.deepEqual(termsFromDraft(draft), [
  { kind: "main", columnNames: ["Temperature"] },
  { kind: "main", columnNames: ["Pressure"] },
  { kind: "interaction", columnNames: ["Pressure", "Temperature"] },
]);

const toggleRemoveAction = createToggleInteractionAction(draft, "Temperature", "Pressure");
assert.deepEqual(toggleRemoveAction, {
  type: "removeInteraction",
  leftName: "Pressure",
  rightName: "Temperature",
});
draft = reduceFitModelDraft(draft, toggleRemoveAction);
assert.deepEqual(termsFromDraft(draft), [
  { kind: "main", columnNames: ["Temperature"] },
  { kind: "main", columnNames: ["Pressure"] },
]);

const toggleAddAction = createToggleInteractionAction(draft, "Temperature", "Pressure");
assert.deepEqual(toggleAddAction, {
  type: "addInteraction",
  leftName: "Pressure",
  rightName: "Temperature",
});
draft = reduceFitModelDraft(draft, toggleAddAction);
assert.deepEqual(termsFromDraft(draft), [
  { kind: "main", columnNames: ["Temperature"] },
  { kind: "main", columnNames: ["Pressure"] },
  { kind: "interaction", columnNames: ["Pressure", "Temperature"] },
]);

const withCentering = reduceFitModelDraft(draft, {
  type: "setCenteringMethod",
  centeringMethod: "mean",
});
assert.equal(withCentering.centeringMethod, "mean");

const blockedMainRemoval = reduceFitModelDraft(withCentering, {
  type: "toggleMainEffect",
  field: temperature,
});
assert.equal(blockedMainRemoval.validationMessage?.code, "mainRequiredByInteraction");
assert.deepEqual(blockedMainRemoval.validationMessage?.interactionLabels, ["Pressure*Temperature"]);

const removedInteraction = reduceFitModelDraft(withCentering, {
  type: "removeInteraction",
  leftName: "Pressure",
  rightName: "Temperature",
});
assert.deepEqual(termsFromDraft(removedInteraction), [
  { kind: "main", columnNames: ["Temperature"] },
  { kind: "main", columnNames: ["Pressure"] },
]);
assert.equal(removedInteraction.centeringMethod, "none");

const removeMain = reduceFitModelDraft(removedInteraction, {
  type: "toggleMainEffect",
  field: temperature,
});
assert.deepEqual(removeMain.predictors.map((field) => field.name), ["Pressure"]);

const blockedLastMain = reduceFitModelDraft(removeMain, {
  type: "toggleMainEffect",
  field: pressure,
});
assert.equal(blockedLastMain.validationMessage?.code, "lastMainEffect");
assert.deepEqual(blockedLastMain.predictors.map((field) => field.name), ["Pressure"]);

const macroSeed = reduceFitModelDraft(
  reduceFitModelDraft(
    reduceFitModelDraft(assignFitModelResponse(createFitModelDraft(), response), {
      type: "toggleMainEffect",
      field: temperature,
    }),
    {
      type: "toggleMainEffect",
      field: pressure,
    },
  ),
  {
    type: "addInteraction",
    leftName: "Temperature",
    rightName: "Pressure",
  },
);
const macroSeedWithCentering = reduceFitModelDraft(macroSeed, {
  type: "setCenteringMethod",
  centeringMethod: "mean",
});

const degreeOne = reduceFitModelDraft(macroSeedWithCentering, {
  type: "setConstruct",
  construct: { kind: "factorialToDegree", degree: 1 },
});
assert.equal(degreeOne.response?.name, "Yield");
assert.equal(degreeOne.centeringMethod, "none");
assert.deepEqual(termsFromDraft(degreeOne), [
  { kind: "main", columnNames: ["Temperature"] },
  { kind: "main", columnNames: ["Pressure"] },
]);

const degreeTwo = reduceFitModelDraft(macroSeedWithCentering, {
  type: "setConstruct",
  construct: { kind: "factorialToDegree", degree: 2 },
});
assert.equal(degreeTwo.response?.name, "Yield");
assert.equal(degreeTwo.centeringMethod, "mean");
assert.deepEqual(termsFromDraft(degreeTwo), [
  { kind: "main", columnNames: ["Temperature"] },
  { kind: "main", columnNames: ["Pressure"] },
  { kind: "interaction", columnNames: ["Pressure", "Temperature"] },
]);

const withThreePredictors = reduceFitModelDraft(macroSeedWithCentering, {
  type: "toggleMainEffect",
  field: {
    name: "Flow",
    sqlType: "DOUBLE",
    modelingRole: "Continuous",
    field: { name: "Flow", type: "continuous" },
  },
});

const responseSurface = reduceFitModelDraft(withThreePredictors, {
  type: "setConstruct",
  construct: { kind: "responseSurface" },
});
assert.equal(responseSurface.centeringMethod, "mean");
assert.equal(responseSurface.terms.filter((term) => term.kind === "power").length, 3);

const degreeThree = reduceFitModelDraft(withThreePredictors, {
  type: "setConstruct",
  construct: { kind: "factorialToDegree", degree: 3 },
});
assert.equal(degreeThree.terms.length, 7);

const invalidCentering = reduceFitModelDraft(degreeOne, {
  type: "setCenteringMethod",
  centeringMethod: "mean",
});
assert.equal(invalidCentering.centeringMethod, "none");

const validDraft = degreeTwo;
assert.equal(canCreateFitModel(validDraft), true);

const invalidHierarchy: FitModelDraft = {
  response: response.field,
  predictors: [{ name: "Temperature", type: "continuous" }],
  construct: { kind: "manual" },
  terms: [
    { kind: "main", columnNames: ["Temperature"] },
    { kind: "interaction", columnNames: ["Pressure", "Temperature"] },
  ],
  centeringMethod: "mean" satisfies FitModelCenteringMethod,
  validationMessage: null,
};
assert.equal(canCreateFitModel(invalidHierarchy), false);

const fitModelRoleDialogSource = readFileSync(
  resolve(process.cwd(), "src/components/fitModel/FitModelRoleDialog.tsx"),
  "utf8",
);

assert.equal(
  fitModelRoleDialogSource.includes("role=\"dialog\"")
    && fitModelRoleDialogSource.includes("aria-modal=\"true\""),
  true,
  "FitModelRoleDialog must use dialog semantics",
);
assert.equal(
  fitModelRoleDialogSource.includes("aria-describedby"),
  true,
  "FitModelRoleDialog must bind validation copy through aria-describedby",
);
assert.equal(
  fitModelRoleDialogSource.includes("onDragOver")
    && fitModelRoleDialogSource.includes("onDrop")
    && fitModelRoleDialogSource.includes("type=\"search\"")
    && fitModelRoleDialogSource.includes("common.retry"),
  true,
  "FitModelRoleDialog must keep structural drag/drop zones, searchable lists, and retry affordance",
);
assert.equal(
  fitModelRoleDialogSource.includes("Create") && fitModelRoleDialogSource.includes("Cancel"),
  true,
  "FitModelRoleDialog must keep Create and Cancel actions",
);
assert.equal(
  fitModelRoleDialogSource.includes("event.key.toLowerCase()")
    && fitModelRoleDialogSource.includes("key === \"y\"")
    && fitModelRoleDialogSource.includes("key === \"m\""),
  true,
  "FitModelRoleDialog must keep keyboard assignment shortcuts",
);
assert.equal(
  fitModelRoleDialogSource.includes("fitModel.dialog.constructManual")
    && fitModelRoleDialogSource.includes("fitModel.dialog.constructFactorial")
    && fitModelRoleDialogSource.includes("fitModel.dialog.constructResponseSurface")
    && fitModelRoleDialogSource.includes("fitModel.dialog.termCount")
    && fitModelRoleDialogSource.includes("fitModel.dialog.searchTerms"),
  true,
  "FitModelRoleDialog must render construct segmented controls, degree input, term count, and searchable term list",
);
assert.equal(
  !fitModelRoleDialogSource.includes("fitModel.dialog.twoWayOnly")
    && !fitModelRoleDialogSource.includes("sp-fit-model-interaction-builder"),
  true,
  "FitModelRoleDialog must remove two-way-only interaction matrix controls",
);
assert.equal(
  fitModelRoleDialogSource.includes("aria-label={t(\"fitModel.dialog.assignResponseLabel\"")
    && fitModelRoleDialogSource.includes("aria-label={t(\"fitModel.dialog.assignMainLabel\""),
  true,
  "FitModelRoleDialog must keep localized accessibility labels for role assignment",
);

const baseLoad = createFitModelFieldLoadSnapshot();
assert.deepEqual(baseLoad, {
  generation: 0,
  loading: false,
  error: null,
  fields: [],
});

const firstLoad = beginFitModelFieldLoad(baseLoad);
assert.equal(firstLoad.generation, 1);
assert.equal(firstLoad.loading, true);
assert.equal(firstLoad.error, null);

const retryLoad = beginFitModelFieldLoad(firstLoad);
assert.equal(retryLoad.generation, 2);
assert.equal(retryLoad.loading, true);
assert.equal(retryLoad.error, null);

const staleCompletion = resolveFitModelFieldLoadSuccess(
  retryLoad,
  1,
  [temperature],
);
assert.deepEqual(staleCompletion, retryLoad);

const currentCompletion = resolveFitModelFieldLoadSuccess(
  staleCompletion,
  2,
  [pressure],
);
assert.equal(currentCompletion.loading, false);
assert.equal(currentCompletion.error, null);
assert.deepEqual(currentCompletion.fields.map((field) => field.name), ["Pressure"]);

const failedRetry = beginFitModelFieldLoad(currentCompletion);
const staleFailure = resolveFitModelFieldLoadError(failedRetry, 2, new Error("stale"));
assert.deepEqual(staleFailure, failedRetry);
const currentFailure = resolveFitModelFieldLoadError(failedRetry, 3, new Error("retry failed"));
assert.equal(currentFailure.loading, false);
assert.equal(currentFailure.error, "Error: retry failed");
assert.deepEqual(currentFailure.fields, []);

const continuousColumn = toFitModelFieldInfo("temperature", "DOUBLE");
assert.deepEqual(continuousColumn, {
  name: "temperature",
  sqlType: "DOUBLE",
  modelingRole: "Continuous",
  field: { name: "temperature", type: "continuous" },
});

const ordinalColumn = toFitModelFieldInfo("lot", "DOUBLE", { extras: { valueOrder: { values: ["1", "2"] } } });
assert.equal(ordinalColumn.field.type, "ordinal");
assert.equal(ordinalColumn.modelingRole, "Ordinal");

assert.equal(
  fitModelRoleDialogSource.includes("createFitModelSubmitCoordinator")
    && fitModelRoleDialogSource.includes("createError")
    && fitModelRoleDialogSource.includes("creating"),
  true,
  "FitModelRoleDialog must coordinate async submit state with helper-backed creating/createError state",
);

function createDeferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (reason: unknown) => void;
} {
  let resolveDeferred: (() => void) | null = null;
  let rejectDeferred: ((reason: unknown) => void) | null = null;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolveDeferred = resolvePromise;
    rejectDeferred = rejectPromise;
  });
  return {
    promise,
    resolve: () => resolveDeferred?.(),
    reject: (reason) => rejectDeferred?.(reason),
  };
}

let invocationCount = 0;
let deferred = createDeferred();
const coordinator = createFitModelSubmitCoordinator(async () => {
  invocationCount += 1;
  return deferred.promise;
});

assert.deepEqual(coordinator.getState(), { creating: false, createError: null });

const submitDefinition = {
  response: response.field,
  construct: { kind: "manual" } as const,
  terms: termsFromDraft(validDraft),
  centeringMethod: validDraft.centeringMethod,
};

const firstSubmit = coordinator.submit(submitDefinition);
await Promise.resolve();
assert.equal(invocationCount, 1);
assert.deepEqual(coordinator.getState(), { creating: true, createError: null });

const secondSubmit = await coordinator.submit(submitDefinition);
assert.equal(secondSubmit, false);
assert.equal(invocationCount, 1, "duplicate submits must be ignored while one submit is in flight");

deferred.reject(new Error("create failed"));
assert.equal(await firstSubmit, false);
assert.equal(coordinator.getState().creating, false);
assert.equal(coordinator.getState().createError?.includes("create failed"), true);

deferred = createDeferred();
const objectRejectSubmit = coordinator.submit(submitDefinition);
await Promise.resolve();
assert.equal(invocationCount, 2, "submit after failure should start a new request");
deferred.reject({ code: "distribution.config.invalid", detail: "missing column" });
assert.equal(await objectRejectSubmit, false);
assert.equal(coordinator.getState().createError?.includes("[object Object]"), false);
assert.equal(coordinator.getState().createError?.includes("distribution.config.invalid"), true);

deferred = createDeferred();
const retrySubmit = coordinator.submit(submitDefinition);
await Promise.resolve();
assert.equal(invocationCount, 3, "retry after failure must invoke submit again");
assert.deepEqual(coordinator.getState(), { creating: true, createError: null });
deferred.resolve();
assert.equal(await retrySubmit, true);
assert.deepEqual(coordinator.getState(), { creating: false, createError: null });

console.log("fitModel dialog contract tests passed");
