import type { FieldRef } from "@/graphCore";

import type { EmbeddedGraphConfig } from "./graphBuilder";

export type FitYByXPersonality = "oneway" | "bivariate";
export type FitYByXNotComputableReason =
  | "insufficientValidRows"
  | "insufficientGroups"
  | "constantFactor"
  | "noResidualDegreesOfFreedom"
  | "noWithinGroupDegreesOfFreedom";

export interface FitYByXRequest {
  datasetId: string;
  generation: number;
  responseColumn: string;
  factorColumn: string;
  personality: FitYByXPersonality;
  confidenceLevel: number;
}

export interface FitYByXAnovaRow {
  source: string;
  degreesOfFreedom: number;
  sumOfSquares: number;
  meanSquare: number | null;
  fRatio: number | null;
  pValue: number | null;
}

export interface FitYByXEstimateRow {
  term: string;
  estimate: number;
  standardError: number | null;
  tRatio: number | null;
  pValue: number | null;
  lowerConfidenceLimit: number | null;
  upperConfidenceLimit: number | null;
}

export interface FitYByXOnewayGroupSummary {
  group: string;
  count: number;
  mean: number;
  standardDeviation: number | null;
  standardError: number | null;
  lowerConfidenceLimit: number | null;
  upperConfidenceLimit: number | null;
}

export interface FitYByXOnewayEffectSizes {
  etaSquared: number;
  omegaSquared: number | null;
}

export interface FitYByXOnewayResult {
  kind: "oneway";
  usedRows: number;
  excludedRows: number;
  confidenceLevel: number;
  groupSummaries: FitYByXOnewayGroupSummary[];
  anova: FitYByXAnovaRow[];
  effectSizes: FitYByXOnewayEffectSizes;
}

export interface FitYByXSummaryOfFit {
  rSquared: number | null;
  adjustedRSquared: number | null;
  rootMeanSquareError: number | null;
  meanOfResponse: number;
  observationCount: number;
}

export interface FitYByXLackOfFitAvailable {
  state: "available";
  rows: FitYByXAnovaRow[];
}

export interface FitYByXLackOfFitNotIdentifiable {
  state: "notIdentifiable";
}

export type FitYByXLackOfFitResult =
  | FitYByXLackOfFitAvailable
  | FitYByXLackOfFitNotIdentifiable;

export interface FitYByXBivariateResult {
  kind: "bivariate";
  usedRows: number;
  excludedRows: number;
  confidenceLevel: number;
  intercept: number;
  slope: number;
  summaryOfFit: FitYByXSummaryOfFit;
  lackOfFit: FitYByXLackOfFitResult;
  anova: FitYByXAnovaRow[];
  parameterEstimates: FitYByXEstimateRow[];
}

export interface FitYByXNotComputableResult {
  kind: "notComputable";
  personality: FitYByXPersonality;
  reason: FitYByXNotComputableReason;
  usedRows: number;
  excludedRows: number;
  confidenceLevel: number;
}

export type FitYByXResult =
  | FitYByXOnewayResult
  | FitYByXBivariateResult
  | FitYByXNotComputableResult;

export interface FitYByXResponse {
  datasetId: string;
  generation: number;
  result: FitYByXResult;
}

export interface FitYByXItem {
  id: string;
  name: string;
  sourceDatasetId: string;
  response: FieldRef;
  factor: FieldRef;
  personality: FitYByXPersonality;
  graph: EmbeddedGraphConfig;
  createdAt: string;
}