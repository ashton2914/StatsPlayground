import { expect, test } from "@playwright/experimental-ct-react";

import { DataLinkHarness } from "./DataLinkHarness";

test("previews and imports the same PostgreSQL selection", async ({ mount }) => {
  const component = await mount(<DataLinkHarness />);
  await expect(component.getByText("PostgreSQL", { exact: true })).toBeVisible();
  await expect(component.getByRole("button", { name: "MySQL" })).toHaveCount(0);
  await component.getByLabel("Password", { exact: true }).fill("temporary-secret");
  await component.getByRole("button", { name: "Test connection" }).click();
  await component.getByRole("button", { name: "Discover objects" }).click();
  await component.getByRole("checkbox", { name: "Select orders" }).check();
  const importButton = component.getByRole("button", { name: "Import selected (1)", exact: true });
  await expect(importButton).toBeDisabled();
  await expect(component.getByText("42", { exact: true })).toHaveCount(0);
  await component.getByRole("button", { name: "Add filter" }).click();
  await component.getByLabel("Filter value").fill("40");
  await component.getByLabel("Comparison").selectOption("atLeast");
  await component.getByRole("button", { name: "Preview selected data" }).click();
  await expect(component.getByText("42", { exact: true })).toBeVisible();
  await expect(importButton).toBeEnabled();
  await component.getByLabel("Filter value").fill("41");
  await expect(importButton).toBeDisabled();
  await component.getByRole("button", { name: "Preview selected data" }).click();
  await importButton.click();
  await expect(component.getByLabel("Imported selection")).toHaveText(
    '{"columns":["order_id"],"filters":[{"column":"order_id","operator":"atLeast","value":"41"}]}',
  );
});

test("PostgreSQL validates connection parameters", async ({ mount }) => {
  const component = await mount(<DataLinkHarness />);
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

test("localizes missing credentials and numeric validation in Chinese", async ({ mount }) => {
  const component = await mount(<DataLinkHarness language="zh-CN" />);
  const password = component.getByLabel("密码", { exact: true });
  await expect(password).toHaveAccessibleDescription("请填写密码。");
  await password.fill("temporary-secret");
  await component.getByLabel("端口", { exact: true }).fill("0");
  await expect(component.getByLabel("端口", { exact: true })).toHaveAccessibleDescription("请输入 1 至 65535 之间的整数。");
  await expect(component.getByRole("button", { name: "测试连接", exact: true })).toBeDisabled();
});

const saved = {
  tableId: "table-a", tableName: "Local data", revision: 2, generation: 4, refresh: true,
  link: {
    version: 1, name: "Source A", importedGeneration: 3, username: "stats_reader",
    definition: {
      connector: "postgresql", host: "localhost", port: 55432, database: "review",
      authenticationType: "usernamePassword", tlsMode: "disabled", connectTimeoutSeconds: 10,
    },
    object: { catalog: "review", schema: "public", name: "orders", objectType: "table" },
  },
} as const;

test("modified DataLink requires a deliberate choice and cancel leaves the table alone", async ({ mount }) => {
  const component = await mount(<DataLinkHarness saved={saved} />);
  await expect(component.getByRole("alert")).toContainText("This table has changed");
  await expect(component.getByRole("button", { name: "Replace current table" })).toBeDisabled();
  await component.getByRole("button", { name: "Cancel" }).click();
  await expect(component.getByLabel("Import request")).toBeEmpty();
});

test("reimport to a new table preserves the modified table", async ({ mount }) => {
  const component = await mount(<DataLinkHarness saved={saved} />);
  await component.getByLabel("Password").fill("temporary-secret");
  await component.getByRole("button", { name: "Import into a new table" }).click();
  await expect(component.getByLabel("Import request")).toHaveText('{"target":"Local data_2","options":{"linkName":"Local data_2"}}');
});

test("confirmed reimport carries the observed table and DataLink revisions", async ({ mount }) => {
  const component = await mount(<DataLinkHarness saved={saved} />);
  await component.getByLabel("Password").fill("temporary-secret");
  await component.getByRole("button", { name: "Replace current table" }).click();
  await expect(component.getByLabel("Import request")).toHaveText(
    '{"target":"Local data","options":{"linkName":"Source A","refresh":{"tableId":"table-a","expectedRevision":2,"expectedGeneration":4,"replaceModified":true}}}',
  );
});
