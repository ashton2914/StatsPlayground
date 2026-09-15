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
  shouldConfirmCsvExport?: (input: {
    datasetId: string;
    rootId: string;
    relativePath: string;
  }) => boolean | Promise<boolean>;
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

      const decision = input?.shouldConfirmCsvExport?.({
        datasetId: exportInput.datasetId,
        rootId: exportInput.rootId,
        relativePath: exportInput.relativePath,
      });

      if (decision instanceof Promise) {
        return decision.then((requireConfirmation) => ({
          allowed: true,
          requireConfirmation,
          reason: requireConfirmation ? "CSV export target already exists" : undefined,
        }));
      }

      return {
        allowed: true,
        requireConfirmation: Boolean(decision),
        reason: decision ? "CSV export target already exists" : undefined,
      };
    },
  };
}