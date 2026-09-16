import { invoke } from "@tauri-apps/api/core";

import { applicationRuntime } from "@/applicationCommands/applicationRuntime";
import type { RuntimeRequestSnapshot } from "@/applicationCommands/runtime";
import type {
  McpAuditEntry,
  McpAuthorizedRootGrant,
  McpCommandRequestSummary,
  McpServerStatus,
} from "@/types/mcp";

function isManagedMcpRequest(request: RuntimeRequestSnapshot): boolean {
  return request.actor.kind === "mcp";
}

export function listMcpCommandRequestsFromRuntimeSnapshot(
  snapshot: RuntimeRequestSnapshot[],
): McpCommandRequestSummary[] {
  return snapshot
    .filter(isManagedMcpRequest)
    .map((request) => ({
      requestId: request.requestId,
      command: request.command,
      status: request.status,
      stage: request.stage,
      message: request.message,
      percent: request.percent,
    }));
}

export function canManageMcpCommandRequest(
  snapshot: RuntimeRequestSnapshot[],
  requestId: string,
): boolean {
  return snapshot.some((request) => request.requestId === requestId && isManagedMcpRequest(request));
}

export const mcpManagementService = {
  startServer: () => invoke<McpServerStatus>("start_mcp_server"),
  stopServer: () => invoke<void>("stop_mcp_server"),
  getServerStatus: () => invoke<McpServerStatus>("get_mcp_server_status"),
  listAuditEntries: () => invoke<McpAuditEntry[]>("list_mcp_audit_entries"),
  authorizeOutputRoot: (rootPath: string) =>
    invoke<McpAuthorizedRootGrant>("authorize_csv_export_root", { rootPath }),
  revokeOutputRoot: (rootId: string) =>
    invoke<void>("revoke_csv_export_root", { rootId }),
  listCommandRequests: (): McpCommandRequestSummary[] =>
    listMcpCommandRequestsFromRuntimeSnapshot(applicationRuntime.snapshot()),
  confirmCommandRequest: (requestId: string, allow: boolean) => {
    const snapshot = applicationRuntime.snapshot();
    if (!canManageMcpCommandRequest(snapshot, requestId)) {
      return false;
    }
    return applicationRuntime.confirm(requestId, allow);
  },
  cancelCommandRequest: (requestId: string) => {
    const snapshot = applicationRuntime.snapshot();
    if (!canManageMcpCommandRequest(snapshot, requestId)) {
      return false;
    }
    return applicationRuntime.cancel(requestId);
  },
};
