import {
  createDistributionRequest,
  normalizeDistributionReportError,
  stableDistributionReportValue,
  type DistributionReportDependencies,
} from "@/components/distribution/useDistributionReport";
import type {
  AnalysisDocumentByKind,
  AnalysisKind,
  DistributionAnalysisDocument,
} from "@/types/analysis";
import type {
  DistributionItem,
  DistributionReportResponse,
  DistributionRequest,
} from "@/types/distribution";

export interface AnalysisExecutionDependencies extends DistributionReportDependencies {}

export type AnalysisExecutionRequestByKind = {
  distribution: DistributionRequest;
};

export type AnalysisExecutionResponseByKind = {
  distribution: DistributionReportResponse;
};

interface AnalysisExecutor<Kind extends AnalysisKind> {
  createRequest: (
    document: AnalysisDocumentByKind[Kind],
    generation: number,
  ) => AnalysisExecutionRequestByKind[Kind];
  fingerprint: (document: AnalysisDocumentByKind[Kind]) => string;
  requestIdentity: (request: AnalysisExecutionRequestByKind[Kind] | null) => string | null;
  resolveDependencies: (
    overrides?: Partial<AnalysisExecutionDependencies>,
  ) => Promise<AnalysisExecutionDependencies>;
  compute: (
    dependencies: AnalysisExecutionDependencies,
    request: AnalysisExecutionRequestByKind[Kind],
  ) => Promise<AnalysisExecutionResponseByKind[Kind]>;
  responseMatches: (
    response: AnalysisExecutionResponseByKind[Kind],
    request: AnalysisExecutionRequestByKind[Kind],
  ) => boolean;
  responseIdentityError: string;
  normalizeError: (error: unknown) => string;
}

function toDistributionItem(document: DistributionAnalysisDocument): DistributionItem {
  return {
    id: document.id,
    name: document.name,
    sourceDatasetId: document.source.datasetId,
    responses: document.definition.responses,
    weight: document.definition.weight,
    frequency: document.definition.frequency,
    by: document.definition.by,
    analysis: document.definition.analysis,
    graphs: document.definition.graphs,
    createdAt: document.createdAt,
  };
}

async function resolveDistributionDependencies(
  overrides?: Partial<AnalysisExecutionDependencies>,
): Promise<AnalysisExecutionDependencies> {
  if (overrides?.getDatasetGeneration && overrides.compute) {
    return overrides as AnalysisExecutionDependencies;
  }

  const [{ dataService }, { distributionService }] = await Promise.all([
    import("../../services/dataService"),
    import("../../services/distributionService"),
  ]);

  return {
    getDatasetGeneration: overrides?.getDatasetGeneration ?? dataService.getDatasetGeneration,
    compute: overrides?.compute ?? distributionService.compute,
  };
}

const distributionExecutor = {
  createRequest: (document, generation) => createDistributionRequest(
    toDistributionItem(document),
    generation,
  ),
  fingerprint: (document) => JSON.stringify(stableDistributionReportValue({
    analysisKind: document.analysisKind,
    configRevision: document.configRevision,
    sourceDatasetId: document.source.datasetId,
    responses: document.definition.responses,
    weight: document.definition.weight,
    frequency: document.definition.frequency,
    by: document.definition.by,
    analysis: document.definition.analysis,
  })),
  requestIdentity: (request) => request == null
    ? null
    : JSON.stringify(stableDistributionReportValue(request)),
  resolveDependencies: resolveDistributionDependencies,
  compute: (dependencies, request) => dependencies.compute(request),
  responseMatches: (response, request) => response.datasetId === request.datasetId
    && response.generation === request.generation,
  responseIdentityError: "Distribution response identity did not match the request.",
  normalizeError: normalizeDistributionReportError,
} satisfies AnalysisExecutor<"distribution">;

export const analysisExecutors = {
  distribution: distributionExecutor,
} satisfies { [Kind in AnalysisKind]: AnalysisExecutor<Kind> };

export function distributionAnalysisDefinitionFingerprint(
  document: DistributionAnalysisDocument,
): string {
  return analysisExecutors.distribution.fingerprint(document);
}

export function createAnalysisExecutionRequest(
  document: DistributionAnalysisDocument,
  generation: number,
): DistributionRequest {
  return analysisExecutors[document.analysisKind].createRequest(document, generation);
}