import { create } from "zustand";

import type { GraphBuilderNewSession } from "@/types/graphBuilderNew";

interface GraphBuilderNewStore {
  sessions: GraphBuilderNewSession[];
  open: (datasetId: string, datasetGeneration: number) => string;
  setColumns: (
    id: string,
    xColumnId: string | null,
    yColumnId: string | null,
  ) => void;
  close: (id: string) => void;
}

export const useGraphBuilderNewStore = create<GraphBuilderNewStore>((set) => ({
  sessions: [],
  open: (datasetId, datasetGeneration) => {
    const id = crypto.randomUUID();
    set({
      sessions: [{
        id,
        datasetId,
        datasetGeneration,
        xColumnId: null,
        yColumnId: null,
      }],
    });
    return id;
  },
  setColumns: (id, xColumnId, yColumnId) => set((state) => ({
    sessions: state.sessions.map((session) => (
      session.id === id ? { ...session, xColumnId, yColumnId } : session
    )),
  })),
  close: (id) => set((state) => ({
    sessions: state.sessions.filter((session) => session.id !== id),
  })),
}));