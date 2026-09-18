import { create } from "zustand";
import type { TabulateItem } from "../types/tabulate.ts";
import { useProjectStore } from "@/stores/useProjectStore";
import { assertProjectMutable } from "@/utils/saveReadOnly";

interface TabulateStore {
  items: TabulateItem[];
  counter: number;
  addItem: (item: TabulateItem) => void;
  updateItem: (id: string, patch: Partial<TabulateItem>) => void;
  renameItem: (id: string, name: string) => void;
  deleteItem: (id: string) => void;
  loadFromProject: (items: TabulateItem[]) => void;
  reset: () => void;
  nextName: () => string;
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

export const useTabulateStore = create<TabulateStore>((set, get) => ({
  items: [],
  counter: 0,
  addItem: (item) =>
    {
      assertProjectMutable(useProjectStore.getState().readOnly);
      set((state) => ({
        items: [...state.items, item],
        counter: Math.max(state.counter, maxTabulateSuffix([item])),
      }));
    },
  updateItem: (id, patch) =>
    {
      assertProjectMutable(useProjectStore.getState().readOnly);
      set((state) => {
        const items = state.items.map((item) => (item.id === id ? { ...item, ...patch } : item));
        return { items, counter: Math.max(state.counter, maxTabulateSuffix(items)) };
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
      }));
    },
  loadFromProject: (items) => set({ items, counter: maxTabulateSuffix(items) }),
  reset: () => set({ items: [], counter: 0 }),
  nextName: () => {
    assertProjectMutable(useProjectStore.getState().readOnly);
    const nextCounter = get().counter + 1;
    set({ counter: nextCounter });
    return `Tabulate ${nextCounter}`;
  },
}));