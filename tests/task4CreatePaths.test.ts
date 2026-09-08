import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const manageExtrasSource = readFileSync(new URL("../src/components/ManageExtrasDialog.tsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const workspaceSource = readFileSync(new URL("../src/components/Workspace.tsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");

assert.match(
  manageExtrasSource,
  /await dataService\.createTableFromRows\(\{[\s\S]*?name,[\s\S]*?columnNames: colNames,[\s\S]*?columnTypes: colTypes,[\s\S]*?rows,[\s\S]*?\}\);/,
  "ManageExtras export must create the dataset via createTableFromRows and use one atomic request payload.",
);

assert.doesNotMatch(
  manageExtrasSource,
  /await dataService\.listDatasets\(\)\)\.find\(\(d\) => d\.name === name\)/,
  "ManageExtras export must not re-list datasets and find by requested name after create.",
);

assert.match(
  workspaceSource,
  /recordAction\(t\("history\.newTable", \{ name: meta\.name \}\)\);/,
  "Workspace new table history must use the backend-returned final dataset name.",
);

assert.match(
  workspaceSource,
  /setRenameValue\(meta\.name\);/,
  "Workspace new table rename prefill must use the backend-returned final dataset name.",
);

assert.match(
  workspaceSource,
  /handleCreateFitYByXItem[\s\S]*?resolveProjectBasename\([\s\S]*?"fitYByX"[\s\S]*?if \(resolved\.error\) \{[\s\S]*?alert\(resolved\.error\);[\s\S]*?return;/,
  "Fit Y by X creation must reject invalid project filenames before adding the item.",
);
assert.match(
  workspaceSource,
  /const requestedName = item\.name\.trim\(\);[\s\S]*?requestedName \|\| nextFitYByXName\(\)/,
  "Fit Y by X creation must not consume a default-name counter for non-empty submissions.",
);

console.log("task4 create paths contract passed");
