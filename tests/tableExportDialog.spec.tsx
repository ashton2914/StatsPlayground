import { expect, test } from "@playwright/experimental-ct-react";

import { TableExportDialogHarness } from "./TableExportDialogHarness";

test("renders the export dialog with disabled export until a table is selected", async ({ mount }) => {
  const component = await mount(<TableExportDialogHarness />);

  await expect(component.getByRole("heading", { name: "Export Tables" })).toBeVisible();
  await expect(component.getByRole("button", { name: "Export" })).toBeDisabled();
  await expect(component.getByRole("button", { name: "CSV" })).toBeVisible();
  await expect(component.getByRole("button", { name: "SQLite" })).toBeVisible();
  await expect(component.getByRole("button", { name: "SPTB" })).toBeVisible();
});

test("selects a folder recursively and reports mixed parent state when a child is opted out", async ({ mount }) => {
  const component = await mount(<TableExportDialogHarness />);

  const batch = component.getByRole("checkbox", { name: "Batch" });
  const tableB = component.getByRole("checkbox", { name: "B", exact: true });

  await batch.check();

  await expect(component.getByText("2 tables selected")).toBeVisible();
  await expect(component.getByRole("checkbox", { name: "A", exact: true })).toBeChecked();
  await expect(tableB).toBeChecked();

  await tableB.uncheck();

  await expect(component.getByText("1 table selected")).toBeVisible();
  await expect(batch).toHaveAttribute("aria-checked", "mixed");
  await expect.poll(() => batch.evaluate((node) => (node as HTMLInputElement).indeterminate)).toBe(true);
});

test("closes on Escape and Cancel without exporting", async ({ mount, page }) => {
  const escapeDialog = await mount(<TableExportDialogHarness />);

  await escapeDialog.locator(".sp-dialog").press("Escape");

  await expect(escapeDialog.getByRole("heading", { name: "Export Tables" })).toHaveCount(0);
  await expect(escapeDialog.getByTestId("close-count")).toHaveText("1");
  await expect(escapeDialog.getByTestId("export-count")).toHaveText("0");

  await escapeDialog.unmount();

  const cancelDialog = await mount(<TableExportDialogHarness />);
  await cancelDialog.getByRole("button", { name: "Cancel" }).click();

  await expect(cancelDialog.getByRole("heading", { name: "Export Tables" })).toHaveCount(0);
  await expect(cancelDialog.getByTestId("close-count")).toHaveText("1");
  await expect(cancelDialog.getByTestId("export-count")).toHaveText("0");
});

test("keeps the dialog open when the native export is cancelled", async ({ mount }) => {
  const component = await mount(<TableExportDialogHarness behavior="cancel" />);

  await component.getByRole("checkbox", { name: "A", exact: true }).check();
  await component.getByRole("button", { name: "Export" }).click();

  await expect(component.getByRole("heading", { name: "Export Tables" })).toBeVisible();
  await expect(component.getByTestId("close-count")).toHaveText("0");
  await expect(component.getByTestId("export-count")).toHaveText("1");
});

test("retains selection and format when export fails", async ({ mount }) => {
  const component = await mount(<TableExportDialogHarness behavior="reject" />);

  await component.getByRole("checkbox", { name: "A", exact: true }).check();
  await component.getByRole("button", { name: "SQLite" }).click();
  await component.getByRole("button", { name: "Export" }).click();

  await expect(component.getByRole("alert")).toContainText("Export failed");
  await expect(component.getByRole("checkbox", { name: "A", exact: true })).toBeChecked();
  await expect(component.getByText("1 table selected")).toBeVisible();
  await expect(component.getByRole("button", { name: "SQLite" })).toHaveAttribute("aria-pressed", "true");
  await expect(component.getByTestId("close-count")).toHaveText("0");
});

test("cannot close while an export is pending", async ({ mount }) => {
  const component = await mount(<TableExportDialogHarness behavior="pending" />);

  await component.getByRole("checkbox", { name: "A", exact: true }).check();
  await component.getByRole("button", { name: "Export" }).click();

  await expect(component.getByRole("button", { name: "Cancel" })).toBeDisabled();
  await component.locator(".sp-dialog").press("Escape");
  await expect(component.getByRole("heading", { name: "Export Tables" })).toBeVisible();
  await expect(component.getByTestId("close-count")).toHaveText("0");
});