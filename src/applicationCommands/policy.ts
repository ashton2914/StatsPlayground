import type { CommandActor } from "./types";

export type CommandMode = "mutation" | "read";

export interface CommandPolicyMetadata {
  mode: CommandMode;
  risk: "low" | "high";
}

export interface CommandPolicyInput {
  requestId: string;
  command: string;
  actor: CommandActor;
  input: unknown;
  metadata: CommandPolicyMetadata;
}

export interface CommandPolicyDecision {
  allowed: boolean;
  reason?: string;
  requireConfirmation?: boolean;
  trustedData?: Record<string, unknown>;
}

export interface CommandPolicy {
  canExecute(input: CommandPolicyInput): CommandPolicyDecision | Promise<CommandPolicyDecision>;
}

export const allowAllCommandPolicy: CommandPolicy = {
  canExecute() {
    return { allowed: true };
  },
};

export function createDefaultCommandPolicy(input?: {
  inspectCsvExportTarget?: (input: {
    datasetId: string;
    rootId: string;
    relativePath: string;
  }) => "createNew" | "overwriteExisting" | Promise<"createNew" | "overwriteExisting">;
}): CommandPolicy {
  return {
    canExecute(policyInput) {
      if (policyInput.command !== "table.exportCsv") {
        return { allowed: true };
      }

      const exportInput = policyInput.input as {
        datasetId?: string;
        rootId?: string;
        relativePath?: string;
      };
      if (
        typeof exportInput.datasetId !== "string"
        || typeof exportInput.rootId !== "string"
        || typeof exportInput.relativePath !== "string"
      ) {
        return { allowed: true };
      }

      const decision = input?.inspectCsvExportTarget?.({
        datasetId: exportInput.datasetId,
        rootId: exportInput.rootId,
        relativePath: exportInput.relativePath,
      });

      if (decision instanceof Promise) {
        return decision.then((targetStatus) => ({
          allowed: true,
          requireConfirmation: targetStatus === "overwriteExisting",
          reason: targetStatus === "overwriteExisting" ? "CSV export target already exists" : undefined,
          trustedData: { targetStatus },
        }));
      }

      return {
        allowed: true,
        requireConfirmation: decision === "overwriteExisting",
        reason: decision === "overwriteExisting" ? "CSV export target already exists" : undefined,
        trustedData: decision ? { targetStatus: decision } : undefined,
      };
    },
  };
}