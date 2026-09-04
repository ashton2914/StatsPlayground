import { expect, test } from "@playwright/experimental-ct-react";

import { ReportBlock } from "../../src/components/distribution/DistributionReport";
import "../../src/components/distribution/distribution.css";
import type { DistributionFitDataV1, DistributionReportBlockV1 } from "../../src/types/distribution";

const metric = (value: number | null, reasonCode: string | null = null) => ({
  state: value === null ? "unavailable" as const : "available" as const,
  value,
  reasonCode,
});

const parameter = (parameterId: string, estimate: number, standardError = 0.1) => ({
  parameterId,
  estimate: metric(estimate),
  standardError: metric(standardError),
  lowerConfidence: metric(estimate - 1.959963984540054 * standardError),
  upperConfidence: metric(estimate + 1.959963984540054 * standardError),
});

const provenance = {
  methodId: "fit.normal.mle.v1",
  methodVersion: "1",
  parameterizationId: "normal.locationScale.v1",
  optimizerId: "closedForm",
  optimizerVersion: "1",
  initializationStrategyId: "closedForm",
  convergenceTolerance: 0,
  iterationLimit: 0,
  dependencyVersions: { statrs: "0.18.0" },
  computationId: "computation-1",
  candidateRegistryIds: ["normal" as const],
  compatibilityStatus: "compatibilityPending" as const,
};

const fit: DistributionFitDataV1 = {
  schemaVersion: "1",
  fitId: "fit-normal",
  distributionId: "normal",
  parameterizationId: "normal.locationScale.v1",
  status: "available",
  reasonCode: null,
  parameters: [
    parameter("location", 3),
    parameter("scale", 1.5),
  ],
  estimatedParameterCount: 2,
  effectiveN: 10,
  logLikelihood: metric(-12),
  aic: metric(28),
  aicc: metric(30),
  bic: metric(29),
  goodnessOfFit: [],
  fittedCurve: { schemaVersion: "1", points: [{ x: 0, y: 0.1 }, { x: 6, y: 0.1 }], provenance },
  diagnostics: [],
  convergence: {
    status: "converged",
    reasonCode: null,
    optimizerId: "closedForm",
    optimizerVersion: "1",
    iterations: 0,
    tolerance: 0,
  },
  provenance,
  warnings: [],
};

const block = (patch: Partial<DistributionReportBlockV1>): DistributionReportBlockV1 => ({
  schemaVersion: "1",
  blockId: "fit-block",
  kind: "continuousFit",
  titleKey: "distribution.report.continuousFit",
  status: "available",
  chartData: null,
  ...patch,
});

test("renders available Continuous Fit parameter estimates and JMP measures with complete grid lines", async ({ mount }) => {
  const component = await mount(<ReportBlock block={block({ distributionFitData: fit })} />);
  await expect(component.getByRole("heading", { name: "Continuous Fit - Normal" })).toBeVisible();
  await expect(component.getByRole("table", { name: "Normal Parameter Estimates" })).toBeVisible();
  const measures = component.getByRole("table", { name: "Normal measures" });
  await expect(measures).toBeVisible();
  await expect(component.getByText("Compatibility pending")).toBeVisible();
  await expect(component.getByText(/Convergence: Converged/)).toBeVisible();
  await expect(component.getByRole("columnheader", { name: "Estimate" })).toBeVisible();
  await expect(component.getByRole("columnheader", { name: "Std Error" })).toBeVisible();
  await expect(component.getByRole("columnheader", { name: "Lower 95%" })).toBeVisible();
  await expect(component.getByRole("columnheader", { name: "Upper 95%" })).toBeVisible();
  await expect(component.getByRole("rowheader", { name: "Location" })).toBeVisible();
  await expect(component.getByRole("rowheader", { name: "Dispersion" })).toBeVisible();
  await expect(measures.locator("tbody tr")).toHaveCount(3);
  await expect(measures.getByRole("row", { name: /-2 Log Likelihood/ })).toContainText("24");
  await expect(measures.getByRole("rowheader", { name: "AICc" })).toBeVisible();
  await expect(measures.getByRole("rowheader", { name: "BIC" })).toBeVisible();
  await expect(measures.getByRole("rowheader", { name: "AIC", exact: true })).toHaveCount(0);
  await expect(measures.getByRole("rowheader", { name: "LogLikelihood", exact: true })).toHaveCount(0);
  await expect(component.locator(".distribution-fit-table td").first()).toHaveCSS("border-right-style", "solid");
  await expect(component.locator(".distribution-fit-table td").first()).toHaveCSS("border-bottom-style", "solid");
});

test("uses model-specific parameter terminology without fixed location rows", async ({ mount }) => {
  const cases: Array<{
    data: DistributionFitDataV1;
    expectedRows: string[];
    note?: string;
  }> = [
    {
      data: {
        ...fit,
        fitId: "fit-lognormal",
        distributionId: "lognormal",
        parameterizationId: "lognormal.logLocationLogScale.v1",
        parameters: [
          parameter("logLocation", 2),
          parameter("logScale", 0.5),
        ],
      },
      expectedRows: ["Scale", "Shape"],
      note: "Parameters use the natural logarithm of the response.",
    },
    {
      data: {
        ...fit,
        fitId: "fit-exponential",
        distributionId: "exponential",
        parameterizationId: "exponential.scaleLocation0.v1",
        parameters: [
          parameter("scale", 3),
        ],
      },
      expectedRows: ["Scale"],
    },
    {
      data: {
        ...fit,
        fitId: "fit-gamma",
        distributionId: "gamma",
        parameterizationId: "gamma.shapeScale.location0.v1",
        parameters: [
          parameter("shape", 2),
          parameter("scale", 3),
        ],
      },
      expectedRows: ["Shape", "Scale"],
    },
    {
      data: {
        ...fit,
        fitId: "fit-weibull",
        distributionId: "weibull",
        parameterizationId: "weibull.shapeScale.location0.v1",
        parameters: [
          parameter("shape", 2),
          parameter("scale", 3),
        ],
      },
      expectedRows: ["Shape", "Scale"],
    },
  ];

  for (const candidate of cases) {
    const component = await mount(<ReportBlock block={block({ distributionFitData: candidate.data })} />);
    const table = component.getByRole("table", { name: new RegExp(`${candidate.data.distributionId} Parameter Estimates`, "i") });
    for (const rowName of candidate.expectedRows) {
      await expect(table.getByRole("row", { name: new RegExp(rowName) })).toBeVisible();
    }
    if (["exponential", "gamma", "weibull"].includes(candidate.data.distributionId)) {
      await expect(table.getByRole("rowheader", { name: "Location" })).toHaveCount(0);
    }
    if (candidate.note) await expect(component.getByText(candidate.note)).toBeVisible();
    await component.unmount();
  }
});

test("preserves unavailable log likelihood state in Measures", async ({ mount }) => {
  const component = await mount(<ReportBlock block={block({
    distributionFitData: {
      ...fit,
      logLikelihood: metric(null, "distribution.fit.informationCriteriaInvalid.v1"),
    },
  })} />);
  const measures = component.getByRole("table", { name: "Normal measures" });
  await expect(measures.getByRole("row", { name: /-2 Log Likelihood/ }))
    .toContainText("distribution.fit.informationCriteriaInvalid.v1");
});

test("keeps the estimate visible when parameter inference is unavailable", async ({ mount }) => {
  const reasonCode = "distribution.fit.parameterInformationSingular.v1";
  const component = await mount(<ReportBlock block={block({
    distributionFitData: {
      ...fit,
      parameters: [{
        parameterId: "location",
        estimate: metric(3),
        standardError: metric(null, reasonCode),
        lowerConfidence: metric(null, reasonCode),
        upperConfidence: metric(null, reasonCode),
      }],
      estimatedParameterCount: 1,
    },
  })} />);
  const row = component.getByRole("row", { name: /Location/ });
  await expect(row).toContainText("3");
  await expect(row).toContainText("Parameter inference is unavailable");
});

test("renders failed fit reason without a fake fit table", async ({ mount }) => {
  const failed: DistributionFitDataV1 = {
    ...fit,
    status: "failed",
    reasonCode: "distribution.fit.optimizerFailed.v1",
    parameters: [],
    fittedCurve: undefined,
    logLikelihood: metric(null, "distribution.fit.optimizerFailed.v1"),
    aic: metric(null, "distribution.fit.optimizerFailed.v1"),
    aicc: metric(null, "distribution.fit.optimizerFailed.v1"),
    bic: metric(null, "distribution.fit.optimizerFailed.v1"),
  };
  const component = await mount(<ReportBlock block={block({ status: "failed", distributionFitData: failed })} />);
  await expect(component.getByText(/Optimization failed/)).toBeVisible();
  await expect(component.locator(".distribution-fit-table")).toHaveCount(0);
  await expect(component.locator("canvas")).toHaveCount(0);
});

test("localizes convergence reasons and preserves unknown reason codes", async ({ mount }) => {
  const convergenceFailure: DistributionFitDataV1 = {
    ...fit,
    convergence: {
      ...fit.convergence,
      status: "failed",
      reasonCode: "distribution.fit.optimizerFailed.v1",
    },
  };
  const known = await mount(<ReportBlock block={block({ distributionFitData: convergenceFailure })} />);
  await expect(known.getByText(/Convergence: Failed \(Optimization failed\)/)).toBeVisible();
  await known.unmount();

  const unknownFailure: DistributionFitDataV1 = {
    ...fit,
    status: "failed",
    reasonCode: "distribution.fit.futureReason.v9",
    fittedCurve: undefined,
  };
  const unknown = await mount(<ReportBlock block={block({ status: "failed", distributionFitData: unknownFailure })} />);
  await expect(unknown.getByText(/distribution\.fit\.futureReason\.v9/)).toBeVisible();
});

test("renders Fit All comparison in backend row order", async ({ mount }) => {
  const component = await mount(<ReportBlock block={block({
    kind: "fitComparison",
    distributionFitComparisonData: {
      schemaVersion: "1",
      comparisonId: "comparison-1",
      candidateRegistryIds: ["normal", "gamma"],
      rows: [
        { distributionId: "normal", status: "available", reasonCode: null, aic: metric(28), aicc: metric(30), bic: metric(29) },
        { distributionId: "gamma", status: "failed", reasonCode: "distribution.fit.domain.v1", aic: metric(null), aicc: metric(null), bic: metric(null) },
      ],
    },
  })} />);
  const table = component.getByRole("table", { name: "Fit Comparison" });
  await expect(table.locator("tbody tr")).toHaveCount(2);
  await expect(table.locator("tbody tr").nth(0).locator("th")).toHaveText("Normal");
  await expect(table.locator("tbody tr").nth(1).locator("th")).toHaveText("Gamma");
  await expect(table.locator("tbody td").first()).toHaveCSS("border-right-style", "solid");
});
