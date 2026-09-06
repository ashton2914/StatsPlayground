import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { migrateLegacyGraphColumnName, reconcileGraphColumnIdentities } from "../src/components/graphBuilder/graphColumnIdentity.ts";
import { createDefaultGraph2DState, createDefaultGraph3DState, createDefaultMultivariateGraphState } from "../src/components/graphBuilder/graphBuilderMode.ts";
import type { GraphBuilderItem } from "../src/types/graphBuilder.ts";

const item: GraphBuilderItem = {
  id: "graph-1",
  name: "Graph 1",
  sourceDatasetId: "dataset-1",
  mode: "2d",
  modeStates: {
    twoD: {
      ...createDefaultGraph2DState(),
      encoding: {
        x: { columnId: "column-x", name: "Build", type: "nominal" },
        overlay: { columnId: "column-group", name: "Cavity", type: "nominal" },
      },
      multiY: [
        { columnId: "column-a1", name: "203-A1", type: "continuous" },
        { columnId: "column-a2", name: "203-A2", type: "continuous" },
        { columnId: "column-a3", name: "203-A3", type: "continuous" },
        { columnId: "column-a4", name: "203-A4", type: "continuous" },
      ],
    },
    threeD: {
      ...createDefaultGraph3DState(),
      encoding: {
        z: { columnId: "column-a1", name: "203-A1", type: "continuous" },
      },
    },
    multivariate: {
      ...createDefaultMultivariateGraphState(),
      columns: [{ columnId: "column-a1", name: "203-A1", type: "continuous" }],
    },
  },
  filters: [{
    id: "filter-1",
    op: "AND",
    rule: {
      kind: "continuous",
      field: { columnId: "column-a1", name: "203-A1", type: "continuous" },
      min: 0,
      max: 1,
    },
  }],
  groupThemeSlots: {
    Cavity: { A: 0 },
  },
  createdAt: "2026-09-03T00:00:00.000Z",
};

const descriptors = [
  { columnId: "column-x", name: "Build", sqlType: "VARCHAR" },
  { columnId: "column-group", name: "Cavity Renamed", sqlType: "VARCHAR" },
  { columnId: "column-a1", name: "203-A1 Long Name", sqlType: "DOUBLE" },
  { columnId: "column-a2", name: "203-A2", sqlType: "DOUBLE" },
  { columnId: "column-a3", name: "203-A3", sqlType: "DOUBLE" },
  { columnId: "column-a4", name: "203-A4", sqlType: "DOUBLE" },
];

const reconciled = reconcileGraphColumnIdentities(item, descriptors);

assert.notStrictEqual(reconciled, item, "a renamed bound column must update the graph item");
assert.equal(reconciled.modeStates.twoD.multiY[0]?.name, "203-A1 Long Name");
assert.equal(reconciled.modeStates.threeD.encoding.z?.name, "203-A1 Long Name");
assert.equal(reconciled.modeStates.multivariate.columns[0]?.name, "203-A1 Long Name");
assert.equal(reconciled.filters?.[0]?.rule.field.name, "203-A1 Long Name");
assert.deepEqual(reconciled.groupThemeSlots, {
  "Cavity Renamed": { A: 0 },
});

const legacyItem: GraphBuilderItem = {
  ...item,
  id: "legacy-graph",
  modeStates: {
    ...item.modeStates,
    twoD: {
      ...item.modeStates.twoD,
      multiY: [{ name: "203-A2", type: "continuous" }],
    },
  },
};

const migrated = reconcileGraphColumnIdentities(legacyItem, descriptors);
assert.equal(migrated.modeStates.twoD.multiY[0]?.columnId, "column-a2");

const renamedBeforeOpen = migrateLegacyGraphColumnName(
  legacyItem,
  "203-A2",
  "203-A2 Renamed Before Open",
  "DOUBLE",
);
assert.equal(renamedBeforeOpen.modeStates.twoD.multiY[0]?.name, "203-A2 Renamed Before Open");
assert.equal(renamedBeforeOpen.modeStates.twoD.multiY[0]?.columnId, undefined);

const stableBinding = migrateLegacyGraphColumnName(item, "203-A1", "wrong name", "DOUBLE");
assert.equal(stableBinding.modeStates.twoD.multiY[0]?.name, "wrong name");
assert.equal(stableBinding.modeStates.twoD.multiY[0]?.columnId, "column-a1");

const reopenedDescriptors = descriptors.map((descriptor) => (
  descriptor.columnId === "column-a1"
    ? { ...descriptor, columnId: "reopened-column-a1", name: "203-A1" }
    : descriptor
));
const reopened = reconcileGraphColumnIdentities(item, reopenedDescriptors);
assert.equal(reopened.modeStates.twoD.multiY[0]?.columnId, "reopened-column-a1");
assert.equal(reopened.modeStates.twoD.multiY[0]?.name, "203-A1");

const unchanged = reconcileGraphColumnIdentities(reconciled, descriptors);
assert.strictEqual(unchanged, reconciled, "reconciliation must preserve identity when nothing changed");

const readSource = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const runtimeSource = readSource("src/components/graphBuilder/GraphRuntime.tsx");
const viewSource = readSource("src/components/graphBuilder/GraphBuilderView.tsx");
const tableSource = readSource("src/components/DataTableView.tsx");
const workspaceSource = readSource("src/components/Workspace.tsx");
const tauriSource = readSource("src-tauri/src/lib.rs");

assert.match(runtimeSource, /dataService\.getColumnDescriptors\(dataset\.id\)/);
assert.match(runtimeSource, /reconcileGraphColumnIdentities\(item, columnDescriptors\)/);
assert.match(runtimeSource, /descriptorGeneration === dataset\.generation/);
assert.match(runtimeSource, /\[dataset\.generation, dataset\.id\]/);
assert.match(viewSource, /onItemReconciled=/);
assert.match(tableSource, /onColumnRenamed\?\.\(renameCol\.oldName, renameValue\.trim\(\), renameType\)/);
assert.match(workspaceSource, /migrateLegacyGraphColumnName\(activeDatasetId, oldName, newName, sqlType\)/);
assert.match(tauriSource, /commands::table_commands::get_column_descriptors/);

console.log("graph column identity tests passed");