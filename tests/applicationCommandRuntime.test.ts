import assert from "node:assert/strict";

import {
  CommandExecutionError,
  createApplicationCommandRuntime,
  type ApplicationCommand,
  type CommandActor,
} from "@/applicationCommands/runtime";
import type { CommandPolicy } from "@/applicationCommands/policy";

type TestRegistry = {
  "test.mutate": { input: Record<string, never>; data: { id: string } };
  "test.read": { input: Record<string, never>; data: { ok: true } };
  "test.slow": { input: Record<string, never>; data: { id: string } };
  "test.commit": { input: Record<string, never>; data: { committed: true } };
};

const MCP_ACTOR: CommandActor = { kind: "mcp", sessionId: "session-a" };

function mutate(control?: ApplicationCommand<TestRegistry, "test.mutate">["control"]): ApplicationCommand<TestRegistry, "test.mutate"> {
  return {
    type: "test.mutate",
    input: {},
    control,
  };
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
  const trace: string[] = [];
  let releaseFirst: (() => void) | null = null;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  runtime.register(
    "test.mutate",
    async () => {
      trace.push("first:start");
      await firstGate;
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

  const firstPromise = runtime.execute({ type: "test.mutate", input: {} }, { kind: "ui" });
  const secondPromise = runtime.execute({ type: "test.slow", input: {} }, { kind: "ui" });
  releaseFirst?.();

  const [first, second] = await Promise.all([firstPromise, secondPromise]);

  assert.deepEqual(trace, ["first:start", "first:end", "second:start", "second:end"]);
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
    (error: unknown) => error instanceof CommandExecutionError && error.code === "policy_denied",
  );
  assert.equal(callCount, 0);
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

  runtime.cancel(requestId!);
  releaseHandler?.();

  await assert.rejects(
    running,
    (error: unknown) => error instanceof CommandExecutionError && error.code === "cancelled",
  );
  assert.equal(sawAbort, true);
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

console.log("application command runtime tests passed");