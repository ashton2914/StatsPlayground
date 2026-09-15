import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type JsonObject = Record<string, unknown>;

const TEST_FILE_DIR = dirname(fileURLToPath(import.meta.url));

function readSource(relativePath: string): string {
  return readFileSync(resolve(TEST_FILE_DIR, relativePath), "utf8").replace(/\r\n/g, "\n");
}

function readJson(relativePath: string): JsonObject {
  return JSON.parse(readSource(relativePath)) as JsonObject;
}

function getPathValue(root: JsonObject, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>((current, segment) => {
      if (!current || typeof current !== "object") {
        return undefined;
      }
      return (current as Record<string, unknown>)[segment];
    }, root);
}

function assertSourceIncludes(source: string, needle: string, message: string): void {
  assert.equal(source.includes(needle), true, message);
}

function assertSourceOrder(source: string, needles: string[], message: string): void {
  let offset = 0;
  for (const needle of needles) {
    const index = source.indexOf(needle, offset);
    assert.notEqual(index, -1, `${message}: missing or out of order: ${needle}`);
    offset = index + needle.length;
  }
}

const workspaceSource = readSource("../src/components/Workspace.tsx");

function sourceBetween(start: string, end: string): string {
  const startIndex = workspaceSource.indexOf(start);
  const endIndex = workspaceSource.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `Missing source boundary: ${start}`);
  assert.notEqual(endIndex, -1, `Missing source boundary: ${end}`);
  return workspaceSource.slice(startIndex, endIndex);
}

assertSourceIncludes(workspaceSource, "useReportStore", "Workspace must consume the report store");
assertSourceIncludes(workspaceSource, "ReportView", "Workspace must render the report main-pane view");
assertSourceIncludes(workspaceSource, "menu.report", "Workspace must expose a Report menu group");
assertSourceIncludes(workspaceSource, "handleCreateReport", "Workspace must expose a report creation action");

assertSourceIncludes(workspaceSource, "activeReportId", "Workspace must track the active report document");
assertSourceIncludes(workspaceSource, "clearWorkspaceDocumentSelection", "Opening or resetting the workspace must clear the active report");
assertSourceIncludes(workspaceSource, 'activateWorkspaceDocument("report", item.id)', "Selecting a report must activate it");
assertSourceIncludes(workspaceSource, "activeReportId === item.id", "DIRECTORY rows must highlight the active report");

assertSourceIncludes(workspaceSource, "reports: reportItems", "Project save payload must include reports");
assertSourceIncludes(workspaceSource, "reportFolders", "Project save/open payloads must include report folder assignments");
assertSourceIncludes(workspaceSource, "fsSetReportFolder", "Drop handling must assign reports into folders");
assertSourceIncludes(workspaceSource, "loadReportsFromProject((result.reports ?? [])", "Project open must load saved reports");
assertSourceIncludes(workspaceSource, "resetReports()", "Project close/open reset must clear the report store");
assertSourceIncludes(workspaceSource, "fsPrune(dsIds, gbIds, tabulateIds, fitYByXIds, distributionIds, reportIds, fitModelIds, analysisIds)", "Prune must include live report ids");

assertSourceIncludes(workspaceSource, "reportUpdateQueueRef", "Workspace must queue report updates so document revisions are read at execution time");
assertSourceIncludes(workspaceSource, 'type: "report.update"', "Workspace report edits must execute the shared report.update command");
assertSourceIncludes(workspaceSource, "getDocumentRevision(id)", "Workspace must read the runtime report document revision before update");
assertSourceIncludes(workspaceSource, "applicationRuntime.flushPendingEffects();", "Workspace must flush runtime report effects before leaving a report selection or before save/teardown");
assertSourceIncludes(workspaceSource, 'type: "report.create"', "Workspace report creation must execute the shared report.create command");
assertSourceIncludes(workspaceSource, "await flushPendingReportHistory();", "Workspace must await pending report command/history work before destructive transitions");

const renameReportSource = sourceBetween("const report = useReportStore.getState().items.find", "const oldName = datasets.find");
assertSourceOrder(renameReportSource, ["await flushPendingReportHistory();", "renameReport(id, basename);", "history.renameReport"], "Report rename history order");
const deleteReportSource = sourceBetween("const handleDeleteReport", "const handleDeleteAnalysis");
assertSourceOrder(deleteReportSource, ["await flushPendingReportHistory();", "deleteReport(id);", "history.deleteReport"], "Report delete history order");
assertSourceIncludes(sourceBetween("const handleSave = async () => {", "handleSaveRef.current = handleSave;"), "await flushPendingReportHistory();", "Saving must flush pending report updates/history before buildSaveProjectRequest reads live stores");
assertSourceIncludes(sourceBetween("const handleCloseProject", "const handleOpenAnother"), "await flushPendingReportHistory();", "Closing a project must flush pending report history before reset");
assertSourceIncludes(sourceBetween("const handleOpenAnother", "const singleExportBaseName"), "await flushPendingReportHistory();", "Opening another project must flush pending report history before reset");

assertSourceIncludes(workspaceSource, 'kind === "report"', "Report naming must have an explicit resolver branch");
assertSourceIncludes(workspaceSource, "reportItems.map((item) => item.name)", "Report rename must de-duplicate within the .sprp namespace");
assertSourceIncludes(workspaceSource, 'projectFileExtension("report")', "DIRECTORY rows must render the immutable .sprp suffix");

const reportViewSource = readSource("../src/components/report/ReportView.tsx");
assertSourceIncludes(reportViewSource, "ReportView", "ReportView component must exist");
assertSourceIncludes(reportViewSource, "item: ReportItem", "ReportView must accept a ReportItem prop");
assertSourceIncludes(workspaceSource, "distributionOptions={distributionAnalysisItems.map", "Workspace must offer Distribution Analysis documents in the Report insert toolbar");

const projectNamingSource = readSource("../src/utils/projectFileNaming.ts");
assertSourceIncludes(projectNamingSource, 'if (kind === "report") return ".sprp";', "Shared naming must map reports to .sprp");

const locales = [
  ["en", readJson("../src/i18n/locales/en.json")],
  ["vi", readJson("../src/i18n/locales/vi.json")],
  ["zh-CN", readJson("../src/i18n/locales/zh-CN.json")],
  ["zh-TW", readJson("../src/i18n/locales/zh-TW.json")],
] as const;

const requiredLocalePaths = [
  "menu.report",
  "menu.newReport",
  "history.newReport",
  "history.renameReport",
  "history.deleteReport",
  "history.editReport",
  "workspace.reportMissing",
  "report.placeholder",
];

for (const [localeName, messages] of locales) {
  for (const keyPath of requiredLocalePaths) {
    assert.equal(typeof getPathValue(messages, keyPath), "string", `${localeName} locale must define ${keyPath}`);
  }
}

console.log("Workspace report integration contract passed");
