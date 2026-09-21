import assert from "node:assert/strict";

import {
  decodeGraphBuilderDragFields,
  encodeGraphBuilderDragFields,
} from "../src/components/graphBuilder/shared/graphBuilderDragPayload";

const duplicateNames = [
  { columnId: "first-id", name: "Voltage", sqlType: "DOUBLE" },
  { columnId: "second-id", name: "Voltage", sqlType: "DOUBLE" },
];

assert.deepEqual(
  decodeGraphBuilderDragFields(encodeGraphBuilderDragFields(duplicateNames)),
  duplicateNames,
);
assert.equal(decodeGraphBuilderDragFields("{}"), null);
assert.equal(decodeGraphBuilderDragFields('{"version":1,"fields":[]}'), null);
assert.equal(
  decodeGraphBuilderDragFields(
    '{"version":1,"fields":[{"columnId":"","name":"X","sqlType":"DOUBLE"}]}',
  ),
  null,
);
assert.equal(
  decodeGraphBuilderDragFields(
    '{"version":1,"fields":[{"columnId":"same","name":"X","sqlType":"DOUBLE"},{"columnId":"same","name":"Y","sqlType":"DOUBLE"}]}',
  ),
  null,
);
assert.throws(
  () => encodeGraphBuilderDragFields([
    { columnId: "same", name: "X", sqlType: "DOUBLE" },
    { columnId: "same", name: "Y", sqlType: "DOUBLE" },
  ]),
  /graph_builder_invalid_drag_fields/,
);

console.log("graphBuilderSharedContracts: all assertions passed");
