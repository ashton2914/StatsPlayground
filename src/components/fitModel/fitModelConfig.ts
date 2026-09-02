import type { FieldRef } from "@/graphCore";
import type { FitModelConstruct, FitModelItem, FitModelTerm } from "@/types/fitModel";

import { buildFactorialToDegreeTerms } from "./fitModelConstruct";

export type FitModelValidationReason =
  | "missingResponse"
  | "missingTerms"
  | "invalidTermKind"
  | "invalidTermArity"
  | "sameColumnInteraction"
  | "responseInModel"
  | "nonContinuousResponse"
  | "nonContinuousPredictor"
  | "duplicateTerm"
  | "missingMainEffect"
  | "invalidPowerExponent";

export type FitModelValidationResult =
  | { ok: true }
  | {
      ok: false;
      reason: FitModelValidationReason;
      columnName?: string;
      termKey?: string;
      termKind?: string;
    };

export class FitModelValidationError extends Error {
  readonly result: Exclude<FitModelValidationResult, { ok: true }>;

  constructor(result: Exclude<FitModelValidationResult, { ok: true }>) {
    super(`Invalid Fit Model definition: ${result.reason}`);
    this.name = "FitModelValidationError";
    this.result = result;
  }
}

function clone<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => clone(entry)) as T;
  }
  if (typeof value === "object" && value !== null) {
    const next: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      next[key] = clone(entry);
    }
    return next as T;
  }
  return value;
}

export function canonicalInteraction(first: string, second: string): [string, string] {
  return first.localeCompare(second) <= 0 ? [first, second] : [second, first];
}

function canonicalInteractionColumns(columnNames: readonly string[]): string[] {
  return [...columnNames].sort((left, right) => left.localeCompare(right));
}

export function canonicalizeFitModelTerms(terms: readonly FitModelTerm[]): FitModelTerm[] {
  return terms.map((term) => {
    if (term.kind === "main") {
      return {
        kind: "main",
        columnNames: [...term.columnNames] as [string],
      };
    }

    if (term.kind === "power") {
      return {
        kind: "power",
        columnNames: [...term.columnNames] as [string],
        exponent: term.exponent,
      };
    }

    return {
      kind: "interaction",
      columnNames: canonicalInteractionColumns(term.columnNames),
    };
  });
}

function termKey(term: FitModelTerm): string {
  if (term.kind === "main") {
    return `main:${term.columnNames[0] ?? ""}`;
  }
  if (term.kind === "power") {
    return `power:${term.columnNames[0] ?? ""}^${term.exponent}`;
  }
  return `interaction:${term.columnNames.join("*")}`;
}

function encodeIdentityPart(value: string): string {
  return `${value.length}:${value}`;
}

export function fitModelTermIdentityKey(term: FitModelTerm): string {
  if (term.kind === "main") {
    return `main\u0000${encodeIdentityPart(term.columnNames[0] ?? "")}`;
  }

  if (term.kind === "power") {
    const columnName = term.columnNames[0] ?? "";
    return `power\u0000${encodeIdentityPart(columnName)}\u0000${term.exponent}`;
  }

  const encodedColumns = canonicalInteractionColumns(term.columnNames)
    .map((columnName) => encodeIdentityPart(columnName))
    .join("\u0000");
  return `interaction\u0000${encodedColumns}`;
}

export function validateFitModelDefinition(input: {
  response: FieldRef | null;
  terms: readonly FitModelTerm[];
  fields?: readonly FieldRef[];
}): FitModelValidationResult {
  if (!input.response) {
    return { ok: false, reason: "missingResponse" };
  }
  if (input.response.type !== "continuous") {
    return { ok: false, reason: "nonContinuousResponse", columnName: input.response.name };
  }
  if (input.terms.length === 0) {
    return { ok: false, reason: "missingTerms" };
  }

  const fieldsByName = new Map(input.fields?.map((field) => [field.name, field.type]) ?? []);
  const seen = new Set<string>();
  const mainEffects = new Set<string>();
  const interactions: string[][] = [];
  const powers: string[] = [];

  for (const term of input.terms) {
    const rawKind = (term as { kind?: unknown }).kind;
    const rawColumnNames = (term as { columnNames?: unknown }).columnNames;

    if (rawKind !== "main" && rawKind !== "interaction" && rawKind !== "power") {
      return { ok: false, reason: "invalidTermKind", termKind: String(rawKind) };
    }

    if (!Array.isArray(rawColumnNames) || !rawColumnNames.every((entry) => typeof entry === "string")) {
      return { ok: false, reason: "invalidTermArity", termKind: rawKind };
    }

    if (rawKind === "main") {
      if (rawColumnNames.length !== 1) {
        return { ok: false, reason: "invalidTermArity", termKind: rawKind };
      }

      const [columnName] = rawColumnNames;
      if (columnName === input.response.name) {
        return { ok: false, reason: "responseInModel", columnName };
      }

      const fieldType = fieldsByName.get(columnName);
      if (fieldType && fieldType !== "continuous") {
        return { ok: false, reason: "nonContinuousPredictor", columnName };
      }

      const key = fitModelTermIdentityKey({ kind: "main", columnNames: [columnName] });
      if (seen.has(key)) {
        return { ok: false, reason: "duplicateTerm", termKey: termKey({ kind: "main", columnNames: [columnName] }) };
      }
      seen.add(key);
      mainEffects.add(columnName);
      continue;
    }

    if (rawKind === "power") {
      if (rawColumnNames.length !== 1) {
        return { ok: false, reason: "invalidTermArity", termKind: rawKind };
      }

      const [columnName] = rawColumnNames;
      const rawExponent = (term as { exponent?: unknown }).exponent;
      if (rawExponent !== 2) {
        return {
          ok: false,
          reason: "invalidPowerExponent",
          columnName,
          termKind: rawKind,
        };
      }

      if (columnName === input.response.name) {
        return { ok: false, reason: "responseInModel", columnName };
      }

      const fieldType = fieldsByName.get(columnName);
      if (fieldType && fieldType !== "continuous") {
        return { ok: false, reason: "nonContinuousPredictor", columnName };
      }

      const key = fitModelTermIdentityKey({ kind: "power", columnNames: [columnName], exponent: 2 });
      if (seen.has(key)) {
        return {
          ok: false,
          reason: "duplicateTerm",
          termKey: termKey({ kind: "power", columnNames: [columnName], exponent: 2 }),
        };
      }
      seen.add(key);
      powers.push(columnName);
      continue;
    }

    if (rawColumnNames.length < 2) {
      return { ok: false, reason: "invalidTermArity", termKind: rawKind };
    }

    const normalizedColumns = canonicalInteractionColumns(rawColumnNames);
    const uniqueColumns = new Set(normalizedColumns);
    if (uniqueColumns.size !== normalizedColumns.length) {
      return { ok: false, reason: "sameColumnInteraction", columnName: normalizedColumns[0] };
    }

    for (const columnName of normalizedColumns) {
      if (columnName === input.response.name) {
        return { ok: false, reason: "responseInModel", columnName: input.response.name };
      }

      const fieldType = fieldsByName.get(columnName);
      if (fieldType && fieldType !== "continuous") {
        return { ok: false, reason: "nonContinuousPredictor", columnName };
      }
    }

    const key = fitModelTermIdentityKey({ kind: "interaction", columnNames: normalizedColumns });
    if (seen.has(key)) {
      return {
        ok: false,
        reason: "duplicateTerm",
        termKey: termKey({ kind: "interaction", columnNames: normalizedColumns }),
      };
    }
    seen.add(key);
    interactions.push(normalizedColumns);
  }

  for (const columns of interactions) {
    for (const columnName of columns) {
      if (!mainEffects.has(columnName)) {
        return { ok: false, reason: "missingMainEffect", columnName };
      }
    }
  }

  for (const columnName of powers) {
    if (!mainEffects.has(columnName)) {
      return { ok: false, reason: "missingMainEffect", columnName };
    }
  }

  return { ok: true };
}

export function applyFactorialDegree(fields: readonly FieldRef[], degree: 1 | 2): FitModelTerm[] {
  return canonicalizeFitModelTerms(buildFactorialToDegreeTerms(fields, degree));
}

export function fitModelParameterCount(terms: readonly FitModelTerm[]): number {
  return 1 + terms.length;
}

function cloneConstruct(construct: FitModelConstruct): FitModelConstruct {
  if (construct.kind === "factorialToDegree") {
    return { kind: "factorialToDegree", degree: construct.degree };
  }
  return { kind: construct.kind };
}

type CreateFitModelItemInput = Omit<FitModelItem, "construct" | "terms" | "response"> & {
  fields: readonly FieldRef[];
  response: FieldRef;
  terms: readonly FitModelTerm[];
  construct?: FitModelConstruct;
};

export function createFitModelItem(input: CreateFitModelItemInput): FitModelItem {
  const validation = validateFitModelDefinition({
    response: input.response,
    terms: input.terms,
    fields: input.fields,
  });
  if (!validation.ok) {
    throw new FitModelValidationError(validation);
  }

  return {
    id: input.id,
    name: input.name,
    sourceDatasetId: input.sourceDatasetId,
    response: clone(input.response),
    construct: cloneConstruct(input.construct ?? { kind: "manual" }),
    terms: canonicalizeFitModelTerms(input.terms),
    centeringMethod: input.centeringMethod,
    createdAt: input.createdAt,
  };
}