import type { AnalysisSummaryEntry } from "@/components/analysis/presentation";
import {
  createDistributionAnalysisPatch,
  describeDistributionAnalysis,
  toDistributionEditorItem,
} from "@/components/analysis/adapters";
import type { AnalysisDocumentByKind, AnalysisKind } from "@/types/analysis";
import type { DatasetMeta } from "@/types/data";
import type { DistributionItem } from "@/types/distribution";

type Translate = (key: string, values?: Record<string, unknown>) => string;

export type AnalysisEditorItemByKind = {
  distribution: DistributionItem;
};

interface AnalysisEditorPolicy<Kind extends AnalysisKind> {
  describe: (
    document: AnalysisDocumentByKind[Kind],
    dataset: DatasetMeta | null,
    translate: Translate,
  ) => AnalysisSummaryEntry[];
  toEditor: (document: AnalysisDocumentByKind[Kind]) => AnalysisEditorItemByKind[Kind];
  createPatch: (
    document: AnalysisDocumentByKind[Kind],
    submitted: AnalysisEditorItemByKind[Kind],
    updatedAt: string,
  ) => ReturnType<typeof createDistributionAnalysisPatch>;
}

export const analysisEditorRegistry = {
  distribution: {
    describe: describeDistributionAnalysis,
    toEditor: toDistributionEditorItem,
    createPatch: createDistributionAnalysisPatch,
  },
} satisfies { [Kind in AnalysisKind]: AnalysisEditorPolicy<Kind> };

export function describeAnalysisDocument(
  document: AnalysisDocumentByKind["distribution"],
  dataset: DatasetMeta | null,
  translate: Translate,
): AnalysisSummaryEntry[] {
  return analysisEditorRegistry[document.analysisKind].describe(document, dataset, translate);
}

export function toAnalysisEditorItem(
  document: AnalysisDocumentByKind["distribution"],
): DistributionItem {
  return analysisEditorRegistry[document.analysisKind].toEditor(document);
}

export function createAnalysisEditorPatch(
  document: AnalysisDocumentByKind["distribution"],
  submitted: DistributionItem,
  updatedAt: string,
) {
  return analysisEditorRegistry[document.analysisKind].createPatch(document, submitted, updatedAt);
}