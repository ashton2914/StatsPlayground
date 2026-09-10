import { expect, test } from "@playwright/experimental-ct-react";

import { HelpDialogHarness } from "./HelpDialogHarness";

test("integrates acknowledgments, contributors, and the license into a scrollable About dialog", async ({ mount, page }) => {
  await page.setViewportSize({ width: 480, height: 500 });
  const component = await mount(<HelpDialogHarness />);
  const dialog = component.locator(".sp-help-dialog");
  const dialogTitle = component.locator(".sp-dialog-title");
  const dialogBody = component.locator(".sp-dialog-body");
  const licenseLink = component.getByRole("button", {
    name: "Licensed under the Apache License 2.0.",
  });

  await expect(component.getByText("About StatsPlayground", { exact: true })).toBeVisible();
  await expect(licenseLink).toBeVisible();
  await expect(component.getByText("Acknowledgments", { exact: true })).toBeVisible();
  await expect(component.getByText("Contributors", { exact: true })).toBeVisible();
  await expect.poll(async () => dialogBody.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await expect.poll(async () => dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);

  await dialogBody.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(dialogTitle).toBeVisible();
  await expect(component.getByRole("button", { name: "Close" })).toBeVisible();

  await licenseLink.click();

  await expect(component.getByText("License", { exact: true })).toBeVisible();
  await expect(component.locator(".sp-help-license")).toContainText("Apache License");
  await expect.poll(async () => dialogBody.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect(component.getByRole("button", { name: "Back to About" })).toBeVisible();
  await expect(component.getByText("Acknowledgments", { exact: true })).toHaveCount(0);

  await component.getByRole("button", { name: "Back to About" }).click();
  await expect(component.getByText("Acknowledgments", { exact: true })).toBeVisible();
  await expect(licenseLink).toBeVisible();
});