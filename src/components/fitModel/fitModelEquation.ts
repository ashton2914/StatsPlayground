import type {
  FitModelCenter,
  FitModelFittedResult,
  FitModelResolvedTerm,
} from "@/types/fitModel";

export interface FitModelEquationPart {
  coefficient: number;
  featureLabel: string | null;
}

export interface NumericFitModelEquation {
  response: string;
  parts: FitModelEquationPart[];
}

function formatFiniteNumber(value: number): string | null {
  if (!Number.isFinite(value)) return null;
  return Number.parseFloat(value.toPrecision(12)).toString();
}

function centeredFeature(
  columnName: string,
  centerByColumn: ReadonlyMap<string, FitModelCenter>,
  centered: boolean,
): string | null {
  if (!centered) return columnName;
  const center = centerByColumn.get(columnName);
  if (!center) return null;
  const formatted = formatFiniteNumber(Math.abs(center.mean));
  if (formatted === null) return null;
  const operator = center.mean < 0 ? "+" : "-";
  return `(${columnName} ${operator} ${formatted})`;
}

function featureLabel(
  term: FitModelResolvedTerm,
  centerByColumn: ReadonlyMap<string, FitModelCenter>,
  centered: boolean,
): string | null {
  if (term.kind === "main") {
    return term.columnNames.length === 1 ? term.columnNames[0] : null;
  }

  if (term.kind === "interaction") {
    if (term.columnNames.length < 2) return null;
    const factors = term.columnNames.map((column) => (
      centeredFeature(column, centerByColumn, centered)
    ));
    return factors.every((factor): factor is string => factor !== null)
      ? factors.join(" * ")
      : null;
  }

  if (term.columnNames.length !== 1) return null;
  const base = centeredFeature(term.columnNames[0], centerByColumn, centered);
  return base === null ? null : `${base}^2`;
}

export function buildNumericFitModelEquation(
  result: FitModelFittedResult,
): NumericFitModelEquation | null {
  const response = result.responseColumn.trim();
  if (response.length === 0) return null;

  const parameterByTermId = new Map(
    result.parameterEstimates.map((parameter) => [parameter.termId, parameter]),
  );
  const intercept = parameterByTermId.get("Intercept");
  if (!intercept || !Number.isFinite(intercept.estimate)) return null;

  const centerByColumn = new Map(
    result.centering.centers.map((center) => [center.columnName, center]),
  );
  const parts: FitModelEquationPart[] = [
    { coefficient: intercept.estimate, featureLabel: null },
  ];

  for (const term of result.terms) {
    const parameter = parameterByTermId.get(term.termId);
    if (!parameter || !Number.isFinite(parameter.estimate)) return null;
    const label = featureLabel(term, centerByColumn, result.centering.method === "mean");
    if (label === null) return null;
    parts.push({ coefficient: parameter.estimate, featureLabel: label });
  }

  return { response, parts };
}
