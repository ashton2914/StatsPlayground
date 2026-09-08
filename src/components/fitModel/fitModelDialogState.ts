import {
  canonicalInteraction,
  canonicalizeFitModelTerms,
  fitModelParameterCount,
  validateFitModelDefinition,
} from "@/components/fitModel/fitModelConfig";
import {
  buildFactorialToDegreeTerms,
  buildFullFactorialTerms,
  buildResponseSurfaceTerms,
  FitModelTermLimitError,
} from "@/components/fitModel/fitModelConstruct";
import { inferFieldType, type FieldRef } from "@/graphCore/types";
import type { ColumnDisplayProps } from "@/types/data";
import type {
  FitModelCenteringMethod,
  FitModelConstruct,
  FitModelPrefill,
  FitModelTerm,
} from "@/types/fitModel";

export const FIT_MODEL_DIALOG_FIELD_DRAG_MIME = "application/x-statsplayground-fit-model-field";

export interface FitModelDragPayload {
  fieldName: string;
}

export type FitModelDropZone = "response" | "mainEffects";

export interface FitModelFieldInfo {
  name: string;
  sqlType: string;
  modelingRole: "Continuous" | "Nominal" | "Ordinal" | "Datetime" | "Id";
  field: FieldRef;
}

export type FitModelDialogMessageCode =
  | "responseCollision"
  | "mainRequiredByInteraction"
  | "lastMainEffect"
  | "nonContinuousField"
  | "invalidInteraction"
  | "prefillInvalid"
  | "tooManyTerms";

export interface FitModelDialogMessage {
  code: FitModelDialogMessageCode;
  fieldName?: string;
  interactionLabels?: string[];
  detail?: string;
}

export interface FitModelDraft {
  response: FieldRef | null;
  predictors: FieldRef[];
  construct: FitModelConstruct;
  terms: FitModelTerm[];
  centeringMethod: FitModelCenteringMethod;
  validationMessage: FitModelDialogMessage | null;
}

export type FitModelDraftAction =
  | { type: "assignResponse"; field: FitModelFieldInfo }
  | { type: "clearResponse" }
  | { type: "toggleMainEffect"; field: FitModelFieldInfo }
  | { type: "addInteraction"; leftName: string; rightName: string }
  | { type: "removeInteraction"; leftName: string; rightName: string }
  | { type: "removeTerm"; term: FitModelTerm }
  | { type: "setConstruct"; construct: FitModelConstruct }
  | { type: "applyDegree"; degree: 1 | 2; fields: readonly FieldRef[] }
  | { type: "setCenteringMethod"; centeringMethod: FitModelCenteringMethod }
  | { type: "clearValidation" };

export interface FitModelFieldLoadSnapshot {
  generation: number;
  loading: boolean;
  error: string | null;
  fields: FitModelFieldInfo[];
}

export interface FitModelCreateDefinition {
  response: FieldRef;
  construct: FitModelConstruct;
  terms: FitModelTerm[];
  centeringMethod: FitModelCenteringMethod;
}

export interface FitModelSubmitState {
  creating: boolean;
  createError: string | null;
}

export interface FitModelSubmitCoordinator {
  getState: () => FitModelSubmitState;
  submit: (definition: FitModelCreateDefinition) => Promise<boolean>;
}

export type FitModelCreateHandler = (definition: FitModelCreateDefinition) => void | Promise<void>;

export function createFitModelDraft(prefill?: FitModelPrefill): FitModelDraft {
  const emptyDraft: FitModelDraft = {
    response: null,
    predictors: [],
    construct: { kind: "fullFactorial" },
    terms: [],
    centeringMethod: "none",
    validationMessage: null,
  };
  if (!prefill) {
    return emptyDraft;
  }

  return applyConstruct({
    ...emptyDraft,
    response: { ...prefill.response },
    predictors: prefill.predictors.map((field) => ({ ...field })),
  }, prefill.construct, prefill.predictors);
}

export function createValidatedFitModelDraft(
  prefill: FitModelPrefill | null | undefined,
  datasetId: string,
  fields: readonly FitModelFieldInfo[],
): FitModelDraft {
  if (!prefill) {
    return createFitModelDraft();
  }

  const referencedFields = [prefill.response, ...prefill.predictors];
  if (referencedFields.some((field) => field.type !== "continuous")) {
    return {
      ...createFitModelDraft(),
      validationMessage: { code: "nonContinuousField" },
    };
  }

  const predictorNames = prefill.predictors.map((field) => field.name);
  const hasFieldCollision = predictorNames.includes(prefill.response.name)
    || new Set(predictorNames).size !== predictorNames.length;
  const availableByName = new Map(fields.map((field) => [field.name, field]));
  const mismatch = hasFieldCollision
    || prefill.sourceDatasetId !== datasetId
    || referencedFields.some((field) => {
      const available = availableByName.get(field.name);
      return !available
        || available.modelingRole !== "Continuous"
        || available.field.type !== field.type;
    });
  if (mismatch) {
    return {
      ...createFitModelDraft(),
      validationMessage: {
        code: "prefillInvalid",
        detail: "The Fit Model prefill does not match the selected data table.",
      },
    };
  }

  return createFitModelDraft(prefill);
}

export function createFitModelFieldLoadSnapshot(): FitModelFieldLoadSnapshot {
  return {
    generation: 0,
    loading: false,
    error: null,
    fields: [],
  };
}

export function createFitModelSubmitState(): FitModelSubmitState {
  return {
    creating: false,
    createError: null,
  };
}

function formatRejectionReason(reason: unknown): string {
  if (reason instanceof Error && reason.message.trim().length > 0) {
    return reason.message;
  }
  if (typeof reason === "string" && reason.trim().length > 0) {
    return reason;
  }
  if (reason && typeof reason === "object") {
    const message = (reason as { message?: unknown }).message;
    if (typeof message === "string" && message.trim().length > 0) {
      return message;
    }
    try {
      const serialized = JSON.stringify(reason);
      if (serialized && serialized !== "{}") {
        return serialized;
      }
    } catch {
      // Fall through to generic fallback.
    }
  }
  const fallback = String(reason);
  return fallback === "[object Object]" ? "Unknown error" : fallback;
}

export function createFitModelSubmitCoordinator(onCreate: FitModelCreateHandler): FitModelSubmitCoordinator {
  let state = createFitModelSubmitState();
  let inFlight: Promise<void> | null = null;

  const getState = () => state;

  const submit = async (definition: FitModelCreateDefinition): Promise<boolean> => {
    if (inFlight) {
      return false;
    }

    state = { creating: true, createError: null };
    const attempt = Promise.resolve().then(() => onCreate(definition));
    inFlight = attempt;

    try {
      await attempt;
      state = { creating: false, createError: null };
      return true;
    } catch (reason) {
      state = { creating: false, createError: formatRejectionReason(reason) };
      return false;
    } finally {
      inFlight = null;
    }
  };

  return { getState, submit };
}

export function beginFitModelFieldLoad(snapshot: FitModelFieldLoadSnapshot): FitModelFieldLoadSnapshot {
  return {
    ...snapshot,
    generation: snapshot.generation + 1,
    loading: true,
    error: null,
  };
}

export function resolveFitModelFieldLoadSuccess(
  snapshot: FitModelFieldLoadSnapshot,
  generation: number,
  fields: FitModelFieldInfo[],
): FitModelFieldLoadSnapshot {
  if (generation !== snapshot.generation) {
    return snapshot;
  }

  return {
    ...snapshot,
    loading: false,
    error: null,
    fields,
  };
}

export function resolveFitModelFieldLoadError(
  snapshot: FitModelFieldLoadSnapshot,
  generation: number,
  reason: unknown,
): FitModelFieldLoadSnapshot {
  if (generation !== snapshot.generation) {
    return snapshot;
  }

  return {
    ...snapshot,
    loading: false,
    error: String(reason),
    fields: [],
  };
}

export function createAssignResponseAction(field: FitModelFieldInfo): FitModelDraftAction {
  return {
    type: "assignResponse",
    field,
  };
}

export function createToggleMainEffectAction(field: FitModelFieldInfo): FitModelDraftAction {
  return {
    type: "toggleMainEffect",
    field,
  };
}

export function createToggleInteractionAction(
  draft: Pick<FitModelDraft, "terms">,
  leftName: string,
  rightName: string,
): FitModelDraftAction {
  const [left, right] = canonicalInteraction(leftName, rightName);
  const exists = draft.terms.some((term) => (
    term.kind === "interaction"
    && term.columnNames.length === 2
    && canonicalInteraction(term.columnNames[0], term.columnNames[1])[0] === left
    && canonicalInteraction(term.columnNames[0], term.columnNames[1])[1] === right
  ));

  return exists
    ? { type: "removeInteraction", leftName: left, rightName: right }
    : { type: "addInteraction", leftName: left, rightName: right };
}

export function hasFitModelDragType(types: readonly string[]): boolean {
  return types.includes(FIT_MODEL_DIALOG_FIELD_DRAG_MIME);
}

export function parseFitModelDragPayload(raw: string): FitModelDragPayload | null {
  if (!raw) {
    return null;
  }

  try {
    const payload = JSON.parse(raw) as FitModelDragPayload;
    if (payload && typeof payload === "object" && typeof payload.fieldName === "string") {
      return payload;
    }
  } catch {
    return null;
  }

  return null;
}

export function readFitModelDragPayload(dataTransfer: Pick<DataTransfer, "getData">): FitModelDragPayload | null {
  return parseFitModelDragPayload(dataTransfer.getData(FIT_MODEL_DIALOG_FIELD_DRAG_MIME));
}

export function createFitModelDropAction(
  zone: FitModelDropZone,
  payload: FitModelDragPayload,
  fieldsByName: ReadonlyMap<string, FitModelFieldInfo>,
): FitModelDraftAction | null {
  const field = fieldsByName.get(payload.fieldName);
  if (!field) {
    return null;
  }

  if (zone === "response") {
    return createAssignResponseAction(field);
  }

  return createToggleMainEffectAction(field);
}

export function toFitModelFieldInfo(
  name: string,
  sqlType: string,
  displayProps?: ColumnDisplayProps,
): FitModelFieldInfo {
  const role = inferFitModelFieldType(name, sqlType, displayProps);
  return {
    name,
    sqlType,
    modelingRole: toModelingRoleLabel(role),
    field: {
      name,
      type: role,
    },
  };
}

function inferFitModelFieldType(name: string, sqlType: string, displayProps?: ColumnDisplayProps): FieldRef["type"] {
  const extras = displayProps?.extras as { valueOrder?: { values?: unknown }; role?: unknown; semanticRole?: unknown } | undefined;
  if (Array.isArray(extras?.valueOrder?.values) && extras.valueOrder.values.length > 0) {
    return "ordinal";
  }

  const explicitRole = extras?.semanticRole ?? extras?.role;
  if (explicitRole === "continuous" || explicitRole === "nominal" || explicitRole === "ordinal" || explicitRole === "datetime" || explicitRole === "id") {
    return explicitRole;
  }

  if (name.toLowerCase() === "id" || name.toLowerCase().endsWith("_id")) {
    return "id";
  }

  return inferFieldType(sqlType);
}

function toModelingRoleLabel(role: FieldRef["type"]): FitModelFieldInfo["modelingRole"] {
  if (role === "continuous") return "Continuous";
  if (role === "ordinal") return "Ordinal";
  if (role === "datetime") return "Datetime";
  if (role === "id") return "Id";
  return "Nominal";
}

function cloneField(field: FieldRef): FieldRef {
  return { name: field.name, type: field.type };
}

function cloneConstruct(construct: FitModelConstruct): FitModelConstruct {
  if (construct.kind === "factorialToDegree") {
    return { kind: "factorialToDegree", degree: construct.degree };
  }
  return { kind: construct.kind };
}

function normalizePredictors(predictors: readonly FieldRef[], response: FieldRef | null): FieldRef[] {
  const deduped: FieldRef[] = [];
  const names = new Set<string>();
  for (const predictor of predictors) {
    if (predictor.type !== "continuous") {
      continue;
    }
    if (response?.name === predictor.name) {
      continue;
    }
    if (names.has(predictor.name)) {
      continue;
    }
    names.add(predictor.name);
    deduped.push(cloneField(predictor));
  }
  return deduped;
}

function mainNamesFromTerms(terms: readonly FitModelTerm[]): Set<string> {
  const names = new Set<string>();
  for (const term of terms) {
    if (term.kind === "main") {
      names.add(term.columnNames[0]);
    }
  }
  return names;
}

function hasInteractionTerms(terms: readonly FitModelTerm[]): boolean {
  return terms.some((term) => term.kind === "interaction");
}

function normalizeConstruct(construct: FitModelConstruct, predictorCount: number): FitModelConstruct {
  if (construct.kind !== "factorialToDegree") {
    return cloneConstruct(construct);
  }

  const minDegree = 1;
  const maxDegree = Math.max(1, predictorCount);
  const boundedDegree = Math.max(minDegree, Math.min(maxDegree, Math.trunc(construct.degree)));
  return { kind: "factorialToDegree", degree: boundedDegree };
}

function buildTermsFromConstruct(construct: FitModelConstruct, predictors: readonly FieldRef[]): FitModelTerm[] {
  if (construct.kind === "manual") {
    return [];
  }
  if (construct.kind === "fullFactorial") {
    return buildFullFactorialTerms(predictors);
  }
  if (construct.kind === "responseSurface") {
    return buildResponseSurfaceTerms(predictors);
  }
  return buildFactorialToDegreeTerms(predictors, construct.degree);
}

function applyConstruct(
  draft: FitModelDraft,
  construct: FitModelConstruct,
  predictors: readonly FieldRef[] = draft.predictors,
): FitModelDraft {
  const normalizedPredictors = normalizePredictors(predictors, draft.response);
  const normalizedConstruct = normalizeConstruct(construct, normalizedPredictors.length);

  if (normalizedConstruct.kind === "manual") {
    const centeringMethod = hasInteractionTerms(draft.terms) ? draft.centeringMethod : "none";
    return {
      ...draft,
      predictors: normalizedPredictors,
      construct: normalizedConstruct,
      centeringMethod,
      validationMessage: null,
    };
  }

  try {
    const terms = canonicalizeFitModelTerms(buildTermsFromConstruct(normalizedConstruct, normalizedPredictors));
    const centeringMethod = normalizedConstruct.kind === "responseSurface"
      ? "mean"
      : (draft.centeringMethod === "mean" && hasInteractionTerms(terms) ? "mean" : "none");
    return {
      ...draft,
      predictors: normalizedPredictors,
      construct: normalizedConstruct,
      terms,
      centeringMethod,
      validationMessage: null,
    };
  } catch (error) {
    if (error instanceof FitModelTermLimitError) {
      return {
        ...draft,
        predictors: normalizedPredictors,
        construct: normalizedConstruct,
        terms: [],
        centeringMethod: "none",
        validationMessage: {
          code: "tooManyTerms",
          detail: error.message,
        },
      };
    }
    throw error;
  }
}

function termLabel(term: FitModelTerm): string {
  if (term.kind === "main") {
    return term.columnNames[0];
  }
  if (term.kind === "power") {
    return `${term.columnNames[0]}^2`;
  }
  return term.columnNames.join("*");
}

function termEquals(left: FitModelTerm, right: FitModelTerm): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.kind === "power" && right.kind === "power" && left.exponent !== right.exponent) {
    return false;
  }
  if (left.columnNames.length !== right.columnNames.length) {
    return false;
  }
  for (let index = 0; index < left.columnNames.length; index += 1) {
    if (left.columnNames[index] !== right.columnNames[index]) {
      return false;
    }
  }
  return true;
}

function isContinuousField(field: FieldRef): boolean {
  return field.type === "continuous";
}

export function assignFitModelResponse(draft: FitModelDraft, fieldInfo: FitModelFieldInfo): FitModelDraft {
  const field = fieldInfo.field;
  if (!isContinuousField(field)) {
    return {
      ...draft,
      validationMessage: {
        code: "nonContinuousField",
        fieldName: field.name,
      },
    };
  }

  if (draft.predictors.some((entry) => entry.name === field.name)) {
    return {
      ...draft,
      validationMessage: {
        code: "responseCollision",
        fieldName: field.name,
      },
    };
  }

  return {
    ...draft,
    response: cloneField(field),
    validationMessage: null,
  };
}

function addMainEffect(draft: FitModelDraft, fieldInfo: FitModelFieldInfo): FitModelDraft {
  const field = fieldInfo.field;
  if (!isContinuousField(field)) {
    return {
      ...draft,
      validationMessage: {
        code: "nonContinuousField",
        fieldName: field.name,
      },
    };
  }

  if (draft.response?.name === field.name) {
    return {
      ...draft,
      validationMessage: {
        code: "responseCollision",
        fieldName: field.name,
      },
    };
  }

  const predictors = [...draft.predictors, cloneField(field)];
  if (draft.construct.kind !== "manual") {
    return applyConstruct(draft, draft.construct, predictors);
  }

  const terms = canonicalizeFitModelTerms([
    ...draft.terms,
    { kind: "main", columnNames: [field.name] },
  ]);
  return {
    ...draft,
    predictors,
    terms,
    validationMessage: null,
  };
}

function removeMainEffect(draft: FitModelDraft, fieldName: string): FitModelDraft {
  if (draft.predictors.length <= 1) {
    return {
      ...draft,
      validationMessage: {
        code: "lastMainEffect",
        fieldName,
      },
    };
  }

  const requiredBy = draft.terms.filter((term) => (
    (term.kind === "interaction" && term.columnNames.includes(fieldName))
    || (term.kind === "power" && term.columnNames[0] === fieldName)
  ));
  if (requiredBy.length > 0) {
    return {
      ...draft,
      validationMessage: {
        code: "mainRequiredByInteraction",
        fieldName,
        interactionLabels: requiredBy.map((term) => termLabel(term)),
      },
    };
  }

  const predictors = draft.predictors.filter((field) => field.name !== fieldName);
  if (draft.construct.kind !== "manual") {
    return applyConstruct(draft, draft.construct, predictors);
  }

  const terms = draft.terms.filter((term) => !(
    term.kind === "main" && term.columnNames[0] === fieldName
  ));
  return {
    ...draft,
    predictors,
    terms,
    validationMessage: null,
  };
}

function addInteraction(draft: FitModelDraft, leftName: string, rightName: string): FitModelDraft {
  if (leftName === rightName) {
    return {
      ...draft,
      validationMessage: {
        code: "invalidInteraction",
      },
    };
  }

  const mainNames = mainNamesFromTerms(draft.terms);
  if (!mainNames.has(leftName) || !mainNames.has(rightName)) {
    return {
      ...draft,
      validationMessage: {
        code: "invalidInteraction",
      },
    };
  }

  const nextInteraction = canonicalInteraction(leftName, rightName);
  if (draft.terms.some((term) => (
    term.kind === "interaction"
    && term.columnNames.length === 2
    && canonicalInteraction(term.columnNames[0], term.columnNames[1])[0] === nextInteraction[0]
    && canonicalInteraction(term.columnNames[0], term.columnNames[1])[1] === nextInteraction[1]
  ))) {
    return {
      ...draft,
      validationMessage: null,
    };
  }

  const terms = canonicalizeFitModelTerms([
    ...draft.terms,
    { kind: "interaction", columnNames: nextInteraction },
  ]);
  return {
    ...draft,
    construct: { kind: "manual" },
    terms,
    validationMessage: null,
  };
}

function removeInteraction(draft: FitModelDraft, leftName: string, rightName: string): FitModelDraft {
  const target = canonicalInteraction(leftName, rightName);
  const terms = draft.terms.filter((term) => !(
    term.kind === "interaction"
    && term.columnNames.length === 2
    && canonicalInteraction(term.columnNames[0], term.columnNames[1])[0] === target[0]
    && canonicalInteraction(term.columnNames[0], term.columnNames[1])[1] === target[1]
  ));
  const centeringMethod = hasInteractionTerms(terms) ? draft.centeringMethod : "none";
  return {
    ...draft,
    construct: { kind: "manual" },
    terms,
    centeringMethod,
    validationMessage: null,
  };
}

function applyDegreeMacro(draft: FitModelDraft, degree: 1 | 2, fields: readonly FieldRef[]): FitModelDraft {
  const predictors = fields.filter((field) => field.type === "continuous" && field.name !== draft.response?.name);
  const nextDraft: FitModelDraft = {
    ...draft,
    predictors: normalizePredictors(predictors, draft.response),
  };
  return applyConstruct(nextDraft, { kind: "factorialToDegree", degree });
}

function removeTerm(draft: FitModelDraft, target: FitModelTerm): FitModelDraft {
  const canonicalTarget = canonicalizeFitModelTerms([target])[0];
  if (canonicalTarget.kind === "main") {
    return removeMainEffect(draft, canonicalTarget.columnNames[0]);
  }

  const terms = draft.terms.filter((term) => !termEquals(term, canonicalTarget));
  const centeringMethod = hasInteractionTerms(terms) ? draft.centeringMethod : "none";
  return {
    ...draft,
    construct: { kind: "manual" },
    terms,
    centeringMethod,
    validationMessage: null,
  };
}

function setCenteringMethod(draft: FitModelDraft, centeringMethod: FitModelCenteringMethod): FitModelDraft {
  if (centeringMethod === "mean" && !hasInteractionTerms(draft.terms)) {
    return {
      ...draft,
      centeringMethod: "none",
      validationMessage: null,
    };
  }

  return {
    ...draft,
    centeringMethod,
    validationMessage: null,
  };
}

export function reduceFitModelDraft(draft: FitModelDraft, action: FitModelDraftAction): FitModelDraft {
  switch (action.type) {
    case "assignResponse":
      return assignFitModelResponse(draft, action.field);
    case "clearResponse":
      return {
        ...draft,
        response: null,
        validationMessage: null,
      };
    case "toggleMainEffect": {
      const exists = draft.predictors.some((field) => field.name === action.field.name);
      return exists ? removeMainEffect(draft, action.field.name) : addMainEffect(draft, action.field);
    }
    case "addInteraction":
      return addInteraction(draft, action.leftName, action.rightName);
    case "removeInteraction":
      return removeInteraction(draft, action.leftName, action.rightName);
    case "removeTerm":
      return removeTerm(draft, action.term);
    case "setConstruct":
      return applyConstruct(draft, action.construct);
    case "applyDegree":
      return applyDegreeMacro(draft, action.degree, action.fields);
    case "setCenteringMethod":
      return setCenteringMethod(draft, action.centeringMethod);
    case "clearValidation":
      return {
        ...draft,
        validationMessage: null,
      };
    default:
      return draft;
  }
}

export function termsFromDraft(draft: FitModelDraft): FitModelTerm[] {
  return canonicalizeFitModelTerms(draft.terms);
}

export function canCreateFitModel(draft: FitModelDraft): boolean {
  if (!draft.response) {
    return false;
  }

  const terms = draft.terms;
  if (terms.length === 0) {
    return false;
  }

  if (draft.centeringMethod === "mean" && !hasInteractionTerms(terms)) {
    return false;
  }

  const validation = validateFitModelDefinition({
    response: draft.response,
    terms,
    fields: [draft.response, ...draft.predictors],
  });

  return validation.ok && fitModelParameterCount(terms) >= 2;
}

export function filterFitModelFields(fields: readonly FitModelFieldInfo[], query: string): FitModelFieldInfo[] {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return [...fields];
  }

  return fields.filter(({ name, sqlType, modelingRole }) => {
    const haystack = `${name} ${sqlType} ${modelingRole}`.toLowerCase();
    return haystack.includes(needle);
  });
}
