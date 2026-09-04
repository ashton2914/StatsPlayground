import { create } from "zustand";
import { dataService } from "@/services/dataService";
import { historyService } from "@/services/historyService";
import type {
  HistoryEntry,
  NamedSnapshot,
  PendingHistoryAction,
  TableHistoryAction,
} from "@/types/history";
import {
  discardedChangeSetIds,
  recordIncrementalEntry,
  redoIncrementalEntry,
  undoIncrementalEntry,
} from "@/utils/historyTimeline";
import {
  allocateProjectBasename,
  formatSnapshotTimestamp,
  projectFileExtension,
} from "@/utils/projectFileNaming";
import { useProjectStore } from "@/stores/useProjectStore";
import { assertProjectMutable } from "@/utils/saveReadOnly";

const MAX_HISTORY = 100;
let historyEpoch = 0;

let _idCounter = 0;
function nextId(): string {
  return `h_${Date.now()}_${++_idCounter}`;
}

function nowISO(): string {
  return new Date().toISOString();
}

function dropDiscardedChangeSets(previous: HistoryEntry[], next: HistoryEntry[]): void {
  for (const changeSetId of discardedChangeSetIds(previous, next)) {
    void dataService.dropTableChangeSet(changeSetId).catch(() => undefined);
  }
}

function updateReplayGeneration(
  entry: HistoryEntry,
  entryId: string,
  generation: number,
): HistoryEntry {
  if (entry.id !== entryId || !entry.action || entry.action.kind === "changeSet") return entry;
  return { ...entry, action: { ...entry.action, generation } };
}

interface HistoryStore {
  /** Ordered list of history entries (newest first) — each optionally carries afterState */
  history: HistoryEntry[];
  /** Named snapshots (newest first) — full state captures */
  snapshots: NamedSnapshot[];
  /** Index of the current history position (0 = latest) */
  currentIdx: number;
  /** Pending restore data — set by undo/redo/jumpTo, consumed by DataTableView */
  pendingRestore: unknown | null;
  pendingAction: PendingHistoryAction | null;
  historyRevision: number;
  dataRevision: number;
  historyError: string | null;
  tableMutationDepth: number;

  /** Record a new action with optional afterState for undo/redo */
  record: (description: string, afterState?: unknown) => void;
  recordTable: (description: string, action: TableHistoryAction) => void;
  invalidateData: () => void;
  tryBeginTableMutation: () => boolean;
  endTableMutation: () => void;
  /** Undo one step (go to previous entry's afterState) */
  undo: () => Promise<void>;
  /** Redo one step (go to next entry's afterState) */
  redo: () => Promise<void>;
  /** Jump to a specific history entry by id */
  jumpTo: (id: string) => void;
  /** Clear the pending restore signal */
  clearPendingRestore: () => void;
  /** Create a named snapshot from current state (full capture, uses IPC) */
  createSnapshot: (name?: string) => Promise<void>;
  /** Restore a named snapshot */
  restoreSnapshot: (id: string) => Promise<void>;
  /** Delete a named snapshot */
  deleteSnapshot: (id: string) => void;
  /** Rename a named snapshot */
  renameSnapshot: (id: string, name: string) => void;
  /** Clear all history (e.g. on project close) */
  reset: () => void;
  /** Load history/snapshots from saved project data */
  loadFromProject: (
    history: HistoryEntry[],
    snapshots: NamedSnapshot[]
  ) => void;
}

export const useHistoryStore = create<HistoryStore>((set, get) => ({
  history: [],
  snapshots: [],
  currentIdx: -1,
  pendingRestore: null,
  pendingAction: null,
  historyRevision: 0,
  dataRevision: 0,
  historyError: null,
  tableMutationDepth: 0,

  record: (description: string, afterState?: unknown) => {
    assertProjectMutable(useProjectStore.getState().readOnly);
    const entry: HistoryEntry = {
      id: nextId(),
      timestamp: nowISO(),
      description,
      afterState,
    };
    set((state) => {
      if (state.pendingAction) return state;
      // If user made changes after undo, truncate "future" entries
      let history = state.currentIdx > 0
        ? state.history.slice(state.currentIdx)
        : [...state.history];
      history.unshift(entry);
      if (history.length > MAX_HISTORY) {
        history.length = MAX_HISTORY;
      }
      dropDiscardedChangeSets(state.history, history);
      return { history, currentIdx: 0 };
    });
  },

  recordTable: (description: string, action: TableHistoryAction) => {
    assertProjectMutable(useProjectStore.getState().readOnly);
    const entry: HistoryEntry = {
      id: nextId(),
      timestamp: nowISO(),
      description,
      action,
    };
    set((state) => {
      if (state.pendingAction) return state;
      const next = recordIncrementalEntry(state, entry, MAX_HISTORY);
      dropDiscardedChangeSets(state.history, next.history);
      return { ...next, dataRevision: state.dataRevision + 1 };
    });
  },

  invalidateData: () => {
    set((state) => ({ dataRevision: state.dataRevision + 1 }));
  },

  tryBeginTableMutation: () => {
    assertProjectMutable(useProjectStore.getState().readOnly);
    if (get().pendingAction) return false;
    set((state) => state.pendingAction
      ? state
      : { tableMutationDepth: state.tableMutationDepth + 1 });
    return get().pendingAction === null;
  },

  endTableMutation: () => {
    set((state) => ({ tableMutationDepth: Math.max(0, state.tableMutationDepth - 1) }));
  },

  undo: async () => {
    assertProjectMutable(useProjectStore.getState().readOnly);
    const { history, currentIdx, pendingAction, tableMutationDepth } = get();
    if (pendingAction || tableMutationDepth > 0) return;
    const transition = undoIncrementalEntry({ history, currentIdx });
    if (transition) {
      const request = transition.request;
      const requestEpoch = historyEpoch;
      set({ ...transition.state, pendingAction: request, historyError: null });
      try {
        let nextGeneration: number | null = null;
        if (request.action.kind === "cells") {
          nextGeneration = await dataService.updateCells(
            request.action.datasetId,
            request.action.cells.map((patch) => ({
              rowId: patch.rowId,
              columnName: patch.columnName,
              value: patch.before == null ? null : String(patch.before),
            })),
            request.action.generation,
          );
        } else if (request.action.kind === "addedRows") {
          nextGeneration = await dataService.applyAddedRows(
            request.action.datasetId,
            request.action.rowIds,
            true,
            request.action.generation,
          );
        } else if (request.action.kind === "reorderColumns") {
          nextGeneration = await dataService.reorderColumnIfGeneration(
            request.action.datasetId,
            request.action.to,
            request.action.from,
            request.action.generation,
          );
        } else {
          await dataService.applyTableChangeSet(request.action.changeSetId, true);
        }
        set((state) => historyEpoch === requestEpoch && state.pendingAction?.entryId === request.entryId
          ? {
              pendingAction: null,
              historyRevision: state.historyRevision + 1,
              dataRevision: state.dataRevision + 1,
              history: nextGeneration == null
                ? state.history
                : state.history.map((entry) => updateReplayGeneration(
                    entry,
                    request.entryId,
                    nextGeneration,
                  )),
            }
          : state);
      } catch (error) {
        set((state) => historyEpoch === requestEpoch && state.pendingAction?.entryId === request.entryId
          ? {
              currentIdx: Math.max(0, state.currentIdx - 1),
              pendingAction: null,
              historyError: String(error),
            }
          : state);
      }
      return;
    }
    if (currentIdx >= history.length - 1) return; // Nothing to undo
    const nextIdx = currentIdx + 1;
    const targetEntry = history[nextIdx];
    if (!targetEntry?.afterState) return;
    set({ currentIdx: nextIdx, pendingRestore: targetEntry.afterState });
  },

  redo: async () => {
    assertProjectMutable(useProjectStore.getState().readOnly);
    const { history, currentIdx, pendingAction, tableMutationDepth } = get();
    if (pendingAction || tableMutationDepth > 0) return;
    const transition = redoIncrementalEntry({ history, currentIdx });
    if (transition) {
      const request = transition.request;
      const requestEpoch = historyEpoch;
      set({ ...transition.state, pendingAction: request, historyError: null });
      try {
        let nextGeneration: number | null = null;
        if (request.action.kind === "cells") {
          nextGeneration = await dataService.updateCells(
            request.action.datasetId,
            request.action.cells.map((patch) => ({
              rowId: patch.rowId,
              columnName: patch.columnName,
              value: patch.after == null ? null : String(patch.after),
            })),
            request.action.generation,
          );
        } else if (request.action.kind === "addedRows") {
          nextGeneration = await dataService.applyAddedRows(
            request.action.datasetId,
            request.action.rowIds,
            false,
            request.action.generation,
          );
        } else if (request.action.kind === "reorderColumns") {
          nextGeneration = await dataService.reorderColumnIfGeneration(
            request.action.datasetId,
            request.action.from,
            request.action.to,
            request.action.generation,
          );
        } else {
          await dataService.applyTableChangeSet(request.action.changeSetId, false);
        }
        set((state) => historyEpoch === requestEpoch && state.pendingAction?.entryId === request.entryId
          ? {
              pendingAction: null,
              historyRevision: state.historyRevision + 1,
              dataRevision: state.dataRevision + 1,
              history: nextGeneration == null
                ? state.history
                : state.history.map((entry) => updateReplayGeneration(
                    entry,
                    request.entryId,
                    nextGeneration,
                  )),
            }
          : state);
      } catch (error) {
        set((state) => historyEpoch === requestEpoch && state.pendingAction?.entryId === request.entryId
          ? {
              currentIdx: Math.min(state.history.length, state.currentIdx + 1),
              pendingAction: null,
              historyError: String(error),
            }
          : state);
      }
      return;
    }
    if (currentIdx <= 0) return; // Already at latest
    const prevIdx = currentIdx - 1;
    const targetEntry = history[prevIdx];
    if (!targetEntry?.afterState) return;
    set({ currentIdx: prevIdx, pendingRestore: targetEntry.afterState });
  },

  jumpTo: (id: string) => {
    assertProjectMutable(useProjectStore.getState().readOnly);
    const { history, currentIdx } = get();
    const targetIdx = history.findIndex((e) => e.id === id);
    if (targetIdx < 0 || targetIdx === currentIdx) return;
    const targetEntry = history[targetIdx];
    if (!targetEntry?.afterState) return;
    set({ currentIdx: targetIdx, pendingRestore: targetEntry.afterState });
  },

  clearPendingRestore: () => {
    set({ pendingRestore: null });
  },

  createSnapshot: async (name?: string) => {
    assertProjectMutable(useProjectStore.getState().readOnly);
    try {
      const snapshot = await historyService.captureProjectSnapshot();
      const ts = nowISO();
      const d = new Date(ts);
      const defaultName = `Snapshot ${formatSnapshotTimestamp(d)}`;
      const resolvedName = allocateProjectBasename(
        name || defaultName,
        projectFileExtension("snapshot"),
        get().snapshots.map((snap) => snap.name),
      );
      const entry: NamedSnapshot = {
        id: nextId(),
        name: resolvedName,
        timestamp: ts,
        snapshot,
      };
      set((state) => ({
        snapshots: [entry, ...state.snapshots],
      }));
    } catch {
      // Silently fail
    }
  },

  restoreSnapshot: async (id: string) => {
    assertProjectMutable(useProjectStore.getState().readOnly);
    const { snapshots } = get();
    const snap = snapshots.find((s) => s.id === id);
    if (!snap) return;
    await historyService.restoreProjectSnapshot(snap.snapshot);
  },

  deleteSnapshot: (id: string) => {
    assertProjectMutable(useProjectStore.getState().readOnly);
    set((state) => ({
      snapshots: state.snapshots.filter((s) => s.id !== id),
    }));
  },

  renameSnapshot: (id: string, name: string) => {
    assertProjectMutable(useProjectStore.getState().readOnly);
    set((state) => ({
      snapshots: state.snapshots.map((s) =>
        s.id === id ? { ...s, name } : s
      ),
    }));
  },

  reset: () => {
    historyEpoch += 1;
    dropDiscardedChangeSets(get().history, []);
    set({ history: [], snapshots: [], currentIdx: -1, pendingRestore: null, pendingAction: null, historyError: null, tableMutationDepth: 0 });
  },

  loadFromProject: (
    history: HistoryEntry[],
    snapshots: NamedSnapshot[]
  ) => {
    const storedHistory = history.map((entry) => entry.action
      ? { ...entry, action: undefined }
      : entry);
    dropDiscardedChangeSets(get().history, []);
    set({ history: storedHistory, snapshots, currentIdx: storedHistory.length > 0 ? 0 : -1 });
  },
}));
