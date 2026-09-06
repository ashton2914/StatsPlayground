import { expect, test } from "@playwright/experimental-ct-react";

import { FitModelProfiler } from "../../src/components/fitModel/FitModelProfiler";
import "../../src/components/fitModel/fitModel.css";
import type { FitModelSnapshot } from "../../src/types/fitModel";

const snapshot: FitModelSnapshot = {
  coefficientTermIds: ["Intercept", "A", "B"],
  coefficients: [1, 2, 3],
  covariance: [
    [0.04, 0, 0],
    [0, 0.01, 0],
    [0, 0, 0.01],
  ],
  meanSquareError: 0.25,
  errorDegreesOfFreedom: 10,
  confidenceLevel: 0.95,
  terms: [
    { termId: "A", kind: "main", columnNames: ["A"], label: "A" },
    { termId: "B", kind: "main", columnNames: ["B"], label: "B" },
  ],
  centering: { method: "none", centers: [] },
  predictorRanges: [
    { columnName: "A", minimum: 0, maximum: 4, mean: 2 },
    { columnName: "B", minimum: 1, maximum: 7, mean: 4 },
  ],
};

function profiler(value: FitModelSnapshot = snapshot) {
  return (
    <div style={{ width: "100%", minWidth: 0 }}>
      <FitModelProfiler snapshot={value} responseName="Y" />
    </div>
  );
}

test("synchronizes slider and number input, then warns on extrapolation", async ({ mount }) => {
  const component = await mount(profiler());
  const aColumn = component.locator('[data-profiler-column="A"]');
  const range = aColumn.locator('input[type="range"]');
  const number = aColumn.locator('input[type="number"]');

  await expect(number).toHaveValue("2");
  await range.fill("3");
  await expect(number).toHaveValue("3");
  await expect(component.locator(".sp-fit-model-profiler-result dd").first()).toHaveText("19");

  await number.fill("9");
  await expect(component.getByRole("status")).toContainText(/A/);
  await expect(range).toHaveValue("4");
});

test("preserves point prediction when intervals are not estimable", async ({ mount }) => {
  const component = await mount(profiler({
    ...snapshot,
    covariance: null,
    meanSquareError: null,
    errorDegreesOfFreedom: 0,
  }));

  await expect(component.locator(".sp-fit-model-profiler-result dd").first()).toHaveText("17");
  await expect(component.getByText("Not estimable", { exact: true })).toHaveCount(2);
});

for (const viewport of [
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
]) {
  test(`renders profiler charts without overflow at ${viewport.width}x${viewport.height}`, async ({ mount, page }) => {
    await page.setViewportSize(viewport);
    const component = await mount(profiler());
    const canvases = component.locator('[data-chart-kind="predictionProfiler"] canvas');
    await expect(canvases).toHaveCount(2);
    await expect(canvases.first()).toBeVisible();
    await expect.poll(async () => canvases.first().evaluate((canvas) => {
      const context = (canvas as HTMLCanvasElement).getContext("2d");
      if (!context) return 0;
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let visible = 0;
      for (let index = 3; index < pixels.length; index += 4) {
        if (pixels[index] > 0) visible += 1;
      }
      return visible;
    })).toBeGreaterThan(100);

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    const columns = await component.locator(".sp-fit-model-profiler-column").evaluateAll((elements) => elements.map((element) => {
      const box = element.getBoundingClientRect();
      return { left: box.left, right: box.right, width: box.width };
    }));
    expect(columns.every((column) => column.left >= -1 && column.right <= viewport.width + 1 && column.width > 0)).toBe(true);
  });
}
