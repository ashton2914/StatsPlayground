import { expect, test } from "@playwright/experimental-ct-react";

import { HelpUpdateHarness } from "./HelpUpdateHarness";

test("About runs a manual update check and displays the current result", async ({ mount }) => {
  const component = await mount(<HelpUpdateHarness />);
  await expect(component.getByRole("dialog", { name: "About StatsPlayground" })).toHaveAttribute("aria-modal", "true");
  const checkButton = component.getByRole("button", { name: "Check for Updates" });

  await checkButton.click();
  const checkingButton = component.getByRole("button", { name: "Checking..." });
  await expect(checkingButton).toBeDisabled();
  await component.getByRole("button", { name: "Complete check" }).click();
  await expect(component.getByRole("status")).toHaveText("StatsPlayground is up to date.");
  await expect(checkButton).toBeEnabled();
});