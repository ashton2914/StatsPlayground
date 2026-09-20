import { expect, test } from "@playwright/experimental-ct-react";

import { LogicalTableNavigationHarness } from "./LogicalTableNavigationHarness";

type AddRowsRequest = {
  count: number;
  beforeRowId: number | null;
  expectedGeneration: number;
};

type TableWindowRequest = {
  start: number;
  generation: number;
};

function readJson<T>(text: string | null): T {
  return JSON.parse(text ?? "null") as T;
}

async function dragRailToRatio(component: any, page: any, ratio: number) {
  const rail = component.getByRole("scrollbar");
  const box = await rail.boundingBox();
  if (!box) throw new Error("logical scrollbar is not visible");
  await page.mouse.move(box.x + box.width / 2, box.y + 8);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height * ratio);
  await page.mouse.up();
}

test("applies append result metadata and reloads only the current window", async ({ mount, page }) => {
  const component = await mount(
    <LogicalTableNavigationHarness rowCount={1_000} width={920} height={420} />,
  );
  const rail = component.getByRole("scrollbar");

  await rail.focus();
  await page.keyboard.press("End");
  await expect.poll(async () => Number(await rail.getAttribute("aria-valuenow")))
    .toBe(Number(await rail.getAttribute("aria-valuemax")));
  await component.locator(".sp-add-row-hdr").click();

  await expect(component.getByTestId("dataset-generation")).toHaveText("2");
  await expect(component.getByTestId("dataset-row-count")).toHaveText("1001");
  await expect(component.getByTestId("dataset-column-count")).toHaveText("8");
  await expect(component.getByTestId("dataset-count")).toHaveText("2");
  await expect(component.getByTestId("unrelated-dataset-generation")).toHaveText("9");
  await expect(component.getByTestId("refresh-datasets-calls")).toHaveText("0");
  await expect(component.getByTestId("latest-history-action")).toHaveText(
    JSON.stringify({
      kind: "changeSet",
      datasetId: "logical-scroll-dataset",
      changeSetId: "add-rows-2",
    }),
  );

  await expect.poll(async () => {
    const requests = readJson<TableWindowRequest[]>(
      await component.getByTestId("table-window-requests").textContent(),
    );
    return requests.filter((request) => request.generation === 2);
  }).toHaveLength(1);
  const mutationReloads = readJson<TableWindowRequest[]>(
    await component.getByTestId("table-window-requests").textContent(),
  ).filter((request) => request.generation === 2);
  expect(mutationReloads).toEqual([{ start: 0, generation: 2 }]);
});

test("uses the loaded stable row id as insertion target under descending sort", async ({ mount, page }) => {
  const component = await mount(<LogicalTableNavigationHarness rowCount={200} />);

  await component.getByTestId("apply-sort-desc").click();
  await expect(component.locator('[data-viewport-slot="0"]')).toContainText("sort-desc-row");
  const targetHeader = component.locator('td[data-row-hdr="2"]');
  const targetText = await component.locator('td[data-row="2"][data-col="0"]').textContent();
  const targetRowId = Number(/sort-desc-row-(\d+)-/.exec(targetText ?? "")?.[1]);
  await targetHeader.click({ button: "right" });
  await component.locator(".sp-ctx-menu .sp-ctx-item").first().click();

  await expect.poll(async () => readJson<AddRowsRequest[]>(
    await component.getByTestId("add-rows-requests").textContent(),
  )).toEqual([{
    count: 1,
    beforeRowId: targetRowId,
    expectedGeneration: 1,
  }]);
  expect(targetRowId).not.toBe(3);

  await component.getByTestId("clear-sort").click();
  await expect(component.locator('[data-viewport-slot="0"]')).toContainText("row-");
  await expect.poll(async () =>
    Number(await component.getByRole("scrollbar").getAttribute("aria-valuemax")),
  ).toBeGreaterThan(100);
  await dragRailToRatio(component, page, 0.17);
  await expect(component.locator(".sp-grid tbody")).toContainText(`row-${targetRowId}-`);
  const visibleText = await component.locator(".sp-grid tbody").textContent();
  expect(visibleText?.indexOf("row-201-")).toBeLessThan(
    visibleText?.indexOf(`row-${targetRowId}-`) ?? -1,
  );
});

test("reports stale mutation, refreshes authoritative state once, and requires retry", async ({ mount }) => {
  const component = await mount(
    <LogicalTableNavigationHarness rowCount={20} staleAddRowsOnce />,
  );

  await component.locator(".sp-corner").click({ button: "right" });
  await component.locator(".sp-ctx-menu .sp-ctx-item").first().click();

  await expect(component.locator(".sp-toast-error")).toContainText("stale dataset generation");
  await expect(component.getByTestId("refresh-datasets-calls")).toHaveText("1");
  await expect(component.getByTestId("dataset-generation")).toHaveText("2");
  await expect(component.getByTestId("dataset-row-count")).toHaveText("20");
  await expect.poll(async () => readJson<AddRowsRequest[]>(
    await component.getByTestId("add-rows-requests").textContent(),
  )).toHaveLength(1);
  await expect(component.getByTestId("latest-history-action")).toHaveText("null");
});

test("delete row applies the returned generation and exact row count locally", async ({ mount }) => {
  const component = await mount(<LogicalTableNavigationHarness rowCount={20} />);

  await component.locator('td[data-row-hdr="2"]').click({ button: "right" });
  await component.locator(".sp-ctx-menu .sp-ctx-danger").click();

  await expect(component.getByTestId("dataset-generation")).toHaveText("2");
  await expect(component.getByTestId("dataset-row-count")).toHaveText("19");
  await expect(component.getByTestId("refresh-datasets-calls")).toHaveText("0");
  await expect(component.getByTestId("scoped-mutation-requests")).toHaveText("deleteRows:3:1");
  await expect(component.getByTestId("latest-history-action")).toHaveText(
    JSON.stringify({
      kind: "changeSet",
      datasetId: "logical-scroll-dataset",
      changeSetId: "delete-rows-2",
    }),
  );
});

test("add and delete columns use the same result-driven metadata path", async ({ mount }) => {
  const added = await mount(<LogicalTableNavigationHarness rowCount={20} columnCount={3} />);

  await added.locator(".sp-corner").click({ button: "right" });
  await added.locator(".sp-ctx-menu .sp-ctx-item").nth(2).click();
  await expect(added.getByTestId("dataset-generation")).toHaveText("2");
  await expect(added.getByTestId("dataset-column-count")).toHaveText("4");
  await expect(added.getByTestId("refresh-datasets-calls")).toHaveText("0");
  await expect(added.getByTestId("scoped-mutation-requests")).toHaveText("addColumns:1:1");

  await added.unmount();
  const deleted = await mount(<LogicalTableNavigationHarness rowCount={20} columnCount={3} />);
  await deleted.locator('th[data-col-hdr="0"]').click({ button: "right" });
  await deleted.locator(".sp-ctx-menu .sp-ctx-danger").click();
  await expect(deleted.getByTestId("dataset-generation")).toHaveText("2");
  await expect(deleted.getByTestId("dataset-column-count")).toHaveText("2");
  await expect(deleted.getByTestId("refresh-datasets-calls")).toHaveText("0");
  await expect(deleted.getByTestId("scoped-mutation-requests"))
    .toHaveText("deleteColumns:column-1:1");
});

test("post-mutation generation fences delayed obsolete window responses", async ({ mount, page }) => {
  const component = await mount(
    <LogicalTableNavigationHarness rowCount={200} width={920} height={420} />,
  );
  const rail = component.getByRole("scrollbar");

  await rail.focus();
  await page.keyboard.press("End");
  await expect(component.locator(".sp-add-row-hdr")).toBeVisible();
  await component.locator(".sp-add-row-hdr").click();
  await expect(component.getByTestId("dataset-generation")).toHaveText("2");
  await page.waitForTimeout(350);

  await expect(component.locator('td[data-row="200"]').first()).toBeVisible();
  await expect(component.getByTestId("dataset-generation")).toHaveText("2");
});
