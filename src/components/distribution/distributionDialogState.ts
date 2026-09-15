import type { FieldRef } from "@/graphCore/types";
import type { DistributionAnalysisConfig } from "@/types/distribution";

import {
  canAssignDistributionRole,
  createDefaultDistributionAnalysisConfig,
  type DistributionAnalysisValidationError,
  DISTRIBUTION_FIT_CAPABILITY_REGISTRY,
  type DistributionFieldInfo,
  isDistributionFitImplemented,
  type DistributionRole,
  type DistributionRoleValidationError,
  validateDistributionAnalysisConfig,
  validateDistributionRoles,
} from "./distributionConfig";

export type DistributionDialogValidationError =
  | DistributionRoleValidationError
  | DistributionAnalysisValidationError;

export interface DistributionDialogState {
  name: string;
  sourceDatasetId: string;
  responses: FieldRef[];
  weight: FieldRef | null;
  frequency: FieldRef | null;
  by: FieldRef[];
  nestedSubgroup: FieldRef | null;
  analysis: DistributionAnalysisConfig;
  validationError: DistributionDialogValidationError | null;
}

const DISTRIBUTION_FIT_ORDER = DISTRIBUTION_FIT_CAPABILITY_REGISTRY.map(
  ({ distributionId }) => distributionId,
);

function sortFitDistributions(
  fitDistributions: readonly DistributionAnalysisConfig["fitDistributions"][number][],
): DistributionAnalysisConfig["fitDistributions"] {
  const selected = new Set(fitDistributions);
  return DISTRIBUTION_FIT_ORDER.filter((distributionId) => selected.has(distributionId));
}

export function createDistributionDialogState(
  name: string,
  sourceDatasetId: string,
  analysis: DistributionAnalysisConfig = createDefaultDistributionAnalysisConfig(),
): DistributionDialogState {
  return {
    name,
    sourceDatasetId,
    responses: [],
    weight: null,
    frequency: null,
    by: [],
    nestedSubgroup: null,
    analysis: structuredClone(analysis),
    validationError: null,
  };
}

function occupiedFields(state: DistributionDialogState): FieldRef[] {
  return [
    ...state.responses,
    ...(state.weight ? [state.weight] : []),
    ...(state.frequency ? [state.frequency] : []),
    ...state.by,
    ...(state.nestedSubgroup ? [state.nestedSubgroup] : []),
  ];
}

export function assignDistributionField(
  state: DistributionDialogState,
  role: DistributionRole,
  field: DistributionFieldInfo,
): DistributionDialogState {
  const validation = canAssignDistributionRole(role, field, occupiedFields(state));
  if (validation !== true) return { ...state, validationError: validation };
  if (role === "response") {
    return { ...state, responses: [...state.responses, { ...field.field }], validationError: null };
  }
  if (role === "by") {
    return { ...state, by: [...state.by, { ...field.field }], validationError: null };
  }
  return { ...state, [role]: { ...field.field }, validationError: null };
}

export function clearDistributionField(
  state: DistributionDialogState,
  role: DistributionRole,
  fieldName?: string,
): DistributionDialogState {
  if (role === "response" || role === "by") {
    const key = role === "response" ? "responses" : "by";
    return {
      ...state,
      [key]: state[key].filter((field) => field.name !== fieldName),
      validationError: null,
    };
  }
  return { ...state, [role]: null, validationError: null };
}

export function toggleDistributionFit(
  state: DistributionDialogState,
  distributionId: DistributionAnalysisConfig["fitDistributions"][number],
): DistributionDialogState {
  if (!isDistributionFitImplemented(distributionId)) {
    return state;
  }
  const selected = state.analysis.fitDistributions.includes(distributionId)
    ? state.analysis.fitDistributions.filter((candidate) => candidate !== distributionId)
    : [...state.analysis.fitDistributions, distributionId];
  const analysis = {
    ...state.analysis,
    fitDistributions: sortFitDistributions(selected),
  };
  return {
    ...state,
    analysis,
    validationError: validateDistributionAnalysisConfig(analysis),
  };
}

export function setDistributionFitAll(
  state: DistributionDialogState,
  fitAll: boolean,
): DistributionDialogState {
  const analysis = {
    ...state.analysis,
    fitAll,
  };
  return {
    ...state,
    analysis,
    validationError: validateDistributionAnalysisConfig(analysis),
  };
}

export function filterDistributionFields(
  fields: readonly DistributionFieldInfo[],
  query: string,
): DistributionFieldInfo[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [...fields];
  return fields.filter((field) =>
    `${field.name} ${field.sqlType} ${field.field.type}`.toLocaleLowerCase().includes(needle),
  );
}

export function canCreateDistribution(
  state: DistributionDialogState,
  fields: readonly DistributionFieldInfo[],
): boolean {
  return state.name.trim().length > 0
    && validateDistributionRoles(state, fields).ok
    && validateDistributionAnalysisConfig(state.analysis) === null;
}