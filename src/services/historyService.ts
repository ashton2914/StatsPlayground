import { invoke } from "@tauri-apps/api/core";
import type { ProjectDataSnapshot } from "@/types/history";

export const historyService = {
  captureProjectSnapshot: () =>
    invoke<ProjectDataSnapshot>("capture_project_snapshot"),

  restoreProjectSnapshot: (snapshot: ProjectDataSnapshot) =>
    invoke<void>("restore_project_snapshot", { snapshot }),
};
