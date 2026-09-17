import type { CommandWarning } from "@/applicationCommands/types";

export type PostCreateStage = "refresh" | "dirty" | "selection" | "history";

export type PostCreateWarnings = Record<PostCreateStage, CommandWarning>;

export interface PostCreateCoordinatorDependencies {
  refreshDatasets: () => Promise<void>;
  markDirty: () => void;
  activateDataset: (datasetId: string) => void;
  recordAction: (description: string) => void;
}

export const TABLE_CREATE_POST_COMMIT_WARNINGS: PostCreateWarnings = {
  refresh: {
    code: "table_create_refresh_failed",
    message: "Table created, but dataset refresh failed",
  },
  dirty: {
    code: "table_create_mark_dirty_failed",
    message: "Table created, but dirty state update failed",
  },
  selection: {
    code: "table_create_activate_dataset_failed",
    message: "Table created, but dataset activation failed",
  },
  history: {
    code: "table_create_history_failed",
    message: "Table created, but history recording failed",
  },
};

export const SQL_CREATE_POST_COMMIT_WARNINGS: PostCreateWarnings = {
  refresh: {
    code: "sql_create_refresh_failed",
    message: "Table created from SQL, but dataset refresh failed",
  },
  dirty: {
    code: "sql_create_mark_dirty_failed",
    message: "Table created from SQL, but dirty state update failed",
  },
  selection: {
    code: "sql_create_activate_dataset_failed",
    message: "Table created from SQL, but dataset activation failed",
  },
  history: {
    code: "sql_create_history_failed",
    message: "Table created from SQL, but history recording failed",
  },
};

async function runStage(
  stage: PostCreateStage,
  effect: () => void | Promise<void>,
  warnings: CommandWarning[],
  warningMap: PostCreateWarnings,
): Promise<void> {
  try {
    await effect();
  } catch {
    warnings.push(warningMap[stage]);
  }
}

export async function runPostCreateCoordinator(input: {
  dependencies: PostCreateCoordinatorDependencies;
  datasetId: string;
  historyMessage: string;
  warnings: CommandWarning[];
  warningMap: PostCreateWarnings;
}): Promise<void> {
  await runStage("refresh", () => input.dependencies.refreshDatasets(), input.warnings, input.warningMap);
  await runStage("dirty", () => input.dependencies.markDirty(), input.warnings, input.warningMap);
  await runStage("selection", () => input.dependencies.activateDataset(input.datasetId), input.warnings, input.warningMap);
  await runStage("history", () => input.dependencies.recordAction(input.historyMessage), input.warnings, input.warningMap);
}