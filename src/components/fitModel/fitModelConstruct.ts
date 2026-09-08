import type { FieldRef } from "@/graphCore";
import type { FitModelTerm } from "@/types/fitModel";

export const MAX_FIT_MODEL_TERMS = 256;

export class FitModelTermLimitError extends Error {
  readonly code = "tooManyTerms" as const;

  constructor(count: number) {
    super(`Fit Model exceeds ${MAX_FIT_MODEL_TERMS} terms (${count}).`);
    this.name = "FitModelTermLimitError";
  }
}

function nChooseK(n: number, k: number): number {
  if (k < 0 || k > n) {
    return 0;
  }
  if (k === 0 || k === n) {
    return 1;
  }

  const reducedK = Math.min(k, n - k);
  let result = 1;
  for (let i = 1; i <= reducedK; i += 1) {
    result = (result * (n - reducedK + i)) / i;
  }
  return Math.round(result);
}

function assertWithinTermLimit(count: number): void {
  if (count > MAX_FIT_MODEL_TERMS) {
    throw new FitModelTermLimitError(count);
  }
}

function normalizePredictorNames(fields: readonly FieldRef[]): string[] {
  const seen = new Set<string>();
  const names: string[] = [];

  for (const field of fields) {
    if (field.type !== "continuous") {
      continue;
    }
    if (seen.has(field.name)) {
      continue;
    }
    seen.add(field.name);
    names.push(field.name);
  }

  return names;
}

function buildCombinations(
  names: readonly string[],
  degree: number,
  startIndex: number,
  stack: string[],
  onCombination: (columns: string[]) => void,
): void {
  if (stack.length === degree) {
    onCombination([...stack]);
    return;
  }

  for (let index = startIndex; index < names.length; index += 1) {
    stack.push(names[index]);
    buildCombinations(names, degree, index + 1, stack, onCombination);
    stack.pop();
  }
}

export function countFactorialTerms(factorCount: number, degree: number): number {
  if (!Number.isInteger(factorCount) || !Number.isInteger(degree) || factorCount < 0 || degree < 0) {
    throw new RangeError("factorCount and degree must be non-negative integers");
  }

  const upperDegree = Math.min(factorCount, degree);
  let count = 0;
  for (let currentDegree = 1; currentDegree <= upperDegree; currentDegree += 1) {
    count += nChooseK(factorCount, currentDegree);
  }
  return count;
}

export function buildFactorialToDegreeTerms(
  fields: readonly FieldRef[],
  degree: number,
): FitModelTerm[] {
  if (!Number.isInteger(degree) || degree < 1) {
    throw new RangeError("degree must be a positive integer");
  }

  const predictorNames = normalizePredictorNames(fields);
  const upperDegree = Math.min(degree, predictorNames.length);
  const count = countFactorialTerms(predictorNames.length, upperDegree);
  assertWithinTermLimit(count);

  const terms: FitModelTerm[] = [];
  for (let currentDegree = 1; currentDegree <= upperDegree; currentDegree += 1) {
    buildCombinations(predictorNames, currentDegree, 0, [], (columns) => {
      if (columns.length === 1) {
        terms.push({ kind: "main", columnNames: [columns[0]] });
        return;
      }
      terms.push({
        kind: "interaction",
        columnNames: columns as [string, string, ...string[]],
      });
    });
  }
  return terms;
}

export function buildFullFactorialTerms(fields: readonly FieldRef[]): FitModelTerm[] {
  const predictorNames = normalizePredictorNames(fields);
  const count = countFactorialTerms(predictorNames.length, predictorNames.length);
  assertWithinTermLimit(count);
  return buildFactorialToDegreeTerms(fields, predictorNames.length);
}

export function buildResponseSurfaceTerms(fields: readonly FieldRef[]): FitModelTerm[] {
  const predictorNames = normalizePredictorNames(fields);
  const mains = predictorNames.length;
  const interactions = nChooseK(predictorNames.length, 2);
  const powers = predictorNames.length;
  assertWithinTermLimit(mains + interactions + powers);

  const terms = buildFactorialToDegreeTerms(fields, 2);
  for (const columnName of predictorNames) {
    terms.push({ kind: "power", columnNames: [columnName], exponent: 2 });
  }
  return terms;
}