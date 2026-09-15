import type { ProjectCommandDependencies } from "@/applicationCommands/projectCommands";
import { createProjectCommandHandlers } from "@/applicationCommands/projectCommands";
import { CommandExecutionError } from "@/applicationCommands/runtime";
import { throwIfCommandCancelled } from "@/applicationCommands/cancellation";
import { mapTauriAppError } from "@/applicationCommands/tauriError";
import type {
  CommandWarning,
  TableTransformCommandData,
  TableTransformCreateInput,
  TableTransformRunInput,
} from "@/applicationCommands/types";
import i18n from "@/i18n";
import { useDataStore } from "@/stores/useDataStore";
import { useHistoryStore } from "@/stores/useHistoryStore";
import { useProjectStore } from "@/stores/useProjectStore";
import { useTableTransformStore } from "@/stores/useTableTransformStore";
import { useWorkspaceSelectionStore } from "@/stores/useWorkspaceSelectionStore";
import { selectWorkspaceDocument } from "@/components/analysis/analysisWorkspaceLifecycle";
import type {
  TableTransformBindingState,
  TableTransformDefinition,
  TableTransformExecutionResult,
} from "@/types/tableTransform";

export interface TableTransformCommandDependencies {
  preflightCreateAndRun: (
    input: TableTransformCreateInput["draft"],
  ) => Promise<void>;
  preflightRun: (transformId: string) => Promise<void>;
  createAndRun: (
    input: TableTransformCreateInput["draft"],
  ) => Promise<TableTransformExecutionResult>;
  rerun: (
    transformId: string,
  ) => Promise<TableTransformExecutionResult>;
  listDefinitions: () => TableTransformDefinition[];
  listBindings: () => TableTransformBindingState[];
  refreshDatasets: () => Promise<void>;
  markDirty: () => void;
  recordAction: (description: string) => void;
  activateDataset: (datasetId: string) => void;
  historyMessage: (name: string) => string;
  projectHandlers?: ReturnType<typeof createProjectCommandHandlers>;
  projectDependencies?: ProjectCommandDependencies;
}

const TRANSFORM_CREATE_WARNINGS: Record<"refresh" | "dirty" | "selection" | "history", CommandWarning> = {
  refresh: {
    code: "table_transform_refresh_failed",
    message: "Table transform completed, but dataset refresh failed",
  },
  dirty: {
    code: "table_transform_mark_dirty_failed",
    message: "Table transform completed, but dirty state update failed",
  },
  selection: {
    code: "table_transform_activate_dataset_failed",
    message: "Table transform completed, but dataset activation failed",
  },
  history: {
    code: "table_transform_history_failed",
    message: "Table transform completed, but history recording failed",
  },
};

const OUTPUT_READ_WARNING: CommandWarning = {
  code: "table_transform_output_describe_failed",
  message: "Table transform completed, but output inspection failed",
};

const COMMITTED_STATE_WARNING: CommandWarning = {
  code: "table_transform_committed_state_unavailable",
  message: "Table transform completed, but committed definition or binding could not be resolved",
};

async function runWarningSafe(
  effect: () => void | Promise<void>,
  warnings: CommandWarning[],
  warning: CommandWarning,
): Promise<void> {
  try {
    await effect();
  } catch {
    warnings.push(warning);
  }
}

function resolveCommittedState(
  dependencies: TableTransformCommandDependencies,
  definitionId: string,
  warnings: CommandWarning[],
) {
  const definition = dependencies.listDefinitions().find((item) => item.id === definitionId);
  const binding = dependencies.listBindings().find((item) => item.definitionId === definitionId);
  if (!definition || !binding) {
    warnings.push(COMMITTED_STATE_WARNING);
    return {
      definition: null,
      binding: null,
    };
  }
  return { definition, binding };
}

export function createTableTransformCommandHandlers(
  dependencies: Partial<TableTransformCommandDependencies> = {},
) {
  const resolvedDependencies: TableTransformCommandDependencies = {
    preflightCreateAndRun: (draft) => useTableTransformStore.getState().preflightCreateAndRun(draft),
    preflightRun: (transformId) => useTableTransformStore.getState().preflightRun(transformId),
    createAndRun: (draft) => useTableTransformStore.getState().createAndRun(draft),
    rerun: (transformId) => useTableTransformStore.getState().rerun(transformId),
    listDefinitions: () => useTableTransformStore.getState().definitions,
    listBindings: () => useTableTransformStore.getState().bindings,
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

  async function buildCommandData(
    execution: TableTransformExecutionResult,
    warnings: CommandWarning[],
  ): Promise<TableTransformCommandData> {
    const persisted = resolveCommittedState(resolvedDependencies, execution.definitionId, warnings);
    let outputTable = null;
    if (execution.output) {
      try {
        outputTable = await projectHandlers.describeProjectTable({ datasetId: execution.output.id });
      } catch {
        warnings.push(OUTPUT_READ_WARNING);
      }
    }
    return {
      execution,
      definition: persisted.definition,
      binding: persisted.binding,
      outputTable,
      targetDatasetGeneration: outputTable?.generation ?? execution.runState.outputGeneration ?? null,
    };
  }

  async function create(
    input: TableTransformCreateInput,
    controls?: { signal?: AbortSignal; beginCommit?: () => void },
  ): Promise<{ data: TableTransformCommandData; warnings: CommandWarning[] }> {
    try {
      await resolvedDependencies.preflightCreateAndRun(input.draft);
    } catch (error) {
      throw mapTauriAppError(error);
    }

    throwIfCommandCancelled(controls?.signal);
    controls?.beginCommit?.();

    let execution: TableTransformExecutionResult;
    try {
      execution = await resolvedDependencies.createAndRun(input.draft);
    } catch (error) {
      throw mapTauriAppError(error);
    }
    const warnings: CommandWarning[] = [];

    await runWarningSafe(
      () => resolvedDependencies.refreshDatasets(),
      warnings,
      TRANSFORM_CREATE_WARNINGS.refresh,
    );
    await runWarningSafe(
      () => resolvedDependencies.markDirty(),
      warnings,
      TRANSFORM_CREATE_WARNINGS.dirty,
    );

    if (execution.output) {
      const output = execution.output;
      await runWarningSafe(
        () => resolvedDependencies.activateDataset(output.id),
        warnings,
        TRANSFORM_CREATE_WARNINGS.selection,
      );
      await runWarningSafe(
        () => resolvedDependencies.recordAction(resolvedDependencies.historyMessage(output.name)),
        warnings,
        TRANSFORM_CREATE_WARNINGS.history,
      );
    }

    const data = await buildCommandData(execution, warnings);
    return { data, warnings };
  }

  async function run(
    input: TableTransformRunInput,
    controls?: { signal?: AbortSignal; beginCommit?: () => void },
  ): Promise<{ data: TableTransformCommandData; warnings: CommandWarning[] }> {
    if (!input.transformId) {
      throw new CommandExecutionError("invalid_input", "transformId is required");
    }

    try {
      await resolvedDependencies.preflightRun(input.transformId);
    } catch (error) {
      throw mapTauriAppError(error);
    }

    throwIfCommandCancelled(controls?.signal);
    controls?.beginCommit?.();

    let execution: TableTransformExecutionResult;
    try {
      execution = await resolvedDependencies.rerun(input.transformId);
    } catch (error) {
      throw mapTauriAppError(error);
    }
    const warnings: CommandWarning[] = [];
    await runWarningSafe(
      () => resolvedDependencies.refreshDatasets(),
      warnings,
      TRANSFORM_CREATE_WARNINGS.refresh,
    );
    await runWarningSafe(
      () => resolvedDependencies.markDirty(),
      warnings,
      TRANSFORM_CREATE_WARNINGS.dirty,
    );

    const data = await buildCommandData(execution, warnings);
    return { data, warnings };
  }

  return {
    create,
    run,
  };
}
