import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { expect, test } from "@playwright/experimental-ct-react";
import type { Locator } from "@playwright/test";

import { useLayoutPreferencesStore } from "../src/stores/useLayoutPreferencesStore";
import { HistoryPanelHarness } from "./HistoryPanelHarness";

const historyPanelSource = readFileSync(
  new URL("../src/components/HistoryPanel.tsx", import.meta.url),
  "utf8",
);
const appCssSource = readFileSync(
  new URL("../src/App.css", import.meta.url),
  "utf8",
);

async function readStoredLayoutPreferences(page: { evaluate: <T>(pageFunction: () => T) => Promise<T> }) {
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
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.evaluate(() => {
    localStorage.clear();
  });
  useLayoutPreferencesStore.setState({ sizes: {} });
});

test("HistoryPanel removes legacy divider/document listener implementation and old divider CSS", async () => {
  assert.doesNotMatch(historyPanelSource, /const\s+draggingRef\s*=\s*useRef\(false\)/);
  assert.doesNotMatch(historyPanelSource, /const\s+handleDividerMouseDown\s*=\s*useCallback\(/);
  assert.doesNotMatch(historyPanelSource, /document\.addEventListener\("mousemove",\s*onMouseMove\)/);
  assert.doesNotMatch(historyPanelSource, /document\.addEventListener\("mouseup",\s*onMouseUp\)/);
  assert.doesNotMatch(historyPanelSource, /className="history-divider"/);
  assert.doesNotMatch(appCssSource, /\.history-divider\s*\{/);
  assert.match(historyPanelSource, /className="history-section"\s+style=\{\{ flex: `0 0 \$\{historyPct\}%` \}\}/);
  assert.match(historyPanelSource, /className="snapshot-section"\s+style=\{\{ flex: `0 0 \$\{100 - historyPct\}%` \}\}/);
});

test("HistoryPanel splitter preserves visible sections, 15-85 clamp, persistence, reset, and keyboard controls", async ({ mount, page }) => {
  let component = await mount(<HistoryPanelHarness />);

  const separator = component.getByRole("separator", { name: "Resize history and snapshots panel" });
  await expect(separator).toHaveAttribute("aria-orientation", "horizontal");
  await expect(separator).toHaveAttribute("aria-valuemin", "15");
  await expect(separator).toHaveAttribute("aria-valuemax", "85");
  await expect(separator).toHaveAttribute("aria-valuenow", "60");

  const historySection = component.locator(".history-section");
  const snapshotSection = component.locator(".snapshot-section");
  const historyBox = await historySection.boundingBox();
  const snapshotBox = await snapshotSection.boundingBox();
  expect((historyBox?.height ?? 0) > 0).toBeTruthy();
  expect((snapshotBox?.height ?? 0) > 0).toBeTruthy();
  await expect(component.getByText("Edited dataset rows")).toBeVisible();
  await expect(component.getByRole("button", { name: "+" })).toBeVisible();

  const firstSnapshot = component.locator(".snapshot-item").first();
  await firstSnapshot.click({ button: "right" });
  await expect(component.getByTestId("menu-id")).toHaveText("snapshot-1");

  const downDrag = await startSeparatorDrag(separator, 0, 300, 41);
  await expect(separator).toHaveAttribute("aria-valuenow", "85");
  await expect.poll(async () => readStoredLayoutPreferences(page)).toEqual(null);
  await endSeparatorDrag(separator, 41, downDrag.movedX, downDrag.movedY);
  await expect.poll(async () => readStoredLayoutPreferences(page)).toEqual({
    version: 1,
    sizes: {
      "history.stack": 85,
    },
  });

  await component.unmount();
  component = await mount(<HistoryPanelHarness />);

  const persistedSeparator = component.getByRole("separator", { name: "Resize history and snapshots panel" });
  await expect(persistedSeparator).toHaveAttribute("aria-valuenow", "85");

  const upDrag = await startSeparatorDrag(persistedSeparator, 0, -400, 52);
  await expect(persistedSeparator).toHaveAttribute("aria-valuenow", "15");
  await endSeparatorDrag(persistedSeparator, 52, upDrag.movedX, upDrag.movedY);
  await expect.poll(async () => readStoredLayoutPreferences(page)).toEqual({
    version: 1,
    sizes: {
      "history.stack": 15,
    },
  });

  await persistedSeparator.press("End");
  await expect(persistedSeparator).toHaveAttribute("aria-valuenow", "85");
  await persistedSeparator.press("Home");
  await expect(persistedSeparator).toHaveAttribute("aria-valuenow", "15");
  await persistedSeparator.press("Enter");
  await expect(persistedSeparator).toHaveAttribute("aria-valuenow", "60");

  await expect.poll(async () => readStoredLayoutPreferences(page)).toEqual({
    version: 1,
    sizes: {},
  });

  const finalHistoryBox = await component.locator(".history-section").boundingBox();
  const finalSnapshotBox = await component.locator(".snapshot-section").boundingBox();
  expect((finalHistoryBox?.height ?? 0) > 0).toBeTruthy();
  expect((finalSnapshotBox?.height ?? 0) > 0).toBeTruthy();
});
