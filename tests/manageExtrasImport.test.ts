import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { resolvePropertyTableLayout } from "../src/components/manageExtrasImport";

const reordered = resolvePropertyTableLayout(
  ["_row_id", "_row_id_1", "Column name", "Unit", "Spec / Lower"],
  "Column name",
);
assert.deepEqual(reordered, {
  keyColumnName: "Column name",
  keyColumnIndex: 2,
  propertyColumnNames: ["_row_id_1", "Unit", "Spec / Lower"],
});

const exported = resolvePropertyTableLayout(
  ["_row_id", "Column name", "Unit", "Spec / Lower"],
  "Column name",
);
assert.deepEqual(exported, {
  keyColumnName: "Column name",
  keyColumnIndex: 1,
  propertyColumnNames: ["Unit", "Spec / Lower"],
});

const ordinaryId = resolvePropertyTableLayout(
  ["_row_id", "ID", "Unit", "Column name", "Spec / Lower"],
  "Column name",
);
assert.deepEqual(ordinaryId, {
  keyColumnName: "Column name",
  keyColumnIndex: 3,
  propertyColumnNames: ["ID", "Unit", "Spec / Lower"],
});

assert.equal(
  resolvePropertyTableLayout(["_row_id", "ID", "Unit"], "Column name"),
  null,
);

const dialogSource = readFileSync(
  new URL("../src/components/ManageExtrasDialog.tsx", import.meta.url),
  "utf8",
).replace(/\r\n/g, "\n");
assert.match(
  dialogSource,
  /resolvePropertyTableLayout\(allCols, t\("extras\.columnNameHeader"\)\)/,
  "ManageExtrasDialog must resolve the key column by its semantic header.",
);
assert.doesNotMatch(
  dialogSource,
  /const keyColName = visibleCols\[0\]|visibleCols\.slice\(1\)/,
  "ManageExtrasDialog must not infer property-table roles from column position.",
);

console.log("manage extras import layout tests passed");