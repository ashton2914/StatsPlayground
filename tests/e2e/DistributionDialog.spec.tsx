import { expect, test } from "@playwright/experimental-ct-react";

import { DistributionDialog } from "../../src/components/distribution/DistributionDialog";
import {
  createDistributionItem,
  type DistributionFieldInfo,
} from "../../src/components/distribution/distributionConfig";
import type { DistributionItem } from "../../src/types/distribution";

const completeSpecColumns: DistributionFieldInfo[] = [
  { name: "Value", sqlType: "DOUBLE", integerCompatible: false, colIndex: 0, extras: { spec: { lsl: 0 } }, field: { name: "Value", type: "continuous" } },
  { name: "Count", sqlType: "INTEGER", integerCompatible: true, colIndex: 1, field: { name: "Count", type: "continuous" } },
  { name: "Group", sqlType: "VARCHAR", integerCompatible: false, colIndex: 2, field: { name: "Group", type: "nominal" } },
];

const missingSpecColumns: DistributionFieldInfo[] = [
  { name: "Value", sqlType: "DOUBLE", integerCompatible: false, colIndex: 0, field: { name: "Value", type: "continuous" } },
  { name: "Count", sqlType: "INTEGER", integerCompatible: true, colIndex: 1, extras: { spec: { lsl: 0 } }, field: { name: "Count", type: "continuous" } },
  { name: "Value 2", sqlType: "DOUBLE", integerCompatible: false, colIndex: 2, field: { name: "Value 2", type: "continuous" } },
  { name: "Group", sqlType: "VARCHAR", integerCompatible: false, colIndex: 3, field: { name: "Group", type: "nominal" } },
];

const manyColumns: DistributionFieldInfo[] = Array.from({ length: 240 }, (_, index) => ({
  name: `Measurement ${String(index + 1).padStart(3, "0")}`,
  sqlType: "DOUBLE",
  integerCompatible: false,
  colIndex: index,
  field: { name: `Measurement ${String(index + 1).padStart(3, "0")}`, type: "continuous" },
}));

const manyMissingSpecColumns: DistributionFieldInfo[] = Array.from({ length: 45 }, (_, index) => ({
  name: `Missing Spec ${String(index + 1).padStart(2, "0")}`,
  sqlType: "DOUBLE",
  integerCompatible: false,
  colIndex: index,
  field: { name: `Missing Spec ${String(index + 1).padStart(2, "0")}`, type: "continuous" },
}));

const longMissingSpecName = `Measurement_${"X".repeat(120)}`;
const longMissingSpecColumns: DistributionFieldInfo[] = [
  {
    name: longMissingSpecName,
    sqlType: "DOUBLE",
    integerCompatible: false,
    colIndex: 0,
    field: { name: longMissingSpecName, type: "continuous" },
  },
];

function dialogProps(overrides: Record<string, unknown> = {}): any {
  return {
    open: true,
    datasetId: "dataset-1",
    columns: completeSpecColumns,
    defaultName: "Distribution 1",
    onManageProperties: () => {},
    onSubmit: () => {},
    onCancel: () => {},
    ...overrides,
  };
}

test("creates one persisted Distribution definition from role assignments", async ({ mount }) => {
  let saved: DistributionItem | null = null;
  const component = await mount(
    <DistributionDialog
      {...dialogProps({ onSubmit: (item: DistributionItem) => { saved = item; } })}
    />,
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

test("persists and reopens a nested subgroup role", async ({ mount }) => {
  let saved: DistributionItem | null = null;
  const component = await mount(
    <DistributionDialog
      {...dialogProps({ onSubmit: (item: DistributionItem) => { saved = item; } })}
    />,
  );

  await component.getByTestId("distribution-column-Value").getByRole("button", { name: "Y", exact: true }).click();
  await component.getByTestId("distribution-column-Group").getByRole("button", { name: "Subgroup", exact: true }).click();
  await component.getByRole("button", { name: "Save" }).click();

  expect(saved?.nestedSubgroup).toEqual({ name: "Group", type: "nominal" });
  await component.unmount();

  const reopened = await mount(
    <DistributionDialog {...dialogProps({ initialItem: saved })} />,
  );
  await expect(reopened.getByTestId("distribution-role-nestedSubgroup")).toContainText("Group");
});

test("edits a definition without changing its stable identity", async ({ mount }) => {
  let saved: DistributionItem | null = null;
  const initialItem = createDistributionItem({
    id: "distribution-stable-1", name: "Original", sourceDatasetId: "dataset-1",
    responses: [{ name: "Value", type: "continuous" }], weight: null, frequency: null, by: [],
    columns: completeSpecColumns, createdAt: "2026-01-01T00:00:00.000Z",
  });
  const component = await mount(
    <DistributionDialog
      {...dialogProps({ defaultName: "Unused", initialItem, onSubmit: (item: DistributionItem) => { saved = item; } })}
    />,
  );

  await component.getByRole("textbox", { name: "Name" }).fill("Renamed");
  await component.getByRole("button", { name: "Save" }).click();

  expect(saved?.id).toBe("distribution-stable-1");
  expect(saved?.createdAt).toBe(initialItem.createdAt);
  expect(saved?.name).toBe("Renamed");
});

test("rejects incompatible and duplicate role assignments", async ({ mount }) => {
  const component = await mount(
    <DistributionDialog {...dialogProps()} />,
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
    <DistributionDialog
      {...dialogProps({ onSubmit: () => { submitCalls += 1; }, onCancel: () => { cancelCalls += 1; } })}
    />,
  );

  await component.getByRole("button", { name: "Cancel" }).click();
  expect(cancelCalls).toBe(1);
  expect(submitCalls).toBe(0);
});

test("uses shared controls without collapsing the desktop dialog", async ({ mount }) => {
  const component = await mount(
    <DistributionDialog {...dialogProps()} />,
  );

  const dialog = component.getByRole("dialog", { name: "Distribution" });
  const bounds = await dialog.boundingBox();
  expect(bounds?.width).toBeGreaterThanOrEqual(850);
  await expect(dialog.locator(".ui-input")).toHaveCount(3);
  await expect(dialog.locator(".ui-button")).toHaveCount(17);
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
  await expect(component.locator(".distribution-spec-fields")).toHaveCount(0);
  await dialog.screenshot({ path: "test-results/distribution-dialog-shared-controls.png" });
});

test("keeps hundreds of fields inside a bounded scrollable selector", async ({ mount, page }) => {
  const component = await mount(
    <DistributionDialog {...dialogProps({ columns: manyColumns })} />,
  );

  const dialog = component.getByRole("dialog", { name: "Distribution" });
  const bounds = await dialog.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.y).toBeGreaterThanOrEqual(12);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(page.viewportSize()!.height - 12);
  await expect(component.getByRole("button", { name: "Save" })).toBeVisible();
  await expect(component.getByRole("button", { name: "Cancel" })).toBeVisible();

  const fieldList = component.locator(".distribution-column-list");
  const overflow = await fieldList.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    overflowY: getComputedStyle(element).overflowY,
  }));
  expect(overflow.scrollHeight).toBeGreaterThan(overflow.clientHeight);
  expect(overflow.overflowY).toBe("auto");
});

test("warns before saving when responses are missing capability specs", async ({ mount }) => {
  let submitCalls = 0;
  const component = await mount(
    <DistributionDialog {...dialogProps({ columns: missingSpecColumns, onSubmit: () => { submitCalls += 1; } })} />,
  );

  await component.getByTestId("distribution-column-Value").getByRole("button", { name: "Y", exact: true }).click();
  await component.getByRole("button", { name: "Save" }).click();

  await expect(component.locator(".distribution-spec-fields")).toHaveCount(0);
  const warning = component.getByRole("alertdialog", { name: "Missing specification limits" });
  await expect(warning).toBeVisible();
  await expect(warning.getByText("Value", { exact: true })).toBeVisible();
  expect(submitCalls).toBe(0);
});

test("moves focus into the missing-spec warning and traps tab inside its actions", async ({ mount, page }) => {
  const component = await mount(
    <DistributionDialog {...dialogProps({ columns: missingSpecColumns })} />,
  );

  await component.getByTestId("distribution-column-Value").getByRole("button", { name: "Y", exact: true }).click();
  await component.getByRole("button", { name: "Save" }).click();

  const warning = component.getByRole("alertdialog", { name: "Missing specification limits" });
  const warningCancel = warning.getByRole("button", { name: "Cancel" });
  const warningManage = warning.getByRole("button", { name: "Manage Column Properties" });
  const warningContinue = warning.getByRole("button", { name: "Continue Without Capability" });

  await expect(warning).toBeVisible();
  await expect(warningCancel).toBeFocused();

  await page.keyboard.press("Tab");
  await expect(warningManage).toBeFocused();

  await page.keyboard.press("Tab");
  await expect(warningContinue).toBeFocused();

  await page.keyboard.press("Tab");
  await expect(warningCancel).toBeFocused();

  await page.keyboard.press("Shift+Tab");
  await expect(warningContinue).toBeFocused();
});

test("escape dismisses the missing-spec warning without discarding the draft", async ({ mount, page }) => {
  let submitCalls = 0;
  const component = await mount(
    <DistributionDialog {...dialogProps({ columns: missingSpecColumns, onSubmit: () => { submitCalls += 1; } })} />,
  );

  await component.getByTestId("distribution-column-Value").getByRole("button", { name: "Y", exact: true }).click();
  await component.getByRole("button", { name: "Save" }).click();

  const warning = component.getByRole("alertdialog", { name: "Missing specification limits" });
  await expect(warning).toBeVisible();

  await page.keyboard.press("Escape");

  await expect(warning).toHaveCount(0);
  await expect(component.getByTestId("distribution-remove-response-Value")).toBeVisible();
  expect(submitCalls).toBe(0);
});

test("continue submits exactly once without capability overrides", async ({ mount }) => {
  let saved: DistributionItem | null = null;
  let submitCalls = 0;
  const component = await mount(
    <DistributionDialog {...dialogProps({ columns: missingSpecColumns, onSubmit: (item: DistributionItem) => {
        submitCalls += 1;
        saved = item;
      } })} />,
  );

  await component.getByTestId("distribution-column-Value").getByRole("button", { name: "Y", exact: true }).click();
  await component.getByRole("button", { name: "Save" }).click();

  const warning = component.getByRole("alertdialog", { name: "Missing specification limits" });
  await warning.getByRole("button", { name: "Continue Without Capability" }).click();

  expect(submitCalls).toBe(1);
  expect(saved?.analysis.specLimits).toEqual({});
  await expect(warning).toHaveCount(0);
});

test("manage delegates missing response columns without submitting", async ({ mount }) => {
  let submitCalls = 0;
  let manageRequest: { datasetId: string; colIndices: number[] } | null = null;
  const component = await mount(
    <DistributionDialog {...dialogProps({ columns: missingSpecColumns, onManageProperties: (request: { datasetId: string; colIndices: number[] }) => {
        manageRequest = request;
      }, onSubmit: () => { submitCalls += 1; } })} />,
  );

  await component.getByTestId("distribution-column-Value").getByRole("button", { name: "Y", exact: true }).click();
  await component.getByTestId("distribution-column-Value 2").getByRole("button", { name: "Y", exact: true }).click();
  await component.getByRole("button", { name: "Save" }).click();

  const warning = component.getByRole("alertdialog", { name: "Missing specification limits" });
  await warning.getByRole("button", { name: "Manage Column Properties" }).click();

  expect(manageRequest).toEqual({ datasetId: "dataset-1", colIndices: [0, 2] });
  expect(submitCalls).toBe(0);
});

test("saves directly when every response already has capability specs", async ({ mount }) => {
  let submitCalls = 0;
  let saved: DistributionItem | null = null;
  const component = await mount(
    <DistributionDialog {...dialogProps({ columns: completeSpecColumns, onSubmit: (item: DistributionItem) => {
        submitCalls += 1;
        saved = item;
      } })} />,
  );

  await component.getByTestId("distribution-column-Value").getByRole("button", { name: "Y", exact: true }).click();
  await component.getByRole("button", { name: "Save" }).click();

  expect(submitCalls).toBe(1);
  expect(saved?.responses).toEqual([{ name: "Value", type: "continuous" }]);
  await expect(component.getByRole("alertdialog", { name: "Missing specification limits" })).toHaveCount(0);
});

test("keeps the missing-spec warning usable at 390px with many responses", async ({ mount, page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const component = await mount(
    <DistributionDialog {...dialogProps({ columns: manyMissingSpecColumns })} />,
  );

  for (const columnName of [
    "Missing Spec 01",
    "Missing Spec 02",
    "Missing Spec 03",
    "Missing Spec 04",
    "Missing Spec 05",
    "Missing Spec 06",
    "Missing Spec 07",
    "Missing Spec 08",
    "Missing Spec 09",
    "Missing Spec 10",
    "Missing Spec 11",
    "Missing Spec 12",
    "Missing Spec 13",
    "Missing Spec 14",
    "Missing Spec 15",
    "Missing Spec 16",
    "Missing Spec 17",
    "Missing Spec 18",
    "Missing Spec 19",
    "Missing Spec 20",
    "Missing Spec 21",
    "Missing Spec 22",
    "Missing Spec 23",
    "Missing Spec 24",
    "Missing Spec 25",
    "Missing Spec 26",
    "Missing Spec 27",
    "Missing Spec 28",
    "Missing Spec 29",
    "Missing Spec 30",
    "Missing Spec 31",
    "Missing Spec 32",
    "Missing Spec 33",
    "Missing Spec 34",
    "Missing Spec 35",
    "Missing Spec 36",
    "Missing Spec 37",
    "Missing Spec 38",
    "Missing Spec 39",
    "Missing Spec 40",
    "Missing Spec 41",
    "Missing Spec 42",
    "Missing Spec 43",
    "Missing Spec 44",
    "Missing Spec 45",
  ]) {
    await component.getByTestId(`distribution-column-${columnName}`).getByRole("button", { name: "Y", exact: true }).click();
  }
  await component.getByRole("button", { name: "Save" }).click();

  const dialog = component.getByRole("dialog", { name: "Distribution" });
  const warning = component.getByRole("alertdialog", { name: "Missing specification limits" });
  const heading = warning.getByRole("heading", { name: "Missing specification limits" });
  const missingList = warning.locator(".distribution-missing-specs-list");
  const actions = warning.locator(".distribution-missing-specs-actions");
  const lastMissingField = warning.getByText("Missing Spec 45", { exact: true });
  const cancelButton = warning.getByRole("button", { name: "Cancel" });
  const manageButton = warning.getByRole("button", { name: "Manage Column Properties" });
  const continueButton = warning.getByRole("button", { name: "Continue Without Capability" });

  await expect(warning).toBeVisible();
  await expect(heading).toBeVisible();

  const viewport = page.viewportSize();
  const dialogBox = await dialog.boundingBox();
  const warningBox = await warning.boundingBox();
  expect(viewport).not.toBeNull();
  expect(dialogBox).not.toBeNull();
  expect(warningBox).not.toBeNull();
  expect(warningBox!.width).toBeLessThanOrEqual(viewport!.width);
  expect(warningBox!.height).toBeLessThanOrEqual(dialogBox!.height);
  expect(warningBox!.height).toBeLessThanOrEqual(viewport!.height - 24);

  const overflow = await warning.evaluate((element) => ({
    scrollWidth: element.scrollWidth,
    clientWidth: element.clientWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);

  const listMetrics = await missingList.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    overflowY: getComputedStyle(element).overflowY,
  }));
  expect(listMetrics.scrollHeight).toBeGreaterThan(listMetrics.clientHeight);
  expect(["auto", "scroll"]).toContain(listMetrics.overflowY);
  await missingList.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(lastMissingField).toBeVisible();

  const actionMetrics = await actions.evaluate((element) => ({
    scrollWidth: element.scrollWidth,
    clientWidth: element.clientWidth,
    flexWrap: getComputedStyle(element).flexWrap,
  }));
  expect(actionMetrics.scrollWidth).toBeLessThanOrEqual(actionMetrics.clientWidth);
  expect(actionMetrics.flexWrap).toBe("wrap");

  await expect(cancelButton).toBeVisible();
  await expect(manageButton).toBeVisible();
  await expect(continueButton).toBeVisible();
});

test("wraps long missing-spec identifiers at 390px without horizontal clipping", async ({ mount, page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const component = await mount(
    <DistributionDialog {...dialogProps({ columns: longMissingSpecColumns })} />,
  );

  await component.getByTestId(`distribution-column-${longMissingSpecName}`).getByRole("button", { name: "Y", exact: true }).click();
  await component.getByRole("button", { name: "Save" }).click();

  const warning = component.getByRole("alertdialog", { name: "Missing specification limits" });
  const missingItem = warning.getByText(longMissingSpecName, { exact: true });

  await expect(warning).toBeVisible();
  await expect(missingItem).toBeVisible();

  const metrics = await missingItem.evaluate((element) => ({
    scrollWidth: element.scrollWidth,
    clientWidth: element.clientWidth,
    text: element.textContent,
  }));
  expect(metrics.text).toBe(longMissingSpecName);
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth);
});
