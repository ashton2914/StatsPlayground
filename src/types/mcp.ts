export type McpServerState = "stopped" | "starting" | "running" | "stopping";

export interface McpSettings {
  port: number;
  token: string;
}

export interface McpSettingsState {
  settings: McpSettings | null;
}

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
  stage: string;
  message?: string | null;
  percent?: number | null;
}
export interface VsCodeLaunchPlan {
  skills?: SkillSyncSummary;
  configurationPath: ".mcp.json" | ".vscode/mcp.json";
  planId: string;
  workspaceDisplayName: string;
  configurationAction: "create" | "merge" | "replaceManagedEntry" | "unchanged";
  confirmationRequired: boolean;
  currentEndpoint: string | null;
  proposedEndpoint: string;
  gitProtection: "localExclude" | "nonGit";
  settingsAction: "reuse" | "startSaved" | "persistRunning" | "initializePersistent";
  warnings: string[];
}

export interface VsCodeLaunchRequest {
  planId: string;
  approveConflict: boolean;
}

export interface VsCodeLaunchResult {
  skills?: SkillSyncSummary;
  configurationPath: VsCodeLaunchPlan["configurationPath"];
  workspaceDisplayName: string;
  configurationResult: VsCodeLaunchPlan["configurationAction"];
  serverState: "running";
  endpoint: string;
  launchResult: "launched" | "configuredVsCodeNotFound" | "configuredLaunchFailed";
  warnings: string[];
}

export interface SkillSyncSummary {
  directory: string;
  installed: string[];
  updated: string[];
  unchanged: string[];
}
