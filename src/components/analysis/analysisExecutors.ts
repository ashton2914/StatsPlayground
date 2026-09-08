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
  FitYByXAnalysisDocument,
} from "@/types/analysis";
import type {
  DistributionItem,
  DistributionReportResponse,
  DistributionRequest,
} from "@/types/distribution";
import type { FitYByXRequest, FitYByXResponse } from "@/types/fitYByX";

function normalizeFitYByXReportError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  if (typeof error === "object" && error !== null) {
    const message = Reflect.get(error, "message");
    if (typeof message === "string" && message.trim().length > 0) return message;
  }
  if (typeof error === "string" && error.trim().length > 0) return error;
  return "Failed to load Fit Y by X report.";
}

export interface AnalysisExecutionDependencies {
  getDatasetGeneration: DistributionReportDependencies["getDatasetGeneration"];
  compute?: DistributionReportDependencies["compute"];
  computeFitYByX?: (request: FitYByXRequest) => Promise<FitYByXResponse>;
}

export type AnalysisExecutionRequestByKind = {
  distribution: DistributionRequest;
  fitYByX: FitYByXRequest;
};

export type AnalysisExecutionResponseByKind = {
  distribution: DistributionReportResponse;
  fitYByX: FitYByXResponse;
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

async function resolveFitYByXDependencies(
  overrides?: Partial<AnalysisExecutionDependencies>,
): Promise<AnalysisExecutionDependencies> {
  if (overrides?.getDatasetGeneration && overrides.computeFitYByX) {
    return overrides as AnalysisExecutionDependencies;
  }
  const [{ dataService }, { fitYByXService }] = await Promise.all([
    import("../../services/dataService"),
    import("../../services/fitYByXService"),
  ]);
  return {
    getDatasetGeneration: overrides?.getDatasetGeneration ?? dataService.getDatasetGeneration,
    computeFitYByX: overrides?.computeFitYByX ?? fitYByXService.compute,
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
  compute: (dependencies, request) => {
    if (!dependencies.compute) throw new Error("Distribution compute dependency is unavailable.");
    return dependencies.compute(request);
  },
  responseMatches: (response, request) => response.datasetId === request.datasetId
    && response.generation === request.generation,
  responseIdentityError: "Distribution response identity did not match the request.",
  normalizeError: normalizeDistributionReportError,
} satisfies AnalysisExecutor<"distribution">;

const fitYByXExecutor = {
  createRequest: (document, generation) => ({
    datasetId: document.source.datasetId,
    generation,
    responseColumn: document.definition.response.name,
    factorColumn: document.definition.factor.name,
    personality: document.definition.personality,
    confidenceLevel: document.definition.confidenceLevel,
  }),
  fingerprint: (document) => JSON.stringify(stableDistributionReportValue({
    analysisKind: document.analysisKind,
    configRevision: document.configRevision,
    sourceDatasetId: document.source.datasetId,
    response: document.definition.response,
    factor: document.definition.factor,
    personality: document.definition.personality,
    confidenceLevel: document.definition.confidenceLevel,
  })),
  requestIdentity: (request) => request == null
    ? null
    : JSON.stringify(stableDistributionReportValue(request)),
  resolveDependencies: resolveFitYByXDependencies,
  compute: (dependencies, request) => {
    if (!dependencies.computeFitYByX) throw new Error("Fit Y by X compute dependency is unavailable.");
    return dependencies.computeFitYByX(request);
  },
  responseMatches: (response, request) => response.datasetId === request.datasetId
    && response.generation === request.generation,
  responseIdentityError: "Fit Y by X response identity did not match the request.",
  normalizeError: normalizeFitYByXReportError,
} satisfies AnalysisExecutor<"fitYByX">;

export const analysisExecutors = {
  distribution: distributionExecutor,
  fitYByX: fitYByXExecutor,
} satisfies { [Kind in AnalysisKind]: AnalysisExecutor<Kind> };

export function distributionAnalysisDefinitionFingerprint(
  document: DistributionAnalysisDocument,
): string {
  return analysisExecutors.distribution.fingerprint(document);
}

export function fitYByXAnalysisDefinitionFingerprint(
  document: FitYByXAnalysisDocument,
): string {
  return analysisExecutors.fitYByX.fingerprint(document);
}

export function createAnalysisExecutionRequest(
  document: AnalysisDocumentByKind["distribution"],
  generation: number,
): AnalysisExecutionRequestByKind["distribution"];
export function createAnalysisExecutionRequest(
  document: AnalysisDocumentByKind["fitYByX"],
  generation: number,
): AnalysisExecutionRequestByKind["fitYByX"];
export function createAnalysisExecutionRequest(
  document: AnalysisDocumentByKind[AnalysisKind],
  generation: number,
): AnalysisExecutionRequestByKind[AnalysisKind];
export function createAnalysisExecutionRequest(
  document: AnalysisDocumentByKind[AnalysisKind],
  generation: number,
): AnalysisExecutionRequestByKind[AnalysisKind] {
  return document.analysisKind === "distribution"
    ? analysisExecutors.distribution.createRequest(document, generation)
    : analysisExecutors.fitYByX.createRequest(document, generation);
}

export function createWorkflowAnalysisExecutionRequest(
  document: AnalysisDocumentByKind[AnalysisKind],
  sourceDatasetId: string,
  generation: number,
): AnalysisExecutionRequestByKind[AnalysisKind] {
  if (sourceDatasetId.trim().length === 0) {
    throw new Error("Workflow Analysis source dataset ID is required.");
  }
  const boundDocument = {
    ...document,
    source: { datasetId: sourceDatasetId },
  } as AnalysisDocumentByKind[AnalysisKind];
  return createAnalysisExecutionRequest(boundDocument, generation);
}