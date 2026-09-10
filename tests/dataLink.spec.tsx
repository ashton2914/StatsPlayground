import { expect, test } from "@playwright/experimental-ct-react";

import { DataLinkHarness } from "./DataLinkHarness";

test("switches the unified DataLink dialog between PostgreSQL and MySQL", async ({ mount }) => {
  const component = await mount(<DataLinkHarness />);
  const postgresButton = component.getByRole("button", { name: "PostgreSQL" });
  const mysqlButton = component.getByRole("button", { name: "MySQL" });
  const portInput = component.getByLabel("Port");
  const passwordInput = component.getByLabel("Password");

  await expect(component.getByRole("heading", { name: "DataLink" })).toBeVisible();
  await expect(postgresButton).toHaveClass(/active/);
  await expect(postgresButton).toHaveAttribute("aria-pressed", "true");
  await expect(mysqlButton).toHaveAttribute("aria-pressed", "false");
  await expect(portInput).toHaveValue("16434");

  await passwordInput.fill("temporary-secret");
  await component.getByRole("button", { name: "Test connection" }).click();
  await expect(component.getByText("Connected", { exact: true })).toBeVisible();
  await component.getByRole("button", { name: "Discover objects" }).click();
  await expect(component.getByRole("button", { name: "orders" })).toBeVisible();
  await expect(component.getByText("42", { exact: true })).toBeVisible();

  await mysqlButton.click();

  await expect(mysqlButton).toHaveClass(/active/);
  await expect(mysqlButton).toHaveAttribute("aria-pressed", "true");
  await expect(postgresButton).toHaveAttribute("aria-pressed", "false");
  await expect(portInput).toHaveValue("53307");
  await expect(passwordInput).toHaveValue("");
  await expect(component.getByText("Not tested", { exact: true })).toBeVisible();
  await expect(component.getByRole("button", { name: "orders" })).toHaveCount(0);
  await expect(component.getByText("42", { exact: true })).toHaveCount(0);

  await postgresButton.click();
  await expect(postgresButton).toHaveClass(/active/);
  await expect(portInput).toHaveValue("16434");
});