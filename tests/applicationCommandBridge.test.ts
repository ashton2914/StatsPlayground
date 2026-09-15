import assert from "node:assert/strict";

import { CommandExecutionError, type CommandActor, type CommandProgress, type CommandResult } from "@/applicationCommands/runtime";
import type { ApplicationCommandRegistry } from "@/applicationCommands/types";
import { createApplicationCommandBridge } from "@/services/applicationCommandBridge";

type Listener = (event: { payload: { requestId: string; command: unknown } }) => void;
type CancelListener = (event: { payload: { requestId: string } }) => void;

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function withRequestId<T>(promise: Promise<T>, requestId: string): Promise<T> & { requestId: string } {
  Object.defineProperty(promise, "requestId", {
    value: requestId,
    enumerable: true,
  });
  return promise as Promise<T> & { requestId: string };
}

{
  const listeners: Record<string, Listener> = {};
  const cancelListeners: Record<string, CancelListener> = {};
  const unlistenCalls: string[] = [];
  const invocations: Array<{ command: string; args?: unknown }> = [];
  const execution = deferred<CommandResult<{ ok: true }>>();
  const captured: Array<{
    command: unknown;
    actor: CommandActor;
    context?: { signal?: AbortSignal; onProgress?: (progress: CommandProgress) => void };
  }> = [];

  const bridge = createApplicationCommandBridge({
    runtime: {
      execute: (command, actor, context) => {
        captured.push({ command, actor, context });
        return withRequestId(execution.promise, "runtime-request-1") as never;
      },
    },
    listen: async (eventName, listener) => {
      assert.equal([...Object.keys(listeners), ...Object.keys(cancelListeners)].includes(eventName), false, "bridge must listen exactly once per event");
      if (eventName === "application-command-request") {
        listeners[eventName] = listener as Listener;
      } else if (eventName === "application-command-cancel") {
        cancelListeners[eventName] = listener as CancelListener;
      } else {
        assert.fail(`unexpected listener ${eventName}`);
      }
      return () => {
        unlistenCalls.push(eventName);
      };
    },
    invoke: async (command, args) => {
      invocations.push({ command, args });
      if (command === "register_application_command_dispatcher") {
        assert.equal(typeof listeners["application-command-request"], "function", "request listener must be installed before ready registration");
        assert.equal(typeof cancelListeners["application-command-cancel"], "function", "cancel listener must be installed before ready registration");
        listeners["application-command-request"]({
          payload: {
            requestId: "rust-request-1",
            command: {
              type: "project.inspect",
              input: { includeCapabilities: true },
              control: { idempotencyKey: "inspect-1" },
            },
          },
        });
      }
      return undefined as never;
    },
  });

  const dispose = await bridge.start();
  await bridge.start();
  assert.deepEqual(invocations.filter((entry) => entry.command === "register_application_command_dispatcher"), [
    { command: "register_application_command_dispatcher", args: undefined },
  ]);
  assert.equal(Object.keys(listeners).length, 1);
  assert.equal(Object.keys(cancelListeners).length, 1);

  assert.equal(captured.length, 1);
  assert.deepEqual(captured[0].command, {
    type: "project.inspect",
    input: { includeCapabilities: true },
    control: { idempotencyKey: "inspect-1" },
  });
  assert.deepEqual(captured[0].actor, {
    kind: "mcp",
    sessionId: "application-command-broker",
    clientId: "rust-request-1",
  });

  captured[0].context?.onProgress?.({ stage: "load", message: "Loading", percent: 0.25 });
  const progressInvocation = invocations.at(-1);
  assert.equal(progressInvocation?.command, "complete_application_command");
  assert.deepEqual(progressInvocation?.args, {
    update: {
      kind: "progress",
      requestId: "rust-request-1",
      status: "running",
      stage: "load",
      message: "Loading",
      percent: 0.25,
    },
  });

  execution.resolve({
    requestId: "runtime-request-1",
    command: "project.inspect",
    changed: false,
    projectRevision: 12,
    data: { ok: true },
    warnings: [],
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(invocations.at(-1), {
    command: "complete_application_command",
    args: {
      update: {
        kind: "complete",
        requestId: "rust-request-1",
        response: {
          kind: "success",
          changed: false,
          projectRevision: 12,
          data: { ok: true },
          warnings: [],
        },
      },
    },
  });

  await dispose.dispose();
  assert.deepEqual(unlistenCalls.sort(), ["application-command-cancel", "application-command-request"]);
  assert.deepEqual(invocations.at(-1), { command: "unregister_application_command_dispatcher", args: undefined });
}

{
  const listeners: Record<string, Listener> = {};
  const cancelListeners: Record<string, CancelListener> = {};
  const invocations: Array<{ command: string; args?: unknown }> = [];
  const execution = deferred<CommandResult<unknown>>();
  let capturedSignal: AbortSignal | undefined;

  const bridge = createApplicationCommandBridge({
    runtime: {
      execute: (_command, _actor, context) => {
        capturedSignal = context?.signal;
        return withRequestId(execution.promise, "runtime-request-2") as never;
      },
    },
    listen: async (eventName, listener) => {
      if (eventName === "application-command-request") {
        listeners[eventName] = listener as Listener;
      } else if (eventName === "application-command-cancel") {
        cancelListeners[eventName] = listener as CancelListener;
      }
      return () => undefined;
    },
    invoke: async (command, args) => {
      invocations.push({ command, args });
      return undefined as never;
    },
  });
  await bridge.start();
  listeners["application-command-request"]({
    payload: {
      requestId: "rust-request-2",
      command: { type: "project.inspect", input: {} },
    },
  });

  cancelListeners["application-command-cancel"]({ payload: { requestId: "unknown-request" } });
  assert.equal(capturedSignal?.aborted, false);
  cancelListeners["application-command-cancel"]({ payload: { requestId: "rust-request-2" } });
  assert.equal(capturedSignal?.aborted, true);
  execution.reject(new CommandExecutionError("cancelled", "Command cancelled"));
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(invocations.at(-1), {
    command: "complete_application_command",
    args: {
      update: {
        kind: "complete",
        requestId: "rust-request-2",
        response: {
          kind: "error",
          code: "cancelled",
          message: "Command cancelled",
          retryable: false,
          details: undefined,
        },
      },
    },
  });
}

{
  const listeners: Record<string, Listener> = {};
  const invocations: Array<{ command: string; args?: unknown }> = [];
  const execution = deferred<CommandResult<unknown>>();

  const bridge = createApplicationCommandBridge({
    runtime: {
      execute: (_command, _actor, context) => {
        (context as { onStatusChange?: (event: { status: string; stage: string }) => void } | undefined)
          ?.onStatusChange?.({ status: "committing", stage: "commit" });
        return withRequestId(execution.promise, "runtime-request-commit") as never;
      },
    },
    listen: async (eventName, listener) => {
      if (eventName === "application-command-request") {
        listeners[eventName] = listener as Listener;
      }
      return () => undefined;
    },
    invoke: async (command, args) => {
      invocations.push({ command, args });
      return undefined as never;
    },
  });

  await bridge.start();
  listeners["application-command-request"]({
    payload: {
      requestId: "rust-request-commit",
      command: { type: "table.create", input: {} },
    },
  });

  assert.deepEqual(invocations.at(-1), {
    command: "complete_application_command",
    args: {
      update: {
        kind: "progress",
        requestId: "rust-request-commit",
        status: "committing",
        stage: "commit",
      },
    },
  });
}

{
  const unlistenCalls: string[] = [];
  const invocations: Array<{ command: string; args?: unknown }> = [];
  const bridge = createApplicationCommandBridge({
    runtime: {
      execute: () => withRequestId(new Promise<never>(() => undefined), "unused") as never,
    },
    listen: async (eventName) => {
      if (eventName === "application-command-request") {
        return () => {
          unlistenCalls.push(eventName);
        };
      }
      throw new Error("cancel listener failed");
    },
    invoke: async (command, args) => {
      invocations.push({ command, args });
      return undefined as never;
    },
  });

  await assert.rejects(bridge.start(), /cancel listener failed/);
  assert.deepEqual(unlistenCalls, ["application-command-request"]);
  assert.equal(invocations.some((entry) => entry.command === "register_application_command_dispatcher"), false);
}

{
  const unlistenCalls: string[] = [];
  const invocations: Array<{ command: string; args?: unknown }> = [];
  const bridge = createApplicationCommandBridge({
    runtime: {
      execute: () => withRequestId(new Promise<never>(() => undefined), "unused") as never,
    },
    listen: async (eventName) => () => {
      unlistenCalls.push(eventName);
    },
    invoke: async (command, args) => {
      invocations.push({ command, args });
      if (command === "register_application_command_dispatcher") {
        throw new Error("register failed");
      }
      return undefined as never;
    },
  });

  await assert.rejects(bridge.start(), /register failed/);
  assert.deepEqual(unlistenCalls.sort(), ["application-command-cancel", "application-command-request"]);
  assert.deepEqual(invocations, [{ command: "register_application_command_dispatcher", args: undefined }]);
}

{
  const listeners: Record<string, Listener> = {};
  const invocations: Array<{ command: string; args?: unknown }> = [];

  const bridge = createApplicationCommandBridge({
    runtime: {
      execute: () => {
        throw new CommandExecutionError("invalid_input", "Bad input", false, { field: "x" });
      },
    },
    listen: async (eventName, listener) => {
      listeners[eventName] = listener as Listener;
      return () => undefined;
    },
    invoke: async (command, args) => {
      invocations.push({ command, args });
      return undefined as never;
    },
  });
  await bridge.start();
  listeners["application-command-request"]({
    payload: {
      requestId: "rust-request-3",
      command: { type: "unknown.command", input: {} } as never,
    },
  });

  await Promise.resolve();
  assert.deepEqual(invocations.at(-1), {
    command: "complete_application_command",
    args: {
      update: {
        kind: "complete",
        requestId: "rust-request-3",
        response: {
          kind: "error",
          code: "invalid_input",
          message: "Bad input",
          retryable: false,
          details: { field: "x" },
        },
      },
    },
  });
}

{
  const { readFileSync } = await import("node:fs");
  const workspaceSource = readFileSync(new URL("../src/components/Workspace.tsx", import.meta.url), "utf8");
  const analysisViewSource = readFileSync(new URL("../src/components/analysis/AnalysisView.tsx", import.meta.url), "utf8");
  assert.match(
    workspaceSource,
    /mountApplicationCommandBridge\(\)/,
    "Workspace/app shell must mount the application command bridge lifecycle once after stores are ready",
  );
  assert.equal(
    analysisViewSource.includes("ApplicationCommandBridge"),
    false,
    "Bridge must not be mounted inside an analysis/document view",
  );
}

{
  const { mountApplicationCommandBridge } = await import("@/components/workspaceApplicationCommandBridge");
  const errors: unknown[] = [];
  let unregisterCount = 0;
  const first = mountApplicationCommandBridge({
    start: async () => {
      throw new Error("bridge start failed");
    },
    onStartupError: (error) => errors.push(error),
  });
  const second = mountApplicationCommandBridge({
    start: async () => {
      unregisterCount += 1;
      return { dispose: async () => undefined };
    },
    onStartupError: (error) => errors.push(error),
  });

  await first.ready;
  await second.ready;
  await first.dispose();
  await first.dispose();
  await second.dispose();
  await second.dispose();

  assert.equal(errors.length, 1);
  assert.deepEqual(errors[0], {
    code: "application_command_bridge_start_failed",
    message: "Application command bridge failed to start",
    cause: "bridge start failed",
  });
  assert.equal(unregisterCount, 1, "workspace bridge lifecycle must mount one shell bridge and dispose once");
}

void ({} satisfies ApplicationCommandRegistry);

console.log("application command bridge tests passed");