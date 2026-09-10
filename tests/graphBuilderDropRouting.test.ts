import assert from "node:assert/strict";

import { decideGraphBuilderDropRoute } from "../src/components/graphBuilder/graphBuilderDropRouting.ts";

const continuous = (name: string) => ({ name, type: "continuous" as const });
const nominal = (name: string) => ({ name, type: "nominal" as const });

assert.equal(decideGraphBuilderDropRoute("x", [continuous("height")], false, "2d"), "multi");
assert.equal(
  decideGraphBuilderDropRoute("x", [continuous("height"), continuous("width")], false, "2d"),
  "multi",
);
assert.equal(decideGraphBuilderDropRoute("x", [nominal("site")], false, "2d"), "single");
assert.equal(
  decideGraphBuilderDropRoute("x", [continuous("height"), nominal("site")], false, "2d"),
  "reject",
);
assert.equal(decideGraphBuilderDropRoute("x", [continuous("width")], true, "2d"), "multi");

assert.equal(decideGraphBuilderDropRoute("y", [continuous("height")], false, "2d"), "single");
assert.equal(
  decideGraphBuilderDropRoute("y", [continuous("height"), continuous("width")], false, "2d"),
  "multi",
);
assert.equal(decideGraphBuilderDropRoute("color", [continuous("height"), continuous("width")], false, "2d"), "single");

assert.equal(decideGraphBuilderDropRoute("x", [continuous("height")], false, "3d"), "single");
assert.equal(decideGraphBuilderDropRoute("y", [continuous("width")], false, "3d"), "single");
assert.equal(decideGraphBuilderDropRoute("z", [continuous("depth")], false, "3d"), "single");

console.log("graph builder drop routing tests passed");
