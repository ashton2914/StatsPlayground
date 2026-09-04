import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function read(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8").replace(/\r\n/g, "\n");
}

const namingSource = read("../src/utils/projectFileNaming.ts");
assert.match(
  namingSource,
  /export function resolveProjectBasenameForKind\(/,
  "projectFileNaming must export resolveProjectBasenameForKind for shared create/rename naming policy",
);

const workspaceSource = read("../src/components/Workspace.tsx");
assert.match(
  workspaceSource,
  /resolveProjectBasenameForKind\(\s*`Table\$\{tableCounter\.current\}`,\s*"table"/,
  "Workspace new-table creation must go through shared naming resolution utility",
);
assert.equal(
  workspaceSource.includes('allocateProjectBasename(nextReportName(), ".sprp", reportItems.map((entry) => entry.name))'),
  true,
  "Workspace new-report creation must allocate report basenames through the shared .sprp naming utility",
);
assert.match(
  workspaceSource,
  /projectFileExtension\("report"\)/,
  "Workspace report rows must show the immutable .sprp suffix via the shared project naming utility",
);

const historyPanelSource = read("../src/components/HistoryPanel.tsx");
assert.match(
  historyPanelSource,
  /resolveProjectBasenameForKind\(\s*renameValue,\s*"snapshot"/,
  "HistoryPanel snapshot rename must use resolveProjectBasenameForKind instead of manual helper composition",
);

const sqlQuerySource = read("../src/components/SqlQueryDialog.tsx");
assert.match(
  sqlQuerySource,
  /resolveProjectBasenameForKind\(\s*newTableName,\s*"table"/,
  "SqlQueryDialog table creation must go through shared naming resolution utility",
);

const extrasSource = read("../src/components/ManageExtrasDialog.tsx");
assert.match(
  extrasSource,
  /resolveProjectBasenameForKind\(\s*proposed,\s*"table"/,
  "ManageExtrasDialog export-table creation must go through shared naming resolution utility",
);

assert.match(
  sqlQuerySource,
  /if \(resolved\.error === "wrongExtension"\)/,
  "SqlQueryDialog must surface a clear wrong-extension invalid-name error",
);
assert.match(
  extrasSource,
  /if \(resolved\.error === "wrongExtension"\)/,
  "ManageExtrasDialog must surface a clear wrong-extension invalid-name error",
);

const tabulateViewSource = read("../src/components/tabulate/TabulateView.tsx");
assert.match(
  tabulateViewSource,
  /resolveProjectBasenameForKind\(/,
  "TabulateView export-to-table must route the target name through shared .sptb resolver",
);

const dataServiceRustSource = read("../src-tauri/src/services/data_service.rs");
assert.match(
  dataServiceRustSource,
  /fn resolve_create_dataset_name\(/,
  "DataService must provide one shared backend create-name resolver for derived-table operations",
);
for (const methodName of [
  "sort_table",
  "subset_table",
  "transpose_table",
  "stack_table",
  "split_table",
  "summary_table",
  "join_tables",
  "concatenate_tables",
]) {
  assert.match(
    dataServiceRustSource,
    new RegExp(`pub fn ${methodName}\\([\\s\\S]*?resolve_create_dataset_name\\(`),
    `DataService::${methodName} must call shared backend create-name resolver`,
  );
}

console.log("project-file-naming integration contract passed");
