import { expect, test } from "@playwright/experimental-ct-react";

import { McpEndToEndHarness } from "./McpEndToEndHarness";

test("runs MCP command-layer end-to-end scenario with correlation and lifecycle checks", async ({ mount, page }) => {
  const component = await mount(<McpEndToEndHarness />);

  await component.getByRole("button", { name: "Start MCP" }).click();
  await expect(component.getByTestId("mcp-e2e-status")).toContainText("running");

  await component.getByRole("button", { name: "Run MCP Scenario" }).click();
  await expect(component.getByTestId("mcp-e2e-status")).toContainText("running-scenario");

  const allowButton = component.locator('button[aria-label^="Allow cmd-"]');
  await expect(allowButton).toBeVisible();
  await allowButton.first().click();

  await expect(component.getByTestId("mcp-e2e-status")).toContainText("scenario-complete");
  await expect(component.getByTestId("mcp-e2e-error")).toBeEmpty();

  await expect(component.getByTestId("mcp-e2e-sequence")).toContainText("project.inspect");
  await expect(component.getByTestId("mcp-e2e-sequence")).toContainText("table.create");
  await expect(component.getByTestId("mcp-e2e-sequence")).toContainText("tableTransform.create");
  await expect(component.getByTestId("mcp-e2e-sequence")).toContainText("tableTransform.run");
  await expect(component.getByTestId("mcp-e2e-sequence")).toContainText("tabulate.create");
  await expect(component.getByTestId("mcp-e2e-sequence")).toContainText("tabulate.run");
  await expect(component.getByTestId("mcp-e2e-sequence")).toContainText("tabulate.exportTable");
  await expect(component.getByTestId("mcp-e2e-sequence")).toContainText("graph.create");
  await expect(component.getByTestId("mcp-e2e-sequence")).toContainText("graph.update");
  await expect(component.getByTestId("mcp-e2e-sequence")).toContainText("analysis.create");
  await expect(component.getByTestId("mcp-e2e-sequence")).toContainText("analysis.update");
  await expect(component.getByTestId("mcp-e2e-sequence")).toContainText("analysis.run");
  await expect(component.getByTestId("mcp-e2e-sequence")).toContainText("report.create");
  await expect(component.getByTestId("mcp-e2e-sequence")).toContainText("report.update");
  await expect(component.getByTestId("mcp-e2e-sequence")).toContainText("project.save");
  await expect(component.getByTestId("mcp-e2e-sequence")).toContainText("table.exportCsv");
  await expect(component.getByTestId("mcp-e2e-sequence")).toContainText("snapshot.create");

  const correlationsText = await component.getByTestId("mcp-e2e-correlations").textContent();
  expect(correlationsText ?? "").toContain("mcp-e2e-001");
  expect(correlationsText ?? "").toContain("project.inspect");
  expect(correlationsText ?? "").toContain("table.exportCsv");

  await component.getByRole("button", { name: "Run Deny Scenario" }).click();
  const denyButton = component.locator('button[aria-label^="Deny cmd-"]');
  await expect(denyButton).toBeVisible();
  await denyButton.first().click();
  await expect(component.getByTestId("mcp-e2e-status")).toContainText("deny-complete");

  const sequenceAfterDeny = (await component.getByTestId("mcp-e2e-sequence").textContent()) ?? "";
  expect((sequenceAfterDeny.match(/table\.exportCsv/g) ?? []).length).toBeGreaterThanOrEqual(2);

  await component.getByRole("button", { name: "Stop MCP" }).click();
  await expect(component.getByTestId("mcp-e2e-status")).toContainText("stopped");
  await expect(component.getByTestId("mcp-token-value")).toContainText("Not available");

  await page.setViewportSize({ width: 390, height: 844 });
  await component.getByRole("button", { name: "Skills..." }).click();
  await expect(component.getByText("Skills are not available in Phase 1.")).toBeVisible();
});
