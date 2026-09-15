export interface MutationControl {
  expectedProjectRevision?: number;
  idempotencyKey?: string;
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
  | "cancelled"
  | "policy_denied"
  | "revision_conflict"
  | "unknown_command"
  | "handler_failed";

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

export type ApplicationCommandType = never;

export type CommandRegistryShape = Record<string, { input: unknown; data: unknown }>;

export type ApplicationCommand<
  TRegistry extends CommandRegistryShape,
  TType extends Extract<keyof TRegistry, string> = Extract<keyof TRegistry, string>,
> = {
  type: TType;
  input: TRegistry[TType]["input"];
  control?: MutationControl;
};