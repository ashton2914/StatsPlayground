import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const TEST_FILE_DIR = resolve(process.cwd(), "tests");

function readSource(relativePath: string): string {
  return readFileSync(resolve(TEST_FILE_DIR, relativePath), "utf8").replace(/\r\n/g, "\n");
}

function assertSourceIncludes(source: string, needle: string, message: string): void {
  assert.equal(source.includes(needle), true, message);
}

const workspaceSource = readSource("../src/components/Workspace.tsx");

assertSourceIncludes(workspaceSource, "useDistributionStore", "Workspace must consume the Distribution store");
assertSourceIncludes(workspaceSource, "DistributionDialog", "Workspace must render the Distribution dialog");
assertSourceIncludes(workspaceSource, "DistributionView", "Workspace must render the Distribution main-pane view");
assertSourceIncludes(workspaceSource, "menu.distribution", "Analysis menu must include menu.distribution");
assertSourceIncludes(workspaceSource, "handleCreateDistribution", "Distribution menu entry must open the creation flow");
assertSourceIncludes(workspaceSource, "handleCreateDistributionItem", "Validated dialog output must enter the document store");
assert.match(
  workspaceSource,
  /kind === "distribution"[\s\S]*existingNames = distributionItems\.map\(\(item\) => item\.name\)/,
  "Distribution create and rename must resolve collisions in the .spdist namespace before persistence",
);

assertSourceIncludes(workspaceSource, "activeDistributionId", "Workspace must track the active Distribution analysis");
assertSourceIncludes(workspaceSource, "showDistributionDialog", "Workspace must track the Distribution creation dialog");
assertSourceIncludes(workspaceSource, "addDistribution", "Workspace must add validated Distribution analyses");
assertSourceIncludes(workspaceSource, "renameDistribution", "Workspace must rename Distribution analyses from the tree");
assertSourceIncludes(workspaceSource, "deleteDistribution", "Workspace must delete Distribution analyses from the tree");
assertSourceIncludes(workspaceSource, "deleteDistributionByDataset", "Deleting a source table must cascade-delete Distribution analyses");
assertSourceIncludes(workspaceSource, "resetDistributions", "Project close/open must clear in-memory Distribution analyses");
assertSourceIncludes(workspaceSource, "fsSetDistributionFolder", "Workspace drag/drop must move Distribution analyses into folders");

assertSourceIncludes(workspaceSource, "| { kind: \"distribution\"; id: string }", "Drag payload and context menu unions must include Distribution items");
assertSourceIncludes(workspaceSource, "distributionByParent", "Tree grouping must include Distribution documents by folder");
assertSourceIncludes(workspaceSource, "setActiveDistributionId(null)", "Selecting another document kind must clear active Distribution selection");
assertSourceIncludes(workspaceSource, "setActiveDistributionId(id)", "Selecting a Distribution item must activate it");
assertSourceIncludes(workspaceSource, "setActiveDistributionId(item.id)", "Creating a Distribution item must activate it");
assertSourceIncludes(workspaceSource, "activeDistributionId === item.id", "Tree rows must show the active Distribution document");
assertSourceIncludes(workspaceSource, "sourceDatasetId === id", "Source-table deletion must recognize active dependent Distribution analyses");
assertSourceIncludes(workspaceSource, "history.newDistribution", "Creation must record Distribution history");
assertSourceIncludes(workspaceSource, "history.renameDistribution", "Rename must record Distribution history");
assertSourceIncludes(workspaceSource, "history.deleteDistribution", "Delete must record Distribution history");
assertSourceIncludes(workspaceSource, "draggable={!readOnly}", "Distribution tree movement must be disabled while read-only");
assertSourceIncludes(workspaceSource, "if (readOnly) return", "Distribution mutation handlers must guard read-only projects");

assertSourceIncludes(workspaceSource, "activeDistributionId ?", "Main-pane routing must dispatch active Distribution analyses");
assertSourceIncludes(workspaceSource, "workspace.distributionMissing", "Missing Distribution documents must have a workspace state");
assertSourceIncludes(workspaceSource, "<DistributionView item={item} dataset={ds}", "DistributionView must receive the item and matching or missing DatasetMeta");
assert.equal(workspaceSource.includes("DistributionWorkspace"), false, "Legacy DistributionWorkspace must stay deleted");
assert.equal(workspaceSource.includes("DistributionDirectoryItem"), false, "Legacy DistributionDirectoryItem must stay deleted");
assert.equal(workspaceSource.includes("DistributionChart"), false, "Legacy DistributionChart must stay deleted");
assert.equal(/startDistributionRun|cancelDistributionRun|snapshotId|runId/.test(workspaceSource), false, "Workspace must not restore legacy Distribution run APIs");

console.log("Workspace Distribution integration contract passed");