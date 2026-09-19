import { useEffect, useRef, useState } from "react";

import { tabulateService } from "@/services/tabulateService";
import type { TabulateItem, TabulateSessionRequest, TabulateSessionStatus, TabulateTotalsKind, TabulateTotalsResult, TabulateWindowResult } from "@/types/tabulate";

import { TabulateTileCache, tabulateTileKey } from "./tabulateTileCache";
import { TabulateTileScheduler } from "./tabulateTileScheduler";
import { calculateTabulateWindow } from "./tabulateViewport";
import type { TabulateTileRequest, TabulateWindowRange } from "./tabulateViewport";

type Phase = "idle" | "preparing" | "loading" | "ready" | "cancelled" | "error";
type Totals = Partial<Record<TabulateTotalsKind["kind"], TabulateTotalsResult>>;
export type TabulateSessionRuntime = Pick<typeof tabulateService, "prepare" | "getStatus" | "queryWindow" | "queryTotals" | "cancelRequest" | "release">;
interface Snapshot {
  key: string;
  windowKey: string;
  status: TabulateSessionStatus | null;
  tile: TabulateWindowResult | null;
  totals: Totals;
  loadingTotals: boolean;
  phase: Phase;
  errorKey: string | null;
}
interface Runtime {
  service: TabulateSessionRuntime;
  epoch: number;
  disposed: boolean;
  cancelled: boolean;
  failed: boolean;
  cache: TabulateTileCache;
  scheduler: TabulateTileScheduler;
  desired: string | null;
  totalsEpoch: number;
  totalsIds: Map<string, { cancelling: boolean }>;
  pendingTotals: Array<() => void>;
  pumpTotals: () => void;
  cancelPreparation: () => void;
  fail: (reason: unknown) => void;
}

function cancelTotals(runtime: Runtime): void {
  runtime.pendingTotals = [];
  for (const [requestId, active] of runtime.totalsIds) {
    if (active.cancelling) continue;
    active.cancelling = true;
    void runtime.service.cancelRequest(requestId).then(() => {
      runtime.totalsIds.delete(requestId);
      runtime.pumpTotals();
    }).catch(() => {});
  }
}

function failureKey(reason: unknown): string {
  const message = String(reason);
  if (/cancel/i.test(message)) return "cancelled";
  if (/stale|generation|source_changed/i.test(message)) return "staleSource";
  if (/budget|memory|resource/i.test(message)) return "memberIndexBudget";
  if (/timeout|timed.out/i.test(message)) return "queryTimeout";
  if (/expired|unavailable|unknown.session|session.not.found/i.test(message)) return "sessionExpired";
  return "sessionFailed";
}

const initial = (key: string, phase: Phase): Snapshot => ({ key, windowKey: "", phase, status: null, tile: null, totals: {}, loadingTotals: false, errorKey: null });

export function useTabulateSession(
  definition: TabulateItem | null,
  datasetGeneration: number | undefined,
  presentation: { visibleRowDepth: number; visibleColumnDepth: number },
  service: TabulateSessionRuntime = tabulateService,
) {
  const request: TabulateSessionRequest | null = definition && definition.statistics.length && datasetGeneration !== undefined ? {
    datasetId: definition.sourceDatasetId, sourceGeneration: datasetGeneration,
    rowFields: definition.rowFields.slice(0, presentation.visibleRowDepth),
    columnFields: definition.columnFields.slice(0, presentation.visibleColumnDepth), statistics: definition.statistics,
    includeRowTotals: definition.includeRowTotals, includeColumnTotals: definition.includeColumnTotals,
  } : null;
  const key = JSON.stringify([definition?.id, request]);
  const [snapshot, setSnapshot] = useState<Snapshot>(() => initial(key, request ? "preparing" : "idle"));
  const [position, setPosition] = useState({ rowStart: 0, columnStart: 0 });
  const [size, setSize] = useState({ visibleRows: 20, visibleColumns: 2 });
  const [attempt, setAttempt] = useState(0);
  const runtimeRef = useRef<Runtime | null>(null);
  const epochRef = useRef(0);
  const previousKey = useRef(key);
  const releaseBarrier = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    const epoch = ++epochRef.current;
    if (previousKey.current !== key) {
      previousKey.current = key;
      setPosition({ rowStart: 0, columnStart: 0 });
    }
    setSnapshot(initial(key, request ? "preparing" : "idle"));
    if (!request) return;
    let ownedSession: string | null = null;
    let released = false;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    let preparation: Promise<void> = Promise.resolve();
    const release = async () => {
      if (ownedSession && !released) {
        released = true;
        await service.release(ownedSession).catch(() => {});
      }
    };
    const current = () => runtimeRef.current === runtime && epochRef.current === epoch && !runtime.disposed && !runtime.cancelled;
    const fail = (reason: unknown) => {
      if (!current()) return;
      runtime.failed = true;
      void release();
      const errorKey = failureKey(reason);
      setSnapshot((value) => ({ ...value, phase: errorKey === "cancelled" ? "cancelled" : "error", errorKey, loadingTotals: false }));
    };
    const runtime: Runtime = {
      service,
      epoch, disposed: false, cancelled: false, failed: false, cache: new TabulateTileCache(), desired: null, totalsEpoch: 0, totalsIds: new Map(), pendingTotals: [],
      pumpTotals: () => {
        while (current() && runtime.totalsIds.size < 3 && runtime.pendingTotals.length) runtime.pendingTotals.shift()?.();
      },
      cancelPreparation: () => { clearTimeout(timer); clearTimeout(pollTimer); void release(); },
      fail,
      scheduler: new TabulateTileScheduler({
        start: service.queryWindow,
        cancelRequest: service.cancelRequest,
        onResult: (tile, tileRequest, priority) => {
          if (!current()) return;
          runtime.cache.putTile(tileRequest, tile);
          if (priority !== "foreground" || runtime.desired !== tabulateTileKey(tileRequest)) return;
          runtime.cache.unpin();
          runtime.cache.pin(tileRequest);
          setSnapshot((value) => ({ ...value, tile, phase: value.errorKey ? "error" : "ready" }));
          if (runtime.failed) return;
          for (const [rowOffset, columnOffset] of [[-tileRequest.rowCount, 0], [tileRequest.rowCount, 0], [0, -tileRequest.columnCount], [0, tileRequest.columnCount]]) {
            const rowStart = tileRequest.rowStart + rowOffset;
            const columnStart = tileRequest.columnStart + columnOffset;
            if (rowStart < 0 || columnStart < 0 || rowStart >= tile.rowMemberCount || columnStart >= tile.columnMemberCount) continue;
            const neighbor = { ...tileRequest, requestId: crypto.randomUUID(), rowStart, columnStart,
              rowCount: Math.min(tileRequest.rowCount, tile.rowMemberCount - rowStart),
              columnCount: Math.min(tileRequest.columnCount, tile.columnMemberCount - columnStart) };
            if (!runtime.cache.getTile(neighbor)) runtime.scheduler.prefetch(neighbor);
          }
        },
        onError: (reason, tileRequest, priority) => {
          if (priority === "foreground" && runtime.desired === tabulateTileKey(tileRequest)) fail(reason);
        },
      }),
    };
    runtimeRef.current = runtime;
    const acceptStatus = async (status: TabulateSessionStatus): Promise<void> => {
      ownedSession = status.sessionId;
      if (!current()) { await release(); return; }
      if (status.sourceGeneration !== request.sourceGeneration) { fail("tabulate_stale_source"); return; }
      if (status.state === "preparing") {
        pollTimer = setTimeout(() => {
          void service.getStatus(status.sessionId).then(acceptStatus).catch(fail);
        }, 250);
      } else if (status.state === "ready") {
        runtime.cache.setIdentity({ ...status, statisticCount: request.statistics.length });
        setSnapshot((value) => ({ ...value, status, phase: "loading" }));
      } else fail(status.failureCode ?? status.state);
    };
    const timer = setTimeout(() => {
      preparation = releaseBarrier.current.then(async () => {
        if (!current()) return;
        try { await acceptStatus(await service.prepare(request)); } catch (reason) { fail(reason); }
      });
    }, 250);
    return () => {
      runtime.disposed = true;
      runtime.scheduler.dispose();
      runtime.cache.clear();
      cancelTotals(runtime);
      clearTimeout(timer);
      clearTimeout(pollTimer);
      const immediateRelease = release();
      releaseBarrier.current = Promise.all([preparation, immediateRelease]).then(release);
    };
  }, [key, attempt, service]);

  const status = snapshot.key === key ? snapshot.status : null;
  const range: TabulateWindowRange | null = status ? calculateTabulateWindow({
    ...position, ...size, rowMemberCount: status.rowMemberCount, columnMemberCount: status.columnMemberCount,
    statisticCount: request?.statistics.length ?? 1,
  }) : null;
  const rangeKey = JSON.stringify(range);
  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime || runtime.disposed || runtime.cancelled || runtime.failed || !status || !range || !request) return;
    const totalsEpoch = ++runtime.totalsEpoch;
    const current = () => runtimeRef.current === runtime && !runtime.disposed && !runtime.cancelled && runtime.totalsEpoch === totalsEpoch;
    cancelTotals(runtime);
    const tileRequest: TabulateTileRequest = { ...range, sessionId: status.sessionId, fingerprint: status.fingerprint,
      sourceGeneration: status.sourceGeneration, statisticCount: request.statistics.length, requestId: crypto.randomUUID() };
    if (!range.rowCount || !range.columnCount) {
      setSnapshot((value) => ({ ...value, phase: "ready", tile: null, totals: {}, loadingTotals: false }));
      return;
    }
    runtime.desired = tabulateTileKey(tileRequest);
    const cached = runtime.cache.getTile(tileRequest);
    const kinds: TabulateTotalsKind[] = [];
    if (request.includeRowTotals) kinds.push({ kind: "rows", start: range.rowStart, count: range.rowCount });
    if (request.includeColumnTotals) kinds.push({ kind: "columns", start: range.columnStart, count: range.columnCount });
    if (request.includeRowTotals && request.includeColumnTotals) kinds.push({ kind: "grand" });
    setSnapshot((value) => ({ ...value, windowKey: rangeKey, tile: cached ?? null, totals: {}, phase: cached ? "ready" : "loading", errorKey: null, loadingTotals: kinds.length > 0 }));
    runtime.cache.unpin();
    if (cached) { runtime.scheduler.cancel(); runtime.cache.pin(tileRequest); }
    else runtime.scheduler.scheduleForeground(tileRequest);
    let remaining = kinds.length;
    for (const totals of kinds) {
      const totalsRequest = { ...tileRequest, requestId: crypto.randomUUID(), totals };
      const cachedTotals = runtime.cache.getTotals(totalsRequest);
      const accept = (result: TabulateTotalsResult) => {
        if (!current()) return;
        if (!cachedTotals && !runtime.cache.putTotals(totalsRequest, result)) throw new Error("Invalid Tabulate totals response");
        setSnapshot((value) => ({ ...value, totals: { ...value.totals, [totals.kind]: result } }));
      };
      runtime.pendingTotals.push(() => {
        runtime.totalsIds.set(totalsRequest.requestId, { cancelling: false });
        void (cachedTotals ? Promise.resolve(cachedTotals) : runtime.service.queryTotals(totalsRequest)).then(accept).catch((reason: unknown) => {
          if (current()) runtime.fail(reason);
        }).finally(() => {
          runtime.totalsIds.delete(totalsRequest.requestId);
          remaining -= 1;
          if (current() && remaining === 0) setSnapshot((value) => ({ ...value, loadingTotals: false }));
          runtime.pumpTotals();
        });
      });
    }
    runtime.pumpTotals();
  }, [status, rangeKey]);

  const navigate = (rowStart: number, columnStart: number) => {
    if (!status || !Number.isFinite(rowStart) || !Number.isFinite(columnStart)) return;
    setPosition({ rowStart: Math.max(0, Math.min(Math.trunc(rowStart), status.rowMemberCount - 1)),
      columnStart: Math.max(0, Math.min(Math.trunc(columnStart), status.columnMemberCount - 1)) });
  };
  const resize = (visibleRows: number, visibleColumns: number) => {
    setSize((value) => value.visibleRows === visibleRows && value.visibleColumns === visibleColumns ? value : { visibleRows, visibleColumns });
  };
  const cancel = () => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    runtime.cancelled = true;
    runtime.scheduler.cancel();
    runtime.cancelPreparation();
    cancelTotals(runtime);
    setSnapshot((value) => ({ ...value, tile: null, totals: {}, phase: "cancelled", errorKey: "cancelled", loadingTotals: false }));
  };
  const visible = snapshot.key === key ? snapshot : initial(key, request ? "preparing" : "idle");
  const windowMatches = visible.windowKey === rangeKey;
  return { ...visible, tile: windowMatches ? visible.tile : null, totals: windowMatches ? visible.totals : {},
    range, position, navigate, resize, cancel, retry: () => setAttempt((value) => value + 1) };
}

export type TabulateSessionController = ReturnType<typeof useTabulateSession>;