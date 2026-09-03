import { Channel, invoke } from "@tauri-apps/api/core";
import type { ProjectInfo, OpenProjectResult, ImportTableResult } from "@/types/project";
import type { DerivedFormulaDocV1, DistributionDocV1, DistributionIssueV1 } from "@/types/distribution";

/** Optional folder payload accepted by the save_project command.
 *  Folder maps are manifest metadata now; they are not used to route archive
 *  filenames. The backend persists them so UI folder layout stays separate
 *  from the stable `tables/<id>.sptb` and `graphs/<id>.spgh` paths. */
export interface SaveProjectFolders {
  /** All folder paths that exist in the project, including empty ones. */
  folders: string[];
  /** datasetId → folder path. Root datasets are simply absent. */
  tableFolders: Record<string, string>;
  /** graphId → folder path. Root graphs are simply absent. */
  graphFolders: Record<string, string>;
  /** fitYByXId → folder path. Root analyses are simply absent. */
  fitYByXFolders: Record<string, string>;
  /** fitModelId → folder path. Root analyses are simply absent. */
  fitModelFolders?: Record<string, string>;
  /** tabulateId → folder path. Root tabulates are simply absent. */
  tabulateFolders: Record<string, string>;
  /** analysisId → folder path. Root distributions are simply absent. */
  distributionFolders: Record<string, string>;
}

export interface SaveProjectRequest {
  filePath?: string;
  history: unknown[];
  snapshots: unknown[];
  graphBuilders: unknown[];
  fitYByX: unknown[];
  fitModels?: unknown[];
  tabulates: unknown[];
  distributions: DistributionDocV1[];
  derivedFormulas: DerivedFormulaDocV1[];
  distributionIssues: DistributionIssueV1[];
  folders: string[];
  tableFolders: Record<string, string>;
  graphFolders: Record<string, string>;
  fitYByXFolders: Record<string, string>;
  fitModelFolders?: Record<string, string>;
  tabulateFolders: Record<string, string>;
  distributionFolders: Record<string, string>;
}

export type SavePhase = "preparing" | "table" | "metadata" | "compressing" | "finalizing";

export interface SaveProgress {
  phase: SavePhase;
  tableIndex: number;
  tableTotal: number;
  tableName?: string;
  rowsDone: number;
  rowsTotal: number;
  overallProgress?: number;
}

export const projectService = {
  initProject: () =>
    invoke<ProjectInfo>("init_project"),

  createProject: (name: string, filePath: string) =>
    invoke<ProjectInfo>("create_project", { name, filePath }),

  openProject: (filePath: string) =>
    invoke<OpenProjectResult>("open_project", { filePath }),

  saveProject: (
    request: SaveProjectRequest,
    onProgress?: (progress: SaveProgress) => void,
  ) => {
    if (!onProgress) {
      return invoke<ProjectInfo>("save_project", { request });
    }
    const progressChannel = new Channel<SaveProgress>();
    progressChannel.onmessage = onProgress;
    return invoke<ProjectInfo>("save_project", { request, onProgress: progressChannel });
  },

  getCurrentProject: () => invoke<ProjectInfo | null>("get_current_project"),

  // ---- Single-table / single-graph share helpers --------------------------
  // .sptb = standalone table file, .spgh = standalone graph file. Both can
  // live by themselves on disk and can be re-imported into any project.

  /** Export one dataset to a `.sptb` file. */
  exportTable: (datasetId: string, filePath: string) =>
    invoke<void>("export_table", { datasetId, filePath }),

  /** Export multiple datasets as `.sptb` files packed into a `.zip`.
   *  `archivePaths` maps each dataset id to the file's path inside the zip
   *  (without `.sptb`), so the UI can mirror its folder tree. */
  exportTablesSptbZip: (
    datasetIds: string[],
    outputPath: string,
    archivePaths?: Record<string, string>,
  ) =>
    invoke<void>("export_tables_sptb_zip", {
      datasetIds,
      outputPath,
      archivePaths: archivePaths ?? null,
    }),

  /** Import a `.sptb` file. Returns the new dataset id assigned in the
   *  project. Per issue #7 the `.sptb` body carries no folder info; the
   *  caller decides where to place the imported table (defaults to root). */
  importTable: (filePath: string) =>
    invoke<ImportTableResult>("import_table", { filePath }),

  /** Export an opaque graph builder config to a `.spgh` file. */
  exportGraph: (graph: unknown, filePath: string) =>
    invoke<void>("export_graph", { graph, filePath }),

  /** Import a `.spgh` file and return its graph builder body. */
  importGraph: (filePath: string) =>
    invoke<unknown>("import_graph", { filePath }),
};
