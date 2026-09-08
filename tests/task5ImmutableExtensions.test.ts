import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function read(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8").replace(/\r\n/g, "\n");
}

function requireIncludes(source: string, needle: string, message: string): void {
  assert.equal(source.includes(needle), true, message);
}

const workspaceSource = read("../src/components/Workspace.tsx");
const historySource = read("../src/components/HistoryPanel.tsx");
const historyStoreSource = read("../src/stores/useHistoryStore.ts");
const appCss = read("../src/App.css");
const locales = [
  read("../src/i18n/locales/en.json"),
  read("../src/i18n/locales/zh-CN.json"),
  read("../src/i18n/locales/zh-TW.json"),
  read("../src/i18n/locales/vi.json"),
];

requireIncludes(
  workspaceSource,
  "projectFileExtension",
  "Workspace must use projectFileExtension to render immutable file extensions.",
);
requireIncludes(
  workspaceSource,
  "withProjectExtension(ds.name, \"table\")",
  "Table rows must render full filenames including .sptb.",
);
requireIncludes(
  workspaceSource,
  "withProjectExtension(gb.name, \"graph\")",
  "Graph rows must render full filenames including .spgh.",
);
requireIncludes(
  workspaceSource,
  "withProjectExtension(item.name, \"fitYByX\")",
  "Fit Y by X rows must render full filenames including .spf.",
);
requireIncludes(
  workspaceSource,
  "withProjectExtension(item.name, \"tabulate\")",
  "Tabulate rows must render full filenames including .spf.",
);
requireIncludes(
  workspaceSource,
  "className=\"ds-rename-shell\"",
  "Workspace rename controls must wrap input and immutable extension suffix.",
);
requireIncludes(
  workspaceSource,
  "className=\"ds-fixed-ext\"",
  "Workspace rename controls must render an immutable extension suffix element.",
);
assert.equal(
  workspaceSource.includes("renameKindForId"),
  false,
  "Workspace must not derive immutable suffix kind via ID lookup/fallback.",
);
requireIncludes(
  workspaceSource,
  "projectFileExtension(\"table\")",
  "Table rename suffix must use statically known table kind.",
);
requireIncludes(
  workspaceSource,
  "projectFileExtension(\"graph\")",
  "Graph rename suffix must use statically known graph kind.",
);
requireIncludes(
  workspaceSource,
  "projectFileExtension(\"fitYByX\")",
  "Fit Y by X rename suffix must use statically known fitYByX kind.",
);
requireIncludes(
  workspaceSource,
  "projectFileExtension(\"tabulate\")",
  "Tabulate rename suffix must use statically known tabulate kind.",
);
requireIncludes(
  workspaceSource,
  "result.documentNameMigrations.length > 0",
  "Open-project migration feedback must use documentNameMigrations.",
);
requireIncludes(
  workspaceSource,
  "result.requiresMigration",
  "Open-project migration feedback must use requiresMigration.",
);

assert.equal(
  workspaceSource.includes("workspace.datasetNameMigrations"),
  false,
  "Workspace must not show table-only migration feedback after generalization.",
);

requireIncludes(
  historySource,
  "projectFileExtension",
  "History panel must use projectFileExtension for snapshot immutable suffix behavior.",
);
requireIncludes(
  historySource,
  "withSnapshotExtension(snap.name)",
  "Snapshot labels must render full filenames including .json.",
);
requireIncludes(
  historySource,
  "className=\"snapshot-rename-shell\"",
  "Snapshot rename must wrap input and immutable extension suffix.",
);
requireIncludes(
  historySource,
  "className=\"snapshot-fixed-ext\"",
  "Snapshot rename must render immutable .json suffix outside the input.",
);
requireIncludes(
  historyStoreSource,
  "formatSnapshotTimestamp",
  "Default snapshot names must use the filesystem-safe timestamp formatter.",
);
assert.equal(
  historyStoreSource.includes("${pad(d.getHours())}:${pad(d.getMinutes())}"),
  false,
  "Default snapshot names must not contain a colon-delimited time.",
);

assert.match(
  appCss,
  /\.ds-rename-shell\s*\{[^}]*min-width:\s*0;[^}]*\}/s,
  "Workspace rename shell must allow shrink in narrow sidebars.",
);
assert.match(
  appCss,
  /\.ds-fixed-ext\s*\{[^}]*flex-shrink:\s*0;[^}]*\}/s,
  "Workspace fixed extension suffix must remain visible while input shrinks.",
);
assert.match(
  appCss,
  /\.snapshot-rename-shell\s*\{[^}]*min-width:\s*0;[^}]*\}/s,
  "Snapshot rename shell must allow shrink in narrow sidebars.",
);
assert.match(
  appCss,
  /\.snapshot-fixed-ext\s*\{[^}]*flex-shrink:\s*0;[^}]*\}/s,
  "Snapshot fixed extension suffix must remain visible while input shrinks.",
);

for (const locale of locales) {
  assert.equal(
    locale.includes("\"documentNameMigrations\""),
    true,
    "Each locale must include generalized document-name migration feedback.",
  );
  assert.equal(
    locale.includes("\"projectRequiresMigration\""),
    true,
    "Each locale must include generalized requiresMigration feedback.",
  );
}

console.log("task5 immutable extension contract passed");
