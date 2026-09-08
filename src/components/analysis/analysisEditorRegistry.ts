import type { AnalysisSummaryEntry } from "@/components/analysis/presentation";
import {
  createDistributionAnalysisPatch,
  createFitYByXAnalysisPatch,
  describeDistributionAnalysis,
  describeFitYByXAnalysis,
  toDistributionEditorItem,
  toFitYByXEditorItem,
} from "@/components/analysis/adapters";
import type { FitYByXAnalysisEditorItem } from "@/components/analysis/adapters";
import type { AnalysisDocumentByKind, AnalysisDocumentPatch, AnalysisKind } from "@/types/analysis";
import type { DatasetMeta } from "@/types/data";
import type { DistributionItem } from "@/types/distribution";

type Translate = (key: string, values?: Record<string, unknown>) => string;

export type AnalysisEditorItemByKind = {
  distribution: DistributionItem;
  fitYByX: FitYByXAnalysisEditorItem;
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
  ) => AnalysisDocumentPatch;
}

export const analysisEditorRegistry = {
  distribution: {
    describe: describeDistributionAnalysis,
    toEditor: toDistributionEditorItem,
    createPatch: createDistributionAnalysisPatch,
  },
  fitYByX: {
    describe: describeFitYByXAnalysis,
    toEditor: toFitYByXEditorItem,
    createPatch: createFitYByXAnalysisPatch,
  },
} satisfies { [Kind in AnalysisKind]: AnalysisEditorPolicy<Kind> | null };

export function describeAnalysisDocument(
  document: AnalysisDocumentByKind["fitYByX"],
  dataset: DatasetMeta | null,
  translate: Translate,
): AnalysisSummaryEntry[];
export function describeAnalysisDocument(
  document: AnalysisDocumentByKind["distribution"],
  dataset: DatasetMeta | null,
  translate: Translate,
): AnalysisSummaryEntry[];
export function describeAnalysisDocument(
  document: AnalysisDocumentByKind["distribution"] | AnalysisDocumentByKind["fitYByX"],
  dataset: DatasetMeta | null,
  translate: Translate,
): AnalysisSummaryEntry[] {
  if (document.analysisKind === "distribution") {
    return analysisEditorRegistry.distribution.describe(document, dataset, translate);
  }
  return analysisEditorRegistry.fitYByX.describe(document, dataset, translate);
}

export function toAnalysisEditorItem(
  document: AnalysisDocumentByKind["fitYByX"],
): FitYByXAnalysisEditorItem;
export function toAnalysisEditorItem(
  document: AnalysisDocumentByKind["distribution"],
): DistributionItem;
export function toAnalysisEditorItem(
  document: AnalysisDocumentByKind["distribution"] | AnalysisDocumentByKind["fitYByX"],
): DistributionItem | FitYByXAnalysisEditorItem {
  if (document.analysisKind === "distribution") {
    return analysisEditorRegistry.distribution.toEditor(document);
  }
  return analysisEditorRegistry.fitYByX.toEditor(document);
}

export function createAnalysisEditorPatch(
  document: AnalysisDocumentByKind["fitYByX"],
  submitted: FitYByXAnalysisEditorItem,
  updatedAt: string,
): AnalysisDocumentPatch;
export function createAnalysisEditorPatch(
  document: AnalysisDocumentByKind["distribution"],
  submitted: DistributionItem,
  updatedAt: string,
): AnalysisDocumentPatch;
export function createAnalysisEditorPatch(
  document: AnalysisDocumentByKind["distribution"] | AnalysisDocumentByKind["fitYByX"],
  submitted: DistributionItem | FitYByXAnalysisEditorItem,
  updatedAt: string,
): AnalysisDocumentPatch {
  if (document.analysisKind === "distribution") {
    return analysisEditorRegistry.distribution.createPatch(document, submitted as DistributionItem, updatedAt);
  }
  return analysisEditorRegistry.fitYByX.createPatch(document, submitted as FitYByXAnalysisEditorItem, updatedAt);
}