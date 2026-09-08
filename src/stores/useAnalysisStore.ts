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

function ensureNormalFit(analysis: AnalysisDocument): AnalysisDocument {
  if (analysis.analysisKind !== "distribution") return analysis;
  const fitDistributions = analysis.definition.analysis.fitDistributions;
  if (fitDistributions.includes("normal")) return analysis;
  return {
    ...analysis,
    definition: {
      ...analysis.definition,
      analysis: {
        ...analysis.definition.analysis,
        fitDistributions: ["normal", ...fitDistributions],
      },
    },
  };
}

function applyAnalysisPatch(analysis: AnalysisDocument, patch: AnalysisDocumentPatch): AnalysisDocument {
  const shared = {
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.source !== undefined ? { source: patch.source } : {}),
    ...(patch.configRevision !== undefined ? { configRevision: patch.configRevision } : {}),
    ...(patch.updatedAt !== undefined ? { updatedAt: patch.updatedAt } : {}),
  };
  if (analysis.analysisKind === "distribution") {
    return ensureNormalFit({
      ...analysis,
      ...shared,
      ...(patch.definition?.kind === "distribution" ? { definition: patch.definition } : {}),
      ...(patch.presentation?.layout === "distribution-v1" ? { presentation: patch.presentation } : {}),
    });
  }
  if (analysis.analysisKind === "fitYByX") {
    return {
      ...analysis,
      ...shared,
      ...(patch.definition?.kind === "fitYByX" ? { definition: patch.definition } : {}),
      ...(patch.presentation?.layout === "fit-y-by-x-v1" ? { presentation: patch.presentation } : {}),
    };
  }
  if (analysis.analysisKind === "hypothesisTest") {
    return {
      ...analysis,
      ...shared,
      ...(patch.definition?.kind === "hypothesisTest" ? { definition: patch.definition } : {}),
      ...(patch.presentation?.layout === "hypothesis-test-v1" ? { presentation: patch.presentation } : {}),
    };
  }
  return {
    ...analysis,
    ...shared,
    ...(patch.definition?.kind === "fitModel" ? { definition: patch.definition } : {}),
    ...(patch.presentation?.layout === "fit-model-v1" ? { presentation: patch.presentation } : {}),
  };
}

export const useAnalysisStore = create<AnalysisStore>((set, get) => ({
  items: [],
  counter: 0,
  addAnalysis: (analysis) => {
    assertProjectMutable(useProjectStore.getState().readOnly);
    const normalizedAnalysis = ensureNormalFit(analysis);
    set((state) => ({
      items: [...state.items, normalizedAnalysis],
      counter: Math.max(state.counter, ANALYSIS_HELPERS.maxSuffix([normalizedAnalysis])),
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
  loadAnalyses: (items) => {
    const normalizedItems = items.map(ensureNormalFit);
    set({ items: normalizedItems, counter: ANALYSIS_HELPERS.maxSuffix(normalizedItems) });
  },
  reset: () => set({ items: [], counter: 0 }),
  nextName: () => {
    assertProjectMutable(useProjectStore.getState().readOnly);
    const nextCounter = get().counter + 1;
    set({ counter: nextCounter });
    return ANALYSIS_HELPERS.nextName(nextCounter - 1);
  },
}));