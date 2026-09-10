import { expect, test } from "@playwright/experimental-ct-react";

import { UpdateDialogsHarness } from "./UpdateDialogsHarness";

test("manual update prompt replaces About and Ignore returns to About", async ({ mount }) => {
  const component = await mount(<UpdateDialogsHarness />);

  await expect(component.getByRole("dialog", { name: "About StatsPlayground" })).toBeVisible();
  await component.getByRole("button", { name: "Check for Updates" }).click();

  await expect(component.getByRole("dialog")).toHaveCount(1);
  await expect(component.getByRole("dialog", { name: "Update available" })).toBeVisible();

  await component.getByRole("button", { name: "Ignore" }).click();
  await expect(component.getByRole("dialog")).toHaveCount(1);
  await expect(component.getByRole("dialog", { name: "About StatsPlayground" })).toBeVisible();
});
