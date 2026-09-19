import { test, expect } from "@playwright/experimental-ct-react";
import type { Page } from "@playwright/test";
import { TabulateVirtualHarness, type VirtualEvidence } from "./TabulateVirtualHarness";

test.use({ viewport: { width: 1500, height: 800 } });
test.setTimeout(20_000);

async function evidence(page: Page): Promise<VirtualEvidence> {
  return JSON.parse(await page.getByTestId("evidence").textContent() ?? "{}");
}
async function position(page: Page, axis: "Row" | "Column", value: number) {
  const input = page.getByRole("spinbutton", { name: `${axis} position`, exact: true });
  await input.fill(String(value));
  await input.press("Enter");
}
async function ready(page: Page) {
  await expect(page.getByRole("grid", { name: "Tabulate results" })).toBeVisible();
  await expect(page.locator('[data-tabulate-cell="0:0:0"]')).toHaveText("0.07");
}

test("million by hundred-thousand session keeps DOM and every transport window bounded", async ({ mount, page }, testInfo) => {
  await mount(<TabulateVirtualHarness />);
  await ready(page);
  const grid = page.getByRole("grid");
  await expect(grid).toHaveAttribute("aria-rowcount", "1000004");
  const count = await page.locator("[data-tabulate-cell]").count();
  expect(count).toBeGreaterThan(0);
  expect(count).toBeLessThan(1500);
  const viewport = await page.locator(".sp-tabulate-virtual-viewport").boundingBox();
  const renderedRows = await page.locator("[data-tabulate-cell]").evaluateAll((cells) => new Set(cells.map((cell) => cell.getAttribute("data-tabulate-cell")!.split(":")[0])).size);
  const renderedColumns = await page.locator("[data-tabulate-cell]").evaluateAll((cells) => new Set(cells.map((cell) => cell.getAttribute("data-tabulate-cell")!.split(":")[1])).size);
  expect(renderedRows).toBeLessThanOrEqual(Math.ceil(viewport!.height / 30) + 2);
  expect(renderedColumns).toBeLessThanOrEqual(Math.ceil(viewport!.width / 208) + 1);
  expect(count).toBe(renderedRows * renderedColumns * 2);
  expect(await grid.locator("*").count()).toBeLessThan(2500);
  const calls = await evidence(page);
  expect(calls.legacy).toBe(0);
  expect(calls.windows.every((request) => request.rowCount <= 128 && request.columnCount <= 64 && request.rowCount * request.columnCount * 2 <= 16384)).toBe(true);
  await expect.poll(async () => new Set((await evidence(page)).totals).size).toBe(3);
  await expect(page.locator(".sp-tabulate-total-cell").first()).toContainText("9,876");
  await testInfo.attach("dom-bound", { body: JSON.stringify({ interiorCells: count, renderedRows, renderedColumns, viewport, descendants: await grid.locator("*").count(), logicalCells: 200_000_000_000, calls }), contentType: "application/json" });
  await page.screenshot({ path: testInfo.outputPath("desktop.png") });
});

test("both logical axes reach deep and final members without pixel spacers", async ({ mount, page }) => {
  await mount(<TabulateVirtualHarness />);
  await ready(page);
  await position(page, "Row", 999991);
  await position(page, "Column", 99991);
  await expect(page.locator('[data-tabulate-cell="999990:99990:0"]')).toHaveText("1,099,980.07");
  await position(page, "Row", 1000000);
  await position(page, "Column", 100000);
  await expect(page.locator('[data-tabulate-cell="999999:99999:0"]')).toBeVisible();
  expect(await page.locator("[data-tabulate-cell]").count()).toBe(2);
  await page.getByRole("grid").press("Control+Home");
  await expect(page.locator('[data-tabulate-cell="0:0:0"]')).toHaveText("0.07");
});

test("hierarchy continuation and resize preserve logical coordinates", async ({ mount, page }) => {
  await mount(<TabulateVirtualHarness />);
  await ready(page);
  await position(page, "Row", 102);
  await position(page, "Column", 102);
  await expect(page.locator('[data-tabulate-cell="101:101:0"]')).toHaveText("202.07");
  await expect(page.getByRole("rowheader", { name: "Region 1", exact: true }).first()).toHaveAttribute("data-continues-before", "true");
  await expect(page.getByRole("columnheader", { name: "Category 1", exact: true }).first()).toHaveAttribute("data-continues-before", "true");
  const before = (await evidence(page)).windows.filter((request) => request.rowStart === 101 && request.columnStart === 101).at(-1)!;
  await page.getByRole("button", { name: "Resize", exact: true }).click();
  await expect.poll(async () => (await evidence(page)).windows.some((request) => request.rowStart === 101 && request.columnStart === 101 && request.columnCount !== before.columnCount)).toBe(true);
  await expect(page.getByRole("spinbutton", { name: "Row position", exact: true })).toHaveValue("102");
  await expect(page.getByRole("spinbutton", { name: "Column position", exact: true })).toHaveValue("102");
});

test("superseded A is cancelled and cannot overwrite completed B", async ({ mount, page }) => {
  await mount(<TabulateVirtualHarness mode="delayed" />);
  await ready(page);
  await position(page, "Row", 101);
  await expect.poll(async () => (await evidence(page)).windows.some((request) => request.rowStart === 100)).toBe(true);
  await position(page, "Row", 201);
  await expect(page.locator('[data-tabulate-cell="200:0:0"]')).toHaveText("200.07");
  const calls = await evidence(page);
  expect(calls.cancelled).toContain(calls.windows.find((request) => request.rowStart === 100)!.requestId);
  await page.getByRole("button", { name: "Complete A" }).click();
  await expect(page.locator('[data-tabulate-cell="200:0:0"]')).toHaveText("200.07");
  await expect(page.locator('[data-tabulate-cell="100:0:0"]')).toHaveCount(0);
});

test("explicit cancellation stays cancelled until retry", async ({ mount, page }) => {
  await mount(<TabulateVirtualHarness mode="delayed" />);
  await ready(page);
  await position(page, "Row", 101);
  await expect.poll(async () => (await evidence(page)).windows.some((request) => request.rowStart === 100)).toBe(true);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Tabulate request cancelled.");
  await page.getByRole("button", { name: "Complete A" }).click();
  await expect(page.locator('[data-tabulate-cell="100:0:0"]')).toHaveCount(0);
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect.poll(async () => (await evidence(page)).prepares.length).toBe(2);
});

test("generation and definition changes fence late tiles and release sessions", async ({ mount, page }) => {
  await mount(<TabulateVirtualHarness mode="delayed" />);
  await ready(page);
  await position(page, "Row", 101);
  await expect.poll(async () => (await evidence(page)).windows.some((request) => request.rowStart === 100)).toBe(true);
  await page.getByRole("button", { name: "Generation", exact: true }).click();
  await expect.poll(async () => (await evidence(page)).prepares.at(-1)?.sourceGeneration).toBe(8);
  await page.getByRole("button", { name: "Complete A" }).click();
  await expect(page.locator('[data-tabulate-cell="0:0:0"]')).toHaveText("0.08");
  await page.getByRole("button", { name: "Definition", exact: true }).click();
  await expect.poll(async () => (await evidence(page)).prepares.at(-1)?.includeRowTotals).toBe(false);
  await expect.poll(async () => (await evidence(page)).released).toEqual(["session-1", "session-2"]);
});

test("expired session reports expiry and reprepares on retry at the same position", async ({ mount, page }) => {
  await mount(<TabulateVirtualHarness mode="expiry" />);
  await ready(page);
  await position(page, "Row", 201);
  await expect(page.getByRole("status")).toContainText("Tabulate session expired. Retry to prepare it again.");
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.locator('[data-tabulate-cell="200:0:0"]')).toHaveText("200.07");
  expect((await evidence(page)).released).toContain("session-1");
});

test("resource refusal and timeout have actionable retry states", async ({ mount, page }) => {
  const component = await mount(<TabulateVirtualHarness mode="resource" />);
  await expect(page.getByRole("status")).toContainText("Member indexes exceed the memory budget.");
  await expect(page.getByRole("status")).toContainText("Reduce column cardinality or expensive statistics, then retry.");
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await ready(page);
  await component.unmount();
  await mount(<TabulateVirtualHarness mode="timeout" />);
  await expect(page.getByRole("status")).toContainText("Tabulate query timed out.");
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await ready(page);
});

test("replacement and unmount release every owned session", async ({ mount, page }) => {
  await mount(<TabulateVirtualHarness />);
  await ready(page);
  await page.getByRole("button", { name: "Replace", exact: true }).click();
  await expect.poll(async () => (await evidence(page)).prepares.length).toBe(2);
  await page.getByRole("button", { name: "Unmount", exact: true }).click();
  await expect.poll(async () => (await evidence(page)).released).toEqual(["session-1", "session-2"]);
});

test("totals stay pending independently of ready interior cells", async ({ mount, page }) => {
  await mount(<TabulateVirtualHarness mode="totals" />);
  await ready(page);
  await expect(page.getByRole("status")).toContainText("Loading totals...");
  await expect(page.locator(".sp-tabulate-total-cell").first()).toHaveAttribute("aria-busy", "true");
  await page.getByRole("button", { name: "Complete A" }).click();
  await expect(page.locator(".sp-tabulate-total-cell").first()).toContainText("9,876");
});

test("read-only navigation preserves definitions and disables export", async ({ mount, page }) => {
  await mount(<TabulateVirtualHarness readOnly />);
  await ready(page);
  const definitions = await page.getByTestId("definitions").textContent();
  await expect(page.getByRole("button", { name: "Export to Data Table", exact: true })).toBeDisabled();
  await expect(page.getByRole("searchbox", { name: "Search available columns", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Remove Region", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Edit Sales · Mean", exact: true })).toBeDisabled();
  await expect(page.getByRole("checkbox", { name: "Row totals", exact: true })).toBeDisabled();
  await position(page, "Row", 501);
  await expect(page.locator('[data-tabulate-cell="500:0:0"]')).toHaveText("500.07");
  const visibleRows = page.getByRole("combobox", { name: "Visible rows", exact: true });
  await expect(visibleRows).toBeEnabled();
  await visibleRows.selectOption("1");
  await expect.poll(async () => (await evidence(page)).prepares.at(-1)?.rowFields).toEqual(["Region"]);
  expect(await page.getByTestId("definitions").textContent()).toBe(definitions);
  expect((await evidence(page)).exports).toEqual([]);
});

test("project reset unmounts runtime and reopen preserves only durable definitions", async ({ mount, page }) => {
  await mount(<TabulateVirtualHarness readOnly />);
  await ready(page);
  const definitions = await page.getByTestId("definitions").textContent();
  await position(page, "Row", 501);
  await expect(page.locator('[data-tabulate-cell="500:0:0"]')).toHaveText("500.07");
  await page.getByRole("button", { name: "Reset project", exact: true }).click();
  await expect(page.getByRole("grid")).toHaveCount(0);
  await expect.poll(async () => (await evidence(page)).released).toEqual(["session-1"]);
  await expect(page.getByTestId("definitions")).toHaveText("[]");
  await page.getByRole("button", { name: "Reopen project", exact: true }).click();
  await ready(page);
  expect(await page.getByTestId("definitions").textContent()).toBe(definitions);
  expect((await evidence(page)).prepares).toHaveLength(2);
  await expect(page.getByRole("button", { name: "Export to Data Table", exact: true })).toBeDisabled();
});

test("export sends full definition and session identity without legacy cell limits", async ({ mount, page }) => {
  await mount(<TabulateVirtualHarness />);
  await ready(page);
  await page.getByRole("combobox", { name: "Visible rows", exact: true }).selectOption("1");
  await expect.poll(async () => (await evidence(page)).prepares.at(-1)?.rowFields).toEqual(["Region"]);
  const button = page.getByRole("button", { name: "Export to Data Table", exact: true });
  await expect(button).toBeEnabled();
  await button.click();
  await expect.poll(async () => (await evidence(page)).exports.length).toBe(1);
  const exported = (await evidence(page)).exports[0];
  expect(exported.request.rowFields).toEqual(["Region", "Store"]);
  expect(exported.request.columnFields).toEqual(["Category", "Product"]);
  expect(exported.request).not.toHaveProperty("maxResultCells");
  expect(exported.request).not.toHaveProperty("cells");
  expect(exported.session).toEqual({ sessionId: "session-2", fingerprint: "fp-2", sourceGeneration: 7 });
  expect((await evidence(page)).legacy).toBe(0);
});

test("preparation polls and narrow layout stays bounded", async ({ mount, page }, testInfo) => {
  await page.setViewportSize({ width: 760, height: 800 });
  await mount(<TabulateVirtualHarness mode="prepare" />);
  await ready(page);
  expect(await page.locator("[data-tabulate-cell]").count()).toBeLessThan(1500);
  const viewport = await page.locator(".sp-tabulate-virtual-viewport").boundingBox();
  const firstValue = await page.locator('[data-tabulate-cell="0:0:0"]').boundingBox();
  expect(firstValue!.x + firstValue!.width).toBeLessThanOrEqual(viewport!.x + viewport!.width);
  await page.screenshot({ path: testInfo.outputPath("narrow.png") });
});

test("Chinese resource state is localized", async ({ mount, page }) => {
  await mount(<TabulateVirtualHarness mode="resource" locale="zh-CN" />);
  await expect(page.getByRole("status")).toContainText("成员索引超出内存预算。");
  await expect(page.getByRole("button", { name: "重试", exact: true })).toBeVisible();
});

test("totals concurrency remains bounded when cancellation is rejected", async ({ mount, page }) => {
  await mount(<TabulateVirtualHarness mode="totalsPressure" />);
  await ready(page);
  for (const row of [201, 401, 601, 801]) {
    await position(page, "Row", row);
    await expect(page.locator(`[data-tabulate-cell="${row - 1}:0:0"]`)).toHaveText(`${row - 1}.07`);
  }
  expect((await evidence(page)).maximumActiveTotals).toBeLessThanOrEqual(3);
  await page.getByRole("button", { name: "Complete A" }).click();
  await expect.poll(async () => (await evidence(page)).totals.length).toBe(6);
});

test("a ready tile cannot erase a totals error", async ({ mount, page }) => {
  await mount(<TabulateVirtualHarness mode="totalsError" />);
  await expect(page.getByRole("status")).toContainText("Tabulate query timed out.");
  await expect.poll(async () => (await evidence(page)).released).toEqual(["session-1"]);
  await page.getByRole("button", { name: "Complete A" }).click();
  await expect(page.locator('[data-tabulate-cell="0:0:0"]')).toHaveText("0.07");
  await expect(page.getByRole("status")).toContainText("Tabulate query timed out.");
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
});

test("a preparation completing after unmount is released without resurrection", async ({ mount, page }) => {
  await mount(<TabulateVirtualHarness mode="latePrepare" />);
  await expect.poll(async () => (await evidence(page)).prepares.length).toBe(1);
  await page.getByRole("button", { name: "Unmount", exact: true }).click();
  await page.getByRole("button", { name: "Complete A" }).click();
  await expect.poll(async () => (await evidence(page)).released).toEqual(["session-1"]);
  expect((await evidence(page)).windows).toEqual([]);
});

test("resize does not silently retry a failed query", async ({ mount, page }) => {
  await mount(<TabulateVirtualHarness mode="timeout" />);
  await expect(page.getByRole("status")).toContainText("Tabulate query timed out.");
  await page.getByRole("button", { name: "Resize", exact: true }).click();
  await expect(page.getByTestId("workspace")).toHaveCSS("width", "1100px");
  await expect(page.getByRole("status")).toContainText("Tabulate query timed out.");
  await expect(page.getByRole("grid")).not.toHaveAttribute("aria-busy", "true");
  expect((await evidence(page)).windows).toHaveLength(1);
});

test("wheel and logical scrollbar navigate both axes", async ({ mount, page }) => {
  await mount(<TabulateVirtualHarness />);
  await ready(page);
  await page.locator(".sp-tabulate-virtual-viewport").dispatchEvent("wheel", { deltaY: 60, deltaX: 104 });
  await expect(page.locator('[data-tabulate-cell="2:1:0"]')).toHaveText("3.07");
  await page.getByRole("scrollbar", { name: "Column position", exact: true }).focus();
  await page.keyboard.press("End");
  await expect(page.locator('[data-tabulate-cell="2:99999:0"]')).toHaveText("100,001.07");
  await page.getByRole("grid").press("PageDown");
  await expect(page.getByRole("spinbutton", { name: "Row position", exact: true })).not.toHaveValue("3");
});