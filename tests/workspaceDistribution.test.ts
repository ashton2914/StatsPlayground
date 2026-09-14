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
const distributionDialogSource = readSource("../src/components/distribution/DistributionDialog.tsx");

assertSourceIncludes(
  distributionDialogSource,
  'import "./distribution.css";',
  "DistributionDialog must load its own layout styles when the legacy DistributionView is not mounted",
);

assertSourceIncludes(workspaceSource, "DistributionDialog", "Workspace must render the Distribution dialog");
assertSourceIncludes(workspaceSource, "menu.distribution", "Analysis menu must include menu.distribution");
assertSourceIncludes(workspaceSource, "handleCreateDistribution", "Distribution menu entry must open the creation flow");
assertSourceIncludes(workspaceSource, "handleCreateDistributionItem", "Validated dialog output must enter the document store");
assertSourceIncludes(workspaceSource, "showDistributionDialog", "Workspace must track the Distribution creation dialog");
assertSourceIncludes(workspaceSource, "draggable={!readOnly}", "Distribution tree movement must be disabled while read-only");
assertSourceIncludes(workspaceSource, "if (readOnly) return", "Distribution mutation handlers must guard read-only projects");
assertSourceIncludes(workspaceSource, "createDistributionAnalysisDocument", "Distribution creation must produce an Analysis document");
assertSourceIncludes(workspaceSource, "addAnalysis(created)", "Distribution creation must use the Analysis store");
assertSourceIncludes(workspaceSource, "buildDistributionFieldInfo", "Workspace must build distribution field metadata from columns and display props");
assertSourceIncludes(workspaceSource, "Promise.all([", "Workspace must block the distribution dialog on parallel metadata loads");
assertSourceIncludes(workspaceSource, "dataService.getColumnDisplayProps(activeDatasetId)", "Distribution creation must load display props for the active dataset");
assertSourceIncludes(workspaceSource, "dataService.getColumnDisplayProps(dataset.id)", "Distribution edit must load display props for the analysis dataset");
assertSourceIncludes(workspaceSource, "shouldApplyDistributionCreateMetadataLoad", "Distribution creation must fence stale async metadata completions by dataset identity and epoch");
assertSourceIncludes(workspaceSource, "shouldApplyDistributionEditMetadataLoad", "Distribution edit must fence stale async metadata completions by analysis identity, dataset identity, and epoch");
assertSourceIncludes(workspaceSource, "shouldRetainTablePropertyManagerRequest", "Workspace must discard pending property-manager requests whose dataset has been removed");
assertSourceIncludes(workspaceSource, 'key={`${activeDatasetId}:${tableKey}`}', "Workspace must key DataTableView by dataset identity so navigation gets a dataset-isolated component lifetime.");
assertSourceIncludes(workspaceSource, "distributionCreateRequestEpochRef", "Workspace must track create-metadata request epochs");
assertSourceIncludes(workspaceSource, "distributionEditRequestEpochRef", "Workspace must track edit-metadata request epochs");
assertSourceIncludes(workspaceSource, "propertyManagerRequest", "Workspace must track the one-shot table property manager request");
assertSourceIncludes(workspaceSource, "crypto.randomUUID()", "Workspace must generate exact one-shot request IDs");
assertSourceIncludes(workspaceSource, 'extraKinds: ["spec"]', "Workspace must hand off the spec extra kind to the table property manager");
assertSourceIncludes(workspaceSource, "onPropertyManagerRequestHandled", "Workspace must clear the one-shot request only after acknowledgement");
assertSourceIncludes(workspaceSource, "activateWorkspaceDocument(\"dataset\", request.datasetId)", "Workspace must activate the source table before handing off the request");
assert.equal(workspaceSource.includes("useDistributionStore"), false, "Workspace must not own a legacy Distribution store");
assert.equal(workspaceSource.includes("DistributionView"), false, "Workspace must not render a legacy Distribution page");
assert.equal(workspaceSource.includes("activeDistributionId"), false, "Workspace must not track legacy Distribution selection");
assert.equal(workspaceSource.includes("distributionByParent"), false, "Directory must not render a second Distribution document family");
assert.equal(workspaceSource.includes("fsSetDistributionFolder"), false, "Folder actions must use Analysis assignments only");
assert.equal(workspaceSource.includes("history.newDistribution"), false, "Creation history must use the Analysis lifecycle");
assert.equal(workspaceSource.includes("DistributionWorkspace"), false, "Legacy DistributionWorkspace must stay deleted");
assert.equal(workspaceSource.includes("DistributionDirectoryItem"), false, "Legacy DistributionDirectoryItem must stay deleted");
assert.equal(workspaceSource.includes("DistributionChart"), false, "Legacy DistributionChart must stay deleted");
assert.equal(/startDistributionRun|cancelDistributionRun|snapshotId|runId/.test(workspaceSource), false, "Workspace must not restore legacy Distribution run APIs");

console.log("Workspace Distribution integration contract passed");