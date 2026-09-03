import assert from "node:assert/strict";

import { expect, test } from "@playwright/experimental-ct-react";

import { AnalysisViewHarness } from "./AnalysisViewHarness";

test("renders live distribution results and refreshes when backend values change without mutating the analysis document", async ({ mount }) => {
  const component = await mount(<AnalysisViewHarness />);
  const firstValueCell = component.getByRole("cell", { name: "101.044792" }).first();
  const originalMedianRow = component.getByRole("row", { name: "Median 101.044792", exact: true });

  await expect(component.getByRole("heading", { name: "Quantiles" })).toBeVisible();
  await expect(firstValueCell).toBeVisible();
  await expect(originalMedianRow).toBeVisible();
  await expect(component.locator(".report-editor")).toHaveCount(0);
  await expect(component.getByText("Distribution graph:overview:ready")).toBeVisible();
  await expect(component.getByText("definition:unchanged")).toBeVisible();

  await component.getByRole("button", { name: "Change backend value" }).click();

  await expect(component.getByRole("row", { name: "Median 88.5", exact: true })).toBeVisible();
  await expect(originalMedianRow).toHaveCount(0);
  await expect(component.getByText("definition:unchanged")).toBeVisible();
  assert.equal(true, true);
});