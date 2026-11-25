import assert from "node:assert/strict";
import { cameraTransform, createCameraScheduler, isCameraDomain, isRestorableCamera, overscanCamera, overscanViewport, panCamera, projectAxisTicks, shouldPreviewCameraTransform, zoomCamera } from "../src/components/graphBuilderNew/graphNewCamera.ts";

const domain = { xMin: 0, xMax: 100, yMin: -50, yMax: 50 };
const plot = { x: 60, y: 10, width: 400, height: 200 };
assert.equal(isRestorableCamera(domain, domain), true);
assert.equal(isRestorableCamera({ xMin: 25, xMax: 75, yMin: -25, yMax: 25 }, domain), true);
for (const invalid of [
  { xMin: 25, xMax: 75, yMin: -50, yMax: 50 },
  { xMin: 0, xMax: 1e-5, yMin: 0, yMax: 1e-5 },
  { xMin: 0, xMax: 500, yMin: 0, yMax: 500 },
  { xMin: 1000, xMax: 1100, yMin: 0, yMax: 100 },
  { xMin: -1e308, xMax: 1e308, yMin: -1e308, yMax: 1e308 },
]) assert.equal(isRestorableCamera(invalid, domain), false);
const zoomed = zoomCamera(domain, domain, plot, { x: 160, y: 60 }, -Math.log(2) / 0.002);
assert.deepEqual(zoomed, { xMin: 12.5, xMax: 62.5, yMin: -12.5, yMax: 37.5 });
const transform = cameraTransform(domain, zoomed, plot);
assert.equal(transform.scale, 2);
assert.equal(100 * transform.scale + transform.x, 100, "pointer stays fixed in plot-local pixels");
assert.equal(50 * transform.scale + transform.y, 50);
const panned = panCamera(domain, domain, plot, 40, 20);
for (const [key, expected] of Object.entries({ xMin: -10, xMax: 90, yMin: -40, yMax: 60 })) {
  assert.ok(Math.abs(panned[key as keyof typeof panned] - expected) < 1e-12);
}
const zoomedOut = zoomCamera(domain, domain, plot, { x: 260, y: 110 }, Math.log(2) / 0.002);
const zoomedAndPanned = panCamera(zoomed, domain, plot, 240, -90);
assert.equal(shouldPreviewCameraTransform(domain, domain, plot), false, "no-op camera needs no provisional preview");
assert.equal(shouldPreviewCameraTransform(domain, panned, plot), true, "panning must preview smoothly while dragging");
assert.equal(shouldPreviewCameraTransform(domain, zoomed, plot), true, "zooming in previews smoothly");
assert.equal(shouldPreviewCameraTransform(domain, zoomedAndPanned, plot), true, "zoomed-in pan previews smoothly");
assert.equal(shouldPreviewCameraTransform(domain, zoomedOut, plot), false, "zooming out retains coherent frame without shrunk preview");
assert.equal(shouldPreviewCameraTransform(domain, { xMin: 25, xMax: 75, yMin: -50, yMax: 50 }, plot), false, "non-uniform scale does not preview");

const overscan = overscanCamera(domain, domain);
assert.ok(overscan, "full domain produces a 2x overscan domain");
assert.deepEqual(overscan.domain, { xMin: -50, xMax: 150, yMin: -100, yMax: 100 });
assert.equal(overscan.factor, 2);
assert.equal(shouldPreviewCameraTransform(domain, domain, plot, overscan.domain), false, "no-op with overscan still needs no preview");
assert.equal(shouldPreviewCameraTransform(domain, panned, plot, overscan.domain), true, "panning uses overscan preview");
assert.equal(shouldPreviewCameraTransform(domain, zoomedOut, plot, overscan.domain), true, "zooming out within overscan coverage previews smoothly");
const overscanPanTransform = cameraTransform(overscan.domain, panned, plot);
assert.equal(overscanPanTransform.scale, 2);
assert.ok(overscanPanTransform.x <= 0 && overscanPanTransform.x + plot.width * overscanPanTransform.scale >= plot.width,
  "panned viewport stays fully covered by overscan buffer without blank edges");
assert.ok(overscanPanTransform.y <= 0 && overscanPanTransform.y + plot.height * overscanPanTransform.scale >= plot.height,
  "vertical pan stays fully covered by overscan buffer without blank edges");
const nearMaxZoomOut = { xMin: -145, xMax: 245, yMin: -195, yMax: 195 };
assert.equal(overscanCamera(nearMaxZoomOut, domain), null, "skips overscan when already near 4x zoom-out limit");
const vp1x = overscanViewport({ x: 64, y: 16, width: 800, height: 500 }, 1, 2);
assert.deepEqual(vp1x, { width: 1600, height: 1000, devicePixelRatio: 1 });
const vp2x = overscanViewport({ x: 128, y: 32, width: 1800, height: 1200 }, 2, 2);
assert.ok(vp2x && Math.ceil(vp2x.width * vp2x.devicePixelRatio) <= 2560 && Math.ceil(vp2x.height * vp2x.devicePixelRatio) <= 1440,
  "caps overscan physical dimensions within 2560x1440 budget");

const baseNumericAxis = {
  kind: "numeric",
  ticks: [0, 25, 50, 75, 100].map((value, index) => ({ value, position: index / 4, label: String(value) })),
};
const livePannedTicks = projectAxisTicks(baseNumericAxis, panned.xMin, panned.xMax, domain.xMin, domain.xMax);
assert.deepEqual(livePannedTicks.map((tick) => tick.value), [0, 25, 50, 75], "live pan preserves tick step and shifts labels with domain");
assert.ok(Math.abs(livePannedTicks[0].position - 0.1) < 1e-12, "tick 0 moves from 0.0 to 0.1 when panning right by 10%");
for (const extreme of [
  { xMin: 1e300, xMax: 1.01e300, yMin: -1e300, yMax: -0.99e300 },
  { xMin: 1e-280, xMax: 2e-280, yMin: -2e-280, yMax: -1e-280 },
]) {
  let current = extreme;
  for (let index = 0; index < 500; index++) current = zoomCamera(current, extreme, plot, { x: 300, y: 100 }, -1000);
  assert.ok(isCameraDomain(current));
  assert.equal(isRestorableCamera(current, extreme), true);
  assert.ok(Number.isFinite(cameraTransform(extreme, current, plot).scale));
  assert.ok(isCameraDomain(panCamera(current, extreme, plot, 1e300, -1e300)));
}
for (const invalid of [{ ...domain, xMax: 0 }, { ...domain, yMin: NaN }, { ...domain, xMin: -1e308, xMax: 1e308 }]) assert.equal(isCameraDomain(invalid), false);
const adjacent = { xMin: 1, xMax: 1 + Number.EPSILON, yMin: 1e300, yMax: 1e300 + 2e284 };
assert.deepEqual(zoomCamera(adjacent, adjacent, plot, { x: 260, y: 110 }, -100), adjacent, "precision-exhausted zoom-in must not zoom out");
const differentScales = { xMin: 0, xMax: 1, yMin: 1e300, yMax: 1e300 + 1e287 };
let precise = differentScales;
for (let index = 0; index < 100; index++) precise = zoomCamera(precise, differentScales, plot, { x: 160, y: 60 }, -25);
const ratioX = (precise.xMax - precise.xMin) / (differentScales.xMax - differentScales.xMin);
const ratioY = (precise.yMax - precise.yMin) / (differentScales.yMax - differentScales.yMin);
assert.ok(Math.abs(ratioX / ratioY - 1) < 1e-6, "never allow anisotropic rounding drift");

let clock = 0;
let serial = 0;
const timers = new Map<number, { due: number; run: () => void }>();
const settled: number[] = [];
let invalidations = 0;
const scheduler = createCameraScheduler({
  invalidate: () => { invalidations++; }, settled: (generation) => settled.push(generation),
  setTimer: (run, delay) => { const id = ++serial; timers.set(id, { due: clock + delay, run }); return id; },
  clearTimer: (id) => { timers.delete(id as number); },
});
function advance(ms: number) { clock += ms; for (const [id, timer] of timers) if (timer.due <= clock) { timers.delete(id); timer.run(); } }
const oldGeneration = scheduler.generation();
for (let index = 0; index < 30; index++) { scheduler.change(); advance(5); }
assert.equal(settled.length, 0, "no render during a wheel burst");
assert.equal(scheduler.isCurrent(oldGeneration), false, "invalidate decode before settling");
advance(75);
assert.deepEqual(settled, [30], "one settled render");
scheduler.begin(); scheduler.change(); advance(200);
assert.equal(settled.length, 1, "held pointer never settles");
scheduler.end(); advance(75);
assert.equal(settled.length, 2);
scheduler.change(); scheduler.dispose(); advance(200);
assert.equal(settled.length, 2, "cancel/unmount clears pending work");
assert.ok(invalidations >= 32);
console.log("graphNewCamera math, limits, debounce and invalidation passed");