import assert from "node:assert/strict";

import { expect, test } from "@playwright/experimental-ct-react";

import { AnalysisViewHarness } from "./AnalysisViewHarness";

test("configRevision-only changes fence stale results and force re-execution on the mounted AnalysisView path", async ({ mount }) => {
  const component = await mount(<AnalysisViewHarness />);
  const firstValueCell = component.getByRole("cell", { name: "101.044792" }).first();
  const originalMedianRow = component.getByRole("row", { name: "Median 101.044792", exact: true });

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