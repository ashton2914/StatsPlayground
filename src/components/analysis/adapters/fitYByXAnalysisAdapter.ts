import type { AnalysisSummaryEntry } from "../presentation";
import { deriveFitYByXPersonality, validateFitYByXRoles } from "../../fitYByX/fitYByXConfig";
import type {
  AnalysisDocumentPatch,
  FitYByXAnalysisDefinition,
  FitYByXAnalysisDocument,
} from "../../../types/analysis";
import type { DatasetMeta } from "../../../types/data";
import type { FitYByXItem } from "../../../types/fitYByX";

type Translate = (key: string, values?: Record<string, unknown>) => string;

export interface FitYByXAnalysisEditorItem extends FitYByXItem {
  confidenceLevel: number;
}

export function createFitYByXAnalysisDocument(input: {
  item: FitYByXItem;
  confidenceLevel: number;
  updatedAt: string;
}): FitYByXAnalysisDocument {
  const { item, confidenceLevel, updatedAt } = input;
  return {
    schemaVersion: 1,
    documentType: "analysis",
    id: item.id,
    name: item.name,
    analysisKind: "fitYByX",
    configRevision: 1,
    source: { datasetId: item.sourceDatasetId },
    definition: {
      kind: "fitYByX",
      response: structuredClone(item.response),
      factor: structuredClone(item.factor),
      personality: item.personality,
      confidenceLevel,
    },
    presentation: {
      schemaVersion: 1,
      layout: "fit-y-by-x-v1",
      graph: structuredClone(item.graph),
    },
    createdAt: item.createdAt,
    updatedAt,
  };
}

export function describeFitYByXAnalysis(
  document: FitYByXAnalysisDocument,
  dataset: DatasetMeta | null,
  translate: Translate,
): AnalysisSummaryEntry[] {
  return [
    {
      key: "analysis",
      label: translate("workspace.analysis", { defaultValue: "Analysis" }),
      value: translate("fitYByX.title", { defaultValue: "Fit Y by X" }),
    },
    { key: "response", label: translate("fitYByX.response"), value: document.definition.response.name },
    { key: "factor", label: translate("fitYByX.factor"), value: document.definition.factor.name },
    {
      key: "personality",
      label: translate("fitYByX.personalityLabel"),
      value: translate(`fitYByX.personality.${document.definition.personality}`),
    },
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

export function toFitYByXEditorItem(
  document: FitYByXAnalysisDocument,
): FitYByXAnalysisEditorItem {
  return {
    id: document.id,
    name: document.name,
    sourceDatasetId: document.source.datasetId,
    response: structuredClone(document.definition.response),
    factor: structuredClone(document.definition.factor),
    personality: document.definition.personality,
    confidenceLevel: document.definition.confidenceLevel,
    graph: structuredClone(document.presentation.graph),
    createdAt: document.createdAt,
  };
}

export function createFitYByXAnalysisPatch(
  document: FitYByXAnalysisDocument,
  submitted: FitYByXAnalysisEditorItem,
  updatedAt: string,
): AnalysisDocumentPatch {
  const roles = validateFitYByXRoles(submitted);
  if (!roles.ok) {
    throw new Error(`Invalid Fit Y by X roles: ${roles.error}`);
  }
  if (!Number.isFinite(submitted.confidenceLevel)
    || submitted.confidenceLevel <= 0
    || submitted.confidenceLevel >= 1) {
    throw new Error("Fit Y by X confidence level must be strictly between 0 and 1");
  }

  const definition: FitYByXAnalysisDefinition = {
    kind: "fitYByX",
    response: structuredClone(submitted.response),
    factor: structuredClone(submitted.factor),
    personality: deriveFitYByXPersonality(submitted.factor),
    confidenceLevel: submitted.confidenceLevel,
  };
  return {
    definition,
    source: structuredClone(document.source),
    configRevision: document.configRevision + 1,
    updatedAt,
  };
}