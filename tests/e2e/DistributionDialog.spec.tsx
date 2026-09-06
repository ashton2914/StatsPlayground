import { expect, test } from "@playwright/experimental-ct-react";

import { DistributionDialog } from "../../src/components/distribution/DistributionDialog";
import {
  createDistributionItem,
  type DistributionFieldInfo,
} from "../../src/components/distribution/distributionConfig";
import type { DistributionItem } from "../../src/types/distribution";

const columns: DistributionFieldInfo[] = [
  { name: "Value", sqlType: "DOUBLE", integerCompatible: false, field: { name: "Value", type: "continuous" } },
  { name: "Count", sqlType: "INTEGER", integerCompatible: true, field: { name: "Count", type: "continuous" } },
  { name: "Group", sqlType: "VARCHAR", integerCompatible: false, field: { name: "Group", type: "nominal" } },
];

test("creates one persisted Distribution definition from role assignments", async ({ mount }) => {
  let saved: DistributionItem | null = null;
  const component = await mount(
    <DistributionDialog open datasetId="dataset-1" columns={columns} defaultName="Distribution 1"
      onSubmit={(item) => { saved = item; }} onCancel={() => {}} />,
  );

  await component.getByTestId("distribution-column-search").fill("Value");
  await expect(component.getByText("Group", { exact: true })).toHaveCount(0);
  await component.getByTestId("distribution-column-Value").getByRole("button", { name: "Y", exact: true }).click();
  await component.getByTestId("distribution-column-search").fill("");
  await component.getByTestId("distribution-column-Count").getByRole("button", { name: "Weight" }).click();
  await component.getByTestId("distribution-column-Group").getByRole("button", { name: "By" }).click();
  await component.getByTestId("distribution-confidence-level").fill("0.9");
  await component.getByRole("button", { name: "Save" }).click();

  expect(saved).not.toBeNull();
  expect(saved?.responses).toEqual([{ name: "Value", type: "continuous" }]);
  expect(saved?.weight).toEqual({ name: "Count", type: "continuous" });
  expect(saved?.by).toEqual([{ name: "Group", type: "nominal" }]);
  expect(saved?.analysis.confidenceLevel).toBe(0.9);
  expect(saved?.graphs.overview.modeStates.twoD.encoding.x?.name).toBe("Value");
});

test("edits a definition without changing its stable identity", async ({ mount }) => {
  let saved: DistributionItem | null = null;
  const initialItem = createDistributionItem({
    id: "distribution-stable-1", name: "Original", sourceDatasetId: "dataset-1",
    responses: [{ name: "Value", type: "continuous" }], weight: null, frequency: null, by: [],
    columns, createdAt: "2026-01-01T00:00:00.000Z",
  });
  const component = await mount(
    <DistributionDialog open datasetId="dataset-1" columns={columns} defaultName="Unused"
      initialItem={initialItem} onSubmit={(item) => { saved = item; }} onCancel={() => {}} />,
  );

  await component.getByRole("textbox", { name: "Name" }).fill("Renamed");
  await component.getByRole("button", { name: "Save" }).click();

  expect(saved?.id).toBe("distribution-stable-1");
  expect(saved?.createdAt).toBe(initialItem.createdAt);
  expect(saved?.name).toBe("Renamed");
});

test("rejects incompatible and duplicate role assignments", async ({ mount }) => {
  const component = await mount(
    <DistributionDialog open datasetId="dataset-1" columns={columns} defaultName="Distribution 1"
      onSubmit={() => {}} onCancel={() => {}} />,
  );

  await expect(component.getByTestId("distribution-column-Group").getByRole("button", { name: "Y", exact: true })).toBeDisabled();
  await expect(component.getByTestId("distribution-column-Group").getByRole("button", { name: "Weight" })).toBeDisabled();
  await expect(component.getByTestId("distribution-column-Value").getByRole("button", { name: "By" })).toBeDisabled();
  await component.getByTestId("distribution-column-Value").getByRole("button", { name: "Y", exact: true }).click();
  await component.getByTestId("distribution-column-Value").getByRole("button", { name: "Weight" }).click();
  await expect(component.getByTestId("distribution-remove-weight-Value")).toHaveCount(0);
  await expect(component.getByRole("button", { name: "Save" })).toBeEnabled();
});

test("cancel closes without producing a definition", async ({ mount }) => {
  let cancelCalls = 0;
  let submitCalls = 0;
  const component = await mount(
    <DistributionDialog open datasetId="dataset-1" columns={columns} defaultName="Distribution 1"
      onSubmit={() => { submitCalls += 1; }} onCancel={() => { cancelCalls += 1; }} />,
  );

  await component.getByRole("button", { name: "Cancel" }).click();
  expect(cancelCalls).toBe(1);
  expect(submitCalls).toBe(0);
});

test("uses shared controls without collapsing the desktop dialog", async ({ mount }) => {
  const component = await mount(
    <DistributionDialog open datasetId="dataset-1" columns={columns} defaultName="Distribution 1"
      onSubmit={() => {}} onCancel={() => {}} />,
  );

  const dialog = component.getByRole("dialog", { name: "Distribution" });
  const bounds = await dialog.boundingBox();
  expect(bounds?.width).toBeGreaterThanOrEqual(850);
  await expect(dialog.locator(".ui-input")).toHaveCount(3);
  await expect(dialog.locator(".ui-button")).toHaveCount(14);
  await expect(component.getByRole("spinbutton", { name: "Confidence level" })).toBeVisible();

  const responseZone = await component.getByTestId("distribution-role-response").boundingBox();
  const weightZone = await component.getByTestId("distribution-role-weight").boundingBox();
  const frequencyZone = await component.getByTestId("distribution-role-frequency").boundingBox();
  expect(responseZone?.width).toBeGreaterThan(180);
  expect(Math.abs((responseZone?.y ?? 0) - (weightZone?.y ?? 0))).toBeLessThan(2);
  expect((frequencyZone?.y ?? 0)).toBeGreaterThan((responseZone?.y ?? 0));
  await expect(component.getByTestId("distribution-role-response")).toHaveCSS("border-top-width", "1px");
  await expect(component.getByTestId("distribution-role-response")).toHaveCSS("border-top-style", "solid");

  await component.getByTestId("distribution-column-Value").getByRole("button", { name: "Y", exact: true }).click();
  const specificationInputs = dialog.locator(".distribution-spec-fields .ui-input");
  await expect(specificationInputs).toHaveCount(3);
  const specificationBounds = await specificationInputs.evaluateAll((inputs) => inputs.map((input) => {
    const bounds = input.getBoundingClientRect();
    return { x: bounds.x, y: bounds.y, width: bounds.width };
  }));
  expect(new Set(specificationBounds.map(({ y }) => Math.round(y))).size).toBe(1);
  expect(specificationBounds.every(({ width }) => width >= 120)).toBe(true);
  await dialog.screenshot({ path: "test-results/distribution-dialog-shared-controls.png" });
});
