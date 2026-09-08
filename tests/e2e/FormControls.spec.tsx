import { expect, test } from "@playwright/experimental-ct-react";

import { FormControlsStory } from "./FormControlsStory";

test("shared form controls preserve native labels, values, and disabled state", async ({ mount }) => {
  const component = await mount(<FormControlsStory />);

  await component.getByRole("textbox", { name: "Name" }).fill("Sample");
  await component.getByRole("spinbutton", { name: "Count" }).fill("4");
  await component.getByRole("combobox", { name: "Mode" }).selectOption("robust");
  await expect(component.getByRole("button", { name: "Run robust Sample 4" })).toBeDisabled();
  await component.getByRole("checkbox", { name: "Enabled" }).check();
  await expect(component.getByRole("button", { name: "Run robust Sample 4" })).toBeEnabled();
});