import assert from "node:assert/strict";

import { DEFAULT_GROUP_KEY } from "../src/graphCore/types.ts";
import {
  buildEffectiveGroupStyles,
  groupThemeSlot,
  normalizeGroupThemeSlots,
  reconcileGroupThemeSlots,
  resolveGroupThemeFieldName,
} from "../src/components/graphBuilder/graphThemeIdentity.ts";

const initial = reconcileGroupThemeSlots(undefined, "Build", ["EV", "EV1", "EV2", "TC1.6"]);
assert.deepEqual(initial.Build, { EV: 0, EV1: 1, EV2: 2, "TC1.6": 3 });

const missingMiddle = reconcileGroupThemeSlots(initial, "Build", ["EV", "EV1", "TC1.6"]);
assert.strictEqual(missingMiddle, initial);
assert.equal(groupThemeSlot(missingMiddle, "Build", "TC1.6", 2), 3);

const appended = reconcileGroupThemeSlots(missingMiddle, "Build", ["EV", "NEW", "TC1.6"]);
assert.equal(appended.Build.NEW, 4);
assert.equal(appended.Build["TC1.6"], 3);

const otherField = reconcileGroupThemeSlots(appended, "Site", ["EV"]);
assert.equal(otherField.Build.EV, 0);
assert.equal(otherField.Site.EV, 0);

const repairedWithoutAdditions = reconcileGroupThemeSlots(
  { Build: { First: 0, Bad: -1, Dup: 0 } },
  "Build",
  ["First"],
);
assert.deepEqual(repairedWithoutAdditions, { Build: { First: 0 } });
assert.notStrictEqual(repairedWithoutAdditions, undefined);

const repersistedInvalidActiveKey = reconcileGroupThemeSlots(
  { Build: { First: 0, Bad: -1, Dup: 0 } },
  "Build",
  ["First", "Bad"],
);
assert.deepEqual(repersistedInvalidActiveKey, { Build: { First: 0, Bad: 1 } });

const lowestUnused = reconcileGroupThemeSlots({ Build: { A: 0, B: 2 } }, "Build", ["A", "B", "C"]);
assert.equal(lowestUnused.Build.C, 1);

const filtered = reconcileGroupThemeSlots(undefined, "Build", ["", DEFAULT_GROUP_KEY, "EV"]);
assert.deepEqual(filtered, { Build: { EV: 0 } });

const remountSlots = reconcileGroupThemeSlots(undefined, "Build", ["EV", "EV1", "EV2", "TC1.6"]);
const beforeRemount = buildEffectiveGroupStyles(
  ["EV", "EV1", "EV2", "TC1.6"],
  remountSlots,
  "Build",
  {},
  [],
  true,
);
const afterRemount = buildEffectiveGroupStyles(
  ["EV", "EV1", "TC1.6"],
  remountSlots,
  "Build",
  {},
  [],
  true,
);
assert.deepEqual(afterRemount["TC1.6"], beforeRemount["TC1.6"]);

const paletteSlots = reconcileGroupThemeSlots(undefined, "Build", ["EV", "EV1", "EV2", "TC1.6"]);
const paletteBefore = buildEffectiveGroupStyles(
  ["EV", "EV1", "EV2", "TC1.6"],
  paletteSlots,
  "Build",
  {},
  [
    { id: "p0", mode: "manual", point: "#100001", line: "#100002", fill: "#100003" },
    { id: "p1", mode: "manual", point: "#200001", line: "#200002", fill: "#200003" },
    { id: "p2", mode: "manual", point: "#300001", line: "#300002", fill: "#300003" },
    { id: "p3", mode: "manual", point: "#400001", line: "#400002", fill: "#400003" },
  ],
  true,
);
const paletteAfter = buildEffectiveGroupStyles(
  ["EV", "EV1", "EV2", "TC1.6"],
  paletteSlots,
  "Build",
  {},
  [
    { id: "p0", mode: "manual", point: "#100001", line: "#100002", fill: "#100003" },
    { id: "p1", mode: "manual", point: "#200001", line: "#200002", fill: "#200003" },
    { id: "p2", mode: "manual", point: "#300001", line: "#300002", fill: "#300003" },
    { id: "p3", mode: "manual", point: "#abc001", line: "#abc002", fill: "#abc003" },
  ],
  true,
);
assert.equal(groupThemeSlot(paletteSlots, "Build", "TC1.6", 999), 3);
assert.equal(paletteBefore["TC1.6"].line?.color, "#400002");
assert.equal(paletteAfter["TC1.6"].line?.color, "#abc002");
assert.equal(paletteAfter["TC1.6"].fill?.color, "#abc003");
assert.equal(paletteAfter["TC1.6"].point?.color, "#abc001");

const autoOnly = buildEffectiveGroupStyles(
  ["EV", "EV1", "EV2"],
  remountSlots,
  "Build",
  {},
  [],
  true,
);
const partialOverride = buildEffectiveGroupStyles(
  ["EV", "EV1", "EV2"],
  remountSlots,
  "Build",
  {
    EV2: {
      point: {
        color: "#123456",
        fillColor: "#123456",
        marker: "square",
        markerSize: 9,
        opacity: 0.4,
      },
    },
  },
  [],
  true,
);
assert.deepEqual(partialOverride.EV2.point, {
  color: "#123456",
  fillColor: "#123456",
  marker: "square",
  markerSize: 9,
  opacity: 0.4,
});
assert.deepEqual(partialOverride.EV2.line, autoOnly.EV2.line);
assert.deepEqual(partialOverride.EV2.fill, autoOnly.EV2.fill);
assert.deepEqual(partialOverride.EV2.gradient, autoOnly.EV2.gradient);

const widthOnlyOverride = buildEffectiveGroupStyles(
  ["EV", "EV1", "EV2"],
  remountSlots,
  "Build",
  { EV2: { line: { lineWidth: 5 } } },
  [],
  true,
);
assert.deepEqual(
  widthOnlyOverride.EV2.line,
  { ...autoOnly.EV2.line, lineWidth: 5 },
  "partial mark overrides must retain the slot-aware automatic color",
);

assert.deepEqual(
  normalizeGroupThemeSlots({
    Build: {
      EV: 0,
      EV1: -1,
      EV2: 0,
      TC: 2.5,
      Good: 3,
      "": 4,
      [DEFAULT_GROUP_KEY]: 5,
      "  ": 6,
      Duplicate: 3,
    },
  }),
  { Build: { EV: 0, Good: 3 } },
);

assert.deepEqual(
  normalizeGroupThemeSlots({
    Build: { First: 0, Second: 0, Third: 1, Fourth: 1, Fifth: 2 },
  }),
  { Build: { First: 0, Third: 1, Fifth: 2 } },
);

assert.equal(
  resolveGroupThemeFieldName({
    color: { name: "ColorGroup", type: "string" },
    overlay: { name: "OverlayGroup", type: "string" },
  }),
  "OverlayGroup",
  "theme slot namespace should follow the data pipeline's overlay-first grouping field",
);

assert.equal(
  resolveGroupThemeFieldName({
    color: { name: "ColorGroup", type: "string" },
  }),
  "ColorGroup",
  "color grouping should still work when overlay is not bound",
);

console.log("graph theme identity regressions passed");