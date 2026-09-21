import assert from "node:assert/strict";

import type * as echarts from "echarts";

import {
  clampFitModelProfilerValue,
  createFitModelXAxisPointerBinding,
} from "../src/components/fitModel/fitModelProfilerInteraction.ts";

assert.equal(clampFitModelProfilerValue(-100, 0, 4), 0);
assert.equal(clampFitModelProfilerValue(100, 0, 4), 4);
assert.equal(clampFitModelProfilerValue(2.5, 0, 4), 2.5);

type PointerHandler = (event: { offsetX: number; offsetY: number }) => void;
const calls: string[] = [];
const activeHandlers = new Map<string, Set<PointerHandler>>();
const renderer = {
  on(name: string, handler: PointerHandler) {
    calls.push(`on:${name}`);
    const handlers = activeHandlers.get(name) ?? new Set<PointerHandler>();
    handlers.add(handler);
    activeHandlers.set(name, handlers);
  },
  off(name: string, handler: PointerHandler) {
    calls.push(`off:${name}`);
    activeHandlers.get(name)?.delete(handler);
  },
};
const chart = {
  containPixel: () => true,
  convertFromPixel: () => [2, 3],
  getZr: () => renderer,
} as unknown as echarts.ECharts;

const pointerBinding = createFitModelXAxisPointerBinding();
pointerBinding.replace(chart, () => () => undefined);
pointerBinding.replace(chart, () => () => undefined);

assert.deepEqual(calls.slice(0, 8), [
  "on:mousedown",
  "on:mousemove",
  "on:mouseup",
  "on:globalout",
  "off:mousedown",
  "off:mousemove",
  "off:mouseup",
  "off:globalout",
]);
for (const name of ["mousedown", "mousemove", "mouseup", "globalout"]) {
  assert.equal(activeHandlers.get(name)?.size, 1, `${name} should have one active handler after recreation`);
}

pointerBinding.dispose();
for (const name of ["mousedown", "mousemove", "mouseup", "globalout"]) {
  assert.equal(activeHandlers.get(name)?.size, 0, `${name} should have no active handlers after unmount`);
  assert.equal(calls.filter((call) => call === `on:${name}`).length, 2);
  assert.equal(calls.filter((call) => call === `off:${name}`).length, 2);
}

console.log("fitModel profiler interaction contract passed");
