import assert from "node:assert/strict";

import type {
  BlackBoxCaseV1,
  DistributionFitDiagnosticDataV1,
  DistributionChartDataV1,
  DistributionChartKindV1,
  DistributionContinuousFitConfigV1,
  DistributionFitCapabilityV1,
  DistributionFitComparisonDataV1,
  DistributionFitDataV1,
  DistributionReportResponse,
  DistributionRequest,
  DistributionResultStatus,
  ProcessCapabilityDataV1,
} from "../src/types/distribution.ts";
import {
  DISTRIBUTION_FIT_CAPABILITY_REGISTRY,
  createDefaultDistributionContinuousFitConfig,
  validateDistributionContinuousFitConfig,
} from "../src/components/distribution/distributionConfig.ts";

const chartKinds = [
  "histogramData",
  "boxPlotData",
  "normalQuantileData",
  "qqData",
  "ppData",
  "cdfData",
  "fittedCurveData",
  "diagnosticCoordinateData",
] as const satisfies readonly DistributionChartKindV1[];

assert.equal(new Set(chartKinds).size, 8);

const oneShotRequest: DistributionRequest = {
  datasetId: "dataset-1",
  generation: 7,
  responseColumns: ["value"],
  weightColumn: null,
  freqColumn: null,
  byColumns: ["batch"],
  confidenceLevel: 0.95,
  specLimits: {},
  fitDistributions: ["normal"],
};
assert.deepEqual(Object.keys(oneShotRequest), [
  "datasetId",
  "generation",
  "responseColumns",
  "weightColumn",
  "freqColumn",
  "byColumns",
  "confidenceLevel",
  "specLimits",
  "fitDistributions",
]);
const resultStatuses = [
  "available",
  "unavailable",
  "failed",
] as const satisfies readonly DistributionResultStatus[];
assert.deepEqual(resultStatuses, ["available", "unavailable", "failed"]);
type GraphRole = keyof DistributionReportResponse["graphFrames"];
const graphRoles = [
  "overview",
  "boxPlot",
  "ecdf",
  "normalQuantile",
] as const satisfies readonly GraphRole[];
assert.deepEqual(graphRoles, ["overview", "boxPlot", "ecdf", "normalQuantile"]);

const chartData: DistributionChartDataV1 = {
  kind: "histogramData",
  schemaVersion: "1",
  provenance: {
    methodId: "histogram-v1",
    methodVersion: "1.0.0",
    compatibilityStatus: "compatibilityPending",
    computationId: "distribution:sha256:test",
  },
  bins: [{ lower: 0, upper: 1, count: 3, probability: 1, density: 1 }],
};
assert.equal("observations" in chartData, false);

type CapabilityIntervalsContract = ProcessCapabilityDataV1["intervals"];
type Assert<T extends true> = T;
type ConfidenceLevelIsRequiredNumber = Assert<
  CapabilityIntervalsContract["confidenceLevel"] extends number
    ? undefined extends CapabilityIntervalsContract["confidenceLevel"]
      ? false
      : true
    : false
>;
type WithinEffectiveDfIsNullableNumber = Assert<
  CapabilityIntervalsContract["provenance"]["withinEffectiveDegreesOfFreedom"] extends number | null
    ? null extends CapabilityIntervalsContract["provenance"]["withinEffectiveDegreesOfFreedom"]
      ? true
      : false
    : false
>;
type StabilityIndexContract = ProcessCapabilityDataV1["processSummary"]["stabilityIndex"];
type StabilityIndexValueIsTyped = Assert<
  StabilityIndexContract["value"] extends ProcessCapabilityDataV1["indices"]["cp"] ? true : false
>;
type StabilityIndexMethodIsRequired = Assert<
  StabilityIndexContract["methodId"] extends string
    ? undefined extends StabilityIndexContract["methodId"]
      ? false
      : true
    : false
>;
const confidenceLevelContract: ConfidenceLevelIsRequiredNumber = true;
const withinEffectiveDfContract: WithinEffectiveDfIsNullableNumber = true;
const stabilityIndexValueContract: StabilityIndexValueIsTyped = true;
const stabilityIndexMethodContract: StabilityIndexMethodIsRequired = true;
assert.equal(confidenceLevelContract, true);
assert.equal(withinEffectiveDfContract, true);
assert.equal(stabilityIndexValueContract, true);
assert.equal(stabilityIndexMethodContract, true);

const continuousFit: DistributionContinuousFitConfigV1 = {
  enabledDistributionIds: ["normal", "gamma"],
  fitAll: false,
  diagnostics: {
    goodnessOfFit: false,
    qqPlot: false,
    cdfPlot: false,
    ppPlot: false,
  },
};
assert.deepEqual(continuousFit, {
  enabledDistributionIds: ["normal", "gamma"],
  fitAll: false,
  diagnostics: {
    goodnessOfFit: false,
    qqPlot: false,
    cdfPlot: false,
    ppPlot: false,
  },
});
assert.deepEqual(createDefaultDistributionContinuousFitConfig(), {
  enabledDistributionIds: [],
  fitAll: false,
  diagnostics: {
    goodnessOfFit: false,
    qqPlot: false,
    cdfPlot: false,
    ppPlot: false,
  },
});
assert.deepEqual(
  validateDistributionContinuousFitConfig({
    ...continuousFit,
    enabledDistributionIds: ["normal", "unknown" as never, "normal"],
  }),
  [
    {
      code: "distribution.config.unknownContinuousFitCapability",
      messageKey: "distribution.errors.unknownContinuousFitCapability",
      fieldPath: "continuousFit.enabledDistributionIds[1]",
    },
    {
      code: "distribution.config.duplicateContinuousFitCapability",
      messageKey: "distribution.errors.duplicateContinuousFitCapability",
      fieldPath: "continuousFit.enabledDistributionIds[2]",
    },
  ],
);

const fitCapabilities = DISTRIBUTION_FIT_CAPABILITY_REGISTRY.filter(
  (capability: DistributionFitCapabilityV1) => capability.implemented,
);
assert.deepEqual(
  fitCapabilities.map((capability) => capability.distributionId),
  ["normal", "lognormal", "exponential", "gamma", "weibull"],
);
assert.equal(
  fitCapabilities.every((capability) => capability.compatibilityStatus === "compatibilityPending"),
  true,
);

const fitData: DistributionFitDataV1 = {
  schemaVersion: "1",
  fitId: "fit-normal-1",
  distributionId: "normal",
  parameterizationId: "normal.locationScale.v1",
  status: "available",
  reasonCode: null,
  parameters: [
    {
      parameterId: "location",
      estimate: {
        state: "available",
        value: 1,
        reasonCode: null,
      },
      standardError: { state: "available", value: 0.1, reasonCode: null },
      lowerConfidence: { state: "available", value: 0.8040036, reasonCode: null },
      upperConfidence: { state: "available", value: 1.1959964, reasonCode: null },
    },
  ],
  estimatedParameterCount: 1,
  effectiveN: 1,
  logLikelihood: { state: "available", value: -1, reasonCode: null },
  aic: { state: "available", value: 4, reasonCode: null },
  aicc: { state: "available", value: 4, reasonCode: null },
  bic: { state: "available", value: 4, reasonCode: null },
  goodnessOfFit: [
    {
      testId: "andersonDarling",
      statistic: { state: "available", value: 0.1, reasonCode: null },
      pValue: { state: "available", value: 0.9, reasonCode: null },
      status: "available",
      reasonCode: null,
    },
  ],
  fittedCurve: {
    schemaVersion: "1",
    points: [{ x: 0, y: 0 }],
    provenance: {
      methodId: "fit.normal.mle",
      methodVersion: "1",
      parameterizationId: "normal.locationScale.v1",
      optimizerId: "closedForm",
      optimizerVersion: "1",
      initializationStrategyId: "closedForm",
      convergenceTolerance: 0,
      iterationLimit: 0,
      dependencyVersions: {},
      computationId: "distribution:sha256:test",
      candidateRegistryIds: ["normal"],
      compatibilityStatus: "compatibilityPending",
    },
  },
  diagnostics: [
    {
      diagnosticId: "qqPlot",
      status: "available",
      reasonCode: null,
    },
  ],
  convergence: {
    status: "converged",
    reasonCode: null,
    optimizerId: "closedForm",
    optimizerVersion: "1",
    iterations: 0,
    tolerance: 0,
    objective: 12.5,
    gradientNorm: null,
  },
  provenance: {
    methodId: "fit.normal.mle",
    methodVersion: "1",
    parameterizationId: "normal.locationScale.v1",
    optimizerId: "closedForm",
    optimizerVersion: "1",
    initializationStrategyId: "closedForm",
    convergenceTolerance: 0,
    iterationLimit: 0,
    dependencyVersions: {},
    computationId: "distribution:sha256:test",
    candidateRegistryIds: ["normal"],
    compatibilityStatus: "compatibilityPending",
  },
  warnings: [],
};
assert.equal(fitData.distributionId, "normal");

const fitDiagnosticWithoutChartData: DistributionFitDiagnosticDataV1 = {
  diagnosticId: "qqPlot",
  status: "available",
  reasonCode: null,
};
assert.equal("chartData" in fitDiagnosticWithoutChartData, false);

const fitDataWithoutFittedCurve: DistributionFitDataV1 = {
  schemaVersion: "1",
  fitId: "fit-normal-2",
  distributionId: "normal",
  parameterizationId: "normal.locationScale.v1",
  status: "available",
  reasonCode: null,
  parameters: [],
  estimatedParameterCount: 2,
  effectiveN: 0,
  logLikelihood: { state: "unavailable", value: null, reasonCode: null },
  aic: { state: "unavailable", value: null, reasonCode: null },
  aicc: { state: "unavailable", value: null, reasonCode: null },
  bic: { state: "unavailable", value: null, reasonCode: null },
  goodnessOfFit: [],
  diagnostics: [fitDiagnosticWithoutChartData],
  convergence: {
    status: "failed",
    reasonCode: null,
    optimizerId: "closedForm",
    optimizerVersion: "1",
    iterations: 0,
    tolerance: 0,
  },
  provenance: fitData.provenance,
  warnings: [],
};
assert.equal("fittedCurve" in fitDataWithoutFittedCurve, false);
assert.equal(fitData.convergence.objective, 12.5);
assert.equal(fitData.convergence.gradientNorm, null);
assert.equal("objective" in fitDataWithoutFittedCurve.convergence, false);
assert.equal("gradientNorm" in fitDataWithoutFittedCurve.convergence, false);

const fitComparison: DistributionFitComparisonDataV1 = {
  schemaVersion: "1",
  comparisonId: "fit-comparison-sales-1",
  candidateRegistryIds: ["normal", "gamma"],
  rows: [{
    distributionId: "normal",
    status: "available",
    reasonCode: null,
    aic: { state: "available", value: 4, reasonCode: null },
    aicc: { state: "available", value: 5, reasonCode: null },
    bic: { state: "available", value: 4.5, reasonCode: null },
  }],
};
assert.equal(fitComparison.rows[0].distributionId, "normal");
assert.deepEqual(fitComparison.candidateRegistryIds, ["normal", "gamma"]);

const invokeCalls: Array<{ command: string; args: unknown }> = [];
Object.assign(globalThis, {
  window: {
    __TAURI_INTERNALS__: {
      invoke: async (command: string, args: unknown = {}) => {
        invokeCalls.push({ command, args });
        if (command === "list_distribution_capabilities") return [];
        return undefined;
      },
    },
  },
});

const { distributionService } = await import("../src/services/distributionService.ts");
await distributionService.listCapabilities();
const blackBoxCase: BlackBoxCaseV1 = {
  schemaVersion: "1",
  caseId: "case.synthetic.1",
  actionId: "distribution.summary.v1",
  inputs: {},
  expected: [],
  observed: [{ kind: "numeric", outputId: "result.mean", value: 1 }],
  warnings: [],
  provenance: {
    sourceLedgerHash: `sha256:${"1".repeat(64)}`,
    inputHash: `sha256:${"2".repeat(64)}`,
    outputHash: `sha256:${"3".repeat(64)}`,
    toolVersion: "validator.v1",
    seed: "seed.synthetic.1",
    reviewArtifactHash: `sha256:${"4".repeat(64)}`,
  },
};
await distributionService.validateBlackBoxCase(blackBoxCase);

assert.deepEqual(invokeCalls, [
  { command: "list_distribution_capabilities", args: {} },
  {
    command: "validate_black_box_case",
    args: { case: blackBoxCase },
  },
]);

console.log("distribution contracts OK");