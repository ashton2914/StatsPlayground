import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createTableTransformDraft } from "../src/components/tableTransform/createTableTransformDraft.ts";
import { DEFAULT_TABLE_TRANSFORM_TYPE, TABLE_TRANSFORM_TYPES } from "../src/components/tableTransform/tableTransformOptions.ts";
import { selectWorkspaceDocument } from "../src/components/analysis/analysisWorkspaceLifecycle.ts";
import type { TableTransformOperation } from "../src/types/tableTransform.ts";

assert.equal(DEFAULT_TABLE_TRANSFORM_TYPE, "summary");
assert.deepEqual(TABLE_TRANSFORM_TYPES, [
  "summary",
  "subset",
  "sort",
  "stack",
  "split",
  "transpose",
  "join",
  "update",
  "concatenate",
]);

const dataTableViewSource = readFileSync(
  new URL("../src/components/DataTableView.tsx", import.meta.url),
  "utf8",
);
const workspaceSource = readFileSync(
  new URL("../src/components/Workspace.tsx", import.meta.url),
  "utf8",
);
const dialogSource = readFileSync(
  new URL("../src/components/TableOpsDialog.tsx", import.meta.url),
  "utf8",
);

assert.doesNotMatch(dataTableViewSource, /onTableOp|menu\.opSummary|menu\.opConcatenate/);
assert.match(dataTableViewSource, /menu\.manageExtras/);
assert.doesNotMatch(workspaceSource, /handleExportTableTransform|handleImportTableTransform/);
assert.match(workspaceSource, /menu\.transform/);
assert.match(workspaceSource, /kind: "tableTransform"/);
assert.match(workspaceSource, /handleDeleteTableTransform/);
assert.match(dialogSource, /TABLE_TRANSFORM_TYPES\.map/);
assert.doesNotMatch(dialogSource, /interface Props \{\s*op:/);

const cases: Array<{
  operation: TableTransformOperation;
  tableIds: string[];
  roles: string[];
}> = [
  { operation: { kind: "sort", sortColumns: [{ column: "value", direction: "ascending" }] }, tableIds: ["table-a"], roles: ["source"] },
  { operation: { kind: "subset", columns: ["value"] }, tableIds: ["table-a"], roles: ["source"] },
  { operation: { kind: "transpose" }, tableIds: ["table-a"], roles: ["source"] },
  { operation: { kind: "stack", stackColumns: ["a"], idColumns: ["id"] }, tableIds: ["table-a"], roles: ["source"] },
  { operation: { kind: "split", splitColumn: "key", valueColumn: "value", idColumns: ["id"] }, tableIds: ["table-a"], roles: ["source"] },
  { operation: { kind: "summary", statisticColumns: ["value"], groupColumns: [], statistics: ["mean"] }, tableIds: ["table-a"], roles: ["source"] },
  { operation: { kind: "join", joinType: "inner", leftKey: "id", rightKey: "id" }, tableIds: ["table-left", "table-right"], roles: ["left", "right"] },
  { operation: { kind: "update", matchColumn: "id", updateColumns: ["value"] }, tableIds: ["table-left", "table-right"], roles: ["left", "right"] },
  { operation: { kind: "concatenate", sourceCount: 3 }, tableIds: ["table-a", "table-b", "table-c"], roles: ["source-1", "source-2", "source-3"] },
];

for (const { operation, tableIds, roles } of cases) {
  const draft = createTableTransformDraft("Reusable transform", "Output table", operation, tableIds);
  assert.deepEqual(draft.inputBindings.map(({ role }) => role), roles);
  assert.deepEqual(draft.inputBindings.map(({ tableDocumentId }) => tableDocumentId), tableIds);
  assert.equal(JSON.stringify(draft.operation).includes("table-"), false);
  assert.equal("id" in draft, false);
  assert.equal("inputSlots" in draft, false);
  assert.equal("output" in draft, false);
}

assert.throws(
  () => createTableTransformDraft("Invalid", "Output", cases[6].operation, ["only-left"]),
  /requires 2 input tables/,
);

const selection = selectWorkspaceDocument("tableTransform", "transform-1");
assert.equal(selection.activeTableTransformId, "transform-1");
assert.equal(selection.activeDatasetId, null);
assert.equal(selection.activeAnalysisId, null);
