import { expect, test } from "@playwright/experimental-ct-react";

import { McpManagementHarness } from "./McpManagementHarness";

for (const scenario of ["stopped", "starting", "running", "stopping"] as const) {
  test(`renders MCP server lifecycle state: ${scenario}`, async ({ mount, page }) => {
    const component = await mount(<McpManagementHarness scenario={scenario} initialSubview="server" />);
    await expect(component.getByRole("heading", { name: "MCP Server" })).toBeVisible();
    await expect(component.getByTestId("mcp-server-state")).toContainText(scenario);
    if (scenario === "running") {
      await expect(component.locator(".ai-value-block").filter({ hasText: "http://127.0.0.1:48123/mcp" })).toBeVisible();
      await expect(page.locator("body")).not.toContainText("secret-token-123");
    }
  });
}

test("copies endpoint, token, and client config only on explicit actions", async ({ mount }) => {
  const component = await mount(<McpManagementHarness scenario="running" initialSubview="server" />);
  const copyLog = component.getByTestId("copy-log");

  await expect(copyLog).toBeEmpty();
  await expect(component.getByTestId("mcp-token-value")).not.toContainText("secret-token-123");

  await component.getByRole("button", { name: "Copy endpoint" }).click();
  await expect(copyLog).toContainText("http://127.0.0.1:48123/mcp");

  await component.getByRole("button", { name: "Copy token" }).click();
  await expect(copyLog).toContainText("secret-token-123");

  await component.getByRole("button", { name: "Copy client config" }).click();
  await expect(copyLog).toContainText("Authorization");
  await expect(copyLog).toContainText("Bearer secret-token-123");
});

test("manages grants, live requests, bounded audit rows, and confirmations", async ({ mount }) => {
  const component = await mount(<McpManagementHarness scenario="running" initialSubview="server" />);

  await expect(component.getByText("/Users/ashton/Exports")).toBeVisible();
  await component.getByPlaceholder("/Users/ashton/Exports").fill("/Users/ashton/Snapshots");
  await component.getByRole("button", { name: "Authorize root" }).click();
  await expect(component.getByText("/Users/ashton/Snapshots")).toBeVisible();

  await expect(component.getByTestId("mcp-activity-row")).toHaveCount(8);
  const activityRows = component.getByTestId("mcp-activity-row");
  await expect(activityRows.filter({ hasText: "cmd-queued" })).toBeVisible();
  await expect(activityRows.filter({ hasText: "cmd-running" })).toBeVisible();
  await expect(activityRows.filter({ hasText: "cmd-confirm" })).toBeVisible();

  await component.getByRole("button", { name: "Allow cmd-confirm" }).click();
  await expect(component.getByText("cmd-confirm")).toHaveCount(0);

  await component.getByRole("button", { name: "Remove root /Users/ashton/Exports" }).click();
  await expect(component.getByText("/Users/ashton/Exports")).toHaveCount(0);
});

test("switches subviews and keeps the Skills placeholder unavailable", async ({ mount, page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const component = await mount(<McpManagementHarness scenario="running" initialSubview="skills" />);

  await expect(component.getByRole("heading", { name: "Skills" })).toBeVisible();
  await expect(component.getByText("Skills are not available in Phase 1.")).toBeVisible();
  await expect(component.getByRole("button", { name: /Enable|Install/ })).toHaveCount(0);

  await component.getByRole("button", { name: "MCP Server..." }).click();
  await expect(component.getByRole("heading", { name: "MCP Server" })).toBeVisible();

  const overflow = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    body: document.body.scrollWidth - document.body.clientWidth,
  }));
  expect(overflow.document, JSON.stringify(overflow)).toBeLessThanOrEqual(1);
  expect(overflow.body, JSON.stringify(overflow)).toBeLessThanOrEqual(1);
});