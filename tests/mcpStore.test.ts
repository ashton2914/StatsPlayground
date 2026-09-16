import assert from "node:assert/strict";

import {
  createMcpStore,
  type McpManagementServiceLike,
} from "../src/stores/useMcpStore.ts";
import type {
  McpAuditEntry,
  McpAuthorizedRootGrant,
  McpCommandRequestSummary,
  McpServerStatus,
} from "../src/types/mcp.ts";

function makeStatus(overrides: Partial<McpServerStatus> = {}): McpServerStatus {
  return {
    state: "stopped",
    endpoint: null,
    token: null,
    activeConnections: 0,
    queuedRequests: 0,
    runningRequests: 0,
    ...overrides,
  };
}

function makeAuditEntry(overrides: Partial<McpAuditEntry> = {}): McpAuditEntry {
  return {
    requestId: "mcp-1",
    timestamp: "2026-09-16T00:00:00.000Z",
    tool: "statsplayground.project.inspect",
    status: "queued",
    durationMs: null,
    errorCode: null,
    ...overrides,
  };
}

function makeRequest(overrides: Partial<McpCommandRequestSummary> = {}): McpCommandRequestSummary {
  return {
    requestId: "cmd-1",
    command: "table.exportCsv",
    status: "queued",
    stage: "queue",
    message: null,
    percent: null,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createTimerHarness() {
  let nextId = 1;
  const intervals = new Map<number, () => void>();
  return {
    setInterval(callback: () => void) {
      const id = nextId;
      nextId += 1;
      intervals.set(id, callback);
      return id;
    },
    clearInterval(id: number) {
      intervals.delete(id);
    },
    tick(id: number) {
      intervals.get(id)?.();
    },
    tickAll() {
      for (const callback of [...intervals.values()]) {
        callback();
      }
    },
    count() {
      return intervals.size;
    },
  };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

function createStorageSpy() {
  const calls: string[] = [];
  return {
    storage: {
      getItem(key: string) {
        calls.push(`get:${key}`);
        return null;
      },
      setItem(key: string, value: string) {
        calls.push(`set:${key}:${value}`);
      },
      removeItem(key: string) {
        calls.push(`remove:${key}`);
      },
      clear() {
        calls.push("clear");
      },
      key() {
        calls.push("key");
        return null;
      },
      get length() {
        return 0;
      },
    },
    calls,
  };
}

function installStorageSpies() {
  const local = createStorageSpy();
  const session = createStorageSpy();
  Object.defineProperty(globalThis, "localStorage", {
    value: local.storage,
    configurable: true,
  });
  Object.defineProperty(globalThis, "sessionStorage", {
    value: session.storage,
    configurable: true,
  });
  return {
    local,
    session,
    restore() {
      delete (globalThis as Record<string, unknown>).localStorage;
      delete (globalThis as Record<string, unknown>).sessionStorage;
    },
  };
}

function createService(overrides: Partial<McpManagementServiceLike> = {}): McpManagementServiceLike {
  return {
    startServer: async () => makeStatus({
      state: "running",
      endpoint: "http://127.0.0.1:48123/mcp",
      token: "token-started",
      activeConnections: 1,
    }),
    stopServer: async () => undefined,
    getServerStatus: async () => makeStatus(),
    listAuditEntries: async () => [],
    authorizeOutputRoot: async () => ({ rootId: "root-1", displayName: "Exports" }),
    revokeOutputRoot: async () => undefined,
    listCommandRequests: () => [],
    confirmCommandRequest: () => false,
    cancelCommandRequest: () => false,
    ...overrides,
  };
}

{
  const storage = installStorageSpies();
  const timer = createTimerHarness();
  const store = createMcpStore({
    service: createService(),
    setInterval: timer.setInterval,
    clearInterval: timer.clearInterval,
  });

  assert.deepEqual(store.getState().status, makeStatus());
  assert.deepEqual(store.getState().auditEntries, []);
  assert.deepEqual(store.getState().authorizedRoots, []);
  assert.deepEqual(store.getState().commandRequests, []);
  assert.equal(store.getState().pendingConfirmations.length, 0);
  assert.equal(storage.local.calls.length, 0);
  assert.equal(storage.session.calls.length, 0);
  storage.restore();
}

{
  const storage = installStorageSpies();
  const timer = createTimerHarness();
  const start = deferred<McpServerStatus>();
  const store = createMcpStore({
    service: createService({
      startServer: async () => start.promise,
    }),
    setInterval: timer.setInterval,
    clearInterval: timer.clearInterval,
  });

  const startPromise = store.getState().startServer();
  assert.equal(store.getState().status.state, "starting");

  start.resolve(makeStatus({
    state: "running",
    endpoint: "http://127.0.0.1:49200/mcp",
    token: "fresh-token",
    activeConnections: 2,
  }));
  await startPromise;

  assert.deepEqual(store.getState().status, makeStatus({
    state: "running",
    endpoint: "http://127.0.0.1:49200/mcp",
    token: "fresh-token",
    activeConnections: 2,
  }));
  assert.equal(storage.local.calls.length, 0);
  assert.equal(storage.session.calls.length, 0);
  storage.restore();
}

{
  const timer = createTimerHarness();
  const store = createMcpStore({
    service: createService({
      startServer: async () => {
        throw new Error("bind failed");
      },
    }),
    setInterval: timer.setInterval,
    clearInterval: timer.clearInterval,
  });

  await assert.rejects(store.getState().startServer(), /bind failed/);
  assert.deepEqual(store.getState().status, makeStatus());
  assert.match(store.getState().lastError ?? "", /bind failed/);
}

{
  const timer = createTimerHarness();
  const runningStatus = makeStatus({
    state: "running",
    endpoint: "http://127.0.0.1:48123/mcp",
    token: "running-token",
    activeConnections: 3,
    queuedRequests: 2,
    runningRequests: 1,
  });
  const store = createMcpStore({
    service: createService(),
    setInterval: timer.setInterval,
    clearInterval: timer.clearInterval,
  });
  store.setState({
    status: runningStatus,
    auditEntries: [makeAuditEntry()],
    commandRequests: [makeRequest({ status: "awaiting-confirmation" })],
    pendingConfirmations: [makeRequest({ status: "awaiting-confirmation" })],
    authorizedRoots: [{ rootId: "root-1", displayName: "Exports" }],
  });

  await store.getState().stopServer();

  assert.deepEqual(store.getState().status, makeStatus());
  assert.deepEqual(store.getState().auditEntries, []);
  assert.deepEqual(store.getState().commandRequests, []);
  assert.deepEqual(store.getState().pendingConfirmations, []);
  assert.deepEqual(store.getState().authorizedRoots, []);
}

{
  const timer = createTimerHarness();
  const grants: McpAuthorizedRootGrant[] = [];
  const store = createMcpStore({
    service: createService({
      authorizeOutputRoot: async (rootPath: string) => {
        const granted = { rootId: `root-${grants.length + 1}`, displayName: rootPath };
        grants.push(granted);
        return granted;
      },
      revokeOutputRoot: async (rootId: string) => {
        const index = grants.findIndex((grant) => grant.rootId === rootId);
        if (index >= 0) grants.splice(index, 1);
      },
    }),
    setInterval: timer.setInterval,
    clearInterval: timer.clearInterval,
  });

  await store.getState().authorizeRoot("/Users/ashton/Exports");
  await store.getState().authorizeRoot("/Users/ashton/Snapshots");
  assert.deepEqual(store.getState().authorizedRoots, [
    { rootId: "root-1", displayName: "/Users/ashton/Exports" },
    { rootId: "root-2", displayName: "/Users/ashton/Snapshots" },
  ]);

  await store.getState().revokeRoot("root-1");
  assert.deepEqual(store.getState().authorizedRoots, [
    { rootId: "root-2", displayName: "/Users/ashton/Snapshots" },
  ]);
}

{
  const timer = createTimerHarness();
  const confirmations: Array<{ requestId: string; allow: boolean }> = [];
  const pending = [
    makeRequest({ requestId: "cmd-allow", status: "awaiting-confirmation" }),
    makeRequest({ requestId: "cmd-deny", status: "awaiting-confirmation" }),
  ];
  const store = createMcpStore({
    service: createService({
      getServerStatus: async () => makeStatus({
        state: "running",
        endpoint: "http://127.0.0.1:48123/mcp",
        token: "token-confirm",
      }),
      listCommandRequests: () => pending,
      confirmCommandRequest: (requestId: string, allow: boolean) => {
        confirmations.push({ requestId, allow });
        return true;
      },
    }),
    setInterval: timer.setInterval,
    clearInterval: timer.clearInterval,
  });

  await store.getState().refresh();
  assert.deepEqual(store.getState().pendingConfirmations.map((entry) => entry.requestId), ["cmd-allow", "cmd-deny"]);

  assert.equal(await store.getState().allowRequest("cmd-allow"), true);
  assert.equal(await store.getState().denyRequest("cmd-deny"), true);
  assert.deepEqual(confirmations, [
    { requestId: "cmd-allow", allow: true },
    { requestId: "cmd-deny", allow: false },
  ]);
  assert.deepEqual(store.getState().pendingConfirmations, []);
}

{
  const timer = createTimerHarness();
  let statusCallCount = 0;
  let requestCallCount = 0;
  const store = createMcpStore({
    service: createService({
      getServerStatus: async () => {
        statusCallCount += 1;
        return makeStatus({
          state: "running",
          endpoint: "http://127.0.0.1:48123/mcp",
          token: "token-progress",
          queuedRequests: statusCallCount === 1 ? 1 : 0,
          runningRequests: statusCallCount === 1 ? 0 : 1,
        });
      },
      listAuditEntries: async () => [makeAuditEntry({ status: statusCallCount === 1 ? "queued" : "running" })],
      listCommandRequests: () => {
        requestCallCount += 1;
        return [makeRequest({
          status: requestCallCount === 1 ? "queued" : "running",
          stage: requestCallCount === 1 ? "queue" : "running",
          message: requestCallCount === 1 ? "Queued for export" : "Exporting rows",
          percent: requestCallCount === 1 ? 0 : 42,
        })];
      },
    }),
    setInterval: timer.setInterval,
    clearInterval: timer.clearInterval,
    refreshIntervalMs: 500,
  });

  store.getState().setViewVisible(true);
  await flushMicrotasks();
  assert.equal(timer.count(), 1);
  assert.equal(store.getState().status.queuedRequests, 1);
  assert.deepEqual(store.getState().commandRequests.map((entry) => entry.status), ["queued"]);
  assert.deepEqual(store.getState().commandRequests.map((entry) => entry.stage), ["queue"]);
  assert.deepEqual(store.getState().commandRequests.map((entry) => entry.message), ["Queued for export"]);
  assert.deepEqual(store.getState().commandRequests.map((entry) => entry.percent), [0]);

  timer.tickAll();
  await flushMicrotasks();
  assert.equal(store.getState().status.runningRequests, 1);
  assert.deepEqual(store.getState().commandRequests.map((entry) => entry.status), ["running"]);
  assert.deepEqual(store.getState().commandRequests.map((entry) => entry.stage), ["running"]);
  assert.deepEqual(store.getState().commandRequests.map((entry) => entry.message), ["Exporting rows"]);
  assert.deepEqual(store.getState().commandRequests.map((entry) => entry.percent), [42]);

  store.getState().setViewVisible(false);
  assert.equal(timer.count(), 0);
}

{
  const timer = createTimerHarness();
  const store = createMcpStore({
    service: createService({
      getServerStatus: async () => makeStatus({ state: "stopped" }),
      listAuditEntries: async () => [makeAuditEntry()],
      listCommandRequests: () => [makeRequest({ status: "awaiting-confirmation" })],
    }),
    setInterval: timer.setInterval,
    clearInterval: timer.clearInterval,
  });

  store.setState({
    status: makeStatus({ state: "running", token: "secret" }),
    auditEntries: [makeAuditEntry()],
    commandRequests: [makeRequest({ status: "awaiting-confirmation" })],
    pendingConfirmations: [makeRequest({ status: "awaiting-confirmation" })],
    authorizedRoots: [{ rootId: "root-1", displayName: "/Users/ashton/Exports" }],
  });

  await store.getState().refresh();

  assert.deepEqual(store.getState().status, makeStatus({ state: "stopped" }));
  assert.deepEqual(store.getState().auditEntries, []);
  assert.deepEqual(store.getState().commandRequests, []);
  assert.deepEqual(store.getState().pendingConfirmations, []);
  assert.deepEqual(store.getState().authorizedRoots, []);
}

{
  const timer = createTimerHarness();
  const uiOnly = makeRequest({
    requestId: "ui-1",
    status: "awaiting-confirmation",
    stage: "confirmation",
    message: "Overwrite existing file?",
    percent: null,
  });
  const mcpVisible = makeRequest({
    requestId: "mcp-1",
    status: "running",
    stage: "running",
    message: "Exporting rows",
    percent: 64,
  });
  const store = createMcpStore({
    service: createService({
      getServerStatus: async () => makeStatus({
        state: "running",
        endpoint: "http://127.0.0.1:48123/mcp",
        token: "token-filtered",
      }),
      listCommandRequests: () => [mcpVisible],
    }),
    setInterval: timer.setInterval,
    clearInterval: timer.clearInterval,
  });

  store.setState({
    commandRequests: [uiOnly],
    pendingConfirmations: [uiOnly],
  });
  await store.getState().refresh();

  assert.deepEqual(store.getState().commandRequests, [mcpVisible]);
  assert.deepEqual(store.getState().pendingConfirmations, []);
}

console.log("mcp store behavior tests passed");