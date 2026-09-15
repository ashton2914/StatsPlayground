import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { applicationRuntime } from "@/applicationCommands/applicationRuntime";
import { CommandExecutionError, type ApplicationCommandRuntime, type CommandProgress, type CommandStatusChange } from "@/applicationCommands/runtime";
import type { ApplicationCommand, ApplicationCommandRegistry } from "@/applicationCommands/types";

const APPLICATION_COMMAND_REQUEST_EVENT = "application-command-request";
const APPLICATION_COMMAND_CANCEL_EVENT = "application-command-cancel";
const MCP_SESSION_ID = "application-command-broker";
const URL_TOKEN_PATTERN = /\b(?:https?|ftp|file):\/\/[^\s"']+/gi;
const WINDOWS_ABSOLUTE_PATH_PATTERN = /(^|[^A-Za-z0-9_])([A-Za-z]:\\(?:[^\\/:*?"<>|\r\n]+\\)*[^\\/:*?"<>|\r\n]+)/g;
const WINDOWS_UNC_PATH_PATTERN = /(^|[^A-Za-z0-9_])(\\\\[^\\/\s]+\\[^\\/:*?"<>|\r\n]+(?:\\[^\\/:*?"<>|\r\n]+)+)/g;
const POSIX_ABSOLUTE_PATH_PATTERN = /(^|[^A-Za-z0-9_./-])(\/(?:[^\/\r\n\s][^\/\r\n]*)(?:\/[^\/\r\n]+)*)/g;

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

interface TrackedController {
  controller: AbortController;
  cancelled: boolean;
  committing: boolean;
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
  const controllers = new Map<string, TrackedController>();

  const complete = async (update: unknown): Promise<void> => {
    await dependencies.invoke("complete_application_command", { update });
  };

  const emitProgress = (requestId: string, progress: {
    status: string;
    stage: string;
    message?: string;
    percent?: number;
  }): void => {
    const tracked = controllers.get(requestId);
    if (!tracked || tracked.cancelled) return;
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
    const tracked = controllers.get(payload.requestId);
    if (!tracked || tracked.committing) return;
    tracked.cancelled = true;
    tracked.controller.abort();
  };

  const runCommand = (payload: ApplicationCommandRequestPayload): void => {
    if (disposed) return;
    const controller = new AbortController();
    controllers.set(payload.requestId, { controller, cancelled: false, committing: false });

    const onProgress = (progress: CommandProgress) => {
      emitProgress(payload.requestId, {
        status: "running",
        stage: progress.stage,
        message: progress.message,
        percent: progress.percent,
      });
    };

    const onStatusChange = (status: CommandStatusChange) => {
      const tracked = controllers.get(payload.requestId);
      if (!tracked || tracked.cancelled) return;
      if (status.status === "committing") {
        tracked.committing = true;
      }
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
      (result) => {
        const tracked = controllers.get(payload.requestId);
        if (!tracked || tracked.cancelled) return undefined;
        return complete({
          kind: "complete",
          requestId: payload.requestId,
          response: toSuccessResponse(result),
        });
      },
      (error) => {
        const tracked = controllers.get(payload.requestId);
        if (!tracked || tracked.cancelled) return undefined;
        return complete({
          kind: "complete",
          requestId: payload.requestId,
          response: toErrorResponse(error),
        });
      },
    ).catch(() => undefined).finally(() => {
      controllers.delete(payload.requestId);
    });
  };

  return {
    async start() {
      if (started) return started;
      disposed = false;
      started = (async () => {
        let disposeStarted = false;
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
            if (disposeStarted) return;
            disposeStarted = true;
            disposed = true;
            for (const tracked of controllers.values()) {
              tracked.cancelled = true;
              tracked.controller.abort();
            }
            controllers.clear();
            requestUnlisten?.();
            cancelUnlisten?.();
            requestUnlisten = null;
            cancelUnlisten = null;
            try {
              await dependencies.invoke("unregister_application_command_dispatcher");
            } finally {
              started = null;
            }
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
      message: sanitizeErrorPayload(error.message),
      retryable: error.retryable,
      details: sanitizeErrorPayload(error.details),
    };
  }
  return {
    kind: "error",
    code: "execution_failed",
    message: sanitizeErrorPayload(error instanceof Error ? error.message : String(error)),
    retryable: false,
    details: error instanceof Error && getErrorCause(error) !== undefined
      ? sanitizeErrorPayload({ cause: getErrorCause(error) })
      : undefined,
  };
}

function getErrorCause(error: Error): unknown {
  return (error as Error & { cause?: unknown }).cause;
}

function sanitizeErrorPayload<T>(value: T): T {
  if (typeof value === "string") {
    return redactAbsolutePaths(value) as T;
  }
  if (value instanceof Error) {
    const cause = getErrorCause(value);
    const output: Record<string, unknown> = {
      name: value.name,
      message: redactAbsolutePaths(value.message),
    };
    if (cause !== undefined) {
      output.cause = sanitizeErrorPayload(cause);
    }
    return output as T;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeErrorPayload(entry)) as T;
  }
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      output[redactAbsolutePaths(key)] = sanitizeErrorPayload(entry);
    }
    return output as T;
  }
  return value;
}

function redactPathLikeSegments(text: string): string {
  return text
    .replace(WINDOWS_UNC_PATH_PATTERN, "$1[redacted-path]")
    .replace(WINDOWS_ABSOLUTE_PATH_PATTERN, "$1[redacted-path]")
    .replace(POSIX_ABSOLUTE_PATH_PATTERN, "$1[redacted-path]");
}

function redactAbsolutePaths(text: string): string {
  let result = "";
  let cursor = 0;
  let match: RegExpExecArray | null = URL_TOKEN_PATTERN.exec(text);

  while (match) {
    const tokenStart = match.index;
    const tokenEnd = tokenStart + match[0].length;
    result += redactPathLikeSegments(text.slice(cursor, tokenStart));
    result += match[0];
    cursor = tokenEnd;
    match = URL_TOKEN_PATTERN.exec(text);
  }

  result += redactPathLikeSegments(text.slice(cursor));
  URL_TOKEN_PATTERN.lastIndex = 0;
  return result;
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