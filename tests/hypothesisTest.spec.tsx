import { expect, test, type Locator } from "@playwright/experimental-ct-react";

import { HypothesisTestDialogHarness, HypothesisTestHarness } from "./HypothesisTestHarness";

function relativeLuminance(color: string) {
  const channels = color.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? [];
  return channels.map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  }).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
}

function contrastRatio(foreground: string, background: string) {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05)
    / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
}

async function paintedPixelCount(canvas: Locator) {
  return canvas.evaluate((node) => {
    const context = (node as HTMLCanvasElement).getContext("2d");
    if (!context) return 0;
    const pixels = context.getImageData(0, 0, context.canvas.width, context.canvas.height).data;
    let painted = 0;
    for (let index = 3; index < pixels.length; index += 4) {
      if (pixels[index] > 0) painted += 1;
    }
    return painted;
  });
}

for (const mode of ["independent", "paired", "completeBlock"] as const) {
  test(`renders nonblank ${mode} result and diagnostic charts`, async ({ mount }) => {
    const component = await mount(<HypothesisTestHarness mode={mode} />);
    await expect(component.locator("[data-graph-strategy='custom']")).toHaveCount(3);
    for (const kind of ["main", "diagnostic", "qq"]) {
      const canvas = component.locator(`[data-chart-kind="${kind}"] canvas`);
      await expect(canvas).toBeVisible();
      await expect.poll(() => paintedPixelCount(canvas)).toBeGreaterThan(500);
    }
    await expect(component.getByRole("table", { name: "Primary result" })).toBeVisible();
  });
}

test("keeps sensitivity conflict and post-hoc results visible", async ({ mount }) => {
  const component = await mount(<HypothesisTestHarness mode="conflictPostHoc" />);
  await expect(component.getByRole("alert")).toContainText("statisticallySensitive");
  await expect(component.getByRole("table", { name: "Sensitivity analysis" })).toContainText("mannWhitneyU");
  await expect(component.getByRole("table", { name: "Post-hoc comparisons: tukeyKramer" })).toContainText("Control vs Treatment");
});

test("renders loading, source-missing, and error states", async ({ mount }) => {
  const loading = await mount(<HypothesisTestHarness mode="loading" />);
  await expect(loading.getByRole("status")).toContainText("Running hypothesis test");
  await loading.unmount();
  const missing = await mount(<HypothesisTestHarness mode="sourceMissing" />);
  await expect(missing.getByRole("alert")).toContainText("source dataset is unavailable");
  await missing.unmount();
  const error = await mount(<HypothesisTestHarness mode="error" />);
  await expect(error.getByRole("alert")).toContainText("Not enough complete pairs");
});

test("keeps charts and wide tables inside a narrow viewport", async ({ mount, page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const component = await mount(<HypothesisTestHarness mode="conflictPostHoc" />);
  await expect(component.locator('[data-chart-kind="main"] canvas')).toBeVisible();
  const overflow = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    body: document.body.scrollWidth - document.body.clientWidth,
  }));
  expect(overflow.document, JSON.stringify(overflow)).toBeLessThanOrEqual(1);
  expect(overflow.body, JSON.stringify(overflow)).toBeLessThanOrEqual(1);
});

test("keeps selected and unselected method selectors visually distinct", async ({ mount }) => {
  const component = await mount(<HypothesisTestDialogHarness />);
  const selected = component.getByRole("button", { name: "Automatic", exact: true });
  await expect(selected).toHaveAttribute("aria-pressed", "true");

  for (const theme of ["light", "dark"] as const) {
    const styles = await component.evaluate((root, activeTheme) => {
      document.documentElement.dataset.theme = activeTheme;
      const selectedButton = root.querySelector<HTMLButtonElement>('[aria-pressed="true"]');
      const unselectedButton = Array.from(root.querySelectorAll<HTMLButtonElement>('[aria-pressed="false"]'))
        .find((button) => button.textContent?.trim() === "Guided");
      if (!selectedButton || !unselectedButton) throw new Error("Expected segmented control buttons");
      const selectedStyle = getComputedStyle(selectedButton);
      const unselectedStyle = getComputedStyle(unselectedButton);
      return {
        selectedBackground: selectedStyle.backgroundColor,
        selectedColor: selectedStyle.color,
        unselectedBackground: unselectedStyle.backgroundColor,
      };
    }, theme);

    expect(styles.selectedBackground).not.toBe("rgba(0, 0, 0, 0)");
    expect(styles.selectedBackground).not.toBe(styles.unselectedBackground);
    expect(contrastRatio(styles.selectedColor, styles.selectedBackground)).toBeGreaterThanOrEqual(4.5);
  }
});