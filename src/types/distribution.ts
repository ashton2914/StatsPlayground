import type { GraphDataFrame } from "./graphData";
import type { FieldRef } from "../graphCore/types";
import type { EmbeddedGraphConfig } from "./graphBuilder";

export type FilterExprV1 =
  | { kind: "and"; exprs: FilterExprV1[] }
  | { kind: "or"; exprs: FilterExprV1[] }
  | { kind: "not"; expr: FilterExprV1 }
  | { kind: "isNull"; fieldId: string; negate: boolean }
  | {
      kind: "numericRange";
      fieldId: string;
      min: number | null;
      max: number | null;
      includeMin: boolean;
      includeMax: boolean;
    }
  | { kind: "categorySet"; fieldId: string; values: string[]; negate: boolean }
  | {
      kind: "dateRange";
      fieldId: string;
      start: string | null;
      end: string | null;
      includeStart: boolean;
      includeEnd: boolean;
      timeZone: string;
    };

export type DistributionSchemaVersionV1 = "1";
export type DistributionModeV1 =
  | "emptySystem"
  | "continuous"
  | "ordinal"
  | "nominal"
  | "discreteNumeric";
export type DistributionModelingTypeV1 =
  | "continuous"
  | "ordinal"
  | "nominal"
  | "discreteNumeric"
  | "datetime";

export interface DistributionColumnRefV1 {
  columnId: string;
  modelingType: DistributionModelingTypeV1;
}

export interface DistributionColumnInfoV1 {
  columnId: string;
  name: string;
  sqlType: string;
  role: string;
  index: number;
  modelingType: DistributionModelingTypeV1;
  integerCompatible: boolean;
}

export interface DistributionColumnDescriptorV1 {
  columnId: string;
  name: string;
  sqlType: string;
  role: string;
  index: number;
}

export type ContinuousDistributionIdV1 =
  | "normal"
  | "lognormal"
  | "exponential"
  | "gamma"
  | "weibull";

export type DistributionFitKind = ContinuousDistributionIdV1;

export interface SpecLimitsOverride {
  lsl: number | null;
  target: number | null;
  usl: number | null;
}

export interface DistributionAnalysisConfig {
  confidenceLevel: number;
  specLimits: Record<string, SpecLimitsOverride>;
  fitDistributions: DistributionFitKind[];
}

export interface DistributionItem {
  id: string;
  name: string;
  sourceDatasetId: string;
  responses: FieldRef[];
  weight: FieldRef | null;
  frequency: FieldRef | null;
  by: FieldRef[];
  analysis: DistributionAnalysisConfig;
  graphs: {
    overview: EmbeddedGraphConfig;
    boxPlot: EmbeddedGraphConfig;
    ecdf: EmbeddedGraphConfig;
    normalQuantile: EmbeddedGraphConfig;
  };
  createdAt: string;
}

export interface DistributionRequest {
  datasetId: string;
  generation: number;
  responseColumns: string[];
  weightColumn: string | null;
  freqColumn: string | null;
  byColumns: string[];
  confidenceLevel: number;
  specLimits: Record<string, SpecLimitsOverride>;
  fitDistributions: DistributionFitKind[];
}

export type DistributionFitStatusV1 = "available" | "unavailable" | "failed";

export interface DistributionContinuousFitConfigV1 {
  enabledDistributionIds: ContinuousDistributionIdV1[];
  fitAll: boolean;
  diagnostics: {
    goodnessOfFit: boolean;
    qqPlot: boolean;
    cdfPlot: boolean;
    ppPlot: boolean;
  };
}

export interface DistributionFitCapabilityV1 {
  distributionId: ContinuousDistributionIdV1;
  methodId: string;
  methodVersion: string;
  parameterizationId: string;
  implemented: boolean;
  compatibilityStatus: Jmp19CompatibilityStatusV1;
}

export interface DistributionFitMetricV1 {
  metricId: string;
  value: CapabilityTypedValueV1;
}

export interface DistributionFitParameterV1 {
  parameterId: string;
  estimate: CapabilityTypedValueV1;
  standardError: CapabilityTypedValueV1;
  lowerConfidence: CapabilityTypedValueV1;
  upperConfidence: CapabilityTypedValueV1;
}

export interface DistributionFitConvergenceV1 {
  status: "converged" | "notConverged" | "failed";
  reasonCode: string | null;
  optimizerId: string;
  optimizerVersion: string;
  iterations: number;
  tolerance: number;
  objective?: number | null;
  gradientNorm?: number | null;
}

export interface DistributionFitProvenanceV1 {
  methodId: string;
  methodVersion: string;
  parameterizationId: string;
  optimizerId: string;
  optimizerVersion: string;
  initializationStrategyId: string;
  convergenceTolerance: number;
  iterationLimit: number;
  dependencyVersions: Record<string, string>;
  computationId: string;
  candidateRegistryIds: ContinuousDistributionIdV1[];
  compatibilityStatus: Jmp19CompatibilityStatusV1;
}

export interface DistributionFittedCurveDataV1 {
  schemaVersion: DistributionSchemaVersionV1;
  points: DistributionCoordinateV1[];
  provenance: DistributionFitProvenanceV1;
}

export interface DistributionFitGoodnessOfFitV1 {
  testId: string;
  statistic: CapabilityTypedValueV1;
  pValue: CapabilityTypedValueV1;
  status: DistributionFitStatusV1;
  reasonCode: string | null;
}

export interface DistributionFitDiagnosticDataV1 {
  diagnosticId: string;
  status: DistributionFitStatusV1;
  reasonCode: string | null;
  chartData?: DistributionChartDataV1;
}

export interface DistributionFitDataV1 {
  schemaVersion: DistributionSchemaVersionV1;
  fitId: string;
  distributionId: ContinuousDistributionIdV1;
  parameterizationId: string;
  status: DistributionFitStatusV1;
  reasonCode: string | null;
  parameters: DistributionFitParameterV1[];
  estimatedParameterCount: number;
  effectiveN: number;
  logLikelihood: CapabilityTypedValueV1;
  aic: CapabilityTypedValueV1;
  aicc: CapabilityTypedValueV1;
  bic: CapabilityTypedValueV1;
  goodnessOfFit: DistributionFitGoodnessOfFitV1[];
  fittedCurve?: DistributionFittedCurveDataV1;
  diagnostics: DistributionFitDiagnosticDataV1[];
  convergence: DistributionFitConvergenceV1;
  provenance: DistributionFitProvenanceV1;
  warnings: string[];
}

export interface DistributionFitComparisonRowV1 {
  distributionId: ContinuousDistributionIdV1;
  status: DistributionFitStatusV1;
  reasonCode: string | null;
  aic: CapabilityTypedValueV1;
  aicc: CapabilityTypedValueV1;
  bic: CapabilityTypedValueV1;
}

export interface DistributionFitComparisonDataV1 {
  schemaVersion: DistributionSchemaVersionV1;
  comparisonId: string;
  candidateRegistryIds: ContinuousDistributionIdV1[];
  rows: DistributionFitComparisonRowV1[];
}

export interface ObservationContributionDimensionV1 {
  code: string;
  action: string;
}

export interface ObservationContributionPolicyV1 {
  schemaVersion: DistributionSchemaVersionV1;
  dimensions: ObservationContributionDimensionV1[];
}

export interface ResourceBudgetV1 {
  maxGroups: number;
  maxRowsPerGroup: number;
  maxTotalRows: number;
  maxTotalBytes: number;
}

export interface DistributionRequestV1 {
  schemaVersion: DistributionSchemaVersionV1;
  analysisId: string;
  configRevision: number;
  sourceDatasetId: string | null;
  sourceDataVersion: string | null;
  mode: DistributionModeV1;
  yColumns: DistributionColumnRefV1[];
  weightColumnId: string | null;
  frequencyColumnId: string | null;
  byColumnIds: string[];
  filterExpr: FilterExprV1;
  confidenceLevel: number;
  histogramsOnly: boolean;
  continuousFit?: DistributionContinuousFitConfigV1;
  visualDiagnostics: DistributionVisualDiagnosticsConfigV1;
  enabledCapabilityIds: string[];
  capabilityOverrides: CapabilityOverrideEnvelopeV1[];
  observationPolicy: ObservationContributionPolicyV1;
  resourceBudget: ResourceBudgetV1;
  exact: boolean;
}

export type DistributionChartKindV1 =
  | "histogramData"
  | "boxPlotData"
  | "normalQuantileData"
  | "qqData"
  | "ppData"
  | "cdfData"
  | "fittedCurveData"
  | "diagnosticCoordinateData";

export type Jmp19CompatibilityStatusV1 =
  | "documentedCompatible"
  | "validatedCompatible"
  | "compatibilityPending"
  | "intentionalDifference";

export interface DistributionChartProvenanceV1 {
  methodId: string;
  methodVersion: string;
  compatibilityStatus: Jmp19CompatibilityStatusV1;
  computationId: string;
}

export type DiagnosticProvenanceV1 = DistributionChartProvenanceV1;

export interface DistributionCoordinateV1 {
  x: number;
  y: number;
}

export interface NormalQuantilePointV1 {
  rank: number;
  probability: number;
  normalScore: number;
  observedValue: number;
}

export interface NormalQuantileBandPointV1 {
  x: number;
  lower: number;
  upper: number;
}

export interface NormalQuantileDataV1 {
  points: NormalQuantilePointV1[];
  referenceLine: DistributionCoordinateV1[];
  confidenceBand: NormalQuantileBandPointV1[];
  status: "available" | "unavailable" | "failed";
  reasonCode: string | null;
  provenance: DiagnosticProvenanceV1;
  referenceLineProvenance: DiagnosticProvenanceV1;
  confidenceBandProvenance: DiagnosticProvenanceV1;
}

interface DistributionChartDataBaseV1 {
  schemaVersion: DistributionSchemaVersionV1;
  provenance: DistributionChartProvenanceV1;
}

export type DistributionChartDataV1 =
  | (DistributionChartDataBaseV1 & {
      kind: "histogramData";
      bins: Array<{
        lower: number;
        upper: number;
        count: number;
        probability: number;
        density: number;
      }>;
    })
  | (DistributionChartDataBaseV1 & {
      kind: "boxPlotData";
      coordinates: {
        lowerWhisker: number;
        lowerQuartile: number;
        median: number;
        upperQuartile: number;
        upperWhisker: number;
        outliers: number[];
      };
    })
  | (DistributionChartDataBaseV1 & {
      kind: "normalQuantileData";
      payload: NormalQuantileDataV1;
    })
  | (DistributionChartDataBaseV1 & {
      kind: Exclude<
        DistributionChartKindV1,
        "histogramData" | "boxPlotData" | "normalQuantileData"
      >;
      points: DistributionCoordinateV1[];
    });

export interface DistributionReportBlockV1 {
  schemaVersion: DistributionSchemaVersionV1;
  blockId: string;
  kind: string;
  titleKey: string;
  status: string;
  summaryData?: DistributionSummaryDataV1;
  capabilityData?: ProcessCapabilityDataV1;
  distributionFitData?: DistributionFitDataV1;
  distributionFitComparisonData?: DistributionFitComparisonDataV1;
  chartData: DistributionChartDataV1 | null;
}

export type DistributionResultStatus = "available" | "unavailable" | "failed";

export type DistributionReportBlock = Omit<DistributionReportBlockV1, "status"> & {
  status: DistributionResultStatus;
  reasonCode: string | null;
};

export type DistributionYResult = Omit<DistributionYResultV1, "blocks"> & {
  blocks: DistributionReportBlock[];
};

export type DistributionGroupResult = Omit<DistributionGroupResultV1, "yResults"> & {
  yResults: DistributionYResult[];
};

export interface DistributionReportResponse {
  datasetId: string;
  generation: number;
  groups: DistributionGroupResult[];
  reportBlocks: DistributionReportBlock[];
  graphFrames: {
    overview: GraphDataFrame;
    boxPlot: GraphDataFrame;
    ecdf: GraphDataFrame;
    normalQuantile: GraphDataFrame;
  };
}

export interface CapabilityTypedValueV1 {
  state: "available" | "notApplicable" | "unavailable" | "unbounded";
  value: number | null;
  reasonCode: string | null;
}

export interface ProcessCapabilityDataV1 {
  specification: {
    lsl: number | null;
    target: number | null;
    usl: number | null;
    source: "columnProperty" | "analysisOverride";
  };
  processSummary: {
    n: number;
    mean: number;
    movingRangeAverage: number | null;
    d2: number;
    withinSigma: number | null;
    overallSigma: number | null;
    stabilityIndex: {
      value: CapabilityTypedValueV1;
      methodId: string;
    };
  };
  indices: {
    cp: CapabilityTypedValueV1;
    cpk: CapabilityTypedValueV1;
    cpl: CapabilityTypedValueV1;
    cpu: CapabilityTypedValueV1;
    cpmWithin: CapabilityTypedValueV1;
    pp: CapabilityTypedValueV1;
    ppk: CapabilityTypedValueV1;
    ppl: CapabilityTypedValueV1;
    ppu: CapabilityTypedValueV1;
    cpmOverall: CapabilityTypedValueV1;
  };
  intervals: {
    confidenceLevel: number;
    cp: ProcessCapabilityIntervalV1;
    cpk: ProcessCapabilityIntervalV1;
    cpl: ProcessCapabilityIntervalV1;
    cpu: ProcessCapabilityIntervalV1;
    cpmWithin: ProcessCapabilityIntervalV1;
    pp: ProcessCapabilityIntervalV1;
    ppk: ProcessCapabilityIntervalV1;
    ppl: ProcessCapabilityIntervalV1;
    ppu: ProcessCapabilityIntervalV1;
    cpmOverall: ProcessCapabilityIntervalV1;
    provenance: ProcessCapabilityIntervalProvenanceV1;
  };
  nonconformance: ProcessCapabilityNonconformanceV1;
  chartData?: ProcessCapabilityChartDataV1;
  warnings: string[];
}

export interface ProcessCapabilityChartBinV1 {
  lower: number;
  upper: number;
  count: number;
  probability: number;
  density: number;
  belowCount: number;
  aboveCount: number;
}

export interface ProcessCapabilitySpecificationLinesV1 {
  lsl: number | null;
  target: number | null;
  usl: number | null;
  source: "columnProperty" | "analysisOverride";
}

export interface ProcessCapabilityDensitySeriesV1 {
  state: "available" | "notApplicable" | "unavailable" | "unbounded";
  reasonCode: string | null;
  coordinates: DistributionCoordinateV1[];
}

export interface ProcessCapabilityChartProvenanceV1 {
  capabilityMethod: string;
  normalDensityMethod: string;
  computationId: string;
  specFingerprint: string;
}

export interface ProcessCapabilityChartDataV1 {
  bins: ProcessCapabilityChartBinV1[];
  specificationLines: ProcessCapabilitySpecificationLinesV1;
  overallDensity: ProcessCapabilityDensitySeriesV1;
  withinDensity: ProcessCapabilityDensitySeriesV1 | null;
  provenance: ProcessCapabilityChartProvenanceV1;
}

export interface ProcessCapabilityIntervalV1 {
  lower: CapabilityTypedValueV1;
  upper: CapabilityTypedValueV1;
  intervalMethod: string | null;
  limitingSide: string | null;
  warnings: string[];
}

export interface ProcessCapabilityIntervalProvenanceV1 {
  distributionCrate: string;
  distributionCrateVersion: string;
  parameterization: string;
  inverseCdfAlgorithmId: string;
  methodVersion: string;
  withinEffectiveDegreesOfFreedom: number | null;
}

export interface CapabilityTypedCountV1 {
  state: "available" | "notApplicable" | "unavailable" | "unbounded";
  value: number | null;
  reasonCode: string | null;
}

export interface ProcessCapabilityProportionIntervalV1 {
  lower: CapabilityTypedValueV1;
  upper: CapabilityTypedValueV1;
  intervalMethod: string | null;
}

export interface ProcessCapabilityObservedTailV1 {
  count: CapabilityTypedCountV1;
  proportion: CapabilityTypedValueV1;
  ppm: CapabilityTypedValueV1;
  proportionInterval: ProcessCapabilityProportionIntervalV1;
}

export interface ProcessCapabilityObservedNonconformanceV1 {
  below: ProcessCapabilityObservedTailV1;
  above: ProcessCapabilityObservedTailV1;
  total: ProcessCapabilityObservedTailV1;
}

export interface ProcessCapabilityExpectedTailV1 {
  proportion: CapabilityTypedValueV1;
  ppm: CapabilityTypedValueV1;
}

export interface ProcessCapabilityExpectedNonconformanceBySigmaV1 {
  below: ProcessCapabilityExpectedTailV1;
  above: ProcessCapabilityExpectedTailV1;
  total: ProcessCapabilityExpectedTailV1;
}

export interface ProcessCapabilityNonconformanceV1 {
  observed: ProcessCapabilityObservedNonconformanceV1;
  expectedWithin: ProcessCapabilityExpectedNonconformanceBySigmaV1;
  expectedOverall: ProcessCapabilityExpectedNonconformanceBySigmaV1;
}

export interface DistributionSummaryDataV1 {
  n: number;
  nMissing: number;
  mean: number;
  stdDev: number | null;
  stdError: number | null;
  meanCiLower: number | null;
  meanCiUpper: number | null;
  minimum: number;
  maximum: number;
  median: number;
  primaryMode: number;
  modeIsUnique: boolean;
  range: number;
  iqr: number;
  mad: number;
}

export interface DistributionQuantileValueV1 {
  probability: number;
  value: number;
}

export interface DistributionYResultV1 {
  yColumn: DistributionColumnRefV1;
  yName: string;
  quantiles: DistributionQuantileValueV1[];
  blocks: DistributionReportBlockV1[];
}

export type DistributionGroupValueV1 =
  | { kind: "missing" }
  | { kind: "boolean"; value: boolean }
  | { kind: "number"; value: number }
  | { kind: "text"; value: string }
  | { kind: "dateTime"; utcMillis: number };

export interface DistributionGroupResultV1 {
  groupKey: DistributionGroupValueV1[];
  groupNames?: string[];
  yResults: DistributionYResultV1[];
}

export interface CapabilityDescriptorV1 {
  id: string;
  titleKey: string;
  scope: string;
  menuScope: string;
  statusKey: string;
}

export type BlackBoxValueV1 =
  | { kind: "number"; value: number }
  | { kind: "boolean"; value: boolean }
  | { kind: "code"; value: string }
  | { kind: "numberList"; value: number[] }
  | { kind: "codeList"; value: string[] }
  | { kind: "null" };

export type BlackBoxStatusV1 = "available" | "unavailable" | "warning" | "error";
export type BlackBoxObservationV1 =
  | { kind: "numeric"; outputId: string; value: number }
  | { kind: "enumeration"; outputId: string; value: string }
  | { kind: "status"; outputId: string; value: BlackBoxStatusV1 };

export interface BlackBoxProvenanceV1 {
  sourceLedgerHash: string;
  inputHash: string;
  outputHash: string;
  toolVersion: string;
  seed: string;
  reviewArtifactHash: string;
}

export interface BlackBoxCaseV1 {
  schemaVersion: DistributionSchemaVersionV1;
  caseId: string;
  actionId: string;
  provenance: BlackBoxProvenanceV1;
  inputs: Record<string, BlackBoxValueV1>;
  expected: BlackBoxObservationV1[];
  observed: BlackBoxObservationV1[];
  warnings: string[];
}

export interface SourceLedgerEntryV1 {
  artifactId: string;
  originKind: string;
  allowedFieldKeys: string[];
  inputHash: string;
  outputHash: string;
  reviewState: string;
}

export interface LegalReviewRecordV1 {
  artifactId: string;
  status: string;
  requestedAt: string;
  reviewerRole: string;
  artifactHash: string;
  notesHash: string;
}

interface DistributionDocBaseV1 {
  schemaVersion: string;
  analysisId: string;
  name: string;
  sourceDatasetId: string;
  status: string;
}

export interface LoadedDistributionDocV1 extends DistributionDocBaseV1 {
  schemaVersion: DistributionSchemaVersionV1;
  loadStatus: "ready" | "missingSource";
  configRevision: number;
  currentConfig: DistributionAnalysisConfigV1;
  rawEnvelope?: never;
  rawText?: never;
}

export interface PreservedDistributionDocV1 extends DistributionDocBaseV1 {
  loadStatus: "unknownVersion" | "corrupt";
  currentConfig: Record<string, unknown>;
  rawEnvelope?: Record<string, unknown>;
  rawText?: string;
}

export type DistributionDocV1 = LoadedDistributionDocV1 | PreservedDistributionDocV1;

export type DistributionLoadStatusV1 = "ready" | "unknownVersion" | "missingSource" | "corrupt";

export interface DerivedFormulaDocV1 {
  formulaId: string;
  schemaVersion: DistributionSchemaVersionV1;
  analysisId: string;
  sourceDatasetId: string;
  sourceColumnIds: string[];
  outputColumnName: string;
  ast: Record<string, unknown>;
  fingerprint: string;
}

export interface DistributionIssueV1 {
  analysisId: string;
  kind: DistributionLoadStatusV1;
  messageKey: string;
  schemaVersion: string;
  sourceDatasetId?: string;
}

export interface CapabilityOverrideEnvelopeV1 {
  schemaVersion: DistributionSchemaVersionV1;
  capabilityId: string;
  payloadSchemaVersion: string;
  payload: Record<string, unknown>;
}

export interface DistributionYReportPreferencesV2 {
  overview: boolean;
  histogram: boolean;
  outlierBoxPlot: boolean;
  specificationLines: boolean;
  quantiles: boolean;
  summary: boolean;
  horizontalTables: boolean;
  normalQuantilePlot: boolean;
  ecdf: boolean;
  processCapability: boolean;
  histogramScale: "count" | "probability" | "density";
  capabilityHistogram?: boolean;
  capabilityProcessSummary?: boolean;
  capabilityWithin?: boolean;
  capabilityOverall?: boolean;
  capabilityNonconformance?: boolean;
  fitOverlays?: boolean;
  fitDetails?: boolean;
}

export type DistributionYReportPreferencesV1 = DistributionYReportPreferencesV2;

export interface DistributionHistogramDiagnosticsConfigV1 {
  method:
    | "jmpAuto"
    | "freedmanDiaconis"
    | "scott"
    | "sturges"
    | "fixedCount"
    | "fixedWidth";
  fixedCount: number | null;
  fixedWidth: number | null;
}

export interface DistributionVisualDiagnosticsConfigV1 {
  histogram: DistributionHistogramDiagnosticsConfigV1;
  normalQuantileConfidenceLevel: number;
}

export interface DistributionAnalysisConfigV1 {
  schemaVersion: DistributionSchemaVersionV1;
  sourceDatasetId: string;
  yColumns: DistributionColumnRefV1[];
  weightColumnId: string | null;
  frequencyColumnId: string | null;
  byColumnIds: string[];
  filterExpr: FilterExprV1;
  confidenceLevel: number;
  histogramsOnly: boolean;
  continuousFit?: DistributionContinuousFitConfigV1;
  visualDiagnostics?: DistributionVisualDiagnosticsConfigV1;
  enabledCapabilityIds: string[];
  capabilityOverrides: CapabilityOverrideEnvelopeV1[];
  reportPreferences?: Record<string, DistributionYReportPreferencesV1>;
}

export interface DistributionConfigErrorV1 {
  code: string;
  messageKey: string;
  fieldPath: string;
}