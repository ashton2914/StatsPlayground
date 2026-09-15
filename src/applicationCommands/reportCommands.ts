import { selectWorkspaceDocument } from "@/components/analysis/analysisWorkspaceLifecycle";
import { CommandExecutionError } from "@/applicationCommands/runtime";
import type {
  ReportCommandResult,
  ReportCreateInput,
  ReportUpdateInput,
} from "@/applicationCommands/types";
import i18n from "@/i18n";
import { useAnalysisStore } from "@/stores/useAnalysisStore";
import { useDataStore } from "@/stores/useDataStore";
import { useGraphBuilderStore } from "@/stores/useGraphBuilderStore";
import { useHistoryStore } from "@/stores/useHistoryStore";
import { useProjectStore } from "@/stores/useProjectStore";
import { useReportStore } from "@/stores/useReportStore";
import { useTabulateStore } from "@/stores/useTabulateStore";
import { useWorkspaceSelectionStore } from "@/stores/useWorkspaceSelectionStore";
import type { AnalysisDocument } from "@/types/analysis";
import type { DatasetMeta } from "@/types/data";
import type { GraphBuilderItem } from "@/types/graphBuilder";
import type { ReportDependency, ReportItem } from "@/types/report";
import type { TabulateItem } from "@/types/tabulate";
import { allocateProjectBasename } from "@/utils/projectFileNaming";
import { extractReportDependencies, parseReportMarkdown } from "@/utils/reportParser";

const REPORT_EXTENSION = ".sprp";
const REPORT_HISTORY_DELAY_MS = 700;

export interface ReportCommandDependencies {
  listDatasets: () => DatasetMeta[];
  listGraphs: () => GraphBuilderItem[];
  listReports: () => ReportItem[];
  listAnalyses: () => AnalysisDocument[];
  listTabulates: () => TabulateItem[];
  nextReportName: () => string;
  listReportNamesForAllocation: () => string[];
  createReportId: () => string;
  createNowIso: () => string;
  addReport: (item: ReportItem) => void;
  updateMarkdown: (id: string, markdown: string, updatedAt: string) => void;
  getDocumentRevision: (reportId: string) => number;
  setDocumentRevision: (reportId: string, revision: number) => void;
  activateReport: (reportId: string) => void;
  markDirty: () => void;
  recordAction: (description: string) => void;
  historyCreateMessage: (name: string) => string;
  historyEditMessage: (name: string) => string;
  scheduleTimer: (callback: () => void, delayMs: number) => number;
  cancelTimer: (timerId: number) => void;
}

function assertDocumentRevision(currentRevision: number, expectedRevision: number, id: string): void {
  if (expectedRevision !== currentRevision) {
    throw new CommandExecutionError("revision_conflict", "Report revision does not match expected revision", false, {
      id,
      expected: expectedRevision,
      actual: currentRevision,
    });
  }
}

function resolveReport(dependencies: ReportCommandDependencies, reportId: string): ReportItem {
  const report = dependencies.listReports().find((entry) => entry.id === reportId);
  if (!report) {
    throw new CommandExecutionError("not_found", `Report ${reportId} was not found`);
  }
  return report;
}

function validateReportDependencies(
  dependencies: ReportCommandDependencies,
  items: ReportDependency[],
): void {
  const datasetIds = new Set(dependencies.listDatasets().map((dataset) => dataset.id));
  const graphIds = new Set(dependencies.listGraphs().map((graph) => graph.id));
  const tabulateIds = new Set(dependencies.listTabulates().map((tabulate) => tabulate.id));
  const analyses = dependencies.listAnalyses();

  for (const item of items) {
    if (item.kind === "table" && datasetIds.has(item.documentId)) {
      continue;
    }
    if (item.kind === "graph" && graphIds.has(item.documentId)) {
      continue;
    }
    if (item.kind === "tabulate" && tabulateIds.has(item.documentId)) {
      continue;
    }
    if ((item.kind === "distribution" || item.kind === "fitYByX" || item.kind === "hypothesisTest")
      && analyses.some((analysis) => analysis.id === item.documentId && analysis.analysisKind === item.kind)) {
      continue;
    }
    throw new CommandExecutionError("invalid_input", `Report embed references missing ${item.kind} ${item.documentId}`, false, {
      kind: item.kind,
      documentId: item.documentId,
    });
  }
}

export function createReportCommandHandlers(
  dependencies: Partial<ReportCommandDependencies> = {},
) {
  let reportHistoryTimerId: number | null = null;
  let pendingReportHistory: { id: string; name: string } | null = null;

  const resolvedDependencies: ReportCommandDependencies = {
    listDatasets: () => useDataStore.getState().datasets,
    listGraphs: () => useGraphBuilderStore.getState().items,
    listReports: () => useReportStore.getState().items,
    listAnalyses: () => useAnalysisStore.getState().items,
    listTabulates: () => useTabulateStore.getState().items,
    nextReportName: () => useReportStore.getState().nextName(),
    listReportNamesForAllocation: () => useReportStore.getState().items.map((item) => item.name),
    createReportId: () => (
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `report-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    ),
    createNowIso: () => new Date().toISOString(),
    addReport: (item) => useReportStore.getState().addItem(item),
    updateMarkdown: (id, markdown, updatedAt) => useReportStore.getState().updateMarkdown(id, markdown, updatedAt),
    getDocumentRevision: (reportId) => useReportStore.getState().getDocumentRevision(reportId),
    setDocumentRevision: (reportId, revision) => useReportStore.getState().setDocumentRevision(reportId, revision),
    activateReport: (reportId) => {
      useWorkspaceSelectionStore.getState().load(selectWorkspaceDocument("report", reportId));
      useDataStore.getState().setActiveDataset(null);
    },
    markDirty: () => useProjectStore.getState().markDirty(),
    recordAction: (description) => useHistoryStore.getState().record(description),
    historyCreateMessage: (name) => i18n.t("history.newReport", { name }),
    historyEditMessage: (name) => i18n.t("history.editReport", { name }),
    scheduleTimer: (callback, delayMs) => window.setTimeout(callback, delayMs),
    cancelTimer: (timerId) => window.clearTimeout(timerId),
    ...dependencies,
  };

  function flushPendingHistory(): void {
    const pending = pendingReportHistory;
    if (!pending) {
      return;
    }
    pendingReportHistory = null;
    if (reportHistoryTimerId !== null) {
      resolvedDependencies.cancelTimer(reportHistoryTimerId);
      reportHistoryTimerId = null;
    }
    resolvedDependencies.recordAction(resolvedDependencies.historyEditMessage(pending.name));
  }

  function scheduleHistory(id: string, name: string): void {
    pendingReportHistory = { id, name };
    if (reportHistoryTimerId !== null) {
      resolvedDependencies.cancelTimer(reportHistoryTimerId);
    }
    reportHistoryTimerId = resolvedDependencies.scheduleTimer(() => {
      flushPendingHistory();
    }, REPORT_HISTORY_DELAY_MS);
  }

  function create(
    _input: ReportCreateInput,
    controls?: { beginCommit?: () => void },
  ): ReportCommandResult {
    const timestamp = resolvedDependencies.createNowIso();
    const item: ReportItem = {
      schemaVersion: 1,
      id: resolvedDependencies.createReportId(),
      name: allocateProjectBasename(
        resolvedDependencies.nextReportName(),
        REPORT_EXTENSION,
        resolvedDependencies.listReportNamesForAllocation(),
      ),
      markdown: "",
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    controls?.beginCommit?.();
    resolvedDependencies.addReport(item);
    resolvedDependencies.setDocumentRevision(item.id, 1);
    resolvedDependencies.activateReport(item.id);
    resolvedDependencies.markDirty();
    resolvedDependencies.recordAction(resolvedDependencies.historyCreateMessage(item.name));

    return { item, documentRevision: 1 };
  }

  function update(
    input: ReportUpdateInput,
    controls?: { beginCommit?: () => void },
  ): { changed: boolean; data: ReportCommandResult } {
    if (!input.reportId) {
      throw new CommandExecutionError("invalid_input", "reportId is required");
    }

    const current = resolveReport(resolvedDependencies, input.reportId);
    const currentRevision = resolvedDependencies.getDocumentRevision(input.reportId);
    assertDocumentRevision(currentRevision, input.expectedDocumentRevision, input.reportId);
    parseReportMarkdown(input.markdown);
    validateReportDependencies(resolvedDependencies, extractReportDependencies(input.markdown));

    if (current.markdown === input.markdown) {
      return {
        changed: false,
        data: {
          item: current,
          documentRevision: currentRevision,
        },
      };
    }

    const updatedAt = resolvedDependencies.createNowIso();
    controls?.beginCommit?.();
    resolvedDependencies.updateMarkdown(input.reportId, input.markdown, updatedAt);
    resolvedDependencies.setDocumentRevision(input.reportId, currentRevision + 1);
    resolvedDependencies.markDirty();
    scheduleHistory(input.reportId, current.name);

    return {
      changed: true,
      data: {
        item: {
          ...current,
          markdown: input.markdown,
          updatedAt,
        },
        documentRevision: currentRevision + 1,
      },
    };
  }

  return {
    create,
    update,
    flushPendingHistory,
  };
}