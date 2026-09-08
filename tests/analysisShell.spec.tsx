import { expect, test } from "@playwright/experimental-ct-react";

import { AnalysisShellHarness } from "./AnalysisShellHarness";

test("AnalysisShell standardizes title, committed inputs, and result layout", async ({ mount }) => {
  const component = await mount(<AnalysisShellHarness />);

  await expect(component).toHaveClass("analysis-shell");
  await expect(component.locator(".analysis-shell-titlebar")).toHaveText("DIM1 Analysis");
  await expect(component.locator(".analysis-shell-source")).toContainText("Source");
  await expect(component.locator(".analysis-shell-source")).toContainText("DIM1 Sample");
  await expect(component.locator(".analysis-shell-summary-row")).toHaveCount(3);
  await expect(component.getByTestId("analysis-results")).toBeVisible();

  await component.getByRole("button", { name: "Edit Inputs" }).click();
  await expect(component.getByTestId("edit-count")).toHaveText("1");
});

test("AnalysisShell disables input editing when the host forbids mutation", async ({ mount }) => {
  const component = await mount(<AnalysisShellHarness disabled />);

  await expect(component.getByRole("button", { name: "Edit Inputs" })).toBeDisabled();
  await expect(component.getByTestId("edit-count")).toHaveText("0");
});