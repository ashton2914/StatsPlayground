export type McpServerState = "stopped" | "starting" | "running" | "stopping";

export type McpAuditStatus =
  | "queued"
  | "running"
  | "awaiting-confirmation"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface McpServerStatus {
  state: McpServerState;
  endpoint: string | null;
  token: string | null;
  activeConnections: number;
  queuedRequests: number;
  runningRequests: number;
}

export interface McpAuditEntry {
  requestId: string;
  timestamp: string;
  tool: string;
  status: McpAuditStatus;
  durationMs: number | null;
  errorCode: string | null;
}

export interface McpAuthorizedRootGrant {
  rootId: string;
  displayName: string;
}

export interface McpCommandRequestSummary {
  requestId: string;
  command: string;
  status:
    | "queued"
    | "running"
    | "awaiting-confirmation"
    | "committing"
    | "succeeded"
    | "failed"
    | "cancelled";
}