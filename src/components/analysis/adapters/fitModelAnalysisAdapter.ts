import {
  canonicalizeFitModelTerms,
  fitModelTermIdentityKey,
  validateFitModelDefinition,
} from "@/components/fitModel/fitModelConfig";
import type { FieldRef } from "@/graphCore";
import type { FitModelAnalysisDocument } from "@/types/analysis";
import type { AnalysisDocumentPatch, FitModelAnalysisDefinition } from "@/types/analysis";
import type { DatasetMeta } from "@/types/data";
import type {
  FitModelCenteringMethod,
  FitModelConstruct,
  FitModelItem,
  FitModelTerm,
} from "@/types/fitModel";

export interface LegacyFitModelAnalysisNormalization {
  document: FitModelAnalysisDocument | null;
  warnings: string[];
}

export interface FitModelAnalysisEditorItem extends FitModelItem {
  confidenceLevel: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function cloneConstruct(construct: FitModelConstruct): FitModelConstruct {
  return construct.kind === "factorialToDegree"
    ? { kind: "factorialToDegree", degree: construct.degree }
    : { kind: construct.kind };
}

function cloneTerms(terms: readonly FitModelTerm[]): FitModelTerm[] {
  return canonicalizeFitModelTerms(terms);
}

function parseField(value: unknown): FieldRef | null {
  if (!isObject(value) || typeof value.name !== "string") return null;
  if (value.type !== "continuous" && value.type !== "ordinal" && value.type !== "nominal") return null;
  return { name: value.name, type: value.type };
}

function parseConstruct(value: unknown): { value: FitModelConstruct; invalid: boolean } {
  if (value === undefined) return { value: { kind: "manual" }, invalid: false };
  if (!isObject(value)) return { value: { kind: "manual" }, invalid: true };
  if (value.kind === "manual" || value.kind === "fullFactorial" || value.kind === "responseSurface") {
    return { value: { kind: value.kind }, invalid: false };
  }
  if (
    value.kind === "factorialToDegree"
    && typeof value.degree === "number"
    && Number.isInteger(value.degree)
    && value.degree >= 1
  ) {
    return { value: { kind: "factorialToDegree", degree: value.degree }, invalid: false };
  }
  return { value: { kind: "manual" }, invalid: true };
}

function parseTerm(value: unknown): FitModelTerm | null {
  if (!isObject(value) || !Array.isArray(value.columnNames)) return null;
  if (!value.columnNames.every((column) => typeof column === "string")) return null;
  const columns = value.columnNames as string[];
  if (value.kind === "main" && columns.length === 1) {
    return { kind: "main", columnNames: [columns[0]] };
  }
  if (value.kind === "power" && columns.length === 1 && value.exponent === 2) {
    return { kind: "power", columnNames: [columns[0]], exponent: 2 };
  }
  if (value.kind === "interaction" && columns.length >= 2 && new Set(columns).size === columns.length) {
    return { kind: "interaction", columnNames: [...columns] as [string, string, ...string[]] };
  }
  return null;
}

function validationDetail(result: Exclude<ReturnType<typeof validateFitModelDefinition>, { ok: true }>): string {
  return [
    result.reason,
    result.columnName ? `column:${result.columnName}` : null,
    result.termKey ? `term:${result.termKey}` : null,
    result.termKind ? `kind:${result.termKind}` : null,
  ].filter(Boolean).join(";");
}

export function createFitModelAnalysisDocument(input: {
  item: FitModelItem;
  confidenceLevel: number;
  updatedAt: string;
}): FitModelAnalysisDocument {
  const { item, confidenceLevel, updatedAt } = input;
  return {
    schemaVersion: 1,
    documentType: "analysis",
    id: item.id,
    name: item.name,
    analysisKind: "fitModel",
    configRevision: 1,
    source: { datasetId: item.sourceDatasetId },
    definition: {
      kind: "fitModel",
      response: { ...item.response },
      construct: cloneConstruct(item.construct),
      terms: cloneTerms(item.terms),
      centeringMethod: item.centeringMethod,
      confidenceLevel,
      ...(item.loadIssue ? { migrationIssue: { ...item.loadIssue } } : {}),
    },
    presentation: { schemaVersion: 1, layout: "fit-model-v1" },
    createdAt: item.createdAt,
    updatedAt,
  };
}

export function normalizeLegacyFitModelAnalysis(
  value: unknown,
  updatedAt: string,
): LegacyFitModelAnalysisNormalization {
  if (!isObject(value)) return { document: null, warnings: [] };
  const { id, name, sourceDatasetId, createdAt } = value;
  if (
    typeof id !== "string"
    || typeof name !== "string"
    || typeof sourceDatasetId !== "string"
    || typeof createdAt !== "string"
  ) {
    return { document: null, warnings: [] };
  }

  const issueDetails: string[] = [];
  const response = parseField(value.response) ?? { name: "", type: "continuous" as const };
  if (!parseField(value.response)) issueDetails.push("invalidResponseShape");
  const construct = parseConstruct(value.construct);
  if (construct.invalid) issueDetails.push("invalidConstruct");
  const centeringMethod: FitModelCenteringMethod = value.centeringMethod === "mean" ? "mean" : "none";
  if (value.centeringMethod !== "none" && value.centeringMethod !== "mean") issueDetails.push("invalidCenteringMethod");

  const parsedTerms: FitModelTerm[] = [];
  if (Array.isArray(value.terms)) {
    value.terms.forEach((term, index) => {
      const parsed = parseTerm(term);
      if (parsed) parsedTerms.push(parsed);
      else issueDetails.push(`invalidTerm:${index}`);
    });
  } else {
    issueDetails.push("invalidTermsShape");
  }

  const warnings: string[] = [];
  const terms: FitModelTerm[] = [];
  const seen = new Set<string>();
  for (const term of canonicalizeFitModelTerms(parsedTerms)) {
    const key = fitModelTermIdentityKey(term);
    if (seen.has(key)) {
      warnings.push(`Dropped duplicate Fit Model term ${key} while loading ${id}.`);
    } else {
      seen.add(key);
      terms.push(term);
    }
  }

  const validation = validateFitModelDefinition({ response, terms });
  if (!validation.ok) issueDetails.push(validationDetail(validation));
  const existingIssue = isObject(value.loadIssue)
    && typeof value.loadIssue.code === "string"
    && typeof value.loadIssue.detail === "string"
    ? { code: value.loadIssue.code, detail: value.loadIssue.detail }
    : null;
  const loadIssue = issueDetails.length > 0
    ? { code: "invalidPersistedDefinition", detail: issueDetails.join(";") }
    : existingIssue;

  return {
    document: createFitModelAnalysisDocument({
      item: {
        id,
        name,
        sourceDatasetId,
        response,
        construct: construct.value,
        terms,
        centeringMethod,
        createdAt,
        ...(loadIssue ? { loadIssue } : {}),
      },
      confidenceLevel: 0.95,
      updatedAt,
    }),
    warnings,
  };
}

export function isFitModelAnalysisDocument(value: { analysisKind?: string }): value is FitModelAnalysisDocument {
  return value.analysisKind === "fitModel";
}

export function describeFitModelAnalysis(
  document: FitModelAnalysisDocument,
  dataset: DatasetMeta | null,
  translate: (key: string, values?: Record<string, unknown>) => string,
) {
  return [
    {
      key: "analysis",
      label: translate("workspace.analysis", { defaultValue: "Analysis" }),
      value: translate("fitModel.title", { defaultValue: "Fit Model" }),
    },
    { key: "response", label: translate("fitModel.response"), value: document.definition.response.name },
    { key: "terms", label: translate("fitModel.modelEffects"), value: document.definition.terms.length.toLocaleString() },
    {
      key: "confidenceLevel",
      label: translate("distribution.confidenceLevel", { defaultValue: "Confidence level" }),
      value: new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 2 })
        .format(document.definition.confidenceLevel),
    },
    {
      key: "rows",
      label: translate("workspace.analysisSummary.rows", { defaultValue: "Rows" }),
      value: dataset?.rowCount.toLocaleString() ?? "—",
    },
  ];
}

export function toFitModelEditorItem(document: FitModelAnalysisDocument): FitModelAnalysisEditorItem {
  return {
    id: document.id,
    name: document.name,
    sourceDatasetId: document.source.datasetId,
    response: { ...document.definition.response },
    construct: cloneConstruct(document.definition.construct),
    terms: cloneTerms(document.definition.terms),
    centeringMethod: document.definition.centeringMethod,
    confidenceLevel: document.definition.confidenceLevel,
    createdAt: document.createdAt,
    ...(document.definition.migrationIssue
      ? { loadIssue: { ...document.definition.migrationIssue } }
      : {}),
  };
}

export function createFitModelAnalysisPatch(
  document: FitModelAnalysisDocument,
  submitted: FitModelAnalysisEditorItem,
  updatedAt: string,
): AnalysisDocumentPatch {
  const validation = validateFitModelDefinition({
    response: submitted.response,
    terms: submitted.terms,
  });
  if (!validation.ok) throw new Error(`Invalid Fit Model definition: ${validationDetail(validation)}`);
  if (!Number.isFinite(submitted.confidenceLevel)
    || submitted.confidenceLevel <= 0
    || submitted.confidenceLevel >= 1) {
    throw new Error("Fit Model confidence level must be strictly between 0 and 1");
  }
  const definition: FitModelAnalysisDefinition = {
    kind: "fitModel",
    response: { ...submitted.response },
    construct: cloneConstruct(submitted.construct),
    terms: cloneTerms(submitted.terms),
    centeringMethod: submitted.centeringMethod,
    confidenceLevel: submitted.confidenceLevel,
  };
  return {
    definition,
    source: { ...document.source },
    configRevision: document.configRevision + 1,
    updatedAt,
  };
}