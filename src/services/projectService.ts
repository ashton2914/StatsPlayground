import { invoke } from "@tauri-apps/api/core";
import type { ProjectInfo } from "@/types/project";

export const projectService = {
  createProject: (name: string, filePath: string) =>
    invoke<ProjectInfo>("create_project", { name, filePath }),

  openProject: (filePath: string) =>
    invoke<ProjectInfo>("open_project", { filePath }),

  saveProject: () => invoke<void>("save_project"),

  getCurrentProject: () => invoke<ProjectInfo | null>("get_current_project"),
};
