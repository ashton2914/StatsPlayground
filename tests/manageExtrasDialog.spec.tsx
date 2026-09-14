import { expect, test } from "@playwright/experimental-ct-react";

import { ManageExtrasDialogHarness } from "./ManageExtrasDialogHarness";

test("uses prop-driven initial selections once, then preserves user changes across rerenders", async ({ mount }) => {
  const component = await mount(
    <ManageExtrasDialogHarness
      initialSelectedColIndices={[-1, 1, 9, 1.5]}
      initialExtraKinds={["spec", "valueOrder", "bogus" as unknown as never]}
    />,
  );

  await expect(component.getByRole("checkbox", { name: "Column A" })).not.toBeChecked();
  await expect(component.getByRole("checkbox", { name: "Column B" })).toBeChecked();
  await expect(component.getByRole("checkbox", { name: "Column C" })).not.toBeChecked();
  await expect(component.getByRole("checkbox", { name: "Spec" })).toBeChecked();
  await expect(component.getByRole("checkbox", { name: "Unit" })).not.toBeChecked();
  await expect(component.getByRole("checkbox", { name: "Range Check" })).not.toBeChecked();
  await expect(component.getByRole("checkbox", { name: "Notes" })).not.toBeChecked();
  await expect(component.getByRole("checkbox", { name: "Value Order" })).toHaveCount(0);

  await component.getByText("Column A").click();
  await component.getByRole("button", { name: "Rerender shell" }).click();

  await expect(component.getByRole("checkbox", { name: "Column A" })).toBeChecked();
  await expect(component.getByRole("checkbox", { name: "Column B" })).toBeChecked();

  await component.getByRole("button", { name: "Remount dialog" }).click();

  await expect(component.getByRole("checkbox", { name: "Column A" })).not.toBeChecked();
  await expect(component.getByRole("checkbox", { name: "Column B" })).toBeChecked();
});

test("keeps current defaults when initial selection props are absent", async ({ mount }) => {
  const component = await mount(<ManageExtrasDialogHarness />);

  await expect(component.getByRole("checkbox", { name: "Column A" })).toBeChecked();
  await expect(component.getByRole("checkbox", { name: "Column B" })).toBeChecked();
  await expect(component.getByRole("checkbox", { name: "Column C" })).toBeChecked();
  await expect(component.getByRole("checkbox", { name: "Unit" })).toBeChecked();
  await expect(component.getByRole("checkbox", { name: "Spec" })).toBeChecked();
  await expect(component.getByRole("checkbox", { name: "Range Check" })).not.toBeChecked();
  await expect(component.getByRole("checkbox", { name: "Notes" })).not.toBeChecked();
});