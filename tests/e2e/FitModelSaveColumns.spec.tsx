import { expect, test } from "@playwright/experimental-ct-react";

import { FitModelSaveColumnsDialog } from "../../src/components/fitModel/FitModelSaveColumnsDialog";
import "../../src/components/fitModel/fitModel.css";
import type { FitModelFittedResult, FitModelSavedMetric } from "../../src/types/fitModel";

const result = {
  kind: "fitted",
  usedRows: 2,
  availableSavedMetrics: [
    "predicted",
    "residual",
    "studentizedResidual",
    "leverage",
    "cooksDistance",
  ],
  diagnostics: {
    rows: [
      {
        fitted: 10,
        residual: 1,
        studentizedResidual: 0.5,
        leverage: 0.2,
        cooksDistance: 0.1,
        meanConfidenceLower: null,
        meanConfidenceUpper: null,
        predictionLower: null,
        predictionUpper: null,
      },
    ],
  },
} as FitModelFittedResult;

test("defaults to available core metrics and disables unavailable intervals", async ({ mount }) => {
  let submitted: FitModelSavedMetric[] = [];
  const component = await mount(
    <FitModelSaveColumnsDialog
      open
      result={result}
      pending={false}
      error={null}
      onClose={() => undefined}
      onSave={(metrics) => { submitted = metrics; }}
    />,
  );

  const checkboxes = component.getByRole("checkbox");
  await expect(checkboxes).toHaveCount(9);
  await expect(checkboxes.nth(0)).toBeChecked();
  await expect(checkboxes.nth(4)).toBeChecked();
  await expect(checkboxes.nth(5)).toBeDisabled();
  await expect(checkboxes.nth(8)).toBeDisabled();

  await component.getByRole("button", { name: "Save", exact: true }).click();
  expect(submitted).toEqual([
    "predicted",
    "residual",
    "studentizedResidual",
    "leverage",
    "cooksDistance",
  ]);
});

test("locks controls and preserves errors while pending", async ({ mount }) => {
  const component = await mount(
    <FitModelSaveColumnsDialog
      open
      result={result}
      pending
      error="stale dataset generation"
      onClose={() => undefined}
      onSave={() => undefined}
    />,
  );

  await expect(component.getByRole("alert")).toContainText("stale dataset generation");
  await expect(component.getByRole("button", { name: "Saving..." })).toBeDisabled();
  await expect(component.getByRole("button", { name: "Cancel" })).toBeDisabled();
  await expect(component.getByRole("checkbox").first()).toBeDisabled();
});

test("focuses the first metric, describes errors, and closes with Escape", async ({ mount, page }) => {
  let closeCount = 0;
  const component = await mount(
    <FitModelSaveColumnsDialog
      open
      result={result}
      pending={false}
      error="save failed"
      onClose={() => { closeCount += 1; }}
      onSave={() => undefined}
    />,
  );

  await expect(component.getByRole("checkbox").first()).toBeFocused();
  await expect(component.getByRole("dialog")).toHaveAttribute(
    "aria-describedby",
    "fit-model-save-columns-error",
  );
  await page.keyboard.press("Shift+Tab");
  await expect(component.getByRole("button", { name: "Save", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(component.getByRole("checkbox").first()).toBeFocused();
  await page.keyboard.press("Escape");
  expect(closeCount).toBe(1);
});
