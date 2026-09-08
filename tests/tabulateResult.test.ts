import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildHeaderSpans,
  canExportTabulateResult,
  canShowReadyResult,
  cellIndex,
  isNumericDuckDbType,
  isLatestSequence,
  parseQuantileInput,
  reorderForDrop,
  totalIndex,
} from "../src/components/tabulate/tabulateResult.ts";
import { useTabulateStore } from "../src/stores/useTabulateStore.ts";
import type { TabulateItem, TabulateResult } from "../src/types/tabulate.ts";

assert.equal(cellIndex(1, 2, 1, 4, 3), 19);
assert.equal(totalIndex(2, 1, 3), 7);

assert.deepEqual(buildHeaderSpans([["A", "x"], ["A", "y"], ["B", "x"]]), [
  [
    { label: "A", start: 0, span: 2 },
    { label: "B", start: 2, span: 1 },
  ],
  [
    { label: "x", start: 0, span: 1 },
    { label: "y", start: 1, span: 1 },
    { label: "x", start: 2, span: 1 },
  ],
]);

assert.deepEqual(
  buildHeaderSpans([
    ["A", null],
    ["A", "x"],
    ["A", null],
  ]),
  [
    [{ label: "A", start: 0, span: 3 }],
    [
      { label: null, start: 0, span: 1 },
      { label: "x", start: 1, span: 1 },
      { label: null, start: 2, span: 1 },
    ],
  ],
);

assert.deepEqual(
  buildHeaderSpans([
    ["A", "x"],
    ["B", "x"],
    ["A", "x"],
  ]),
  [
    [
      { label: "A", start: 0, span: 1 },
      { label: "B", start: 1, span: 1 },
      { label: "A", start: 2, span: 1 },
    ],
    [
      { label: "x", start: 0, span: 1 },
      { label: "x", start: 1, span: 1 },
      { label: "x", start: 2, span: 1 },
    ],
  ],
);

assert.equal(isLatestSequence(4, 4), true);
assert.equal(isLatestSequence(3, 4), false);
assert.equal(isNumericDuckDbType("DECIMAL(18,2)"), true);
assert.equal(isNumericDuckDbType("INTERVAL"), false);
assert.equal(canShowReadyResult(4, true, 1), true);
assert.equal(canShowReadyResult(4, false, 1), false);
assert.equal(canShowReadyResult(4, true, 0), false);
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
assert.match(tabulateResultTableSource, /style=\{\{ left: rowLabelIndex \* ROW_LABEL_WIDTH \}\}/);
assert.match(tabulateViewSource, /onTableCreated/);
assert.match(tabulateViewSource, /buildTabulateExportRequest/);
assert.match(tabulateViewSource, /createTableFromRows/);
assert.match(tabulateViewSource, /resolveProjectBasenameForKind\(/);
assert.match(tabulateViewSource, /invalidName\.wrongExtension/);
assert.match(tabulateViewSource, /invalidName\.reserved/);
assert.match(tabulateViewSource, /exporting/);
assert.match(tabulateViewSource, /readOnly/);
assert.match(tabulateResultTableSource, /fa-table-arrow-up/);
assert.match(tabulateResultTableSource, /sp-tabulate-results-toolbar/);
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

console.log("tabulateResult helpers OK");

// --- Export payload tests (Task 1) ---
{
  // Minimal item/result to exercise export builder
  const exportItem: Pick<TabulateItem, "rowFields" | "columnFields" | "statistics"> = {
    rowFields: ["Region"],
    columnFields: ["Zone", "Channel"],
    statistics: [
      { id: "s1", kind: "mean", field: "Sales" },
      { id: "s2", kind: "count", field: "Sales" },
    ],
  };

  const exportResult: Pick<TabulateResult, "rowMembers" | "columnMembers" | "statistics" | "cells"> = {
    rowMembers: [["North"], ["South"]],
    columnMembers: [["East", "Retail"], [null, "Retail"]],
    statistics: exportItem.statistics,
    cells: [10, 2, null, 1, 20, 4, 30, 6],
  };

  // require helpers to be exported; will fail until implemented
  // dynamic import to avoid top-level alias resolution issues in some runners
  const { buildTabulateExportRequest, canAssignTabulateField } = await import("../src/components/tabulate/tabulateResult.ts");

  assert.deepEqual(buildTabulateExportRequest(exportItem, exportResult, {
    tableName: "Sales Summary",
    missingLabel: "Missing",
    statisticLabel: (statistic: { kind: string }) => statistic.kind === "mean" ? "Mean" : "Count",
  }), {
    name: "Sales Summary",
    columnNames: [
      "Region",
      "East - Retail - Mean - Sales",
      "East - Retail - Count - Sales",
      "Missing - Retail - Mean - Sales",
      "Missing - Retail - Count - Sales",
    ],
    columnTypes: ["VARCHAR", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE"],
    rows: [["North", 10, 2, null, 1], ["South", 20, 4, 30, 6]],
  });

  assert.equal(canAssignTabulateField("rows", ["Region"], "Store"), false);
  assert.equal(canAssignTabulateField("columns", ["Region"], "Store"), true);
  assert.equal(canAssignTabulateField("statistics", ["Sales"], "Profit"), true);

  const missingRowPayload = buildTabulateExportRequest(
    exportItem,
    { ...exportResult, rowMembers: [[null], ["South"]] },
    {
      tableName: "T",
      missingLabel: "Missing",
      statisticLabel: (statistic: { kind: string }) => statistic.kind === "mean" ? "Mean" : "Count",
    },
  );
  assert.equal(missingRowPayload.rows[0][0], "Missing");

  assert.throws(
    () => buildTabulateExportRequest(
      { ...exportItem, rowFields: ["Region", "Store"] },
      exportResult,
      { tableName: "T", missingLabel: "Missing", statisticLabel: () => "S" },
    ),
    /at most one row field/i,
  );
  assert.throws(
    () => buildTabulateExportRequest(
      exportItem,
      { ...exportResult, columnMembers: [["East"]] },
      { tableName: "T", missingLabel: "Missing", statisticLabel: () => "S" },
    ),
    /column member depth/i,
  );
  assert.throws(
    () => buildTabulateExportRequest(
      exportItem,
      { ...exportResult, cells: exportResult.cells.slice(0, -1) },
      { tableName: "T", missingLabel: "Missing", statisticLabel: () => "S" },
    ),
    /cell count/i,
  );

  const noRowsItem = { ...exportItem, rowFields: [] };
  const noRowResult = { ...exportResult, rowMembers: [[]], cells: [10, 2, null, 1] };
  const noRowsPayload = buildTabulateExportRequest(noRowsItem, noRowResult, {
    tableName: "T",
    missingLabel: "Missing",
    statisticLabel: () => "S",
  });
  assert.deepEqual(noRowsPayload.rows, [[10, 2, null, 1]]);

  const noColumnsItem = { ...exportItem, columnFields: [] };
  const noColResult = { ...exportResult, columnMembers: [[]], cells: [10, 2, 20, 4] };
  const noColsPayload = buildTabulateExportRequest(noColumnsItem, noColResult, {
    tableName: "T",
    missingLabel: "Missing",
    statisticLabel: () => "S",
  });
  assert.deepEqual(noColsPayload.columnNames, ["Region", "S - Sales", "S - Sales (2)"]);
  assert.deepEqual(noColsPayload.rows, [["North", 10, 2], ["South", 20, 4]]);

  // duplicate generated names receive stable suffixes
  const dupColsResult = { ...exportResult, columnMembers: [["East", "Retail"], ["East", "Retail"]] };
  const dupPayload = buildTabulateExportRequest(exportItem, dupColsResult, {
    tableName: "T",
    missingLabel: "Missing",
    statisticLabel: (s: { kind: string }) => s.kind === "mean" ? "Mean" : "Count",
  });
  // Expect second generated column header to receive " (2)" for duplicates
  assert.ok(dupPayload.columnNames[1].endsWith("Mean - Sales") );
  assert.ok(dupPayload.columnNames[3].match(/\(2\)$/));
}