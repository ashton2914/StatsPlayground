import { expect, test, type Page } from "@playwright/experimental-ct-react";
import { CalculatedColumnHarness } from "./CalculatedColumnHarness";

async function renameWidth(page: Page, name: string, index = 1) {
  await page.locator(`[data-col-hdr="${index}"]`).click({ button: "right" });
  await page.getByText("Column properties", { exact: true }).click();
  const input = page.locator(".sp-dialog-input").first();
  await input.fill(name);
  await input.press("Enter");
}

test("context-menu sorting displays B1 B2 B3 and reverses the full row order after rename", async ({ mount, page }) => {
  await mount(<CalculatedColumnHarness scenario="sort" />);
  const builds = page.locator('td[data-col="0"][data-row]');
  await expect(builds).toHaveText(["B3", "B1", "B2"]);
  await page.evaluate(() => window.__calculatedColumnHarness?.lagDatasetMetadata());
  await page.locator('[data-col-hdr="0"]').click({ button: "right" });
  await page.getByText("Sort ascending", { exact: true }).click();
  await expect(builds).toHaveText(["B1", "B2", "B3"]);
  await expect(page.locator('td[data-col="1"][data-row]')).toHaveText(["11", "12", "13"]);
  await renameWidth(page, "Build-2", 0);
  await expect(builds).toHaveText(["B1", "B2", "B3"]);
  await page.locator('[data-col-hdr="0"]').click({ button: "right" });
  await page.getByText("Sort descending", { exact: true }).click();
  await expect(builds).toHaveText(["B3", "B2", "B1"]);
  await expect(page.locator('td[data-col="1"][data-row]')).toHaveText(["13", "12", "11"]);
});

for (const descending of [false, true]) {
  test(`sorted rename preserves direction ${descending} without stale requests`, async ({ mount, page }) => {
    await mount(<CalculatedColumnHarness scenario="matrix" />);
    await expect(page.locator('[data-col-hdr="1"]')).toContainText("Width");
    await page.evaluate((descending) => window.__calculatedColumnHarness?.setSort({ column: "Width", descending }), descending);
    const firstWidth = page.locator('[data-row="0"][data-col="1"]');
    await expect(firstWidth).toHaveText(descending ? "3" : "2");
    await renameWidth(page, "Width Renamed");
    await expect(page.locator('[data-col-hdr="1"]')).toContainText("Width Renamed");
    await expect(firstWidth).toHaveText(descending ? "3" : "2");
    await expect.poll(() => page.evaluate(() => window.__calculatedColumnHarness?.getSort())).toEqual({ column: "Width Renamed", descending });
    expect(await page.evaluate(() => window.__calculatedColumnHarness?.getSnapshot().rejectedSortNames)).toEqual([]);
    await page.evaluate(() => { window.__calculatedColumnHarness?.stageHistoryRefresh("undo"); });
    await page.locator('[data-row="0"][data-col="1"]').click();
    await page.keyboard.press("Meta+Z");
    await expect(page.locator('[data-col-hdr="1"]')).toContainText("Width Undo");
    await expect(firstWidth).toHaveText(descending ? "3" : "2");
    await expect.poll(() => page.evaluate(() => window.__calculatedColumnHarness?.getSort())).toEqual({ column: "Width Undo", descending });
    await page.evaluate(() => { window.__calculatedColumnHarness?.stageHistoryRefresh("redo"); });
    await page.locator('[data-row="0"][data-col="1"]').click();
    await page.keyboard.press("Meta+Shift+Z");
    await expect(page.locator('[data-col-hdr="1"]')).toContainText("Width Redo");
    await expect(firstWidth).toHaveText(descending ? "3" : "2");
    await expect.poll(() => page.evaluate(() => window.__calculatedColumnHarness?.getSort())).toEqual({ column: "Width Redo", descending });
    expect(await page.evaluate(() => window.__calculatedColumnHarness?.getSnapshot().rejectedSortNames)).toEqual([]);
  });
}

test("failed rename keeps the existing sort", async ({ mount, page }) => {
  await mount(<CalculatedColumnHarness scenario="matrix" />);
  await expect(page.locator('[data-col-hdr="1"]')).toBeVisible();
  await page.evaluate(() => { window.__calculatedColumnHarness?.setSort({ column: "Width", descending: true }); window.__calculatedColumnHarness?.failNextRename(); });
  await renameWidth(page, "Rejected Width");
  await expect(page.getByText("Error: rename failed", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.__calculatedColumnHarness?.getSort())).toEqual({ column: "Width", descending: true });
});

test("sort updates actual rows when dataset metadata lags the loaded generation", async ({ mount, page }) => {
  await mount(<CalculatedColumnHarness scenario="matrix" />);
  const firstWidth = page.locator('[data-row="0"][data-col="1"]');
  await expect(firstWidth).toHaveText("2");
  await page.evaluate(() => window.__calculatedColumnHarness?.lagDatasetMetadata());
  await expect(firstWidth).toHaveText("2");
  await page.evaluate(() => window.__calculatedColumnHarness?.setSort({ column: "Width", descending: true }));
  await expect(page.locator('[data-col-hdr="1"]')).toHaveAttribute("aria-sort", "descending");
  await expect(firstWidth).toHaveText("3");
  await renameWidth(page, "Width Renamed");
  await expect(firstWidth).toHaveText("3");
});

test("deleting the sorted column clears its sort before querying", async ({ mount, page }) => {
  await mount(<CalculatedColumnHarness scenario="matrix" />);
  await expect(page.locator('[data-col-hdr="1"]')).toBeVisible();
  await page.evaluate(() => window.__calculatedColumnHarness?.setSort({ column: "Width", descending: true }));
  await page.locator('[data-col-hdr="1"]').click({ button: "right" });
  await page.getByText('Delete column "Width"', { exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__calculatedColumnHarness?.getSort())).toBeNull();
  await expect(page.locator('[data-col-hdr="1"]')).not.toContainText("Width");
  expect(await page.evaluate(() => window.__calculatedColumnHarness?.getSnapshot().rejectedSortNames)).toEqual([]);
});

test("failed loads remain actionable after the toast lifetime and can retry", async ({ mount, page }) => {
  await mount(<CalculatedColumnHarness scenario="matrix" />);
  await expect(page.locator('[data-col-hdr="1"]')).toBeVisible();
  await page.evaluate(() => { window.__calculatedColumnHarness?.setReadFailure(true); window.__calculatedColumnHarness?.bumpGeneration(); });
  const error = page.getByRole("alert").filter({ hasText: "table read failed" });
  await expect(error).toBeVisible();
  await page.waitForTimeout(4200);
  await expect(error).toBeVisible();
  await page.evaluate(() => window.__calculatedColumnHarness?.setReadFailure(false));
  await error.getByRole("button", { name: "Retry" }).click();
  await expect(page.locator('[data-col-hdr="1"]')).toBeVisible();
  await expect(error).toHaveCount(0);
});

 test("v5 receipt before rename returns preserves rows across consecutive sorted renames", async ({ mount, page }) => {
  await mount(<CalculatedColumnHarness scenario="sort" nativePersistence receiptBeforeRenameReturn />);
  const builds = page.locator('td[data-col="0"][data-row]');
  await expect(builds).toHaveText(["B3", "B1", "B2"]);
  await page.locator('[data-col-hdr="0"]').click({ button: "right" });
  await page.getByText("Sort ascending", { exact: true }).click();
  await expect(builds).toHaveText(["B1", "B2", "B3"]);
  await renameWidth(page, "Build1", 0);
  await expect(page.locator('[data-col-hdr="0"]')).toContainText("Build1");
  await expect(builds).toHaveText(["B1", "B2", "B3"]);
  await renameWidth(page, "Build2", 0);
  await expect(page.locator('[data-col-hdr="0"]')).toContainText("Build2");
  await expect(builds).toHaveText(["B1", "B2", "B3"]);
});
