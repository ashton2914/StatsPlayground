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
  FitModelAnalysisDocument,
  FitYByXAnalysisDocument,
  HypothesisTestAnalysisDocument,
} from "@/types/analysis";
import type {
  DistributionItem,
  DistributionReportResponse,
  DistributionRequest,
} from "@/types/distribution";
import type { FitYByXRequest, FitYByXResponse } from "@/types/fitYByX";
import type { FitModelRequest, FitModelResult } from "@/types/fitModel";
import type { HypothesisTestRequest, HypothesisTestResponse } from "@/types/hypothesisTest";

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
  runFitModel?: (request: FitModelRequest) => Promise<FitModelResult>;
  runHypothesisTest?: (request: HypothesisTestRequest) => Promise<HypothesisTestResponse>;
}

export type AnalysisExecutionRequestByKind = {
  distribution: DistributionRequest;
  fitYByX: FitYByXRequest;
  fitModel: FitModelRequest;
  hypothesisTest: HypothesisTestRequest;
};

export type AnalysisExecutionResponseByKind = {
  distribution: DistributionReportResponse;
  fitYByX: FitYByXResponse;
  fitModel: FitModelResult;
  hypothesisTest: HypothesisTestResponse;
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

async function resolveFitModelDependencies(
  overrides?: Partial<AnalysisExecutionDependencies>,
): Promise<AnalysisExecutionDependencies> {
  if (overrides?.getDatasetGeneration && overrides.runFitModel) {
    return overrides as AnalysisExecutionDependencies;
  }
  const [{ dataService }, { fitModelService }] = await Promise.all([
    import("../../services/dataService"),
    import("../../services/fitModelService"),
  ]);
  return {
    getDatasetGeneration: overrides?.getDatasetGeneration ?? dataService.getDatasetGeneration,
    runFitModel: overrides?.runFitModel ?? fitModelService.run,
  };
}

async function resolveHypothesisTestDependencies(
  overrides?: Partial<AnalysisExecutionDependencies>,
): Promise<AnalysisExecutionDependencies> {
  if (overrides?.getDatasetGeneration && overrides.runHypothesisTest) {
    return overrides as AnalysisExecutionDependencies;
  }
  const [{ dataService }, { hypothesisTestService }] = await Promise.all([
    import("../../services/dataService"),
    import("../../services/hypothesisTestService"),
  ]);
  return {
    getDatasetGeneration: overrides?.getDatasetGeneration ?? dataService.getDatasetGeneration,
    runHypothesisTest: overrides?.runHypothesisTest ?? hypothesisTestService.run,
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

const fitModelExecutor = {
  createRequest: (document, generation) => ({
    datasetId: document.source.datasetId,
    generation,
    responseColumn: document.definition.response.name,
    terms: structuredClone(document.definition.terms),
    centeringMethod: document.definition.centeringMethod,
    confidenceLevel: 0.95,
  }),
  fingerprint: (document) => JSON.stringify(stableDistributionReportValue({
    analysisKind: document.analysisKind,
    configRevision: document.configRevision,
    sourceDatasetId: document.source.datasetId,
    response: document.definition.response,
    construct: document.definition.construct,
    terms: document.definition.terms,
    centeringMethod: document.definition.centeringMethod,
    confidenceLevel: document.definition.confidenceLevel,
    migrationIssue: document.definition.migrationIssue ?? null,
  })),
  requestIdentity: (request) => request == null
    ? null
    : JSON.stringify(stableDistributionReportValue(request)),
  resolveDependencies: resolveFitModelDependencies,
  compute: (dependencies, request) => {
    if (!dependencies.runFitModel) throw new Error("Fit Model compute dependency is unavailable.");
    return dependencies.runFitModel(request);
  },
  responseMatches: (_response, _request) => true,
  responseIdentityError: "Fit Model response identity did not match the request.",
  normalizeError: (error) => {
    if (error instanceof Error && error.message.trim()) return error.message;
    if (typeof error === "string" && error.trim()) return error;
    const message = typeof error === "object" && error !== null ? Reflect.get(error, "message") : null;
    return typeof message === "string" && message.trim() ? message : "Failed to load Fit Model report.";
  },
} satisfies AnalysisExecutor<"fitModel">;

function hypothesisTestFingerprint(document: HypothesisTestAnalysisDocument): string {
  const definition = structuredClone(document.definition);
  if (definition.manualSelection) definition.manualSelection.reason = null;
  return JSON.stringify(stableDistributionReportValue({
    analysisKind: document.analysisKind,
    analysisId: document.id,
    configRevision: document.configRevision,
    sourceDatasetId: document.source.datasetId,
    definition,
  }));
}

const hypothesisTestExecutor = {
  createRequest: (document, generation) => {
    const requestFingerprint = hypothesisTestFingerprint(document);
    return {
      analysisKind: "hypothesisTest",
      analysisId: document.id,
      datasetId: document.source.datasetId,
      generation,
      configRevision: document.configRevision,
      definition: structuredClone(document.definition),
      requestFingerprint,
    };
  },
  fingerprint: hypothesisTestFingerprint,
  requestIdentity: (request) => request == null
    ? null
    : JSON.stringify(stableDistributionReportValue(request)),
  resolveDependencies: resolveHypothesisTestDependencies,
  compute: (dependencies, request) => {
    if (!dependencies.runHypothesisTest) throw new Error("Hypothesis Test compute dependency is unavailable.");
    return dependencies.runHypothesisTest(request);
  },
  responseMatches: (response, request) => response.analysisKind === request.analysisKind
    && response.analysisId === request.analysisId
    && response.datasetId === request.datasetId
    && response.generation === request.generation
    && response.configRevision === request.configRevision
    && response.selectorVersion === request.definition.selectorVersion
    && response.requestFingerprint === request.requestFingerprint,
  responseIdentityError: "Hypothesis Test response identity did not match the request.",
  normalizeError: (error) => {
    if (error instanceof Error && error.message.trim()) return error.message;
    if (typeof error === "string" && error.trim()) return error;
    const message = typeof error === "object" && error !== null ? Reflect.get(error, "message") : null;
    return typeof message === "string" && message.trim() ? message : "Failed to run Hypothesis Test.";
  },
} satisfies AnalysisExecutor<"hypothesisTest">;

export const analysisExecutors = {
  distribution: distributionExecutor,
  fitYByX: fitYByXExecutor,
  fitModel: fitModelExecutor,
  hypothesisTest: hypothesisTestExecutor,
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

export function fitModelAnalysisDefinitionFingerprint(
  document: FitModelAnalysisDocument,
): string {
  return analysisExecutors.fitModel.fingerprint(document);
}

export function hypothesisTestAnalysisDefinitionFingerprint(
  document: HypothesisTestAnalysisDocument,
): string {
  return analysisExecutors.hypothesisTest.fingerprint(document);
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
  document: AnalysisDocumentByKind["fitModel"],
  generation: number,
): AnalysisExecutionRequestByKind["fitModel"];
export function createAnalysisExecutionRequest(
  document: AnalysisDocumentByKind["hypothesisTest"],
  generation: number,
): AnalysisExecutionRequestByKind["hypothesisTest"];
export function createAnalysisExecutionRequest(
  document: AnalysisDocumentByKind[AnalysisKind],
  generation: number,
): AnalysisExecutionRequestByKind[AnalysisKind];
export function createAnalysisExecutionRequest(
  document: AnalysisDocumentByKind[AnalysisKind],
  generation: number,
): AnalysisExecutionRequestByKind[AnalysisKind] {
  if (document.analysisKind === "distribution") {
    return analysisExecutors.distribution.createRequest(document, generation);
  }
  if (document.analysisKind === "fitYByX") {
    return analysisExecutors.fitYByX.createRequest(document, generation);
  }
  if (document.analysisKind === "fitModel") {
    return analysisExecutors.fitModel.createRequest(document, generation);
  }
  return analysisExecutors.hypothesisTest.createRequest(document, generation);
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