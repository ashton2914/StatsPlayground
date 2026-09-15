import {
  allowAllCommandPolicy,
  type CommandMode,
  type CommandPolicy,
  type CommandPolicyDecision,
  type CommandPolicyMetadata,
} from "./policy";
import type {
  ApplicationCommand,
  CommandActor,
  CommandErrorCode,
  CommandExecutionContext,
  CommandLifecycleStatus,
  CommandProgress,
  CommandRegistryShape,
  CommandResult,
  CommandStatusChange,
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

type RequestStatus = CommandLifecycleStatus;

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
  cancellationSignal: Promise<void>;
  confirmationSignal: Promise<boolean>;
  signalCancellation(): void;
  resolveConfirmation(allow: boolean): void;
  resolve(value: CommandResult<TData>): void;
  reject(error: unknown): void;
}

interface RegisteredCommand {
  run: (input: unknown, context: CommandExecutionContext) => Promise<CommandHandlerResult<unknown>>;
  metadata: CommandPolicyMetadata;
}

export type PendingCommandResult<TData> = Promise<CommandResult<TData>> & {
  readonly requestId: string;
};

interface RuntimeRevisionAdapter {
  get: () => number;
  set: (revision: number) => void;
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
    context?: {
      signal?: AbortSignal;
      onProgress?: (progress: CommandProgress) => void;
      onStatusChange?: (status: CommandStatusChange) => void;
    },
  ): PendingCommandResult<TRegistry[TType]["data"]>;
  confirm(requestId: string, allow: boolean): boolean;
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

  private readonly idempotencyInFlight = new Map<string, Promise<CommandResult<unknown>>>();

  private mutationTail: Promise<void> = Promise.resolve();

  private projectRevision: number;

  private requestCounter = 0;

  private readonly policy: CommandPolicy;

  private readonly revisionAdapter?: RuntimeRevisionAdapter;

  constructor(input?: { initialRevision?: number; policy?: CommandPolicy; revision?: RuntimeRevisionAdapter }) {
    this.projectRevision = input?.initialRevision ?? 0;
    this.policy = input?.policy ?? allowAllCommandPolicy;
    this.revisionAdapter = input?.revision;
    if (this.revisionAdapter) {
      this.projectRevision = this.revisionAdapter.get();
    }
  }

  private getProjectRevision(): number {
    if (this.revisionAdapter) {
      return this.revisionAdapter.get();
    }
    return this.projectRevision;
  }

  private setProjectRevision(nextRevision: number): void {
    this.projectRevision = nextRevision;
    this.revisionAdapter?.set(nextRevision);
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

  execute<TType extends Extract<keyof TRegistry, string>>(
    command: ApplicationCommand<TRegistry, TType>,
    actor: CommandActor,
    context?: {
      signal?: AbortSignal;
      onProgress?: (progress: CommandProgress) => void;
      onStatusChange?: (status: CommandStatusChange) => void;
    },
  ): PendingCommandResult<TRegistry[TType]["data"]> {
    const registered = this.handlers.get(command.type);
    if (!registered) {
      const failed = Promise.reject(
        new CommandExecutionError("invalid_input", `Unknown command: ${command.type}`),
      ) as PendingCommandResult<TRegistry[TType]["data"]>;
      Object.defineProperty(failed, "requestId", {
        value: "",
        enumerable: true,
        configurable: false,
        writable: false,
      });
      return failed;
    }

    const idempotencyKey = this.buildIdempotencyKey(actor, command.type, command.control?.idempotencyKey);
    if (idempotencyKey) {
      const existing = this.idempotencyCache.get(idempotencyKey);
      if (existing) {
        const cached = Promise.resolve(
          existing as CommandResult<TRegistry[TType]["data"]>,
        ) as PendingCommandResult<TRegistry[TType]["data"]>;
        Object.defineProperty(cached, "requestId", {
          value: "",
          enumerable: true,
          configurable: false,
          writable: false,
        });
        return cached;
      }
      const inFlight = this.idempotencyInFlight.get(idempotencyKey);
      if (inFlight) {
        return inFlight as PendingCommandResult<TRegistry[TType]["data"]>;
      }
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

    const policyDecision = this.resolvePolicyDecision(
      requestId,
      command.type,
      actor,
      command.input,
      registered.metadata,
      request,
    );
    policyDecision.catch(() => undefined);

    if (context?.signal) {
      if (context.signal.aborted) {
        this.cancel(requestId);
      } else {
        context.signal.addEventListener("abort", () => {
          this.cancel(requestId);
        }, { once: true });
      }
    }

    this.mutationTail = this.mutationTail.then(
      () => this.runRequest(command, registered, request, policyDecision, context),
      () => this.runRequest(command, registered, request, policyDecision, context),
    ).then(
      () => undefined,
      () => undefined,
    );

    const requestPromise = request.promise as PendingCommandResult<TRegistry[TType]["data"]>;
    Object.defineProperty(requestPromise, "requestId", {
      value: requestId,
      enumerable: true,
      configurable: false,
      writable: false,
    });
    if (idempotencyKey) {
      this.idempotencyInFlight.set(idempotencyKey, requestPromise as Promise<CommandResult<unknown>>);
      requestPromise.then((result) => {
        this.idempotencyCache.set(idempotencyKey, result as CommandResult<unknown>);
      }).catch(() => undefined).finally(() => {
        if (this.idempotencyInFlight.get(idempotencyKey) === requestPromise) {
          this.idempotencyInFlight.delete(idempotencyKey);
        }
      });
    }

    return requestPromise;
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
    request.signalCancellation();
    if (request.status === "queued" || request.status === "awaiting-confirmation") {
      request.status = "cancelled";
      this.rejectRequest(request, new CommandExecutionError("cancelled", "Command cancelled"));
    }
    return true;
  }

  confirm(requestId: string, allow: boolean): boolean {
    const request = this.requests.get(requestId);
    if (!request || request.settled || request.status !== "awaiting-confirmation") {
      return false;
    }
    request.resolveConfirmation(allow);
    return true;
  }

  snapshot(): Array<{ requestId: string; command: string; status: RequestStatus }> {
    return [...this.requests.values()].map((request) => ({
      requestId: request.requestId,
      command: request.command,
      status: request.status,
    }));
  }

  private buildIdempotencyKey(
    actor: CommandActor,
    commandType: string,
    idempotencyKey: string | undefined,
  ): string | null {
    if (!idempotencyKey) return null;
    if (actor.kind !== "mcp") return null;
    return `${actor.sessionId}:${commandType}:${idempotencyKey}`;
  }

  private resolvePolicyDecision(
    requestId: string,
    command: string,
    actor: CommandActor,
    input: unknown,
    metadata: CommandPolicyMetadata,
    request: RuntimeRequest<unknown>,
  ): Promise<CommandPolicyDecision> {
    const evaluation = this.policy.canExecute({ requestId, command, actor, input, metadata });
    void request;
    if (evaluation instanceof Promise) {
      return evaluation;
    }
    return Promise.resolve(evaluation);
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
    let resolveCancellation: (() => void) | null = null;
    let resolveConfirmation: ((allow: boolean) => void) | null = null;

    const promise = new Promise<CommandResult<TData>>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const cancellationSignal = new Promise<void>((resolve) => {
      resolveCancellation = resolve;
    });
    const confirmationSignal = new Promise<boolean>((resolve) => {
      resolveConfirmation = resolve;
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
      cancellationSignal,
      confirmationSignal,
      signalCancellation() {
        resolveCancellation?.();
      },
      resolveConfirmation(allow) {
        resolveConfirmation?.(allow);
      },
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
    policyDecision: Promise<CommandPolicyDecision>,
    observer?: {
      onProgress?: (progress: CommandProgress) => void;
      onStatusChange?: (status: CommandStatusChange) => void;
    },
  ): Promise<void> {
    if (request.settled || request.status === "cancelled") {
      return;
    }

    try {
      let confirmationGranted = false;
      const policyOutcome = await Promise.race([
        policyDecision.then(
          (decision) => ({ kind: "policy" as const, decision }),
          (error) => ({ kind: "policy_error" as const, error }),
        ),
        request.cancellationSignal.then(() => ({ kind: "cancelled" as const })),
      ]);

      if (policyOutcome.kind === "cancelled") {
        throw new CommandExecutionError("cancelled", "Command cancelled");
      }

      if (policyOutcome.kind === "policy_error") {
        throw new CommandExecutionError("execution_failed", "Policy evaluation failed", false, {
          cause: policyOutcome.error instanceof Error ? policyOutcome.error.message : String(policyOutcome.error),
        });
      }

      const decision = policyOutcome.decision;
      if (request.settled) {
        return;
      }
      if (!decision.allowed) {
        throw new CommandExecutionError("user_denied", decision.reason ?? "Command denied by policy");
      }

      if (decision.requireConfirmation) {
        request.status = "awaiting-confirmation";
        const confirmationOutcome = await Promise.race([
          request.confirmationSignal.then((allow) => ({ kind: "confirmation" as const, allow })),
          request.cancellationSignal.then(() => ({ kind: "cancelled" as const })),
        ]);
        if (confirmationOutcome.kind === "cancelled") {
          throw new CommandExecutionError("cancelled", "Command cancelled");
        }
        if (!confirmationOutcome.allow) {
          throw new CommandExecutionError("user_denied", decision.reason ?? "Command denied by policy");
        }
        confirmationGranted = true;
      }

      if (request.status === "awaiting-confirmation") {
        request.status = "queued";
      }
      request.status = "running";

      if (request.mode === "mutation") {
        const expectedRevision = request.control.expectedProjectRevision;
        const currentRevision = this.getProjectRevision();
        if (expectedRevision != null && expectedRevision !== currentRevision) {
          throw new CommandExecutionError("revision_conflict", "Project revision does not match expected revision", false, {
            expected: expectedRevision,
            actual: currentRevision,
          });
        }
      }

      const runtimeContext: CommandExecutionContext = {
        requestId: request.requestId,
        signal: request.controller.signal,
        reportProgress: (progress) => {
          if (request.controller.signal.aborted && !request.committed) {
            return;
          }
          request.status = "running";
          observer?.onProgress?.(progress);
        },
        beginCommit: () => {
          if (request.controller.signal.aborted && !request.committed) {
            throw new CommandExecutionError("cancelled", "Command cancelled");
          }
          request.committed = true;
          request.status = "committing";
          observer?.onStatusChange?.({
            requestId: request.requestId,
            status: "committing",
            stage: "commit",
          });
        },
        trusted: {
          requestId: request.requestId,
          policy: {
            requireConfirmation: Boolean(decision.requireConfirmation),
            confirmationGranted,
            reason: decision.reason,
            trustedData: decision.trustedData,
          },
        },
      };

      if (request.controller.signal.aborted && !request.committed) {
        throw new CommandExecutionError("cancelled", "Command cancelled");
      }

      const handlerResult = await registered.run(command.input, runtimeContext);

      if (request.controller.signal.aborted && !request.committed) {
        throw new CommandExecutionError("cancelled", "Command cancelled");
      }

      if (request.mode === "mutation" && handlerResult.changed) {
        this.setProjectRevision(this.getProjectRevision() + 1);
      }

      const result: CommandResult<TRegistry[TType]["data"]> = {
        requestId: request.requestId,
        command: command.type,
        changed: handlerResult.changed,
        projectRevision: this.getProjectRevision(),
        data: handlerResult.data as TRegistry[TType]["data"],
        warnings: handlerResult.warnings ?? [],
      };

      request.status = "succeeded";
      request.resolve(result);
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
      request.reject(new CommandExecutionError("execution_failed", "Command handler failed", false, {
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
  revision?: RuntimeRevisionAdapter;
}): ApplicationCommandRuntime<TRegistry> {
  return new Runtime<TRegistry>(input);
}

export type {
  ApplicationCommand,
  CommandActor,
  CommandExecutionContext,
  CommandLifecycleStatus,
  CommandProgress,
  CommandResult,
  CommandStatusChange,
} from "./types";