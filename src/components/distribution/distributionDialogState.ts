import type { FieldRef } from "@/graphCore/types";
import type { DistributionAnalysisConfig } from "@/types/distribution";

import {
  canAssignDistributionRole,
  createDefaultDistributionAnalysisConfig,
  type DistributionFieldInfo,
  type DistributionRole,
  type DistributionRoleValidationError,
  validateDistributionRoles,
} from "./distributionConfig";

export interface DistributionDialogState {
  name: string;
  sourceDatasetId: string;
  responses: FieldRef[];
  weight: FieldRef | null;
  frequency: FieldRef | null;
  by: FieldRef[];
  analysis: DistributionAnalysisConfig;
  validationError: DistributionRoleValidationError | null;
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
  return state.name.trim().length > 0 && validateDistributionRoles(state, fields).ok;
}