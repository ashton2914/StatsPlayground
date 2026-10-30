import type { ProjectInfo } from "./project";
import type {DatasetMeta} from "./data";

export interface ProjectHeader {
  projectId: string;
  formatVersion: string;
  minimumReader: number;
  minimumWriter: number;
  committedRevision: number;
  createdAt: string;
  engineVersion: string;
  storageVersion: string;
}

export interface DatasetGeneration { id: string; generation: number }
export interface DocumentRevision { id: string; revision: number }
export interface SettingRevision { key: string; revision: number }

export interface ProjectWriteContext {
  operationId: string;
  expectedProjectId: string;
  expectedEpoch: number;
  expectedRevision: number;
  requestDigest?: string;
  documentRevisions?: DocumentRevision[];
  datasetGenerations?: DatasetGeneration[];
}

export interface ProjectCommit<T> {
  operationId: string;
  epoch: number;
  committedRevision: number;
  value: T;
  changedDatasetGenerations: DatasetGeneration[];
  changedDatasetMetadata?:DatasetMeta[];
  changedDocumentRevisions: DocumentRevision[];
  changedSettingRevisions?: SettingRevision[];
  changedFilterSettings?: ProjectSettingRecord[];
  changedHistoryEntries?: ProjectHistorySummary[];
  changedDirectoryEntries?: ProjectDocumentSummary[];
  deletedDirectoryIds?: string[];
}

export type ProjectDocumentKind =
  | "table" | "graph" | "graphNew" | "analysis" | "report" | "tabulate"
  | "workflow" | "transform" | "snapshot" | "folder";

export interface ProjectDocumentSummary {
  id: string;
  kind: ProjectDocumentKind;
  name: string;
  folder: string;
  revision: number;
  dependencies: string[];
  analysisKind?: import("./analysis").AnalysisKind;
}

export interface ProjectDocumentBody {
  summary: ProjectDocumentSummary;
  schemaVersion: number;
  body: unknown;
}

export interface DocumentWrite {
  expectedRevision: number | null;
  document: ProjectDocumentBody;
}

export interface DirectoryMove { id: string; expectedRevision: number; folder: string; name?: string }
export interface ProjectSettingRecord { key: string; revision: number; value: unknown }
export interface ProjectSettingWrite { key: string; expectedRevision: number | null; value: unknown }

export interface ProjectRecordPatch {
  documents?: DocumentWrite[];
  deletedDocumentIds?: string[];
  settings?: ProjectSettingWrite[];
  directoryMoves?: DirectoryMove[];
  createdFolders?: string[];
  deletedFolders?: string[];
}

export interface CatalogPageRequest { after: string | null; limit: number }
export interface CatalogPage {
  items: ProjectDocumentSummary[];
  nextCursor: string | null;
  committedRevision: number;
}

export interface HistoryPageRequest { datasetId: string | null; after: string | null; limit: number }
export interface ProjectHistorySummary { id: string; datasetId: string; datasetName?:string; description?:string; timestamp?:string; operation: string; applied: boolean; generation: number }
export interface ProjectTableLifecycleEvent { id:string; datasetId:string; datasetGeneration:number|null; operation:"create_table"|"delete_table"; applied:boolean; revision:number; historyOrdinal:number; projectRevision:number }
export interface ProjectHistoryFrontier { entry: ProjectHistorySummary | null; committedRevision: number }
export interface ProjectHistoryPage { items: ProjectHistorySummary[]; nextCursor: string | null; committedRevision: number }

export interface ProjectOpenSummary {
  project: ProjectInfo;
  header: ProjectHeader;
  epoch: number;
  writable: boolean;
  directory: CatalogPage;
  settingsRevision: number;
  datasets?: import("./data").DatasetMeta[];
}

export interface ProjectPersistenceStatus { epoch: number; committedRevision: number; writable: boolean }

export type ProjectOperationResolution =
  | {status:"committed";commit:ProjectCommit<unknown>}
  | {status:"cancelled";operationId:string;epoch:number;committedRevision:number};

export interface ProjectDataSnapshotDescriptor {
 id:string; name:string; revision:number; createdAt:string; tableCount:number;
}
export interface ProjectDataSnapshotPage {
 items:ProjectDataSnapshotDescriptor[]; nextCursor:string|null; committedRevision:number;
}
export interface ProjectDataSnapshotRestored {
 kind:"dataSnapshotRestored"; snapshotId:string; tableHistoryReset:true; tableCount?:number;
}

export interface ProjectWorkflowRunState {
 workflowId:string; workflowRevision:number; committedRevision:number; totalCount:number;
 latestRunId:string|null; latestOutputBindings:import("./workflow").WorkflowOutputBinding[]|null;
}

/** Metadata-only table ownership and Transform connectivity at one project revision. */
export interface ProjectTableNode { id:string; name:string; folder:string; revision:number }
export interface ProjectTransformInput { role:string; tableId:string }
export interface ProjectTransformLink {
  id:string; name:string; revision:number; operationKind:string;
  inputs:ProjectTransformInput[]; outputTableId:string;
}
export interface ProjectOwnedDocument { id:string; kind:ProjectDocumentKind; tableId:string; revision:number }
export interface ProjectTopologyDiagnostic { code:string; id:string }
export interface ProjectTopology {
  epoch:number; committedRevision:number; tables:ProjectTableNode[];
  transforms:ProjectTransformLink[]; ownedDocuments:ProjectOwnedDocument[];
  diagnostics:ProjectTopologyDiagnostic[];
}
export type ProjectActionScope = 'component' | 'descendants';
export interface ProjectActionPreview {
  epoch:number; committedRevision:number; targetTableId:string; scope:ProjectActionScope;
  tableIds:string[]; transformIds:string[]; ownedDocumentIds:string[];
  blockers:ProjectTopologyDiagnostic[];
}
export interface ProjectGroupMoveRequest { targetTableId:string; destinationFolder:string; expectedTopologyRevision:number }
export interface ProjectGroupCopyRequest extends ProjectGroupMoveRequest {}
export interface ProjectGroupCopyResult { tableIds:string[]; idMap:Record<string,string> }
export interface ProjectGroupExportRequest { targetTableId:string; filePath:string; expectedTopologyRevision:number }
export interface ProjectGroupImportRequest { filePath:string; destinationFolder:string }
