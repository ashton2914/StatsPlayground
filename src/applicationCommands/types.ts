export interface MutationControl {
  expectedProjectRevision?: number;
  idempotencyKey?: string;
}

export interface ProjectInspectInput {
  includeCapabilities?: boolean;
}

export interface ProjectSaveInput {
  filePath?: string;
}

export interface ProjectSaveResult {
  name: string;
  createdAt: string;
  fileName: string | null;
  hasProjectPath: boolean;
}

export interface ProjectInspectResult {
  project: {
    name: string;
    createdAt: string;
    fileName: string | null;
    hasProjectPath: boolean;
  } | null;
  dirty: boolean;
  readOnly: boolean;
  projectRevision: number;
  counts: {
    tables: number;
    tableTransforms: number;
    graphs: number;
    analyses: number;
    tabulates: number;
    reports: number;
  };
  capabilities?: {
    table: {
      list: boolean;
      describe: boolean;
      describePreview: boolean;
    };
    document: {
      list: boolean;
      get: boolean;
    };
    project: {
      inspect: boolean;
    };
  };
}

export interface TableListInput {
  cursor?: string;
  limit?: number;
}

export interface TableListItem {
  id: string;
  name: string;
  sourceType: string;
  rowCount: number;
  colCount: number;
  generation: number;
  createdAt: string;
  updatedAt: string;
  sourceName: string | null;
}

export interface TableListResult {
  items: TableListItem[];
  nextCursor: string | null;
}

export interface TableDescribeInput {
  datasetId: string;
  preview?: {
    offset?: number;
    limit: number;
  };
}

export interface TableDescribeResult {
  dataset: TableListItem;
  generation: number;
  columns: Array<{
    colIndex: number;
    colName: string;
    colType: string;
    width?: number;
    format?: {
      kind: string;
      decimals?: number;
      currency?: string;
    };
    extras?: Record<string, unknown>;
  }>;
  preview?: {
    offset: number;
    limit: number;
    totalRows: number;
    rows: Array<{
      rowIndex: number;
      cells: Array<{
        colIndex: number;
        value: unknown;
      }>;
    }>;
  };
}

export interface TableCreateInput {
  request: import("@/types/data").CreateManagedTableRequest;
  preview?: {
    offset?: number;
    limit: number;
  };
}

export type TableCreateResult = TableDescribeResult;

export interface TableTransformCreateInput {
  draft: import("@/types/tableTransform").TableTransformDraft;
}

export interface TableTransformRunInput {
  transformId: string;
}

export interface TableTransformCommandData {
  execution: import("@/types/tableTransform").TableTransformExecutionResult;
  definition: import("@/types/tableTransform").TableTransformDefinition | null;
  binding: import("@/types/tableTransform").TableTransformBindingState | null;
  outputTable: TableDescribeResult | null;
  targetDatasetGeneration: number | null;
}

export interface SqlCreateTableInput {
  sql: string;
  name: string;
}

export interface SqlCreateTableResult {
  datasetId: string;
  datasetName: string;
  outputTable: TableDescribeResult | null;
}

export interface TabulateCreateInput {
  sourceDatasetId: string;
}

export interface TabulateCreateResult {
  item: import("@/types/tabulate").TabulateItem;
}

export interface TabulateRunInput {
  tabulateId: string;
  request: Omit<import("@/types/tabulate").TabulateSessionRequest, "sourceGeneration">;
}

export interface TabulateRunResult {
  tabulateId: string;
  requestFingerprint: string;
  sourceGeneration: number;
  completedAt: string;
  session: import("@/types/tabulate").TabulateSessionStatus;
  leaseReleased: boolean;
  cacheValid: boolean;
}

export interface TabulateExportTableInput {
  tabulateId: string;
  request: TabulateRunInput["request"];
  tableName: string;
  session?: Pick<import("@/types/tabulate").TabulateSessionStatus, "sessionId" | "fingerprint" | "sourceGeneration">;
}

export interface TabulateExportTableResult {
  outputTable: TableDescribeResult | null;
  reran: boolean;
  requestFingerprint: string;
  sourceGeneration: number;
}

export interface SnapshotCreateInput {
  name?: string;
}

export interface SnapshotCreateResult {
  snapshotId: string | null;
  snapshotName: string | null;
  createdAt: string | null;
}

export interface TableExportCsvInput {
  datasetId: string;
  rootId: string;
  relativePath: string;
}

export interface TableExportCsvResult {
  targetStatus: "createNew" | "overwriteExisting";
}

export interface GraphCreateInput {
  sourceDatasetId: string;
}

export type DistributionAnalysisCreateDraft = Omit<
  import("@/types/distribution").DistributionItem,
  "id" | "name" | "sourceDatasetId" | "createdAt" | "analysis" | "graphs"
> & {
  name?: string;
  analysis?: import("@/types/distribution").DistributionAnalysisConfig;
  graphs?: import("@/types/distribution").DistributionItem["graphs"];
};

export interface FitYByXAnalysisCreateDraft {
  name?: string;
  response: import("@/graphCore/types").FieldRef;
  factor: import("@/graphCore/types").FieldRef;
  confidenceLevel: number;
  graph?: import("@/types/graphBuilder").EmbeddedGraphConfig;
}

export interface FitModelAnalysisCreateDraft {
  name?: string;
  response: import("@/graphCore/types").FieldRef;
  construct: import("@/types/fitModel").FitModelConstruct;
  terms: import("@/types/fitModel").FitModelTerm[];
  centeringMethod: import("@/types/fitModel").FitModelCenteringMethod;
  confidenceLevel?: number;
}

export interface HypothesisTestAnalysisCreateDraft {
  name?: string;
  definition: import("@/types/hypothesisTest").HypothesisTestAnalysisDefinition;
}

export type AnalysisCreateInputByKind = {
  distribution: {
    analysisKind: "distribution";
    sourceDatasetId: string;
    draft: DistributionAnalysisCreateDraft;
  };
  fitYByX: {
    analysisKind: "fitYByX";
    sourceDatasetId: string;
    draft: FitYByXAnalysisCreateDraft;
  };
  fitModel: {
    analysisKind: "fitModel";
    sourceDatasetId: string;
    draft: FitModelAnalysisCreateDraft;
  };
  hypothesisTest: {
    analysisKind: "hypothesisTest";
    sourceDatasetId: string;
    draft: HypothesisTestAnalysisCreateDraft;
  };
};

export type AnalysisCreateInput = AnalysisCreateInputByKind[import("@/types/analysis").AnalysisKind];

export type DistributionAnalysisUpdateDraft = Omit<
  import("@/types/distribution").DistributionItem,
  "id" | "name" | "sourceDatasetId" | "createdAt"
>;

export interface FitYByXAnalysisUpdateDraft {
  response: import("@/graphCore/types").FieldRef;
  factor: import("@/graphCore/types").FieldRef;
  confidenceLevel: number;
  graph?: import("@/types/graphBuilder").EmbeddedGraphConfig;
}

export interface FitModelAnalysisUpdateDraft {
  response: import("@/graphCore/types").FieldRef;
  construct: import("@/types/fitModel").FitModelConstruct;
  terms: import("@/types/fitModel").FitModelTerm[];
  centeringMethod: import("@/types/fitModel").FitModelCenteringMethod;
  confidenceLevel?: number;
}

export interface HypothesisTestAnalysisUpdateDraft {
  definition: import("@/types/hypothesisTest").HypothesisTestAnalysisDefinition;
  presentation?: import("@/types/hypothesisTest").HypothesisTestAnalysisPresentation;
}

export type AnalysisUpdateInputByKind = {
  distribution: {
    analysisId: string;
    analysisKind: "distribution";
    expectedConfigRevision: number;
    draft: DistributionAnalysisUpdateDraft;
  };
  fitYByX: {
    analysisId: string;
    analysisKind: "fitYByX";
    expectedConfigRevision: number;
    draft: FitYByXAnalysisUpdateDraft;
  };
  fitModel: {
    analysisId: string;
    analysisKind: "fitModel";
    expectedConfigRevision: number;
    draft: FitModelAnalysisUpdateDraft;
  };
  hypothesisTest: {
    analysisId: string;
    analysisKind: "hypothesisTest";
    expectedConfigRevision: number;
    draft: HypothesisTestAnalysisUpdateDraft;
  };
};

export type AnalysisUpdateInput = AnalysisUpdateInputByKind[import("@/types/analysis").AnalysisKind];

export interface AnalysisCommandResult {
  item: import("@/types/analysis").AnalysisDocument;
}

export interface AnalysisRunInput {
  analysisId: string;
}

export interface AnalysisRunResult {
  item: import("@/types/analysis").AnalysisDocument;
  definition: import("@/types/analysis").AnalysisDocument["definition"];
  dataset: import("@/types/data").DatasetMeta;
  state: import("@/components/analysis/useAnalysisExecution").AnalysisExecutionState;
}

export interface GraphCommandResult {
  item: import("@/types/graphBuilder").GraphBuilderItem;
  documentRevision: number;
}

export interface GraphUpdateInput {
  graphId: string;
  expectedDocumentRevision: number;
  definition: import("@/types/graphBuilder").GraphBuilderItem;
}

export interface ReportCreateInput {
}

export interface ReportCommandResult {
  item: import("@/types/report").ReportItem;
  documentRevision: number;
}

export interface ReportUpdateInput {
  reportId: string;
  expectedDocumentRevision: number;
  markdown: string;
}

export type ProjectDocumentKind = "tableTransform" | "graph" | "analysis" | "tabulate" | "report";

export interface ProjectDocumentListInput {
  kind?: ProjectDocumentKind;
  cursor?: string;
  limit?: number;
}

export interface ProjectDocumentSummary {
  kind: ProjectDocumentKind;
  id: string;
  name: string;
  sourceDatasetId?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface ProjectDocumentListResult {
  items: ProjectDocumentSummary[];
  nextCursor: string | null;
}

export interface ProjectDocumentGetInput {
  kind: ProjectDocumentKind;
  id: string;
}

export interface ProjectDocumentGetResult {
  kind: ProjectDocumentKind;
  id: string;
  document: unknown;
}

export type CommandActor =
  | { kind: "ui" }
  | { kind: "mcp"; sessionId: string; clientId?: string };

export interface CommandWarning {
  code: string;
  message: string;
}

export interface CommandResult<T> {
  requestId: string;
  command: string;
  changed: boolean;
  projectRevision: number;
  data: T;
  warnings: CommandWarning[];
}

export type CommandErrorCode =
  | "app_not_ready"
  | "project_required"
  | "project_path_required"
  | "read_only"
  | "invalid_input"
  | "not_found"
  | "revision_conflict"
  | "path_not_authorized"
  | "confirmation_required"
  | "user_denied"
  | "queue_full"
  | "timeout"
  | "cancelled"
  | "execution_failed";

export interface CommandError {
  code: CommandErrorCode;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export interface CommandProgress {
  stage: string;
  message?: string;
  percent?: number;
}

export type CommandLifecycleStatus =
  | "queued"
  | "running"
  | "awaiting-confirmation"
  | "committing"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface CommandStatusChange {
  requestId: string;
  status: CommandLifecycleStatus;
  stage: string;
  message?: string;
  percent?: number;
}

export interface TrustedCommandExecutionContext {
  requestId: string;
  policy: {
    requireConfirmation: boolean;
    confirmationGranted: boolean;
    reason?: string;
    trustedData?: Record<string, unknown>;
  };
}

export interface CommandExecutionContext {
  requestId: string;
  signal: AbortSignal;
  reportProgress(progress: CommandProgress): void;
  beginCommit(): void;
  trusted: TrustedCommandExecutionContext;
}

export type ApplicationCommandRegistry = {
  "project.inspect": { input: ProjectInspectInput; data: ProjectInspectResult };
  "project.save": { input: ProjectSaveInput; data: ProjectSaveResult };
  "table.create": { input: TableCreateInput; data: TableCreateResult };
  "tableTransform.create": { input: TableTransformCreateInput; data: TableTransformCommandData };
  "tableTransform.run": { input: TableTransformRunInput; data: TableTransformCommandData };
  "sql.createTable": { input: SqlCreateTableInput; data: SqlCreateTableResult };
  "analysis.create": { input: AnalysisCreateInput; data: AnalysisCommandResult };
  "analysis.update": { input: AnalysisUpdateInput; data: AnalysisCommandResult };
  "analysis.run": { input: AnalysisRunInput; data: AnalysisRunResult };
  "graph.create": { input: GraphCreateInput; data: GraphCommandResult };
  "graph.update": { input: GraphUpdateInput; data: GraphCommandResult };
  "report.create": { input: ReportCreateInput; data: ReportCommandResult };
  "report.update": { input: ReportUpdateInput; data: ReportCommandResult };
  "tabulate.create": { input: TabulateCreateInput; data: TabulateCreateResult };
  "tabulate.run": { input: TabulateRunInput; data: TabulateRunResult };
  "tabulate.exportTable": { input: TabulateExportTableInput; data: TabulateExportTableResult };
  "snapshot.create": { input: SnapshotCreateInput; data: SnapshotCreateResult };
  "table.exportCsv": { input: TableExportCsvInput; data: TableExportCsvResult };
  "table.list": { input: TableListInput; data: TableListResult };
  "table.describe": { input: TableDescribeInput; data: TableDescribeResult };
  "document.list": { input: ProjectDocumentListInput; data: ProjectDocumentListResult };
  "document.get": { input: ProjectDocumentGetInput; data: ProjectDocumentGetResult };
};

export type ApplicationCommandType = Extract<keyof ApplicationCommandRegistry, string>;

export type CommandRegistryShape = Record<string, { input: unknown; data: unknown }>;

export type ApplicationCommand<
  TRegistry extends CommandRegistryShape,
  TType extends Extract<keyof TRegistry, string> = Extract<keyof TRegistry, string>,
> = {
  type: TType;
  input: TRegistry[TType]["input"];
  control?: MutationControl;
};