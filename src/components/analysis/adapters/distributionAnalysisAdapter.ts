import type { AnalysisSummaryEntry } from "../presentation";
import type { AnalysisDocument, AnalysisDocumentPatch, DistributionAnalysisDefinition } from "../../../types/analysis";
import type { DatasetMeta } from "../../../types/data";
import type { DistributionItem, SpecLimitsOverride } from "../../../types/distribution";

type Translate = (key: string, values?: Record<string, unknown>) => string;

function formatLimit(value: number | null): string {
  return value === null ? "—" : value.toLocaleString(undefined, { maximumSignificantDigits: 8 });
}

function formatSpecificationLimits(document: AnalysisDocument): string {
  const entries = document.definition.responses
    .map((response) => [response.name, document.definition.analysis.specLimits[response.name]] as const)
    .filter((entry): entry is readonly [string, SpecLimitsOverride] => entry[1] !== undefined);
  if (entries.length === 0) return "—";
  return entries.map(([name, limits]) => {
    const values = [limits.lsl, limits.target, limits.usl].map(formatLimit).join(" / ");
    return entries.length === 1 ? values : `${name}: ${values}`;
  }).join("; ");
}

export function describeDistributionAnalysis(
  document: AnalysisDocument,
  dataset: DatasetMeta | null,
  translate: Translate,
): AnalysisSummaryEntry[] {
  return [
    {
      key: "analysis",
      label: translate("workspace.analysis", { defaultValue: "Analysis" }),
      value: translate("distribution.title", { defaultValue: "Distribution" }),
    },
    {
      key: "response",
      label: translate("distribution.response", { defaultValue: "Response" }),
      value: document.definition.responses.map((response) => response.name).join(", ") || "—",
    },
    {
      key: "fit",
      label: translate("workspace.analysisSummary.fit", { defaultValue: "Fit" }),
      value: document.definition.analysis.fitDistributions.join(", ") || "—",
    },
    {
      key: "specificationLimits",
      label: translate("workspace.analysisSummary.specificationLimits", { defaultValue: "LSL / Target / USL" }),
      value: formatSpecificationLimits(document),
    },
    {
      key: "confidenceLevel",
      label: translate("distribution.confidenceLevel", { defaultValue: "Confidence level" }),
      value: new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 2 })
        .format(document.definition.analysis.confidenceLevel),
    },
    {
      key: "rows",
      label: translate("workspace.analysisSummary.rows", { defaultValue: "Rows" }),
      value: dataset?.rowCount.toLocaleString() ?? "—",
    },
  ];
}

export function toDistributionEditorItem(document: AnalysisDocument): DistributionItem {
  return {
    id: document.id,
    name: document.name,
    sourceDatasetId: document.source.datasetId,
    responses: structuredClone(document.definition.responses),
    weight: structuredClone(document.definition.weight),
    frequency: structuredClone(document.definition.frequency),
    by: structuredClone(document.definition.by),
    analysis: structuredClone(document.definition.analysis),
    graphs: structuredClone(document.definition.graphs),
    createdAt: document.createdAt,
  };
}

export function createDistributionAnalysisPatch(
  document: AnalysisDocument,
  submitted: DistributionItem,
  updatedAt: string,
): AnalysisDocumentPatch {
  const definition: DistributionAnalysisDefinition = {
    kind: "distribution",
    responses: structuredClone(submitted.responses),
    weight: structuredClone(submitted.weight),
    frequency: structuredClone(submitted.frequency),
    by: structuredClone(submitted.by),
    analysis: structuredClone(submitted.analysis),
    graphs: structuredClone(submitted.graphs),
  };
  return {
    definition,
    source: structuredClone(document.source),
    configRevision: document.configRevision + 1,
    updatedAt,
  };
}