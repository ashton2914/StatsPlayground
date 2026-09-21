import { expect, test } from "@playwright/experimental-ct-react";

import { GraphBuilderSharedHarness } from "./GraphBuilderSharedHarness";

test("shared graph palette preserves stable IDs for duplicate display names", async ({ mount }) => {
  const component = await mount(<GraphBuilderSharedHarness />);
  await component.getByTestId("graph-field-second-id")
    .dragTo(component.getByTestId("graph-slot-x"));
  await expect(component.getByTestId("last-drop")).toHaveText("second-id");
});

test("shared graph slot clears its binding", async ({ mount }) => {
  const component = await mount(<GraphBuilderSharedHarness />);
  await component.getByRole("button", { name: "Clear X" }).click();
  await expect(component.getByTestId("clear-count")).toHaveText("1");
});

test("disabled graph controls do not emit callbacks", async ({ mount }) => {
  const component = await mount(<GraphBuilderSharedHarness />);
  const placeholder = component.getByRole("button", { name: "Start Over" });
  await expect(placeholder).toBeDisabled();
  await expect(placeholder).toHaveAttribute(
    "title",
    "Not yet available in New Graph Builder",
  );
  await expect(component.getByTestId("graph-slot-y")).toHaveAttribute("aria-disabled", "true");
  await component.getByTestId("graph-field-first-id")
    .dragTo(component.getByTestId("graph-slot-y"));
  await expect(component.getByTestId("disabled-drop-count")).toHaveText("0");
});
