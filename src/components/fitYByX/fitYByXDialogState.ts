import type { FieldRef } from "@/graphCore/types";

import {
  canAssignFitYByXRole,
  type FitYByXRole,
  type FitYByXValidationError,
  validateFitYByXRoles,
} from "./fitYByXRoles";

export interface FitYByXFieldInfo {
  name: string;
  sqlType: string;
  modelingRole: "Continuous" | "Nominal" | "Ordinal" | "Datetime";
  field: FieldRef;
}

export interface FitYByXDialogState {
  name: string;
  response?: FieldRef;
  factor?: FieldRef;
  validationError: FitYByXValidationError | null;
}

export function createFitYByXDialogState(defaultName: string): FitYByXDialogState {
  return {
    name: defaultName,
    validationError: null,
  };
}

export function assignFitYByXField(
  state: FitYByXDialogState,
  role: FitYByXRole,
  field: FitYByXFieldInfo,
): FitYByXDialogState {
  const other = role === "response" ? state.factor : state.response;
  const validation = canAssignFitYByXRole(role, field.field, other);
  if (validation !== true) {
    return {
      ...state,
      validationError: validation,
    };
  }

  return {
    ...state,
    [role]: { ...field.field },
    validationError: null,
  };
}

export function clearFitYByXField(state: FitYByXDialogState, role: FitYByXRole): FitYByXDialogState {
  return {
    ...state,
    [role]: undefined,
    validationError: null,
  };
}

export function filterFitYByXFields(fields: readonly FitYByXFieldInfo[], query: string): FitYByXFieldInfo[] {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return [...fields];
  }

  return fields.filter(({ name, sqlType, modelingRole }) => {
    const haystack = `${name} ${sqlType} ${modelingRole}`.toLowerCase();
    return haystack.includes(needle);
  });
}

export function canCreateFitYByX(state: FitYByXDialogState): boolean {
  return state.name.trim().length > 0 && validateFitYByXRoles({
    response: state.response,
    factor: state.factor,
  }).ok;
}