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
      <FitModelAnalysisReport
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
  await expect(component.locator("[data-graph-strategy='custom']")).toHaveCount(4);
  await expect(component.getByRole("button", { name: "Residual Q-Q" })).toHaveCount(1);
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

    const chartBoxes = await component.locator('[data-chart-kind="actualByPredicted"], [data-chart-kind="residualByPredicted"], [data-chart-kind="residualQq"]').evaluateAll((elements) => elements.map((element) => {
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
    expect(chartBoxes).toHaveLength(3);
    if (viewport.width >= 1000) {
      for (const chart of chartBoxes.filter((entry) => entry.kind !== "residualQq")) {
        expect(chart.width).toBeLessThanOrEqual(680);
        expect(Math.abs(chart.frameWidth - chart.width)).toBeLessThanOrEqual(2);
      }
      const qq = chartBoxes.find((entry) => entry.kind === "residualQq");
      expect(qq?.width ?? 0).toBeGreaterThanOrEqual(480);
      expect(qq?.width ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(560);
      expect(Math.abs((qq?.width ?? 0) - (qq?.height ?? 0))).toBeLessThanOrEqual(80);
      expect(Math.abs((qq?.frameWidth ?? 0) - (qq?.width ?? 0))).toBeLessThanOrEqual(2);
      expect(qq?.nestedFrameCount).toBe(0);
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