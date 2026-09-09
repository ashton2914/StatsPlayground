import assert from "node:assert/strict";

import {
  buildTableExportPlan,
  buildTableExportTree,
  selectionState,
  setTableSelection,
} from "../src/components/tableExport/tableExportModel.ts";

const datasets = [
  { id: "root", name: "Root" },
  { id: "a", name: "A" },
  { id: "b", name: "B" },
];

const folders = { a: "Batch/One", b: "Batch/Two" };

assert.deepEqual(buildTableExportTree(datasets, folders).descendantIds, ["root", "a", "b"]);
assert.equal(selectionState(new Set(["a"]), ["a", "b"]), "mixed");
assert.deepEqual([...setTableSelection(new Set(["a", "b"]), ["b"], false)], ["a"]);

const tree = buildTableExportTree(datasets, folders);
assert.equal(tree.folders.length, 1);
assert.equal(tree.folders[0]?.name, "Batch");
assert.equal(tree.folders[0]?.folders[0]?.name, "One");
assert.deepEqual(tree.folders[0]?.folders[0]?.tables.map((table) => table.id), ["a"]);
assert.deepEqual(tree.folders[0]?.folders[0]?.tables.map((table) => table.folder), ["Batch/One"]);
assert.deepEqual(tree.folders[0]?.folders[0]?.descendantIds, ["a"]);
assert.equal(tree.folders[0]?.folders[0]?.folders.length, 0);
assert.deepEqual(tree.folders[0]?.folders[1]?.descendantIds, ["b"]);

const sameFolderDatasets = [
  { id: "b", name: "Beta" },
  { id: "a", name: "Alpha" },
];
const sameFolderAssignments = { a: "Batch/One", b: "Batch/One" };
const sameFolderTree = buildTableExportTree(sameFolderDatasets, sameFolderAssignments);
assert.deepEqual(sameFolderTree.folders[0]?.folders[0]?.tables.map((table) => table.id), ["a", "b"]);

const csvSingle = buildTableExportPlan({
  datasets,
  tableFolders: folders,
  selectedIds: new Set(["a"]),
  format: "csv",
  projectName: "A:/B*",
});
assert.equal(csvSingle?.mode, "single-file");
assert.equal(csvSingle?.suggestedFilename, "A-B-csv.zip");
assert.deepEqual(csvSingle?.datasetIds, ["a"]);
assert.deepEqual(csvSingle?.archivePaths, { a: "Batch/One/A" });
assert.deepEqual(csvSingle?.sqliteNames, { a: "Batch-One-A" });

const preservedDashProjectName = buildTableExportPlan({
  datasets,
  tableFolders: folders,
  selectedIds: new Set(["a"]),
  format: "csv",
  projectName: "-A-",
});
assert.equal(preservedDashProjectName?.suggestedFilename, "-A--csv.zip");

const fallbackProjectName = buildTableExportPlan({
  datasets,
  tableFolders: folders,
  selectedIds: new Set(["a"]),
  format: "csv",
  projectName: "...",
});
assert.equal(fallbackProjectName?.suggestedFilename, "export-csv.zip");

const csvMulti = buildTableExportPlan({
  datasets: sameFolderDatasets,
  tableFolders: sameFolderAssignments,
  selectedIds: new Set(["a", "b"]),
  format: "csv",
  projectName: "Project",
});
assert.equal(csvMulti?.mode, "zip");
assert.deepEqual(csvMulti?.datasetIds, ["b", "a"]);

const sptbSingle = buildTableExportPlan({
  datasets,
  tableFolders: folders,
  selectedIds: new Set(["a"]),
  format: "sptb",
  projectName: "Project",
});
assert.equal(sptbSingle?.mode, "single-file");

const sptbMulti = buildTableExportPlan({
  datasets,
  tableFolders: folders,
  selectedIds: new Set(["a", "b"]),
  format: "sptb",
  projectName: "Project",
});
assert.equal(sptbMulti?.mode, "zip");

const sqlitePlan = buildTableExportPlan({
  datasets,
  tableFolders: folders,
  selectedIds: new Set(["a", "b"]),
  format: "sqlite",
  projectName: "Project",
});
assert.equal(sqlitePlan?.mode, "sqlite-subset");
assert.deepEqual(sqlitePlan?.sqliteNames, { a: "Batch-One-A", b: "Batch-Two-B" });

const stalePlan = buildTableExportPlan({
  datasets,
  tableFolders: folders,
  selectedIds: new Set(["a", "missing"]),
  format: "sqlite",
  projectName: "Project",
});
assert.deepEqual(stalePlan?.datasetIds, ["a"]);
assert.equal(buildTableExportPlan({
  datasets,
  tableFolders: folders,
  selectedIds: new Set(["missing"]),
  format: "csv",
  projectName: "Project",
}), null);

console.log("table export model OK");