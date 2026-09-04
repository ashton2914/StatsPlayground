import { create } from "zustand";

import { useProjectStore } from "@/stores/useProjectStore";
import type { ReportItem } from "@/types/report";
import { assertProjectMutable } from "@/utils/saveReadOnly";

interface ReportStore {
  items: ReportItem[];
  counter: number;
  addItem: (item: ReportItem) => void;
  updateMarkdown: (id: string, markdown: string, updatedAt: string) => void;
  renameItem: (id: string, name: string) => void;
  deleteItem: (id: string) => void;
  loadFromProject: (items: ReportItem[]) => void;
  reset: () => void;
  nextName: () => string;
}

const REPORT_NAME_RE = /^Report (\d+)$/;

function maxReportSuffix(items: readonly ReportItem[]): number {
  return items.reduce((maxValue, item) => {
    const match = item.name.match(REPORT_NAME_RE);
    if (!match) {
      return maxValue;
    }
    return Math.max(maxValue, Number.parseInt(match[1], 10));
  }, 0);
}

export const useReportStore = create<ReportStore>((set, get) => ({
  items: [],
  counter: 0,
  addItem: (item) => {
    assertProjectMutable(useProjectStore.getState().readOnly);
    set((state) => ({
      items: [...state.items, item],
      counter: Math.max(state.counter, maxReportSuffix([item])),
    }));
  },
  updateMarkdown: (id, markdown, updatedAt) => {
    assertProjectMutable(useProjectStore.getState().readOnly);
    set((state) => ({
      items: state.items.map((item) => (
        item.id === id ? { ...item, markdown, updatedAt } : item
      )),
    }));
  },
  renameItem: (id, name) => {
    assertProjectMutable(useProjectStore.getState().readOnly);
    set((state) => {
      const items = state.items.map((item) => (item.id === id ? { ...item, name } : item));
      return { items, counter: Math.max(state.counter, maxReportSuffix(items)) };
    });
  },
  deleteItem: (id) => {
    assertProjectMutable(useProjectStore.getState().readOnly);
    set((state) => ({
      items: state.items.filter((item) => item.id !== id),
    }));
  },
  loadFromProject: (items) => set({ items, counter: maxReportSuffix(items) }),
  reset: () => set({ items: [], counter: 0 }),
  nextName: () => {
    assertProjectMutable(useProjectStore.getState().readOnly);
    const nextCounter = get().counter + 1;
    set({ counter: nextCounter });
    return `Report ${nextCounter}`;
  },
}));