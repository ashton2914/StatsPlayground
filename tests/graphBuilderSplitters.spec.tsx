import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { expect, test } from "@playwright/experimental-ct-react";

import { useLayoutPreferencesStore } from "../src/stores/useLayoutPreferencesStore";
import { GraphBuilderSplittersHarness } from "./GraphBuilderSplittersHarness";

const graphBuilderViewSource = readFileSync(
  new URL("../src/components/graphBuilder/GraphBuilderView.tsx", import.meta.url),
  "utf8",
);
const graphBuilderCssSource = readFileSync(
  new URL("../src/components/graphBuilder/graphBuilder.css", import.meta.url),
  "utf8",
);

function readStoredLayoutPreferences(page: { evaluate: <T>(pageFunction: () => T) => Promise<T> }) {
  return page.evaluate(() => {
    const raw = localStorage.getItem("sp-layout-preferences-v1");
    return raw ? JSON.parse(raw) : null;
  });
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => {
    localStorage.clear();
  });

  useLayoutPreferencesStore.setState({ sizes: {} });
});

test("GraphBuilderView removes legacy resize handlers and splitter classes after migration", async () => {
  assert.doesNotMatch(graphBuilderViewSource, /startSideResize/);
  assert.doesNotMatch(graphBuilderViewSource, /startLeftRowResize/);
  assert.doesNotMatch(graphBuilderViewSource, /document\.addEventListener\("mousemove"/);
  assert.doesNotMatch(graphBuilderViewSource, /className="gb-splitter"/);
  assert.doesNotMatch(graphBuilderViewSource, /className="gb-splitter-h"/);
  assert.doesNotMatch(graphBuilderCssSource, /\.gb-splitter\s*\{/);
  assert.doesNotMatch(graphBuilderCssSource, /\.gb-splitter-h\s*\{/);
});

test("GraphBuilderView consumes shared field palette and drop slot chrome", async () => {
  assert.match(graphBuilderViewSource, /GraphFieldPalette/);
  assert.match(graphBuilderViewSource, /GraphDropSlot/);
  assert.match(graphBuilderViewSource, /graphBuilderDragPayload/);
  assert.doesNotMatch(graphBuilderViewSource, /function Slot\(/);
});

test("Graph Builder splitter configs preserve defaults, bounds, persistence, reset, and right-rail direction", async ({ mount, page }) => {
  const component = await mount(<GraphBuilderSplittersHarness />);

  const filterSeparator = component.getByRole("separator", { name: "Resize graph builder filter panel" });
  const leftRailSeparator = component.getByRole("separator", { name: "Resize graph builder left rail" });
  const rightRailSeparator = component.getByRole("separator", { name: "Resize graph builder right rail" });
  const leftStackSeparator = component.getByRole("separator", { name: "Resize graph builder left stack" });

  await expect(filterSeparator).toHaveAttribute("aria-orientation", "vertical");
  await expect(filterSeparator).toHaveAttribute("aria-valuemin", "160");
  await expect(filterSeparator).toHaveAttribute("aria-valuemax", "500");
  await expect(filterSeparator).toHaveAttribute("aria-valuenow", "240");
  await expect(filterSeparator).toHaveAttribute("aria-valuetext", "240px");

  await expect(leftRailSeparator).toHaveAttribute("aria-valuenow", "220");
  await expect(leftRailSeparator).toHaveAttribute("aria-valuetext", "220px");

  await expect(rightRailSeparator).toHaveAttribute("aria-valuenow", "220");
  await expect(rightRailSeparator).toHaveAttribute("aria-valuetext", "220px");

  await expect(leftStackSeparator).toHaveAttribute("aria-orientation", "horizontal");
  await expect(leftStackSeparator).toHaveAttribute("aria-valuemin", "15");
  await expect(leftStackSeparator).toHaveAttribute("aria-valuemax", "85");
  await expect(leftStackSeparator).toHaveAttribute("aria-valuenow", "50");
  await expect(leftStackSeparator).toHaveAttribute("aria-valuetext", "50%");

  await filterSeparator.press("Shift+ArrowRight");
  await leftRailSeparator.press("Shift+ArrowRight");
  await rightRailSeparator.press("ArrowRight");
  await leftStackSeparator.press("Shift+ArrowDown");

  await expect(filterSeparator).toHaveAttribute("aria-valuenow", "272");
  await expect(leftRailSeparator).toHaveAttribute("aria-valuenow", "252");
  await expect(rightRailSeparator).toHaveAttribute("aria-valuenow", "212");
  await expect(leftStackSeparator).toHaveAttribute("aria-valuenow", "82");

  await expect.poll(async () => readStoredLayoutPreferences(page)).toEqual({
    version: 1,
    sizes: {
      "graphBuilder.filter": 272,
      "graphBuilder.leftRail": 252,
      "graphBuilder.rightRail": 212,
      "graphBuilder.leftStack": 82,
    },
  });

  await filterSeparator.dblclick();
  await leftRailSeparator.dblclick();
  await rightRailSeparator.dblclick();
  await leftStackSeparator.dblclick();

  await expect(filterSeparator).toHaveAttribute("aria-valuenow", "240");
  await expect(leftRailSeparator).toHaveAttribute("aria-valuenow", "220");
  await expect(rightRailSeparator).toHaveAttribute("aria-valuenow", "220");
  await expect(leftStackSeparator).toHaveAttribute("aria-valuenow", "50");
  await expect.poll(async () => readStoredLayoutPreferences(page)).toEqual({
    version: 1,
    sizes: {},
  });
});

test("Graph Builder clamps seeded out-of-range startup panel preferences across all four consumers", async ({ mount, page }) => {
  await page.evaluate(() => {
    localStorage.setItem(
      "sp-layout-preferences-v1",
      JSON.stringify({
        version: 1,
        sizes: {
          "graphBuilder.filter": 999,
          "graphBuilder.leftRail": 120,
          "graphBuilder.rightRail": 520,
          "graphBuilder.leftStack": 3,
        },
      }),
    );
  });

  useLayoutPreferencesStore.setState({
    sizes: {
      "graphBuilder.filter": 999,
      "graphBuilder.leftRail": 120,
      "graphBuilder.rightRail": 520,
      "graphBuilder.leftStack": 3,
    },
  });

  const component = await mount(<GraphBuilderSplittersHarness />);

  await expect(component.getByRole("separator", { name: "Resize graph builder filter panel" })).toHaveAttribute("aria-valuenow", "500");
  await expect(component.getByRole("separator", { name: "Resize graph builder left rail" })).toHaveAttribute("aria-valuenow", "160");
  await expect(component.getByRole("separator", { name: "Resize graph builder right rail" })).toHaveAttribute("aria-valuenow", "500");
  await expect(component.getByRole("separator", { name: "Resize graph builder left stack" })).toHaveAttribute("aria-valuenow", "15");

  await expect(component.getByTestId("graph-filter-panel")).toHaveCSS("width", "500px");
  await expect(component.getByTestId("graph-left-rail")).toHaveCSS("width", "160px");
  await expect(component.getByTestId("graph-right-rail")).toHaveCSS("width", "500px");
  await expect(component.getByTestId("graph-left-stack-top")).toHaveAttribute("style", /15%/);
  await expect(component.getByTestId("graph-left-stack-bottom")).toHaveAttribute("style", /85%/);
});