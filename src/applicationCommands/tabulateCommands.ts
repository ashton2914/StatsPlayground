import { selectWorkspaceDocument } from "@/components/analysis/analysisWorkspaceLifecycle";
import { formatStatisticLabel } from "@/components/tabulate/TabulateStatisticEditor";
import { throwIfCommandCancelled } from "@/applicationCommands/cancellation";
import { createTableCommandHandlers } from "@/applicationCommands/tableCommands";
import { CommandExecutionError } from "@/applicationCommands/runtime";
import type {
  CommandWarning,
  TabulateCreateInput,
  TabulateCreateResult,
  TabulateExportTableInput,
  TabulateExportTableResult,
  TabulateRunInput,
  TabulateRunResult,
} from "@/applicationCommands/types";
import i18n from "@/i18n";
import { dataService } from "@/services/dataService";
import { tabulateService } from "@/services/tabulateService";
import { useAnalysisStore } from "@/stores/useAnalysisStore";
import { useDataStore } from "@/stores/useDataStore";
import { useHistoryStore } from "@/stores/useHistoryStore";
import { useProjectStore } from "@/stores/useProjectStore";
import { useTabulateStore } from "@/stores/useTabulateStore";
import { useWorkspaceSelectionStore } from "@/stores/useWorkspaceSelectionStore";
import { allocateProjectBasename, validateProjectBasename } from "@/utils/projectFileNaming";
import type { TabulateItem, TabulateSessionRequest } from "@/types/tabulate";

const TABULATE_EXTENSION = ".spf";

const TABULATE_RUN_SOURCE_CHANGED_WARNING: CommandWarning = {
  code: "tabulate_run_source_changed",
  message: "Tabulate finished, but source table changed during execution",
};

export interface TabulateCommandDependencies {
  listTabulates: () => TabulateItem[];
  listDatasets: () => Array<{ id: string; name: string }>;
  listTabulateNamesForAllocation: () => string[];
  createTabulateId: () => string;
  createNowIso: () => string;
  nextTabulateBaseName: () => string;
  addTabulate: (item: TabulateItem) => void;
  activateTabulate: (tabulateId: string) => void;
  markDirty: () => void;
  recordAction: (description: string) => void;
  historyCreateMessage: (name: string, sourceName: string) => string;
  isProjectReadOnly: () => boolean;
  getDatasetGeneration: (datasetId: string) => Promise<number>;
  prepareSession: typeof tabulateService.prepare;
  getSessionStatus: typeof tabulateService.getStatus;
  releaseSession: typeof tabulateService.release;
  materializeTable: typeof tabulateService.materializeTable;
  completeMaterializedTable: ReturnType<typeof createTableCommandHandlers>["completeMaterializedTable"];
}

function resolveTabulateSource(
  dependencies: TabulateCommandDependencies,
  sourceDatasetId: string,
): { id: string; name: string } {
  const source = dependencies.listDatasets().find((dataset) => dataset.id === sourceDatasetId);
  if (!source) {
    throw new CommandExecutionError("not_found", `Dataset ${sourceDatasetId} was not found`);
  }
  return source;
}

function resolveTabulateItem(
  dependencies: TabulateCommandDependencies,
  tabulateId: string,
): TabulateItem {
  const item = dependencies.listTabulates().find((entry) => entry.id === tabulateId);
  if (!item) {
    throw new CommandExecutionError("not_found", `Tabulate ${tabulateId} was not found`);
  }
  return item;
}

async function executeTabulateRun(
  dependencies: TabulateCommandDependencies,
  input: TabulateRunInput,
  controls?: { signal?: AbortSignal },
): Promise<{ data: TabulateRunResult; warnings: CommandWarning[] }> {
  const item = resolveTabulateItem(dependencies, input.tabulateId);
  if (item.sourceDatasetId !== input.request.datasetId) {
    throw new CommandExecutionError("invalid_input", "Tabulate request dataset does not match source table");
  }

  const sourceGenerationBefore = await dependencies.getDatasetGeneration(input.request.datasetId);
  throwIfCommandCancelled(controls?.signal);
  const prepared = await dependencies.prepareSession({
    datasetId: input.request.datasetId, sourceGeneration: sourceGenerationBefore,
    rowFields: [...input.request.rowFields], columnFields: [...input.request.columnFields],
    statistics: input.request.statistics.map((statistic) => ({ ...statistic })),
    includeRowTotals: input.request.includeRowTotals, includeColumnTotals: input.request.includeColumnTotals,
  });
  const warnings: CommandWarning[] = [];
  let data: TabulateRunResult | undefined;
  try {
    let session = prepared;
    const deadline = Date.now() + 120_000;
    for (;;) {
      throwIfCommandCancelled(controls?.signal);
      if (session.sessionId !== prepared.sessionId || session.fingerprint !== prepared.fingerprint
        || session.sourceGeneration !== sourceGenerationBefore) {
        throw new CommandExecutionError("execution_failed", "Tabulate session identity changed", true);
      }
      if (session.state !== "preparing") break;
      if (Date.now() >= deadline) {
        throw new CommandExecutionError("execution_failed", "Tabulate preparation timed out", true);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      throwIfCommandCancelled(controls?.signal);
      session = await dependencies.getSessionStatus(prepared.sessionId);
    }
    if (session.state !== "ready") {
      throw new CommandExecutionError(session.state === "cancelled" ? "cancelled" : "execution_failed",
        session.failureCode ?? "Tabulate session unavailable", true);
    }
    const sourceGenerationAfter = await dependencies.getDatasetGeneration(input.request.datasetId);
    throwIfCommandCancelled(controls?.signal);
    if (sourceGenerationAfter !== sourceGenerationBefore) warnings.push(TABULATE_RUN_SOURCE_CHANGED_WARNING);
    data = {
      tabulateId: input.tabulateId, requestFingerprint: session.fingerprint,
      sourceGeneration: sourceGenerationBefore, completedAt: dependencies.createNowIso(),
      session: {
        sessionId: session.sessionId, fingerprint: session.fingerprint, sourceGeneration: session.sourceGeneration,
        state: session.state, rowMemberCount: session.rowMemberCount, columnMemberCount: session.columnMemberCount,
        logicalCellCount: session.logicalCellCount, measuredMemberIndexBytes: session.measuredMemberIndexBytes,
      },
      cacheValid: sourceGenerationAfter === sourceGenerationBefore, leaseReleased: false,
    };
    return { data, warnings };
  } finally {
    try {
      await dependencies.releaseSession(prepared.sessionId);
      if (data) data.leaseReleased = true;
    } catch {
      warnings.push({ code: "tabulate_release_failed", message: "Tabulate session cleanup failed" });
    }
  }
}

export function createTabulateCommandHandlers(
  dependencies: Partial<TabulateCommandDependencies> = {},
) {
  const tableHandlers = createTableCommandHandlers();
  const resolvedDependencies: TabulateCommandDependencies = {
    listTabulates: () => useTabulateStore.getState().items,
    listDatasets: () => useDataStore.getState().datasets,
    listTabulateNamesForAllocation: () => {
      const analyses = useAnalysisStore.getState().items.map((analysis) => analysis.name);
      const tabulates = useTabulateStore.getState().items.map((item) => item.name);
      return [...analyses, ...tabulates];
    },
    createTabulateId: () => (
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `tabulate-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    ),
    createNowIso: () => new Date().toISOString(),
    nextTabulateBaseName: () => useTabulateStore.getState().nextName(),
    addTabulate: (item) => useTabulateStore.getState().addItem(item),
    activateTabulate: (tabulateId) => {
      useWorkspaceSelectionStore.getState().load(selectWorkspaceDocument("tabulate", tabulateId));
      useDataStore.getState().setActiveDataset(null);
    },
    markDirty: () => useProjectStore.getState().markDirty(),
    recordAction: (description) => useHistoryStore.getState().record(description),
    historyCreateMessage: (name, sourceName) => i18n.t("history.newTabulate", { name, source: sourceName }),
    isProjectReadOnly: () => useProjectStore.getState().readOnly,
    getDatasetGeneration: dataService.getDatasetGeneration,
    prepareSession: tabulateService.prepare,
    getSessionStatus: tabulateService.getStatus,
    releaseSession: tabulateService.release,
    materializeTable: tabulateService.materializeTable,
    completeMaterializedTable: tableHandlers.completeMaterializedTable,
    ...dependencies,
  };

  async function create(
    input: TabulateCreateInput,
    controls?: { beginCommit?: () => void },
  ): Promise<TabulateCreateResult> {
    if (!input.sourceDatasetId) {
      throw new CommandExecutionError("invalid_input", "sourceDatasetId is required");
    }
    const source = resolveTabulateSource(resolvedDependencies, input.sourceDatasetId);
    const id = resolvedDependencies.createTabulateId();
    const name = allocateProjectBasename(
      resolvedDependencies.nextTabulateBaseName(),
      TABULATE_EXTENSION,
      resolvedDependencies.listTabulateNamesForAllocation(),
    );

    controls?.beginCommit?.();

    const item: TabulateItem = {
      id,
      name,
      sourceDatasetId: source.id,
      rowFields: [],
      columnFields: [],
      statistics: [],
      includeRowTotals: true,
      includeColumnTotals: true,
      createdAt: resolvedDependencies.createNowIso(),
    };

    resolvedDependencies.addTabulate(item);
    resolvedDependencies.activateTabulate(item.id);
    resolvedDependencies.markDirty();
    resolvedDependencies.recordAction(resolvedDependencies.historyCreateMessage(item.name, source.name));

    return { item };
  }

  async function run(
    input: TabulateRunInput,
    controls?: { signal?: AbortSignal },
  ): Promise<{ data: TabulateRunResult; warnings: CommandWarning[] }> {
    if (!input.tabulateId) {
      throw new CommandExecutionError("invalid_input", "tabulateId is required");
    }
    return executeTabulateRun(resolvedDependencies, input, controls);
  }

  async function exportTable(
    input: TabulateExportTableInput,
    controls?: { signal?: AbortSignal; beginCommit?: () => void },
  ): Promise<{ data: TabulateExportTableResult; warnings: CommandWarning[] }> {
    if (!input.tabulateId) {
      throw new CommandExecutionError("invalid_input", "tabulateId is required");
    }
    if (validateProjectBasename(input.tableName)) {
      throw new CommandExecutionError("invalid_input", "Invalid table name");
    }
    if (resolvedDependencies.isProjectReadOnly()) {
      throw new CommandExecutionError("read_only", "Project is read-only");
    }

    const item = resolveTabulateItem(resolvedDependencies, input.tabulateId);
    if (item.sourceDatasetId !== input.request.datasetId) {
      throw new CommandExecutionError("invalid_input", "Tabulate request dataset does not match source table");
    }

    throwIfCommandCancelled(controls?.signal);
    const sourceGeneration = await resolvedDependencies.getDatasetGeneration(input.request.datasetId);
    throwIfCommandCancelled(controls?.signal);
    const definition: TabulateSessionRequest = {
      datasetId: input.request.datasetId,
      sourceGeneration,
      rowFields: [...input.request.rowFields],
      columnFields: [...input.request.columnFields],
      statistics: input.request.statistics.map((statistic) => ({ ...statistic })),
      includeRowTotals: input.request.includeRowTotals,
      includeColumnTotals: input.request.includeColumnTotals,
    };
    const prepared = await resolvedDependencies.prepareSession(definition);
    const warnings: CommandWarning[] = [];
    try {
      throwIfCommandCancelled(controls?.signal);
      let session = prepared;
      const deadline = Date.now() + 120_000;
      while (session.state === "preparing") {
        if (Date.now() >= deadline) {
          throw new CommandExecutionError("execution_failed", "Tabulate preparation timed out", true);
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
        throwIfCommandCancelled(controls?.signal);
        session = await resolvedDependencies.getSessionStatus(prepared.sessionId);
        throwIfCommandCancelled(controls?.signal);
      }
      if (session.state !== "ready") {
        throw new CommandExecutionError("execution_failed", session.failureCode ?? "Tabulate session unavailable", true);
      }
      if (session.sessionId !== prepared.sessionId || session.fingerprint !== prepared.fingerprint
        || session.sourceGeneration !== sourceGeneration
        || await resolvedDependencies.getDatasetGeneration(definition.datasetId) !== sourceGeneration) {
        throw new CommandExecutionError("execution_failed", "Source table changed during tabulate rerun; retry after source stabilizes", true);
      }
      throwIfCommandCancelled(controls?.signal);
      controls?.beginCommit?.();
      const created = await resolvedDependencies.materializeTable({
        sessionId: session.sessionId,
        fingerprint: session.fingerprint,
        sourceGeneration,
        destinationName: input.tableName,
        missingLabel: i18n.t("tabulate.missing"),
        statisticLabels: definition.statistics.map(formatStatisticLabel),
      });
      const completed = await resolvedDependencies.completeMaterializedTable(created);
      warnings.push(...completed.warnings);
      return {
        data: {
          outputTable: completed.result,
          reran: prepared.state !== "ready" || input.session?.sessionId !== session.sessionId
            || input.session.fingerprint !== session.fingerprint || input.session.sourceGeneration !== sourceGeneration,
          requestFingerprint: session.fingerprint,
          sourceGeneration,
        },
        warnings,
      };
    } finally {
      try {
        await resolvedDependencies.releaseSession(prepared.sessionId);
      } catch {
        warnings.push({ code: "tabulate_release_failed", message: "Tabulate session cleanup failed" });
      }
    }
  }

  return {
    create,
    run,
    exportTable,
  };
}

export type TabulateCommandFactory = ReturnType<typeof createTabulateCommandHandlers>;
