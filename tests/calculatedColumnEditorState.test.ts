import assert from "node:assert/strict";

import {
  createCalculatedColumnAutocompleteEntries,
  reduceCalculatedColumnEditorState,
  type CalculatedColumnEditorState,
} from "../src/components/calculatedColumnEditorState.ts";
import type { ColumnDescriptor } from "../src/types/data.ts";

const baseState: CalculatedColumnEditorState = {
  generation: 4,
  draftText: "round([Length], 2)",
  validatedText: "round([Length], 1)",
  validatedGeneration: 3,
  validationStatus: "ready",
  diagnostics: [
    {
      level: "warning",
      code: "old-warning",
      message: "stale",
      relatedColumnIds: ["length-id"],
    },
  ],
  pendingSubmit: true,
};

const generationChanged = reduceCalculatedColumnEditorState(baseState, {
  type: "generationChanged",
  generation: 5,
});

assert.equal(generationChanged.generation, 5);
assert.equal(generationChanged.draftText, "round([Length], 2)");
assert.equal(generationChanged.validatedText, null);
assert.equal(generationChanged.validatedGeneration, null);
assert.equal(generationChanged.validationStatus, "pending");
assert.deepEqual(generationChanged.diagnostics, []);
assert.equal(generationChanged.pendingSubmit, false);

const descriptors: ColumnDescriptor[] = [
  {
    columnId: "length-id",
    name: "Length",
    sqlType: "DOUBLE",
  },
  {
    columnId: "width-id",
    name: "Width [mm]",
    sqlType: "DOUBLE",
  },
];

const entries = createCalculatedColumnAutocompleteEntries(descriptors);
const labels = entries.map((entry) => entry.label);
assert.equal(labels.includes("Length"), true);
assert.equal(labels.includes("Width [mm]"), true);
assert.equal(labels.includes("round"), true);

const widthEntry = entries.find((entry) => entry.label === "Width [mm]");
assert.equal(widthEntry?.insertText, "[Width [mm]]]");
assert.equal(widthEntry?.columnId, "width-id");

const noMatch = createCalculatedColumnAutocompleteEntries(descriptors, "zzz");
assert.deepEqual(noMatch, []);

console.log("Calculated column editor state passed");