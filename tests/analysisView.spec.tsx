import assert from "node:assert/strict";

import { expect, test } from "@playwright/experimental-ct-react";
import type { Locator } from "@playwright/test";

import { AnalysisExecutionHarness } from "./AnalysisExecutionHarness";
import { AnalysisGraphVisualHarness } from "./AnalysisGraphVisualHarness";
import { AnalysisViewHarness } from "./AnalysisViewHarness";

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
  await expect(component.locator("[data-analysis-block='graph']")).toHaveCount(3);
  await expect(component.locator("[data-analysis-block='graph']").first()).toHaveClass(/analysis-ui-frame/);
  await expect(component.locator("[data-analysis-block='tables']")).toHaveClass("analysis-ui-frame");
  await expect(component.locator("[data-analysis-block='process-capabilities']")).toHaveClass("analysis-ui-frame");
  await expect(component.locator(".analysis-ui-graph")).toHaveCount(3);
  await expect(component.locator(".analysis-ui-graph-runtime")).toHaveCount(3);
  await expect(component.locator("[data-graph-role='distributionComposite']")).toHaveCount(1);
  await expect(component.locator("[data-graph-role='ecdf']")).toHaveCount(1);
  await expect(component.locator("[data-graph-role='summaryRange']")).toHaveCount(1);
  await expect(component.locator("[data-graph-role='overview']")).toHaveCount(0);
  await expect(component.locator("[data-graph-role='boxPlot']")).toHaveCount(0);
  await expect(component.locator("[data-graph-role='distributionComposite']")).toHaveAttribute("data-graph-strategy", "builder");
  await expect(component.locator("[data-graph-role='ecdf']")).toHaveAttribute("data-graph-strategy", "builder-custom");
  await expect(component.locator("[data-graph-role='summaryRange']")).toHaveAttribute("data-graph-strategy", "custom");
  await expect(component.getByRole("img", { name: /five-number range/i })).toBeVisible();
  const summarySection = component.locator("[data-analysis-block='tables']");
  await expect(summarySection).toContainText("Quantiles");
  await expect(summarySection).toContainText("Location");
  await expect(summarySection).toContainText("Variation");
  await expect(summarySection).not.toContainText("Summary Statistics");
  await expect(summarySection.locator(".analysis-ui-table", { hasText: "Quantiles" }).locator("table")).toHaveCount(1);
  await expect(summarySection.locator(".analysis-ui-table", { hasText: "Location" }).locator("table")).toHaveCount(1);
  await expect(summarySection.locator(".analysis-ui-table", { hasText: "Variation" }).locator("table")).toHaveCount(1);
  await expect(summarySection.locator(".analysis-ui-table")).toHaveCount(3);
  await expect(component.locator(".analysis-table-frame")).toHaveCount(0);
  await expect(component.locator(".analysis-ui-text")).toHaveCSS("border-style", "none");
  assert.deepEqual(
    await component.locator("[data-analysis-document] > .analysis-ui-frame-body > .analysis-ui-stack > *")
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-analysis-block"))),
    ["graph", "graph", "graph", "text", "tables", "process-capabilities"],
  );
  await expect(component.getByRole("button", { name: "Quantiles" })).toBeVisible();
  await expect(firstValueCell).toBeVisible();
  await expect(originalMedianRow).toBeVisible();
  await expect(component.locator(".report-editor")).toHaveCount(0);
  await expect(component.getByText("Distribution graph:overview:ready:native")).toBeVisible();
  await expect(component.getByTestId("composite-element-kinds")).toHaveText("histogram,line,boxplot");
  await expect(component.getByText("Distribution graph:ecdf:ready:custom-option")).toBeVisible();
  await expect(component.getByText("definition:unchanged")).toBeVisible();
  await expect(component.getByText("compute-calls:1")).toBeVisible();
  await expect(component.getByText(/generation-calls:[1-9]\d*/)).toBeVisible();

  await component.getByRole("button", { name: "Summary Statistical" }).click();
  await expect(component.getByRole("button", { name: "Summary Statistical" })).toHaveAttribute("aria-expanded", "false");
  await expect(component.getByRole("button", { name: "Quantiles" })).toHaveCount(0);
  await expect(component.locator("[data-graph-role='distributionComposite']")).toHaveCount(1);
  await expect(component.getByRole("button", { name: "Process Capabilities" })).toHaveAttribute("aria-expanded", "true");
  await component.getByRole("button", { name: "Summary Statistical" }).click();

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
  await expect(component.getByText("compute-calls:0")).toBeVisible();
  await expect(component.getByText("generation-calls:0")).toBeVisible();
  await expect(component.getByText(/Distribution graph:/)).toHaveCount(0);
});

test("builder-backed Analysis graphs open axis settings from both axes", async ({ mount }) => {
  const component = await mount(<AnalysisViewHarness />);

  for (const role of ["overview", "ecdf"] as const) {
    for (const axis of ["X", "Y"] as const) {
      await component.getByRole("button", { name: `Open ${role} ${axis} axis` }).click();
      await expect(component.locator(".sp-dialog-title")).toHaveText(`${axis} Axis Settings`);
      await component.getByRole("button", { name: "Done" }).click();
    }
  }
});

test("Analysis axis settings update the selected persisted graph config", async ({ mount }) => {
  const component = await mount(<AnalysisViewHarness />);

  await component.getByRole("button", { name: "Open overview X axis" }).click();
  await component.getByLabel("Min").fill("80");
  await expect(component.getByTestId("overview-x-min")).toHaveText("80");
  await expect(component.getByTestId("ecdf-y-min")).toHaveText("auto");
  await component.getByRole("button", { name: "Done" }).click();

  await component.getByRole("button", { name: "Open ecdf Y axis" }).click();
  await component.getByLabel("Min").fill("0.1");
  await expect(component.getByTestId("ecdf-y-min")).toHaveText("0.1");
  await expect(component.getByTestId("overview-x-min")).toHaveText("80");
});

test("renders three non-overlapping graph strategies with painted canvases and pan mode", async ({ mount, page }) => {
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.stack ?? error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  const component = await mount(<AnalysisGraphVisualHarness />);
  const frames = component.locator(".analysis-ui-graph");
  const compositeCanvas = component.locator("[data-graph-role='distributionComposite'] canvas");
  const ecdfCanvas = component.locator("[data-graph-role='ecdf'] canvas");

  await expect.poll(() => browserErrors, { message: "AnalysisView must mount without browser errors" }).toEqual([]);
  await expect(page.getByTestId("visual-error")).toHaveCount(0);
  await expect(frames).toHaveCount(3);
  await expect(compositeCanvas).toHaveCount(1);
  await expect(ecdfCanvas).toHaveCount(1);
  await expect(component.getByRole("img", { name: /five-number range/i })).toBeVisible();
  await expect.poll(() => paintedPixelCount(compositeCanvas)).toBeGreaterThan(1_000);
  await expect.poll(() => paintedPixelCount(ecdfCanvas)).toBeGreaterThan(500);

  const boxes = await frames.evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().toJSON()));
  assert.ok(boxes[0].bottom <= boxes[1].top && boxes[1].bottom <= boxes[2].top);

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
  await page.screenshot({ path: "test-results/analysis-three-graphs-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 480, height: 900 });
  await expect(frames).toHaveCount(3);
  await page.screenshot({ path: "test-results/analysis-three-graphs-mobile.png", fullPage: true });
});