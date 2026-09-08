import type { FieldRef } from "../graphCore/types";

export const HYPOTHESIS_TEST_METHOD_IDS = [
  "studentTwoSampleT",
  "welchTwoSampleT",
  "mannWhitneyU",
  "oneWayAnova",
  "welchAnova",
  "kruskalWallis",
  "pairedT",
  "wilcoxonSignedRank",
  "randomizedBlockAnova",
  "friedman",
] as const;

export type HypothesisTestMethodId = typeof HYPOTHESIS_TEST_METHOD_IDS[number];
export type HypothesisTestStudyDesign = "independent" | "pairedOrBlocked";
export type HypothesisTestSelectionMode = "automatic" | "guided" | "manual";
export type HypothesisTestAlternative = "twoSided" | "less" | "greater";
export type HypothesisTestSelectorVersion = "1";

export type HypothesisTestRoles =
  | {
      layout: "long";
      response: FieldRef;
      condition: FieldRef;
      subject: FieldRef | null;
    }
  | {
      layout: "wide";
      measurements: FieldRef[];
      subject: FieldRef | null;
    };

export interface HypothesisTestManualSelection {
  methodId: HypothesisTestMethodId;
  reason: string | null;
}

export interface HypothesisTestAnalysisDefinition {
  kind: "hypothesisTest";
  roles: HypothesisTestRoles;
  studyDesign: HypothesisTestStudyDesign;
  selectionMode: HypothesisTestSelectionMode;
  manualSelection: HypothesisTestManualSelection | null;
  alternative: HypothesisTestAlternative;
  alpha: number;
  confidenceLevel: number;
  levelOrder: string[];
  referenceLevel: string | null;
  postHoc: "automatic" | "off";
  selectorVersion: HypothesisTestSelectorVersion;
}

export interface HypothesisTestAnalysisPresentation {
  schemaVersion: 1;
  layout: "hypothesis-test-v1";
  activeResultTab: "results" | "diagnostics" | "audit";
  collapsedSections: Array<"methodEvidence" | "sensitivity" | "postHoc" | "exclusions" | "audit">;
  graphs: {
    showRawData: boolean;
    showIntervals: boolean;
    showDiagnostics: boolean;
  };
  tableSort: {
    key: string;
    direction: "ascending" | "descending";
  } | null;
}

export type HypothesisTestValue =
  | { state: "available"; value: number }
  | { state: "unavailable"; reason: string };

export interface HypothesisTestEstimate {
  estimand: string;
  estimate: HypothesisTestValue;
  lower: HypothesisTestValue;
  upper: HypothesisTestValue;
  confidenceLevel: number;
  simultaneous: boolean;
}

export interface HypothesisTestEffectSize {
  kind: string;
  estimate: HypothesisTestValue;
  formulaVersion: string;
}

export interface HypothesisTestMethodResult {
  state: "computed";
  methodId: HypothesisTestMethodId;
  statisticName: string;
  statistic: number;
  degreesOfFreedom: number[];
  pValue: number;
  direction: "negative" | "none" | "positive";
  conclusion: "difference" | "insufficientEvidence";
  estimate: HypothesisTestEstimate;
  effectSize: HypothesisTestEffectSize;
  formulaVersion: string;
}

export interface HypothesisTestCompatibility {
  methodId: HypothesisTestMethodId;
  state: "compatible" | "incompatible";
  reasonCodes: string[];
}

export interface HypothesisTestDiagnosticEvidence {
  code: string;
  grade: "supports" | "opposes" | "insufficient";
  value: HypothesisTestValue;
  parameters: Record<string, number | string>;
}

export interface HypothesisTestSelectionDecision {
  selectorVersion: HypothesisTestSelectorVersion;
  recommendedMethod: HypothesisTestMethodId;
  executedMethod: HypothesisTestMethodId;
  certainty: "high" | "medium" | "low";
  reasonCodes: string[];
  overridden: boolean;
}

export interface HypothesisTestSensitivityResult {
  method: HypothesisTestMethodResult;
  robustness: "stable" | "statisticallySensitive" | "substantivelyConflicting" | "notDirectlyComparable";
}

export interface HypothesisTestPostHocComparison {
  left: string;
  right: string;
  estimate: HypothesisTestValue;
  rawPValue: number;
  adjustedPValue: number;
  adjustment: string;
  lower: HypothesisTestValue;
  upper: HypothesisTestValue;
}

export interface HypothesisTestPostHocResult {
  state: "computed";
  family: "tukeyKramer" | "gamesHowell" | "dunnHolm" | "pairedTHolm" | "pairedWilcoxonHolm";
  comparisons: HypothesisTestPostHocComparison[];
  compactLetters: Record<string, string>;
}

export interface HypothesisTestExclusion {
  identity: string;
  reasonCode: string;
  condition: string | null;
}

export interface HypothesisTestAudit {
  selectorVersion: HypothesisTestSelectorVersion;
  methodVersion: string;
  formulaVersion: string;
  inferencePath: "exact" | "asymptotic" | "parametric";
  correctionCodes: string[];
  executedAt: string;
}

export interface HypothesisTestPlotObservation {
  condition: string;
  value: number;
  subject: string | null;
}

export interface HypothesisTestPlotSummary {
  condition: string;
  count: number;
  mean: number;
  median: number;
  lowerQuartile: number;
  upperQuartile: number;
  minimum: number;
  maximum: number;
  meanIntervalLower: HypothesisTestValue;
  meanIntervalUpper: HypothesisTestValue;
}

export interface HypothesisTestQqPoint {
  theoretical: number;
  observed: number;
}

export interface HypothesisTestPlotData {
  studyStructure: "independent" | "paired" | "completeBlock";
  conditions: string[];
  observations: HypothesisTestPlotObservation[];
  summaries: HypothesisTestPlotSummary[];
  diagnosticKind: "groupResiduals" | "pairedDifferences" | "additiveResiduals";
  diagnosticValues: number[];
  qqPoints: HypothesisTestQqPoint[];
}

export interface HypothesisTestRequest {
  analysisKind: "hypothesisTest";
  analysisId: string;
  datasetId: string;
  generation: number;
  configRevision: number;
  definition: HypothesisTestAnalysisDefinition;
  requestFingerprint: string;
}

export interface HypothesisTestResponse {
  analysisKind: "hypothesisTest";
  analysisId: string;
  datasetId: string;
  generation: number;
  configRevision: number;
  selectorVersion: HypothesisTestSelectorVersion;
  requestFingerprint: string;
  retainedObservations: number;
  plotData: HypothesisTestPlotData;
  exclusions: HypothesisTestExclusion[];
  compatibility: HypothesisTestCompatibility[];
  diagnostics: HypothesisTestDiagnosticEvidence[];
  selectionDecision: HypothesisTestSelectionDecision;
  primaryResult: HypothesisTestMethodResult;
  sensitivityResults: HypothesisTestSensitivityResult[];
  postHocResult: HypothesisTestPostHocResult | null;
  warnings: string[];
  methodAudit: HypothesisTestAudit;
}