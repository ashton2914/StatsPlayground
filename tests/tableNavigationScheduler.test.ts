import assert from "node:assert/strict";

import type { TableNavigationRequest, TableNavigationResult } from "../src/types/data.ts";
import {
  TableNavigationScheduler,
  type TableNavigationSchedulerClock,
} from "../src/utils/tableNavigationScheduler.ts";

class FakeClock implements TableNavigationSchedulerClock {
  private nowMs = 0;
  private nextHandle = 1;
  private timers = new Map<number, { dueAt: number; callback: () => void }>();

  now(): number {
    return this.nowMs;
  }

  setTimeout(callback: () => void, delayMs: number): number {
    const handle = this.nextHandle++;
    this.timers.set(handle, {
      dueAt: this.nowMs + Math.max(0, delayMs),
      callback,
    });
    return handle;
  }

  clearTimeout(handle: number): void {
    this.timers.delete(handle);
  }

  async advanceBy(delayMs: number): Promise<void> {
    const target = this.nowMs + delayMs;
    while (true) {
      let next: { handle: number; dueAt: number; callback: () => void } | null = null;
      for (const [handle, timer] of this.timers.entries()) {
        if (timer.dueAt > target) continue;
        if (next == null || timer.dueAt < next.dueAt || (timer.dueAt === next.dueAt && handle < next.handle)) {
          next = { handle, dueAt: timer.dueAt, callback: timer.callback };
        }
      }
      if (!next) break;
      this.nowMs = next.dueAt;
      this.timers.delete(next.handle);
      next.callback();
      await Promise.resolve();
    }
    this.nowMs = target;
    await Promise.resolve();
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

function makeRequest(requestId: string, start: number, generation = 1): TableNavigationRequest {
  return {
    version: 1,
    requestId,
    datasetId: "dataset-a",
    generation,
    start,
    count: 40,
    columnIds: ["col-a"],
    sort: null,
    filters: [],
    sessionId: "session-a",
  };
}

function makeResult(request: TableNavigationRequest): TableNavigationResult {
  return {
    version: 1,
    requestId: request.requestId,
    datasetId: request.datasetId,
    generation: request.generation,
    start: request.start,
    totalRows: 10_000_000,
    totalRowsExact: true,
    sessionId: request.sessionId,
    columns: ["_row_id", "value"],
    columnTypes: ["BIGINT", "VARCHAR"],
    rows: [[request.start + 1, `row-${request.start + 1}`]],
    timings: { totalMs: 1 },
  };
}

async function run() {
  await testReturnsSupersededPendingRequestBeforeStart();
  await testSettlesToLatestDragTarget();
  await testFlushStartsImmediatelyOnRelease();
  await testCancelsObsoleteActiveRequestWithoutSurfacingCancelledError();
  await testDiscardsActiveRequestWhenCancellationRejectsBeforeAcknowledgement();
  await testStartsLatestRequestAfterCancellationAcknowledgement();
  await testGenerationChangeCancelsActiveAndPendingWork();
  console.log("table navigation scheduler contract passed (7 tests)");
}

async function testReturnsSupersededPendingRequestBeforeStart() {
  const clock = new FakeClock();
  const started: string[] = [];
  const scheduler = new TableNavigationScheduler<TableNavigationRequest, TableNavigationResult>({
    settleMs: 75,
    clock,
    start: async (request) => {
      started.push(request.requestId);
      return makeResult(request);
    },
    cancel: async () => {},
    onResult: () => {},
    onError: (error) => {
      throw error;
    },
  });

  const droppedFirst = scheduler.schedule(makeRequest("req-a", 100));
  assert.equal(droppedFirst, null);

  const droppedSecond = scheduler.schedule(makeRequest("req-b", 200));
  assert.equal(droppedSecond?.requestId, "req-a", "replacing a pending request must report the dropped request");

  await clock.advanceBy(75);
  assert.deepEqual(started, ["req-b"], "only the latest pending request should start after replacement");
}

async function testSettlesToLatestDragTarget() {
  const clock = new FakeClock();
  const started: string[] = [];
  const scheduler = new TableNavigationScheduler<TableNavigationRequest, TableNavigationResult>({
    settleMs: 75,
    clock,
    start: async (request) => {
      started.push(request.requestId);
      return makeResult(request);
    },
    cancel: async () => {},
    onResult: () => {},
    onError: (error) => {
      throw error;
    },
  });

  for (let index = 0; index < 100; index += 1) {
    scheduler.schedule(makeRequest(`drag-${index}`, index));
  }

  await clock.advanceBy(74);
  assert.deepEqual(started, [], "drag updates must not issue a request before the 75 ms settle threshold");

  await clock.advanceBy(1);
  assert.deepEqual(started, ["drag-99"], "only the latest drag target should start after settling");
}

async function testFlushStartsImmediatelyOnRelease() {
  const clock = new FakeClock();
  const started: string[] = [];
  const scheduler = new TableNavigationScheduler<TableNavigationRequest, TableNavigationResult>({
    settleMs: 75,
    clock,
    start: async (request) => {
      started.push(request.requestId);
      return makeResult(request);
    },
    cancel: async () => {},
    onResult: () => {},
    onError: (error) => {
      throw error;
    },
  });

  scheduler.schedule(makeRequest("drag-early", 12));
  await clock.advanceBy(10);
  scheduler.flush();
  await Promise.resolve();

  assert.deepEqual(started, ["drag-early"], "pointer release must flush the latest target immediately");
}

async function testCancelsObsoleteActiveRequestWithoutSurfacingCancelledError() {
  const clock = new FakeClock();
  const started: string[] = [];
  const cancelled: string[] = [];
  const surfacedErrors: string[] = [];
  const firstRequest = deferred<TableNavigationResult>();
  const secondRequest = deferred<TableNavigationResult>();
  const scheduler = new TableNavigationScheduler<TableNavigationRequest, TableNavigationResult>({
    settleMs: 75,
    clock,
    start: (request) => {
      started.push(request.requestId);
      if (request.requestId === "req-1") return firstRequest.promise;
      if (request.requestId === "req-3") return secondRequest.promise;
      throw new Error(`unexpected request ${request.requestId}`);
    },
    cancel: async (requestId) => {
      cancelled.push(requestId);
    },
    isCancelledError: (error) => error instanceof Error && error.message === "cancelled",
    onResult: () => {},
    onError: (error) => {
      surfacedErrors.push(String(error));
    },
  });

  scheduler.schedule(makeRequest("req-1", 100));
  await clock.advanceBy(75);
  assert.deepEqual(started, ["req-1"]);

  scheduler.schedule(makeRequest("req-2", 200));
  scheduler.schedule(makeRequest("req-3", 300));
  scheduler.flush();
  await Promise.resolve();
  assert.deepEqual(cancelled, ["req-1"], "a newer target must cancel the obsolete active request");

  firstRequest.reject(new Error("cancelled"));
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(started, ["req-1", "req-3"], "the scheduler must keep only one latest pending target while the active request cancels");

  secondRequest.resolve(makeResult(makeRequest("req-3", 300)));
  await Promise.resolve();
  assert.deepEqual(surfacedErrors, [], "cancelled requests must not surface as user-facing errors");
}

async function testDiscardsActiveRequestWhenCancellationRejectsBeforeAcknowledgement() {
  const clock = new FakeClock();
  const obsoleteRequest = deferred<TableNavigationResult>();
  const cancellationAcknowledgement = deferred<void>();
  const discarded: string[] = [];
  const scheduler = new TableNavigationScheduler<TableNavigationRequest, TableNavigationResult>({
    settleMs: 75,
    clock,
    start: (request) => request.requestId === "req-obsolete"
      ? obsoleteRequest.promise
      : Promise.resolve(makeResult(request)),
    cancel: () => cancellationAcknowledgement.promise,
    isCancelledError: (error) => error instanceof Error && error.message === "cancelled",
    onDiscarded: (request) => {
      discarded.push(request.requestId);
    },
    onResult: () => {},
    onError: (error) => {
      throw error;
    },
  });

  scheduler.schedule(makeRequest("req-obsolete", 100));
  await clock.advanceBy(75);
  scheduler.schedule(makeRequest("req-latest", 900));

  obsoleteRequest.reject(new Error("cancelled"));
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(discarded, ["req-obsolete"], "a cancelled active request must be discarded when its rejection arrives first");

  cancellationAcknowledgement.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(discarded, ["req-obsolete"], "cancellation acknowledgement must not discard the same request twice");
}

async function testStartsLatestRequestAfterCancellationAcknowledgement() {
  const clock = new FakeClock();
  const started: string[] = [];
  const obsoleteRequest = deferred<TableNavigationResult>();
  const scheduler = new TableNavigationScheduler<TableNavigationRequest, TableNavigationResult>({
    settleMs: 75,
    clock,
    start: (request) => {
      started.push(request.requestId);
      if (request.requestId === "req-obsolete") return obsoleteRequest.promise;
      return Promise.resolve(makeResult(request));
    },
    cancel: async () => {},
    onResult: () => {},
    onError: (error) => {
      throw error;
    },
  });

  scheduler.schedule(makeRequest("req-obsolete", 100));
  await clock.advanceBy(75);
  scheduler.schedule(makeRequest("req-latest", 900));
  scheduler.flush();
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(
    started,
    ["req-obsolete", "req-latest"],
    "an acknowledged cancellation must not let an unresolved obsolete request block the latest target",
  );
}

async function testGenerationChangeCancelsActiveAndPendingWork() {
  const clock = new FakeClock();
  const started: string[] = [];
  const cancelled: string[] = [];
  const activeRequest = deferred<TableNavigationResult>();
  const scheduler = new TableNavigationScheduler<TableNavigationRequest, TableNavigationResult>({
    settleMs: 75,
    clock,
    start: (request) => {
      started.push(request.requestId);
      if (request.requestId === "gen-1") return activeRequest.promise;
      throw new Error(`unexpected request ${request.requestId}`);
    },
    cancel: async (requestId) => {
      cancelled.push(requestId);
    },
    isCancelledError: (error) => error instanceof Error && error.message === "cancelled",
    onResult: () => {},
    onError: (error) => {
      throw error;
    },
  });

  scheduler.schedule(makeRequest("gen-1", 10, 1));
  await clock.advanceBy(75);
  scheduler.schedule(makeRequest("gen-2", 20, 1));

  const droppedPending = await scheduler.invalidate({ datasetId: "dataset-a", generation: 2 });
  assert.deepEqual(cancelled, ["gen-1"], "generation changes must cancel active work and drop pending work");
  assert.equal(droppedPending?.requestId, "gen-2", "generation invalidation must report the dropped pending request");

  activeRequest.reject(new Error("cancelled"));
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(started, ["gen-1"], "pending work from the stale generation must never start after invalidation");
}

void run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});