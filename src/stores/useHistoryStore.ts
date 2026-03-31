import { create } from "zustand";
import { historyService } from "@/services/historyService";
import type {
  HistoryEntry,
  NamedSnapshot,
} from "@/types/history";

const MAX_HISTORY = 100;

let _idCounter = 0;
function nextId(): string {
  return `h_${Date.now()}_${++_idCounter}`;
}

function nowISO(): string {
  return new Date().toISOString();
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

  /** Record a new action with optional afterState for undo/redo */
  record: (description: string, afterState?: unknown) => void;
  /** Undo one step (go to previous entry's afterState) */
  undo: () => void;
  /** Redo one step (go to next entry's afterState) */
  redo: () => void;
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

  record: (description: string, afterState?: unknown) => {
    const entry: HistoryEntry = {
      id: nextId(),
      timestamp: nowISO(),
      description,
      afterState,
    };
    set((state) => {
      // If user made changes after undo, truncate "future" entries
      let history = state.currentIdx > 0
        ? state.history.slice(state.currentIdx)
        : [...state.history];
      history.unshift(entry);
      if (history.length > MAX_HISTORY) {
        history.length = MAX_HISTORY;
      }
      return { history, currentIdx: 0 };
    });
  },

  undo: () => {
    const { history, currentIdx } = get();
    if (currentIdx >= history.length - 1) return; // Nothing to undo
    const nextIdx = currentIdx + 1;
    const targetEntry = history[nextIdx];
    if (!targetEntry?.afterState) return;
    set({ currentIdx: nextIdx, pendingRestore: targetEntry.afterState });
  },

  redo: () => {
    const { history, currentIdx } = get();
    if (currentIdx <= 0) return; // Already at latest
    const prevIdx = currentIdx - 1;
    const targetEntry = history[prevIdx];
    if (!targetEntry?.afterState) return;
    set({ currentIdx: prevIdx, pendingRestore: targetEntry.afterState });
  },

  jumpTo: (id: string) => {
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
    try {
      const snapshot = await historyService.captureProjectSnapshot();
      const ts = nowISO();
      const entry: NamedSnapshot = {
        id: nextId(),
        name:
          name ||
          `快照 ${new Date(ts).toLocaleString("zh-CN", {
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
          })}`,
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
    const { snapshots } = get();
    const snap = snapshots.find((s) => s.id === id);
    if (!snap) return;
    await historyService.restoreProjectSnapshot(snap.snapshot);
  },

  deleteSnapshot: (id: string) => {
    set((state) => ({
      snapshots: state.snapshots.filter((s) => s.id !== id),
    }));
  },

  renameSnapshot: (id: string, name: string) => {
    set((state) => ({
      snapshots: state.snapshots.map((s) =>
        s.id === id ? { ...s, name } : s
      ),
    }));
  },

  reset: () => {
    set({ history: [], snapshots: [], currentIdx: -1, pendingRestore: null });
  },

  loadFromProject: (
    history: HistoryEntry[],
    snapshots: NamedSnapshot[]
  ) => {
    set({ history, snapshots, currentIdx: history.length > 0 ? 0 : -1 });
  },
}));
