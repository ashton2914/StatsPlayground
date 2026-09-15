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