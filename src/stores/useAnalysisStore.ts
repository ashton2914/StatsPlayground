import { create } from "zustand";

import { useProjectStore } from "@/stores/useProjectStore";
import type { AnalysisDocument, AnalysisDocumentPatch } from "@/types/analysis";
import { assertProjectMutable } from "@/utils/saveReadOnly";
import { createNamedDocumentHelpers, removeDocumentById, updateDocumentById } from "./documentStore";

interface AnalysisStore {
  items: AnalysisDocument[];
  counter: number;
  addAnalysis: (analysis: AnalysisDocument) => void;
  updateAnalysis: (id: string, patch: AnalysisDocumentPatch) => void;
  removeAnalysis: (id: string) => void;
  loadAnalyses: (items: AnalysisDocument[]) => void;
  reset: () => void;
  nextName: () => string;
}

const ANALYSIS_HELPERS = createNamedDocumentHelpers("Analysis");

function applyAnalysisPatch(analysis: AnalysisDocument, patch: AnalysisDocumentPatch): AnalysisDocument {
  return {
    ...analysis,
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.definition !== undefined ? { definition: patch.definition } : {}),
    ...(patch.presentation !== undefined ? { presentation: patch.presentation } : {}),
    ...(patch.source !== undefined ? { source: patch.source } : {}),
    ...(patch.configRevision !== undefined ? { configRevision: patch.configRevision } : {}),
    ...(patch.updatedAt !== undefined ? { updatedAt: patch.updatedAt } : {}),
  };
}

export const useAnalysisStore = create<AnalysisStore>((set, get) => ({
  items: [],
  counter: 0,
  addAnalysis: (analysis) => {
    assertProjectMutable(useProjectStore.getState().readOnly);
    set((state) => ({
      items: [...state.items, analysis],
      counter: Math.max(state.counter, ANALYSIS_HELPERS.maxSuffix([analysis])),
    }));
  },
  updateAnalysis: (id, patch) => {
    assertProjectMutable(useProjectStore.getState().readOnly);
    set((state) => {
      const items = updateDocumentById(state.items, id, (analysis) => applyAnalysisPatch(analysis, patch));
      return { items, counter: Math.max(state.counter, ANALYSIS_HELPERS.maxSuffix(items)) };
    });
  },
  removeAnalysis: (id) => {
    assertProjectMutable(useProjectStore.getState().readOnly);
    set((state) => ({
      items: removeDocumentById(state.items, id),
    }));
  },
  loadAnalyses: (items) => set({ items, counter: ANALYSIS_HELPERS.maxSuffix(items) }),
  reset: () => set({ items: [], counter: 0 }),
  nextName: () => {
    assertProjectMutable(useProjectStore.getState().readOnly);
    const nextCounter = get().counter + 1;
    set({ counter: nextCounter });
    return ANALYSIS_HELPERS.nextName(nextCounter - 1);
  },
}));