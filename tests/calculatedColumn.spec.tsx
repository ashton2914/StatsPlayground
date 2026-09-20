import { expect, test } from "@playwright/experimental-ct-react";

import { CalculatedColumnHarness } from "./CalculatedColumnHarness";

async function readSnapshot(page: import("@playwright/test").Page) {
  return page.evaluate(() => window.__calculatedColumnHarness?.getSnapshot());
}

async function setConfirmResult(page: import("@playwright/test").Page, value: boolean) {
  await page.evaluate((nextValue) => {
    window.__calculatedColumnHarness?.setConfirmResult(nextValue);
  }, value);
}

async function setClipboardText(page: import("@playwright/test").Page, value: string) {
  await page.evaluate((nextValue) => {
    window.__calculatedColumnHarness?.setClipboardText(nextValue);
  }, value);
}

async function bumpGeneration(page: import("@playwright/test").Page) {
  await page.evaluate(() => {
    window.__calculatedColumnHarness?.bumpGeneration();
  });
}

async function holdNextValidation(page: import("@playwright/test").Page) {
  await page.evaluate(() => {
    window.__calculatedColumnHarness?.holdNextValidation();
  });
}

async function resolveHeldValidation(page: import("@playwright/test").Page) {
  await page.evaluate(() => {
    window.__calculatedColumnHarness?.resolveHeldValidation();
  });
}

async function setLanguage(page: import("@playwright/test").Page, language: string) {
  await page.evaluate((nextLanguage) => {
    (window as Window & {
      __calculatedColumnHarness?: {
        setLanguage?: (value: string) => void;
      };
    }).__calculatedColumnHarness?.setLanguage?.(nextLanguage);
  }, language);
}

async function stageUndoRefresh(page: import("@playwright/test").Page) {
  await page.evaluate(() => {
    (window as Window & {
      __calculatedColumnHarness?: {
        stageHistoryRefresh?: (mode: "undo" | "redo") => void;
      };
    }).__calculatedColumnHarness?.stageHistoryRefresh?.("undo");
  });
}

async function stageRedoRefresh(page: import("@playwright/test").Page) {
  await page.evaluate(() => {
    (window as Window & {
      __calculatedColumnHarness?: {
        stageHistoryRefresh?: (mode: "undo" | "redo") => void;
      };
    }).__calculatedColumnHarness?.stageHistoryRefresh?.("redo");
  });
}

async function openColumnMenu(page: import("@playwright/test").Page, index: number) {
  await page.locator(`[data-col-hdr="${index}"]`).click({ button: "right" });
}

function formulaTextbox(page: import("@playwright/test").Page) {
  return page.getByRole("textbox", { name: "Formula" });
}

test("creates a calculated column from text and backend validation", async ({ mount, page }) => {
  await mount(<CalculatedColumnHarness scenario="matrix" />);

  await page.getByRole("button", { name: "Calculated Column" }).click();
  await expect(page.getByLabel("Output name")).toHaveValue("Calculated2");
  await formulaTextbox(page).fill("ROUND(Length * Width, 2)");
  await expect(page.getByText("Output type: DOUBLE")).toBeVisible();
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByRole("columnheader", { name: "Calculated2" })).toHaveAttribute("data-calculated", "ready");
  const snapshot = await readSnapshot(page);
  expect(snapshot?.upsertRequests).toHaveLength(1);
});

test("localizes validation exceptions without exposing raw backend payloads", async ({ mount, page }) => {
  await mount(<CalculatedColumnHarness scenario="matrix" />);

  await page.getByRole("button", { name: "Calculated Column" }).click();
  await formulaTextbox(page).fill("FORCE_VALIDATION_THROW()");

  await expect(page.getByRole("alert")).toContainText('Validation failed: Unexpected token near ")"');
  await expect(page.getByText(/validationFailed/)).toHaveCount(0);
  await expect(page.getByText(/safeMessage/)).toHaveCount(0);
  await expect(page.getByText(/backend parser crashed/)).toHaveCount(0);
});

test("announces calculated-column dialogs by mode-correct accessible role and name", async ({ mount, page }) => {
  await mount(<CalculatedColumnHarness scenario="matrix" />);

  await page.getByRole("button", { name: "Calculated Column" }).click();
  const createDialog = page.getByRole("dialog", { name: "Calculated Column" });
  await expect(createDialog).toBeVisible();
  await expect(createDialog).toHaveAttribute("aria-modal", "true");
  await createDialog.locator(".sp-calculated-column-actions").getByRole("button", { name: "Cancel" }).click();

  await openColumnMenu(page, 4);
  await page.getByText("Edit Formula").click();
  const editDialog = page.getByRole("dialog", { name: "Edit Formula" });
  await expect(editDialog).toBeVisible();
  await expect(editDialog).toHaveAttribute("aria-modal", "true");
  await editDialog.locator(".sp-calculated-column-actions").getByRole("button", { name: "Cancel" }).click();

  await openColumnMenu(page, 1);
  await page.getByText("Calculated Formula").click();
  const convertExistingDialog = page.getByRole("dialog", { name: "Calculated Formula" });
  await expect(convertExistingDialog).toBeVisible();
  await expect(convertExistingDialog).toHaveAttribute("aria-modal", "true");
  await convertExistingDialog.locator(".sp-calculated-column-actions").getByRole("button", { name: "Cancel" }).click();
});

test("localizes formula dependency diagnostics with detail and without raw backend code", async ({ mount, page }) => {
  await mount(<CalculatedColumnHarness scenario="matrix" />);

  await page.getByRole("button", { name: "Calculated Column" }).click();
  await setLanguage(page, "zh-CN");
  await page.getByLabel("公式").fill("USE_LOCKED_DEPENDENCY([Length])");

  await expect(page.getByText("依赖仍在使用")).toBeVisible();
  await expect(page.getByText('无法删除 "Length"，因为依赖路径 Area -> DoubleArea 仍在使用它。')).toBeVisible();
  await expect(page.getByText(/formula_dependency_in_use/i)).toHaveCount(0);
});

test("escapes bracketed column names from autocomplete entries", async ({ mount, page }) => {
  await mount(<CalculatedColumnHarness scenario="matrix" />);

  await page.getByRole("button", { name: "Calculated Column" }).click();
  await page.getByRole("textbox", { name: "Insert column or function" }).fill("Bracket ] Name");
  await page.getByRole("button", { name: /Bracket ] Name/ }).click();
  await expect(formulaTextbox(page)).toHaveValue("[Bracket ]] Name]");
});

test("converts an ordinary column in place with the stable column identity", async ({ mount, page }) => {
  await mount(<CalculatedColumnHarness scenario="matrix" />);

  await openColumnMenu(page, 1);
  await page.getByText("Calculated Formula").click();
  await expect(page.getByLabel("Output name")).toHaveValue("Width");
  await formulaTextbox(page).fill("ROUND([Length] * 10, 0)");
  await page.getByRole("button", { name: "Apply" }).click();
  const snapshot = await readSnapshot(page);
  expect(snapshot?.upsertRequests[0]).toMatchObject({
    outputColumnId: "width-id",
    formulaId: null,
    outputName: "Width",
  });
});

test("edits an existing calculated column and shows inferred type dependencies and downstream impact", async ({ mount, page }) => {
  await mount(<CalculatedColumnHarness scenario="matrix" />);

  await openColumnMenu(page, 4);
  await page.getByText("Edit Formula").click();
  await expect(page.getByLabel("Output name")).toHaveValue("Area");
  await expect(formulaTextbox(page)).toHaveValue("ROUND([Length] * [Width], 2)");
  await expect(page.getByText("Output type: DOUBLE")).toBeVisible();
  await expect(page.locator(".sp-calculated-column-chip", { hasText: "Length" })).toBeVisible();
  await expect(page.locator(".sp-calculated-column-chip", { hasText: "Width" })).toBeVisible();
  await expect(page.locator(".sp-calculated-column-chip", { hasText: "DoubleArea" })).toBeVisible();
  await formulaTextbox(page).fill("IF([Area] > 20, 1, 0)");
  await page.getByRole("button", { name: "Apply" }).click();
  const snapshot = await readSnapshot(page);
  expect(snapshot?.upsertRequests[0]).toMatchObject({
    outputColumnId: "area-id",
    formulaId: "formula-area",
  });
});

test("confirms before convert to values and cancels before IPC when declined", async ({ mount, page }) => {
  await mount(<CalculatedColumnHarness scenario="matrix" />);
  await setConfirmResult(page, false);

  await openColumnMenu(page, 4);
  await page.getByText("Convert to Values").click();
  const snapshot = await readSnapshot(page);
  expect(snapshot?.confirmMessages).toEqual(["Convert calculated column \"Area\" to values?"]);
  expect(snapshot?.convertRequests).toHaveLength(0);
});

test("confirms before convert to values and mutates only after confirmation", async ({ mount, page }) => {
  await mount(<CalculatedColumnHarness scenario="matrix" />);
  await setConfirmResult(page, true);

  await openColumnMenu(page, 4);
  await page.getByText("Convert to Values").click();
  const snapshot = await readSnapshot(page);
  expect(snapshot?.confirmMessages).toEqual(["Convert calculated column \"Area\" to values?"]);
  expect(snapshot?.convertRequests).toHaveLength(1);
  await expect(page.locator('[data-col-hdr="4"]')).not.toHaveAttribute("data-calculated", "ready");
});

test("parses dependency delete failures into localized action text without exposing the raw backend code", async ({ mount, page }) => {
  await mount(<CalculatedColumnHarness scenario="matrix" />);

  await openColumnMenu(page, 0);
  await page.getByText('Delete column "Length"').click();
  await expect(page.getByText('Cannot delete "Length" because the dependency path Area -> DoubleArea still uses it.')).toBeVisible();
  await expect(page.getByText("Area -> DoubleArea")).toBeVisible();
  await expect(page.getByText(/formula_dependency_in_use/i)).toHaveCount(0);
});

test("renders localized broken and unsupported calculated statuses", async ({ mount, page }) => {
  await mount(<CalculatedColumnHarness scenario="matrix" />);

  await expect(page.getByRole("columnheader", { name: "BrokenArea" })).toHaveAttribute("data-calculated", "broken");
  await expect(page.getByRole("columnheader", { name: "UnsupportedArea" })).toHaveAttribute("data-calculated", "unsupported");
  await expect(page.getByRole("columnheader", { name: "BrokenArea" })).toHaveAttribute("title", /Status: Broken/);
  await expect(page.getByRole("columnheader", { name: "UnsupportedArea" })).toHaveAttribute("title", /Status: Unsupported/);
});

test("normalizes renamed source columns after descriptor refresh", async ({ mount, page }) => {
  await mount(<CalculatedColumnHarness scenario="matrix" />);

  await page.evaluate(() => window.__calculatedColumnHarness?.renameWidthAndRefresh());
  await expect(page.getByRole("columnheader", { name: "Width Renamed" })).toBeVisible();
  await openColumnMenu(page, 4);
  await page.getByText("Edit Formula").click();
  await expect(formulaTextbox(page)).toHaveValue("ROUND([Length] * [Width Renamed], 2)");
});

test("preserves the draft on stale generation, offers revalidate, and only re-enables apply after validation matches the new generation", async ({ mount, page }) => {
  await mount(<CalculatedColumnHarness scenario="matrix" />);

  await page.getByRole("button", { name: "Calculated Column" }).click();
  await formulaTextbox(page).fill("ROUND([Length] * [Width], 2)");
  await expect(page.getByText("Output type: DOUBLE")).toBeVisible();
  const before = await readSnapshot(page);
  expect(before?.validateRequests.at(-1)?.expectedGeneration).toBe(7);
  const validationCountBeforeGenerationChange = before?.validateRequests.length ?? 0;
  await bumpGeneration(page);
  await expect(formulaTextbox(page)).toHaveValue("ROUND([Length] * [Width], 2)");
  await expect(page.getByText("Validation is stale because the table changed. Revalidate before applying.")).toBeVisible();
  await page.waitForTimeout(300);
  const stale = await readSnapshot(page);
  expect(stale?.validateRequests).toHaveLength(validationCountBeforeGenerationChange);
  await expect(page.getByRole("button", { name: "Apply" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Revalidate" })).toBeVisible();
  await page.getByRole("button", { name: "Revalidate" }).click();
  await expect(page.getByRole("button", { name: "Apply" })).toBeEnabled();
  const after = await readSnapshot(page);
  expect(after?.validateRequests.at(-1)?.formulaText).toBe("ROUND([Length] * [Width], 2)");
  expect(after?.validateRequests.at(-1)?.expectedGeneration).toBe(8);
});

test("keeps stale revalidation required when the draft changes during an explicit validation", async ({ mount, page }) => {
  await mount(<CalculatedColumnHarness scenario="matrix" />);

  await page.getByRole("button", { name: "Calculated Column" }).click();
  await formulaTextbox(page).fill("ROUND([Length] * [Width], 2)");
  await expect(page.getByRole("button", { name: "Apply" })).toBeEnabled();
  await bumpGeneration(page);
  await expect(page.getByRole("button", { name: "Revalidate" })).toBeVisible();

  await holdNextValidation(page);
  const beforeRevalidation = await readSnapshot(page);
  await page.getByRole("button", { name: "Revalidate" }).click();
  await expect.poll(async () => (await readSnapshot(page))?.validateRequests.length)
    .toBe((beforeRevalidation?.validateRequests.length ?? 0) + 1);

  await page.getByLabel("Output name").fill("Updated Calculation");
  await formulaTextbox(page).fill("ROUND([Length] + [Width], 2)");
  await resolveHeldValidation(page);

  const staleMessage = page.getByText("Validation is stale because the table changed. Revalidate before applying.");
  await expect(staleMessage).toBeVisible();
  await expect(page.getByRole("button", { name: "Revalidate" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Apply" })).toBeDisabled();

  await page.getByRole("button", { name: "Revalidate" }).click();
  await expect(page.getByRole("button", { name: "Apply" })).toBeEnabled();
  const after = await readSnapshot(page);
  expect(after?.validateRequests.at(-1)).toMatchObject({
    outputName: "Updated Calculation",
    formulaText: "ROUND([Length] + [Width], 2)",
    expectedGeneration: 8,
  });
});

test("guards cut before clipboard write when the selection intersects calculated columns", async ({ mount, page }) => {
  await mount(<CalculatedColumnHarness scenario="matrix" />);
  await setClipboardText(page, "99");

  const ordinaryCell = page.locator('[data-row="0"][data-col="3"]');
  await ordinaryCell.click();
  await page.keyboard.down("Shift");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.up("Shift");
  await page.keyboard.press("Meta+X");

  await expect(page.getByText('Calculated column "Area" must be edited through Calculated Column.')).toBeVisible();
  const snapshot = await readSnapshot(page);
  expect(snapshot?.clipboardWrites).toHaveLength(0);
  expect(snapshot?.clearCellsCalls).toHaveLength(0);
  expect(snapshot?.pasteCalls).toHaveLength(0);
  expect(snapshot?.updateCellCalls).toHaveLength(0);
});

test("does not persist batch display props before rejecting calculated output type changes", async ({ mount, page }) => {
  await mount(<CalculatedColumnHarness scenario="matrix" />);

  await page.locator('[data-col-hdr="0"]').dragTo(page.locator('[data-col-hdr="4"]'));
  await openColumnMenu(page, 4);
  await page.getByText("Column properties (5 columns)").click();
  const dialog = page.locator(".sp-dialog");
  await dialog.locator("select.sp-dialog-select").first().selectOption("VARCHAR");
  await dialog.locator('input[type="number"]').last().fill("180");
  await dialog.getByRole("button", { name: "Confirm" }).click();

  await expect(page.getByText(/read-only until convert to values: Area/)).toBeVisible();
  const snapshot = await readSnapshot(page);
  expect(snapshot?.alterColumnsTypeRequests).toEqual([
    {
      datasetId: "dataset-calculated-columns",
      columnNames: ["Length", "Width", "Calculated1", "Area"],
      newType: "VARCHAR",
      expectedGeneration: 7,
    },
  ]);
  expect(snapshot?.displayPropsWrites).toHaveLength(0);
});

test("blocks edit formula-bar clear delete backspace and paste on calculated columns before IPC", async ({ mount, page }) => {
  await mount(<CalculatedColumnHarness scenario="matrix" />);
  await setClipboardText(page, "99");

  const areaCell = page.locator('[data-row="0"][data-col="4"]');
  await areaCell.click();
  await areaCell.dblclick();
  await expect(page.locator(".sp-cell-input")).toHaveCount(0);
  await expect(page.getByText('Calculated column "Area" must be edited through Calculated Column.')).toBeVisible();

  const formulaBar = page.locator(".sp-formula-input");
  await formulaBar.fill("99");
  await formulaBar.press("Enter");
  await page.keyboard.press("Delete");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Meta+V");

  const snapshot = await readSnapshot(page);
  expect(snapshot?.updateCellCalls).toHaveLength(0);
  expect(snapshot?.clearCellsCalls).toHaveLength(0);
  expect(snapshot?.clipboardWrites).toHaveLength(0);
  expect(snapshot?.pasteCalls).toHaveLength(0);
});

test("refreshes calculated descriptors and window state after undo and redo revisions", async ({ mount, page }) => {
  await mount(<CalculatedColumnHarness scenario="matrix" />);

  await expect(page.locator('[data-col-hdr="1"] .sp-col-name')).toHaveText("Width");
  await expect(page.locator('[data-col-hdr="4"]')).toHaveAttribute("data-calculated", "ready");

  await stageUndoRefresh(page);
  await page.locator('[data-row="0"][data-col="1"]').click();
  await page.keyboard.press("Meta+Z");
  await expect(page.locator('[data-col-hdr="1"] .sp-col-name')).toHaveText("Width Undo");
  await openColumnMenu(page, 4);
  await page.getByText("Edit Formula").click();
  await expect(formulaTextbox(page)).toHaveValue("ROUND([Length] * [Width Undo], 2)");
  await page.locator(".sp-calculated-column-actions").getByRole("button", { name: "Cancel" }).click();

  await stageRedoRefresh(page);
  await page.locator('[data-row="0"][data-col="1"]').click();
  await page.keyboard.press("Meta+Shift+Z");
  await expect(page.locator('[data-col-hdr="1"] .sp-col-name')).toHaveText("Width Redo");
  await openColumnMenu(page, 4);
  await page.getByText("Edit Formula").click();
  await expect(formulaTextbox(page)).toHaveValue("ROUND([Length] * [Width Redo], 2)");
});

test("keeps long localized labels and diagnostics contained within the 760px dialog without pane or text overlap", async ({ mount, page }) => {
  await page.setViewportSize({ width: 760, height: 900 });
  await mount(<CalculatedColumnHarness scenario="matrix" width={760} />);

  await page.getByRole("button", { name: "Calculated Column" }).click();
  await formulaTextbox(page).fill("RUNNING_SUM([Length])");
  await expect(page.getByText("Output type: DOUBLE")).toBeVisible();
  await setLanguage(page, "vi");
  const dialog = page.locator(".sp-calculated-column-dialog");
  const mainBox = await page.locator(".sp-calculated-column-main").boundingBox();
  const sideBox = await page.locator(".sp-calculated-column-side").boundingBox();
  const dialogBox = await dialog.boundingBox();
  expect(mainBox).not.toBeNull();
  expect(sideBox).not.toBeNull();
  expect(dialogBox).not.toBeNull();
  if (!mainBox || !sideBox || !dialogBox) return;
  const separatedHorizontally = mainBox.x + mainBox.width <= sideBox.x + 1 || sideBox.x + sideBox.width <= mainBox.x + 1;
  const separatedVertically = mainBox.y + mainBox.height <= sideBox.y + 1 || sideBox.y + sideBox.height <= mainBox.y + 1;
  expect(separatedHorizontally || separatedVertically).toBe(true);
  expect(dialogBox.width).toBeLessThanOrEqual(760);
  const diagnostic = page.locator(".sp-calculated-column-diagnostic").first();
  const diagnosticBox = await diagnostic.boundingBox();
  expect(diagnosticBox).not.toBeNull();
  if (!diagnosticBox) return;
  expect(diagnosticBox.x).toBeGreaterThanOrEqual(dialogBox.x);
  expect(diagnosticBox.x + diagnosticBox.width).toBeLessThanOrEqual(dialogBox.x + dialogBox.width);
});