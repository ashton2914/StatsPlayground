import type { SaveProjectRequest } from "@/services/projectService";
import type { AnalysisDocument } from "@/types/analysis";
import type { FitYByXItem } from "@/types/fitYByX";
import type { EmbeddedGraphConfig } from "@/types/graphBuilder";
import type { OpenProjectResult } from "@/types/project";

import {
  createAnalysisGraphPersistencePatch,
  type AnalysisGraphPersistenceResult,
} from "./analysisGraphPolicies";
import { migrateLegacyDistributions } from "./distributionAnalysisMigration";
import { migrateLegacyFitYByX } from "./fitYByXAnalysisMigration";
import { migrateLegacyFitModels } from "./fitModelProjectMigration";

export interface WorkspaceDocumentSelection {
  activeDatasetId: string | null;
  activeTableTransformId: string | null;
  activeGraphBuilderId: string | null;
  activeReportId: string | null;
  activeAnalysisId: string | null;
  activeTabulateId: string | null;
}

export type WorkspaceDocumentKind =
  | "dataset"
  | "tableTransform"
  | "graph"
  | "report"
  | "analysis"
  | "tabulate";

export function createEmptyWorkspaceDocumentSelection(): WorkspaceDocumentSelection {
  return {
    activeDatasetId: null,
    activeTableTransformId: null,
    activeGraphBuilderId: null,
    activeReportId: null,
    activeAnalysisId: null,
    activeTabulateId: null,
  };
}

export function selectWorkspaceDocument(kind: WorkspaceDocumentKind, id: string): WorkspaceDocumentSelection {
  const next = createEmptyWorkspaceDocumentSelection();
  if (kind === "dataset") next.activeDatasetId = id;
  if (kind === "tableTransform") next.activeTableTransformId = id;
  if (kind === "graph") next.activeGraphBuilderId = id;
  if (kind === "report") next.activeReportId = id;
  if (kind === "analysis") next.activeAnalysisId = id;
  if (kind === "tabulate") next.activeTabulateId = id;
  return next;
}

export function buildAnalysisProjectPayload(input: {
  analyses: AnalysisDocument[];
  analysisFolders: Record<string, string>;
}): Pick<
  SaveProjectRequest,
  "analyses" | "analysisFolders" | "distributions" | "distributionFolders" | "fitYByX" | "fitYByXFolders"
> {
  return {
    analyses: input.analyses,
    analysisFolders: input.analysisFolders,
    distributions: [],
    distributionFolders: {},
    fitYByX: [],
    fitYByXFolders: {},
  };
}

export function hydrateAnalysisProjectPayload(
  result: Partial<Pick<
    OpenProjectResult,
    "analyses" | "analysisFolders" | "distributions" | "distributionFolders"
  >> & {
    fitYByX?: FitYByXItem[];
    fitYByXFolders?: Record<string, string>;
    fitModels?: unknown[];
    fitModelFolders?: Record<string, string>;
  },
): Pick<OpenProjectResult, "analyses" | "analysisFolders"> & {
  migratedCount: number;
  migrationWarnings: string[];
} {
  const distributions = migrateLegacyDistributions({
    analyses: result.analyses ?? [],
    analysisFolders: result.analysisFolders ?? {},
    distributions: result.distributions ?? [],
    distributionFolders: result.distributionFolders ?? {},
  });
  const fitYByX = migrateLegacyFitYByX({
    analyses: distributions.analyses,
    analysisFolders: distributions.analysisFolders,
    fitYByX: result.fitYByX ?? [],
    fitYByXFolders: result.fitYByXFolders ?? {},
  });
  const fitModels = migrateLegacyFitModels({
    analyses: fitYByX.analyses,
    analysisFolders: fitYByX.analysisFolders,
    fitModels: result.fitModels ?? [],
    fitModelFolders: result.fitModelFolders ?? {},
  });
  return {
    analyses: fitModels.analyses,
    analysisFolders: fitModels.analysisFolders,
    migratedCount: distributions.migratedCount + fitYByX.migratedCount + fitModels.migratedCount,
    migrationWarnings: fitModels.warnings,
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

export function shouldMarkAnalysisMigrationDirty(migratedCount: number): boolean {
  return migratedCount > 0;
}

export function createWorkspaceAnalysisGraphConfigPatch(
  document: AnalysisDocument,
  role: "overview" | "main",
  graph: EmbeddedGraphConfig,
  updatedAt: string,
): AnalysisGraphPersistenceResult {
  if (document.analysisKind === "distribution") {
    if (role !== "overview") throw new Error(`Unsupported Distribution graph role: ${role}`);
    return createAnalysisGraphPersistencePatch(document, role, graph, updatedAt);
  }
  if (document.analysisKind === "fitModel") {
    throw new Error("Fit Model graphs are not editable");
  }
  if (document.analysisKind === "hypothesisTest") {
    throw new Error("Hypothesis Test graphs are not editable");
  }
  if (role !== "main") throw new Error(`Unsupported Fit Y by X graph role: ${role}`);
  return createAnalysisGraphPersistencePatch(document, role, graph, updatedAt);
}

export function getAnalysisCreationHistoryKey(origin: "sample" | "generic"): "history.analysisSample" | "history.newAnalysis" {
  return origin === "sample" ? "history.analysisSample" : "history.newAnalysis";
}