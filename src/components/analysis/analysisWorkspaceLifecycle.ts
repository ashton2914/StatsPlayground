import type { SaveProjectRequest } from "@/services/projectService";
import type { AnalysisDocument } from "@/types/analysis";
import type { OpenProjectResult } from "@/types/project";

import { migrateLegacyDistributions } from "./distributionAnalysisMigration";

export interface WorkspaceDocumentSelection {
  activeDatasetId: string | null;
  activeGraphBuilderId: string | null;
  activeFitYByXId: string | null;
  activeFitModelId: string | null;
  activeReportId: string | null;
  activeAnalysisId: string | null;
  activeTabulateId: string | null;
}

export type WorkspaceDocumentKind =
  | "dataset"
  | "graph"
  | "fitYByX"
  | "fitModel"
  | "report"
  | "analysis"
  | "tabulate";

export function createEmptyWorkspaceDocumentSelection(): WorkspaceDocumentSelection {
  return {
    activeDatasetId: null,
    activeGraphBuilderId: null,
    activeFitYByXId: null,
    activeFitModelId: null,
    activeReportId: null,
    activeAnalysisId: null,
    activeTabulateId: null,
  };
}

export function selectWorkspaceDocument(kind: WorkspaceDocumentKind, id: string): WorkspaceDocumentSelection {
  const next = createEmptyWorkspaceDocumentSelection();
  if (kind === "dataset") next.activeDatasetId = id;
  if (kind === "graph") next.activeGraphBuilderId = id;
  if (kind === "fitYByX") next.activeFitYByXId = id;
  if (kind === "fitModel") next.activeFitModelId = id;
  if (kind === "report") next.activeReportId = id;
  if (kind === "analysis") next.activeAnalysisId = id;
  if (kind === "tabulate") next.activeTabulateId = id;
  return next;
}

export function buildAnalysisProjectPayload(input: {
  analyses: AnalysisDocument[];
  analysisFolders: Record<string, string>;
}): Pick<SaveProjectRequest, "analyses" | "analysisFolders" | "distributions" | "distributionFolders"> {
  return {
    analyses: input.analyses,
    analysisFolders: input.analysisFolders,
    distributions: [],
    distributionFolders: {},
  };
}

export function hydrateAnalysisProjectPayload(
  result: Partial<Pick<
    OpenProjectResult,
    "analyses" | "analysisFolders" | "distributions" | "distributionFolders"
  >>,
): Pick<OpenProjectResult, "analyses" | "analysisFolders"> & { migratedCount: number } {
  return migrateLegacyDistributions({
    analyses: result.analyses ?? [],
    analysisFolders: result.analysisFolders ?? {},
    distributions: result.distributions ?? [],
    distributionFolders: result.distributionFolders ?? {},
  });
}

export function getRetainedActiveAnalysisIdAfterDatasetDeletion(input: {
  deletedDatasetId: string;
  activeAnalysis: Pick<AnalysisDocument, "id" | "source"> | null;
}): string | null {
  if (input.activeAnalysis?.source.datasetId !== input.deletedDatasetId) {
    return null;
  }
  return input.activeAnalysis.id;
}

export function shouldMarkAnalysisMigrationDirty(migratedCount: number): boolean {
  return migratedCount > 0;
}

export function getAnalysisCreationHistoryKey(origin: "sample" | "generic"): "history.analysisSample" | "history.newAnalysis" {
  return origin === "sample" ? "history.analysisSample" : "history.newAnalysis";
}