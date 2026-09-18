import type { TabulateWindowResult } from "@/types/tabulate";
import { tabulateTileKey } from "./tabulateTileCache";
import { tabulateIdentityKey, validateTabulateWindow } from "./tabulateViewport";
import type { TabulateTileRequest } from "./tabulateViewport";

export type TabulateTilePriority = "foreground" | "prefetch";

export interface TabulateTileSchedulerOptions {
  start: (request: TabulateTileRequest) => Promise<TabulateWindowResult>;
  cancelRequest: (requestId: string) => Promise<void>;
  onResult: (result: TabulateWindowResult, request: TabulateTileRequest, priority: TabulateTilePriority) => void;
  onError: (error: unknown, request: TabulateTileRequest, priority: TabulateTilePriority) => void;
}

interface TileJob {
  request: TabulateTileRequest;
  key: string;
}

interface ActiveTile extends TileJob {
  anchor: TileJob;
  priority: TabulateTilePriority;
  valid: boolean;
  cancelling: boolean;
}

function axisDirection(start: number, count: number, anchorStart: number, anchorCount: number): number | null {
  if (start === anchorStart && count === anchorCount) return 0;
  if (start + count === anchorStart) return -1;
  if (start === anchorStart + anchorCount) return 1;
  return null;
}

function neighborDirection(request: TabulateTileRequest, anchor: TabulateTileRequest): string | null {
  if (tabulateIdentityKey(request) !== tabulateIdentityKey(anchor)
    || request.rowCount > anchor.rowCount || request.columnCount > anchor.columnCount) return null;
  const row = axisDirection(request.rowStart, request.rowCount, anchor.rowStart, anchor.rowCount);
  const column = axisDirection(request.columnStart, request.columnCount, anchor.columnStart, anchor.columnCount);
  return row === null || column === null || (row === 0 && column === 0) ? null : `${row}:${column}`;
}

export class TabulateTileScheduler {
  private readonly options: TabulateTileSchedulerOptions;
  private foreground: ActiveTile | null = null;
  private prefetchActive: ActiveTile | null = null;
  private pendingForeground: TileJob | null = null;
  private readonly pendingPrefetch = new Map<string, TileJob>();
  private latest: TileJob | null = null;
  private pumpQueued = false;
  private disposed = false;

  constructor(options: TabulateTileSchedulerOptions) {
    this.options = options;
  }

  get pendingPrefetchCount(): number { return this.pendingPrefetch.size; }

  scheduleForeground(request: TabulateTileRequest): TabulateTileRequest | null {
    if (this.disposed) throw new Error("Tabulate scheduler is disposed");
    const job = { key: tabulateTileKey(request), request: { ...request } };
    if (this.pendingForeground?.key === job.key
      || (this.foreground?.valid && this.foreground.key === job.key)
      || (this.prefetchActive?.valid && this.prefetchActive.priority === "foreground"
        && this.prefetchActive.key === job.key)) return null;
    this.assertRequestId(job);
    const dropped = this.pendingForeground?.request ?? null;
    this.latest = job;
    this.pendingForeground = null;
    this.pendingPrefetch.clear();
    this.cancelActive(this.foreground);
    if (this.prefetchActive?.valid && this.prefetchActive.key === job.key) {
      this.prefetchActive.priority = "foreground";
      this.prefetchActive.anchor = job;
    } else {
      this.cancelActive(this.prefetchActive);
      this.pendingForeground = job;
    }
    this.queuePump();
    return dropped;
  }

  prefetch(request: TabulateTileRequest): boolean {
    if (this.disposed || !this.latest) return false;
    const key = tabulateTileKey(request);
    this.assertRequestId({ key, request });
    const direction = neighborDirection(request, this.latest.request);
    if (direction === null) return false;
    if (this.prefetchActive?.valid) {
      if (this.prefetchActive.key === key) return true;
      if (neighborDirection(this.prefetchActive.request, this.latest.request) === direction) return false;
    }
    const previous = this.pendingPrefetch.get(direction);
    if (previous?.key === key) return true;
    this.pendingPrefetch.set(direction, { key, request: { ...request } });
    this.queuePump();
    return true;
  }

  cancel(): void {
    this.latest = null;
    this.pendingForeground = null;
    this.pendingPrefetch.clear();
    this.cancelActive(this.foreground);
    this.cancelActive(this.prefetchActive);
  }

  dispose(): void {
    this.disposed = true;
    this.cancel();
  }

  private assertRequestId(job: TileJob): void {
    for (const active of [this.foreground, this.prefetchActive]) {
      if (active?.request.requestId === job.request.requestId
        && (active.key !== job.key || active.cancelling)) {
        throw new RangeError("Tabulate request ID is already active");
      }
    }
    if (this.pendingForeground?.request.requestId === job.request.requestId
      && this.pendingForeground.key !== job.key) {
      throw new RangeError("Tabulate request ID is already pending");
    }
    for (const pending of this.pendingPrefetch.values()) {
      if (pending.request.requestId === job.request.requestId && pending.key !== job.key) {
        throw new RangeError("Tabulate request ID is already pending");
      }
    }
  }

  private queuePump(): void {
    if (this.pumpQueued || this.disposed) return;
    this.pumpQueued = true;
    queueMicrotask(() => {
      this.pumpQueued = false;
      this.pump();
    });
  }

  private pump(): void {
    if (this.disposed || !this.latest) return;
    if (this.pendingForeground && !this.foreground
      && !(this.prefetchActive?.valid && this.prefetchActive.priority === "foreground")) {
      const job = this.pendingForeground;
      this.pendingForeground = null;
      this.start(job, "foreground");
    }
    if (this.foreground || this.pendingForeground || this.prefetchActive) return;
    const next = this.pendingPrefetch.entries().next().value;
    if (next) {
      this.pendingPrefetch.delete(next[0]);
      this.start(next[1], "prefetch");
    }
  }

  private start(job: TileJob, priority: TabulateTilePriority): void {
    if (!this.latest) return;
    const active: ActiveTile = { ...job, anchor: this.latest, priority, valid: true, cancelling: false };
    if (priority === "foreground") this.foreground = active;
    else this.prefetchActive = active;
    try {
      void this.options.start({ ...job.request }).then(
        (result) => this.finish(active, { result }),
        (error: unknown) => this.finish(active, { error }),
      );
    } catch (error) {
      this.finish(active, { error });
    }
  }

  private finish(active: ActiveTile, outcome: { result: TabulateWindowResult } | { error: unknown }): void {
    if (!this.release(active)) return;
    if (!active.valid || active.anchor !== this.latest || this.disposed) return;
    if ("error" in outcome) {
      this.options.onError(outcome.error, { ...active.request }, active.priority);
    } else if (!validateTabulateWindow(active.request, outcome.result)) {
      this.options.onError(new Error("Invalid Tabulate window response"), { ...active.request }, active.priority);
    } else {
      this.options.onResult(outcome.result, { ...active.request }, active.priority);
    }
  }

  private release(active: ActiveTile): boolean {
    if (this.foreground === active) this.foreground = null;
    else if (this.prefetchActive === active) this.prefetchActive = null;
    else return false;
    this.queuePump();
    return true;
  }

  private cancelActive(active: ActiveTile | null): void {
    if (!active || active.cancelling) return;
    active.valid = false;
    active.cancelling = true;
    try {
      void this.options.cancelRequest(active.request.requestId).then(
        () => { this.release(active); },
        () => {},
      );
    } catch {
      return;
    }
  }
}