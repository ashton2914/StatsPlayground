import { invoke } from "@tauri-apps/api/core";

import { applicationRuntime } from "@/applicationCommands/applicationRuntime";
import type {
  McpAuditEntry,
  McpAuthorizedRootGrant,
  McpCommandRequestSummary,
  McpServerStatus,
} from "@/types/mcp";

export const mcpManagementService = {
  startServer: () => invoke<McpServerStatus>("start_mcp_server"),
  stopServer: () => invoke<void>("stop_mcp_server"),
  getServerStatus: () => invoke<McpServerStatus>("get_mcp_server_status"),
  listAuditEntries: () => invoke<McpAuditEntry[]>("list_mcp_audit_entries"),
  authorizeOutputRoot: (rootPath: string) =>
    invoke<McpAuthorizedRootGrant>("authorize_csv_export_root", { rootPath }),
  revokeOutputRoot: (rootId: string) =>
    invoke<void>("revoke_csv_export_root", { rootId }),
  listCommandRequests: (): McpCommandRequestSummary[] => applicationRuntime.snapshot(),
  confirmCommandRequest: (requestId: string, allow: boolean) =>
    applicationRuntime.confirm(requestId, allow),
  cancelCommandRequest: (requestId: string) =>
    applicationRuntime.cancel(requestId),
};
