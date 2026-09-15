import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { applicationRuntime } from "@/applicationCommands/applicationRuntime";
import { CommandExecutionError, type ApplicationCommandRuntime, type CommandProgress, type CommandStatusChange } from "@/applicationCommands/runtime";
import type { ApplicationCommand, ApplicationCommandRegistry } from "@/applicationCommands/types";

const APPLICATION_COMMAND_REQUEST_EVENT = "application-command-request";
const APPLICATION_COMMAND_CANCEL_EVENT = "application-command-cancel";
const MCP_SESSION_ID = "application-command-broker";

type Runtime = Pick<ApplicationCommandRuntime<ApplicationCommandRegistry>, "execute">;
type Listen = typeof listen;
type Invoke = typeof invoke;

interface ApplicationCommandRequestPayload {
  requestId: string;
  command: ApplicationCommand<ApplicationCommandRegistry>;
}

interface ApplicationCommandCancelPayload {
  requestId: string;
}

interface ApplicationCommandBridgeDependencies {
  runtime: Runtime;
  listen: Listen;
  invoke: Invoke;
}

export interface ApplicationCommandBridgeHandle {
  start(): Promise<ApplicationCommandBridgeDisposer>;
}

export interface ApplicationCommandBridgeDisposer {
  dispose(): Promise<void>;
}

export function createApplicationCommandBridge(
  dependencies: ApplicationCommandBridgeDependencies,
): ApplicationCommandBridgeHandle {
  let started: Promise<ApplicationCommandBridgeDisposer> | null = null;
  let requestUnlisten: UnlistenFn | null = null;
  let cancelUnlisten: UnlistenFn | null = null;
  let disposed = false;
  const controllers = new Map<string, AbortController>();

  const complete = async (update: unknown): Promise<void> => {
    await dependencies.invoke("complete_application_command", { update });
  };

  const emitProgress = (requestId: string, progress: {
    status: string;
    stage: string;
    message?: string;
    percent?: number;
  }): void => {
    const update: Record<string, unknown> = {
      kind: "progress",
      requestId,
      status: toBrokerStatus(progress.status),
      stage: progress.stage,
    };
    if (progress.message !== undefined) update.message = progress.message;
    if (progress.percent !== undefined) update.percent = progress.percent;
    void complete(update).catch(() => undefined);
  };

  const cancelCommand = (payload: ApplicationCommandCancelPayload): void => {
    controllers.get(payload.requestId)?.abort();
  };

  const runCommand = (payload: ApplicationCommandRequestPayload): void => {
    if (disposed) return;
    const controller = new AbortController();
    controllers.set(payload.requestId, controller);

    const onProgress = (progress: CommandProgress) => {
      emitProgress(payload.requestId, {
        status: "running",
        stage: progress.stage,
        message: progress.message,
        percent: progress.percent,
      });
    };

    const onStatusChange = (status: CommandStatusChange) => {
      emitProgress(payload.requestId, {
        status: status.status,
        stage: status.stage,
        message: status.message,
        percent: status.percent,
      });
    };

    let commandPromise: Promise<unknown>;
    try {
      commandPromise = dependencies.runtime.execute(
        payload.command,
        { kind: "mcp", sessionId: MCP_SESSION_ID, clientId: payload.requestId },
        { signal: controller.signal, onProgress, onStatusChange },
      );
    } catch (error) {
      controllers.delete(payload.requestId);
      void complete({
        kind: "complete",
        requestId: payload.requestId,
        response: toErrorResponse(error),
      }).catch(() => undefined);
      return;
    }

    commandPromise.then(
      (result) => complete({
        kind: "complete",
        requestId: payload.requestId,
        response: toSuccessResponse(result),
      }),
      (error) => complete({
        kind: "complete",
        requestId: payload.requestId,
        response: toErrorResponse(error),
      }),
    ).catch(() => undefined).finally(() => {
      controllers.delete(payload.requestId);
    });
  };

  return {
    async start() {
      if (started) return started;
      started = (async () => {
        try {
          requestUnlisten = await dependencies.listen<ApplicationCommandRequestPayload>(
            APPLICATION_COMMAND_REQUEST_EVENT,
            (event) => runCommand(event.payload),
          );
          cancelUnlisten = await dependencies.listen<ApplicationCommandCancelPayload>(
            APPLICATION_COMMAND_CANCEL_EVENT,
            (event) => cancelCommand(event.payload),
          );
          await dependencies.invoke("register_application_command_dispatcher");
        } catch (error) {
          requestUnlisten?.();
          cancelUnlisten?.();
          requestUnlisten = null;
          cancelUnlisten = null;
          started = null;
          throw error;
        }
        return {
          async dispose() {
            if (disposed) return;
            disposed = true;
            for (const controller of controllers.values()) {
              controller.abort();
            }
            controllers.clear();
            requestUnlisten?.();
            cancelUnlisten?.();
            requestUnlisten = null;
            cancelUnlisten = null;
            await dependencies.invoke("unregister_application_command_dispatcher");
          },
        };
      })();
      return started;
    },
  };
}

function toBrokerStatus(status: string): string {
  if (status === "awaiting-confirmation") return "awaitingConfirmation";
  return status;
}

function toSuccessResponse(result: unknown): unknown {
  const commandResult = result as {
    changed: boolean;
    projectRevision: number;
    data: unknown;
    warnings?: unknown[];
  };
  return {
    kind: "success",
    changed: commandResult.changed,
    projectRevision: commandResult.projectRevision,
    data: commandResult.data,
    warnings: commandResult.warnings ?? [],
  };
}

function toErrorResponse(error: unknown): unknown {
  if (error instanceof CommandExecutionError) {
    return {
      kind: "error",
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      details: error.details,
    };
  }
  return {
    kind: "error",
    code: "execution_failed",
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
    details: undefined,
  };
}

let applicationCommandBridge: ApplicationCommandBridgeHandle | null = null;

export function startApplicationCommandBridge(): Promise<ApplicationCommandBridgeDisposer> {
  if (!applicationCommandBridge) {
    applicationCommandBridge = createApplicationCommandBridge({
      runtime: applicationRuntime,
      listen,
      invoke,
    });
  }
  return applicationCommandBridge.start();
}