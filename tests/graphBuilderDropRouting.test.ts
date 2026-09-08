import assert from "node:assert/strict";

import { decideGraphBuilderDropRoute } from "../src/components/graphBuilder/graphBuilderDropRouting.ts";

const continuous = (name: string) => ({ name, type: "continuous" as const });
const nominal = (name: string) => ({ name, type: "nominal" as const });

assert.equal(decideGraphBuilderDropRoute("x", [continuous("height")], false), "multi");
assert.equal(
  decideGraphBuilderDropRoute("x", [continuous("height"), continuous("width")], false),
  "multi",
);
assert.equal(decideGraphBuilderDropRoute("x", [nominal("site")], false), "single");
assert.equal(
  decideGraphBuilderDropRoute("x", [continuous("height"), nominal("site")], false),
  "reject",
);
assert.equal(decideGraphBuilderDropRoute("x", [continuous("width")], true), "multi");

assert.equal(decideGraphBuilderDropRoute("y", [continuous("height")], false), "single");
assert.equal(
  decideGraphBuilderDropRoute("y", [continuous("height"), continuous("width")], false),
  "multi",
);
assert.equal(decideGraphBuilderDropRoute("color", [continuous("height"), continuous("width")], false), "single");

console.log("graph builder drop routing tests passed");
