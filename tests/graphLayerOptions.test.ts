import assert from "node:assert/strict";
import { defaultPointOptions, defaultLineOptions, normalizePointOptions, normalizeLineOptions } from "../src/components/graphBuilder/shared/graphLayerOptionContracts";

assert.deepEqual(defaultPointOptions(), { summaryStat: "none", errorInterval: "auto", intervalStyle: "errorBar", jitter: "stacked", jitterLimit: 0.5 });
assert.deepEqual(defaultLineOptions(), { rowOrder: false, connection: "line", summaryStat: "mean", fill: "none", errorInterval: "auto", intervalStyle: "errorBar", missingFactors: "skip", missingValues: "connect" });
assert.equal(normalizePointOptions({ jitter: "auto" }).jitter, "stacked");
for (const jitterLimit of [-1, 2, NaN, Infinity]) assert.throws(() => normalizePointOptions({ jitterLimit }));
assert.throws(() => normalizePointOptions({ summaryStat: "average" }));
assert.throws(() => normalizeLineOptions({ missingValues: "ignore" }));
assert.throws(() => normalizeLineOptions({ rowOrder: "false" }));
assert.throws(() => normalizeLineOptions({ unrelated: true }));
console.log("graph layer option contracts passed");
