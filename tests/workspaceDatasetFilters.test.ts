import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workspace = readFileSync(new URL("../src/components/Workspace.tsx", import.meta.url), "utf8");
const service = readFileSync(new URL("../src/services/projectService.ts", import.meta.url), "utf8");
const projectTypes = readFileSync(new URL("../src/types/project.ts", import.meta.url), "utf8");
const projectStore = readFileSync(new URL("../src/stores/useProjectStore.ts", import.meta.url), "utf8");

assert.match(service, /datasetFilters:\s*DatasetFilterMap/);
assert.match(projectTypes, /datasetFilters:\s*DatasetFilterMap/);
assert.match(projectTypes, /datasetFilterMigrationConflicts:\s*string\[\]/);

assert.match(workspace, /useDatasetFilterStore\.getState\(\)\.toProjectPayload\(\)/);
assert.match(workspace, /datasetFilters,/);
assert.match(workspace, /resetDatasetFilters\(\)/);
assert.match(workspace, /loadDatasetFiltersFromProject\(result\.datasetFilters\)/);
assert.match(workspace, /await dataService\.deleteDataset\(id\);[\s\S]*?removeDatasetFilters\(id\)/);
assert.match(
  workspace,
  /onColumnRenamed=\{\(oldName, newName, sqlType\) => \{[\s\S]*?renameDatasetFilterColumn\(activeDatasetId, oldName, newName\)/,
);
assert.match(workspace, /datasetFilterMigrationConflicts/);
assert.match(workspace, /workspace\.datasetFilterMigrationConflict/);
assert.match(workspace, /datasetNames\.get\(datasetId\) \?\? datasetId/);
assert.match(
  projectStore,
  /requiresMigration:\s*\(result\.requiresMigration \?\? false\)\s*\|\| datasetFilterMigrationConflicts\.length > 0/,
);

for (const locale of ["en", "zh-CN", "zh-TW", "vi"]) {
  const document = JSON.parse(
    readFileSync(new URL(`../src/i18n/locales/${locale}.json`, import.meta.url), "utf8"),
  ) as { workspace?: { datasetFilterMigrationConflict?: string } };
  const message = document.workspace?.datasetFilterMigrationConflict;
  assert.ok(message?.trim(), `${locale} must define workspace.datasetFilterMigrationConflict`);
  assert.match(message, /\{\{names\}\}/, `${locale} conflict message must interpolate dataset names`);
}

console.log("workspace dataset Filter lifecycle passed");