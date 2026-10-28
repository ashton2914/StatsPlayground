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
  await wrapper.hover();
  for (let index = 0; index < 20; index += 1) {
    await component.page().mouse.wheel(0, index % 2 === 0 ? 10_000 : -10_000);
  }
  await component.page().mouse.wheel(0, 10_000);

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

test("an uncached window still paints when a distant viewport cannot enter the cache",async({mount})=>{
 const component=await mount(<DataTableScrollHarness rows={5000} rejectCache/>);
 await expect(component.getByText("row-1",{exact:true})).toBeVisible();
 await component.locator(".sp-grid-wrapper").dispatchEvent("wheel",{deltaY:200000,deltaMode:0});
 await expect.poll(()=>component.page().evaluate(()=>(window as any).__scrollSnapshot().viewports["scroll-dataset"].logicalStart)).toBeGreaterThan(4900);
 await expect.poll(()=>component.page().evaluate(()=>(window as any).__scrollRequests.map((request:any)=>request.start))).toContain(4500);
 await expect(component.getByText("row-5000",{exact:true})).toBeVisible();
 expect(await component.page().evaluate(()=>(window as any).__scrollRequests.filter((request:any)=>request.start===4500).length)).toBe(1);
});


test("large string rows use smaller distant pages while covering the viewport",async({mount,page})=>{
 const component=await mount(<DataTableScrollHarness rows={10000} valuePadding={10000}/>);
 await expect(component.locator('td[data-row="0"][data-col="0"]')).toContainText("row-1x");
 const reference=component.locator(".sp-formula-ref-input");await reference.fill("A5501");await reference.press("Enter");
 await expect(component.locator('td[data-row="5500"][data-col="0"]')).toContainText("row-5501x");
 const active=await page.evaluate(()=>(window as any).__scrollRequests.filter((request:any)=>!request.prefetch&&request.start>0));
 expect(active.length).toBeGreaterThan(0);expect(active.every((request:any)=>request.count<=128)).toBe(true);
 await expect(component.locator(".sp-grid tbody tr.sp-data-row")).not.toHaveCount(0);
});
