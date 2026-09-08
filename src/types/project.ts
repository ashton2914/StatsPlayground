import type { AnalysisDocument } from "./analysis";
import type { DistributionItem } from "./distribution";
import type { ReportItem } from "./report";
import type {
  LogicalFolder,
  ProjectLineageGraph,
  WorkflowDefinition,
  WorkflowRun,
} from "./workflow";

/** 项目元数据 */
export interface ProjectInfo {
  name: string;
  filePath: string;
  createdAt: string;
}

export interface DatasetNameMigration {
  datasetId: string;
  oldName: string;
  newName: string;
}

export interface DocumentNameMigration {
  id: string;
  kind: string;
  oldName: string;
  newName: string;
}

/** open_project 返回结果，包含历史/快照数据 + 文件夹布局 */
export interface OpenProjectResult {
  project: ProjectInfo;
  history: unknown[];
  snapshots: unknown[];
  graphBuilders: unknown[];
  fitYByX: unknown[];
  fitModels?: unknown[];
  tabulates: unknown[];
  distributions: DistributionItem[];
  analyses: AnalysisDocument[];
  /** 项目内所有文件夹路径（含空文件夹），使用 "/" 分隔，根目录不出现在列表中。 */
  folders: string[];
  /** datasetId → folder path（根目录的表不在此映射中）。 */
  tableFolders: Record<string, string>;
  /** graphId → folder path（根目录的图不在此映射中）。 */
  graphFolders: Record<string, string>;
  fitYByXFolders: Record<string, string>;
  fitModelFolders?: Record<string, string>;
  distributionFolders: Record<string, string>;
  analysisFolders: Record<string, string>;
  documentNameMigrations: DocumentNameMigration[];
  datasetNameMigrations: DatasetNameMigration[];
  requiresMigration: boolean;
  /** tabulateId → folder path。 */
  tabulateFolders: Record<string, string>;
  /** reportId → folder path。 */
  reportFolders: Record<string, string>;
  /** 项目中的报告。 */
  reports: ReportItem[];
  workflows: WorkflowDefinition[];
  logicalFolders: LogicalFolder[];
  workflowRuns: WorkflowRun[];
  lineageGraph: ProjectLineageGraph;
}

/** 导入 .sptb 的返回值。
 *  按 #7 设计，.sptb 文件本身不携带 folder 信息——导入后默认落在根目录，
 *  调用方可选地把它移动到目标文件夹。 */
export interface ImportTableResult {
  id: string;
}
