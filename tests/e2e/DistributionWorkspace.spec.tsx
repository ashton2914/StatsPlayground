import { expect, test } from "@playwright/experimental-ct-react";
import type { Locator } from "@playwright/test";

import { createDistributionItem } from "../../src/components/distribution/distributionConfig";
import * as distributionViewModule from "../../src/components/distribution/DistributionView";
import { AnalysisViewHarness } from "../AnalysisViewHarness";
import { DataTableViewPropertyManagerHarness } from "../DataTableViewPropertyManagerHarness";
import { DistributionWorkspaceHarness } from "../DistributionWorkspaceHarness";

async function ensureFrameExpanded(root: Locator, title: string) {
  const button = root.getByRole("button", { name: title, exact: true }).first();
  if ((await button.getAttribute("aria-expanded")) === "false") {
    await button.click();
  }
}

const currentColumns = [
  { name: "value", sqlType: "DOUBLE", integerCompatible: false, field: { name: "value", type: "continuous" as const } },
];
const currentItem = createDistributionItem({
  id: "distribution-1", name: "Distribution 1", sourceDatasetId: "dataset-1",
  responses: [currentColumns[0].field], weight: null, frequency: null, by: [],
  columns: currentColumns, createdAt: "2026-01-01T00:00:00.000Z",
});

test("keeps the source relationship on the persisted definition", () => {
  expect(currentItem.sourceDatasetId).toBe("dataset-1");
  expect(currentItem.responses).toEqual([{ name: "value", type: "continuous" }]);
  expect(currentItem).not.toHaveProperty("runState");
  expect(currentItem).not.toHaveProperty("snapshotId");
});

test("materializes four stable embedded GraphRuntime documents", () => {
  const graphs = distributionViewModule.materializeDistributionGraphItems(currentItem);

  expect(Object.keys(graphs)).toEqual(["overview", "boxPlot", "ecdf", "normalQuantile"]);
  expect(graphs.overview.id).toBe("distribution-graph:distribution-1:overview");
  expect(graphs.boxPlot.sourceDatasetId).toBe("dataset-1");
  expect(graphs.ecdf.modeStates.twoD.encoding.x?.name).toBe("value");
});

test("capability report renders typed Cpm confidence intervals", async ({ mount }) => {
  const component = await mount(<AnalysisViewHarness mode="multiResponseBy" />);
  const groupFrames = component.locator("[data-analysis-document] > .analysis-ui-frame");
  const overallGroup = groupFrames.first();
  await ensureFrameExpanded(overallGroup, "Overall");

  const responseFrames = overallGroup.locator(
    ":scope > .analysis-ui-frame-body > .analysis-ui-stack > .analysis-ui-frame",
  );
  const firstResponse = responseFrames.first();
  await ensureFrameExpanded(firstResponse, "301A-F01");

  const capabilityReport = firstResponse.locator("[data-analysis-surface='processCapability']").first();
  await ensureFrameExpanded(capabilityReport, "Process Capability");
  await expect(
    capabilityReport.getByRole("row", { name: "cpm 1.044 0.944 1.144", exact: true }),
  ).toBeVisible();
  await expect(
    capabilityReport.getByRole("row", { name: "cpm 0.720 0.620 0.820", exact: true }),
  ).toBeVisible();
});

test("table property manager controller waits for current table data and display props before consuming a matching one-shot request", async ({ mount, page }) => {
  const component = await mount(<DistributionWorkspaceHarness />);
  const handledRequestIds = page.getByTestId("handled-request-ids");

  await component.getByRole("button", { name: "Send dataset A request" }).click();
  await expect(handledRequestIds).toHaveText("");

  await component.getByRole("button", { name: "Resolve table data" }).click();
  await expect(handledRequestIds).toHaveText("");

  await component.getByRole("button", { name: "Rerender shell" }).click();
  await expect(handledRequestIds).toHaveText("");

  await component.getByRole("button", { name: "Resolve display props" }).click();

  await expect(handledRequestIds).toHaveText("request-spec-1");
  await expect(page.getByRole("checkbox", { name: "Column A" })).not.toBeChecked();
  await expect(page.getByRole("checkbox", { name: "Column B" })).not.toBeChecked();
  await expect(page.getByRole("checkbox", { name: "Column C" })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "Spec" })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "Unit" })).not.toBeChecked();

  await component.getByRole("button", { name: "Rerender shell" }).click();
  await expect(handledRequestIds).toHaveText("request-spec-1");
});

test("table property manager controller resets to ordinary Manage Extras defaults after a request-driven open", async ({ mount, page }) => {
  const component = await mount(<DistributionWorkspaceHarness />);
  const handledRequestIds = page.getByTestId("handled-request-ids");

  await component.getByRole("button", { name: "Send dataset A request" }).click();
  await component.getByRole("button", { name: "Resolve table data" }).click();
  await component.getByRole("button", { name: "Resolve display props" }).click();

  await expect(handledRequestIds).toHaveText("request-spec-1");
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("checkbox", { name: "Column C" })).toHaveCount(0);

  await component.getByRole("button", { name: "Manage Column Properties" }).click();
  await expect(page.getByRole("checkbox", { name: "Column A" })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "Column B" })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "Column C" })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "Unit" })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "Spec" })).toBeChecked();
});

test("table property manager controller ignores mismatched one-shot requests", async ({ mount, page }) => {
  const component = await mount(<DistributionWorkspaceHarness />);
  const handledRequestIds = page.getByTestId("handled-request-ids");

  await component.getByRole("button", { name: "Send mismatched request" }).click();
  await component.getByRole("button", { name: "Resolve table data" }).click();
  await component.getByRole("button", { name: "Resolve display props" }).click();

  await expect(handledRequestIds).toHaveText("");
  await expect(page.getByRole("checkbox", { name: "Column B" })).toHaveCount(0);
});

test("table property manager controller does not consume a dataset B request while readiness still identifies dataset A", async ({ mount, page }) => {
  const component = await mount(<DistributionWorkspaceHarness />);
  const handledRequestIds = page.getByTestId("handled-request-ids");

  await expect(page.getByTestId("active-dataset-id")).toHaveText("dataset-1");
  await component.getByRole("button", { name: "Resolve table data" }).click();
  await component.getByRole("button", { name: "Resolve display props" }).click();
  await expect(page.getByTestId("loaded-data-dataset-id")).toHaveText("dataset-1");
  await expect(page.getByTestId("loaded-display-props-dataset-id")).toHaveText("dataset-1");

  await component.getByRole("button", { name: "Switch to dataset B" }).click();
  await expect(page.getByTestId("active-dataset-id")).toHaveText("dataset-2");
  await component.getByRole("button", { name: "Send dataset B request" }).click();
  await expect(handledRequestIds).toHaveText("");

  await component.getByRole("button", { name: "Resolve table data" }).click();
  await expect(page.getByTestId("loaded-data-dataset-id")).toHaveText("dataset-2");
  await expect(page.getByTestId("loaded-display-props-dataset-id")).toHaveText("dataset-1");
  await expect(handledRequestIds).toHaveText("");

  await component.getByRole("button", { name: "Resolve display props" }).click();
  await expect(page.getByTestId("loaded-display-props-dataset-id")).toHaveText("dataset-2");
  await expect(handledRequestIds).toHaveText("request-spec-2");

  await expect(page.getByRole("checkbox", { name: "Column A" })).not.toBeChecked();
  await expect(page.getByRole("checkbox", { name: "Column B" })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "Column C" })).not.toBeChecked();

  await component.getByRole("button", { name: "Rerender shell" }).click();
  await expect(handledRequestIds).toHaveText("request-spec-2");
});

test("table property manager controller does not consume a stale dataset A request after navigation has rendered dataset B", async ({ mount, page }) => {
  const component = await mount(<DistributionWorkspaceHarness />);
  const handledRequestIds = page.getByTestId("handled-request-ids");

  await expect(page.getByTestId("active-dataset-id")).toHaveText("dataset-1");
  await component.getByRole("button", { name: "Resolve table data" }).click();
  await component.getByRole("button", { name: "Resolve display props" }).click();
  await expect(page.getByTestId("loaded-data-dataset-id")).toHaveText("dataset-1");
  await expect(page.getByTestId("loaded-display-props-dataset-id")).toHaveText("dataset-1");

  await component.getByRole("button", { name: "Switch to dataset B" }).click();
  await expect(page.getByTestId("active-dataset-id")).toHaveText("dataset-2");
  await component.getByRole("button", { name: "Send dataset A request" }).click();
  await component.getByRole("button", { name: "Rerender shell" }).click();

  await expect(handledRequestIds).toHaveText("");
  await expect(page.getByRole("checkbox", { name: "Column C" })).toHaveCount(0);
});

test("DataTableView waits for refreshed same-dataset data and display props before acknowledging a property-manager request", async ({ mount, page }) => {
  const component = await mount(<DataTableViewPropertyManagerHarness />);

  await expect(page.getByTestId("initial-load-complete")).toHaveText("yes");
  await expect(page.getByTestId("handled-request-ids")).toHaveText("");

  await component.getByRole("button", { name: "Publish same-dataset refresh request" }).click();

  await expect(page.getByTestId("refresh-load-issued")).toHaveText("yes");
  await expect(page.getByTestId("handled-request-ids")).toHaveText("");
  await expect(page.getByRole("checkbox", { name: "New" })).toHaveCount(0);

  await component.getByRole("button", { name: "Resolve refreshed table data" }).click();

  await expect(page.getByTestId("refresh-display-props-issued")).toHaveText("yes");
  await expect(page.getByTestId("handled-request-ids")).toHaveText("");
  await expect(page.getByRole("checkbox", { name: "New" })).toHaveCount(0);

  await component.getByRole("button", { name: "Resolve refreshed display props" }).click();

  await expect(page.getByTestId("handled-request-ids")).toHaveText("request-refresh-1");
  await expect(page.getByTestId("handled-request-count")).toHaveText("1");
  await expect(page.getByRole("checkbox", { name: "Old" })).not.toBeChecked();
  await expect(page.getByRole("checkbox", { name: "New" })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "Spec" })).toBeChecked();
});
