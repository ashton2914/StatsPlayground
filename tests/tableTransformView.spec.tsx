import { expect, test } from "@playwright/experimental-ct-react";

import { TableTransformHarness } from "./TableTransformHarness";

test("blocked transform remains inspectable, rebindable, and rerunnable", async ({ mount }) => {
  const component = await mount(<TableTransformHarness />);

  await expect(component.getByRole("heading", { name: "Reusable sort" })).toBeVisible();
  await expect(component.getByText("Sort: value (ascending)")).toBeVisible();
  await expect(component.getByText("Missing column: batch")).toBeVisible();
  await expect(component.getByRole("button", { name: "Open Sorted output" })).toBeVisible();
  await component.getByRole("button", { name: "Open Sorted output" }).click();
  await expect(component.getByTestId("open-call")).toHaveText("1");

  await component.getByLabel("source").selectOption("source-b");
  await component.getByRole("button", { name: "Apply bindings" }).click();
  await expect(component.getByTestId("rebind-call")).toHaveText("source:source-b");

  await component.getByRole("button", { name: "Rerun" }).click();
  await expect(component.getByTestId("rerun-call")).toHaveText("1");
});

test("read-only transform disables mutation actions", async ({ mount }) => {
  const component = await mount(<TableTransformHarness readOnly />);

  await expect(component.getByRole("button", { name: "Rerun" })).toBeDisabled();
  await expect(component.getByRole("button", { name: "Apply bindings" })).toBeDisabled();
  await expect(component.getByLabel("source")).toBeDisabled();
});
