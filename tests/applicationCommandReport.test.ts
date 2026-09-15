import assert from "node:assert/strict";

import { createApplicationRuntime } from "@/applicationCommands/applicationRuntime";
import { CommandExecutionError, type CommandActor } from "@/applicationCommands/runtime";
import type { AnalysisDocument } from "@/types/analysis";
import type { DatasetMeta } from "@/types/data";
import type { GraphBuilderItem } from "@/types/graphBuilder";
import type { ReportItem } from "@/types/report";
import type { TabulateItem } from "@/types/tabulate";

const NOW = "2026-09-15T13:00:00.000Z";

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

async function createReportForActor(actor: CommandActor) {
  const reports: ReportItem[] = [];
  const documentRevisions = new Map<string, number>();
  const historyEntries: string[] = [];
  const activated: string[] = [];
  let dirty = false;
  let dirtyTransitions = 0;

  const runtime = createApplicationRuntime({
    initialRevision: 3,
    project: {
      getProjectState: () => ({
        project: {
          name: "Task6",
          filePath: "/Users/ashton/projects/task6.spprj",
          createdAt: NOW,
        },
        dirty,
        readOnly: false,
        projectRevision: 3,
      }),
      listDatasets: () => [],
      listTableTransforms: () => [],
      listGraphs: () => [],
      listReports: () => reports,
      listAnalyses: () => [],
      listTabulates: () => [],
      getColumns: async () => [],
      getColumnDisplayProps: async () => [],
      getDatasetGeneration: async () => 1,
    },
    report: {
      listDatasets: () => [],
      listGraphs: () => [],
      listReports: () => reports,
      listAnalyses: () => [],
      listTabulates: () => [],
      nextReportName: () => "Report 1",
      listReportNamesForAllocation: () => reports.map((item) => item.name),
      createReportId: () => "report-1",
      createNowIso: () => NOW,
      addReport: (item: ReportItem) => {
        reports.push(item);
      },
      updateMarkdown: () => {},
      getDocumentRevision: (reportId: string) => documentRevisions.get(reportId) ?? 0,
      setDocumentRevision: (reportId: string, revision: number) => {
        documentRevisions.set(reportId, revision);
      },
      activateReport: (reportId: string) => {
        activated.push(reportId);
      },
      markDirty: () => {
        if (!dirty) {
          dirtyTransitions += 1;
        }
        dirty = true;
      },
      recordAction: (description: string) => {
        historyEntries.push(description);
      },
      historyCreateMessage: (name: string) => `Created report ${name}`,
      historyEditMessage: (name: string) => `Edited report ${name}`,
      scheduleTimer: () => 1,
      cancelTimer: () => {},
    },
  });

  const result = await runtime.execute(
    {
      type: "report.create",
      input: {},
      control: { expectedProjectRevision: 3 },
    },
    actor,
  );

  return {
    result,
    reports,
    documentRevisions,
    historyEntries,
    activated,
    dirtyTransitions,
  };
}

{
  const ui = await createReportForActor({ kind: "ui" });
  const mcp = await createReportForActor({ kind: "mcp", sessionId: "session-report-create" });

  assert.deepEqual(ui.result.data.item, report("report-1"));
  assert.deepEqual(mcp.result.data.item, report("report-1"));
  assert.equal(ui.result.data.documentRevision, 1);
  assert.equal(mcp.result.data.documentRevision, 1);
  assert.equal(ui.result.projectRevision, 4);
  assert.equal(mcp.result.projectRevision, 4);
  assert.equal(ui.documentRevisions.get("report-1"), 1);
  assert.equal(mcp.documentRevisions.get("report-1"), 1);
  assert.equal(ui.historyEntries.length, 1);
  assert.equal(mcp.historyEntries.length, 1);
  assert.equal(ui.activated[0], "report-1");
  assert.equal(mcp.activated[0], "report-1");
  assert.equal(ui.dirtyTransitions, 1);
  assert.equal(mcp.dirtyTransitions, 1);
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
  let dirtyTransitions = 0;

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
        if (!dirty) {
          dirtyTransitions += 1;
        }
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

  const first = await runtime.execute(
    {
      type: "report.update",
      input: {
        reportId: "report-1",
        expectedDocumentRevision: 1,
        markdown: [
          "Before",
          '{{sp-embed kind="table" id="table-1"}}',
          '{{sp-embed kind="graph" id="graph-1"}}',
          '{{sp-embed kind="fitYByX" id="fit-1"}}',
          '{{sp-embed kind="tabulate" id="tab-1"}}',
        ].join("\n"),
      },
      control: { expectedProjectRevision: 8 },
    },
    { kind: "ui" },
  );

  const second = await runtime.execute(
    {
      type: "report.update",
      input: {
        reportId: "report-1",
        expectedDocumentRevision: 2,
        markdown: "After\n{{sp-embed kind=\"graph\" id=\"graph-1\"}}",
      },
      control: { expectedProjectRevision: 9 },
    },
    { kind: "ui" },
  );

  assert.equal(first.data.documentRevision, 2);
  assert.equal(second.data.documentRevision, 3);
  assert.equal(first.projectRevision, 9);
  assert.equal(second.projectRevision, 10);
  assert.equal(historyEntries.length, 0, "edit history should stay coalesced until flush");
  runtime.flushPendingEffects();
  assert.equal(historyEntries.length, 1, "flushed report edits should emit one history entry");
  assert.equal(historyEntries[0], "Edited report Report 1");
  assert.equal(dirtyTransitions, 1);

  await assert.rejects(
    runtime.execute(
      {
        type: "report.update",
        input: {
          reportId: "report-1",
          expectedDocumentRevision: 1,
          markdown: "stale",
        },
        control: { expectedProjectRevision: 10 },
      },
      { kind: "ui" },
    ),
    (error: unknown) => error instanceof CommandExecutionError && error.code === "revision_conflict",
  );

  await assert.rejects(
    runtime.execute(
      {
        type: "report.update",
        input: {
          reportId: "report-1",
          expectedDocumentRevision: 3,
          markdown: '{{sp-embed kind="graph" id="missing-graph"}}',
        },
        control: { expectedProjectRevision: 10 },
      },
      { kind: "ui" },
    ),
    (error: unknown) => error instanceof CommandExecutionError && error.code === "invalid_input",
  );

  assert.equal(reports[0]?.markdown, "After\n{{sp-embed kind=\"graph\" id=\"graph-1\"}}"
  );
  assert.equal(documentRevisions.get("report-1"), 3);
}

console.log("application command report lifecycle OK");