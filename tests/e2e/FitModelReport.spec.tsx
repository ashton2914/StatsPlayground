import { expect, test } from "@playwright/experimental-ct-react";

import { FitModelReport } from "../../src/components/fitModel/FitModelReport";
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

function report() {
  return (
    <div style={{ width: "100%", height: "100vh", minWidth: 0 }}>
      <FitModelReport
        item={item}
        state={state}
        datasetMissing={false}
        loadIssue={null}
        removeMessage={null}
        onRemoveTerm={() => undefined}
        onUndoRemove={null}
      />
    </div>
  );
}

test("toggles report sections and filters diagnostic rows", async ({ mount }) => {
  const component = await mount(report());
  const rowDiagnostics = component.getByRole("button", { name: "Row Diagnostics" });
  await expect(rowDiagnostics).toHaveAttribute("aria-expanded", "true");
  await rowDiagnostics.click();
  await expect(rowDiagnostics).toHaveAttribute("aria-expanded", "false");
  await rowDiagnostics.click();

  const rows = component.locator(".sp-fit-model-diagnostics-table tbody tr");
  await expect(rows).toHaveCount(2);
  await component.locator('[data-diagnostic-filter="flagged"]').click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Residual warning");
});

for (const viewport of [
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
]) {
  test(`renders diagnostics without page overflow at ${viewport.width}x${viewport.height}`, async ({ mount, page }) => {
    await page.setViewportSize(viewport);
    const component = await mount(report());
    const qqCanvas = component.locator('[data-chart-kind="residualQq"] canvas');
    await expect(qqCanvas).toBeVisible();
    await expect.poll(async () => qqCanvas.evaluate((canvas) => {
      const context = (canvas as HTMLCanvasElement).getContext("2d");
      if (!context) return 0;
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let visible = 0;
      for (let index = 3; index < pixels.length; index += 4) {
        if (pixels[index] > 0) visible += 1;
      }
      return visible;
    })).toBeGreaterThan(100);

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
        let element: HTMLElement | null = document.querySelector(".sp-fit-model-diagnostics-table");
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

    const sections = component.locator(".sp-fit-model-report-section");
    const boxes = await sections.evaluateAll((elements) => elements.map((element) => {
      const box = element.getBoundingClientRect();
      return { top: box.top, bottom: box.bottom };
    }));
    for (let index = 1; index < boxes.length; index += 1) {
      expect(boxes[index].top).toBeGreaterThanOrEqual(boxes[index - 1].bottom - 1);
    }
  });
}