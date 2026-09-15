import type { CommandActor } from "./types";

export type CommandMode = "mutation" | "read";

export interface CommandPolicyMetadata {
  mode: CommandMode;
  risk: "low" | "high";
}

export interface CommandPolicyInput {
  command: string;
  actor: CommandActor;
  metadata: CommandPolicyMetadata;
}

export interface CommandPolicyDecision {
  allowed: boolean;
  reason?: string;
}

export interface CommandPolicy {
  canExecute(input: CommandPolicyInput): CommandPolicyDecision | Promise<CommandPolicyDecision>;
}

export const allowAllCommandPolicy: CommandPolicy = {
  canExecute() {
    return { allowed: true };
  },
};