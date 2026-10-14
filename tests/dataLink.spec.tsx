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

for (const connector of ["PostgreSQL", "MySQL"] as const) {
  test(`${connector} prevents invalid parameters from reaching the connection service and explains each field`, async ({ mount }) => {
    const component = await mount(<DataLinkHarness />);
    await component.getByRole("button", { name: connector, exact: true }).click();
    const testButton = component.getByRole("button", { name: "Test connection", exact: true });
    const password = component.getByLabel("Password", { exact: true });
    await expect(testButton).toBeDisabled();
    await expect(password).toHaveAttribute("aria-invalid", "true");
    await expect(password).toHaveAccessibleDescription("Password is required.");
    await password.fill("temporary-secret");
    await expect(testButton).toBeEnabled();
    const cases = [
      ["Host", "", "localhost", "Host is required."],
      ["Host", "   ", "localhost", "Host is required."],
      ["Database", "   ", "statsplayground_test", "Database is required."],
      ["Username", "   ", "stats_reader", "Username is required."],
      ["Password", "", "temporary-secret", "Password is required."],
      ["Port", "", "5432", "Enter a whole number from 1 to 65535."],
      ["Port", "65536", "65535", "Enter a whole number from 1 to 65535."],
      ["Port", "1.5", "1", "Enter a whole number from 1 to 65535."],
      ["Timeout (seconds)", "0", "10", "Enter a whole number from 1 to 300 seconds."],
      ["Timeout (seconds)", "301", "300", "Enter a whole number from 1 to 300 seconds."],
      ["Timeout (seconds)", "1.5", "1", "Enter a whole number from 1 to 300 seconds."],
    ];
    for (const [label, invalid, valid, hint] of cases) {
      const field = component.getByLabel(label, { exact: true });
      await field.fill(invalid);
      await expect(testButton).toBeDisabled();
      await expect(field).toHaveAttribute("aria-invalid", "true");
      await expect(field).toHaveAccessibleDescription(hint);
      await expect(component.getByLabel("Connection test calls")).toHaveText("0");
      await field.fill(valid);
      await expect(testButton).toBeEnabled();
      await expect(field).not.toHaveAttribute("aria-invalid", "true");
    }
    await testButton.click();
    await expect(component.getByText("Connected", { exact: true })).toBeVisible();
    await expect(component.getByLabel("Connection test calls")).toHaveText("1");
    await component.getByLabel("Host", { exact: true }).fill(" ");
    await expect(component.getByRole("button", { name: "Discover objects", exact: true })).toBeDisabled();
    await expect(component.getByText("Not tested", { exact: true })).toBeVisible();
  });
}

test("localizes missing credentials and numeric validation in Chinese", async ({ mount }) => {
  const component = await mount(<DataLinkHarness language="zh-CN" />);
  const password = component.getByLabel("密码", { exact: true });
  await expect(password).toHaveAccessibleDescription("请填写密码。");
  await password.fill("temporary-secret");
  await component.getByLabel("端口", { exact: true }).fill("0");
  await expect(component.getByLabel("端口", { exact: true })).toHaveAccessibleDescription("请输入 1 至 65535 之间的整数。");
  await expect(component.getByRole("button", { name: "测试连接", exact: true })).toBeDisabled();
});
