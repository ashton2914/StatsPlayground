import type { HistoryEntry, PendingHistoryAction } from "@/types/history";

export interface IncrementalHistoryState {
  history: HistoryEntry[];
  currentIdx: number;
}

export interface IncrementalHistoryTransition {
  state: IncrementalHistoryState;
  request: PendingHistoryAction;
}

export function recordIncrementalEntry(
  state: IncrementalHistoryState,
  entry: HistoryEntry,
  limit: number,
): IncrementalHistoryState {
  const retained = state.currentIdx > 0
    ? state.history.slice(state.currentIdx)
    : state.history;
  return {
    history: [entry, ...retained].slice(0, Math.max(0, limit)),
    currentIdx: 0,
  };
}

export function undoIncrementalEntry(
  state: IncrementalHistoryState,
): IncrementalHistoryTransition | null {
  const entryIndex = state.history.findIndex(
    (entry, index) => index >= state.currentIdx && entry.action,
  );
  if (entryIndex < 0) return null;
  const entry = state.history[entryIndex];
  if (!entry.action) return null;
  return {
    state: { ...state, currentIdx: entryIndex + 1 },
    request: { entryId: entry.id, direction: "undo", action: entry.action },
  };
}

export function redoIncrementalEntry(
  state: IncrementalHistoryState,
): IncrementalHistoryTransition | null {
  if (state.currentIdx <= 0) return null;
  let entryIndex = state.currentIdx - 1;
  while (entryIndex >= 0 && !state.history[entryIndex]?.action) {
    entryIndex -= 1;
  }
  if (entryIndex < 0) return null;
  const entry = state.history[entryIndex];
  if (!entry.action) return null;
  return {
    state: { ...state, currentIdx: entryIndex },
    request: { entryId: entry.id, direction: "redo", action: entry.action },
  };
}

export function discardedChangeSetIds(
  previous: HistoryEntry[],
  next: HistoryEntry[],
): string[] {
  const retainedIds = new Set(next.map(({ id }) => id));
  return previous.flatMap((entry) =>
    !retainedIds.has(entry.id) && entry.action?.kind === "changeSet"
      ? [entry.action.changeSetId]
      : []
  );
}

export function prepareArchivedHistory(history: HistoryEntry[]): HistoryEntry[] {
  return history.map((entry) =>
    entry.replayable === false
      ? { ...entry, action: undefined }
      : entry
  );
}