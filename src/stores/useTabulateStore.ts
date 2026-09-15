import { create } from "zustand";
import type { TabulateItem } from "../types/tabulate.ts";
import { useProjectStore } from "@/stores/useProjectStore";
import { assertProjectMutable } from "@/utils/saveReadOnly";

export interface TabulateLatestResult {
  requestFingerprint: string;
  sourceGeneration: number;
  result: import("@/types/tabulate").TabulateResult;
  completedAt: string;
}

interface TabulateStore {
  items: TabulateItem[];
  latestResultsById: Record<string, TabulateLatestResult>;
  counter: number;
  addItem: (item: TabulateItem) => void;
  updateItem: (id: string, patch: Partial<TabulateItem>) => void;
  renameItem: (id: string, name: string) => void;
  deleteItem: (id: string) => void;
  loadFromProject: (items: TabulateItem[]) => void;
  reset: () => void;
  nextName: () => string;
  setLatestResult: (id: string, latest: TabulateLatestResult) => void;
  getLatestResult: (id: string) => TabulateLatestResult | null;
  clearLatestResult: (id: string) => void;
}

const TABULATE_NAME_RE = /^Tabulate (\d+)$/;

function maxTabulateSuffix(items: readonly TabulateItem[]): number {
  return items.reduce((maxValue, item) => {
    const match = item.name.match(TABULATE_NAME_RE);
    if (!match) {
      return maxValue;
    }
    return Math.max(maxValue, Number.parseInt(match[1], 10));
  }, 0);
}

function hasDefinitionPatch(patch: Partial<TabulateItem>): boolean {
  return (
    Object.hasOwn(patch, "sourceDatasetId")
    || Object.hasOwn(patch, "rowFields")
    || Object.hasOwn(patch, "columnFields")
    || Object.hasOwn(patch, "statistics")
    || Object.hasOwn(patch, "includeRowTotals")
    || Object.hasOwn(patch, "includeColumnTotals")
  );
}

export const useTabulateStore = create<TabulateStore>((set, get) => ({
  items: [],
  latestResultsById: {},
  counter: 0,
  addItem: (item) =>
    {
      assertProjectMutable(useProjectStore.getState().readOnly);
      set((state) => ({
        items: [...state.items, item],
        latestResultsById: (() => {
          const next = { ...state.latestResultsById };
          delete next[item.id];
          return next;
        })(),
        counter: Math.max(state.counter, maxTabulateSuffix([item])),
      }));
    },
  updateItem: (id, patch) =>
    {
      assertProjectMutable(useProjectStore.getState().readOnly);
      set((state) => {
        const items = state.items.map((item) => (item.id === id ? { ...item, ...patch } : item));
        const latestResultsById = hasDefinitionPatch(patch)
          ? (() => {
              const next = { ...state.latestResultsById };
              delete next[id];
              return next;
            })()
          : state.latestResultsById;
        return { items, latestResultsById, counter: Math.max(state.counter, maxTabulateSuffix(items)) };
      });
    },
  renameItem: (id, name) =>
    {
      assertProjectMutable(useProjectStore.getState().readOnly);
      set((state) => {
        const items = state.items.map((item) => (item.id === id ? { ...item, name } : item));
        return { items, counter: Math.max(state.counter, maxTabulateSuffix(items)) };
      });
    },
  deleteItem: (id) =>
    {
      assertProjectMutable(useProjectStore.getState().readOnly);
      set((state) => ({
        items: state.items.filter((item) => item.id !== id),
        latestResultsById: (() => {
          const next = { ...state.latestResultsById };
          delete next[id];
          return next;
        })(),
      }));
    },
  loadFromProject: (items) => set({ items, latestResultsById: {}, counter: maxTabulateSuffix(items) }),
  reset: () => set({ items: [], latestResultsById: {}, counter: 0 }),
  nextName: () => {
    assertProjectMutable(useProjectStore.getState().readOnly);
    const nextCounter = get().counter + 1;
    set({ counter: nextCounter });
    return `Tabulate ${nextCounter}`;
  },
  setLatestResult: (id, latest) => set((state) => ({
    latestResultsById: {
      ...state.latestResultsById,
      [id]: latest,
    },
  })),
  getLatestResult: (id) => get().latestResultsById[id] ?? null,
  clearLatestResult: (id) => set((state) => {
    if (!state.latestResultsById[id]) {
      return state;
    }
    const next = { ...state.latestResultsById };
    delete next[id];
    return { latestResultsById: next };
  }),
}));