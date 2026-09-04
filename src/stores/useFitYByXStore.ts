import { create } from "zustand";

import {
  createDefaultFitYByXGraphConfig,
  createFitYByXItem,
  FitYByXRoleValidationError,
  deriveFitYByXPersonality,
} from "@/components/fitYByX/fitYByXConfig";
import { createEmbeddedGraphItem } from "@/components/graphBuilder/graphBuilderMode";
import { normalizeGroupThemeSlots } from "@/components/graphBuilder/graphThemeIdentity";
import { useProjectStore } from "@/stores/useProjectStore";
import type { EmbeddedGraphConfig } from "@/types/graphBuilder";
import type { FitYByXItem, FitYByXPersonality } from "@/types/fitYByX";
import { assertProjectMutable } from "@/utils/saveReadOnly";

interface FitYByXStore {
  items: FitYByXItem[];
  counter: number;
  addItem: (item: FitYByXItem) => void;
  updateItem: (id: string, patch: Partial<FitYByXItem>) => void;
  renameItem: (id: string, name: string) => void;
  deleteItem: (id: string) => void;
  deleteByDataset: (datasetId: string) => void;
  loadFromProject: (items: FitYByXItem[]) => void;
  reset: () => void;
  nextName: () => string;
}

const FIT_Y_BY_X_NAME_RE = /^Fit Y by X (\d+)$/;

function maxFitYByXSuffix(items: readonly FitYByXItem[]): number {
  return items.reduce((maxValue, item) => {
    const match = item.name.match(FIT_Y_BY_X_NAME_RE);
    if (!match) {
      return maxValue;
    }
    return Math.max(maxValue, Number.parseInt(match[1], 10));
  }, 0);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isLoadableEmbeddedGraphConfig(value: unknown): value is EmbeddedGraphConfig {
  if (!isObject(value)) return false;
  if (value.mode !== "2d" && value.mode !== "3d" && value.mode !== "multivariate") return false;
  if (!isObject(value.modeStates)) return false;
  return isObject(value.modeStates.twoD)
    && isObject(value.modeStates.threeD)
    && isObject(value.modeStates.multivariate);
}

function extractEmbeddedGraphConfig(item: ReturnType<typeof createEmbeddedGraphItem>): EmbeddedGraphConfig {
  const groupThemeSlots = normalizeGroupThemeSlots(item.groupThemeSlots);
  return {
    mode: item.mode,
    modeStates: item.modeStates,
    filters: item.filters,
    sampling: item.sampling,
    ...(Object.keys(groupThemeSlots).length === 0 ? {} : { groupThemeSlots }),
  };
}

function isMatchingField(
  actual: { name: string; type: string } | undefined,
  expected: { name: string; type: string },
): boolean {
  return actual?.name === expected.name && actual.type === expected.type;
}

function isExpectedFamily(personality: FitYByXPersonality, graph: EmbeddedGraphConfig): boolean {
  if (graph.mode !== "2d") return false;
  const activeKinds = graph.modeStates.twoD.elements
    .filter((element) => element.enabled !== false)
    .map((element) => element.kind);
  return personality === "bivariate"
    ? activeKinds.includes("fitline") && !activeKinds.includes("boxplot")
    : activeKinds.includes("boxplot") && !activeKinds.includes("fitline");
}

function isUsableFitYByXGraph(item: FitYByXItem, graph: EmbeddedGraphConfig): boolean {
  return graph.mode === "2d"
    && isMatchingField(graph.modeStates.twoD.encoding.x, item.factor)
    && isMatchingField(graph.modeStates.twoD.encoding.y, item.response)
    && isExpectedFamily(item.personality, graph);
}

function normalizeLoadedItem(item: FitYByXItem): FitYByXItem {
  const personality = deriveFitYByXPersonality(item.factor);
  const base = createFitYByXItem({
    id: item.id,
    name: item.name,
    sourceDatasetId: item.sourceDatasetId,
    response: item.response,
    factor: item.factor,
    createdAt: item.createdAt,
  });

  const normalizedBase: FitYByXItem = {
    ...base,
    personality,
    graph: createDefaultFitYByXGraphConfig({
      response: item.response,
      factor: item.factor,
    }),
  };

  if (!isLoadableEmbeddedGraphConfig(item.graph)) {
    return normalizedBase;
  }

  const graph = extractEmbeddedGraphConfig(createEmbeddedGraphItem({
    id: `fit-y-by-x-graph:${base.id}`,
    name: base.name,
    sourceDatasetId: base.sourceDatasetId,
    config: item.graph,
    createdAt: base.createdAt,
  }));

  return isUsableFitYByXGraph(normalizedBase, graph) ? { ...normalizedBase, graph } : normalizedBase;
}

export const useFitYByXStore = create<FitYByXStore>((set, get) => ({
  items: [],
  counter: 0,
  addItem: (item) =>
    {
      assertProjectMutable(useProjectStore.getState().readOnly);
      set((state) => ({
        items: [...state.items, item],
        counter: Math.max(state.counter, maxFitYByXSuffix([item])),
      }));
    },
  updateItem: (id, patch) =>
    {
      assertProjectMutable(useProjectStore.getState().readOnly);
      set((state) => {
        const items = state.items.map((item) => (item.id === id ? { ...item, ...patch } : item));
        return { items, counter: Math.max(state.counter, maxFitYByXSuffix(items)) };
      });
    },
  renameItem: (id, name) =>
    {
      assertProjectMutable(useProjectStore.getState().readOnly);
      set((state) => {
        const items = state.items.map((item) => (item.id === id ? { ...item, name } : item));
        return { items, counter: Math.max(state.counter, maxFitYByXSuffix(items)) };
      });
    },
  deleteItem: (id) =>
    {
      assertProjectMutable(useProjectStore.getState().readOnly);
      set((state) => ({
        items: state.items.filter((item) => item.id !== id),
      }));
    },
  deleteByDataset: (datasetId) =>
    {
      assertProjectMutable(useProjectStore.getState().readOnly);
      set((state) => ({
        items: state.items.filter((item) => item.sourceDatasetId !== datasetId),
      }));
    },
  loadFromProject: (items) => set(() => {
    const normalized = items.flatMap((item) => {
      try {
        return [normalizeLoadedItem(item)];
      } catch (error) {
        if (error instanceof FitYByXRoleValidationError) {
          return [];
        }
        throw error;
      }
    });
    return {
      items: normalized,
      counter: maxFitYByXSuffix(normalized),
    };
  }),
  reset: () => set({ items: [], counter: 0 }),
  nextName: () => {
    assertProjectMutable(useProjectStore.getState().readOnly);
    const nextCounter = get().counter + 1;
    set({ counter: nextCounter });
    return `Fit Y by X ${nextCounter}`;
  },
}));