import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { applicationRuntime } from "@/applicationCommands/applicationRuntime";
import { CommandExecutionError, type ApplicationCommandRuntime, type CommandProgress } from "@/applicationCommands/runtime";
import type { ApplicationCommand, ApplicationCommandRegistry } from "@/applicationCommands/types";

const APPLICATION_COMMAND_REQUEST_EVENT = "application-command-request";
const MCP_SESSION_ID = "application-command-broker";

type Runtime = Pick<ApplicationCommandRuntime<ApplicationCommandRegistry>, "execute">;
type Listen = typeof listen;
type Invoke = typeof invoke;

interface ApplicationCommandRequestPayload {
  requestId: string;
  command: ApplicationCommand<ApplicationCommandRegistry>;
}

interface ApplicationCommandBridgeDependencies {
  runtime: Runtime;
  listen: Listen;
  invoke: Invoke;
}

export interface ApplicationCommandBridgeHandle {
  start(): Promise<ApplicationCommandBridgeDisposer>;
  cancel(requestId: string): Promise<boolean>;
}

export interface ApplicationCommandBridgeDisposer {
  dispose(): Promise<void>;
}

export function createApplicationCommandBridge(
  dependencies: ApplicationCommandBridgeDependencies,
): ApplicationCommandBridgeHandle {
  let started: Promise<ApplicationCommandBridgeDisposer> | null = null;
  let unlisten: UnlistenFn | null = null;
  let disposed = false;
  const controllers = new Map<string, AbortController>();

  const complete = async (update: unknown): Promise<void> => {
    await dependencies.invoke("complete_application_command", { update });
  };

  const runCommand = (payload: ApplicationCommandRequestPayload): void => {
    if (disposed) return;
    const controller = new AbortController();
    controllers.set(payload.requestId, controller);

    const onProgress = (progress: CommandProgress) => {
      void complete({
        kind: "progress",
        requestId: payload.requestId,
        status: "running",
        stage: progress.stage,
        message: progress.message,
        percent: progress.percent,
      }).catch(() => undefined);
    };

    let commandPromise: Promise<unknown>;
    try {
      commandPromise = dependencies.runtime.execute(
        payload.command,
        { kind: "mcp", sessionId: MCP_SESSION_ID, clientId: payload.requestId },
        { signal: controller.signal, onProgress },
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
        await dependencies.invoke("register_application_command_dispatcher");
        unlisten = await dependencies.listen<ApplicationCommandRequestPayload>(
          APPLICATION_COMMAND_REQUEST_EVENT,
          (event) => runCommand(event.payload),
        );
        return {
          async dispose() {
            if (disposed) return;
            disposed = true;
            for (const controller of controllers.values()) {
              controller.abort();
            }
            controllers.clear();
            unlisten?.();
            unlisten = null;
            await dependencies.invoke("unregister_application_command_dispatcher");
          },
        };
      })();
      return started;
    },
    async cancel(requestId: string) {
      const controller = controllers.get(requestId);
      if (!controller) return false;
      controller.abort();
      return true;
    },
  };
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