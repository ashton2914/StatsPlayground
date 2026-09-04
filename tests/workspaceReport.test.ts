import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type JsonObject = Record<string, unknown>;

const TEST_FILE_DIR = resolve(process.cwd(), "tests");

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
assertSourceIncludes(workspaceSource, "setActiveReportId(null)", "Opening any other document or resetting the workspace must clear the active report");
assertSourceIncludes(workspaceSource, "setActiveReportId(id)", "Selecting or creating a report must activate it");
assertSourceIncludes(workspaceSource, "activeReportId === item.id", "DIRECTORY rows must highlight the active report");

assertSourceIncludes(workspaceSource, "reports: reportItems", "Project save payload must include reports");
assertSourceIncludes(workspaceSource, "reportFolders", "Project save/open payloads must include report folder assignments");
assertSourceIncludes(workspaceSource, "setReportFolder", "Workspace must move reports through the folder store");
assertSourceIncludes(workspaceSource, "loadReportsFromProject((result.reports ?? [])", "Project open must load saved reports");
assertSourceIncludes(workspaceSource, "resetReports()", "Project close/open reset must clear the report store");
assertSourceIncludes(workspaceSource, "fsPrune(dsIds, gbIds, tabulateIds, fitYByXIds, distributionIds, reportIds)", "Prune must include live distribution and report ids");

assertSourceIncludes(workspaceSource, '| { kind: "report"; id: string }', "Drag payload and context menu unions must include reports");
assertSourceIncludes(workspaceSource, "reportsByParent", "Tree grouping must include reports by folder");
assertSourceIncludes(workspaceSource, "fsSetReportFolder", "Drop handling must assign reports into folders");
assertSourceIncludes(workspaceSource, "history.newReport", "Creation must record report history");
assertSourceIncludes(workspaceSource, "history.renameReport", "Rename must record report history");
assertSourceIncludes(workspaceSource, "history.deleteReport", "Delete must record report history");
const renameReportSource = sourceBetween("const report = useReportStore.getState().items.find", "const oldName = datasets.find");
assertSourceOrder(renameReportSource, ["flushPendingReportHistory();", "renameReport(id, basename);", "history.renameReport"], "Report rename history order");
const deleteReportSource = sourceBetween("const handleDeleteReport", "const handleDeleteDataset");
assertSourceOrder(deleteReportSource, ["flushPendingReportHistory();", "deleteReport(id);", "history.deleteReport"], "Report delete history order");
const flushReportHistorySource = sourceBetween("const flushPendingReportHistory", "const scheduleReportHistory");
assertSourceOrder(
  flushReportHistorySource,
  ["pendingReportHistoryRef.current = null;", "window.clearTimeout(reportHistoryTimerRef.current);", "reportHistoryTimerRef.current = null;", "recordAction("],
  "Flushing report history must cancel the delayed duplicate before recording",
);
assertSourceIncludes(
  sourceBetween("const handleCloseProject", "const handleOpenAnother"),
  "flushPendingReportHistory();",
  "Closing a project must flush pending report history before reset",
);
assertSourceIncludes(
  sourceBetween("const handleOpenAnother", "// ---- Folder-aware export helpers"),
  "flushPendingReportHistory();",
  "Opening another project must flush pending report history before reset",
);
assertSourceIncludes(
  workspaceSource,
  'kind === "report"',
  "Report naming must have an explicit resolver branch",
);
assertSourceIncludes(
  workspaceSource,
  "reportItems.map((item) => item.name)",
  "Report rename must de-duplicate within the .sprp namespace",
);

assertSourceIncludes(workspaceSource, "schemaVersion: 1", "New reports must start at schema version 1");
assertSourceIncludes(workspaceSource, 'name: allocateProjectBasename(', "New reports must allocate an independent basename through the shared naming policy");
assertSourceIncludes(workspaceSource, '".sprp"', "Report lifecycle must preserve the .sprp extension contract");
assertSourceIncludes(workspaceSource, 'projectFileExtension("report")', "DIRECTORY rows must render the immutable .sprp suffix");
assertSourceIncludes(workspaceSource, "createdAt: timestamp", "New reports must use one timestamp for createdAt");
assertSourceIncludes(workspaceSource, "updatedAt: timestamp", "New reports must use the same timestamp for updatedAt");
assertSourceIncludes(workspaceSource, "markdown: \"\"", "New reports must start with empty markdown");

const reportViewSource = readSource("../src/components/report/ReportView.tsx");
assertSourceIncludes(reportViewSource, "ReportView", "ReportView component must exist");
assertSourceIncludes(reportViewSource, "item: ReportItem", "ReportView must accept a ReportItem prop");

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
  "workspace.reportMissing",
  "report.placeholder",
];

for (const [localeName, messages] of locales) {
  for (const keyPath of requiredLocalePaths) {
    assert.equal(typeof getPathValue(messages, keyPath), "string", `${localeName} locale must define ${keyPath}`);
  }
}

console.log("Workspace report integration contract passed");
