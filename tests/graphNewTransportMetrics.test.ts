import assert from "node:assert/strict";

import {
  evaluateGraphNewTransportGate,
  type GraphNewTransportGateInput,
} from "../src/benchmarks/graphNewTransportMetrics.ts";

const PASSING_INPUT: GraphNewTransportGateInput = {
  width: 3840,
  height: 2160,
  readbackToPresentP95Ms: 100,
  compositorFpsP95: 55,
  compositorFrameTimeP95Ms: 18,
  longestAvoidableMainThreadTaskMs: 50,
  maximumQueueDepth: 1,
  usedTextPixelEncoding: false,
  tornOrStaleFrames: 0,
};

const failures: Array<{
  field: keyof GraphNewTransportGateInput;
  value: GraphNewTransportGateInput[keyof GraphNewTransportGateInput];
}> = [
  { field: "width", value: 1920 },
  { field: "height", value: 1080 },
  { field: "readbackToPresentP95Ms", value: 100.01 },
  { field: "compositorFpsP95", value: 54.99 },
  { field: "compositorFrameTimeP95Ms", value: 18.01 },
  { field: "longestAvoidableMainThreadTaskMs", value: 50.01 },
  { field: "maximumQueueDepth", value: 2 },
  { field: "usedTextPixelEncoding", value: true },
  { field: "tornOrStaleFrames", value: 1 },
];

const passingVerdict = evaluateGraphNewTransportGate(PASSING_INPUT);
assert.equal(passingVerdict.pass, true);
assert.deepEqual(passingVerdict.failedBudgets, []);

for (const failure of failures) {
  const verdict = evaluateGraphNewTransportGate({
    ...PASSING_INPUT,
    [failure.field]: failure.value,
  });
  assert.equal(verdict.pass, false, `${failure.field} must fail the gate`);
  assert.deepEqual(verdict.failedBudgets, [failure.field]);
}

console.log("graph-new transport metric gate tests passed");