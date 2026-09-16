import assert from "node:assert/strict";

import {
  CommandExecutionError,
  createApplicationCommandRuntime,
  type ApplicationCommand,
  type ApplicationCommandRuntime,
  type CommandActor,
} from "@/applicationCommands/runtime";
import type { CommandPolicy } from "@/applicationCommands/policy";

type TestRegistry = {
  "test.mutate": { input: Record<string, never>; data: { id: string } };
  "test.read": { input: Record<string, never>; data: { ok: true } };
  "test.slow": { input: Record<string, never>; data: { id: string } };
  "test.commit": { input: Record<string, never>; data: { committed: true } };
  "test.other": { input: Record<string, never>; data: { marker: "other" } };
};

const MCP_ACTOR: CommandActor = { kind: "mcp", sessionId: "session-a" };

function mutate(control?: ApplicationCommand<TestRegistry, "test.mutate">["control"]): ApplicationCommand<TestRegistry, "test.mutate"> {
  return {
    type: "test.mutate",
    input: {},
    control,
  };
}

async function waitForRequestStatus(
  runtime: ApplicationCommandRuntime<TestRegistry>,
  requestId: string,
  status: string,
): Promise<void> {
  while (runtime.snapshot().find((entry) => entry.requestId === requestId)?.status !== status) {
    await Promise.resolve();
  }
}

{
  const runtime = createApplicationCommandRuntime<TestRegistry>({ initialRevision: 4 });
  runtime.register("test.mutate", async () => ({ changed: true, data: { id: "a" }, warnings: [] }), {
    mode: "mutation",
  });

  const first = await runtime.execute(
    mutate({ expectedProjectRevision: 4, idempotencyKey: "create-a" }),
    MCP_ACTOR,
  );
  const duplicate = await runtime.execute(
    mutate({ expectedProjectRevision: 4, idempotencyKey: "create-a" }),
    MCP_ACTOR,
  );

  assert.equal(first.projectRevision, 5);
  assert.deepEqual(duplicate, first);

  await assert.rejects(
    runtime.execute(mutate({ expectedProjectRevision: 4 }), { kind: "ui" }),
    (error: unknown) => error instanceof CommandExecutionError && error.code === "revision_conflict",
  );
}

{
  const runtime = createApplicationCommandRuntime<TestRegistry>({ initialRevision: 0 });
  let runCount = 0;
  let release: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  runtime.register(
    "test.slow",
    async () => {
      runCount += 1;
      await gate;
      return { changed: true, data: { id: "once" }, warnings: [] };
    },
    { mode: "mutation" },
  );

  const one = runtime.execute(
    { type: "test.slow", input: {}, control: { idempotencyKey: "same" } },
    { kind: "mcp", sessionId: "session-a" },
  );
  const two = runtime.execute(
    { type: "test.slow", input: {}, control: { idempotencyKey: "same" } },
    { kind: "mcp", sessionId: "session-a" },
  );

  release?.();
  const [first, second] = await Promise.all([one, two]);

  assert.equal(runCount, 1);
  assert.deepEqual(second, first);
  assert.equal(first.projectRevision, 1);
}

{
  const runtime = createApplicationCommandRuntime<TestRegistry>({ initialRevision: 0 });
  let mutateCount = 0;
  let otherCount = 0;

  runtime.register(
    "test.mutate",
    async () => {
      mutateCount += 1;
      return { changed: true, data: { id: "mutate" }, warnings: [] };
    },
    { mode: "mutation" },
  );
  runtime.register(
    "test.other",
    async () => {
      otherCount += 1;
      return { changed: true, data: { marker: "other" }, warnings: [] };
    },
    { mode: "mutation" },
  );

  const first = await runtime.execute(
    { type: "test.mutate", input: {}, control: { idempotencyKey: "same" } },
    { kind: "mcp", sessionId: "session-z" },
  );
  const second = await runtime.execute(
    { type: "test.other", input: {}, control: { idempotencyKey: "same" } },
    { kind: "mcp", sessionId: "session-z" },
  );

  assert.equal(mutateCount, 1);
  assert.equal(otherCount, 1);
  assert.equal(first.data.id, "mutate");
  assert.equal(second.data.marker, "other");
}

{
  const runtime = createApplicationCommandRuntime<TestRegistry>({ initialRevision: 0 });
  const trace: string[] = [];
  let state = "before";
  let releaseFirst: (() => void) | null = null;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  runtime.register(
    "test.mutate",
    async () => {
      trace.push("first:start");
      await firstGate;
      state = "after";
      trace.push("first:end");
      return { changed: true, data: { id: "first" }, warnings: [] };
    },
    { mode: "mutation" },
  );
  runtime.register(
    "test.slow",
    async () => {
      trace.push("second:start");
      trace.push("second:end");
      return { changed: true, data: { id: "second" }, warnings: [] };
    },
    { mode: "mutation" },
  );
  runtime.register(
    "test.read",
    async () => ({ changed: false, data: { ok: state === "after" }, warnings: [] }),
    { mode: "read" },
  );

  const firstPromise = runtime.execute({ type: "test.mutate", input: {} }, { kind: "ui" });
  const readPromise = runtime.execute({ type: "test.read", input: {} }, { kind: "ui" });
  const secondPromise = runtime.execute({ type: "test.slow", input: {} }, { kind: "ui" });
  releaseFirst?.();

  const [first, readResult, second] = await Promise.all([firstPromise, readPromise, secondPromise]);

  assert.deepEqual(trace, ["first:start", "first:end", "second:start", "second:end"]);
  assert.equal(readResult.data.ok, true);
  assert.equal(readResult.projectRevision, 1);
  assert.equal(first.projectRevision, 1);
  assert.equal(second.projectRevision, 2);
}

{
  const runtime = createApplicationCommandRuntime<TestRegistry>({ initialRevision: 2 });
  runtime.register("test.read", async () => ({ changed: false, data: { ok: true }, warnings: [] }), {
    mode: "read",
  });

  const result = await runtime.execute({ type: "test.read", input: {} }, { kind: "ui" });
  assert.equal(result.projectRevision, 2);
}

{
  let revision = 5;
  const runtime = createApplicationCommandRuntime<TestRegistry>({
    initialRevision: 2,
    revision: {
      get: () => revision,
      set: (value) => {
        revision = value;
      },
    },
  });
  runtime.register("test.read", async () => ({ changed: false, data: { ok: true }, warnings: [] }), {
    mode: "read",
  });
  runtime.register("test.mutate", async () => ({ changed: true, data: { id: "m" }, warnings: [] }), {
    mode: "mutation",
  });

  const firstRead = await runtime.execute({ type: "test.read", input: {} }, { kind: "ui" });
  assert.equal(firstRead.projectRevision, 5);

  const changed = await runtime.execute(
    { type: "test.mutate", input: {}, control: { expectedProjectRevision: 5 } },
    { kind: "ui" },
  );
  assert.equal(changed.projectRevision, 6);
  assert.equal(revision, 6);

  revision = 0;
  const resetRead = await runtime.execute({ type: "test.read", input: {} }, { kind: "ui" });
  assert.equal(resetRead.projectRevision, 0);

  await assert.rejects(
    runtime.execute(
      { type: "test.mutate", input: {}, control: { expectedProjectRevision: 6 } },
      { kind: "ui" },
    ),
    (error: unknown) => error instanceof CommandExecutionError && error.code === "revision_conflict",
  );

  const afterResetChange = await runtime.execute(
    { type: "test.mutate", input: {}, control: { expectedProjectRevision: 0 } },
    { kind: "ui" },
  );
  assert.equal(afterResetChange.projectRevision, 1);
  assert.equal(revision, 1);
}

{
  let callCount = 0;
  const denyAllPolicy: CommandPolicy = {
    canExecute() {
      return { allowed: false, reason: "Denied" };
    },
  };
  const runtime = createApplicationCommandRuntime<TestRegistry>({
    initialRevision: 0,
    policy: denyAllPolicy,
  });

  runtime.register(
    "test.mutate",
    async () => {
      callCount += 1;
      return { changed: true, data: { id: "never" }, warnings: [] };
    },
    { mode: "mutation" },
  );

  await assert.rejects(
    runtime.execute({ type: "test.mutate", input: {} }, { kind: "ui" }),
    (error: unknown) => error instanceof CommandExecutionError && error.code === "user_denied",
  );
  assert.equal(callCount, 0);
}

{
  let resolvePolicy: ((decision: { allowed: boolean; reason?: string }) => void) | null = null;
  const asyncPolicy: CommandPolicy = {
    canExecute() {
      return new Promise((resolve) => {
        resolvePolicy = resolve;
      });
    },
  };
  const runtime = createApplicationCommandRuntime<TestRegistry>({
    initialRevision: 0,
    policy: asyncPolicy,
  });
  runtime.register(
    "test.mutate",
    async () => ({ changed: true, data: { id: "ok" }, warnings: [] }),
    { mode: "mutation" },
  );

  const pending = runtime.execute({ type: "test.mutate", input: {} }, { kind: "ui" }) as Promise<{
    requestId: string;
  }> & { requestId?: string };
  assert.match(pending.requestId ?? "", /^cmd-/, "Pending command promises must expose their runtime requestId immediately");

  const waiting = runtime.snapshot().find((entry) => entry.requestId === pending.requestId);
  assert.equal(waiting?.status, "queued");

  resolvePolicy?.({ allowed: true });
  const result = await pending;
  const done = runtime.snapshot().find((entry) => entry.requestId === result.requestId);
  assert.equal(done?.status, "succeeded");
}

{
  let resolvePolicy: ((decision: { allowed: boolean; reason?: string; requireConfirmation?: boolean }) => void) | null = null;
  const asyncPolicy: CommandPolicy = {
    canExecute() {
      return new Promise((resolve) => {
        resolvePolicy = resolve;
      });
    },
  };
  const runtime = createApplicationCommandRuntime<TestRegistry>({
    initialRevision: 0,
    policy: asyncPolicy,
  });
  runtime.register(
    "test.mutate",
    async () => ({ changed: true, data: { id: "confirmed" }, warnings: [] }),
    { mode: "mutation" },
  );

  const pending = runtime.execute({ type: "test.mutate", input: {} }, { kind: "ui" }) as Promise<{
    requestId: string;
  }> & { requestId?: string };
  const requestId = pending.requestId ?? "";
  assert.equal(runtime.snapshot().find((entry) => entry.requestId === requestId)?.status, "queued");

  resolvePolicy?.({ allowed: true, requireConfirmation: true, reason: "need-confirmation" });
  await waitForRequestStatus(runtime, requestId, "awaiting-confirmation");

  assert.equal(runtime.confirm(requestId, true), true);
  const result = await pending;
  assert.equal(result.requestId, requestId);
  assert.equal(runtime.snapshot().find((entry) => entry.requestId === requestId)?.status, "succeeded");
}

{
  let resolvePolicy: ((decision: {
    allowed: boolean;
    reason?: string;
    requireConfirmation?: boolean;
    trustedData?: Record<string, unknown>;
  }) => void) | null = null;
  let trustedExecution: unknown = null;
  const asyncPolicy: CommandPolicy = {
    canExecute() {
      return new Promise((resolve) => {
        resolvePolicy = resolve;
      });
    },
  };
  const runtime = createApplicationCommandRuntime<TestRegistry>({
    initialRevision: 0,
    policy: asyncPolicy,
  });
  runtime.register(
    "test.mutate",
    async (_input, context) => {
      trustedExecution = (context as typeof context & { trusted?: unknown }).trusted ?? null;
      return { changed: true, data: { id: "confirmed" }, warnings: [] };
    },
    { mode: "mutation", risk: "high" },
  );

  const pending = runtime.execute({ type: "test.mutate", input: {} }, { kind: "ui" }) as Promise<{
    requestId: string;
  }> & { requestId?: string };
  const requestId = pending.requestId ?? "";
  resolvePolicy?.({
    allowed: true,
    requireConfirmation: true,
    reason: "need-confirmation",
    trustedData: { targetStatus: "overwriteExisting" },
  });

  await waitForRequestStatus(runtime, requestId, "awaiting-confirmation");
  assert.equal(runtime.confirm(requestId, true), true);
  await pending;

  assert.deepEqual(trustedExecution, {
    requestId,
    policy: {
      confirmationGranted: true,
      requireConfirmation: true,
      reason: "need-confirmation",
      trustedData: { targetStatus: "overwriteExisting" },
    },
  });
}

{
  let resolvePolicy: ((decision: { allowed: boolean; reason?: string }) => void) | null = null;
  const asyncPolicy: CommandPolicy = {
    canExecute() {
      return new Promise((resolve) => {
        resolvePolicy = resolve;
      });
    },
  };
  const runtime = createApplicationCommandRuntime<TestRegistry>({
    initialRevision: 0,
    policy: asyncPolicy,
  });
  let handlerCalls = 0;
  runtime.register(
    "test.mutate",
    async () => {
      handlerCalls += 1;
      return { changed: true, data: { id: "nope" }, warnings: [] };
    },
    { mode: "mutation" },
  );

  const pending = runtime.execute({ type: "test.mutate", input: {} }, { kind: "ui" });
  const waiting = runtime.snapshot().find((entry) => entry.command === "test.mutate");
  assert.equal(waiting?.status, "queued");

  resolvePolicy?.({ allowed: false, reason: "denied" });
  await assert.rejects(
    pending,
    (error: unknown) => error instanceof CommandExecutionError && error.code === "user_denied",
  );
  assert.equal(handlerCalls, 0);
}

{
  let firstPolicyReject: ((error: unknown) => void) | null = null;
  let policyCalls = 0;
  const splitPolicy: CommandPolicy = {
    canExecute() {
      policyCalls += 1;
      if (policyCalls === 1) {
        return new Promise((_, reject) => {
          firstPolicyReject = reject;
        });
      }
      return { allowed: true };
    },
  };

  const runtime = createApplicationCommandRuntime<TestRegistry>({
    initialRevision: 0,
    policy: splitPolicy,
  });
  const unhandled: unknown[] = [];
  const onUnhandledRejection = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandledRejection);

  try {
    runtime.register(
      "test.mutate",
      async () => ({ changed: true, data: { id: "first" }, warnings: [] }),
      { mode: "mutation" },
    );
    runtime.register(
      "test.other",
      async () => ({ changed: true, data: { marker: "other" }, warnings: [] }),
      { mode: "mutation" },
    );

    const first = runtime.execute({ type: "test.mutate", input: {} }, { kind: "ui" });
    const firstOutcome = first.then(
      (value) => ({ ok: true as const, value }),
      (error) => ({ ok: false as const, error }),
    );
    const firstSnapshot = runtime.snapshot().find((entry) => entry.command === "test.mutate");
    assert.equal(firstSnapshot?.status, "queued");

    // Let the queued operation enter runRequest and block on policy awaiting.
    await Promise.resolve();

    const cancelled = runtime.cancel(firstSnapshot!.requestId);
    assert.equal(cancelled, true);

    const second = runtime.execute({ type: "test.other", input: {} }, { kind: "ui" });
    const secondResult = await Promise.race([
      second,
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("second command timed out after cancelling unresolved policy")), 75);
      }),
    ]);

    assert.equal(secondResult.command, "test.other");
    assert.equal(secondResult.projectRevision, 1);
    const cancelledOutcome = await firstOutcome;
    assert.equal(cancelledOutcome.ok, false);
    assert.ok(cancelledOutcome.error instanceof CommandExecutionError);
    assert.equal(cancelledOutcome.error.code, "cancelled");

    firstPolicyReject?.(new Error("late policy rejection"));
    await new Promise<void>((resolve) => {
      setTimeout(() => resolve(), 0);
    });
    assert.equal(unhandled.length, 0);
  } finally {
    process.off("unhandledRejection", onUnhandledRejection);
  }
}

{
  const runtime = createApplicationCommandRuntime<TestRegistry>({ initialRevision: 0 });
  await assert.rejects(
    runtime.execute({ type: "test.missing" as keyof TestRegistry, input: {} as Record<string, never> }, { kind: "ui" }),
    (error: unknown) => error instanceof CommandExecutionError && error.code === "invalid_input",
  );
}

{
  const runtime = createApplicationCommandRuntime<TestRegistry>({ initialRevision: 0 });
  runtime.register(
    "test.mutate",
    async () => {
      throw new Error("boom");
    },
    { mode: "mutation" },
  );

  await assert.rejects(
    runtime.execute({ type: "test.mutate", input: {} }, { kind: "ui" }),
    (error: unknown) => error instanceof CommandExecutionError && error.code === "execution_failed",
  );
}

{
  const runtime = createApplicationCommandRuntime<TestRegistry>({ initialRevision: 0 });
  let counter = 0;
  runtime.register(
    "test.mutate",
    async () => {
      counter += 1;
      return { changed: true, data: { id: String(counter) }, warnings: [] };
    },
    { mode: "mutation" },
  );

  const sessionAFirst = await runtime.execute(
    mutate({ idempotencyKey: "same" }),
    { kind: "mcp", sessionId: "a" },
  );
  const sessionADupe = await runtime.execute(
    mutate({ idempotencyKey: "same" }),
    { kind: "mcp", sessionId: "a" },
  );
  const sessionB = await runtime.execute(
    mutate({ idempotencyKey: "same" }),
    { kind: "mcp", sessionId: "b" },
  );

  assert.deepEqual(sessionADupe, sessionAFirst);
  assert.equal(sessionAFirst.data.id, "1");
  assert.equal(sessionB.data.id, "2");
}

{
  const runtime = createApplicationCommandRuntime<TestRegistry>({ initialRevision: 0 });
  let releaseFirst: (() => void) | null = null;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const started: string[] = [];

  runtime.register(
    "test.slow",
    async (_input, context) => {
      started.push("first");
      await firstGate;
      context.beginCommit();
      return { changed: true, data: { id: "first" }, warnings: [] };
    },
    { mode: "mutation" },
  );
  runtime.register(
    "test.mutate",
    async () => {
      started.push("second");
      return { changed: true, data: { id: "second" }, warnings: [] };
    },
    { mode: "mutation" },
  );

  const running = runtime.execute({ type: "test.slow", input: {} }, { kind: "ui" });
  const queued = runtime.execute({ type: "test.mutate", input: {} }, { kind: "ui" });
  const queuedRequestId = (await runtime.snapshot()).find((entry) => entry.command === "test.mutate")?.requestId;
  assert.ok(queuedRequestId);

  runtime.cancel(queuedRequestId!);
  releaseFirst?.();

  const runningResult = await running;
  assert.equal(runningResult.projectRevision, 1);
  await assert.rejects(
    queued,
    (error: unknown) => error instanceof CommandExecutionError && error.code === "cancelled",
  );
  assert.deepEqual(started, ["first"]);
}

{
  const runtime = createApplicationCommandRuntime<TestRegistry>({ initialRevision: 0 });
  let sawAbort = false;
  let releaseHandler: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    releaseHandler = resolve;
  });

  runtime.register(
    "test.slow",
    async (_input, context) => {
      context.signal.addEventListener("abort", () => {
        sawAbort = true;
      });
      await gate;
      if (context.signal.aborted) {
        throw new CommandExecutionError("cancelled", "Cancelled");
      }
      return { changed: true, data: { id: "done" }, warnings: [] };
    },
    { mode: "mutation" },
  );

  const running = runtime.execute({ type: "test.slow", input: {} }, { kind: "ui" });
  const requestId = (await runtime.snapshot()).find((entry) => entry.command === "test.slow")?.requestId;
  assert.ok(requestId);

  for (let attempt = 0; attempt < 25; attempt += 1) {
    const status = runtime.snapshot().find((entry) => entry.requestId === requestId)?.status;
    if (status === "running") {
      break;
    }
    await Promise.resolve();
  }

  runtime.cancel(requestId!);
  releaseHandler?.();

  await assert.rejects(
    running,
    (error: unknown) => error instanceof CommandExecutionError && error.code === "cancelled",
  );
  assert.equal(sawAbort, true);
}

{
  const runtime = createApplicationCommandRuntime<TestRegistry>({ initialRevision: 0 });
  let releaseHandler: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    releaseHandler = resolve;
  });
  let mutatedAfterCancel = false;

  runtime.register(
    "test.commit",
    async (_input, context) => {
      await gate;
      context.beginCommit();
      mutatedAfterCancel = true;
      return { changed: true, data: { committed: true }, warnings: [] };
    },
    { mode: "mutation" },
  );

  const running = runtime.execute({ type: "test.commit", input: {} }, { kind: "ui" });
  const requestId = runtime.snapshot().find((entry) => entry.command === "test.commit")?.requestId;
  assert.ok(requestId);

  for (let attempt = 0; attempt < 25; attempt += 1) {
    const status = runtime.snapshot().find((entry) => entry.requestId === requestId)?.status;
    if (status === "running") {
      break;
    }
    await Promise.resolve();
  }

  assert.equal(runtime.cancel(requestId!), true);
  releaseHandler?.();

  await assert.rejects(
    running,
    (error: unknown) => error instanceof CommandExecutionError && error.code === "cancelled",
  );
  assert.equal(mutatedAfterCancel, false);
  assert.equal(runtime.snapshot().find((entry) => entry.requestId === requestId)?.status, "cancelled");
}

{
  const runtime = createApplicationCommandRuntime<TestRegistry>({ initialRevision: 5 });
  let cancelInsideCommit = false;

  runtime.register(
    "test.commit",
    async (_input, context) => {
      context.beginCommit();
      cancelInsideCommit = runtime.cancel(context.requestId);
      return { changed: true, data: { committed: true }, warnings: [] };
    },
    { mode: "mutation" },
  );

  const result = await runtime.execute({ type: "test.commit", input: {} }, { kind: "ui" });
  assert.equal(cancelInsideCommit, false);
  assert.equal(result.projectRevision, 6);

  const state = (await runtime.snapshot()).find((entry) => entry.requestId === result.requestId);
  assert.equal(state?.status, "succeeded");
}

{
  const runtime = createApplicationCommandRuntime<TestRegistry>({ initialRevision: 0 });
  const statusEvents: Array<{ requestId: string; status: string; stage: string }> = [];
  let commitStatusWasObservedBeforeIrreversibleWork = false;

  runtime.register(
    "test.commit",
    async (_input, context) => {
      context.beginCommit();
      commitStatusWasObservedBeforeIrreversibleWork = statusEvents.some((event) => (
        event.requestId === context.requestId
        && event.status === "committing"
        && event.stage === "commit"
      ));
      return { changed: true, data: { committed: true }, warnings: [] };
    },
    { mode: "mutation" },
  );

  const result = await runtime.execute(
    { type: "test.commit", input: {} },
    { kind: "mcp", sessionId: "session-a" },
    {
      onStatusChange: (event) => {
        statusEvents.push(event);
      },
    } as never,
  );

  assert.equal(result.projectRevision, 1);
  assert.equal(commitStatusWasObservedBeforeIrreversibleWork, true);
  assert.deepEqual(statusEvents.filter((event) => event.status === "committing"), [{
    requestId: result.requestId,
    status: "committing",
    stage: "commit",
  }]);
}

{
  const runtime = createApplicationCommandRuntime<TestRegistry>({ initialRevision: 0 });
  runtime.register(
    "test.slow",
    async (_input, context) => {
      context.reportProgress({ stage: "queue", message: "Queued for execution", percent: 5 });
      context.reportProgress({ stage: "running", message: "Executing", percent: 40 });
      context.beginCommit();
      return { changed: true, data: { id: "done" }, warnings: [] };
    },
    { mode: "mutation" },
  );

  const pending = runtime.execute({ type: "test.slow", input: {} }, MCP_ACTOR);
  const result = await pending;
  const snapshot = runtime.snapshot().find((entry) => entry.requestId === result.requestId);

  assert.deepEqual(snapshot, {
    requestId: result.requestId,
    command: "test.slow",
    status: "succeeded",
    actor: { kind: "mcp", clientId: undefined },
    stage: "commit",
    message: "Executing",
    percent: 40,
  });
}

{
  const runtime = createApplicationCommandRuntime<TestRegistry>({ initialRevision: 0 });
  runtime.register(
    "test.read",
    async (_input, context) => {
      context.reportProgress({ stage: "running", message: "UI only", percent: 25 });
      return { changed: false, data: { ok: true }, warnings: [] };
    },
    { mode: "read" },
  );

  const result = await runtime.execute({ type: "test.read", input: {} }, { kind: "ui" });
  const snapshot = runtime.snapshot().find((entry) => entry.requestId === result.requestId);

  assert.deepEqual(snapshot, {
    requestId: result.requestId,
    command: "test.read",
    status: "succeeded",
    actor: { kind: "ui" },
    stage: "running",
    message: "UI only",
    percent: 25,
  });
}

{
  const runtime = createApplicationCommandRuntime<TestRegistry>({ initialRevision: 0 });
  runtime.register(
    "test.mutate",
    async () => ({ changed: true, data: { id: "ok" }, warnings: [] }),
    { mode: "mutation" },
  );
  runtime.register(
    "test.other",
    async () => {
      throw new CommandExecutionError("execution_failed", "planned failure");
    },
    { mode: "mutation" },
  );
  runtime.register(
    "test.slow",
    async (_input, context) => {
      if (context.signal.aborted) {
        throw new CommandExecutionError("cancelled", "cancelled");
      }
      return { changed: true, data: { id: "cancel" }, warnings: [] };
    },
    { mode: "mutation" },
  );

  for (let index = 0; index < 80; index += 1) {
    await runtime.execute({ type: "test.mutate", input: {} }, { kind: "ui" });
  }
  for (let index = 0; index < 20; index += 1) {
    await assert.rejects(
      runtime.execute({ type: "test.other", input: {} }, { kind: "ui" }),
      (error: unknown) => error instanceof CommandExecutionError && error.code === "execution_failed",
    );
  }
  for (let index = 0; index < 20; index += 1) {
    const controller = new AbortController();
    const pending = runtime.execute(
      { type: "test.slow", input: {} },
      { kind: "ui" },
      { signal: controller.signal },
    );
    controller.abort();
    await assert.rejects(
      pending,
      (error: unknown) => error instanceof CommandExecutionError && error.code === "cancelled",
    );
  }
  await runtime.execute({ type: "test.mutate", input: {} }, { kind: "ui" });
  await assert.rejects(
    runtime.execute({ type: "test.other", input: {} }, { kind: "ui" }),
    (error: unknown) => error instanceof CommandExecutionError && error.code === "execution_failed",
  );
  const controller = new AbortController();
  const pending = runtime.execute(
    { type: "test.slow", input: {} },
    { kind: "ui" },
    { signal: controller.signal },
  );
  controller.abort();
  await assert.rejects(
    pending,
    (error: unknown) => error instanceof CommandExecutionError && error.code === "cancelled",
  );

  const snapshot = runtime.snapshot();
  assert.ok(snapshot.length <= 32, `settled request observation must be bounded, got ${snapshot.length}`);
  assert.equal(snapshot.some((entry) => entry.status === "succeeded"), true);
  assert.equal(snapshot.some((entry) => entry.status === "failed"), true);
  assert.equal(snapshot.some((entry) => entry.status === "cancelled"), true);
}

console.log("application command runtime tests passed");