import { expect, test } from "@playwright/experimental-ct-react";
import { CalculatedColumnHarness } from "./CalculatedColumnHarness";

for (const dismissal of ["close", "timeout"] as const) {
test(`does not replay a history failure after ${dismissal} when its table remounts`, async ({ mount, page }) => {
  await mount(<CalculatedColumnHarness scenario="matrix" />);
  await expect(page.getByRole("button", { name: "Calculated Column", exact: true })).toBeVisible();
  await page.evaluate(() => window.__calculatedColumnHarness?.failHistoryReplay());
  await expect(page.getByText("Error: history replay failed for this table", { exact: true })).toBeVisible();
  if (dismissal === "close") await page.locator(".sp-toast-error button").click();
  else await expect(page.locator(".sp-toast-error")).toHaveCount(0);
  await page.evaluate(() => window.__calculatedColumnHarness?.setTableVisible(false));
  await expect(page.getByRole("button", { name: "Calculated Column", exact: true })).toHaveCount(0);
  await page.evaluate(() => window.__calculatedColumnHarness?.setTableVisible(true));
  await expect(page.getByRole("button", { name: "Calculated Column", exact: true })).toBeVisible();
  expect(await page.getByText("Error: history replay failed for this table", { exact: true }).count()).toBe(0);
  await page.evaluate(() => window.__calculatedColumnHarness?.failHistoryReplay());
  await expect(page.getByText("Error: history replay failed for this table", { exact: true })).toBeVisible();
});
}
