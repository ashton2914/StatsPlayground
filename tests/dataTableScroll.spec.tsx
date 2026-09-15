import { expect, test } from "@playwright/experimental-ct-react";

import { DataTableScrollHarness } from "./DataTableScrollHarness";

test("keeps rendered row height synchronized with the virtual scroll contract", async ({ mount }) => {
  const component = await mount(<DataTableScrollHarness />);
  const firstDataRow = component.locator(".sp-grid tbody tr:has(td.sp-cell)").first();

  await expect(firstDataRow).toBeVisible();
  await expect.poll(() => firstDataRow.evaluate((row) => row.getBoundingClientRect().height)).toBe(27);
});

test("keeps rows contiguous after rapid bidirectional scrolling", async ({ mount }) => {
  const component = await mount(<DataTableScrollHarness />);
  const wrapper = component.locator(".sp-grid-wrapper");
  const dataRows = component.locator(".sp-grid tbody tr.sp-data-row");

  await expect(dataRows.first()).toBeVisible();
  await wrapper.evaluate((element) => {
    for (let index = 0; index < 20; index += 1) {
      element.scrollTop = index % 2 === 0 ? element.scrollHeight : 0;
      element.dispatchEvent(new Event("scroll"));
    }
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event("scroll"));
  });

  await expect.poll(() => component.locator(".sp-row-hdr").filter({ hasText: "238" }).count()).toBe(1);
  await expect.poll(async () => dataRows.evaluateAll((rows) => rows.every((row, index) => {
    const rect = row.getBoundingClientRect();
    if (rect.height !== 27) return false;
    if (index === 0) return true;
    const previousRect = rows[index - 1].getBoundingClientRect();
    return Math.abs(rect.top - previousRect.bottom) < 0.01;
  }))).toBe(true);
});

test("uses the same rounded height at 125 percent zoom", async ({ mount }) => {
  const component = await mount(<DataTableScrollHarness zoom={1.25} />);
  const firstDataRow = component.locator(".sp-grid tbody tr:has(td.sp-cell)").first();

  await expect(firstDataRow).toBeVisible();
  await expect.poll(() => firstDataRow.evaluate((row) => row.getBoundingClientRect().height)).toBe(34);
});