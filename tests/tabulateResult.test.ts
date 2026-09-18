import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  canAssignTabulateField,
  canExportTabulateResult,
  isNumericDuckDbType,
  parseQuantileInput,
  reorderForDrop,
} from "../src/components/tabulate/tabulateResult.ts";
import { useTabulateStore } from "../src/stores/useTabulateStore.ts";
import { useProjectStore } from "../src/stores/useProjectStore.ts";
import type { TabulateItem } from "../src/types/tabulate.ts";

const durableDefinition: TabulateItem = {
  id: "legacy-tabulate", name: "Saved Tabulate", sourceDatasetId: "dataset-1",
  rowFields: ["Region"], columnFields: ["Channel"],
  statistics: [{ id: "count", field: "Sales", kind: "count" }],
  includeRowTotals: true, includeColumnTotals: false,
  createdAt: "2026-08-13T00:00:00.000Z",
};
useTabulateStore.getState().loadFromProject([durableDefinition]);
useProjectStore.setState({ readOnly: true });
assert.deepEqual(JSON.parse(JSON.stringify(useTabulateStore.getState().items)), [durableDefinition]);
for (const mutate of [
  () => useTabulateStore.getState().addItem(durableDefinition),
  () => useTabulateStore.getState().updateItem(durableDefinition.id, { rowFields: [] }),
  () => useTabulateStore.getState().renameItem(durableDefinition.id, "Changed"),
  () => useTabulateStore.getState().deleteItem(durableDefinition.id),
  () => useTabulateStore.getState().nextName(),
]) assert.throws(mutate);
assert.deepEqual(useTabulateStore.getState().items, [durableDefinition]);
useTabulateStore.getState().reset();
assert.deepEqual(useTabulateStore.getState().items, []);
useTabulateStore.getState().loadFromProject([durableDefinition]);
assert.deepEqual(useTabulateStore.getState().items, [durableDefinition]);
useProjectStore.setState({ readOnly: false });
useTabulateStore.getState().reset();

const legacyPaths = [
  "src-tauri/src/models/tabulate.rs", "src-tauri/src/services/tabulate_service.rs",
  "src-tauri/src/engine/duckdb_engine.rs", "src-tauri/src/commands/tabulate_commands.rs",
  "src/types/tabulate.ts", "src/services/tabulateService.ts", "src/stores/useTabulateStore.ts",
  "src/types/index.ts",
  "src/applicationCommands/tabulateCommands.ts", "src/components/tabulate/tabulateResult.ts",
  "src/components/tabulate/TabulateResultTable.tsx",
];
const legacyMatches = legacyPaths.flatMap((path) => {
  const source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8").split(/#\[cfg\(test\)\]\s*mod tests\s*\{/)[0];
  return /\b(?:TabulateRequest|TabulateResult|TabulateLatestResult|MAX_RESULT_CELLS|MAX_RESULT_CELLS_STR|max_result_cells|maxResultCells|setLatestResult|getLatestResult|clearLatestResult|buildTabulateExportRequest)\b/.test(source) ? [path] : [];
});
assert.deepEqual(legacyMatches, [], "Task 9 removes the monolithic Tabulate runtime and compatibility shims");
for (const locale of ["en", "zh-CN", "zh-TW", "vi"]) {
  const copy = JSON.parse(readFileSync(new URL(`../src/i18n/locales/${locale}.json`, import.meta.url), "utf8")).tabulate;
  assert.equal("resultTooLargeDetail" in copy, false);
  assert.equal("resultTooLargeTitle" in copy, false);
}
assert.doesNotMatch(readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8"), /tabulate_commands::tabulate\s*,/);
assert.doesNotMatch(readFileSync(new URL("../src-tauri/src/commands/mutation_guard_coverage.rs", import.meta.url), "utf8"), /commands::tabulate_commands::tabulate"/);
assert.equal(isNumericDuckDbType("DECIMAL(18,2)"), true);
assert.equal(isNumericDuckDbType("INTERVAL"), false);
assert.equal(canExportTabulateResult(true, true, false, false, false), true);
assert.equal(canExportTabulateResult(true, false, false, false, false), false);
assert.equal(canExportTabulateResult(true, true, true, false, false), false);
assert.equal(canExportTabulateResult(true, true, false, true, false), false);
assert.equal(canExportTabulateResult(true, true, false, false, true), false);
assert.equal(canExportTabulateResult(false, true, false, false, false), false);

const tabulateViewSource = readFileSync(
  new URL("../src/components/tabulate/TabulateView.tsx", import.meta.url),
  "utf8",
);
const tabulateFieldListSource = readFileSync(
  new URL("../src/components/tabulate/TabulateFieldList.tsx", import.meta.url),
  "utf8",
);
const tabulateRoleZoneSource = readFileSync(
  new URL("../src/components/tabulate/TabulateRoleZone.tsx", import.meta.url),
  "utf8",
);
const tabulateResultTableSource = readFileSync(
  new URL("../src/components/tabulate/TabulateResultTable.tsx", import.meta.url),
  "utf8",
);
const tabulateCss = readFileSync(
  new URL("../src/components/tabulate/tabulate.css", import.meta.url),
  "utf8",
);
const tabulateTypesSource = readFileSync(
  new URL("../src/types/tabulate.ts", import.meta.url),
  "utf8",
);
const tabulateServiceSource = readFileSync(
  new URL("../src/services/tabulateService.ts", import.meta.url),
  "utf8",
);
const englishLocale = JSON.parse(readFileSync(
  new URL("../src/i18n/locales/en.json", import.meta.url),
  "utf8",
));

assert.match(tabulateViewSource, /from "\.\/tabulateResult"[\s\S]*canAssignTabulateField/);
assert.match(tabulateViewSource, /canAssignTabulateField\(/);
assert.ok((tabulateViewSource.match(/canAssignTabulateField\(/g) ?? []).length >= 3);
assert.match(tabulateViewSource, /workspace\.datasourceLabel/);
assert.match(tabulateViewSource, /workspace\.datasourceDeleted/);
assert.match(tabulateViewSource, /aria-expanded=\{!fieldsCollapsed\}/);
assert.match(tabulateViewSource, /tabulate\.expandColumns/);
assert.match(tabulateViewSource, /tabulate\.collapseColumns/);
assert.doesNotMatch(tabulateViewSource, /Unknown field/);
assert.match(tabulateFieldListSource, /className="sp-cols-panel-list"/);
assert.match(tabulateFieldListSource, /sp-cols-panel-item/);
assert.match(tabulateFieldListSource, /sp-cols-panel-item-type/);
assert.match(tabulateFieldListSource, /sp-cols-panel-item-name/);
assert.match(tabulateFieldListSource, /sp-cols-panel-item-drag/);
assert.match(tabulateFieldListSource, /kind: "field", fieldName: field\.name/);
assert.doesNotMatch(tabulateFieldListSource, /onAssign/);
assert.doesNotMatch(tabulateFieldListSource, /onDoubleClick/);
assert.doesNotMatch(tabulateFieldListSource, /<button/);
assert.match(
  tabulateRoleZoneSource,
  /onDragOver=\{\(event\) => \{\s*if \(!hasTabulateDragType\(event\.dataTransfer\.types\)\)/,
);
assert.match(
  tabulateRoleZoneSource,
  /onDrop=\{\(event\) => \{\s*event\.stopPropagation\(\);\s*const payload = readDragPayload/,
);
assert.match(tabulateViewSource, /applicationRuntime\.execute\(/);
assert.doesNotMatch(tabulateViewSource, /type: "tabulate\.run"|useState<TabulateResult|latestResultsById/);
assert.match(tabulateViewSource, /useTabulateSession\(/);
assert.match(tabulateResultTableSource, /buildVisibleHeaderSpans\(/);
assert.match(tabulateResultTableSource, /role="grid"/);
assert.match(tabulateViewSource, /type: "tabulate\.exportTable"/);
assert.match(tabulateViewSource, /resolveProjectBasenameForKind\(/);
assert.match(tabulateViewSource, /invalidName\.wrongExtension/);
assert.match(tabulateViewSource, /invalidName\.reserved/);
assert.match(tabulateViewSource, /exporting/);
assert.match(tabulateViewSource, /readOnly/);
assert.match(tabulateResultTableSource, /fa-table-arrow-up/);
assert.match(tabulateResultTableSource, /sp-tabulate-results-toolbar/);
assert.match(tabulateTypesSource, /interface TabulateSessionRequest/);
assert.doesNotMatch(
  tabulateTypesSource.match(/interface TabulateSessionRequest \{[\s\S]*?\n\}/)?.[0] ?? "",
  /maxResultCells/,
);
assert.doesNotMatch(
  tabulateTypesSource.match(/interface TabulateWindowResult \{[\s\S]*?\n\}/)?.[0] ?? "",
  /cells:\s*Array<number \| null>/,
);
for (const command of [
  "prepare_tabulate_session",
  "get_tabulate_session_status",
  "query_tabulate_window",
  "query_tabulate_totals",
  "cancel_tabulate_request",
  "release_tabulate_session",
  "materialize_tabulate_table",
]) {
  assert.equal(
    (tabulateServiceSource.match(new RegExp(`"${command}"`, "g")) ?? []).length,
    1,
    `${command} must have exactly one TypeScript wrapper`,
  );
}
assert.equal(englishLocale.tabulate.fields, "Columns");
assert.equal(englishLocale.tabulate.searchFields, "Search columns");
assert.equal(englishLocale.tabulate.rowsEmptyHint, "Drag columns here to build row nesting.");
assert.equal(englishLocale.tabulate.columnsEmptyHint, "Drag columns here to build column headers.");
assert.equal(englishLocale.tabulate.statisticsEmptyHint, "Drag a column here to add a statistic.");
assert.equal(englishLocale.tabulate.exportTable, "Export to Data Table");
assert.equal(englishLocale.tabulate.exportingTable, "Exporting...");
assert.equal(englishLocale.tabulate.exportTableFailed, "Failed to export Tabulate result to data table.");
assert.equal(englishLocale.history.tabulateTableCreated, "Create data table \"{{name}}\" from tabulate result");
const visibleTabulateCopy = Object.values(englishLocale.tabulate)
  .filter((value): value is string => typeof value === "string")
  .map((value) => value.replaceAll("{{field}}", ""))
  .join(" ");
assert.doesNotMatch(visibleTabulateCopy, /\bfields?\b/i);
assert.match(
  tabulateCss,
  /\.sp-tabulate-row-label,\s*\.sp-tabulate-corner-header\s*\{[^}]*position:\s*sticky;[^}]*z-index:\s*4;[^}]*width:\s*148px;[^}]*background-color:[^}]*box-shadow:\s*1px 0/,
);
assert.match(
  tabulateCss,
  /\.sp-tabulate-table thead th\.sp-tabulate-corner-header\s*\{\s*z-index:\s*[5-9];\s*\}/,
);
assert.match(
  tabulateCss,
  /@media \(max-width: 880px\)[\s\S]*\.sp-tabulate-view:not\(\.is-fields-collapsed\)\s*\{\s*grid-template-columns:\s*minmax\((?!52px)/,
);
assert.equal(parseQuantileInput(""), null);
assert.equal(parseQuantileInput("   "), null);
assert.equal(parseQuantileInput("-0.01"), null);
assert.equal(parseQuantileInput("1.01"), null);
assert.equal(parseQuantileInput("0"), 0);
assert.equal(parseQuantileInput("0.5"), 0.5);
assert.equal(parseQuantileInput("1"), 1);

assert.deepEqual(reorderForDrop(["A", "B", "C"], 0, 2), ["B", "A", "C"]);
assert.deepEqual(reorderForDrop(["A", "B", "C"], 2, 0), ["C", "A", "B"]);
assert.deepEqual(reorderForDrop(["A", "B", "C"], 0, 3), ["B", "C", "A"]);
assert.deepEqual(reorderForDrop(["A", "B", "C"], 1, 1), ["A", "B", "C"]);

const item = (id: string, name: string): TabulateItem => ({
  id,
  name,
  sourceDatasetId: "dataset-1",
  rowFields: [],
  columnFields: [],
  statistics: [],
  includeRowTotals: true,
  includeColumnTotals: true,
  createdAt: "2026-08-13T00:00:00.000Z",
});

useTabulateStore.getState().reset();
useTabulateStore.getState().loadFromProject([
  item("tab-2", "Tabulate 2"),
  item("custom", "Custom analysis"),
]);
assert.equal(useTabulateStore.getState().nextName(), "Tabulate 3");

useTabulateStore.getState().addItem(item("tab-8", "Tabulate 8"));
assert.equal(useTabulateStore.getState().nextName(), "Tabulate 9");
useTabulateStore.getState().renameItem("custom", "Tabulate 12");
assert.equal(useTabulateStore.getState().nextName(), "Tabulate 13");

useTabulateStore.getState().updateItem("tab-2", {
  rowFields: ["Region"],
  includeRowTotals: false,
});
assert.deepEqual(
  useTabulateStore.getState().items.find(({ id }) => id === "tab-2")?.rowFields,
  ["Region"],
);
assert.equal(
  useTabulateStore.getState().items.find(({ id }) => id === "tab-2")?.includeRowTotals,
  false,
);

useTabulateStore.getState().deleteItem("tab-8");
assert.equal(useTabulateStore.getState().items.some(({ id }) => id === "tab-8"), false);
assert.deepEqual(
  useTabulateStore.getState().items.map(({ id }) => id),
  ["tab-2", "custom"],
);
assert.equal("deleteByDataset" in useTabulateStore.getState(), false);

useTabulateStore.getState().reset();
assert.deepEqual(useTabulateStore.getState().items, []);
assert.equal(useTabulateStore.getState().counter, 0);
assert.equal("latestResultsById" in useTabulateStore.getState(), false);

console.log("tabulateResult helpers OK");

assert.equal(canAssignTabulateField("rows", ["Region"], "Store"), false);
assert.equal(canAssignTabulateField("columns", ["Region"], "Store"), true);
assert.equal(canAssignTabulateField("statistics", ["Sales"], "Profit"), true);
for (const name of ["setLatestResult", "getLatestResult", "clearLatestResult", "latestResultsById"]) {
  assert.equal(name in useTabulateStore.getState(), false);
}
