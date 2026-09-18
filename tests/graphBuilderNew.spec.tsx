import { expect, test } from "@playwright/experimental-ct-react";

import { GraphBuilderNewHarness } from "./GraphBuilderNewHarness";

for (const width of [960, 390]) {
  for (const axisFixture of ["nanoTime", "microTime", "microDuration", "unicode"] as const) {
    test(`reviewed precise labels ${axisFixture} at ${width}px`, async ({ mount, page }, testInfo) => {
      await page.setViewportSize({ width, height: 800 });
      const component = await mount(<GraphBuilderNewHarness mode="largeExact" axisFixture={axisFixture} />);
      await component.getByLabel("X field").selectOption("column-x");
      await component.getByLabel("Y field").selectOption("column-y");
      await expect(component.getByTestId("render-metrics")).toContainText('"presented":1');
      const expected = axisFixture === "nanoTime" ? ["2026-09-18 00:00:00.000000001 UTC", "2026-09-18 00:00:00.000000002 UTC"]
        : axisFixture === "microTime" ? ["2026-09-18 00:00:00.000001 UTC", "2026-09-18 00:00:00.000002 UTC"]
          : axisFixture === "microDuration" ? ["25:00:00.000001", "25:00:00.000002"] : ["\u6e29\u5ea6", "\u00e9\u0394"];
      const labels = component.getByTestId("x-axis-ticks").locator("span");
      const actual = await labels.allTextContents();
      expect(actual.length).toBeGreaterThan(0);
      if (width === 960) expect(actual).toEqual(expected);
      const boxes = await labels.evaluateAll(elements => elements.map(element => {
        const rect = element.getBoundingClientRect();
        const host = element.closest(".graph-new-canvas-host")!.getBoundingClientRect();
        const plot = element.closest(".graph-new-canvas-host")!.querySelector('[data-testid="camera-plot"]')!.getBoundingClientRect();
        return { text: element.textContent!, left: rect.left, right: rect.right, width: rect.width, bottom: rect.bottom,
          hostLeft: host.left, hostRight: host.right, hostBottom: host.bottom, plotLeft: plot.left, plotRight: plot.right,
          scrollWidth: element.scrollWidth, clientWidth: element.clientWidth };
      }));
      for (const [index, box] of boxes.entries()) {
        const position = expected.indexOf(box.text);
        expect(position).toBeGreaterThanOrEqual(0);
        const anchor = position === 0 ? box.plotLeft : box.plotRight;
        const alignedLeft = Math.max(box.hostLeft, Math.min(box.hostRight - box.width, anchor - box.width / 2));
        expect(Math.abs(box.left - alignedLeft)).toBeLessThan(1.1);
        expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth);
        expect(box.bottom).toBeLessThanOrEqual(box.hostBottom + 1);
        if (index > 0) expect(box.left).toBeGreaterThanOrEqual(boxes[index - 1].right + 6);
      }
      await component.screenshot({ path: testInfo.outputPath(`${axisFixture}-${width}.png`) });
    });
  }
}

test("phase1 typed X and raw line controls preserve mode camera and reset interpretation", async ({ mount }, testInfo) => {
  const component = await mount(<GraphBuilderNewHarness mode="mixedFields" />);
  await expect(component.getByLabel("X field").locator('option[value="text-test-time"]')).toHaveJSProperty("disabled", false);
  await component.getByLabel("X field").selectOption("text-test-time");
  await component.getByLabel("Y field").selectOption("column-y");
  const metrics = component.getByTestId("render-metrics");
  await expect(metrics).toContainText('"presented":1');
  await component.getByTestId("camera-plot").dispatchEvent("wheel", { deltaY: -100 });
  await expect(metrics).toContainText('"presented":2');
  const camera = JSON.parse((await component.getByTestId("render-request").textContent())!).cameraDomain;
  await component.getByLabel("Raw series").selectOption("pointsLine");
  await expect(metrics).toContainText('"presented":3');
  expect(JSON.parse((await component.getByTestId("render-request").textContent())!).cameraDomain).toEqual(camera);
  await component.getByLabel("X interpretation").selectOption("duration");
  await expect(metrics).toContainText('"presented":4');
  const request = JSON.parse((await component.getByTestId("render-request").textContent())!);
  expect(request.xMode).toBe("duration"); expect(request.rawMode).toBe("pointsLine"); expect(request.cameraDomain).toBeNull();
  await expect(component.getByTestId("x-axis-ticks")).toContainText("25:00:00");
  await expect(metrics).toContainText('"maximumActive":1');
  await component.screenshot({ path: testInfo.outputPath("typed-raw-controls.png") });
});

for (const width of [960, 390]) {
  test(`phase1 typed ticks fit and remain separated at ${width}px`, async ({ mount, page }, testInfo) => {
    await page.setViewportSize({ width, height: 800 });
    const component = await mount(<GraphBuilderNewHarness mode="largeExact" />);
    await component.getByLabel("X field").selectOption("column-x");
    await component.getByLabel("Y field").selectOption("column-y");
    await expect(component.getByTestId("render-metrics")).toContainText('"presented":1');
    for (const [index, mode] of ["duration", "time", "category"].entries()) {
      await component.getByLabel("X interpretation").selectOption(mode);
      await expect(component.getByTestId("render-metrics")).toContainText(`"presented":${index + 2}`);
      const ticks = component.getByTestId("x-axis-ticks");
      await expect(ticks).toBeVisible();
      if (mode === "time") await expect(ticks).toContainText("UTC");
      if (mode === "category") await expect(ticks).toContainText("Category");
      const boxes = await ticks.locator("span").evaluateAll(elements => elements.map(element => {
        const rect = element.getBoundingClientRect();
        const host = element.closest(".graph-new-canvas-host")!.getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, hostLeft: host.left, hostRight: host.right, hostBottom: host.bottom };
      }));
      expect(boxes.length).toBeGreaterThan(0);
      expect(boxes.length).toBeLessThanOrEqual(5);
      for (const [index, box] of boxes.entries()) {
        expect(box.left).toBeGreaterThanOrEqual(box.hostLeft - 1);
        expect(box.right).toBeLessThanOrEqual(box.hostRight + 1);
        expect(box.bottom).toBeLessThanOrEqual(box.hostBottom + 1);
        if (index > 0) expect(box.left).toBeGreaterThanOrEqual(boxes[index - 1].right + 6);
      }
      await component.screenshot({ path: testInfo.outputPath(`${mode}-${width}.png`) });
    }
  });
}

test("mean overlay defaults on and toggles without resetting the camera", async ({ mount }, testInfo) => {
  const component = await mount(<GraphBuilderNewHarness mode="largeExact" />);
  await component.getByLabel("X field").selectOption("column-x");
  await component.getByLabel("Y field").selectOption("column-y");
  const metrics = component.getByTestId("render-metrics");
  const toggle = component.getByRole("checkbox", { name: "Mean" });
  await expect(metrics).toContainText('"presented":1');
  await expect(toggle).toBeChecked();
  await expect(component.getByTestId("mean-legend")).toBeVisible();
  await component.getByTestId("camera-plot").dispatchEvent("wheel", { deltaY: -200 });
  await expect(metrics).toContainText('"presented":2');
  const before = JSON.parse((await component.getByTestId("render-request").textContent())!);
  expect(before.showMean).toBe(true);
  await toggle.uncheck();
  await expect(metrics).toContainText('"presented":3');
  const off = JSON.parse((await component.getByTestId("render-request").textContent())!);
  expect(off.showMean).toBe(false);
  expect(off.cameraDomain).toEqual(before.cameraDomain);
  expect(off.rendererGeneration).toBeGreaterThan(before.rendererGeneration);
  await expect(component.getByTestId("mean-legend")).toHaveCount(0);
  await toggle.check();
  await expect(metrics).toContainText('"presented":4');
  await expect(component.getByTestId("mean-legend")).toBeVisible();
  await expect(component.getByTestId("x-axis-title")).toHaveText("Diameter");
  await component.screenshot({ path: testInfo.outputPath("mean-controls.png") });
});

test("mean overlay refuses incomplete data without hiding the scatter", async ({ mount }) => {
  const component = await mount(<GraphBuilderNewHarness mode="unknownCount" />);
  await component.getByLabel("X field").selectOption("column-x");
  await component.getByLabel("Y field").selectOption("column-y");
  await expect(component.getByRole("checkbox", { name: "Mean" })).toBeDisabled();
  await expect(component.getByTestId("mean-unavailable")).toContainText("complete data");
  await expect(component.getByTestId("mean-legend")).toHaveCount(0);
  await expect(component.getByRole("img", { name: "Point plot frame" })).toBeVisible();
});

test("mean overlay fences stale decode and preserves desired camera", async ({ mount, page }) => {
  const component = await mount(<GraphBuilderNewHarness mode="largeExact" />);
  await component.getByLabel("X field").selectOption("column-x");
  await component.getByLabel("Y field").selectOption("column-y");
  const metrics = component.getByTestId("render-metrics");
  await expect(metrics).toContainText('"presented":1');
  await page.evaluate(() => {
    const original = window.createImageBitmap.bind(window);
    let hold = true;
    (window as any).meanBitmapClosed = 0;
    (window as any).createImageBitmap = async (...args: any[]) => {
      const bitmap = await (original as any)(...args);
      const close = bitmap.close.bind(bitmap);
      bitmap.close = () => { (window as any).meanBitmapClosed++; close(); };
      if (!hold) return bitmap;
      hold = false;
      return new Promise((resolve) => { (window as any).releaseMeanBitmap = () => resolve(bitmap); });
    };
  });
  await component.getByTestId("camera-plot").dispatchEvent("wheel", { deltaY: -100 });
  await expect.poll(() => page.evaluate(() => typeof (window as any).releaseMeanBitmap)).toBe("function");
  const camera = JSON.parse((await component.getByTestId("render-request").textContent())!).cameraDomain;
  await component.getByRole("checkbox", { name: "Mean" }).uncheck();
  await expect(component.getByTestId("mean-legend")).toBeVisible();
  await page.evaluate(() => (window as any).releaseMeanBitmap());
  await expect(metrics).toContainText('"presented":2');
  await expect(metrics).toContainText('"renders":3');
  await expect(metrics).toContainText('"maximumActive":1');
  const current = JSON.parse((await component.getByTestId("render-request").textContent())!);
  expect(current.showMean).toBe(false);
  expect(current.cameraDomain).toEqual(camera);
  await expect(component.getByTestId("mean-legend")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as any).meanBitmapClosed)).toBe(2);
});

test("mean overlay Chinese unavailable reason fits a narrow viewport", async ({ mount, page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const component = await mount(<GraphBuilderNewHarness mode="unknownCount" locale="zh-CN" />);
  await component.getByLabel("X field").selectOption("column-x");
  await component.getByLabel("Y field").selectOption("column-y");
  await expect(component.getByRole("checkbox", { name: "均值" })).toBeDisabled();
  await expect(component.getByTestId("mean-unavailable")).toHaveText("均值不可用：未保留完整数据。");
  const layers = component.locator(".graph-new-layers");
  const bounds = (await layers.boundingBox())!;
  const reason = (await component.getByTestId("mean-unavailable").boundingBox())!;
  expect(reason.x + reason.width).toBeLessThanOrEqual(bounds.x + bounds.width + 1);
  expect(reason.y + reason.height).toBeLessThanOrEqual(bounds.y + bounds.height + 1);
  const canvas = (await component.getByRole("img", { name: "Point plot frame" }).boundingBox())!;
  expect(canvas.y).toBeGreaterThanOrEqual(bounds.y + bounds.height);
  await component.screenshot({ path: testInfo.outputPath("mean-mobile-zh.png") });
});

test("bounded LOD status reports unknown visible count without implying completeness", async ({ mount }, testInfo) => {
  const component = await mount(<GraphBuilderNewHarness mode="unknownCount" />);
  const status = component.locator(".graph-new-frame-status");
  await component.getByLabel("X field").selectOption("column-x");
  await component.getByLabel("Y field").selectOption("column-y");
  await expect(status).toContainText("3 visible; 2 submitted");
  await component.getByTestId("camera-plot").dispatchEvent("wheel", { deltaY: -200 });
  await expect(status).toContainText("Approximate LOD: 0 submitted; visible count unknown");
  await expect(status).not.toContainText("Exact");
  await expect(status).toContainText("1 excluded");
  await component.screenshot({ path: testInfo.outputPath("bounded-count-unknown.png") });
});

test("status distinguishes exact visible points from approximate LOD", async ({ mount }) => {
  const component = await mount(<GraphBuilderNewHarness mode="render" />);
  await component.getByLabel("X field").selectOption("column-x");
  await component.getByLabel("Y field").selectOption("column-y");
  await expect(component.getByRole("status").filter({ hasText: "Approximate LOD" })).toContainText("3 visible; 2 submitted");
  const plot = component.getByTestId("camera-plot");
  await plot.dispatchEvent("wheel", { deltaY: -200 });
  await expect(component.getByRole("status").filter({ hasText: "Exact" })).toContainText("1 visible; 1 submitted");
});

test("exact status distinguishes seven visible rows from all submitted marks", async ({ mount }) => {
  const component = await mount(<GraphBuilderNewHarness mode="largeExact" />);
  await component.getByLabel("X field").selectOption("column-x");
  await component.getByLabel("Y field").selectOption("column-y");
  const status = component.locator(".graph-new-frame-status");
  await expect(status).toContainText("Exact:");
  await component.getByTestId("camera-plot").dispatchEvent("wheel", { deltaY: -200 });
  await expect(status).toContainText("Exact: 7 visible; 2,032,293 submitted; 1 excluded");
});

for (const change of ["host resize", "DPR change"]) {
  test(`camera retains settled zoom across ${change}`, async ({ mount, page }, testInfo) => {
    const component = await mount(<GraphBuilderNewHarness mode="slow" />);
    await component.getByLabel("X field").selectOption("column-x");
    await component.getByLabel("Y field").selectOption("column-y");
    const metrics = component.getByTestId("render-metrics");
    const requestOutput = component.getByTestId("render-request");
    const plot = component.getByTestId("camera-plot");
    await expect(metrics).toContainText('"presented":1');
    const bounds = (await plot.boundingBox())!;
    await plot.dispatchEvent("wheel", { deltaY: -200, clientX: bounds.x + bounds.width / 3, clientY: bounds.y + bounds.height / 3 });
    await expect(metrics).toContainText('"presented":2');
    const zoomed = JSON.parse((await requestOutput.textContent())!);
    expect(zoomed.cameraDomain.xMax - zoomed.cameraDomain.xMin).toBeLessThan(100);
    if (change === "host resize") {
      await component.getByRole("button", { name: "Resize fixture" }).click();
    } else {
      await page.evaluate(() => {
        Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 2 });
        window.dispatchEvent(new Event("resize"));
      });
    }
    await expect(metrics).toContainText('"renders":3');
    const resized = JSON.parse((await requestOutput.textContent())!);
    expect(resized.cameraDomain).toEqual(zoomed.cameraDomain);
    expect(resized.rendererGeneration).toBeGreaterThan(zoomed.rendererGeneration);
    if (change === "host resize") expect(resized.width).toBeLessThan(zoomed.width);
    else expect(resized.devicePixelRatio).toBe(2);
    await expect(metrics).toContainText('"presented":3');
    await expect(metrics).toContainText('"maximumActive":1');
    const frame = component.getByRole("img", { name: "Point plot frame" });
    const frameBounds = (await frame.boundingBox())!;
    const plotBounds = (await plot.boundingBox())!;
    const physicalWidth = Math.ceil(resized.width * resized.devicePixelRatio);
    const scale = frameBounds.width / physicalWidth;
    expect(plotBounds.x - frameBounds.x).toBeCloseTo(Math.ceil(64 * resized.devicePixelRatio) * scale, 1);
    expect(plotBounds.width).toBeCloseTo((Math.floor((resized.width - 16) * resized.devicePixelRatio) - Math.ceil(64 * resized.devicePixelRatio)) * scale, 1);
    expect(await frame.evaluate((element: HTMLCanvasElement) => Array.from(element.getContext("2d")!.getImageData(element.width / 2, element.height / 2, 1, 1).data))).toEqual([31, 111, 235, 255]);
    await component.screenshot({ path: testInfo.outputPath("retained-camera.png") });
    await plot.dispatchEvent("wheel", { deltaY: -100, clientX: plotBounds.x + plotBounds.width / 2, clientY: plotBounds.y + plotBounds.height / 2 });
    await expect(metrics).toContainText('"presented":4');
    const continued = JSON.parse((await requestOutput.textContent())!);
    expect(continued.cameraDomain.xMax - continued.cameraDomain.xMin).toBeLessThan(zoomed.cameraDomain.xMax - zoomed.cameraDomain.xMin);
    await component.getByRole("button", { name: "Reset view" }).click();
    await expect(metrics).toContainText('"presented":5');
    expect(JSON.parse((await requestOutput.textContent())!).cameraDomain).toBeNull();
    await plot.dispatchEvent("wheel", { deltaY: -100 });
    await expect(metrics).toContainText('"presented":6');
    await component.getByLabel("Y field").selectOption("column-x");
    await expect(metrics).toContainText('"presented":7');
    expect(JSON.parse((await requestOutput.textContent())!).cameraDomain).toBeNull();
    await testInfo.attach("retained-camera-requests", { body: JSON.stringify({ zoomed, resized, continued }), contentType: "application/json" });
  });
}

test("camera resize preserves desired zoom while stale decode is pending", async ({ mount, page }, testInfo) => {
  const component = await mount(<GraphBuilderNewHarness mode="render" />);
  await component.getByLabel("X field").selectOption("column-x");
  await component.getByLabel("Y field").selectOption("column-y");
  const metrics = component.getByTestId("render-metrics");
  await expect(metrics).toContainText('"presented":1');
  await page.evaluate(() => {
    const original = window.createImageBitmap.bind(window);
    let hold = true;
    (window as any).resizeBitmapClosed = 0;
    (window as any).createImageBitmap = async (...args: any[]) => {
      const bitmap = await (original as any)(...args);
      const close = bitmap.close.bind(bitmap);
      bitmap.close = () => { (window as any).resizeBitmapClosed++; close(); };
      if (!hold) return bitmap;
      hold = false;
      return new Promise((resolve) => { (window as any).releaseResizeBitmap = () => resolve(bitmap); });
    };
  });
  const plot = component.getByTestId("camera-plot");
  const bounds = (await plot.boundingBox())!;
  const gesture = { deltaY: -100, clientX: bounds.x + bounds.width / 2, clientY: bounds.y + bounds.height / 2 };
  await plot.dispatchEvent("wheel", gesture);
  await expect.poll(() => page.evaluate(() => typeof (window as any).releaseResizeBitmap)).toBe("function");
  await plot.dispatchEvent("wheel", gesture);
  await component.getByRole("button", { name: "Resize fixture" }).click();
  await expect(plot).toBeHidden();
  await page.evaluate(() => (window as any).releaseResizeBitmap());
  await expect(metrics).toContainText('"presented":2');
  await expect(metrics).toContainText('"renders":3');
  await expect(metrics).toContainText('"maximumActive":1');
  const request = JSON.parse((await component.getByTestId("render-request").textContent())!);
  expect(request.cameraDomain).not.toBeNull();
  expect(request.cameraDomain.xMax - request.cameraDomain.xMin).toBeCloseTo(100 * Math.exp(-0.4), 8);
  await expect.poll(() => page.evaluate(() => (window as any).resizeBitmapClosed)).toBe(2);
  await expect(component.getByTestId("camera-preview")).toHaveCSS("transform", "none");
  await testInfo.attach("desired-camera-resize-request", { body: JSON.stringify(request), contentType: "application/json" });
});

test("camera transforms immediately, coalesces wheel and supports keyboard reset", async ({ mount, page }, testInfo) => {
  const component = await mount(<GraphBuilderNewHarness mode="slow" />);
  await component.getByLabel("X field").selectOption("column-x");
  await component.getByLabel("Y field").selectOption("column-y");
  const metrics = component.getByTestId("render-metrics");
  await expect(metrics).toContainText('"presented":1');
  const plot = component.getByTestId("camera-plot");
  const preview = component.getByTestId("camera-preview");
  const timing = await plot.evaluate(async (element) => {
    const bounds = element.getBoundingClientRect();
    const started = performance.now();
    for (let index = 0; index < 20; index++) element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true,
      clientX: bounds.x + bounds.width / 4, clientY: bounds.y + bounds.height / 4, deltaY: -5 }));
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const transform = getComputedStyle(element.querySelector("canvas")!).transform;
    return { started, immediateMs: performance.now() - started, transform,
      metrics: document.querySelector('[data-testid="render-metrics"]')!.textContent };
  });
  expect(timing.transform).not.toBe("none");
  expect(timing.metrics).toContain('"renders":1');
  expect(timing.immediateMs).toBeLessThan(200);
  await expect(preview).not.toHaveCSS("transform", "none");
  await expect(metrics).toContainText('"presented":1');
  await expect(component.getByRole("status").filter({ hasText: "Axes frozen" })).toBeVisible();
  await component.screenshot({ path: testInfo.outputPath("task7-camera-preview.png") });
  await expect(metrics).toContainText('"renders":2');
  await expect(metrics).toContainText('"presented":2');
  const renderTimes = JSON.parse((await component.getByTestId("render-times").textContent())!);
  const settleMs = renderTimes[1] - timing.started;
  expect(settleMs).toBeGreaterThanOrEqual(70);
  expect(settleMs).toBeLessThan(200);
  const request = JSON.parse((await component.getByTestId("render-request").textContent())!);
  expect(request.cameraDomain.xMax - request.cameraDomain.xMin).toBeLessThan(100);
  expect(request.cameraGeneration).toBeGreaterThan(0);
  await page.waitForTimeout(120);
  await expect(metrics).toContainText('"renders":2');
  const reset = component.getByRole("button", { name: "Reset view" });
  await reset.focus(); await page.keyboard.press("Enter");
  await expect(metrics).toContainText('"presented":3');
  expect(JSON.parse((await component.getByTestId("render-request").textContent())!).cameraDomain).toBeNull();
  await expect(component.getByTestId("x-axis-title")).toHaveText("Diameter");
  await testInfo.attach("camera-timing", { body: JSON.stringify({ ...timing, settleMs }), contentType: "application/json" });
});

test("camera gesture during decode fences snapback and preserves cache on replacement", async ({ mount, page }, testInfo) => {
  const component = await mount(<GraphBuilderNewHarness mode="render" />);
  await component.getByLabel("X field").selectOption("column-x");
  await component.getByLabel("Y field").selectOption("column-y");
  const metrics = component.getByTestId("render-metrics");
  await expect(metrics).toContainText('"presented":1');
  await page.evaluate(() => {
    const original = window.createImageBitmap.bind(window);
    (window as any).cameraBitmapClosed = 0;
    let hold = true;
    (window as any).createImageBitmap = async (...args: any[]) => {
      const bitmap = await (original as any)(...args);
      const close = bitmap.close.bind(bitmap);
      bitmap.close = () => { (window as any).cameraBitmapClosed++; close(); };
      if (!hold) return bitmap;
      hold = false;
      return new Promise((resolve) => { (window as any).releaseCameraBitmap = () => resolve(bitmap); });
    };
  });
  const plot = component.getByTestId("camera-plot");
  const bounds = (await plot.boundingBox())!;
  await plot.dispatchEvent("wheel", { deltaY: -100, clientX: bounds.x + 100, clientY: bounds.y + 100 });
  await expect.poll(() => page.evaluate(() => typeof (window as any).releaseCameraBitmap)).toBe("function");
  await page.mouse.move(bounds.x + 50, bounds.y + 50); await page.mouse.down();
  await page.mouse.move(bounds.x + 90, bounds.y + 70);
  await page.mouse.up();
  await expect.poll(async () => (await component.getByTestId("cancel-modes").textContent())!).toBe("[true,true]");
  await page.waitForTimeout(100);
  await expect(component.getByTestId("cancel-modes")).toHaveText("[true,true]");
  await page.evaluate(() => (window as any).releaseCameraBitmap());
  await expect(metrics).toContainText('"presented":2');
  await expect(metrics).toContainText('"renders":3');
  await expect.poll(() => page.evaluate(() => (window as any).cameraBitmapClosed)).toBe(2);
  await expect(metrics).toContainText('"maximumActive":1');
  await component.screenshot({ path: testInfo.outputPath("task7-camera-settled.png") });
});

test("camera pointer capture cancels cleanly and unmount clears settle", async ({ mount, page }) => {
  const component = await mount(<GraphBuilderNewHarness mode="slow" />);
  await component.getByLabel("X field").selectOption("column-x");
  await component.getByLabel("Y field").selectOption("column-y");
  const metrics = component.getByTestId("render-metrics");
  await expect(metrics).toContainText('"presented":1');
  const plot = component.getByTestId("camera-plot");
  const bounds = (await plot.boundingBox())!;
  await page.mouse.move(bounds.x + 30, bounds.y + 30); await page.mouse.down();
  await page.mouse.move(bounds.x + 80, bounds.y + 50, { steps: 8 });
  await expect(component.getByTestId("camera-preview")).not.toHaveCSS("transform", "none");
  await page.waitForTimeout(100);
  await expect(metrics).toContainText('"renders":1');
  await plot.dispatchEvent("pointercancel", { pointerId: 1 });
  await page.mouse.up();
  await expect(metrics).toContainText('"presented":2');
  await plot.dispatchEvent("wheel", { deltaY: -100 });
  await component.getByRole("button", { name: "Unmount view" }).click();
  await page.waitForTimeout(200);
  await expect(metrics).toContainText('"renders":2');
  await expect(metrics).toContainText('"maximumActive":1');
});

test.describe("large high-DPR canvas", () => {
  test.use({ deviceScaleFactor: 2 });
  for (const hostSize of [{ width: 2500, height: 1000 }, { width: 10000, height: 5000 }, { width: 2094, height: 1000 }]) {
    test(`preserves aspect ratio at ${hostSize.width}x${hostSize.height}`, async ({ mount, page }, testInfo) => {
      await page.setViewportSize({ width: 3000, height: 1400 });
      const component = await mount(<GraphBuilderNewHarness mode="render" />);
      await page.addStyleTag({ content: `.graph-new-canvas-host { width: ${hostSize.width}px; height: ${hostSize.height}px; }` });
      await component.getByLabel("X field").selectOption("column-x");
      await component.getByLabel("Y field").selectOption("column-y");
      await expect(component.getByTestId("render-metrics")).toContainText('"presented":1');
      const request = JSON.parse((await component.getByTestId("render-request").textContent())!);
      expect(await page.evaluate(() => devicePixelRatio)).toBe(2);
      expect(request.width / request.height).toBeCloseTo(hostSize.width / hostSize.height, 2);
      expect(request.devicePixelRatio).toBeGreaterThanOrEqual(0.5);
      expect(request.devicePixelRatio).toBeLessThan(2);
      const canvas = component.getByRole("img", { name: "Point plot frame" });
      const dimensions = await canvas.evaluate((element: HTMLCanvasElement) => {
        const bounds = element.getBoundingClientRect();
        return { width: element.width, height: element.height, scaleX: bounds.width / element.width, scaleY: bounds.height / element.height,
          pixel: Array.from(element.getContext("2d")!.getImageData(Math.floor(element.width / 2), Math.floor(element.height / 2), 1, 1).data) };
      });
      expect(dimensions.width).toBeLessThanOrEqual(3840);
      expect(dimensions.height).toBeLessThanOrEqual(2160);
      expect(dimensions.scaleX).toBeCloseTo(dimensions.scaleY, 3);
      expect(dimensions.pixel).toEqual([31, 111, 235, 255]);
      if (hostSize.width === 2500) await page.screenshot({ path: testInfo.outputPath("large-host-dpr2.png") });
    });
  }
});

test("presents a deterministic binary frame with frontend axis titles and closes", async ({ mount }) => {
  const component = await mount(<GraphBuilderNewHarness mode="render" />);
  await component.getByLabel("X field").selectOption("column-x");
  await component.getByLabel("Y field").selectOption("column-y");
  const canvas = component.getByRole("img", { name: "Point plot frame" });
  await expect(canvas).toBeVisible();
  await expect(component.getByTestId("render-metrics")).toContainText('"presented":1');
  expect(await canvas.evaluate((element: HTMLCanvasElement) => Array.from(element.getContext("2d")!.getImageData(Math.floor(element.width / 2), Math.floor(element.height / 2), 1, 1).data))).toEqual([31, 111, 235, 255]);
  await expect(component.getByTestId("x-axis-title")).toHaveText("Diameter");
  await expect(component.getByTestId("y-axis-title")).toHaveText("Height");
  await component.getByRole("button", { name: "Close Graph Builder-new" }).click();
  await expect(component.getByTestId("render-metrics")).toContainText('"closes":1');
});

test("keeps a coherent frame during resize and serializes rapid changes", async ({ mount }) => {
  const component = await mount(<GraphBuilderNewHarness mode="slow" />);
  await component.getByLabel("X field").selectOption("column-x");
  await component.getByLabel("Y field").selectOption("column-y");
  const metrics = component.getByTestId("render-metrics");
  const canvas = component.getByRole("img", { name: "Point plot frame" });
  await expect(metrics).toContainText('"presented":1');
  await component.getByRole("button", { name: "Resize fixture" }).click();
  await expect(metrics).toContainText('"renders":2');
  await expect(canvas).toBeVisible();
  expect(await canvas.evaluate((element: HTMLCanvasElement) => element.getContext("2d")!.getImageData(Math.floor(element.width / 2), Math.floor(element.height / 2), 1, 1).data[2])).toBe(235);
  await component.getByLabel("Y field").selectOption("column-x");
  await expect(metrics).toContainText('"cancels":2');
  await expect(metrics).toContainText('"presented":2');
  await expect(metrics).toContainText('"maximumActive":1');
  await component.getByRole("button", { name: "Invalidate source" }).click();
  await expect(canvas).toHaveCount(0);
  await expect(metrics).toContainText('"closes":1');
});

test("drops and closes a stale bitmap before replacement", async ({ mount, page }) => {
  await page.evaluate(() => {
    const original = window.createImageBitmap.bind(window);
    (window as any).bitmapClosed = 0;
    let first = true;
    (window as any).createImageBitmap = async (...args: any[]) => {
      const bitmap = await (original as any)(...args);
      const close = bitmap.close.bind(bitmap);
      bitmap.close = () => { (window as any).bitmapClosed++; close(); };
      if (!first) return bitmap;
      first = false;
      return new Promise((resolve) => { (window as any).releaseBitmap = () => resolve(bitmap); });
    };
  });
  const component = await mount(<GraphBuilderNewHarness mode="render" />);
  await component.getByLabel("X field").selectOption("column-x");
  await component.getByLabel("Y field").selectOption("column-y");
  await expect.poll(() => page.evaluate(() => typeof (window as any).releaseBitmap)).toBe("function");
  await component.getByLabel("Y field").selectOption("column-x");
  await page.evaluate(() => (window as any).releaseBitmap());
  await expect(component.getByTestId("render-metrics")).toContainText('"presented":1');
  await expect.poll(() => page.evaluate(() => (window as any).bitmapClosed)).toBe(2);
  await expect(component.getByTestId("y-axis-title")).toHaveText("Diameter");
});

test("cancels after close and reports safe render failures", async ({ mount }) => {
  const component = await mount(<GraphBuilderNewHarness mode="slow" />);
  await component.getByLabel("X field").selectOption("column-x");
  await component.getByLabel("Y field").selectOption("column-y");
  await expect(component.getByTestId("render-metrics")).toContainText('"renders":1');
  await component.getByRole("button", { name: "Close Graph Builder-new" }).click();
  await expect(component.getByTestId("render-metrics")).toContainText('"cancels":1');
  await expect(component.getByTestId("render-metrics")).toContainText('"presented":0');
  await component.unmount();
  const failed = await mount(<GraphBuilderNewHarness mode="renderError" />);
  await failed.getByLabel("X field").selectOption("column-x");
  await failed.getByLabel("Y field").selectOption("column-y");
  await expect(failed.getByRole("alert")).toHaveText("Plot could not be rendered.");
  await expect(failed.getByRole("alert")).toHaveAttribute("data-reason", "graph_new_render_failed");
  await expect(failed.getByText("/user/source.db", { exact: false })).toHaveCount(0);
});

test("frames fit desktop and mobile layouts", async ({ mount, page }, testInfo) => {
  const component = await mount(<GraphBuilderNewHarness mode="render" />);
  await component.getByLabel("X field").selectOption("column-x");
  await component.getByLabel("Y field").selectOption("column-y");
  const canvas = component.getByRole("img", { name: "Point plot frame" });
  await expect(component.getByTestId("render-metrics")).toContainText('"presented":1');
  await component.screenshot({ path: testInfo.outputPath("task6-desktop.png") });
  await page.setViewportSize({ width: 375, height: 700 });
  await expect(component.getByTestId("render-metrics")).toContainText('"presented":2');
  const bounds = await canvas.boundingBox();
  expect(bounds!.width).toBeGreaterThan(96);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(375);
  const titleBounds = await component.getByTestId("x-axis-title").boundingBox();
  expect(titleBounds!.y).toBeGreaterThanOrEqual(bounds!.y + bounds!.height);
  expect(await canvas.evaluate((element: HTMLCanvasElement) => element.getContext("2d")!.getImageData(Math.floor(element.width / 2), Math.floor(element.height / 2), 1, 1).data[2])).toBe(235);
  await component.screenshot({ path: testInfo.outputPath("task6-mobile.png") });
});

test("unmount cancels late work, remount restores the same session, and store close is terminal", async ({ mount }) => {
  const component = await mount(<GraphBuilderNewHarness mode="slow" />);
  await component.getByLabel("X field").selectOption("column-x");
  await component.getByLabel("Y field").selectOption("column-y");
  const metrics = component.getByTestId("render-metrics");
  await expect(metrics).toContainText('"renders":1');
  await component.getByRole("button", { name: "Unmount view" }).click();
  await expect(metrics).toContainText('"cancels":1');
  await expect(metrics).toContainText('"closes":0');
  await expect(metrics).toContainText('"settled":1');
  await expect(metrics).toContainText('"presented":0');
  const retainedSession = await component.getByTestId("selected-columns").textContent();
  await component.getByRole("button", { name: "Remount view" }).click();
  await expect(metrics).toContainText('"presented":1');
  await expect(component.getByRole("img", { name: "Point plot frame" })).toBeVisible();
  await expect(component.getByTestId("selected-columns")).toHaveText(retainedSession!);
  await component.getByRole("button", { name: "Unmount view" }).click();
  await component.getByRole("button", { name: "Close retained session" }).click();
  await expect(metrics).toContainText('"closes":1');
  await component.getByRole("button", { name: "Remount view" }).click();
  await expect(component.getByText("This Graph Builder-new session is closed.")).toBeVisible();
  await expect(metrics).toContainText('"renders":2');
});

test("offers all X fields but only numeric Y fields and stores their stable IDs", async ({ mount }) => {
  const component = await mount(<GraphBuilderNewHarness />);
  const xField = component.getByLabel("X field");
  const yField = component.getByLabel("Y field");

  await expect(xField.getByRole("option")).toHaveText(["Select a field", "Diameter", "Height", "Cavity (Text)"]);
  await expect(yField.getByRole("option")).toHaveText(["Select a field", "Diameter", "Height"]);
  await xField.selectOption("column-x");
  await yField.selectOption("column-y");
  await expect(xField).toHaveValue("column-x");
  await expect(yField).toHaveValue("column-y");
  await expect(xField.locator('option[value="column-label"]')).toHaveJSProperty("disabled", false);
});

for (const locale of ["en", "zh-CN"] as const) {
  test(`field visibility preserves source order, stable IDs and numeric eligibility in ${locale}`, async ({ mount }, testInfo) => {
    const component = await mount(<GraphBuilderNewHarness mode="mixedFields" locale={locale} />);
    const xField = component.getByLabel("X field");
    const yField = component.getByLabel("Y field");
    const textSuffix = locale === "en" ? "Text" : "文本";
    const timestampSuffix = locale === "en" ? "Timestamp" : "时间戳";
    await expect(xField.locator("option")).toHaveText([
      "Select a field", `TestTime (${textSuffix})`, "TestTime", `DPT (${timestampSuffix})`,
      `StepTime (${textSuffix})`, "Voltage", "TestTime",
    ]);
    expect(await xField.locator("option").evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value)))
      .toEqual(["", "text-test-time", "column-x", "timestamp-dpt", "text-step-time", "column-y", "duplicate-x"]);
    await expect(yField.locator("option")).toHaveText(["Select a field", "TestTime", "Voltage", "TestTime"]);
    await yField.selectOption("column-y");
    for (const [index, value] of ["text-test-time", "timestamp-dpt", "text-step-time"].entries()) {
      await expect(xField.locator(`option[value="${value}"]`)).toHaveJSProperty("disabled", false);
      await xField.selectOption(value);
      await expect(component.getByTestId("selected-columns")).toContainText(`"xColumnId":"${value}"`);
      await expect(component.getByTestId("render-metrics")).toContainText(`"presented":${index + 1}`);
    }
    await xField.selectOption("duplicate-x");
    await expect(component.getByTestId("render-metrics")).toContainText('"presented":4');
    await expect(component.getByTestId("render-request")).toContainText('"xColumnId":"duplicate-x"');
    await component.screenshot({ path: testInfo.outputPath(`fields-${locale}.png`) });
    await testInfo.attach("field-options", { body: JSON.stringify(await xField.locator("option").evaluateAll((options) => options.map((element) => {
      const option = element as HTMLOptionElement;
      return { value: option.value, text: option.text, disabled: option.disabled };
    }))), contentType: "application/json" });
  });
}

test("field visibility allows scalar X but requires numeric Y before rendering", async ({ mount }) => {
  const component = await mount(<GraphBuilderNewHarness mode="unsupportedFields" />);
  const xField = component.getByLabel("X field");
  await expect(xField).toBeEnabled();
  await expect(xField.locator("option:disabled")).toHaveCount(0);
  await expect(component.getByLabel("Y field")).toBeDisabled();
  await xField.selectOption({ index: 1 });
  await expect(xField).not.toHaveValue("");
  await expect(component.getByTestId("render-metrics")).toContainText('"renders":0');
  await expect(component.getByText("This table has no numeric columns.")).toBeVisible();
});

for (const outcome of ["Resolve", "Reject"]) {
  test(`field visibility ignores ${outcome.toLowerCase()} of old metadata after source replacement`, async ({ mount }) => {
    const component = await mount(<GraphBuilderNewHarness mode="deferredFields" />);
    await expect(component.getByTestId("descriptor-calls")).toHaveText("1");
    await expect(component.getByLabel("X field")).toBeDisabled();
    await component.getByRole("button", { name: "Replace field source" }).click();
    const xOptions = component.getByLabel("X field").locator("option");
    const expected = ["Select a field", "New X", "New text (Text)"];
    await expect(xOptions).toHaveText(expected);
    await component.getByRole("button", { name: `${outcome} old fields` }).click();
    await expect(xOptions).toHaveText(expected);
    await expect(component.getByRole("alert")).toHaveCount(0);
    await expect(component.getByTestId("render-metrics")).toContainText('"renders":0');
  });
}

test("field visibility clears loaded fields when the source becomes stale", async ({ mount }) => {
  const component = await mount(<GraphBuilderNewHarness mode="mixedFields" />);
  await expect(component.getByLabel("X field").locator("option")).toHaveCount(7);
  await component.getByRole("button", { name: "Invalidate source" }).click();
  await expect(component.getByLabel("X field").locator("option")).toHaveText(["Select a field"]);
  await expect(component.getByLabel("X field")).toBeDisabled();
  await expect(component.getByLabel("Y field").locator("option")).toHaveText(["Select a field"]);
});

test("field visibility replaces loaded source fields without retaining old selections", async ({ mount }) => {
  const component = await mount(<GraphBuilderNewHarness mode="mixedFields" />);
  await component.getByLabel("X field").selectOption("column-x");
  await component.getByLabel("Y field").selectOption("column-y");
  await expect(component.getByTestId("render-metrics")).toContainText('"presented":1');
  await component.getByRole("button", { name: "Replace field source" }).click();
  await expect(component.getByLabel("X field").locator("option")).toHaveText([
    "Select a field", "New X", "New text (Text)",
  ]);
  await expect(component.getByLabel("Y field").locator("option")).toHaveText(["Select a field", "New X"]);
  await expect(component.getByTestId("selected-columns")).toContainText('"xColumnId":null');
  await expect(component.getByTestId("selected-columns")).toContainText('"yColumnId":null');
  await expect(component.getByTestId("render-metrics")).toContainText('"renders":1');
});

for (const selected of ["column-x", "duplicate-x"]) {
  test(`field visibility retains scalar ${selected} unless metadata removes it`, async ({ mount }) => {
    const component = await mount(<GraphBuilderNewHarness mode="mixedFields" />);
    await component.getByLabel("X field").selectOption(selected);
    await component.getByLabel("Y field").selectOption("column-y");
    await expect(component.getByTestId("render-metrics")).toContainText('"presented":1');
    await component.getByRole("button", { name: "Refresh field metadata" }).click();
    await expect(component.getByTestId("selected-columns")).toContainText(selected === "column-x" ? '"xColumnId":"column-x"' : '"xColumnId":null');
    await expect(component.getByTestId("selected-columns")).toContainText('"yColumnId":"column-y"');
    await expect(component.getByLabel("X field").locator('option[value="column-x"]')).toHaveJSProperty("disabled", false);
    await expect(component.getByLabel("X field").locator('option[value="duplicate-x"]')).toHaveCount(0);
    await expect(component.getByTestId("render-metrics")).toContainText('"renders":1');
  });
}

test("does not load descriptors for a stale dataset generation", async ({ mount }) => {
  const component = await mount(<GraphBuilderNewHarness mode="stale" />);

  await expect(component.getByText("The source table changed. Close this session and open a new one.")).toBeVisible();
  await expect(component.getByTestId("descriptor-calls")).toHaveText("0");
});

test("diagnoses a missing dataset without loading descriptors", async ({ mount }) => {
  const component = await mount(<GraphBuilderNewHarness mode="missing" />);

  await expect(component.getByText("The source table is no longer available.")).toBeVisible();
  await expect(component.getByTestId("descriptor-calls")).toHaveText("0");
});

test("clears selected IDs that are not numeric descriptors", async ({ mount }) => {
  const component = await mount(<GraphBuilderNewHarness mode="invalid" />);

  await expect(component.getByTestId("selected-columns")).toContainText('"xColumnId":null');
  await expect(component.getByTestId("selected-columns")).toContainText('"yColumnId":null');
});

test("renders empty and error states", async ({ mount }) => {
  const empty = await mount(<GraphBuilderNewHarness mode="empty" />);
  await expect(empty.getByText("This table has no numeric columns.")).toBeVisible();
  await empty.unmount();

  const failed = await mount(<GraphBuilderNewHarness mode="error" />);
  await expect(failed.getByText("Numeric fields could not be loaded.")).toBeVisible();
  await expect(failed.getByText("descriptor lookup failed")).toHaveCount(0);
});

test("reports transport capability and closes the session", async ({ mount }) => {
  const component = await mount(<GraphBuilderNewHarness />);

  await expect(component.getByText("Tauri host not detected; raw-frame transport unavailable")).toBeVisible();
  await component.getByRole("button", { name: "Close Graph Builder-new" }).click();
  await expect(component.getByTestId("close-count")).toHaveText("1");
  await expect(component.getByText("This Graph Builder-new session is closed.")).toBeVisible();
});