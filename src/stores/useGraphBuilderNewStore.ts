import { create } from "zustand";

import type { GraphBuilderNewSession, GraphNewRawMode, GraphNewXMode } from "@/types/graphBuilderNew";

interface GraphBuilderNewStore {
  sessions: GraphBuilderNewSession[];
  open: (datasetId: string, datasetGeneration: number) => string;
  setColumns: (
    id: string,
    xColumnId: string | null,
    yColumnId: string | null,
  ) => void;
  close: (id: string) => void;
  setMean: (id: string, showMean: boolean) => void;
  setModes: (id: string, xMode: GraphNewXMode, rawMode: GraphNewRawMode) => void;
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
        showMean: true,
        xMode: "auto",
        rawMode: "scatter",
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
  setMean: (id, showMean) => set((state) => ({
    sessions: state.sessions.map((session) => session.id === id ? { ...session, showMean } : session),
  })),
  setModes: (id, xMode, rawMode) => set((state) => ({
    sessions: state.sessions.map((session) => session.id === id ? { ...session, xMode, rawMode } : session),
  })),
}));