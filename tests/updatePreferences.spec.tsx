import { expect, test } from "@playwright/experimental-ct-react";

import { PreferencesDialog } from "../src/components/PreferencesDialog";

test("update preferences default on and persist disabled choices", async ({ mount, page }) => {
  const component = await mount(<PreferencesDialog onClose={() => undefined} />);
  const automatic = component.getByRole("checkbox", { name: "Automatically check for updates" });
  const preview = component.getByRole("checkbox", { name: "Include preview releases" });

  await expect(automatic).toBeChecked();
  await expect(preview).toBeChecked();

  await automatic.uncheck();
  await preview.uncheck();

  await expect.poll(() => page.evaluate(() => localStorage.getItem("sp-update-automatic-check"))).toBe("false");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("sp-update-include-prerelease"))).toBe("false");
});