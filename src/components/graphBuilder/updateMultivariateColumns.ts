import type { FieldRef } from "@/graphCore";

export type MultivariateColumnUpdate =
  | { type: "append"; fields: FieldRef[] }
  | { type: "remove"; index: number }
  | { type: "reorder"; from: number; to: number }
  | { type: "set"; fields: FieldRef[] };

export type MultivariateColumnUpdateError =
  | "invalidFieldType"
  | "duplicateField"
  | "maxColumns";

export interface MultivariateColumnUpdateResult {
  columns: FieldRef[];
  error?: MultivariateColumnUpdateError;
}

export const MAX_MULTIVARIATE_COLUMNS = 20;

function normalizeContinuousFields(fields: FieldRef[]): FieldRef[] {
  return fields.map((field) => ({ ...field, type: "continuous" as const }));
}

function validateCandidateColumns(fields: FieldRef[]): MultivariateColumnUpdateError | undefined {
  const seen = new Set<string>();
  for (const field of fields) {
    if (field.type !== "continuous") {
      return "invalidFieldType";
    }
    if (seen.has(field.name)) {
      return "duplicateField";
    }
    seen.add(field.name);
  }
  if (fields.length > MAX_MULTIVARIATE_COLUMNS) {
    return "maxColumns";
  }
  return undefined;
}

export function updateMultivariateColumns(
  current: FieldRef[],
  update: MultivariateColumnUpdate,
): MultivariateColumnUpdateResult {
  if (update.type === "remove") {
    if (update.index < 0 || update.index >= current.length) {
      return { columns: current };
    }
    return {
      columns: current.filter((_, index) => index !== update.index),
    };
  }

  if (update.type === "reorder") {
    const { from, to } = update;
    if (
      from < 0
      || to < 0
      || from >= current.length
      || to >= current.length
      || from === to
    ) {
      return { columns: current };
    }
    const next = [...current];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    return { columns: next };
  }

  if (update.type === "set") {
    const validationError = validateCandidateColumns(update.fields);
    if (validationError) {
      return { columns: current, error: validationError };
    }
    return { columns: normalizeContinuousFields(update.fields) };
  }

  if (update.fields.length === 0) {
    return { columns: current };
  }

  const incomingValidation = validateCandidateColumns(update.fields);
  if (incomingValidation) {
    return { columns: current, error: incomingValidation };
  }

  const existing = new Set(current.map((field) => field.name));
  for (const field of update.fields) {
    if (existing.has(field.name)) {
      return { columns: current, error: "duplicateField" };
    }
  }

  const candidate = [...current, ...normalizeContinuousFields(update.fields)];
  if (candidate.length > MAX_MULTIVARIATE_COLUMNS) {
    return { columns: current, error: "maxColumns" };
  }

  return { columns: candidate };
}
