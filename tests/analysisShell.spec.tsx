import { expect, test } from "@playwright/experimental-ct-react";

import { AnalysisShellHarness } from "./AnalysisShellHarness";

function measuredWidth(box: { width: number } | null, label: string) {
  if (!box) {
    throw new Error(`${label} bounding box unavailable`);
  }

  return box.width;
}

function expectedSummaryMax(shellWidth: number) {
  return Math.round(Math.max(240, Math.min(480, shellWidth * 0.45)));
}

async function readStoredLayoutPreferences(page: { evaluate: <T>(pageFunction: () => T) => Promise<T> }) {
  return page.evaluate(() => {
    const raw = localStorage.getItem("sp-layout-preferences-v1");
    return raw ? JSON.parse(raw) : null;
  });
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.evaluate(() => {
    localStorage.clear();
  });
});

test("AnalysisShell standardizes title, committed inputs, and result layout", async ({ mount }) => {
  const component = await mount(<AnalysisShellHarness containerWidth={960} />);
  const shell = component.locator(".analysis-shell");
  const info = component.locator(".analysis-shell-info");

  await expect(shell).toHaveClass("analysis-shell");
  await expect(component.locator(".analysis-shell-titlebar")).toHaveText("DIM1 Analysis");
  await expect(component.locator(".analysis-shell-source")).toContainText("Source");
  await expect(component.locator(".analysis-shell-source")).toContainText("DIM1 Sample");
  await expect(component.locator(".analysis-shell-summary-row")).toHaveCount(3);
  await expect(component.getByTestId("analysis-results")).toBeVisible();
  await expect(component.getByTestId("results-ref-ready")).toHaveText("analysis-shell-results");
  await expect(info).toHaveCSS("border-right-width", "1px");

  const summaryWidth = measuredWidth(await component.locator(".analysis-shell-info").boundingBox(), "summary");
  const resultsWidth = measuredWidth(await component.getByTestId("analysis-results").boundingBox(), "results");
  const shellWidth = measuredWidth(await shell.boundingBox(), "shell");
  const maxSummaryWidth = expectedSummaryMax(shellWidth);
  expect(summaryWidth).toBeCloseTo(280, 0);
  expect(resultsWidth).toBeGreaterThan(640);

  const separator = component.getByRole("separator", { name: "Resize analysis summary panel" });
  await expect(separator).toHaveAttribute("aria-orientation", "vertical");
  await expect(separator).toHaveAttribute("aria-valuemin", "240");
  await expect(separator).toHaveAttribute("aria-valuemax", `${maxSummaryWidth}`);
  await expect(separator).toHaveAttribute("aria-valuenow", "280");

  await component.getByRole("button", { name: "Edit Inputs" }).click();
  await expect(component.getByTestId("edit-count")).toHaveText("1");
});

test("AnalysisShell resizes, persists analysis.summary, and clamps to 45 percent on remount", async ({ mount, page }) => {
  const component = await mount(<AnalysisShellHarness containerWidth={960} />);

  const separator = component.getByRole("separator", { name: "Resize analysis summary panel" });
  const summary = component.locator(".analysis-shell-info");
  const results = component.getByTestId("analysis-results");
  const separatorBox = await separator.boundingBox();

  if (!separatorBox) {
    throw new Error("separator bounding box unavailable");
  }

  await separator.hover();
  await page.mouse.down();
  await page.mouse.move(separatorBox.x + separatorBox.width / 2 + 140, separatorBox.y + separatorBox.height / 2);
  await page.mouse.up();

  await expect.poll(async () => Math.round(measuredWidth(await summary.boundingBox(), "summary"))).toBe(420);
  await expect(results).toBeVisible();
  await expect.poll(async () => readStoredLayoutPreferences(page)).toEqual({
    version: 1,
    sizes: {
      "analysis.summary": 420,
    },
  });

  await component.unmount();

  const remounted = await mount(<AnalysisShellHarness containerWidth={960} />);
  await expect.poll(async () => Math.round(measuredWidth(await remounted.locator(".analysis-shell-info").boundingBox(), "summary"))).toBe(420);

  await remounted.unmount();

  const wide = await mount(<AnalysisShellHarness containerWidth={1400} />);
  const wideSeparator = wide.getByRole("separator", { name: "Resize analysis summary panel" });
  await wideSeparator.press("End");
  await expect.poll(async () => Math.round(measuredWidth(await wide.locator(".analysis-shell-info").boundingBox(), "wide summary"))).toBe(480);
  await expect.poll(async () => readStoredLayoutPreferences(page)).toEqual({
    version: 1,
    sizes: {
      "analysis.summary": 480,
    },
  });

  await wide.unmount();

  const clamped = await mount(<AnalysisShellHarness containerWidth={960} />);
  const shellWidth = measuredWidth(await clamped.locator(".analysis-shell").boundingBox(), "shell");
  const maxSummaryWidth = expectedSummaryMax(shellWidth);
  const clampedSeparator = clamped.getByRole("separator", { name: "Resize analysis summary panel" });
  await expect.poll(async () => Math.round(measuredWidth(await clamped.locator(".analysis-shell-info").boundingBox(), "summary"))).toBe(maxSummaryWidth);
  await expect(clamped.getByTestId("analysis-results")).toBeVisible();
  await expect(clampedSeparator).toHaveAttribute("aria-valuemax", `${maxSummaryWidth}`);
  await expect(clampedSeparator).toHaveAttribute("aria-valuenow", `${maxSummaryWidth}`);
});

test("AnalysisShell disables input editing when the host forbids mutation", async ({ mount }) => {
  const component = await mount(<AnalysisShellHarness disabled />);

  await expect(component.getByRole("button", { name: "Edit Inputs" })).toBeDisabled();
  await expect(component.getByTestId("edit-count")).toHaveText("0");
});

test("AnalysisShell omits the desktop splitter at the existing narrow breakpoint", async ({ mount, page }) => {
  await page.setViewportSize({ width: 880, height: 900 });

  const component = await mount(<AnalysisShellHarness containerWidth={760} />);

  await expect(component.getByRole("separator", { name: "Resize analysis summary panel" })).toHaveCount(0);
  await expect(component.locator(".analysis-shell-info")).toBeVisible();
  await expect(component.getByTestId("analysis-results")).toBeVisible();
});

test("AnalysisShell uses compact layout when the shell container is narrow inside a wide viewport", async ({ mount, page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });

  const component = await mount(<AnalysisShellHarness containerWidth={860} />);

  await expect(component.getByRole("separator", { name: "Resize analysis summary panel" })).toHaveCount(0);

  const info = component.locator(".analysis-shell-info");
  const results = component.getByTestId("analysis-results");

  await expect(info).toBeVisible();
  await expect(results).toBeVisible();
  await expect(info).toHaveCSS("border-right-width", "0px");
  await expect(info).toHaveCSS("border-bottom-width", "1px");
  await expect(component.locator(".analysis-shell-results")).toHaveCSS("overflow-y", "visible");

  const infoBox = await info.boundingBox();
  const resultsBox = await results.boundingBox();

  if (!infoBox) throw new Error("analysis shell info bounding box unavailable");
  if (!resultsBox) throw new Error("analysis results bounding box unavailable");

  expect(infoBox.y).toBeLessThan(resultsBox.y);
  expect(resultsBox.y).toBeGreaterThan(infoBox.y + infoBox.height - 1);
  expect(resultsBox.width).toBeGreaterThan(800);
});