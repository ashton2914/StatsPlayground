export interface TableNavigationSchedulerClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): number;
  clearTimeout(handle: number): void;
}

interface SchedulerRequestLike {
  requestId: string;
  datasetId: string;
  generation: number;
}

interface PendingRequest<TRequest> {
  request: TRequest;
  dueAtMs: number;
}

interface ActiveRequest<TRequest> {
  request: TRequest;
  cancelling: boolean;
}

export interface TableNavigationSchedulerOptions<TRequest extends SchedulerRequestLike, TResult> {
  settleMs: number;
  clock: TableNavigationSchedulerClock;
  start: (request: TRequest) => Promise<TResult>;
  cancel: (requestId: string) => Promise<void>;
  onResult: (result: TResult, request: TRequest) => void;
  onError: (error: unknown, request: TRequest) => void;
  onDiscarded?: (request: TRequest) => void;
  isCancelledError?: (error: unknown) => boolean;
}

export class TableNavigationScheduler<
  TRequest extends SchedulerRequestLike,
  TResult,
> {
  private readonly settleMs: number;
  private readonly clock: TableNavigationSchedulerClock;
  private readonly startRequest: (request: TRequest) => Promise<TResult>;
  private readonly cancelRequest: (requestId: string) => Promise<void>;
  private readonly onResult: (result: TResult, request: TRequest) => void;
  private readonly onError: (error: unknown, request: TRequest) => void;
  private readonly onDiscarded: (request: TRequest) => void;
  private readonly isCancelledError: (error: unknown) => boolean;

  private active: ActiveRequest<TRequest> | null = null;
  private pending: PendingRequest<TRequest> | null = null;
  private settleTimer: number | null = null;

  constructor(options: TableNavigationSchedulerOptions<TRequest, TResult>) {
    this.settleMs = options.settleMs;
    this.clock = options.clock;
    this.startRequest = options.start;
    this.cancelRequest = options.cancel;
    this.onResult = options.onResult;
    this.onError = options.onError;
    this.onDiscarded = options.onDiscarded ?? (() => {});
    this.isCancelledError = options.isCancelledError ?? (() => false);
  }

  schedule(request: TRequest): TRequest | null {
    const droppedPendingRequest = this.pending?.request ?? null;
    const dueAtMs = this.clock.now() + this.settleMs;
    this.pending = {
      request,
      dueAtMs,
    };
    if (!this.active) {
      this.armSettleTimer();
    } else {
      this.clearSettleTimer();
    }
    if (this.active && !this.active.cancelling && this.active.request.requestId !== request.requestId) {
      this.active.cancelling = true;
      const cancelledRequestId = this.active.request.requestId;
      void this.cancelRequest(cancelledRequestId)
        .catch(() => {})
        .then(() => {
          if (this.active?.request.requestId !== cancelledRequestId || !this.active.cancelling) {
            return;
          }
          const discardedRequest = this.active.request;
          this.active = null;
          this.onDiscarded(discardedRequest);
          this.maybeStartPending();
        });
    }
    return droppedPendingRequest?.requestId === request.requestId ? null : droppedPendingRequest;
  }

  flush(): void {
    this.clearSettleTimer();
    if (this.pending) {
      this.pending = {
        ...this.pending,
        dueAtMs: this.clock.now(),
      };
    }
    if (this.active) {
      return;
    }
    this.maybeStartPending();
  }

  async invalidate(target: { datasetId: string; generation: number }): Promise<TRequest | null> {
    this.clearSettleTimer();
    let droppedPendingRequest: TRequest | null = null;
    if (this.pending?.request.datasetId === target.datasetId) {
      droppedPendingRequest = this.pending.request;
      this.pending = null;
    }
    if (!this.active || this.active.request.datasetId !== target.datasetId) {
      return droppedPendingRequest;
    }
    if (this.active.cancelling) {
      return droppedPendingRequest;
    }
    this.active.cancelling = true;
    await this.cancelRequest(this.active.request.requestId);
    return droppedPendingRequest;
  }

  private armSettleTimer(): void {
    this.clearSettleTimer();
    this.settleTimer = this.clock.setTimeout(() => {
      this.settleTimer = null;
      if (this.active) {
        return;
      }
      this.maybeStartPending();
    }, this.settleMs);
  }

  private clearSettleTimer(): void {
    if (this.settleTimer == null) {
      return;
    }
    this.clock.clearTimeout(this.settleTimer);
    this.settleTimer = null;
  }

  private maybeStartPending(): void {
    if (this.active || !this.pending) {
      return;
    }
    if (this.pending.dueAtMs > this.clock.now()) {
      this.armSettleTimer();
      return;
    }
    const request = this.pending.request;
    this.pending = null;
    this.active = {
      request,
      cancelling: false,
    };
    void this.startRequest(request)
      .then((result) => {
        if (this.active?.request.requestId !== request.requestId) {
          return;
        }
        this.active = null;
        this.onResult(result, request);
        this.maybeStartPending();
      })
      .catch((error) => {
        if (this.active?.request.requestId !== request.requestId) {
          return;
        }
        this.active = null;
        if (this.isCancelledError(error)) {
          this.onDiscarded(request);
        } else {
          this.onError(error, request);
        }
        this.maybeStartPending();
      });
  }
}