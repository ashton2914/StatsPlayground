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

async function expectCommittedAppend(component: any) {
  await expect(component.getByTestId("dataset-generation")).toHaveText("2");
  await expect(component.getByTestId("latest-history-action")).toHaveText(
    JSON.stringify({
      kind: "changeSet",
      datasetId: "logical-scroll-dataset",
      changeSetId: "add-rows-2",
    }),
  );
  await expect(component.getByTestId("project-dirty")).toHaveText("true");
  await expect.poll(async () => readJson<AddRowsRequest[]>(
    await component.getByTestId("add-rows-requests").textContent(),
  )).toHaveLength(1);
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

  await expect(component.getByTestId("dataset-generation")).toHaveText("2");
  await expect(component.locator(".sp-ctx-menu")).toHaveCount(0);
  await component.getByTestId("clear-sort").click();
  await expect(component.locator('[data-viewport-slot="0"]')).toContainText("row-");
  await expect.poll(async () =>
    Number(await component.getByRole("scrollbar").getAttribute("aria-valuemax")),
  ).toBeGreaterThan(100);
  const rail = component.getByRole("scrollbar");
  await rail.focus();
  for (let index = 0; index < 30; index += 1) {
    await page.keyboard.press("ArrowDown");
  }
  await expect.poll(async () => Number(await rail.getAttribute("aria-valuenow")))
    .toBeGreaterThanOrEqual(30);
  await expect(component.locator(".sp-grid tbody")).toContainText(`row-${targetRowId}-`);
  const visibleText = await component.locator(".sp-grid tbody").textContent();
  expect(visibleText?.indexOf("row-201-")).toBeLessThan(
    visibleText?.indexOf(`row-${targetRowId}-`) ?? -1,
  );
});

test("uses the loaded stable row id as insertion target under a filter", async ({ mount }) => {
  const component = await mount(
    <LogicalTableNavigationHarness rowCount={200} initialFilterMode="ev" />,
  );

  await expect(component.locator('[data-viewport-slot="0"]')).toContainText("ev-row-");
  const targetText = await component.locator('td[data-row="2"][data-col="0"]').textContent();
  const targetRowId = Number(/ev-row-(\d+)-/.exec(targetText ?? "")?.[1]);
  await component.locator('td[data-row-hdr="2"]').click({ button: "right" });
  await component.locator(".sp-ctx-menu .sp-ctx-item").first().click();

  await expect.poll(async () => readJson<AddRowsRequest[]>(
    await component.getByTestId("add-rows-requests").textContent(),
  )).toEqual([{
    count: 1,
    beforeRowId: targetRowId,
    expectedGeneration: 1,
  }]);
  await expect(component.locator(".sp-ctx-menu")).toHaveCount(0);
  await component.getByTestId("clear-filter").click();
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

test("retains committed mutation state when scheduled invalidation fails", async ({ mount, page }) => {
  const component = await mount(
    <LogicalTableNavigationHarness rowCount={1_000} failNavigationInvalidation />,
  );

  await dragRailToRatio(component, page, 0.7);
  await expect.poll(async () =>
    ((await component.getByTestId("nav-request-starts").textContent()) ?? "")
      .split(",")
      .some((value) => Number(value) > 0),
  ).toBe(true);
  await component.locator(".sp-corner").click({ button: "right" });
  await component.locator(".sp-ctx-menu .sp-ctx-item").first().click();

  await expectCommittedAppend(component);
  await expect(component.locator(".sp-toast-error")).toContainText("mutation committed");
  await expect(component.locator(".sp-toast-error"))
    .toContainText("scheduled navigation invalidation failed");
  await expect(component.locator(".sp-ctx-menu")).toHaveCount(0);
});

test("retains committed mutation state when query-session release fails", async ({ mount }) => {
  const component = await mount(
    <LogicalTableNavigationHarness
      rowCount={200}
      initialFilterMode="ev"
      failSessionRelease
    />,
  );

  await expect.poll(async () =>
    (await component.getByTestId("prepared-session-ids").textContent()) ?? "",
  ).not.toBe("");
  await component.locator(".sp-corner").click({ button: "right" });
  await component.locator(".sp-ctx-menu .sp-ctx-item").first().click();

  await expectCommittedAppend(component);
  await expect(component.getByTestId("release-attempts")).not.toHaveText("0");
  await expect(component.locator(".sp-toast-error")).toContainText("mutation committed");
  await expect(component.locator(".sp-toast-error"))
    .toContainText("table query session release failed");
});

test("retains committed mutation state when current-window reload fails", async ({ mount }) => {
  const component = await mount(
    <LogicalTableNavigationHarness rowCount={20} failMutationReload />,
  );

  await component.locator(".sp-corner").click({ button: "right" });
  await component.locator(".sp-ctx-menu .sp-ctx-item").first().click();

  await expectCommittedAppend(component);
  await expect(component.locator(".sp-toast-error")).toContainText("mutation committed");
  await expect(component.locator(".sp-toast-error"))
    .toContainText("post-commit window reload failed");
  await expect(component.locator(".sp-ctx-menu")).toHaveCount(0);
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

test("reloads authoritative descriptors before deleting a newly added column", async ({ mount }) => {
  const component = await mount(
    <LogicalTableNavigationHarness
      rowCount={20}
      columnCount={3}
      delayMutationDescriptors
    />,
  );

  await component.locator(".sp-corner").click({ button: "right" });
  await component.locator(".sp-ctx-menu .sp-ctx-item").nth(2).click();
  await expect(component.locator('th[data-col-hdr="3"]')).toContainText("Column 4");
  await expect(component.getByTestId("mutation-refresh-events")).toHaveText(
    /^descriptors:2,window:2/,
  );
  await component.locator('th[data-col-hdr="3"]').click({ button: "right" });
  await component.locator(".sp-ctx-menu .sp-ctx-danger").click();

  await expect(component.getByTestId("dataset-generation")).toHaveText("3");
  await expect(component.getByTestId("dataset-column-count")).toHaveText("3");
  await expect(component.getByTestId("scoped-mutation-requests")).toHaveText(
    "addColumns:1:1|deleteColumns:column-4:2",
  );
  await expect(component.locator('th[data-col-hdr="3"]')).toHaveCount(0);
  await expect(component.locator(".sp-toast-error")).toHaveCount(0);
});

test("clamps active and selected column coordinates after deleting the trailing column", async ({ mount }) => {
  const component = await mount(
    <LogicalTableNavigationHarness rowCount={20} columnCount={3} />,
  );

  await component.locator('td[data-row="0"][data-col="2"]').click();
  await expect(component.locator(".sp-formula-ref-input")).toHaveValue("C1");
  await component.locator('th[data-col-hdr="2"]').dispatchEvent("contextmenu");
  await component.locator(".sp-ctx-menu .sp-ctx-danger").click();

  await expect(component.getByTestId("dataset-column-count")).toHaveText("2");
  await expect(component.locator(".sp-formula-ref-input")).toHaveValue("B1");
  await expect(component.locator('th[data-col-hdr="1"]')).toHaveClass(/sp-col-selected/);
  await expect(component.locator('[data-col="2"], [data-col-hdr="2"]')).toHaveCount(0);
});

test("blocks deleting the final remaining user column", async ({ mount }) => {
  const component = await mount(
    <LogicalTableNavigationHarness rowCount={20} columnCount={1} />,
  );

  await component.locator('th[data-col-hdr="0"]').click({ button: "right" });
  await expect(component.locator(".sp-ctx-menu .sp-ctx-danger")).toHaveClass(/sp-ctx-disabled/);

  await expect(component.getByTestId("dataset-column-count")).toHaveText("1");
  await expect(component.getByTestId("scoped-mutation-requests")).toHaveText("");
});

test("clears all column coordinates when a mutation reports zero user columns", async ({ mount }) => {
  const component = await mount(
    <LogicalTableNavigationHarness
      rowCount={20}
      columnCount={2}
      reportZeroColumnsOnDelete
    />,
  );

  await component.locator('td[data-row="0"][data-col="1"]').click();
  await component.locator('th[data-col-hdr="1"]').click({ button: "right" });
  await component.locator(".sp-ctx-menu .sp-ctx-danger").click();

  await expect(component.getByTestId("dataset-column-count")).toHaveText("0");
  await expect(component.locator("[data-col-hdr]")).toHaveCount(0);
  await expect(component.locator(".sp-cell-active, .sp-col-selected, .sp-col-selected-cell"))
    .toHaveCount(0);
});

test("rejects an unloaded row selection without mutation", async ({ mount, page }) => {
  const component = await mount(
    <LogicalTableNavigationHarness />,
  );

  await component.locator('td[data-row-hdr="0"]').dispatchEvent("click");
  const rail = component.getByRole("scrollbar");
  await rail.focus();
  await page.keyboard.press("End");
  await expect.poll(async () => Number(await rail.getAttribute("aria-valuenow")))
    .toBe(Number(await rail.getAttribute("aria-valuemax")));
  await expect(component.locator('[data-viewport-slot="0"]')).toContainText("row-");
  const logicalStart = Number(await rail.getAttribute("aria-valuenow"));
  const unloadedHeader = component.locator(`td[data-row-hdr="${logicalStart}"]`);
  await expect(unloadedHeader).toBeVisible();
  await unloadedHeader.dispatchEvent("click", { shiftKey: true });

  await expect(component.locator(".sp-toast-error")).toContainText(
    "requires rows outside the loaded window",
  );
  await expect(component.getByTestId("scoped-mutation-requests")).toHaveText("");
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

test("fences an obsolete response before awaiting stale metadata refresh", async ({ mount, page }) => {
  const component = await mount(
    <LogicalTableNavigationHarness
      rowCount={1_000}
      staleAddRowsOnce
      delayDatasetRefresh
    />,
  );

  await dragRailToRatio(component, page, 0.7);
  await expect.poll(async () =>
    ((await component.getByTestId("nav-request-starts").textContent()) ?? "")
      .split(",")
      .some((value) => Number(value) > 0),
  ).toBe(true);
  await component.locator(".sp-corner").click({ button: "right" });
  await component.locator(".sp-ctx-menu .sp-ctx-item").first().click();

  await expect(component.getByTestId("refresh-datasets-calls")).toHaveText("1");
  await expect.poll(async () => {
    const requests = readJson<TableWindowRequest[]>(
      await component.getByTestId("table-window-requests").textContent(),
    );
    return requests.filter((request) => request.generation === 2);
  }).toEqual([{ start: 0, generation: 2 }]);
  await expect(component.locator('[data-viewport-slot="0"]')).toContainText("row-1-");
});

test("composes stale recovery errors and still attempts authoritative reload", async ({ mount }) => {
  const component = await mount(
    <LogicalTableNavigationHarness
      rowCount={200}
      initialFilterMode="ev"
      staleAddRowsOnce
      failSessionRelease
      failMutationReload
    />,
  );

  await expect.poll(async () =>
    (await component.getByTestId("prepared-session-ids").textContent()) ?? "",
  ).not.toBe("");
  await component.locator(".sp-corner").click({ button: "right" });
  await component.locator(".sp-ctx-menu .sp-ctx-item").first().click();

  await expect(component.locator(".sp-toast-error")).toContainText("stale dataset generation");
  await expect(component.locator(".sp-toast-error"))
    .toContainText("table query session release failed");
  await expect(component.locator(".sp-toast-error"))
    .toContainText("post-commit window reload failed");
  await expect(component.getByTestId("release-attempts")).not.toHaveText("0");
  await expect.poll(async () => {
    const requests = readJson<TableWindowRequest[]>(
      await component.getByTestId("table-window-requests").textContent(),
    );
    return requests.some((request) => request.generation === 2);
  }).toBe(true);
  await expect.poll(async () => readJson<AddRowsRequest[]>(
    await component.getByTestId("add-rows-requests").textContent(),
  )).toHaveLength(1);
});

test("shows composite stale recovery error when metadata refresh fails", async ({ mount }) => {
  const component = await mount(
    <LogicalTableNavigationHarness rowCount={20} staleAddRowsOnce failDatasetRefresh />,
  );

  await component.locator(".sp-corner").click({ button: "right" });
  await component.locator(".sp-ctx-menu .sp-ctx-item").first().click();

  await expect(component.locator(".sp-toast-error")).toContainText("stale dataset generation");
  await expect(component.locator(".sp-toast-error"))
    .toContainText("authoritative dataset refresh failed");
  await expect.poll(async () => readJson<AddRowsRequest[]>(
    await component.getByTestId("add-rows-requests").textContent(),
  )).toHaveLength(1);
});
