import assert from "node:assert/strict";
import test from "node:test";

import { TabulateTileScheduler } from "../src/components/tabulate/tabulateTileScheduler.ts";
import type { TabulateTileRequest } from "../src/components/tabulate/tabulateViewport.ts";
import type { TabulateWindowResult } from "../src/types/tabulate.ts";

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<Value>((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}
const tick = async () => { for (let turn = 0; turn < 12; turn += 1) await Promise.resolve(); };
const request = (requestId: string, rowStart = 20, columnStart = 20): TabulateTileRequest => ({
  requestId, rowStart, columnStart, rowCount: 2, columnCount: 2,
  sessionId: "session", fingerprint: "fingerprint", sourceGeneration: 7, statisticCount: 1,
});
function result(target: TabulateTileRequest): TabulateWindowResult {
  return { ...target, rowMemberCount: 100, columnMemberCount: 100,
    rowMembers: [[target.rowStart], [target.rowStart + 1]],
    columnMembers: [[target.columnStart], [target.columnStart + 1]],
    rowMemberBefore: [target.rowStart - 1], rowMemberAfter: [target.rowStart + 2],
    columnMemberBefore: [target.columnStart - 1], columnMemberAfter: [target.columnStart + 2],
    statistics: [{ id: "count", kind: "count", field: "" }], cells: [],
    rowTotalsReady: false, columnTotalsReady: false };
}
function harness() {
  const started: TabulateTileRequest[] = [];
  const cancelled: string[] = [];
  const results: string[] = [];
  const errors: string[] = [];
  const work = new Map<string, ReturnType<typeof deferred<TabulateWindowResult>>>();
  const cancellations = new Map<string, ReturnType<typeof deferred<void>>>();
  const scheduler = new TabulateTileScheduler({
    start: (target) => {
      started.push(target);
      const pending = deferred<TabulateWindowResult>();
      work.set(target.requestId, pending);
      return pending.promise;
    },
    cancelRequest: (requestId) => {
      cancelled.push(requestId);
      const pending = deferred<void>();
      cancellations.set(requestId, pending);
      return pending.promise;
    },
    onResult: (_value, target, priority) => results.push(`${priority}:${target.requestId}`),
    onError: (_error, target) => errors.push(target.requestId),
  });
  return { scheduler, started, cancelled, results, errors, work, cancellations };
}

test("pending foreground bursts drop obsolete work and coalesce duplicate keys", async () => {
  const state = harness();
  const first = request("first");
  assert.equal(state.scheduler.scheduleForeground(first), null);
  assert.equal(state.scheduler.scheduleForeground({ ...first, requestId: "duplicate" }), null);
  const latest = request("latest", 40);
  assert.equal(state.scheduler.scheduleForeground(latest)?.requestId, "first");
  await tick();
  assert.deepEqual(state.started.map((entry) => entry.requestId), ["latest"]);
  state.work.get("latest")!.resolve(result(latest));
  await tick();
  assert.deepEqual(state.results, ["foreground:latest"]);
});

test("active duplicates coalesce while changed counts or identity supersede", async () => {
  const state = harness();
  state.scheduler.scheduleForeground(request("first"));
  await tick();
  state.scheduler.scheduleForeground(request("duplicate"));
  await tick();
  assert.deepEqual(state.cancelled, []);
  assert.equal(state.started.length, 1);
  state.scheduler.scheduleForeground({ ...request("resize"), columnCount: 1 });
  assert.deepEqual(state.cancelled, ["first"]);
  state.cancellations.get("first")!.resolve();
  await tick();
  assert.equal(state.started[1].requestId, "resize");
  state.scheduler.cancel();
});

test("latest foreground cancels once, bounds pending work, and rejects late success and errors", async () => {
  const state = harness();
  state.scheduler.scheduleForeground(request("old"));
  await tick();
  state.scheduler.scheduleForeground(request("middle", 30));
  assert.equal(state.scheduler.scheduleForeground(request("latest", 40))?.requestId, "middle");
  await tick();
  assert.deepEqual(state.cancelled, ["old"]);
  assert.equal(state.started.length, 1);
  state.cancellations.get("old")!.resolve();
  await tick();
  state.work.get("latest")!.resolve(result(request("latest", 40)));
  state.work.get("old")!.resolve(result(request("old")));
  await tick();
  assert.deepEqual(state.results, ["foreground:latest"]);
  assert.deepEqual(state.errors, []);
  const staleError = harness();
  staleError.scheduler.scheduleForeground(request("old"));
  await tick();
  staleError.scheduler.scheduleForeground(request("new", 50));
  staleError.work.get("old")!.reject(new Error("late failure"));
  await tick();
  assert.deepEqual(staleError.errors, []);
  assert.deepEqual(staleError.started.map((entry) => entry.requestId), ["old", "new"]);
  staleError.cancellations.get("old")!.resolve();
  await tick();
  assert.equal(staleError.started.length, 2);
  staleError.scheduler.cancel();
});

test("prefetch admits only eight immediately adjacent tiles in the current identity", async () => {
  const state = harness();
  state.scheduler.scheduleForeground(request("center"));
  assert.equal(state.scheduler.prefetch(request("far", 24)), false);
  assert.equal(state.scheduler.prefetch(request("overlap", 21)), false);
  assert.equal(state.scheduler.prefetch({ ...request("stale", 22), fingerprint: "other" }), false);
  assert.equal(state.scheduler.prefetch({ ...request("wrong-size", 20, 22), rowCount: 1 }), false);
  for (const rowStart of [18, 20, 22]) {
    for (const columnStart of [18, 20, 22]) {
      if (rowStart === 20 && columnStart === 20) continue;
      assert.equal(state.scheduler.prefetch(request(`${rowStart}:${columnStart}`, rowStart, columnStart)), true);
    }
  }
  assert.equal(state.scheduler.pendingPrefetchCount, 8);
  assert.equal(state.scheduler.prefetch(request("duplicate", 18, 18)), true);
  assert.equal(state.scheduler.pendingPrefetchCount, 8);
  await tick();
  assert.deepEqual(state.started.map((entry) => entry.requestId), ["center"]);
  state.work.get("center")!.resolve(result(request("center")));
  await tick();
  for (let index = 1; index <= 8; index += 1) {
    const next = state.started[index];
    assert.ok(next);
    state.work.get(next.requestId)!.resolve(result(next));
    await tick();
  }
  assert.equal(state.started.length, 9);
  assert.equal(state.scheduler.pendingPrefetchCount, 0);
  assert.equal(state.results.filter((entry) => entry.startsWith("prefetch:")).length, 8);
});

test("running prefetch never delays foreground even while cancellation acknowledgement is pending", async () => {
  const state = harness();
  state.scheduler.scheduleForeground(request("center"));
  state.scheduler.prefetch(request("prefetch", 22));
  state.scheduler.prefetch(request("queued", 18));
  await tick();
  state.work.get("center")!.resolve(result(request("center")));
  await tick();
  assert.equal(state.started[1].requestId, "prefetch");
  state.scheduler.scheduleForeground(request("new", 50));
  await tick();
  assert.deepEqual(state.cancelled, ["prefetch"]);
  assert.deepEqual(state.started.map((entry) => entry.requestId), ["center", "prefetch", "new"]);
  assert.equal(state.scheduler.pendingPrefetchCount, 0);
  state.work.get("new")!.resolve(result(request("new", 50)));
  state.work.get("prefetch")!.resolve(result(request("prefetch", 22)));
  await tick();
  assert.deepEqual(state.results, ["foreground:center", "foreground:new"]);
});

test("queued prefetch promoted to foreground runs once and clears the old ring", async () => {
  const state = harness();
  state.scheduler.scheduleForeground(request("center"));
  state.scheduler.prefetch(request("queued", 22));
  await tick();
  state.scheduler.scheduleForeground(request("promoted", 22));
  state.cancellations.get("center")!.resolve();
  await tick();
  assert.deepEqual(state.started.map((entry) => entry.requestId), ["center", "promoted"]);
  assert.equal(state.scheduler.pendingPrefetchCount, 0);
  state.scheduler.cancel();
});

test("active prefetch promotion coalesces the transport and delivers as foreground", async () => {
  const state = harness();
  state.scheduler.scheduleForeground(request("center"));
  state.scheduler.prefetch(request("prefetch", 22));
  await tick();
  state.work.get("center")!.resolve(result(request("center")));
  await tick();
  state.scheduler.scheduleForeground(request("promoted", 22));
  await tick();
  assert.equal(state.started.length, 2);
  assert.deepEqual(state.cancelled, []);
  state.work.get("prefetch")!.resolve(result(request("prefetch", 22)));
  await tick();
  assert.deepEqual(state.results, ["foreground:center", "foreground:prefetch"]);
});

test("cancel drops pending work, cancels active once, and fences late completion", async () => {
  const state = harness();
  state.scheduler.scheduleForeground(request("never-start"));
  state.scheduler.cancel();
  await tick();
  assert.equal(state.started.length, 0);
  state.scheduler.scheduleForeground(request("active"));
  state.scheduler.prefetch(request("queued", 22));
  await tick();
  state.scheduler.cancel();
  state.scheduler.cancel();
  assert.deepEqual(state.cancelled, ["active"]);
  assert.equal(state.scheduler.pendingPrefetchCount, 0);
  state.work.get("active")!.resolve(result(request("active")));
  await tick();
  assert.deepEqual(state.results, []);
  state.scheduler.dispose();
  assert.throws(() => state.scheduler.scheduleForeground(request("disposed")), /disposed/);
});

test("identity changes reject stale responses even at identical coordinates", async () => {
  for (const patch of [{ sourceGeneration: 8 }, { fingerprint: "new" }, { sessionId: "new" }, { statisticCount: 2 }]) {
    const state = harness();
    state.scheduler.scheduleForeground(request("old"));
    await tick();
    state.scheduler.scheduleForeground({ ...request("new"), ...patch });
    state.work.get("old")!.resolve(result(request("old")));
    await tick();
    assert.deepEqual(state.results, []);
    assert.deepEqual(state.cancelled, ["old"]);
    assert.equal(state.started[1].requestId, "new");
    state.scheduler.cancel();
  }
});

test("malformed current responses and transport failures reach onError, never onResult", async () => {
  const state = harness();
  state.scheduler.scheduleForeground(request("invalid"));
  await tick();
  state.work.get("invalid")!.resolve({ ...result(request("invalid")), fingerprint: "wrong" });
  await tick();
  assert.deepEqual(state.errors, ["invalid"]);
  assert.deepEqual(state.results, []);
  state.scheduler.scheduleForeground(request("failed", 40));
  await tick();
  state.work.get("failed")!.reject(new Error("transport"));
  await tick();
  assert.deepEqual(state.errors, ["invalid", "failed"]);
});

test("failed cancellation keeps transport concurrency bounded until old work settles", async () => {
  const state = harness();
  state.scheduler.scheduleForeground(request("old"));
  await tick();
  for (let index = 0; index < 100; index += 1) {
    state.scheduler.scheduleForeground(request(`new-${index}`, 30 + index));
  }
  state.cancellations.get("old")!.reject(new Error("cancel failed"));
  await tick();
  assert.equal(state.started.length, 1);
  assert.deepEqual(state.cancelled, ["old"]);
  state.work.get("old")!.reject(new Error("cancelled"));
  await tick();
  assert.deepEqual(state.started.map((entry) => entry.requestId), ["old", "new-99"]);
  assert.deepEqual(state.errors, []);
  state.scheduler.cancel();
});

test("one ring cannot be widened by oversized adjacent candidates; short edge tiles remain valid", () => {
  const state = harness();
  state.scheduler.scheduleForeground(request("center"));
  assert.equal(state.scheduler.prefetch({ ...request("wide", 20, 22), columnCount: 64 }), false);
  assert.equal(state.scheduler.prefetch({ ...request("tall", 22), rowCount: 128 }), false);
  assert.equal(state.scheduler.prefetch({ ...request("far-back", 0), rowCount: 20 }), false);
  assert.equal(state.scheduler.prefetch({ ...request("edge", 22), rowCount: 1 }), true);
  assert.equal(state.scheduler.pendingPrefetchCount, 1);
  state.scheduler.cancel();
});

test("request IDs cannot alias different outstanding tiles or cross foreground/prefetch lanes", async () => {
  const state = harness();
  state.scheduler.scheduleForeground(request("same-id"));
  assert.throws(() => state.scheduler.prefetch(request("same-id", 22)), /request ID/);
  await tick();
  assert.throws(() => state.scheduler.scheduleForeground(request("same-id", 30)), /request ID/);
  assert.deepEqual(state.cancelled, []);
  state.scheduler.scheduleForeground(request("replacement", 40));
  assert.throws(() => state.scheduler.scheduleForeground(request("same-id", 50)), /request ID/);
  state.work.get("same-id")!.resolve(result(request("same-id")));
  await tick();
  assert.equal(state.started[1].requestId, "replacement");
  state.scheduler.cancel();
});