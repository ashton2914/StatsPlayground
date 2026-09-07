export interface SourceColumn {
  name: string;
  sourceType: string;
  nullable: boolean;
  primaryKey: boolean;
  precision: number | null;
  scale: number | null;
}

export type ConnectorKind = "sqlite" | "postgresql" | "mysql" | "sqlServer" | "odbc";

export type AuthenticationType = "usernamePassword" | "windows" | "entraId";

export type TlsMode = "disabled" | "required" | "verifyCa" | "verifyFull";

export interface ConnectionDefinition {
  connector: ConnectorKind;
  host: string;
  port: number;
  database: string;
  authenticationType: AuthenticationType;
  tlsMode: TlsMode;
  tlsRootCertificatePem?: string;
  connectTimeoutSeconds: number;
}

export interface ConnectionCredentials {
  username: string;
  password: string;
}

export type SourceObjectType = "table" | "view";

export interface SourceObjectRef {
  catalog: string | null;
  schema: string | null;
  name: string;
  objectType: SourceObjectType;
}

export interface ConnectorCapabilities {
  supportsViews: boolean;
  supportsPrimaryKeys: boolean;
  supportsCustomQuery: boolean;
  supportsCancellation: boolean;
}

export type DataLinkErrorCategory =
  | "network"
  | "authentication"
  | "tls"
  | "permission"
  | "query"
  | "conversion"
  | "storage"
  | "cancelled";

export interface DataLinkError {
  category: DataLinkErrorCategory;
  message: string;
}

export interface SourceObject {
  name: string;
  objectType: "table" | "view";
  columns: SourceColumn[];
}

export interface PreviewResult {
  objectName: string;
  columns: SourceColumn[];
  rows: unknown[][];
  truncated: boolean;
}

export interface SqliteImportSelection {
  sourceName: string;
  targetName: string;
  action: "create" | "append" | "skip";
}

export interface ImportTableSummary {
  sourceName: string;
  targetName: string;
  action: "create" | "append" | "skip";
  rowsWritten: number;
}

export interface ImportSummary {
  status: "completed" | "failed" | "cancelled";
  imported: ImportTableSummary[];
  skipped: ImportTableSummary[];
  failedTable: string | null;
  error: string | null;
  totalRowsWritten: number;
}

export interface ImportProgress {
  tableName: string;
  tableIndex: number;
  tableTotal: number;
  rowsDone: number;
  rowsTotal: number;
}
