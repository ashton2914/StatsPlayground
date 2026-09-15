import { expect, test } from "@playwright/experimental-ct-react";

import { UpdatePromptHarness } from "./UpdatePromptHarness";

test("update prompt uses consistent release labels and keeps ignore separate from download", async ({ mount }) => {
  const component = await mount(<UpdatePromptHarness />);

  const dialog = component.getByRole("dialog", { name: "Update available" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("v0.1.0")).toBeVisible();
  await expect(dialog.getByText("v0.2.0-preview.1")).toBeVisible();

  await dialog.getByRole("button", { name: "Ignore" }).click();
  await expect(component.getByTestId("update-action")).toHaveText("ignored");

  await dialog.getByRole("button", { name: "Download Update" }).click();
  await expect(component.getByTestId("update-action")).toHaveText("downloaded");
});

test("update prompt preserves a non-semver development identity", async ({ mount }) => {
  const component = await mount(<UpdatePromptHarness currentVersion="bdad63d" />);
  const dialog = component.getByRole("dialog", { name: "Update available" });

  await expect(dialog.getByText("bdad63d", { exact: true })).toBeVisible();
  await expect(dialog.getByText("v0.2.0-preview.1")).toBeVisible();
});