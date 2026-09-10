import { expect, test } from "@playwright/experimental-ct-react";

import { UpdatePromptHarness } from "./UpdatePromptHarness";

test("update prompt shows version details and keeps ignore separate from download", async ({ mount }) => {
  const component = await mount(<UpdatePromptHarness />);

  const dialog = component.getByRole("dialog", { name: "Update available" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("0.1.0")).toBeVisible();
  await expect(dialog.getByText("0.2.0-preview.1")).toBeVisible();

  await dialog.getByRole("button", { name: "Ignore" }).click();
  await expect(component.getByTestId("update-action")).toHaveText("ignored");

  await dialog.getByRole("button", { name: "Download Update" }).click();
  await expect(component.getByTestId("update-action")).toHaveText("downloaded");
});