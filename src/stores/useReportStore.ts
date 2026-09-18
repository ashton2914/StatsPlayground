import { create } from "zustand";

import { useProjectStore } from "@/stores/useProjectStore";
import type { ReportItem } from "@/types/report";
import { assertProjectMutable } from "@/utils/saveReadOnly";
import { createNamedDocumentHelpers, removeDocumentById, updateDocumentById } from "./documentStore";

interface ReportStore {
  items: ReportItem[];
  documentRevisions: Record<string, number>;
  counter: number;
  addItem: (item: ReportItem) => void;
  updateMarkdown: (id: string, markdown: string, updatedAt: string) => void;
  renameItem: (id: string, name: string) => void;
  deleteItem: (id: string) => void;
  loadFromProject: (items: ReportItem[]) => void;
  reset: () => void;
  nextName: () => string;
  getDocumentRevision: (id: string) => number;
  setDocumentRevision: (id: string, revision: number) => void;
}

const REPORT_HELPERS = createNamedDocumentHelpers("Report");

export const useReportStore = create<ReportStore>((set, get) => ({
  items: [],
  documentRevisions: {},
  counter: 0,
  addItem: (item) => {
    assertProjectMutable(useProjectStore.getState().readOnly);
    set((state) => ({
      items: [...state.items, item],
      documentRevisions: (() => {
        const next = { ...state.documentRevisions };
        delete next[item.id];
        return next;
      })(),
      counter: Math.max(state.counter, REPORT_HELPERS.maxSuffix([item])),
    }));
  },
  updateMarkdown: (id, markdown, updatedAt) => {
    assertProjectMutable(useProjectStore.getState().readOnly);
    set((state) => ({
      items: updateDocumentById(state.items, id, (item) => ({ ...item, markdown, updatedAt })),
    }));
  },
  renameItem: (id, name) => {
    assertProjectMutable(useProjectStore.getState().readOnly);
    set((state) => {
      const items = updateDocumentById(state.items, id, (item) => ({ ...item, name }));
      return { items, counter: Math.max(state.counter, REPORT_HELPERS.maxSuffix(items)) };
    });
  },
  deleteItem: (id) => {
    assertProjectMutable(useProjectStore.getState().readOnly);
    set((state) => ({
      items: removeDocumentById(state.items, id),
      documentRevisions: (() => {
        const next = { ...state.documentRevisions };
        delete next[id];
        return next;
      })(),
    }));
  },
  loadFromProject: (items) => set({ items, documentRevisions: {}, counter: REPORT_HELPERS.maxSuffix(items) }),
  reset: () => set({ items: [], documentRevisions: {}, counter: 0 }),
  nextName: () => {
    assertProjectMutable(useProjectStore.getState().readOnly);
    const nextCounter = get().counter + 1;
    set({ counter: nextCounter });
    return REPORT_HELPERS.nextName(nextCounter - 1);
  },
  getDocumentRevision: (id) => get().documentRevisions[id] ?? 0,
  setDocumentRevision: (id, revision) => {
    set((state) => ({
      documentRevisions: {
        ...state.documentRevisions,
        [id]: revision,
      },
    }));
  },
}));