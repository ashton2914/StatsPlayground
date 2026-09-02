import type { FieldRef } from "@/graphCore";

export type FitModelCenteringMethod = "none" | "mean";
export type FitModelConstruct =
  | { kind: "manual" }
  | { kind: "fullFactorial" }
  | { kind: "factorialToDegree"; degree: number }
  | { kind: "responseSurface" };

type FitModelStrictTerm =
  | { kind: "main"; columnNames: [string] }
  | { kind: "interaction"; columnNames: string[] }
  | { kind: "power"; columnNames: [string]; exponent?: 2 };

export type FitModelTerm =
  | FitModelStrictTerm
  | { kind: "main" | "interaction" | "power"; columnNames: string[]; exponent?: 2 };

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
  confidenceLevel: number;
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

export interface FitModelResolvedTerm {
  termId: string;
  kind: FitModelTermKind;
  columnNames: string[];
  label: string;
}

export interface FitModelFittedResult {
  kind: "fitted";
  usedRows: number;
  excludedRows: number;
  confidenceLevel: number;
  responseColumn: string;
  predictorColumns: string[];
  terms: FitModelResolvedTerm[];
  centering: {
    method: FitModelCenteringMethod;
    centers: FitModelCenter[];
  };
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