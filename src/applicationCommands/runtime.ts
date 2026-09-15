import { allowAllCommandPolicy, type CommandMode, type CommandPolicy, type CommandPolicyMetadata } from "./policy";
import type {
  ApplicationCommand,
  CommandActor,
  CommandErrorCode,
  CommandExecutionContext,
  CommandProgress,
  CommandRegistryShape,
  CommandResult,
  CommandWarning,
} from "./types";

type CommandHandlerResult<TData> = {
  changed: boolean;
  data: TData;
  warnings?: CommandWarning[];
};

type CommandHandler<
  TRegistry extends CommandRegistryShape,
  TType extends Extract<keyof TRegistry, string>,
> = (
  input: TRegistry[TType]["input"],
  context: CommandExecutionContext,
) => Promise<CommandHandlerResult<TRegistry[TType]["data"]>>;

type RequestStatus =
  | "queued"
  | "running"
  | "awaiting-confirmation"
  | "committing"
  | "succeeded"
  | "failed"
  | "cancelled";

interface RuntimeRequest<TData> {
  requestId: string;
  command: string;
  status: RequestStatus;
  actor: CommandActor;
  control: { expectedProjectRevision?: number; idempotencyKey?: string };
  mode: CommandMode;
  controller: AbortController;
  committed: boolean;
  settled: boolean;
  resolve(value: CommandResult<TData>): void;
  reject(error: unknown): void;
}

interface RegisteredCommand {
  run: (input: unknown, context: CommandExecutionContext) => Promise<CommandHandlerResult<unknown>>;
  metadata: CommandPolicyMetadata;
}

export interface ApplicationCommandRuntime<TRegistry extends CommandRegistryShape> {
  register<TType extends Extract<keyof TRegistry, string>>(
    type: TType,
    handler: CommandHandler<TRegistry, TType>,
    config?: { mode?: CommandMode; risk?: "low" | "high" },
  ): void;
  execute<TType extends Extract<keyof TRegistry, string>>(
    command: ApplicationCommand<TRegistry, TType>,
    actor: CommandActor,
    context?: { signal?: AbortSignal; onProgress?: (progress: CommandProgress) => void },
  ): Promise<CommandResult<TRegistry[TType]["data"]>>;
  cancel(requestId: string): boolean;
  snapshot(): Array<{ requestId: string; command: string; status: RequestStatus }>;
}

export class CommandExecutionError extends Error {
  public readonly code: CommandErrorCode;
  public readonly retryable: boolean;
  public readonly details?: Record<string, unknown>;

  constructor(
    code: CommandErrorCode,
    message: string,
    retryable = false,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "CommandExecutionError";
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }
}

class Runtime<TRegistry extends CommandRegistryShape> implements ApplicationCommandRuntime<TRegistry> {
  private readonly handlers = new Map<string, RegisteredCommand>();

  private readonly requests = new Map<string, RuntimeRequest<unknown>>();

  private readonly idempotencyCache = new Map<string, CommandResult<unknown>>();

  private mutationTail: Promise<void> = Promise.resolve();

  private projectRevision: number;

  private requestCounter = 0;

  private readonly policy: CommandPolicy;

  constructor(input?: { initialRevision?: number; policy?: CommandPolicy }) {
    this.projectRevision = input?.initialRevision ?? 0;
    this.policy = input?.policy ?? allowAllCommandPolicy;
  }

  register<TType extends Extract<keyof TRegistry, string>>(
    type: TType,
    handler: CommandHandler<TRegistry, TType>,
    config?: { mode?: CommandMode; risk?: "low" | "high" },
  ): void {
    this.handlers.set(type, {
      run: (input, context) => handler(input as TRegistry[TType]["input"], context),
      metadata: {
        mode: config?.mode ?? "mutation",
        risk: config?.risk ?? "low",
      },
    });
  }

  async execute<TType extends Extract<keyof TRegistry, string>>(
    command: ApplicationCommand<TRegistry, TType>,
    actor: CommandActor,
    context?: { signal?: AbortSignal; onProgress?: (progress: CommandProgress) => void },
  ): Promise<CommandResult<TRegistry[TType]["data"]>> {
    const registered = this.handlers.get(command.type);
    if (!registered) {
      throw new CommandExecutionError("unknown_command", `Unknown command: ${command.type}`);
    }

    const idempotencyKey = this.buildIdempotencyKey(actor, command.control?.idempotencyKey);
    if (idempotencyKey) {
      const existing = this.idempotencyCache.get(idempotencyKey);
      if (existing) {
        return existing as CommandResult<TRegistry[TType]["data"]>;
      }
    }

    const policyEvaluation = this.policy.canExecute({
      command: command.type,
      actor,
      metadata: registered.metadata,
    });
    const policyDecision = policyEvaluation instanceof Promise
      ? await policyEvaluation
      : policyEvaluation;
    if (!policyDecision.allowed) {
      throw new CommandExecutionError("policy_denied", policyDecision.reason ?? "Command denied by policy");
    }

    const requestId = this.nextRequestId();
    const request = this.createRequest<TRegistry[TType]["data"]>({
      requestId,
      command: command.type,
      actor,
      control: {
        expectedProjectRevision: command.control?.expectedProjectRevision,
        idempotencyKey: command.control?.idempotencyKey,
      },
      mode: registered.metadata.mode,
    });

    if (context?.signal) {
      if (context.signal.aborted) {
        this.cancel(requestId);
      } else {
        context.signal.addEventListener("abort", () => {
          this.cancel(requestId);
        }, { once: true });
      }
    }

    if (registered.metadata.mode === "read") {
      await this.runRequest(command, registered, request, context?.onProgress);
      return request.promise as Promise<CommandResult<TRegistry[TType]["data"]>>;
    }

    this.mutationTail = this.mutationTail.then(
      () => this.runRequest(command, registered, request, context?.onProgress),
      () => this.runRequest(command, registered, request, context?.onProgress),
    ).then(
      () => undefined,
      () => undefined,
    );

    return request.promise as Promise<CommandResult<TRegistry[TType]["data"]>>;
  }

  cancel(requestId: string): boolean {
    const request = this.requests.get(requestId);
    if (!request) return false;
    if (request.status === "succeeded" || request.status === "failed" || request.status === "cancelled") {
      return false;
    }
    if (request.committed || request.status === "committing") {
      return false;
    }

    request.controller.abort();
    if (request.status === "queued") {
      request.status = "cancelled";
      this.rejectRequest(request, new CommandExecutionError("cancelled", "Command cancelled"));
    }
    return true;
  }

  snapshot(): Array<{ requestId: string; command: string; status: RequestStatus }> {
    return [...this.requests.values()].map((request) => ({
      requestId: request.requestId,
      command: request.command,
      status: request.status,
    }));
  }

  private buildIdempotencyKey(actor: CommandActor, idempotencyKey: string | undefined): string | null {
    if (!idempotencyKey) return null;
    if (actor.kind !== "mcp") return null;
    return `${actor.sessionId}:${idempotencyKey}`;
  }

  private nextRequestId(): string {
    this.requestCounter += 1;
    return `cmd-${this.requestCounter}`;
  }

  private createRequest<TData>(input: {
    requestId: string;
    command: string;
    actor: CommandActor;
    control: { expectedProjectRevision?: number; idempotencyKey?: string };
    mode: CommandMode;
  }): RuntimeRequest<TData> & { promise: Promise<CommandResult<TData>> } {
    let resolvePromise: ((value: CommandResult<TData>) => void) | null = null;
    let rejectPromise: ((reason?: unknown) => void) | null = null;

    const promise = new Promise<CommandResult<TData>>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });

    const request: RuntimeRequest<TData> & { promise: Promise<CommandResult<TData>> } = {
      requestId: input.requestId,
      command: input.command,
      status: "queued",
      actor: input.actor,
      control: input.control,
      mode: input.mode,
      controller: new AbortController(),
      committed: false,
      settled: false,
      resolve(value) {
        if (request.settled) return;
        request.settled = true;
        resolvePromise?.(value);
      },
      reject(error) {
        if (request.settled) return;
        request.settled = true;
        rejectPromise?.(error);
      },
      promise,
    };

    this.requests.set(input.requestId, request as RuntimeRequest<unknown>);
    return request;
  }

  private async runRequest<
    TType extends Extract<keyof TRegistry, string>,
  >(
    command: ApplicationCommand<TRegistry, TType>,
    registered: RegisteredCommand,
    request: RuntimeRequest<TRegistry[TType]["data"]>,
    onProgress?: (progress: CommandProgress) => void,
  ): Promise<void> {
    if (request.settled || request.status === "cancelled") {
      return;
    }

    try {
      request.status = "running";

      if (request.mode === "mutation") {
        const expectedRevision = request.control.expectedProjectRevision;
        if (expectedRevision != null && expectedRevision !== this.projectRevision) {
          throw new CommandExecutionError("revision_conflict", "Project revision does not match expected revision", false, {
            expected: expectedRevision,
            actual: this.projectRevision,
          });
        }
      }

      const runtimeContext: CommandExecutionContext = {
        requestId: request.requestId,
        signal: request.controller.signal,
        reportProgress: (progress) => {
          request.status = "running";
          onProgress?.(progress);
        },
        beginCommit: () => {
          request.committed = true;
          request.status = "committing";
        },
      };

      const handlerResult = await registered.run(command.input, runtimeContext);

      if (request.controller.signal.aborted && !request.committed) {
        throw new CommandExecutionError("cancelled", "Command cancelled");
      }

      if (request.mode === "mutation" && handlerResult.changed) {
        this.projectRevision += 1;
      }

      const result: CommandResult<TRegistry[TType]["data"]> = {
        requestId: request.requestId,
        command: command.type,
        changed: handlerResult.changed,
        projectRevision: this.projectRevision,
        data: handlerResult.data as TRegistry[TType]["data"],
        warnings: handlerResult.warnings ?? [],
      };

      request.status = "succeeded";
      request.resolve(result);

      const idempotencyKey = this.buildIdempotencyKey(request.actor, request.control.idempotencyKey);
      if (idempotencyKey) {
        this.idempotencyCache.set(idempotencyKey, result);
      }
    } catch (error) {
      if (request.settled) return;

      if (error instanceof CommandExecutionError) {
        request.status = error.code === "cancelled" ? "cancelled" : "failed";
        request.reject(error);
        return;
      }

      if (request.controller.signal.aborted && !request.committed) {
        request.status = "cancelled";
        request.reject(new CommandExecutionError("cancelled", "Command cancelled"));
        return;
      }

      request.status = "failed";
      request.reject(new CommandExecutionError("handler_failed", "Command handler failed", false, {
        cause: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  private rejectRequest(request: RuntimeRequest<unknown>, error: CommandExecutionError): void {
    request.reject(error);
  }
}

export function createApplicationCommandRuntime<TRegistry extends CommandRegistryShape>(input?: {
  initialRevision?: number;
  policy?: CommandPolicy;
}): ApplicationCommandRuntime<TRegistry> {
  return new Runtime<TRegistry>(input);
}

export type {
  ApplicationCommand,
  CommandActor,
  CommandExecutionContext,
  CommandProgress,
  CommandResult,
} from "./types";