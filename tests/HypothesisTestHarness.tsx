import { HypothesisTestAnalysisReport } from "../src/components/analysis/renderers/HypothesisTestAnalysisReport";
import { HypothesisTestDialog } from "../src/components/hypothesisTest/HypothesisTestDialog";
import type { AnalysisExecutionState } from "../src/components/analysis/useAnalysisExecution";
import { dataService } from "../src/services/dataService";
import type { DatasetMeta } from "../src/types/data";
import type {
  HypothesisTestAnalysisPresentation,
  HypothesisTestMethodResult,
  HypothesisTestPlotData,
  HypothesisTestRequest,
  HypothesisTestResponse,
} from "../src/types/hypothesisTest";

export type HypothesisTestHarnessMode =
  | "independent"
  | "paired"
  | "completeBlock"
  | "conflictPostHoc"
  | "loading"
  | "error"
  | "sourceMissing";

const presentation: HypothesisTestAnalysisPresentation = {
  schemaVersion: 1,
  layout: "hypothesis-test-v1",
  activeResultTab: "results",
  collapsedSections: [],
  graphs: { showRawData: true, showIntervals: true, showDiagnostics: true },
  tableSort: null,
};

function request(): HypothesisTestRequest {
  return {
    analysisKind: "hypothesisTest",
    analysisId: "hypothesis-1",
    datasetId: "dataset-1",
    generation: 4,
    configRevision: 1,
    requestFingerprint: "hypothesis-fixture",
    definition: {
      kind: "hypothesisTest",
      roles: {
        layout: "wide",
        measurements: [
          { name: "Control", type: "continuous" },
          { name: "Treatment", type: "continuous" },
        ],
        subject: null,
      },
      studyDesign: "independent",
      selectionMode: "automatic",
      manualSelection: null,
      alternative: "twoSided",
      alpha: 0.05,
      confidenceLevel: 0.95,
      levelOrder: ["Control", "Treatment"],
      referenceLevel: "Control",
      postHoc: "automatic",
      selectorVersion: "1",
    },
  };
}

function methodResult(methodId: HypothesisTestMethodResult["methodId"] = "studentTwoSampleT"): HypothesisTestMethodResult {
  return {
    state: "computed",
    methodId,
    statisticName: "t",
    statistic: -3.2,
    degreesOfFreedom: [14],
    pValue: 0.006,
    direction: "negative",
    conclusion: "difference",
    estimate: {
      estimand: "meanDifference",
      estimate: { state: "available", value: -3 },
      lower: { state: "available", value: -4.9 },
      upper: { state: "available", value: -1.1 },
      confidenceLevel: 0.95,
      simultaneous: false,
    },
    effectSize: { kind: "hedgesG", estimate: { state: "available", value: -1.4 }, formulaVersion: "1" },
    formulaVersion: "1",
  };
}

function plotData(structure: "independent" | "paired" | "completeBlock"): HypothesisTestPlotData {
  const conditions = structure === "completeBlock" ? ["Control", "Treatment", "Recovery"] : ["Control", "Treatment"];
  const subjects = ["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8"];
  const observations = subjects.flatMap((subject, subjectIndex) => conditions.map((condition, conditionIndex) => ({
    condition,
    value: 10 + subjectIndex * 0.45 + conditionIndex * 3 + (subjectIndex % 2 ? 0.35 : -0.2),
    subject: structure === "independent" ? null : subject,
  })));
  const summaries = conditions.map((condition, conditionIndex) => ({
    condition,
    count: subjects.length,
    mean: 11.7 + conditionIndex * 3,
    median: 11.65 + conditionIndex * 3,
    lowerQuartile: 10.7 + conditionIndex * 3,
    upperQuartile: 12.7 + conditionIndex * 3,
    minimum: 9.8 + conditionIndex * 3,
    maximum: 13.5 + conditionIndex * 3,
    meanIntervalLower: { state: "available" as const, value: 10.8 + conditionIndex * 3 },
    meanIntervalUpper: { state: "available" as const, value: 12.6 + conditionIndex * 3 },
  }));
  const diagnosticValues = observations.map((observation, index) => observation.value - summaries[index % conditions.length].mean);
  return {
    studyStructure: structure,
    conditions,
    observations,
    summaries,
    diagnosticKind: structure === "independent" ? "groupResiduals" : structure === "paired" ? "pairedDifferences" : "additiveResiduals",
    diagnosticValues,
    qqPoints: [...diagnosticValues]
      .sort((left, right) => left - right)
      .map((observed, index, values) => ({ theoretical: -1.8 + index * (3.6 / Math.max(1, values.length - 1)), observed })),
  };
}

function response(mode: HypothesisTestHarnessMode): HypothesisTestResponse {
  const structure = mode === "paired" ? "paired" : mode === "completeBlock" ? "completeBlock" : "independent";
  const primaryResult = methodResult(structure === "completeBlock" ? "randomizedBlockAnova" : structure === "paired" ? "pairedT" : "studentTwoSampleT");
  return {
    analysisKind: "hypothesisTest",
    analysisId: "hypothesis-1",
    datasetId: "dataset-1",
    generation: 4,
    configRevision: 1,
    selectorVersion: "1",
    requestFingerprint: "hypothesis-fixture",
    retainedObservations: structure === "completeBlock" ? 24 : 16,
    plotData: plotData(structure),
    exclusions: [{ identity: "row-17", reasonCode: "MISSING_RESPONSE", condition: "Treatment" }],
    compatibility: [],
    diagnostics: [{ code: "varianceRatio", grade: "supports", value: { state: "available", value: 1.18 }, parameters: {} }],
    selectionDecision: {
      selectorVersion: "1",
      recommendedMethod: primaryResult.methodId,
      executedMethod: primaryResult.methodId,
      certainty: mode === "conflictPostHoc" ? "low" : "high",
      reasonCodes: [],
      overridden: false,
    },
    primaryResult,
    sensitivityResults: mode === "conflictPostHoc"
      ? [{ method: { ...methodResult("mannWhitneyU"), conclusion: "insufficientEvidence", pValue: 0.08 }, robustness: "statisticallySensitive" }]
      : [],
    postHocResult: mode === "conflictPostHoc" ? {
      state: "computed",
      family: "tukeyKramer",
      comparisons: [{
        left: "Control",
        right: "Treatment",
        estimate: { state: "available", value: -3 },
        rawPValue: 0.004,
        adjustedPValue: 0.012,
        adjustment: "tukeyKramer",
        lower: { state: "available", value: -4.8 },
        upper: { state: "available", value: -1.2 },
      }],
      compactLetters: { Control: "A", Treatment: "B" },
    } : null,
    warnings: mode === "conflictPostHoc" ? ["Method conclusions differ at alpha."] : [],
    methodAudit: {
      selectorVersion: "1",
      methodVersion: "1",
      formulaVersion: "1",
      inferencePath: "parametric",
      correctionCodes: [],
      executedAt: "2026-09-08T00:00:00Z",
    },
  };
}

function state(mode: HypothesisTestHarnessMode): AnalysisExecutionState {
  if (mode === "loading" || mode === "sourceMissing") {
    return { status: "loading", analysisKind: "hypothesisTest", analysisId: "hypothesis-1", datasetId: "dataset-1", configRevision: 1, request: request() };
  }
  if (mode === "error") {
    return { status: "error", analysisKind: "hypothesisTest", analysisId: "hypothesis-1", datasetId: "dataset-1", configRevision: 1, request: request(), error: "Not enough complete pairs." };
  }
  return { status: "success", analysisKind: "hypothesisTest", analysisId: "hypothesis-1", datasetId: "dataset-1", configRevision: 1, request: request(), result: response(mode) };
}

export function HypothesisTestHarness({ mode = "independent" }: { mode?: HypothesisTestHarnessMode }) {
  return (
    <main style={{ width: "100%", minWidth: 0 }}>
      <HypothesisTestAnalysisReport
        state={state(mode)}
        datasetMissing={mode === "sourceMissing"}
        presentation={presentation}
      />
    </main>
  );
}

const dialogDataset: DatasetMeta = {
  id: "dataset-1",
  name: "Measurements",
  sourcePath: null,
  sourceType: "manual",
  rowCount: 12,
  colCount: 3,
  generation: 1,
  createdAt: "2026-09-08T00:00:00Z",
  updatedAt: "2026-09-08T00:00:00Z",
};

export function HypothesisTestDialogHarness() {
  dataService.getColumns = async () => [
    ["Value", "DOUBLE"],
    ["Group", "VARCHAR"],
    ["Subject", "VARCHAR"],
  ];
  return (
    <HypothesisTestDialog
      mode="create"
      dataset={dialogDataset}
      defaultName="Hypothesis Test 1"
      onCancel={() => {}}
      onSubmit={() => {}}
    />
  );
}