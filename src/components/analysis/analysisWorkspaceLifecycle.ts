import type { SaveProjectRequest } from "@/services/projectService";
import type { AnalysisDocument } from "@/types/analysis";
import type { OpenProjectResult } from "@/types/project";

export interface WorkspaceDocumentSelection {
  activeDatasetId: string | null;
  activeGraphBuilderId: string | null;
  activeFitYByXId: string | null;
  activeReportId: string | null;
  activeAnalysisId: string | null;
  activeDistributionId: string | null;
  activeTabulateId: string | null;
}

export type WorkspaceDocumentKind =
  | "dataset"
  | "graph"
  | "fitYByX"
  | "report"
  | "analysis"
  | "distribution"
  | "tabulate";

export function createEmptyWorkspaceDocumentSelection(): WorkspaceDocumentSelection {
  return {
    activeDatasetId: null,
    activeGraphBuilderId: null,
    activeFitYByXId: null,
    activeReportId: null,
    activeAnalysisId: null,
    activeDistributionId: null,
    activeTabulateId: null,
  };
}

export function selectWorkspaceDocument(kind: WorkspaceDocumentKind, id: string): WorkspaceDocumentSelection {
  const next = createEmptyWorkspaceDocumentSelection();
  if (kind === "dataset") next.activeDatasetId = id;
  if (kind === "graph") next.activeGraphBuilderId = id;
  if (kind === "fitYByX") next.activeFitYByXId = id;
  if (kind === "report") next.activeReportId = id;
  if (kind === "analysis") next.activeAnalysisId = id;
  if (kind === "distribution") next.activeDistributionId = id;
  if (kind === "tabulate") next.activeTabulateId = id;
  return next;
}

export function buildAnalysisProjectPayload(input: {
  analyses: AnalysisDocument[];
  analysisFolders: Record<string, string>;
}): Pick<SaveProjectRequest, "analyses" | "analysisFolders"> {
  return {
    analyses: input.analyses,
    analysisFolders: input.analysisFolders,
  };
}

export function hydrateAnalysisProjectPayload(
  result: Partial<Pick<OpenProjectResult, "analyses" | "analysisFolders">>,
): Pick<OpenProjectResult, "analyses" | "analysisFolders"> {
  return {
    analyses: result.analyses ?? [],
    analysisFolders: result.analysisFolders ?? {},
  };
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

export function getAnalysisCreationHistoryKey(origin: "sample" | "generic"): "history.analysisSample" | "history.newAnalysis" {
  return origin === "sample" ? "history.analysisSample" : "history.newAnalysis";
}