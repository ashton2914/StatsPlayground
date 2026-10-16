import { test, expect } from "@playwright/experimental-ct-react";
import { GraphLayerOptionsHarness } from "./GraphLayerOptionsHarness";
test("shared layer editors retain legacy defaults and accessible settings", async ({ mount }) => {
  const view = await mount(<GraphLayerOptionsHarness/>);
  const scatter = view.getByRole("region", { name: "Scatter" });
  await expect(scatter.getByLabel("Summary Statistic")).toHaveValue("none");
  await expect(scatter.getByLabel("Jitter", { exact: true })).toHaveValue("stacked");
  await scatter.getByLabel("Summary Statistic").selectOption("median");
  await expect(view.locator("output")).toContainText('"summaryStat":"median"');
  const line = view.getByRole("region", { name: "Line" });
  await expect(line.getByLabel("Summary Statistic")).toHaveValue("mean");
  await expect(line.getByLabel("Connection")).toHaveValue("line");
  await expect(line.locator("select")).toHaveCount(7);
});
test("shared layer editors disable every control in Chinese", async ({ mount }) => {
  const view = await mount(<GraphLayerOptionsHarness locale="zh-CN" disabled/>);
  await expect(view.locator("select")).toHaveCount(11);
  for (const control of await view.locator("select,input").all()) await expect(control).toBeDisabled();
});
