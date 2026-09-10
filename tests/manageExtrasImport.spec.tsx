import { expect, test } from "@playwright/experimental-ct-react";

import { ManageExtrasImportHarness } from "./ManageExtrasImportHarness";

test("imports properties when an ID column precedes Column name", async ({ mount }) => {
  const component = await mount(<ManageExtrasImportHarness mode="reordered" />);

  await component.getByRole("button", { name: "Next" }).click();
  await component.locator(".sp-extras-batch-select").selectOption("property-table");
  await component.getByRole("button", { name: "Import from property table" }).click();

  await expect(component.locator(".sp-extras-batch-input")).toHaveValue("mm");
  await expect(component.getByText("Imported 1 columns; ignored unknown columns: ID")).toBeVisible();
});

test("reports a missing Column name header", async ({ mount }) => {
  const component = await mount(<ManageExtrasImportHarness mode="missingKey" />);

  await component.getByRole("button", { name: "Next" }).click();
  await component.locator(".sp-extras-batch-select").selectOption("property-table");
  await component.getByRole("button", { name: "Import from property table" }).click();

  await expect(
    component.getByText('The selected table is missing the required "Column name" column.'),
  ).toBeVisible();
});