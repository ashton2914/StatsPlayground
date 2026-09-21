import { expect, test } from "@playwright/experimental-ct-react";

import { FitModelAnalysisReport } from "../../src/components/analysis/renderers/FitModelAnalysisReport";
import "../../src/components/fitModel/fitModel.css";
import type { FitModelReportState } from "../../src/components/fitModel/useFitModelReport";
import type { FitModelFittedResult, FitModelItem } from "../../src/types/fitModel";

const terms = [
  { termId: "A", kind: "main" as const, columnNames: ["A"], label: "A" },
];

const item: FitModelItem = {
  id: "fit-model-report-test",
  name: "Fit Model report test",
  sourceDatasetId: "dataset-1",
  response: { name: "Y", type: "continuous" },
  construct: { kind: "manual" },
  terms: [{ kind: "main", columnNames: ["A"] }],
  centeringMethod: "mean",
  createdAt: "2026-09-02T00:00:00.000Z",
};

const fittedResult: FitModelFittedResult = {
  kind: "fitted",
  usedRows: 12,
  excludedRows: 0,
  confidenceLevel: 0.95,
  responseColumn: "Y",
  predictorColumns: ["A"],
  terms,
  centering: { method: "mean", centers: [{ columnName: "A", mean: 6.5 }] },
  snapshot: {
    coefficientTermIds: ["Intercept", "A"],
    coefficients: [1, 2],
    covariance: [[0.1, 0], [0, 0.1]],
    meanSquareError: 1,
    errorDegreesOfFreedom: 10,
    confidenceLevel: 0.95,
    terms,
    centering: { method: "mean", centers: [{ columnName: "A", mean: 6.5 }] },
    predictorRanges: [{ columnName: "A", minimum: 1, maximum: 12, mean: 6.5 }],
  },
  diagnostics: {
    lackOfFit: {
      sumOfSquaresError: 10,
      sumOfSquaresPureError: 4,
      sumOfSquaresLackOfFit: 6,
      errorDegreesOfFreedom: 10,
      pureErrorDegreesOfFreedom: 4,
      lackOfFitDegreesOfFreedom: 6,
      meanSquarePureError: 1,
      meanSquareLackOfFit: 1,
      fRatio: 1,
      pValue: 0.5,
      reason: null,
    },
    featureVif: [{ termId: "A", termLabel: "A", value: 1.2, reason: null }],
    rows: [
      {
        rowIndex: 4,
        observed: 10,
        fitted: 8,
        residual: 2,
        studentizedResidual: 2.4,
        leverage: 0.5,
        cooksDistance: 0.4,
        meanConfidenceLower: 7,
        meanConfidenceUpper: 9,
        predictionLower: 5,
        predictionUpper: 11,
        flags: ["residualWarning", "highLeverage"],
      },
      {
        rowIndex: 9,
        observed: 12,
        fitted: 11.8,
        residual: 0.2,
        studentizedResidual: 0.2,
        leverage: 0.1,
        cooksDistance: 0.01,
        meanConfidenceLower: 11,
        meanConfidenceUpper: 12.5,
        predictionLower: 9,
        predictionUpper: 14,
        flags: [],
      },
    ],
    rowsSampled: true,
    sourceRowCount: 12,
    qqRows: [
      { rowIndex: 9, theoreticalQuantile: -0.67, studentizedResidual: -0.5 },
      { rowIndex: 4, theoreticalQuantile: 0.67, studentizedResidual: 0.8 },
    ],
    qqRowsSampled: true,
    qqSourceRowCount: 12,
    qqReason: null,
  },
  summaryOfFit: {
    rSquared: 0.9,
    adjustedRSquared: 0.89,
    rootMeanSquareError: 1,
    meanOfResponse: 10,
    observationCount: 12,
    modelDegreesOfFreedom: 1,
    errorDegreesOfFreedom: 10,
  },
  anova: [
    { source: "Model", degreesOfFreedom: 1, sumOfSquares: 90, meanSquare: 90, fRatio: 90, pValue: 0.0001 },
    { source: "Error", degreesOfFreedom: 10, sumOfSquares: 10, meanSquare: 1, fRatio: null, pValue: null },
  ],
  parameterEstimates: [
    { termId: "Intercept", termLabel: "Intercept", estimate: 1, standardError: 0.1, tRatio: 10, pValue: 0.001, lowerConfidenceLimit: 0.8, upperConfidenceLimit: 1.2 },
    { termId: "A", termLabel: "A", estimate: 2, standardError: 0.2, tRatio: 10, pValue: 0.001, lowerConfidenceLimit: 1.6, upperConfidenceLimit: 2.4 },
  ],
  effectTests: [
    { termId: "A", termLabel: "A", numberOfParameters: 1, degreesOfFreedom: 1, sumOfSquares: 90, fRatio: 90, pValue: 0.0001, reason: null },
    { termId: "B", termLabel: "B", numberOfParameters: 1, degreesOfFreedom: 1, sumOfSquares: 4, fRatio: 4, pValue: 0.08, reason: null },
  ],
  leveragePlots: [
    {
      termId: "A",
      termLabel: "A",
      pValue: 0.0001,
      points: [
        { rowIndex: 4, effectLeverage: -1, adjustedResponse: 8 },
        { rowIndex: 9, effectLeverage: 1, adjustedResponse: 12 },
      ],
      confidenceBand: [
        { effectLeverage: -1, fitted: 8, lower: 7, upper: 9 },
        { effectLeverage: 1, fitted: 12, lower: 11, upper: 13 },
      ],
      nullLineY: 10,
      rowsSampled: false,
      sourceRowCount: 12,
      reason: null,
    },
    {
      termId: "B",
      termLabel: "B",
      pValue: 0.08,
      points: [
        { rowIndex: 4, effectLeverage: -2, adjustedResponse: 7 },
        { rowIndex: 9, effectLeverage: 2, adjustedResponse: 13 },
      ],
      confidenceBand: [
        { effectLeverage: -2, fitted: 7, lower: 6, upper: 8 },
        { effectLeverage: 2, fitted: 13, lower: 12, upper: 14 },
      ],
      nullLineY: 10,
      rowsSampled: false,
      sourceRowCount: 12,
      reason: null,
    },
  ],
  plotRows: [
    { rowIndex: 4, observed: 10, fitted: 8, residual: 2 },
    { rowIndex: 9, observed: 12, fitted: 11.8, residual: 0.2 },
  ],
  plotRowsSampled: false,
  warnings: [],
};

const state: FitModelReportState = {
  status: "success",
  result: fittedResult,
  error: null,
  configurationKey: "fit-model-report-test",
};

function report(callbacks: {
  onAddEffect?: () => void;
  onRemoveTerm?: (termId: string) => void;
} = {}, result: FitModelFittedResult = fittedResult) {
  const reportState: FitModelReportState = {
    ...state,
    result,
    configurationKey: result.effectTests.map((effect) => effect.termId).join("|"),
  };
  return (
    <div style={{ width: "100%", height: "100vh", minWidth: 0 }}>
      <FitModelAnalysisReport
        item={item}
        state={reportState}
        datasetMissing={false}
        loadIssue={null}
        removeMessage={null}
        onAddEffect={callbacks.onAddEffect}
        onRemoveTerm={callbacks.onRemoveTerm ?? (() => undefined)}
        onUndoRemove={null}
      />
    </div>
  );
}

test("renders approved report order and effect interactions", async ({ mount }) => {
  const addCalls: string[] = [];
  const removeCalls: string[] = [];
  const component = await mount(report({
    onAddEffect: () => addCalls.push("add"),
    onRemoveTerm: (termId) => removeCalls.push(termId),
  }));
  const disclosureButtons = component.locator(
    "[data-fit-model-analysis-report] .analysis-ui-frame-title",
  );
  await expect(disclosureButtons).toHaveCount(13);
  const sectionTitles = await disclosureButtons.allTextContents();
  expect(sectionTitles.map((title) => title.replace(/^[▾▸]\s*/u, "").trim())).toEqual([
    "Model Specification",
    "Leverage Plot",
    "Actual by Predicted",
    "Effect Summary",
    "Lack of Fit",
    "Residual by Predicted",
    "Summary of Fit",
    "Analysis of Variance",
    "Parameter Estimates",
    "Effect Tests",
    "Row Diagnostics",
    "Prediction Profiler",
    "Warnings",
  ]);
  const reportBlocks = component.locator("[data-fit-model-analysis-report] > [data-analysis-block]");
  for (const blockIndex of [3, 10]) {
    const frame = reportBlocks.nth(blockIndex);
    await expect(frame).toHaveCount(1);
    await expect(frame.locator(".analysis-ui-frame")).toHaveCount(0);
  }
  await expect(component.getByRole("button", { name: "Residual Q-Q" })).toHaveCount(0);
  await expect(component.locator('[data-chart-kind="residualQq"]')).toHaveCount(0);
  await expect(component.getByText("Mean of Response", { exact: true })).toBeVisible();
  await expect(component.getByText("Observations", { exact: true })).toBeVisible();
  await expect(
    component.getByRole("table", { name: "Parameter Estimates" }).locator("thead th"),
  ).toHaveText(["Term", "Estimate", "Std Error", "t Ratio", "Feature VIF"]);

  await component.getByRole("button", { name: "Add" }).click();
  expect(addCalls).toEqual(["add"]);
  await component.getByRole("button", { name: "Remove" }).click();
  expect(removeCalls).toEqual(["A"]);
  const leverageSelector = component.getByLabel("Effect", { exact: true });
  await leverageSelector.selectOption("B");
  await expect(leverageSelector).toHaveValue("B");
  await expect(component.locator('[data-chart-kind="leveragePlot"]')).toHaveCount(1);

  const rowDiagnostics = component.getByRole("button", { name: "Row Diagnostics" });
  await expect(rowDiagnostics).toHaveAttribute("aria-expanded", "true");
  await rowDiagnostics.click();
  await expect(rowDiagnostics).toHaveAttribute("aria-expanded", "false");
  await rowDiagnostics.click();

  const rows = component.getByRole("table", { name: "Row Diagnostics" }).locator("tbody tr");
  await expect(rows).toHaveCount(2);
  await component.locator('[data-diagnostic-filter="flagged"]').click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Residual warning");
});

test("reconciles leverage selection after refit and renders non-estimable reason without a chart", async ({ mount }) => {
  const component = await mount(report());
  const leverageSelector = component.getByLabel("Effect", { exact: true });
  await leverageSelector.selectOption("B");
  await expect(leverageSelector).toHaveValue("B");

  const withoutB: FitModelFittedResult = {
    ...fittedResult,
    effectTests: fittedResult.effectTests.filter((effect) => effect.termId !== "B"),
    leveragePlots: fittedResult.leveragePlots.filter((plot) => plot.termId !== "B"),
  };
  await component.update(report({}, withoutB));
  await expect(component.getByLabel("Effect", { exact: true })).toHaveValue("A");
  await expect(component.locator('[data-chart-kind="leveragePlot"]')).toHaveCount(1);

  const mixedEstimability: FitModelFittedResult = {
    ...fittedResult,
    leveragePlots: fittedResult.leveragePlots.map((plot) => plot.termId === "A"
      ? { ...plot, reason: "inferenceNotEstimable" }
      : plot),
  };
  await component.update(report({}, mixedEstimability));
  await expect(component.getByLabel("Effect", { exact: true })).toHaveValue("B");
  await component.getByLabel("Effect", { exact: true }).selectOption("A");
  await expect(component.locator('[data-chart-kind="leveragePlot"]')).toHaveCount(0);
  await expect(component.getByText(/not estimable/i).last()).toBeVisible();

  const allNonEstimable: FitModelFittedResult = {
    ...fittedResult,
    effectTests: [{
      ...fittedResult.effectTests[0],
      pValue: 0.0001,
      reason: "inferenceNotEstimable",
    }],
    leveragePlots: [{
      ...fittedResult.leveragePlots[0],
      pValue: 0.0001,
      reason: "inferenceNotEstimable",
    }],
  };
  await component.update(report({}, allNonEstimable));
  await expect(component.locator('[data-chart-kind="leveragePlot"]')).toHaveCount(0);
  await expect(component.getByText(/not estimable/i).last()).toBeVisible();
});

for (const viewport of [
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
]) {
  test(`renders diagnostics without page overflow at ${viewport.width}x${viewport.height}`, async ({ mount, page }) => {
    await page.setViewportSize(viewport);
    const component = await mount(report());
    const matchedChartBoxes = await component.locator(
      '[data-chart-kind="actualByPredicted"], [data-chart-kind="leveragePlot"]',
    ).evaluateAll((elements) => elements.map((element) => {
      const frame = element.closest<HTMLElement>(".analysis-ui-frame");
      return {
        width: frame?.getBoundingClientRect().width ?? 0,
        chartHeight: element.getBoundingClientRect().height,
      };
    }));
    expect(matchedChartBoxes).toHaveLength(2);
    if (viewport.width >= 1000) {
      expect(Math.abs(matchedChartBoxes[0].width - matchedChartBoxes[1].width)).toBeLessThanOrEqual(2);
      expect(Math.abs(matchedChartBoxes[0].chartHeight - matchedChartBoxes[1].chartHeight)).toBeLessThanOrEqual(2);
    }
    const chartBoxes = await component.locator('[data-chart-kind="actualByPredicted"], [data-chart-kind="residualByPredicted"]').evaluateAll((elements) => elements.map((element) => {
      const box = element.getBoundingClientRect();
      const frame = element.closest<HTMLElement>(".analysis-ui-frame");
      const frameBox = frame?.getBoundingClientRect();
      return {
        kind: element.getAttribute("data-chart-kind"),
        width: box.width,
        height: box.height,
        frameWidth: frameBox?.width ?? 0,
        nestedFrameCount: frame?.querySelectorAll(".analysis-ui-frame").length ?? 0,
      };
    }));
    expect(chartBoxes).toHaveLength(2);
    if (viewport.width >= 1000) {
      const residual = chartBoxes.find((entry) => entry.kind === "residualByPredicted");
      expect(residual?.width ?? 0).toBeGreaterThan(680);
      expect(residual?.width ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(820);
      expect(residual?.width ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(residual?.frameWidth ?? 0);
      for (const chart of chartBoxes) {
        expect(chart.nestedFrameCount).toBe(0);
      }
    }

    const profiler = component.locator('[data-graph-role="predictionProfiler"]');
    const profilerGeometry = await profiler.evaluate((element) => {
      const frame = element.closest<HTMLElement>(".analysis-ui-frame");
      const content = element.querySelector<HTMLElement>(".sp-fit-model-profiler");
      return {
        frameWidth: frame?.getBoundingClientRect().width ?? 0,
        contentWidth: content?.getBoundingClientRect().width ?? 0,
      };
    });
    if (viewport.width >= 1000) {
      expect(profilerGeometry.contentWidth).toBeGreaterThanOrEqual(480);
      expect(Math.abs(profilerGeometry.frameWidth - profilerGeometry.contentWidth)).toBeLessThanOrEqual(2);
    }

    const overflow = await page.evaluate(() => ({
      amount: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      offenders: Array.from(document.querySelectorAll<HTMLElement>("body *"))
        .filter((element) => element.getBoundingClientRect().right > document.documentElement.clientWidth + 1)
        .slice(0, 8)
        .map((element) => {
          const style = getComputedStyle(element);
          return {
            className: element.className,
            right: element.getBoundingClientRect().right,
            width: style.width,
            minWidth: style.minWidth,
          };
        }),
      ancestors: (() => {
        const rows: Array<Record<string, unknown>> = [];
        let element: HTMLElement | null = document.querySelector('table[aria-label="Row Diagnostics"]');
        while (element) {
          const style = getComputedStyle(element);
          rows.push({
            tag: element.tagName,
            className: element.className,
            clientWidth: element.clientWidth,
            scrollWidth: element.scrollWidth,
            overflowX: style.overflowX,
          });
          element = element.parentElement;
        }
        return rows;
      })(),
      scrollX: (() => {
        window.scrollTo({ left: document.documentElement.scrollWidth, behavior: "instant" });
        const value = window.scrollX;
        window.scrollTo({ left: 0, behavior: "instant" });
        return value;
      })(),
    }));
    expect(overflow.amount, JSON.stringify(overflow)).toBeLessThanOrEqual(1);
    for (const chart of matchedChartBoxes) {
      expect(chart.width).toBeLessThanOrEqual(viewport.width);
    }

    const blocks = component.locator("[data-fit-model-analysis-report] > *");
    const boxes = await blocks.evaluateAll((elements) => elements.map((element) => {
      const box = element.getBoundingClientRect();
      return { top: box.top, bottom: box.bottom };
    }));
    for (let index = 1; index < boxes.length; index += 1) {
      expect(boxes[index].top).toBeGreaterThanOrEqual(boxes[index - 1].bottom - 1);
    }
  });
}