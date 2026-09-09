import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workspacePath = new URL("../src/components/Workspace.tsx", import.meta.url);
const source = readFileSync(workspacePath, "utf8");

function expectInOrder(block: string, tokens: readonly string[]): void {
  let previousIndex = -1;
  for (const token of tokens) {
    const index = block.indexOf(token);
    assert.notEqual(index, -1, `expected to find ${token}`);
    assert.ok(index > previousIndex, `expected ${token} after previous menu token`);
    previousIndex = index;
  }
}

function menuBlock(labelToken: string): string {
  const start = source.indexOf(`<MenuDropdown label={t("${labelToken}")}>`);
  assert.notEqual(start, -1, `missing ${labelToken} menu block`);
  const next = source.indexOf("</MenuDropdown>", start);
  assert.notEqual(next, -1, `missing closing MenuDropdown for ${labelToken}`);
  return source.slice(start, next);
}

const tableMenu = menuBlock("menu.table");
expectInOrder(tableMenu, [
  "menu.newTable",
  "menu.transform",
  "menu.tabulate",
  "menu.sqlQuery",
  "menu.importSptb",
  "menu.importCsv",
  "menu.importSqlite",
  "menu.exportTables",
]);
assert.equal(tableMenu.includes("menu.data"), false, "table menu should not mention menu.data");

assert.equal(source.includes('<MenuDropdown label={t("menu.data")}>'), false, "data menu should be removed");

const analyzeMenu = menuBlock("menu.analyze");
assert.equal(analyzeMenu.includes("menu.tabulate"), false, "Analyze menu should not contain Tabulate");

const graphMenu = menuBlock("menu.graph");
assert.equal(graphMenu.includes("menu.exportSpgh"), false, "Graph menu should not contain graph export");

const tableContextStart = source.indexOf('ctxMenu.kind === "table"');
assert.notEqual(tableContextStart, -1, "missing table context block");
const graphContextStart = source.indexOf('ctxMenu.kind === "graph"', tableContextStart);
assert.notEqual(graphContextStart, -1, "missing graph context block");
const tableContext = source.slice(tableContextStart, graphContextStart);
assert.equal(tableContext.includes("handleExportTableSptbFromCtx"), false, "table context should not expose SPTB export");
assert.equal(tableContext.includes("handleExportTableCsvFromCtx"), false, "table context should not expose CSV export");
assert.equal(tableContext.includes("handleExportTableSqliteFromCtx"), false, "table context should not expose SQLite export");

const folderContextStart = source.indexOf('ctxMenu.kind === "folder"');
assert.notEqual(folderContextStart, -1, "missing folder context block");
const emptyContextStart = source.indexOf('ctxMenu.kind === "empty"', folderContextStart);
assert.notEqual(emptyContextStart, -1, "missing empty context block");
const folderContext = source.slice(folderContextStart, emptyContextStart);
assert.equal(folderContext.includes("handleExportFolderSptbZip"), false, "folder context should not expose SPTB zip export");
assert.equal(folderContext.includes("handleExportFolderCsvZip"), false, "folder context should not expose CSV zip export");
assert.equal(folderContext.includes("handleExportFolderSqlite"), false, "folder context should not expose SQLite export");

assert.equal(source.includes("<TableExportDialog"), true, "Workspace should render TableExportDialog");

const pickerTitleStart = source.indexOf("const tableExportPickerTitle = useCallback");
assert.notEqual(pickerTitleStart, -1, "missing tableExportPickerTitle");
const pickerTitleEnd = source.indexOf("\n\n  const handleTableExport", pickerTitleStart);
assert.notEqual(pickerTitleEnd, -1, "missing tableExportPickerTitle boundary");
const pickerTitleHelper = source.slice(pickerTitleStart, pickerTitleEnd);
assert.equal(
  pickerTitleHelper.includes('tableExport.pickerTitle.${format}'),
  true,
  "tableExportPickerTitle should use format-specific locale keys",
);

const exportHandlerStart = source.indexOf("const handleTableExport = async (plan: TableExportPlan): Promise<boolean> => {");
assert.notEqual(exportHandlerStart, -1, "missing handleTableExport");
const exportHandlerEnd = source.indexOf("\n\n  // ---- Folder mutation helpers", exportHandlerStart);
assert.notEqual(exportHandlerEnd, -1, "missing handleTableExport boundary");
const exportHandler = source.slice(exportHandlerStart, exportHandlerEnd);
for (const token of [
  "open({ directory: true",
  "tableExportPickerTitle(plan.format)",
  "join(",
  "ioService.exportCsv",
  "ioService.exportCsvZipSubset",
  "ioService.exportSqliteSubset",
  "projectService.exportTable",
  "projectService.exportTablesSptbZip",
]) {
  assert.equal(exportHandler.includes(token), true, `expected handleTableExport to contain ${token}`);
}
assert.equal(exportHandler.includes('t("menu.exportTables"'), false, "handleTableExport should not use menu.exportTables for picker titles");

console.log("workspace issue 153 source contract OK");