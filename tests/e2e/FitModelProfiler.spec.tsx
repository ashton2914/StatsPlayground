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

const replacementSnapshot: FitModelSnapshot = {
  ...snapshot,
  coefficients: [10, 1, 2],
  predictorRanges: [
    { columnName: "A", minimum: 0, maximum: 2, mean: 1 },
    { columnName: "B", minimum: 0, maximum: 4, mean: 2 },
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

test("links every chart and gives them the same Y domain", async ({ mount }) => {
  const component = await mount(profiler());
  const columns = component.locator(".sp-fit-model-profiler-column");
  const canvases = columns.locator("canvas");
  await expect(canvases).toHaveCount(2);

  const initialImages = await canvases.evaluateAll((elements) => (
    elements.map((element) => (element as HTMLCanvasElement).toDataURL())
  ));
  const initialDomains = await columns.evaluateAll((elements) => elements.map((element) => ({
    min: element.getAttribute("data-y-domain-min"),
    max: element.getAttribute("data-y-domain-max"),
  })));
  expect(initialDomains[0]).toEqual(initialDomains[1]);

  await component.locator('[data-profiler-column="A"] input[type="range"]').fill("3");
  await expect(component.locator(".sp-fit-model-profiler-result dd").first()).toHaveText("19");
  await expect.poll(async () => canvases.evaluateAll((elements) => (
    elements.map((element) => (element as HTMLCanvasElement).toDataURL())
  ))).not.toEqual(initialImages);

  const updatedImages = await canvases.evaluateAll((elements) => (
    elements.map((element) => (element as HTMLCanvasElement).toDataURL())
  ));
  expect(updatedImages[0]).not.toEqual(initialImages[0]);
  expect(updatedImages[1]).not.toEqual(initialImages[1]);
  const updatedDomains = await columns.evaluateAll((elements) => elements.map((element) => ({
    min: Number(element.getAttribute("data-y-domain-min")),
    max: Number(element.getAttribute("data-y-domain-max")),
    markerX: Number(element.getAttribute("data-marker-x")),
    marker: Number(element.getAttribute("data-marker-y")),
    curveStart: Number(element.getAttribute("data-curve-start-y")),
    curveEnd: Number(element.getAttribute("data-curve-end-y")),
  })));
  expect(
    updatedDomains.map(({ min, max, markerX, marker }) => ({ min, max, markerX, marker })),
  ).toEqual([
    { min: updatedDomains[0].min, max: updatedDomains[0].max, markerX: 3, marker: 19 },
    { min: updatedDomains[0].min, max: updatedDomains[0].max, markerX: 4, marker: 19 },
  ]);
  expect(updatedDomains[0].marker).toBe(19);
  expect(updatedDomains[0].marker).toBeGreaterThanOrEqual(updatedDomains[0].min);
  expect(updatedDomains[0].marker).toBeLessThanOrEqual(updatedDomains[0].max);
  expect(updatedDomains.map(({ curveStart, curveEnd }) => [curveStart, curveEnd])).toEqual([
    [13, 21],
    [10, 28],
  ]);
});

test("resets controls, curves, markers, domain, and summary coherently on snapshot replacement", async ({ mount }) => {
  const component = await mount(profiler());
  await component.update(profiler(replacementSnapshot));

  await expect(component.locator('[data-profiler-column="A"] input[type="number"]')).toHaveValue("1");
  await expect(component.locator('[data-profiler-column="B"] input[type="number"]')).toHaveValue("2");
  await expect(component.locator(".sp-fit-model-profiler-result dd").first()).toHaveText("15");
  const chartState = await component.locator(".sp-fit-model-profiler-column").evaluateAll((elements) => (
    elements.map((element) => ({
      min: Number(element.getAttribute("data-y-domain-min")),
      max: Number(element.getAttribute("data-y-domain-max")),
      markerX: Number(element.getAttribute("data-marker-x")),
      marker: Number(element.getAttribute("data-marker-y")),
      curveStart: Number(element.getAttribute("data-curve-start-y")),
      curveEnd: Number(element.getAttribute("data-curve-end-y")),
    }))
  ));
  expect(chartState[0].marker).toBe(15);
  expect(chartState[1].marker).toBe(15);
  expect(chartState[0].marker).toBeGreaterThanOrEqual(chartState[0].min);
  expect(chartState[0].marker).toBeLessThanOrEqual(chartState[0].max);
  expect(chartState[0]).toMatchObject({ markerX: 1, curveStart: 14, curveEnd: 16 });
  expect(chartState[1]).toMatchObject({ markerX: 2, curveStart: 11, curveEnd: 19 });
  expect({ min: chartState[0].min, max: chartState[0].max }).toEqual({
    min: chartState[1].min,
    max: chartState[1].max,
  });
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
    const track = component.locator(".sp-fit-model-profiler-track");
    await expect(track).toBeVisible();
    const trackMetrics = await track.evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }));
    const columns = await component.locator(".sp-fit-model-profiler-column").evaluateAll((elements) => elements.map((element) => {
      const box = element.getBoundingClientRect();
      return { left: box.left, right: box.right, top: box.top, width: box.width };
    }));
    expect(columns.every((column) => column.width >= 280 && column.width <= 380)).toBe(true);
    expect(columns.every((column) => Math.abs(column.top - columns[0].top) <= 1)).toBe(true);
    expect(columns[0].left).toBeGreaterThanOrEqual(-1);
    expect(columns[0].right).toBeLessThanOrEqual(viewport.width + 1);
    const profilerBox = await component.locator(".sp-fit-model-profiler").evaluate((element) => {
      const box = element.getBoundingClientRect();
      return { width: box.width };
    });
    if (viewport.width >= 1000) {
      expect(trackMetrics.scrollWidth).toBeLessThanOrEqual(trackMetrics.clientWidth + 1);
    } else {
      expect(trackMetrics.scrollWidth).toBeGreaterThan(trackMetrics.clientWidth);
    }
    expect(profilerBox.width).toBeLessThanOrEqual(viewport.width + 1);
  });
}
