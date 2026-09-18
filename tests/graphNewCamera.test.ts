import assert from "node:assert/strict";
import { cameraTransform, createCameraScheduler, isCameraDomain, isRestorableCamera, panCamera, zoomCamera } from "../src/components/graphBuilderNew/graphNewCamera.ts";

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