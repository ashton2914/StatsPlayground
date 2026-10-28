import {invokeProjectExport} from "@/projectPersistence/exportRead";
import { Channel, invoke } from "@tauri-apps/api/core";
import type { AnalysisDocument } from "@/types/analysis";
import type { DistributionItem } from "@/types/distribution";
import type { DatasetFilterMap } from "@/stores/useDatasetFilterStore";
import type { GraphBuilderNewDocument, PersistedGraphBuilderNewDocument } from "@/types/graphBuilderNew";
import type { ProjectInfo, OpenProjectResult, ImportTableResult } from "@/types/project";
import type { ReportItem } from "@/types/report";
import type {
  TableTransformDefinition,
  TableTransformProjectBinding,
} from "@/types/tableTransform";
import type {
  LogicalFolder,
  WorkflowDefinition,
  WorkflowExtractionRequest,
  WorkflowRunCommitPacket,
  WorkflowRunRequest,
  WorkflowRun,
} from "@/types/workflow";

import type { ProjectOperation } from "@/projectPersistence/coordinator";
import type { ProjectCommit, ProjectWriteContext, ProjectOpenSummary, ProjectSettingRecord, CatalogPageRequest, CatalogPage, ProjectDocumentBody, HistoryPageRequest, ProjectHistoryPage, ProjectPersistenceStatus } from "@/types/projectPersistence";

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
  graphNewFolders?: Record<string, string>;
  /** fitYByXId → folder path. Root analyses are simply absent. */
  fitYByXFolders: Record<string, string>;
  /** fitModelId → folder path. Root analyses are simply absent. */
  fitModelFolders?: Record<string, string>;
  /** tabulateId → folder path. Root tabulates are simply absent. */
  tabulateFolders: Record<string, string>;
  /** reportId → folder path. Root reports are simply absent. */
  reportFolders: Record<string, string>;
  /** Reports persisted with the project. */
  reports: ReportItem[];
  /** distributionId → folder path. Root analyses are simply absent. */
  distributionFolders: Record<string, string>;
  /** Analysis documents persisted with the project. */
  analyses: AnalysisDocument[];
  /** analysisId → folder path. Root analyses are simply absent. */
  analysisFolders: Record<string, string>;
}

export interface SaveProjectRequest {
  filePath?: string;
  history: unknown[];
  snapshots: unknown[];
  datasetFilters: DatasetFilterMap;
  graphBuilders: unknown[];
  graphBuildersNew?: GraphBuilderNewDocument[];
  graphNewFolders?: Record<string, string>;
  fitYByX: unknown[];
  fitModels?: unknown[];
  tabulates: unknown[];
  distributions: DistributionItem[];
  analyses: AnalysisDocument[];
  folders: string[];
  tableFolders: Record<string, string>;
  graphFolders: Record<string, string>;
  fitYByXFolders: Record<string, string>;
  fitModelFolders?: Record<string, string>;
  tabulateFolders: Record<string, string>;
  reportFolders: Record<string, string>;
  reports: ReportItem[];
  distributionFolders: Record<string, string>;
  analysisFolders: Record<string, string>;
  workflows: WorkflowDefinition[];
  logicalFolders: LogicalFolder[];
  workflowRuns: WorkflowRun[];
  tableTransforms?: TableTransformDefinition[];
  tableTransformBindings?: TableTransformProjectBinding[];
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
  preflightProjectMigration: (sourcePath:string,destinationPath?:string)=>invoke<import("@/projectPersistence/openWithMigration").ProjectMigrationPreflight>("preflight_project_migration",{sourcePath,destinationPath:destinationPath??null}),
  cancelProjectMigration: (migrationId:string)=>invoke<boolean>("cancel_project_migration",{migrationId}),
  checkpointProjectV5: (epoch:number,expectedRevision:number)=>invoke<boolean>("checkpoint_project_v5",{epoch,expectedRevision}),
  projectV5Enabled: () => invoke<boolean>("project_v5_enabled"),
  createProjectDraftV5: () => invoke<ProjectOpenSummary>("create_project_draft_v5"),
  closeProjectV5: (epoch:number) => invoke<void>("close_project_v5",{epoch}),
  listRecoverableProjectDrafts: () => invoke<Array<{projectId:string;displayName:string;recoveryId:string}>>("list_recoverable_project_drafts"),
  recoverProjectDraftV5: (recoveryId:string) => invoke<ProjectOpenSummary>("recover_project_draft_v5",{recoveryId}),
  snapshotProjectV5: (epoch:number,filePath:string,firstNaming:boolean) => invoke<{active:ProjectOpenSummary|null;error:string|null;destinationPublished:boolean}>("snapshot_project_v5",{epoch,filePath,firstNaming}),
  openProjectV5: (filePath: string, readOnly = false) => invoke<ProjectOpenSummary>("open_project_v5", { filePath, readOnly }),
  listProjectCatalog: (epoch: number, request: CatalogPageRequest) => invoke<CatalogPage>("list_project_catalog", { epoch, request }),
  getProjectSetting: (epoch: number,key: string) => invoke<ProjectSettingRecord|null>("get_project_setting",{epoch,key}),
  getProjectDocument: (epoch: number, id: string, expectedRevision: number) => invoke<ProjectDocumentBody>("get_project_document", { epoch, id, expectedRevision }),
  listProjectHistory: (epoch: number, request: HistoryPageRequest) => invoke<ProjectHistoryPage>("list_project_history", { epoch, request }),
  getHistoryFrontier: (epoch:number,undo:boolean)=>invoke<import("@/types/projectPersistence").ProjectHistoryFrontier>("get_project_history_frontier",{epoch,undo}),
  getTableLifecycleEvent: (epoch:number,eventId:string)=>invoke<import("@/types/projectPersistence").ProjectTableLifecycleEvent>("get_project_table_lifecycle_event",{epoch,eventId}),
  getProjectPersistenceStatus: (epoch: number) => invoke<ProjectPersistenceStatus>("get_project_persistence_status", { epoch }),
  commitOperation: <T>(operation: ProjectOperation<T>, context: ProjectWriteContext): Promise<ProjectCommit<T>> => {
    if (!operation.payload || typeof operation.payload !== "object" || Array.isArray(operation.payload)) {
      return Promise.reject(new Error("Invalid project operation payload"));
    }
    const args = operation.command === "commit_project_records"
      ? { patch: operation.payload, context }
      : { ...operation.payload, context };
    return invoke<ProjectCommit<T>>(operation.command, args);
  },

  initProject: () =>
    invoke<ProjectInfo>("init_project"),

  createProject: (name: string, filePath: string) =>
    invoke<ProjectInfo>("create_project", { name, filePath }),

  openProject: async (filePath: string) => {
    const result = await invoke<OpenProjectResult>("open_project", { filePath });
    return {
      ...result,
      graphBuildersNew: (result.graphBuildersNew ?? []) as PersistedGraphBuilderNewDocument[],
      graphNewFolders: result.graphNewFolders ?? {},
    };
  },

  saveProject: (
    request: SaveProjectRequest,
    onProgress?: (progress: SaveProgress) => void,
  ) => {
    const progressChannel = new Channel<SaveProgress>();
    if (onProgress) {
      progressChannel.onmessage = onProgress;
    }
    return invoke<ProjectInfo>("save_project", {
      request: {
        ...request,
        graphBuildersNew: request.graphBuildersNew ?? [],
        graphNewFolders: request.graphNewFolders ?? {},
      },
      onProgress: progressChannel,
    });
  },

  getCurrentProject: () => invoke<ProjectInfo | null>("get_current_project"),

  extractWorkflow: (request: WorkflowExtractionRequest) =>
    invoke<WorkflowDefinition>("extract_workflow", { request }),

  getWorkflowRunState: (epoch:number,workflowId:string,workflowRevision:number) =>
    invoke<import("@/types/projectPersistence").ProjectWorkflowRunState>("get_project_workflow_run_state",{epoch,workflowId,workflowRevision}),

  runWorkflow: async (request: WorkflowRunRequest):Promise<WorkflowRunCommitPacket> => {
    const {useProjectStore}=await import("../stores/useProjectStore");
    const persistence=useProjectStore.getState().persistence;
    if(!persistence)return invoke<WorkflowRunCommitPacket>("run_workflow", { request });
    const epoch=persistence.snapshot().epoch;
    const {useProjectCatalogStore}=await import("../stores/useProjectCatalogStore");
    const current=()=>{if(useProjectStore.getState().persistence!==persistence)throw new Error("Project changed before workflow run");};
    while(useProjectCatalogStore.getState().epoch===epoch&&useProjectCatalogStore.getState().nextCursor) {
      current();await useProjectCatalogStore.getState().loadNextPage();
    }
    current();
    const {getProjectDirectorySummaries}=await import("../projectPersistence/documentAdapters");
    const summaries=getProjectDirectorySummaries(epoch)??[];
    const workflow=summaries.find(item=>item.id===request.workflow.id&&item.kind==="workflow");
    if(!workflow)throw new Error("project_document_metadata_required");
    const outputs=request.outputBindings.flatMap(binding=>summaries.filter(item=>item.id===binding.artifactDocumentId));
    const ids=[...new Set([...request.inputBindings.map(input=>input.tableDocumentId),...outputs.filter(item=>item.kind==="table").map(item=>item.id)])];
    const datasetGenerations=await Promise.all(ids.map(async id=>({id,generation:await invoke<number>("get_dataset_generation",{datasetId:id})})));
    current();
    const documentRevisions=[workflow,...outputs.filter(item=>item.id!==workflow.id)].map(item=>({id:item.id,revision:item.revision}));
    return (await persistence.submit<WorkflowRunCommitPacket>({command:"run_workflow",payload:{request,folder:workflow.folder},datasetGenerations,documentRevisions})).value;
  },

  acknowledgeWorkflowCommit: async (commitId: string):Promise<void> => {
    const {useProjectStore}=await import("../stores/useProjectStore");
    if(!useProjectStore.getState().persistence)await invoke<void>("acknowledge_workflow_commit", { commitId });
  },

  // ---- Single-table share helpers ----------------------------------------
  // .sptb = standalone table file. It can live by itself on disk and be
  // re-imported into any project.

  /** Export one dataset to a `.sptb` file. */
  exportTable: (datasetId: string, filePath: string) =>
    invokeProjectExport("export_table", { datasetId, filePath }),

  /** Export multiple datasets as `.sptb` files packed into a `.zip`.
   *  `archivePaths` maps each dataset id to the file's path inside the zip
   *  (without `.sptb`), so the UI can mirror its folder tree. */
  exportTablesSptbZip: (
    datasetIds: string[],
    outputPath: string,
    archivePaths?: Record<string, string>,
  ) =>
    invokeProjectExport("export_tables_sptb_zip", {
      datasetIds,
      outputPath,
      archivePaths: archivePaths ?? null,
    }),

  /** Import a `.sptb` file. Returns the new dataset id assigned in the
   *  project. Per issue #7 the `.sptb` body carries no folder info; the
   *  caller decides where to place the imported table (defaults to root). */
  importTable: async (filePath: string):Promise<ImportTableResult> => {
    const {useProjectStore}=await import("../stores/useProjectStore");
    const owner=useProjectStore.getState().persistence;
    if(!owner)return invoke<ImportTableResult>("import_table",{filePath});
    return (await owner.submit<ImportTableResult>({command:"import_table",payload:{filePath}})).value;
  },

  /** Import a `.spgh` file and return its graph builder body. */
  importGraph: (filePath: string) =>
    invoke<unknown>("import_graph", { filePath }),
};
