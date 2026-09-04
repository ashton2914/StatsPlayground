import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  defaultLayerOptions,
  GRAPH_LAYER_DEFS,
  LAYER_DIM,
} from "../src/components/graphBuilder/graphLayerConfig.ts";

assert.equal(GRAPH_LAYER_DEFS.some((definition) => definition.kind === "contour3d"), true);
assert.equal(LAYER_DIM.contour3d, "3d");
assert.deepEqual(defaultLayerOptions("contour3d", []), {
  stat: "mean",
  smoothness: 0,
  levels: 10,
});
assert.equal(GRAPH_LAYER_DEFS.some((definition) => definition.kind === "normalCurve"), true);
assert.equal(LAYER_DIM.normalCurve, "2d");
assert.deepEqual(defaultLayerOptions("normalCurve", []), { showSigmaBands: false });

for (const locale of ["en", "zh-CN", "zh-TW", "vi"]) {
  const messages = JSON.parse(readFileSync(new URL(`../src/i18n/locales/${locale}.json`, import.meta.url), "utf8"));
  assert.equal(typeof messages.graph.type.contour3d, "string", `${locale} contour layer label`);
  assert.ok(messages.graph.type.contour3d.trim().length > 0, `${locale} contour layer label is non-empty`);
  assert.equal(typeof messages.graph.opt.contourLevels, "string", `${locale} contour levels label`);
  assert.ok(messages.graph.opt.contourLevels.trim().length > 0, `${locale} contour levels label is non-empty`);
  assert.equal(typeof messages.graph.type.normalCurve, "string", `${locale} normal curve layer label`);
  assert.ok(messages.graph.type.normalCurve.trim().length > 0, `${locale} normal curve layer label is non-empty`);
  assert.equal(typeof messages.graph.opt.showSigmaBands, "string", `${locale} sigma bands option label`);
  assert.ok(messages.graph.opt.showSigmaBands.trim().length > 0, `${locale} sigma bands option label is non-empty`);
}

console.log("graph layer config regressions passed");
