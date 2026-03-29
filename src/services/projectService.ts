import { invoke } from "@tauri-apps/api/core";
import type { ProjectInfo } from "@/types/project";

export const projectService = {
  initProject: () =>
    invoke<ProjectInfo>("init_project"),

  createProject: (name: string, filePath: string) =>
    invoke<ProjectInfo>("create_project", { name, filePath }),

  openProject: (filePath: string) =>
    invoke<ProjectInfo>("open_project", { filePath }),

  saveProject: (filePath?: string) =>
    invoke<ProjectInfo>("save_project", { filePath: filePath ?? null }),

  getCurrentProject: () => invoke<ProjectInfo | null>("get_current_project"),
};
