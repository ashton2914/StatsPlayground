import { CommandExecutionError } from "@/applicationCommands/runtime";
import {
  createProjectCommandHandlers,
  type ProjectCommandDependencies,
} from "@/applicationCommands/projectCommands";
import {
  runPostCreateCoordinator,
  TABLE_CREATE_POST_COMMIT_WARNINGS,
} from "@/applicationCommands/postCreateCoordinator";
import type {
  CommandWarning,
  TableCreateInput,
  TableCreateResult,
  TableDescribeInput,
  TableDescribeResult,
  TableListInput,
  TableListItem,
  TableListResult,
} from "@/applicationCommands/types";
import i18n from "@/i18n";
import { dataService } from "@/services/dataService";
import { useDataStore } from "@/stores/useDataStore";
import { useHistoryStore } from "@/stores/useHistoryStore";
import { useProjectStore } from "@/stores/useProjectStore";
import { useWorkspaceSelectionStore } from "@/stores/useWorkspaceSelectionStore";
import { selectWorkspaceDocument } from "@/components/analysis/analysisWorkspaceLifecycle";

export interface TableCommandDependencies {
  createManagedTable: typeof dataService.createManagedTable;
  refreshDatasets: () => Promise<void>;
  markDirty: () => void;
  recordAction: (description: string) => void;
  activateDataset: (datasetId: string) => void;
  historyMessage: (name: string) => string;
  projectHandlers?: ReturnType<typeof createProjectCommandHandlers>;
  projectDependencies?: ProjectCommandDependencies;
}

const MIN_TABLE_PREVIEW_LIMIT = 1;
const MAX_TABLE_PREVIEW_LIMIT = 200;

export function createTableCommandHandlers(
  dependencies: Partial<TableCommandDependencies> = {},
) {
  const resolvedDependencies: TableCommandDependencies = {
    createManagedTable: dataService.createManagedTable,
    refreshDatasets: () => useDataStore.getState().refreshDatasets(),
    markDirty: () => useProjectStore.getState().markDirty(),
    recordAction: (description) => useHistoryStore.getState().record(description),
    activateDataset: (datasetId) => {
      const selection = selectWorkspaceDocument("dataset", datasetId);
      useWorkspaceSelectionStore.getState().load(selection);
      useDataStore.getState().setActiveDataset(selection.activeDatasetId);
    },
    historyMessage: (name) => i18n.t("history.newTable", { name }),
    ...dependencies,
  };

  const projectHandlers = resolvedDependencies.projectHandlers
    ?? createProjectCommandHandlers(resolvedDependencies.projectDependencies);

  function toTableListItem(
    dataset: Awaited<ReturnType<typeof dataService.createManagedTable>>["dataset"],
  ): TableListItem {
    return {
      id: dataset.id,
      name: dataset.name,
      sourceType: dataset.sourceType,
      rowCount: dataset.rowCount,
      colCount: dataset.colCount,
      generation: dataset.generation,
      createdAt: dataset.createdAt,
      updatedAt: dataset.updatedAt,
      sourceName: null,
    };
  }

  function buildCreateResult(
    created: Awaited<ReturnType<typeof dataService.createManagedTable>>,
    input: TableCreateInput,
  ): TableCreateResult {
    const result: TableCreateResult = {
      dataset: toTableListItem(created.dataset),
      generation: created.generation,
      columns: created.columns,
    };

    if (input.preview) {
      const offset = input.preview.offset ?? 0;
      const limit = input.preview.limit;
      const rows = input.request.rows.slice(offset, offset + limit);
      result.preview = {
        offset,
        limit,
        totalRows: input.request.rows.length,
        rows: rows.map((row, rowOffset) => ({
          rowIndex: offset + rowOffset,
          cells: row.map((value, colIndex) => ({ colIndex, value })),
        })),
      };
    }

    return result;
  }

  async function createTable(
    input: TableCreateInput,
    controls?: { beginCommit?: () => void },
  ): Promise<{ result: TableCreateResult; warnings: CommandWarning[] }> {
    if (input.request.columns.length !== 0 && input.request.rows.length > 0) {
      for (const row of input.request.rows) {
        if (row.length !== input.request.columns.length) {
          throw new CommandExecutionError("invalid_input", "row width does not match column count");
        }
      }
    }

    if (input.preview) {
      if (!Number.isInteger(input.preview.limit)
        || input.preview.limit < MIN_TABLE_PREVIEW_LIMIT
        || input.preview.limit > MAX_TABLE_PREVIEW_LIMIT) {
        throw new CommandExecutionError(
          "invalid_input",
          `preview.limit must be between ${MIN_TABLE_PREVIEW_LIMIT} and ${MAX_TABLE_PREVIEW_LIMIT}`,
        );
      }
      if (input.preview.offset != null && (!Number.isInteger(input.preview.offset) || input.preview.offset < 0)) {
        throw new CommandExecutionError("invalid_input", "preview.offset must be a non-negative integer");
      }
    }

    controls?.beginCommit?.();
    const created = await resolvedDependencies.createManagedTable(input.request);
    const warnings: CommandWarning[] = [];
    await runPostCreateCoordinator({
      dependencies: resolvedDependencies,
      datasetId: created.dataset.id,
      historyMessage: resolvedDependencies.historyMessage(created.dataset.name),
      warnings,
      warningMap: TABLE_CREATE_POST_COMMIT_WARNINGS,
    });
    return { result: buildCreateResult(created, input), warnings };
  }

  async function completeMaterializedTable(
    created: import("@/types/data").DatasetMeta,
  ): Promise<{ result: TableCreateResult | null; warnings: CommandWarning[] }> {
    const warnings: CommandWarning[] = [];
    await runPostCreateCoordinator({
      dependencies: resolvedDependencies,
      datasetId: created.id,
      historyMessage: resolvedDependencies.historyMessage(created.name),
      warnings,
      warningMap: TABLE_CREATE_POST_COMMIT_WARNINGS,
    });
    let result: TableCreateResult = {
      dataset: {
        id: created.id,
        name: created.name,
        sourceType: created.sourceType,
        rowCount: created.rowCount,
        colCount: created.colCount,
        generation: created.generation,
        createdAt: created.createdAt,
        updatedAt: created.updatedAt,
        sourceName: created.sourcePath,
      },
      generation: created.generation,
      columns: [],
    };
    try {
      result = await projectHandlers.describeProjectTable({ datasetId: created.id });
    } catch {
      warnings.push({ code: "table_create_describe_failed", message: "Table created, but output inspection failed" });
    }
    return { result, warnings };
  }

  return {
    createTable,
    completeMaterializedTable,
    listProjectTables: (input: TableListInput): Promise<TableListResult> => projectHandlers.listProjectTables(input),
    describeProjectTable: (input: TableDescribeInput): Promise<TableDescribeResult> => projectHandlers.describeProjectTable(input),
  };
}

export function createProjectTable(input: TableCreateInput): Promise<TableCreateResult> {
  return createTableCommandHandlers().createTable(input).then((value) => value.result);
}

export function listProjectTables(input: TableListInput): Promise<TableListResult> {
  return createTableCommandHandlers().listProjectTables(input);
}

export function describeProjectTable(input: TableDescribeInput): Promise<TableDescribeResult> {
  return createTableCommandHandlers().describeProjectTable(input);
}
