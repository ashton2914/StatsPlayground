export interface MutationControl {
  expectedProjectRevision?: number;
  idempotencyKey?: string;
}

export interface ProjectInspectInput {
  includeCapabilities?: boolean;
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

export interface CommandExecutionContext {
  requestId: string;
  signal: AbortSignal;
  reportProgress(progress: CommandProgress): void;
  beginCommit(): void;
}

export type ApplicationCommandRegistry = {
  "project.inspect": { input: ProjectInspectInput; data: ProjectInspectResult };
  "table.create": { input: TableCreateInput; data: TableCreateResult };
  "tableTransform.create": { input: TableTransformCreateInput; data: TableTransformCommandData };
  "tableTransform.run": { input: TableTransformRunInput; data: TableTransformCommandData };
  "sql.createTable": { input: SqlCreateTableInput; data: SqlCreateTableResult };
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