import type { AnalysisDocument, AnalysisDocumentByKind, AnalysisKind } from "@/types/analysis";

export interface AnalysisReportPolicy<Kind extends AnalysisKind> {
  dependencyKind: "distribution" | "fitYByX" | "hypothesisTest";
  accepts: (document: AnalysisDocument) => document is AnalysisDocumentByKind[Kind];
}

export function isDistributionAnalysisDocument(
  document: AnalysisDocument,
): document is AnalysisDocumentByKind["distribution"] {
  return document.analysisKind === "distribution";
}

export function isFitYByXAnalysisDocument(
  document: AnalysisDocument,
): document is AnalysisDocumentByKind["fitYByX"] {
  return document.analysisKind === "fitYByX";
}

export function isHypothesisTestAnalysisDocument(
  document: AnalysisDocument,
): document is AnalysisDocumentByKind["hypothesisTest"] {
  return document.analysisKind === "hypothesisTest";
}

export const analysisReportPolicies = {
  distribution: {
    dependencyKind: "distribution",
    accepts: isDistributionAnalysisDocument,
  },
  fitYByX: {
    dependencyKind: "fitYByX",
    accepts: isFitYByXAnalysisDocument,
  },
  fitModel: null,
  hypothesisTest: {
    dependencyKind: "hypothesisTest",
    accepts: isHypothesisTestAnalysisDocument,
  },
} satisfies { [Kind in AnalysisKind]: AnalysisReportPolicy<Kind> | null };