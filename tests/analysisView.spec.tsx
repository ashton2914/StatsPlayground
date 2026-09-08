import assert from "node:assert/strict";

import { expect, test } from "@playwright/experimental-ct-react";
import type { Locator } from "@playwright/test";

import { AnalysisExecutionHarness } from "./AnalysisExecutionHarness";
import { AnalysisGraphVisualHarness } from "./AnalysisGraphVisualHarness";
import { AnalysisViewHarness, FitYByXAnalysisViewHarness } from "./AnalysisViewHarness";

async function paintedPixelCount(canvas: Locator) {
  return canvas.evaluate((node) => {
    const context = (node as HTMLCanvasElement).getContext("2d");
    if (!context) return 0;
    const pixels = context.getImageData(0, 0, context.canvas.width, context.canvas.height).data;
    let painted = 0;
    for (let index = 3; index < pixels.length; index += 4) {
      if (pixels[index] > 0) painted += 1;
    }
    return painted;
  });
}

test("useAnalysisExecution masks stale success synchronously when configRevision changes", async ({ mount }) => {
  const component = await mount(<AnalysisExecutionHarness />);

  await expect(component.getByTestId("visible-state")).toContainText("1:success:101.044792");

  await component.getByRole("button", { name: "Bump config revision" }).click();

  await expect(component.getByTestId("visible-state")).toContainText("2:loading:");
  await expect(component.getByTestId("state-history")).not.toContainText("2:success:101.044792");
  await expect(component.getByText("compute-calls:2")).toBeVisible();

  await component.getByRole("button", { name: "Resolve pending response" }).click();

  await expect(component.getByTestId("visible-state")).toContainText("2:success:88.5");
  await expect(component.getByText("compute-calls:2")).toBeVisible();
});

test("configRevision-only changes fence stale results and force re-execution on the mounted AnalysisView path", async ({ mount }) => {
  const component = await mount(<AnalysisViewHarness />);
  const firstValueCell = component.getByRole("cell", { name: "101.044792" }).first();
  const originalMedianRow = component.getByRole("row", { name: "Median 101.044792", exact: true });

  await expect(component.locator(".analysis-workspace")).toHaveCount(0);
  await expect(component.locator(".analysis-shell")).toHaveCount(1);
  await expect(component.locator(".analysis-shell-titlebar")).toHaveText("Strength Distribution");
  await expect(component.locator(".analysis-shell-source")).toContainText("Incoming Data");
  await expect(component.locator(".analysis-shell-summary")).toContainText("DIM1");
  await expect(component.locator(".analysis-shell-summary")).toContainText("55 / 100 / 145");
  await component.getByRole("button", { name: "Edit Inputs" }).click();
  await expect(component.getByTestId("edit-inputs-calls")).toHaveText("1");
  await expect(component.locator("[data-analysis-document]")).toHaveClass("analysis-ui-frame");
  await expect(component.locator("[data-analysis-block='graph']")).toHaveCount(1);
  await expect(component.locator("[data-analysis-block='graph']").first()).toHaveClass(/analysis-ui-frame/);
  await expect(component.locator("[data-analysis-block='report']")).toHaveClass("analysis-ui-frame");
  await expect(component.locator(".analysis-ui-graph")).toHaveCount(1);
  await expect(component.locator(".analysis-ui-graph-runtime")).toHaveCount(1);
  await expect(component.locator("[data-graph-role='distributionComposite']")).toHaveCount(1);
  await expect(component.locator("[data-graph-role='ecdf']")).toHaveCount(0);
  await expect(component.locator("[data-graph-role='normalQuantile']")).toHaveCount(0);
  await expect(component.locator("[data-graph-role='overview']")).toHaveCount(0);
  await expect(component.locator("[data-graph-role='boxPlot']")).toHaveCount(0);
  await expect(component.locator("[data-graph-role='distributionComposite']")).toHaveAttribute("data-graph-strategy", "builder");
  await expect(component.getByRole("img", { name: /five-number range/i })).toHaveCount(0);
  const summarySection = component.locator("[data-analysis-block='report']");
  await expect(summarySection).toContainText("Quantiles");
  await expect(summarySection).toContainText("Location");
  await expect(summarySection).toContainText("Variation");
  await expect(summarySection.locator(".distribution-report-tree")).toHaveCount(0);
  await expect(summarySection.locator(".distribution-quantile-table")).toHaveCount(0);
  await expect(summarySection.locator(".distribution-summary-table")).toHaveCount(0);
  await expect(summarySection.locator(".analysis-ui-table")).toHaveCount(3);
  await expect(component.locator(".analysis-ui-text")).toHaveCSS("border-style", "none");
  assert.deepEqual(
    await component.locator("[data-analysis-document] > .analysis-ui-frame-body > .analysis-ui-stack > *")
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-analysis-block"))),
    ["graph", "text", "report"],
  );
  await expect(firstValueCell).toBeVisible();
  await expect(originalMedianRow).toBeVisible();
  await expect(component.locator(".report-editor")).toHaveCount(0);
  await expect(component.getByText("Distribution graph:overview:ready:native")).toBeVisible();
  await expect(component.getByTestId("composite-element-kinds")).toHaveText("histogram,normalCurve,boxplot");
  await expect(component.getByTestId("composite-packet-kinds")).toHaveText("histogram,precomputedCurve,boxPlot");
  await expect(component.getByText("Distribution graph:ecdf:ready:custom-option")).toHaveCount(0);
  await expect(component.getByText("Distribution graph:normalQuantile:ready:native")).toHaveCount(0);
  await expect(component.getByText("definition:unchanged")).toBeVisible();
  await expect(component.getByText("compute-calls:1")).toBeVisible();
  await expect(component.getByText(/generation-calls:[1-9]\d*/)).toBeVisible();

  await component.getByRole("button", { name: "Statistical Report" }).click();
  await expect(component.getByRole("button", { name: "Statistical Report" })).toHaveAttribute("aria-expanded", "false");
  await expect(component.locator(".distribution-quantile-table")).toHaveCount(0);
  await expect(component.locator("[data-graph-role='distributionComposite']")).toHaveCount(1);
  await component.getByRole("button", { name: "Statistical Report" }).click();

  await component.getByRole("button", { name: "Bump config revision" }).click();

  await expect(component.getByText("Loading report...")).toBeVisible();
  await expect(originalMedianRow).toHaveCount(0);
  await expect(component.getByText("compute-calls:2")).toBeVisible();
  await expect(component.getByText("definition:unchanged")).toBeVisible();

  await component.getByRole("button", { name: "Resolve pending response" }).click();

  await expect(component.getByRole("row", { name: "Median 88.5", exact: true })).toBeVisible();
  await expect(originalMedianRow).toHaveCount(0);
  assert.equal(true, true);
});

test("unsupported presentation schema does not invoke generation or compute services", async ({ mount }) => {
  const component = await mount(<AnalysisViewHarness mode="unsupportedPresentation" />);

  await expect(component.getByRole("alert")).toContainText("Unsupported analysis presentation.");
  await expect(component.getByRole("alert")).toHaveClass("analysis-ui-text");
  await expect(component.getByText("compute-calls:0")).toBeVisible();
  await expect(component.getByText("generation-calls:0")).toBeVisible();
  await expect(component.getByText(/Distribution graph:/)).toHaveCount(0);
});

test("builder-backed Analysis graphs open axis settings from both axes", async ({ mount }) => {
  const component = await mount(<AnalysisViewHarness />);

  for (const axis of ["X", "Y"] as const) {
    await component.getByRole("button", { name: `Open overview ${axis} axis` }).click();
    await expect(component.locator(".sp-dialog-title")).toHaveText(`${axis} Axis Settings`);
    await component.getByRole("button", { name: "Done" }).click();
  }
});

test("Analysis axis settings update the selected persisted graph config", async ({ mount }) => {
  const component = await mount(<AnalysisViewHarness />);

  await component.getByRole("button", { name: "Open overview X axis" }).click();
  await component.getByLabel("Min").fill("80");
  await expect(component.getByTestId("overview-x-min")).toHaveText("80");
  await component.getByRole("button", { name: "Done" }).click();
});

test("fits the painted Distribution graph without an internal vertical scroller", async ({ mount, page }) => {
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.stack ?? error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  const component = await mount(<AnalysisGraphVisualHarness />);
  const frames = component.locator(".analysis-ui-graph");
  const compositeCanvas = component.locator("[data-graph-role='distributionComposite'] canvas");

  await expect.poll(() => browserErrors, { message: "AnalysisView must mount without browser errors" }).toEqual([]);
  await expect(page.getByTestId("visual-error")).toHaveCount(0);
  await expect(frames).toHaveCount(1);
  await expect(compositeCanvas).toHaveCount(1);
  await expect.poll(() => paintedPixelCount(compositeCanvas)).toBeGreaterThan(1_000);
  await expect(frames).toHaveCSS("overflow-y", "visible");
  await expect(component.locator(".gc-graph")).toHaveCSS("overflow-y", "visible");
  const verticalMetrics = await component
    .locator(".analysis-graph-distribution, [data-graph-role='distributionComposite'], .gc-graph")
    .evaluateAll((nodes) => nodes.map((node) => ({
      clientHeight: node.clientHeight,
      scrollHeight: node.scrollHeight,
    })));
  assert.ok(verticalMetrics.every(({ clientHeight, scrollHeight }) => scrollHeight <= clientHeight + 1));

  await compositeCanvas.hover({ position: { x: 260, y: 120 } });
  await expect.poll(() => compositeCanvas.evaluate((node) => {
    let current: HTMLElement | null = (node as HTMLElement).parentElement;
    const cursors: string[] = [];
    while (current) {
      if (current.style.cursor) cursors.push(current.style.cursor);
      current = current.parentElement;
    }
    return cursors;
  })).toContain("grab");

  await page.mouse.move(0, 0);
  await page.screenshot({ path: "test-results/analysis-distribution-fit-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 480, height: 900 });
  await expect(frames).toHaveCount(1);
  await expect(component.locator(".gc-graph")).toHaveCSS("overflow-y", "visible");
  await page.screenshot({ path: "test-results/analysis-distribution-fit-mobile.png", fullPage: true });
});

test("Fit Y by X presentation changes do not recompute and definition changes mask stale success", async ({ mount }) => {
  const component = await mount(<AnalysisExecutionHarness analysisKind="fitYByX" />);

  await expect(component.getByTestId("visible-state")).toContainText("1:success:notComputable");
  await expect(component.getByText("compute-calls:1")).toBeVisible();

  await component.getByRole("button", { name: "Change graph presentation" }).click();
  await expect(component.getByTestId("visible-state")).toContainText("1:success:notComputable");
  await expect(component.getByText("compute-calls:1")).toBeVisible();

  await component.getByRole("button", { name: "Change confidence" }).click();
  await expect(component.getByTestId("visible-state")).toContainText("2:loading:");
  await expect(component.getByTestId("state-history")).not.toContainText("2:success:notComputable");
  await expect(component.getByText("compute-calls:2")).toBeVisible();

  await component.getByRole("button", { name: "Resolve pending response" }).click();
  await expect(component.getByTestId("visible-state")).toContainText("2:success:notComputable");
});

test("Fit Y by X renders through the synchronous Analysis view", async ({ mount }) => {
  const component = await mount(<FitYByXAnalysisViewHarness />);

  await expect(component.locator('[data-analysis-kind="fitYByX"]')).toBeVisible();
  await component.getByRole("button", { name: "Edit Inputs" }).click();
  await expect(component.getByTestId("fit-edit-inputs-calls")).toHaveText("1");
  await expect(component.locator('[data-analysis-block="graph"]')).toBeVisible();
  await expect(component.locator('[data-analysis-block="report"]')).toBeVisible();
  await expect(component.getByText("Fit Y by X graph:Strength by Site")).toBeVisible();
  await expect(component.getByRole("button", { name: "Group Summary" })).toBeVisible();
  await expect(component.getByRole("button", { name: "Analysis of Variance" })).toBeVisible();
  await expect(component.getByRole("button", { name: "Effect Size" })).toBeVisible();
});

test("Fit Y by X persists axis edits and reset zoom without recomputing", async ({ mount }) => {
  const component = await mount(<FitYByXAnalysisViewHarness />);

  await expect(component.getByTestId("fit-compute-calls")).toHaveText("1");
  for (const axis of ["X", "Y"] as const) {
    await component.getByRole("button", { name: `Open main ${axis} axis`, exact: true }).click();
    await expect(component.locator(".sp-dialog-title")).toHaveText(`${axis} Axis Settings`);
    if (axis === "X") {
      await component.getByLabel("Min").fill("6");
      await expect(component.getByTestId("fit-main-x-min")).toHaveText("6");
    }
    await component.getByRole("button", { name: "Done" }).click();
  }

  await component.getByRole("button", { name: "Zoom main X axis" }).click();
  await expect(component.getByTestId("fit-main-x-min")).toHaveText("4");
  await component.getByRole("button", { name: "Open main X axis menu" }).click();
  await component.getByText("Reset zoom", { exact: true }).click();
  await expect(component.getByTestId("fit-main-x-min")).toHaveText("auto");
  await expect(component.getByTestId("fit-compute-calls")).toHaveText("1");
});

test("Fit Y by X renders loading state", async ({ mount }) => {
  const component = await mount(<FitYByXAnalysisViewHarness mode="loading" />);
  await expect(component.getByText("Loading analysis results...")).toBeVisible();
});

test("Fit Y by X renders errors accessibly", async ({ mount }) => {
  const component = await mount(<FitYByXAnalysisViewHarness mode="error" />);
  await expect(component.getByRole("alert")).toContainText("fit failed");
});

test("Fit Y by X renders not-computable state", async ({ mount }) => {
  const component = await mount(<FitYByXAnalysisViewHarness mode="notComputable" />);
  await expect(component.getByText("Not computable")).toBeVisible();
  await expect(component.getByText("At least two non-empty groups are required for Oneway analysis.")).toBeVisible();
});

test("Fit Y by X renders source-missing graph and report states", async ({ mount }) => {
  const component = await mount(<FitYByXAnalysisViewHarness mode="sourceMissing" />);
  await expect(component.locator('[data-analysis-block="graph"]')).toContainText(/unavailable/i);
  await expect(component.locator('[data-analysis-block="report"]')).toContainText(/unavailable/i);
});