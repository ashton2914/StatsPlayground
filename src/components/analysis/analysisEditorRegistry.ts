import type { AnalysisSummaryEntry } from "@/components/analysis/presentation";
import {
  createDistributionAnalysisPatch,
  createFitModelAnalysisPatch,
  createFitYByXAnalysisPatch,
  describeDistributionAnalysis,
  describeFitModelAnalysis,
  describeFitYByXAnalysis,
  toFitModelEditorItem,
  toDistributionEditorItem,
  toFitYByXEditorItem,
} from "@/components/analysis/adapters";
import type { FitModelAnalysisEditorItem, FitYByXAnalysisEditorItem } from "@/components/analysis/adapters";
import type { AnalysisDocumentByKind, AnalysisDocumentPatch, AnalysisKind } from "@/types/analysis";
import type { DatasetMeta } from "@/types/data";
import type { DistributionItem } from "@/types/distribution";

type Translate = (key: string, values?: Record<string, unknown>) => string;

export type AnalysisEditorItemByKind = {
  distribution: DistributionItem;
  fitYByX: FitYByXAnalysisEditorItem;
  fitModel: FitModelAnalysisEditorItem;
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
  fitModel: {
    describe: describeFitModelAnalysis,
    toEditor: toFitModelEditorItem,
    createPatch: createFitModelAnalysisPatch,
  },
} satisfies { [Kind in AnalysisKind]: AnalysisEditorPolicy<Kind> | null };

export function describeAnalysisDocument(
  document: AnalysisDocumentByKind["fitYByX"],
  dataset: DatasetMeta | null,
  translate: Translate,
): AnalysisSummaryEntry[];
export function describeAnalysisDocument(
  document: AnalysisDocumentByKind["fitModel"],
  dataset: DatasetMeta | null,
  translate: Translate,
): AnalysisSummaryEntry[];
export function describeAnalysisDocument(
  document: AnalysisDocumentByKind["distribution"],
  dataset: DatasetMeta | null,
  translate: Translate,
): AnalysisSummaryEntry[];
export function describeAnalysisDocument(
  document: AnalysisDocumentByKind[AnalysisKind],
  dataset: DatasetMeta | null,
  translate: Translate,
): AnalysisSummaryEntry[] {
  if (document.analysisKind === "distribution") {
    return analysisEditorRegistry.distribution.describe(document, dataset, translate);
  }
  if (document.analysisKind === "fitYByX") {
    return analysisEditorRegistry.fitYByX.describe(document, dataset, translate);
  }
  return analysisEditorRegistry.fitModel.describe(document, dataset, translate);
}

export function toAnalysisEditorItem(
  document: AnalysisDocumentByKind["fitYByX"],
): FitYByXAnalysisEditorItem;
export function toAnalysisEditorItem(
  document: AnalysisDocumentByKind["fitModel"],
): FitModelAnalysisEditorItem;
export function toAnalysisEditorItem(
  document: AnalysisDocumentByKind["distribution"],
): DistributionItem;
export function toAnalysisEditorItem(
  document: AnalysisDocumentByKind[AnalysisKind],
): AnalysisEditorItemByKind[AnalysisKind] {
  if (document.analysisKind === "distribution") {
    return analysisEditorRegistry.distribution.toEditor(document);
  }
  if (document.analysisKind === "fitYByX") {
    return analysisEditorRegistry.fitYByX.toEditor(document);
  }
  return analysisEditorRegistry.fitModel.toEditor(document);
}

export function createAnalysisEditorPatch(
  document: AnalysisDocumentByKind["fitYByX"],
  submitted: FitYByXAnalysisEditorItem,
  updatedAt: string,
): AnalysisDocumentPatch;
export function createAnalysisEditorPatch(
  document: AnalysisDocumentByKind["fitModel"],
  submitted: FitModelAnalysisEditorItem,
  updatedAt: string,
): AnalysisDocumentPatch;
export function createAnalysisEditorPatch(
  document: AnalysisDocumentByKind["distribution"],
  submitted: DistributionItem,
  updatedAt: string,
): AnalysisDocumentPatch;
export function createAnalysisEditorPatch(
  document: AnalysisDocumentByKind[AnalysisKind],
  submitted: AnalysisEditorItemByKind[AnalysisKind],
  updatedAt: string,
): AnalysisDocumentPatch {
  if (document.analysisKind === "distribution") {
    return analysisEditorRegistry.distribution.createPatch(document, submitted as DistributionItem, updatedAt);
  }
  if (document.analysisKind === "fitYByX") {
    return analysisEditorRegistry.fitYByX.createPatch(document, submitted as FitYByXAnalysisEditorItem, updatedAt);
  }
  return analysisEditorRegistry.fitModel.createPatch(document, submitted as FitModelAnalysisEditorItem, updatedAt);
}