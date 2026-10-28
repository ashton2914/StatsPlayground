interface CancellationDependencies {
  cancel(): Promise<boolean>;
  onChange(requested: boolean): void;
  onError(error: unknown): void;
}

/** Retains early cancel intent until the native request has registered. */
export function createMigrationCancellation(deps: CancellationDependencies) {
  let requested = false;
  let registered = false;
  let disposed = false;
  let confirmed = false;
  let attempts = 0;
  let inFlight: Promise<void> | undefined;

  function send(): Promise<void> {
    if (disposed || !requested || confirmed || attempts >= 2) return Promise.resolve();
    if (inFlight) return inFlight;
    inFlight = Promise.resolve().then(async () => {
      try {
        do {
          attempts += 1;
          confirmed = await deps.cancel();
        } while (!disposed && requested && registered && !confirmed && attempts < 2);
      } catch (error) {
        if (!disposed) {
          requested = false;
          attempts = 0;
          deps.onChange(false);
          deps.onError(error);
        }
      }
    }).finally(() => { inFlight = undefined; });
    return inFlight;
  }

  return {
    request() {
      if (!disposed && !requested) {
        requested = true;
        deps.onChange(true);
      }
      return send();
    },
    registered() { registered = true; return send(); },
    isRequested: () => requested,
    dispose() { disposed = true; },
  };
}
