import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { expect, test } from "@playwright/experimental-ct-react";
import type { Locator } from "@playwright/test";

import { useLayoutPreferencesStore } from "../src/stores/useLayoutPreferencesStore";
import { DataTableViewPropertyManagerHarness } from "./DataTableViewPropertyManagerHarness";

const dataTableViewSource = readFileSync(
  new URL("../src/components/DataTableView.tsx", import.meta.url),
  "utf8",
);
const appCssSource = readFileSync(
  new URL("../src/App.css", import.meta.url),
  "utf8",
);

function readStoredLayoutPreferences(page: { evaluate: <T>(pageFunction: () => T) => Promise<T> }) {
  return page.evaluate(() => {
    const raw = localStorage.getItem("sp-layout-preferences-v1");
    return raw ? JSON.parse(raw) : null;
  });
}

async function startSeparatorDrag(
  separator: Locator,
  deltaX: number,
  deltaY: number,
  pointerId: number,
) {
  const box = await separator.boundingBox();
  if (!box) throw new Error("separator bounding box unavailable");

  const startX = Math.round(box.x + box.width / 2);
  const startY = Math.round(box.y + box.height / 2);
  const movedX = startX + deltaX;
  const movedY = startY + deltaY;

  await separator.dispatchEvent("pointerdown", {
    pointerId,
    pointerType: "mouse",
    button: 0,
    buttons: 1,
    clientX: startX,
    clientY: startY,
  });
  await separator.dispatchEvent("pointermove", {
    pointerId,
    pointerType: "mouse",
    buttons: 1,
    clientX: movedX,
    clientY: movedY,
  });

  return { movedX, movedY };
}

async function endSeparatorDrag(separator: Locator, pointerId: number, clientX: number, clientY: number) {
  await separator.dispatchEvent("pointerup", {
    pointerId,
    pointerType: "mouse",
    button: 0,
    buttons: 0,
    clientX,
    clientY,
  });
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => {
    localStorage.clear();
  });
  useLayoutPreferencesStore.setState({ sizes: {} });
});

test("DataTableView removes legacy inline splitter handlers and splitter class styles after migration", async () => {
  assert.doesNotMatch(dataTableViewSource, /setTableFilterWidth\(next\);\s*};\s*const onUp = \(\) => \{\s*document\.removeEventListener\("mousemove", onMove\);\s*document\.removeEventListener\("mouseup", onUp\);/s);
  assert.doesNotMatch(dataTableViewSource, /setColsPanelWidth\(next\);\s*};\s*const onUp = \(\) => \{\s*document\.removeEventListener\("mousemove", onMove\);\s*document\.removeEventListener\("mouseup", onUp\);/s);
  assert.doesNotMatch(dataTableViewSource, /className="sp-cols-panel-splitter"/);
  assert.doesNotMatch(appCssSource, /\.sp-cols-panel-splitter\s*\{/);
});

test("Data Table splitters preserve defaults, bounds, commit-only persistence, remount values, and reset", async ({ mount, page }) => {
  let component = await mount(<DataTableViewPropertyManagerHarness />);

  await component.getByRole("button", { name: "Filter" }).click();

  const filterSeparator = component.getByRole("separator", { name: "Resize data table filter panel" });
  const columnsSeparator = component.getByRole("separator", { name: "Resize data table columns panel" });

  await expect(filterSeparator).toHaveAttribute("aria-orientation", "vertical");
  await expect(filterSeparator).toHaveAttribute("aria-valuemin", "200");
  await expect(filterSeparator).toHaveAttribute("aria-valuemax", "500");
  await expect(filterSeparator).toHaveAttribute("aria-valuenow", "260");

  await expect(columnsSeparator).toHaveAttribute("aria-orientation", "vertical");
  await expect(columnsSeparator).toHaveAttribute("aria-valuemin", "120");
  await expect(columnsSeparator).toHaveAttribute("aria-valuemax", "600");
  await expect(columnsSeparator).toHaveAttribute("aria-valuenow", "200");

  const columnsDrag = await startSeparatorDrag(columnsSeparator, 48, 0, 11);
  await expect(columnsSeparator).toHaveAttribute("aria-valuenow", "248");
  await expect.poll(async () => readStoredLayoutPreferences(page)).toEqual(null);
  await endSeparatorDrag(columnsSeparator, 11, columnsDrag.movedX, columnsDrag.movedY);
  await expect.poll(async () => readStoredLayoutPreferences(page)).toEqual({
    version: 1,
    sizes: {
      "table.columns": 248,
    },
  });

  const filterDrag = await startSeparatorDrag(filterSeparator, -32, 0, 17);
  await expect(filterSeparator).toHaveAttribute("aria-valuenow", "228");
  await expect.poll(async () => readStoredLayoutPreferences(page)).toEqual({
    version: 1,
    sizes: {
      "table.columns": 248,
    },
  });
  await endSeparatorDrag(filterSeparator, 17, filterDrag.movedX, filterDrag.movedY);
  await expect.poll(async () => readStoredLayoutPreferences(page)).toEqual({
    version: 1,
    sizes: {
      "table.columns": 248,
      "table.filter": 228,
    },
  });

  await component.unmount();
  component = await mount(<DataTableViewPropertyManagerHarness />);
  await component.getByRole("button", { name: "Filter" }).click();

  await expect(component.getByRole("separator", { name: "Resize data table columns panel" })).toHaveAttribute("aria-valuenow", "248");
  await expect(component.getByRole("separator", { name: "Resize data table filter panel" })).toHaveAttribute("aria-valuenow", "228");

  const remountedFilterSeparator = component.getByRole("separator", { name: "Resize data table filter panel" });
  const remountedColumnsSeparator = component.getByRole("separator", { name: "Resize data table columns panel" });

  await remountedFilterSeparator.dblclick();
  await remountedColumnsSeparator.dblclick();

  await expect(remountedFilterSeparator).toHaveAttribute("aria-valuenow", "260");
  await expect(remountedColumnsSeparator).toHaveAttribute("aria-valuenow", "200");
  await expect.poll(async () => readStoredLayoutPreferences(page)).toEqual({
    version: 1,
    sizes: {},
  });
});
