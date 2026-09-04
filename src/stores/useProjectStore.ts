import { create } from "zustand";
import type { ProjectInfo, OpenProjectResult } from "@/types/project";
import {
  projectService,
  type SaveProgress,
  type SaveProjectRequest,
} from "@/services/projectService";
import {
  assertProjectMutable,
  beginSaveState,
  completeSaveState,
  failSaveState,
  replaceSaveProgress,
} from "@/utils/saveReadOnly";

type ProjectServiceLike = Pick<
  typeof projectService,
  "initProject" | "createProject" | "openProject" | "saveProject" | "getCurrentProject"
>;

interface ProjectStoreDeps {
  projectService: ProjectServiceLike;
}

interface ProjectStore {
  /** 当前打开的项目 */
  project: ProjectInfo | null;
  /** 加载中 */
  loading: boolean;
  /** 是否有未保存的修改 */
  dirty: boolean;
  /** 保存进行中（用于禁用重复保存）。 */
  saving: boolean;
  /** 保存期间前端只读。 */
  readOnly: boolean;
  /** 保存进度（仅保存期间有效）。 */
  saveProgress: SaveProgress | null;
  /** 最近一次保存错误（保存失败时保留）。 */
  saveError: string | null;
  /** 初始化项目（内存中，未保存到磁盘） */
  initProject: () => Promise<void>;
  /** 创建新项目 */
  createProject: (name: string, filePath: string) => Promise<void>;
  /** 打开已有项目，返回历史/快照数据 */
  openProject: (filePath: string) => Promise<OpenProjectResult>;
  /** 保存项目（单请求对象，含可选 filePath 与目录归属映射）。 */
  saveProject: (request: SaveProjectRequest) => Promise<void>;
  /** 关闭项目 */
  closeProject: () => void;
  /** 标记有未保存的修改 */
  markDirty: () => void;
}

export function createProjectStore(
  deps: ProjectStoreDeps = { projectService },
) {
  let saveGeneration = 0;
  let activeSaveGeneration: number | null = null;

  return create<ProjectStore>((set, get) => ({
    project: null,
    loading: false,
    dirty: false,
    saving: false,
    readOnly: false,
    saveProgress: null,
    saveError: null,

    initProject: async () => {
      set({ loading: true });
      const project = await deps.projectService.initProject();
      set({ project, loading: false, dirty: false, saveError: null });
    },

    createProject: async (name, filePath) => {
      set({ loading: true });
      const project = await deps.projectService.createProject(name, filePath);
      set({ project, loading: false, dirty: false, saveError: null });
    },

    openProject: async (filePath) => {
      set({ loading: true });
      try {
        const result = await deps.projectService.openProject(filePath);
        const normalizedResult: OpenProjectResult = {
          ...result,
          documentNameMigrations: result.documentNameMigrations ?? [],
          datasetNameMigrations: result.datasetNameMigrations ?? [],
          requiresMigration: result.requiresMigration ?? false,
        };
        set({
          project: normalizedResult.project,
          dirty:
            normalizedResult.requiresMigration
            || normalizedResult.documentNameMigrations.length > 0
            || normalizedResult.datasetNameMigrations.length > 0,
          saveError: null,
        });
        return normalizedResult;
      } finally {
        set({ loading: false });
      }
    },

    saveProject: async (request) => {
      set((state) => ({
        ...beginSaveState({
          dirty: state.dirty,
          saving: state.saving,
          readOnly: state.readOnly,
          saveProgress: state.saveProgress,
        }),
        saveError: null,
      }));

      const generation = saveGeneration + 1;
      saveGeneration = generation;
      activeSaveGeneration = generation;

      try {
        const project = await deps.projectService.saveProject(request, (progress) => {
          if (activeSaveGeneration !== generation) return;
          set((state) => {
            if (!state.saving || activeSaveGeneration !== generation) return state;
            return {
              saveProgress: replaceSaveProgress(state.saveProgress, progress),
            };
          });
        });

        if (activeSaveGeneration !== generation) return;

        set((state) => ({
          project,
          ...completeSaveState({
            dirty: state.dirty,
            saving: state.saving,
            readOnly: state.readOnly,
            saveProgress: state.saveProgress,
          }),
          saveError: null,
        }));
      } catch (error) {
        if (activeSaveGeneration === generation) {
          set((state) => ({
            ...failSaveState({
              dirty: state.dirty,
              saving: state.saving,
              readOnly: state.readOnly,
              saveProgress: state.saveProgress,
            }),
            saveError: String(error),
          }));
        }
        throw error;
      } finally {
        if (activeSaveGeneration === generation) {
          activeSaveGeneration = null;
          set({ saving: false, readOnly: false, saveProgress: null });
        }
      }
    },

    closeProject: () => {
      activeSaveGeneration = null;
      set({
        project: null,
        dirty: false,
        saving: false,
        readOnly: false,
        saveProgress: null,
        saveError: null,
      });
    },

    markDirty: () => {
      assertProjectMutable(get().readOnly);
      set({ dirty: true });
    },
  }));
}

export const useProjectStore = createProjectStore();
