import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createApplicationRuntime } from "@/applicationCommands/applicationRuntime";
import type { AnalysisDocument } from "@/types/analysis";
import type { DatasetMeta } from "@/types/data";
import type { GraphBuilderItem } from "@/types/graphBuilder";
import type { ReportItem } from "@/types/report";
import type { TabulateItem } from "@/types/tabulate";

type JsonObject = Record<string, unknown>;

const TEST_FILE_DIR = dirname(fileURLToPath(import.meta.url));
const NOW = "2026-09-15T13:30:00.000Z";

function dataset(id: string, name: string): DatasetMeta {
  return {
    id,
    name,
    sourcePath: null,
    sourceType: "manual",
    rowCount: 5,
    colCount: 2,
    generation: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function graph(id: string, sourceDatasetId: string): GraphBuilderItem {
  return {
    id,
    name: "Graph 1",
    sourceDatasetId,
    mode: "2d",
    modeStates: {
      twoD: {
        encoding: {},
        multiX: [],
        multiY: [],
        elements: [{ kind: "points", enabled: true }],
        smootherLambda: 0.4,
      },
      threeD: {
        encoding: {},
        elements: [{ kind: "scatter3d", enabled: true }],
        smootherLambda: 0.4,
      },
      multivariate: {
        columns: [],
        chartType: "correlationMatrix",
        correlationMethod: "pearson",
      },
    },
    createdAt: NOW,
  };
}

function report(id: string, name = "Report 1", markdown = ""): ReportItem {
  return {
    schemaVersion: 1,
    id,
    name,
    markdown,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function fitYByXAnalysis(id: string, datasetId: string): AnalysisDocument {
  return {
    schemaVersion: 1,
    documentType: "analysis",
    id,
    name: "Fit Y by X 1",
    analysisKind: "fitYByX",
    configRevision: 1,
    source: { datasetId },
    definition: {
      kind: "fitYByX",
      x: { name: "x", type: "continuous" },
      y: { name: "y", type: "continuous" },
      fitLine: true,
      groups: [],
    },
    presentation: { schemaVersion: 1, layout: "fit-y-by-x-v1" },
    createdAt: NOW,
    updatedAt: NOW,
  } as AnalysisDocument;
}

function tabulate(id: string, sourceDatasetId: string): TabulateItem {
  return {
    id,
    name: "Tabulate 1",
    sourceDatasetId,
    rowFields: [],
    columnFields: [],
    statistics: [],
    includeRowTotals: true,
    includeColumnTotals: true,
    createdAt: NOW,
  };
}

function createDeferred<T>() {
  let resolvePromise: ((value: T | PromiseLike<T>) => void) | null = null;
  let rejectPromise: ((reason?: unknown) => void) | null = null;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: (value: T | PromiseLike<T>) => resolvePromise?.(value),
    reject: (reason?: unknown) => rejectPromise?.(reason),
  };
}

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

{
  const datasets = [dataset("table-1", "Sales")];
  const graphs = [graph("graph-1", "table-1")];
  const reports = [report("report-1")];
  const analyses = [fitYByXAnalysis("fit-1", "table-1")];
  const tabulates = [tabulate("tab-1", "table-1")];
  const documentRevisions = new Map<string, number>([["report-1", 1]]);
  const historyEntries: string[] = [];
  const scheduled = new Map<number, () => void>();
  let nextTimerId = 1;
  let dirty = false;
  const drainRelease = createDeferred<void>();

  const runtime = createApplicationRuntime({
    initialRevision: 8,
    project: {
      getProjectState: () => ({
        project: {
          name: "Task6",
          filePath: "/Users/ashton/projects/task6.spprj",
          createdAt: NOW,
        },
        dirty,
        readOnly: false,
        projectRevision: 8,
      }),
      listDatasets: () => datasets,
      listTableTransforms: () => [],
      listGraphs: () => graphs,
      listReports: () => reports,
      listAnalyses: () => analyses,
      listTabulates: () => tabulates,
      getColumns: async () => [],
      getColumnDisplayProps: async () => [],
      getDatasetGeneration: async () => 1,
    },
    report: {
      listDatasets: () => datasets,
      listGraphs: () => graphs,
      listReports: () => reports,
      listAnalyses: () => analyses,
      listTabulates: () => tabulates,
      nextReportName: () => "Report 2",
      listReportNamesForAllocation: () => reports.map((item) => item.name),
      createReportId: () => "report-new",
      createNowIso: () => NOW,
      addReport: (item: ReportItem) => {
        reports.push(item);
      },
      updateMarkdown: (id: string, markdown: string, updatedAt: string) => {
        const index = reports.findIndex((item) => item.id === id);
        reports[index] = { ...reports[index]!, markdown, updatedAt };
      },
      getDocumentRevision: (reportId: string) => documentRevisions.get(reportId) ?? 0,
      setDocumentRevision: (reportId: string, revision: number) => {
        documentRevisions.set(reportId, revision);
      },
      activateReport: () => {},
      markDirty: () => {
        dirty = true;
      },
      recordAction: (description: string) => {
        historyEntries.push(description);
      },
      historyCreateMessage: (name: string) => `Created report ${name}`,
      historyEditMessage: (name: string) => `Edited report ${name}`,
      scheduleTimer: (callback: () => void) => {
        const timerId = nextTimerId;
        nextTimerId += 1;
        scheduled.set(timerId, callback);
        return timerId;
      },
      cancelTimer: (timerId: number) => {
        scheduled.delete(timerId);
      },
    },
  });

  const unregisterDrain = runtime.registerPendingEffectsDrain(async () => {
    await drainRelease.promise;
    const expectedDocumentRevision = documentRevisions.get("report-1") ?? 0;
    await runtime.execute(
      {
        type: "report.update",
        input: {
          reportId: "report-1",
          expectedDocumentRevision,
          markdown: "After\n{{sp-embed kind=\"graph\" id=\"graph-1\"}}",
        },
        control: { expectedProjectRevision: 8 },
      },
      { kind: "ui" },
    );
  });

  const flushPromise = runtime.flushPendingEffects();
  assert.equal(reports[0]?.markdown, "");
  assert.equal(historyEntries.length, 0);
  drainRelease.resolve(undefined);
  await flushPromise;
  unregisterDrain();

  assert.equal(reports[0]?.markdown, "After\n{{sp-embed kind=\"graph\" id=\"graph-1\"}}");
  assert.equal(documentRevisions.get("report-1"), 2);
  assert.deepEqual(historyEntries, ["Edited report Report 1"]);
  assert.equal(scheduled.size, 0);
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
assertSourceIncludes(workspaceSource, "fsPrune(dsIds, gbIds, tabulateIds, fitYByXIds, distributionIds, reportIds, fitModelIds, analysisIds,", "Prune must include live Analysis and report ids");

assertSourceIncludes(workspaceSource, "reportUpdateQueueRef", "Workspace must queue report updates so document revisions are read at execution time");
assertSourceIncludes(workspaceSource, 'type: "report.update"', "Workspace report edits must execute the shared report.update command");
assertSourceIncludes(workspaceSource, "getDocumentRevision(id)", "Workspace must read the runtime report document revision before update");
assertSourceIncludes(workspaceSource, "await applicationRuntime.flushPendingEffects();", "Workspace must await runtime report effects before leaving a report selection or before save/teardown");
assertSourceIncludes(workspaceSource, 'type: "report.create"', "Workspace report creation must execute the shared report.create command");
assertSourceIncludes(workspaceSource, "await flushPendingReportHistory();", "Workspace must await pending report command/history work before destructive transitions");
assertSourceIncludes(workspaceSource, "registerPendingEffectsDrain", "Workspace must register its queued report updates with the runtime drain boundary");

const renameReportSource = sourceBetween("const report = useReportStore.getState().items.find", "const oldName = datasets.find");
assertSourceOrder(renameReportSource, ["await flushPendingReportHistory();", "renameReport(id, basename);", "history.renameReport"], "Report rename history order");
const deleteReportSource = sourceBetween("const handleDeleteReport", "const handleDeleteAnalysis");
assertSourceOrder(deleteReportSource, ["await flushPendingReportHistory();", "deleteReport(id);", "history.deleteReport"], "Report delete history order");
assertSourceIncludes(sourceBetween("const handleSave = async (saveAs = false) => {", "handleSaveRef.current = handleSave;"), "await flushPendingReportHistory();", "Saving must flush pending report updates/history before buildSaveProjectRequest reads live stores");
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
