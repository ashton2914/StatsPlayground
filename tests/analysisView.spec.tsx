import assert from "node:assert/strict";

import { expect, test } from "@playwright/experimental-ct-react";

import { AnalysisExecutionHarness } from "./AnalysisExecutionHarness";
import { AnalysisViewHarness } from "./AnalysisViewHarness";

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

  await expect(component.locator(".analysis-workspace")).toHaveCount(1);
  await expect(component.locator(".analysis-info-panel")).toContainText("Strength Distribution");
  await expect(component.locator(".analysis-frame", { hasText: "Graph" })).toHaveCount(1);
  await expect(component.locator(".analysis-graph-composite [data-graph-role='overview']")).toHaveCount(1);
  await expect(component.locator(".analysis-graph-composite [data-graph-role='boxPlot']")).toHaveCount(1);
  await expect(component.locator(".analysis-graph-composite [data-graph-role='ecdf']")).toHaveCount(0);
  await expect(component.locator(".analysis-graph-composite [data-graph-role='normalQuantile']")).toHaveCount(0);
  await expect(component.locator(".analysis-tables-grid")).toContainText("Quantiles");
  await expect(component.locator(".analysis-tables-grid")).toContainText("Summary Statistics");
  await expect(component.locator(".analysis-text-block")).toHaveCSS("border-style", "none");
  assert.deepEqual(
    await component.locator(".analysis-content-flow > *").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-analysis-block"))),
    ["graph", "text", "tables"],
  );
  await expect(component.getByRole("heading", { name: "Quantiles" })).toBeVisible();
  await expect(firstValueCell).toBeVisible();
  await expect(originalMedianRow).toBeVisible();
  await expect(component.locator(".report-editor")).toHaveCount(0);
  await expect(component.getByText("Distribution graph:overview:ready")).toBeVisible();
  await expect(component.getByText("definition:unchanged")).toBeVisible();
  await expect(component.getByText("compute-calls:1")).toBeVisible();
  await expect(component.getByText(/generation-calls:[1-9]\d*/)).toBeVisible();

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