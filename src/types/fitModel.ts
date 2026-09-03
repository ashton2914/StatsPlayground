import type { FieldRef } from "@/graphCore";

export type FitModelCenteringMethod = "none" | "mean";
export type FitModelConstruct =
  | { kind: "manual" }
  | { kind: "fullFactorial" }
  | { kind: "factorialToDegree"; degree: number }
  | { kind: "responseSurface" };

type FitModelStrictTerm =
  | { kind: "main"; columnNames: [string] }
  | { kind: "interaction"; columnNames: [string, string, ...string[]] }
  | { kind: "power"; columnNames: [string]; exponent: 2 };

export type FitModelTerm = FitModelStrictTerm;

export type FitModelTermKind = FitModelTerm["kind"];

export interface FitModelLoadIssue {
  code: string;
  detail: string;
}

export interface FitModelItem {
  id: string;
  name: string;
  sourceDatasetId: string;
  response: FieldRef;
  construct: FitModelConstruct;
  terms: FitModelTerm[];
  centeringMethod: FitModelCenteringMethod;
  createdAt: string;
  loadIssue?: FitModelLoadIssue;
}

export interface FitModelRequest {
  datasetId: string;
  generation: number;
  responseColumn: string;
  terms: FitModelTerm[];
  centeringMethod: FitModelCenteringMethod;
  confidenceLevel: 0.95;
}

export type FitModelNotComputableReason = "insufficientRows" | "rankDeficient";
export type FitModelWarningCode =
  | "saturatedModel"
  | "constantResponse"
  | "perfectFit"
  | "illConditioned";

export interface FitModelPlotRow {
  rowIndex: number;
  observed: number;
  fitted: number;
  residual: number;
}

export interface FitModelParameterEstimate {
  termId: string;
  termLabel: string;
  estimate: number;
  standardError: number | null;
  tRatio: number | null;
  pValue: number | null;
  lowerConfidenceLimit: number | null;
  upperConfidenceLimit: number | null;
}

export interface FitModelAnovaRow {
  source: string;
  degreesOfFreedom: number;
  sumOfSquares: number;
  meanSquare: number | null;
  fRatio: number | null;
  pValue: number | null;
}

export interface FitModelSummaryOfFit {
  rSquared: number | null;
  adjustedRSquared: number | null;
  rootMeanSquareError: number | null;
  meanOfResponse: number;
  observationCount: number;
  modelDegreesOfFreedom: number;
  errorDegreesOfFreedom: number;
}

export interface FitModelCenter {
  columnName: string;
  mean: number;
}

export interface FitModelCentering {
  method: FitModelCenteringMethod;
  centers: FitModelCenter[];
}

export interface FitModelResolvedTerm {
  termId: string;
  kind: FitModelTermKind;
  columnNames: string[];
  label: string;
}

export interface FitModelPredictorRange {
  columnName: string;
  minimum: number;
  maximum: number;
  mean: number;
}

export interface FitModelSnapshot {
  coefficientTermIds: string[];
  coefficients: number[];
  covariance: number[][] | null;
  meanSquareError: number | null;
  errorDegreesOfFreedom: number;
  confidenceLevel: 0.95;
  terms: FitModelResolvedTerm[];
  centering: FitModelCentering;
  predictorRanges: FitModelPredictorRange[];
}

export type FitModelInferenceReason = "inferenceNotEstimable";

export interface FitModelPrediction {
  predicted: number;
  meanConfidenceLower: number | null;
  meanConfidenceUpper: number | null;
  predictionLower: number | null;
  predictionUpper: number | null;
  inferenceReason: FitModelInferenceReason | null;
}

export interface FitModelFittedResult {
  kind: "fitted";
  usedRows: number;
  excludedRows: number;
  confidenceLevel: number;
  responseColumn: string;
  predictorColumns: string[];
  terms: FitModelResolvedTerm[];
  centering: FitModelCentering;
  snapshot: FitModelSnapshot;
  summaryOfFit: FitModelSummaryOfFit;
  anova: FitModelAnovaRow[];
  parameterEstimates: FitModelParameterEstimate[];
  plotRows: FitModelPlotRow[];
  plotRowsSampled: boolean;
  warnings: FitModelWarningCode[];
}

export interface FitModelNotComputableResult {
  kind: "notComputable";
  reason: FitModelNotComputableReason;
  usedRows: number;
  excludedRows: number;
}

export type FitModelResult = FitModelFittedResult | FitModelNotComputableResult;