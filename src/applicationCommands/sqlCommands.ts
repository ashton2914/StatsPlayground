import { CommandExecutionError } from "@/applicationCommands/runtime";
import type { SqlCreateTableInput, SqlCreateTableResult } from "@/applicationCommands/types";
import type { ProjectCommandDependencies } from "@/applicationCommands/projectCommands";
import { createProjectCommandHandlers } from "@/applicationCommands/projectCommands";
import {
  runPostCreateCoordinator,
  SQL_CREATE_POST_COMMIT_WARNINGS,
} from "@/applicationCommands/postCreateCoordinator";
import i18n from "@/i18n";
import { dataService } from "@/services/dataService";
import { useDataStore } from "@/stores/useDataStore";
import { useHistoryStore } from "@/stores/useHistoryStore";
import { useProjectStore } from "@/stores/useProjectStore";
import { useWorkspaceSelectionStore } from "@/stores/useWorkspaceSelectionStore";
import { selectWorkspaceDocument } from "@/components/analysis/analysisWorkspaceLifecycle";
import type { CommandWarning } from "./types";

const SQL_OUTPUT_WARNING: CommandWarning = {
  code: "sql_create_describe_failed",
  message: "Table created from SQL, but output inspection failed",
};

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export interface SqlCommandDependencies {
  createTableFromSqlQuery: typeof dataService.createTableFromSqlQuery;
  refreshDatasets: () => Promise<void>;
  markDirty: () => void;
  recordAction: (description: string) => void;
  activateDataset: (datasetId: string) => void;
  historyMessage: (name: string) => string;
  projectHandlers?: ReturnType<typeof createProjectCommandHandlers>;
  projectDependencies?: ProjectCommandDependencies;
}

export function createSqlCommandHandlers(
  dependencies: Partial<SqlCommandDependencies> = {},
) {
  const resolvedDependencies: SqlCommandDependencies = {
    createTableFromSqlQuery: dataService.createTableFromSqlQuery,
    refreshDatasets: () => useDataStore.getState().refreshDatasets(),
    markDirty: () => useProjectStore.getState().markDirty(),
    recordAction: (description) => useHistoryStore.getState().record(description),
    activateDataset: (datasetId) => {
      const selection = selectWorkspaceDocument("dataset", datasetId);
      useWorkspaceSelectionStore.getState().load(selection);
      useDataStore.getState().setActiveDataset(selection.activeDatasetId);
    },
    historyMessage: (name) => i18n.t("history.sqlQueryTableCreated", { name }),
    ...dependencies,
  };

  const projectHandlers = resolvedDependencies.projectHandlers
    ?? createProjectCommandHandlers(resolvedDependencies.projectDependencies);

  async function createTable(
    input: SqlCreateTableInput,
    controls?: { beginCommit?: () => void },
  ): Promise<{ result: SqlCreateTableResult; warnings: CommandWarning[] }> {
    if (!input.sql.trim()) {
      throw new CommandExecutionError("invalid_input", "sql is required");
    }
    if (!input.name.trim()) {
      throw new CommandExecutionError("invalid_input", "name is required");
    }

    controls?.beginCommit?.();

    let created;
    try {
      created = await resolvedDependencies.createTableFromSqlQuery(input.sql, input.name);
    } catch (error) {
      throw new CommandExecutionError("invalid_input", errorMessage(error));
    }

    const warnings: CommandWarning[] = [];
    await runPostCreateCoordinator({
      dependencies: resolvedDependencies,
      datasetId: created.id,
      historyMessage: resolvedDependencies.historyMessage(created.name),
      warnings,
      warningMap: SQL_CREATE_POST_COMMIT_WARNINGS,
    });

    let outputTable = null;
    try {
      outputTable = await projectHandlers.describeProjectTable({ datasetId: created.id });
    } catch {
      warnings.push(SQL_OUTPUT_WARNING);
    }

    return {
      result: {
        datasetId: created.id,
        datasetName: created.name,
        outputTable,
      },
      warnings,
    };
  }

  return {
    createTable,
  };
}
