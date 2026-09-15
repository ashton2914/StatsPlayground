import { CommandExecutionError } from "@/applicationCommands/runtime";
import {
  createProjectCommandHandlers,
  type ProjectCommandDependencies,
} from "@/applicationCommands/projectCommands";
import type {
  TableCreateInput,
  TableCreateResult,
  TableDescribeInput,
  TableDescribeResult,
  TableListInput,
  TableListItem,
  TableListResult,
} from "@/applicationCommands/types";
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
    historyMessage: (name) => `Created table ${name}`,
    ...dependencies,
  };

  const projectHandlers = resolvedDependencies.projectHandlers
    ?? createProjectCommandHandlers(resolvedDependencies.projectDependencies);

  function toTableListItem(dataset: Awaited<ReturnType<typeof dataService.createManagedTable>>): TableListItem {
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
    const columns = input.request.columns.map((column, colIndex) => ({
      colIndex,
      colName: column.name,
      colType: column.columnType,
      width: column.display?.width,
      format: column.display?.format,
      extras: column.display?.extras,
    }));

    const result: TableCreateResult = {
      dataset: toTableListItem(created),
      generation: created.generation,
      columns,
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
  ): Promise<TableCreateResult> {
    if (input.request.columns.length !== 0 && input.request.rows.length > 0) {
      for (const row of input.request.rows) {
        if (row.length !== input.request.columns.length) {
          throw new CommandExecutionError("invalid_input", "row width does not match column count");
        }
      }
    }

    controls?.beginCommit?.();
    const created = await resolvedDependencies.createManagedTable(input.request);
    await resolvedDependencies.refreshDatasets();

    resolvedDependencies.markDirty();
    resolvedDependencies.activateDataset(created.id);
    resolvedDependencies.recordAction(resolvedDependencies.historyMessage(created.name));
    return buildCreateResult(created, input);
  }

  return {
    createTable,
    listProjectTables: (input: TableListInput): Promise<TableListResult> => projectHandlers.listProjectTables(input),
    describeProjectTable: (input: TableDescribeInput): Promise<TableDescribeResult> => projectHandlers.describeProjectTable(input),
  };
}

export function createProjectTable(input: TableCreateInput): Promise<TableCreateResult> {
  return createTableCommandHandlers().createTable(input);
}

export function listProjectTables(input: TableListInput): Promise<TableListResult> {
  return createTableCommandHandlers().listProjectTables(input);
}

export function describeProjectTable(input: TableDescribeInput): Promise<TableDescribeResult> {
  return createTableCommandHandlers().describeProjectTable(input);
}
