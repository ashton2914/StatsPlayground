import { create } from "zustand";
import type { ProjectInfo } from "@/types/project";
import { projectService } from "@/services/projectService";

interface ProjectStore {
  /** 当前打开的项目 */
  project: ProjectInfo | null;
  /** 加载中 */
  loading: boolean;
  /** 是否有未保存的修改 */
  dirty: boolean;
  /** 创建新项目 */
  createProject: (name: string, filePath: string) => Promise<void>;
  /** 打开已有项目 */
  openProject: (filePath: string) => Promise<void>;
  /** 保存项目 */
  saveProject: () => Promise<void>;
  /** 关闭项目（返回欢迎页） */
  closeProject: () => void;
  /** 标记有未保存的修改 */
  markDirty: () => void;
}

export const useProjectStore = create<ProjectStore>((set) => ({
  project: null,
  loading: false,
  dirty: false,

  createProject: async (name, filePath) => {
    set({ loading: true });
    const project = await projectService.createProject(name, filePath);
    set({ project, loading: false, dirty: false });
  },

  openProject: async (filePath) => {
    set({ loading: true });
    const project = await projectService.openProject(filePath);
    set({ project, loading: false, dirty: false });
  },

  saveProject: async () => {
    await projectService.saveProject();
    set({ dirty: false });
  },

  closeProject: () => {
    set({ project: null, dirty: false });
  },

  markDirty: () => {
    set({ dirty: true });
  },
}));
