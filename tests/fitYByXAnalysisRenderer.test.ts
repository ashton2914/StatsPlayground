import assert from "node:assert/strict";

import { createFitYByXAnalysisReportModel } from "../src/components/analysis/renderers/fitYByXAnalysisModel.ts";
import type { AnalysisExecutionState } from "../src/components/analysis/useAnalysisExecution.ts";
import type { FitYByXAnalysisDocument } from "../src/types/analysis.ts";
import type { FitYByXResponse, FitYByXResult } from "../src/types/fitYByX.ts";

const translate = (key: string, values?: Record<string, string | number | null | undefined>) => {
  if (key === "fitYByX.report.summaryOfFit.equationTemplate") {
    return `${values?.response} = ${values?.intercept} + ${values?.slope} * ${values?.factor}`;
  }
  return key;
};

const document: FitYByXAnalysisDocument = {
  schemaVersion: 1,
  documentType: "analysis",
  id: "fit-1",
  name: "Strength by Site",
  analysisKind: "fitYByX",
  configRevision: 1,
  source: { datasetId: "dataset-1" },
  definition: {
    kind: "fitYByX",
    response: { name: "Strength", type: "continuous" },
    factor: { name: "Site", type: "nominal" },
    personality: "oneway",
    confidenceLevel: 0.95,
  },
  presentation: {
    schemaVersion: 1,
    layout: "fit-y-by-x-v1",
    graph: {} as FitYByXAnalysisDocument["presentation"]["graph"],
  },
  createdAt: "2026-09-07T00:00:00.000Z",
  updatedAt: "2026-09-07T00:00:00.000Z",
};

function success(result: FitYByXResult): AnalysisExecutionState {
  const response: FitYByXResponse = {
    datasetId: "dataset-1",
    generation: 7,
    result,
  };
  return {
    status: "success",
    analysisKind: "fitYByX",
    analysisId: document.id,
    datasetId: "dataset-1",
    configRevision: 1,
    request: {
      datasetId: "dataset-1",
      generation: 7,
      responseColumn: "Strength",
      factorColumn: "Site",
      personality: result.kind === "notComputable" ? result.personality : result.kind,
      confidenceLevel: 0.95,
    },
    result: response,
  };
}

const bivariate = createFitYByXAnalysisReportModel({
  document: {
    ...document,
    definition: {
      ...document.definition,
      factor: { name: "Temperature", type: "continuous" },
      personality: "bivariate",
    },
  },
  state: success({
    kind: "bivariate",
    usedRows: 12,
    excludedRows: 1,
    confidenceLevel: 0.95,
    intercept: 1.25,
    slope: -0.5,
    summaryOfFit: {
      rSquared: 0.8,
      adjustedRSquared: 0.78,
      rootMeanSquareError: 0.2,
      meanOfResponse: 4.5,
      observationCount: 12,
    },
    lackOfFit: { state: "notIdentifiable" },
    anova: [{
      source: "Model",
      degreesOfFreedom: 1,
      sumOfSquares: 8,
      meanSquare: 8,
      fRatio: 16,
      pValue: 0.00001,
    }],
    parameterEstimates: [{
      term: "Intercept",
      estimate: 1.25,
      standardError: 0.1,
      tRatio: 12.5,
      pValue: 0.00001,
      lowerConfidenceLimit: 1,
      upperConfidenceLimit: 1.5,
    }],
  }),
  datasetMissing: false,
  translate,
});

assert.deepEqual(
  bivariate.sections.map((section) => section.key),
  ["summaryOfFit", "lackOfFit", "analysisOfVariance", "parameterEstimates"],
);
assert.equal(bivariate.summary.usedRows, "12");
assert.match(String(bivariate.sections[0]?.rows[0]?.cells[1]), /Strength = 1\.25 - 0\.5 \* Temperature/);
assert.equal(bivariate.sections[1]?.title, "Lack of Fit");
assert.equal(bivariate.sections[2]?.rows[0]?.cells[5], "<0.0001");

const oneway = createFitYByXAnalysisReportModel({
  document,
  state: success({
    kind: "oneway",
    usedRows: 9,
    excludedRows: 2,
    confidenceLevel: 0.95,
    groupSummaries: [{
      group: "A",
      count: 5,
      mean: 10,
      standardDeviation: 2,
      standardError: 1,
      lowerConfidenceLimit: 8,
      upperConfidenceLimit: 12,
    }],
    anova: [],
    effectSizes: { etaSquared: 0.25, omegaSquared: null },
  }),
  datasetMissing: false,
  translate,
});
assert.deepEqual(
  oneway.sections.map((section) => section.key),
  ["groupSummary", "analysisOfVariance", "effectSize"],
);
assert.equal(oneway.sections[2]?.rows[1]?.cells[1], "—");

const notComputable = createFitYByXAnalysisReportModel({
  document,
  state: success({
    kind: "notComputable",
    personality: "oneway",
    reason: "insufficientGroups",
    usedRows: 4,
    excludedRows: 3,
    confidenceLevel: 0.95,
  }),
  datasetMissing: false,
  translate,
});
assert.deepEqual(notComputable.sections.map((section) => section.key), ["notComputable"]);
assert.equal(notComputable.sections[0]?.rows[0]?.cells[1], "fitYByX.report.reason.insufficientGroups");

for (const [state, datasetMissing, expected] of [
  [{ status: "loading", analysisKind: "fitYByX", analysisId: "fit-1", datasetId: "dataset-1", configRevision: 1, request: null }, false, "loading"],
  [{ status: "error", analysisKind: "fitYByX", analysisId: "fit-1", datasetId: "dataset-1", configRevision: 1, request: null, error: "failed" }, false, "error"],
  [{ status: "idle" }, true, "sourceMissing"],
] as const) {
  const model = createFitYByXAnalysisReportModel({
    document,
    state: state as AnalysisExecutionState,
    datasetMissing,
    translate,
  });
  assert.deepEqual(model.sections.map((section) => section.key), [expected]);
  if (expected === "error") assert.equal(model.alert, true);
}

console.log("Fit Y by X Analysis renderer model contract passed");
