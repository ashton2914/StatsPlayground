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
  dependencies: TableCommandDependencies = {
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
  },
) {
  const projectHandlers = dependencies.projectHandlers
    ?? createProjectCommandHandlers(dependencies.projectDependencies);

  async function createTable(input: TableCreateInput): Promise<TableCreateResult> {
    if (input.request.columns.length !== 0 && input.request.rows.length > 0) {
      for (const row of input.request.rows) {
        if (row.length !== input.request.columns.length) {
          throw new CommandExecutionError("invalid_input", "row width does not match column count");
        }
      }
    }

    const created = await dependencies.createManagedTable(input.request);
    await dependencies.refreshDatasets();

    const described = await projectHandlers.describeProjectTable({
      datasetId: created.id,
      preview: input.preview,
    });

    dependencies.markDirty();
    dependencies.activateDataset(created.id);
    dependencies.recordAction(dependencies.historyMessage(created.name));
    return described;
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
