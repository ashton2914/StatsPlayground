import type { FieldRef } from "@/graphCore/types";

export type FitYByXRole = "response" | "factor";
export type FitYByXValidationError =
  | "missingResponse"
  | "missingFactor"
  | "duplicateRole"
  | "invalidResponse"
  | "invalidFactor";

function isContinuous(field: FieldRef): boolean {
  return field.type === "continuous";
}

function isFactor(field: FieldRef): boolean {
  return field.type === "nominal" || field.type === "ordinal" || field.type === "continuous";
}

function isDuplicate(field: FieldRef, other?: FieldRef): boolean {
  return other !== undefined && other.name === field.name;
}

export function canAssignFitYByXRole(
  role: FitYByXRole,
  field: FieldRef,
  other?: FieldRef,
): true | FitYByXValidationError {
  if (isDuplicate(field, other)) return "duplicateRole";
  if (role === "response") {
    return isContinuous(field) ? true : "invalidResponse";
  }
  return isFactor(field) ? true : "invalidFactor";
}

export function validateFitYByXRoles(input: {
  response?: FieldRef;
  factor?: FieldRef;
}): { ok: true } | { ok: false; error: FitYByXValidationError } {
  if (!input.response) return { ok: false, error: "missingResponse" };
  if (!input.factor) return { ok: false, error: "missingFactor" };

  const responseValidation = canAssignFitYByXRole("response", input.response, input.factor);
  if (responseValidation !== true) return { ok: false, error: responseValidation };

  const factorValidation = canAssignFitYByXRole("factor", input.factor, input.response);
  if (factorValidation !== true) return { ok: false, error: factorValidation };

  return { ok: true };
}