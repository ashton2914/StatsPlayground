import { expect, test } from "@playwright/experimental-ct-react";

import { McpManagementHarness } from "./McpManagementHarness";

function registerLifecycleStateTest(
  scenario: "stopped" | "starting" | "running" | "stopping",
) {
  test(`renders MCP server lifecycle state: ${scenario}`, async ({ mount, page }) => {
    const component = await mount(<McpManagementHarness scenario={scenario} initialSubview="server" />);
    await expect(component.getByRole("heading", { name: "MCP Server" })).toBeVisible();
    await expect(component.getByTestId("mcp-server-state")).toContainText(scenario);
    const settingsControls = [
      component.getByLabel("Port", { exact: true }),
      component.getByLabel("Token", { exact: true }),
      component.getByRole("button", { name: "Reveal token" }),
      component.getByRole("button", { name: "Generate token" }),
      component.getByRole("button", { name: "Save settings" }),
    ];
    for (const control of settingsControls) {
      if (scenario === "stopped") {
        await expect(control).toBeEnabled();
      } else {
        await expect(control).toBeDisabled();
      }
    }
    if (scenario === "stopped") {
      await expect(component.getByRole("button", { name: "Start server" })).toBeEnabled();
    }
    if (scenario === "running") {
      await expect(component.locator(".ai-value-block").filter({ hasText: "http://127.0.0.1:48123/mcp" })).toBeVisible();
      await expect(page.locator("body")).not.toContainText("secret-token-123");
    }
  });
}

registerLifecycleStateTest("stopped");
registerLifecycleStateTest("starting");
registerLifecycleStateTest("running");
registerLifecycleStateTest("stopping");

test("edits saved settings without exposing the masked token", async ({ mount, page }) => {
  const component = await mount(<McpManagementHarness scenario="stopped" initialSubview="server" />);
  const tokenInput = component.getByLabel("Token", { exact: true });

  await expect(component.getByLabel("Port", { exact: true })).toHaveValue("48123");
  await expect(tokenInput).toHaveAttribute("type", "password");
  await expect(page.locator("body")).not.toContainText("saved-token-abcdefghijklmnopqrstuvwxyz");

  await component.getByRole("button", { name: "Reveal token" }).click();
  await expect(tokenInput).toHaveAttribute("type", "text");
  await component.getByRole("button", { name: "Hide token" }).click();
  await expect(tokenInput).toHaveAttribute("type", "password");
});

test("generates and saves edited settings", async ({ mount, page }) => {
  const component = await mount(<McpManagementHarness scenario="stopped" initialSubview="server" />);
  const tokenInput = component.getByLabel("Token", { exact: true });

  await component.getByRole("button", { name: "Generate token" }).click();
  await expect(tokenInput).toHaveValue("generated-token-abcdefghijklmnopqrstuvwxyz");
  await component.getByLabel("Port", { exact: true }).fill("49152");
  await component.getByRole("button", { name: "Save settings" }).click();

  await expect(component.getByTestId("save-log")).toHaveAttribute(
    "data-last-save",
    JSON.stringify({ port: 49152, token: "generated-token-abcdefghijklmnopqrstuvwxyz" }),
  );
  await expect(page.locator("body")).not.toContainText("generated-token-abcdefghijklmnopqrstuvwxyz");
});

test("shows settings validation errors", async ({ mount }) => {
  const component = await mount(<McpManagementHarness scenario="stopped" initialSubview="server" />);

  await component.getByLabel("Port", { exact: true }).fill("0");
  await component.getByRole("button", { name: "Save settings" }).click();
  await expect(component.getByText("MCP port must be between 1 and 65535")).toBeVisible();

  await component.getByLabel("Port", { exact: true }).fill("48123");
  await component.getByLabel("Token", { exact: true }).fill("too-short");
  await component.getByRole("button", { name: "Save settings" }).click();
  await expect(component.getByText("MCP token must be between 32 and 256 bytes")).toBeVisible();
});

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
  await expect(activityRows.filter({ hasText: "cmd-commit" })).toBeVisible();
  await expect(activityRows.filter({ hasText: "Queued for export" })).toBeVisible();
  await expect(activityRows.filter({ hasText: "64%" })).toBeVisible();
  await expect(activityRows.filter({ hasText: "Committing snapshot" })).toBeVisible();

  await component.getByRole("button", { name: "Allow cmd-confirm" }).click();
  await expect(component.getByText("cmd-confirm")).toHaveCount(0);
  await expect(component.getByText("ui-only-confirm")).toHaveCount(0);

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

test("keeps MCP lifecycle controls visible while panel content scrolls", async ({ mount, page }) => {
  await page.setViewportSize({ width: 390, height: 420 });
  const component = await mount(
    <McpManagementHarness scenario="running" initialSubview="server" constrainedHeight={420} />,
  );
  const view = component.locator(".ai-activity-view");
  const scrollBody = component.locator(".ai-panel-scroll");
  const header = component.locator(".ai-panel-header");
  const stopButton = component.getByRole("button", { name: "Stop server" });

  const scrollMetrics = await scrollBody.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    return {
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      scrollTop: element.scrollTop,
    };
  });

  const [viewBox, headerBox, stopBox] = await Promise.all([
    view.boundingBox(),
    header.boundingBox(),
    stopButton.boundingBox(),
  ]);
  expect(viewBox).not.toBeNull();
  expect(headerBox).not.toBeNull();
  expect(stopBox).not.toBeNull();
  expect(viewBox!.height).toBeLessThanOrEqual(420);
  expect(scrollMetrics.scrollHeight).toBeGreaterThan(scrollMetrics.clientHeight);
  expect(scrollMetrics.scrollTop).toBeGreaterThan(0);
  expect(headerBox!.y).toBeGreaterThanOrEqual(viewBox!.y);
  expect(stopBox!.y + stopBox!.height).toBeLessThanOrEqual(viewBox!.y + viewBox!.height);
  await expect(stopButton).toBeEnabled();
});