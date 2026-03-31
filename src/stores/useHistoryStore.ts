import { create } from "zustand";
import { historyService } from "@/services/historyService";
import type {
  HistoryEntry,
  NamedSnapshot,
  ProjectDataSnapshot,
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
  /** Ordered list of history entries (newest first) */
  history: HistoryEntry[];
  /** Named snapshots (newest first) */
  snapshots: NamedSnapshot[];
  /** Index of the current history position (for undo tracking) */
  currentIdx: number;

  /** Record a new action (captures current project state) */
  record: (description: string) => Promise<void>;
  /** Restore to a specific history entry */
  restoreHistory: (id: string) => Promise<void>;
  /** Create a named snapshot from current state */
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

  record: async (description: string) => {
    try {
      const snapshot = await historyService.captureProjectSnapshot();
      const entry: HistoryEntry = {
        id: nextId(),
        timestamp: nowISO(),
        description,
        snapshot,
      };
      set((state) => {
        // If we're not at the latest, truncate future entries
        const history =
          state.currentIdx > 0
            ? state.history.slice(state.currentIdx)
            : [...state.history];
        history.unshift(entry);
        // Trim to max
        if (history.length > MAX_HISTORY) {
          history.length = MAX_HISTORY;
        }
        return { history, currentIdx: 0 };
      });
    } catch {
      // Silently fail — don't break user flow
    }
  },

  restoreHistory: async (id: string) => {
    const { history } = get();
    const idx = history.findIndex((e) => e.id === id);
    if (idx < 0) return;
    const entry = history[idx];
    await historyService.restoreProjectSnapshot(entry.snapshot);
    set({ currentIdx: idx });
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
    set({ history: [], snapshots: [], currentIdx: -1 });
  },

  loadFromProject: (
    history: HistoryEntry[],
    snapshots: NamedSnapshot[]
  ) => {
    set({ history, snapshots, currentIdx: history.length > 0 ? 0 : -1 });
  },
}));
