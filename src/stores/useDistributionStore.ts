import { create } from "zustand";

import {
  createDefaultDistributionAnalysisConfig,
  createDefaultDistributionGraphs,
  createDistributionItem,
  type DistributionFieldInfo,
  validateDistributionRoles,
} from "@/components/distribution/distributionConfig";
import { createEmbeddedGraphItem } from "@/components/graphBuilder/graphBuilderMode";
import type { FieldRef } from "@/graphCore";
import { useProjectStore } from "@/stores/useProjectStore";
import type {
  DistributionAnalysisConfig,
  DistributionItem,
  SpecLimitsOverride,
} from "@/types/distribution";
import type { EmbeddedGraphConfig } from "@/types/graphBuilder";
import { assertProjectMutable } from "@/utils/saveReadOnly";

interface CreateDistributionItemInput {
  id: string;
  name?: string;
  sourceDatasetId: string;
  responses: FieldRef[];
  weight: FieldRef | null;
  frequency: FieldRef | null;
  by: FieldRef[];
  columns: readonly DistributionFieldInfo[];
  analysis?: DistributionAnalysisConfig;
  createdAt: string;
}

interface DistributionStore {
  items: DistributionItem[];
  counter: number;
  createItem: (input: CreateDistributionItemInput) => DistributionItem;
  addItem: (item: DistributionItem) => void;
  updateItem: (id: string, patch: Partial<DistributionItem>) => void;
  renameItem: (id: string, name: string) => void;
  deleteItem: (id: string) => void;
  deleteByDataset: (datasetId: string) => void;
  loadFromProject: (items: unknown[]) => void;
  reset: () => void;
  nextName: () => string;
}

const DISTRIBUTION_NAME_RE = /^Distribution (\d+)$/;

function maxDistributionSuffix(items: readonly DistributionItem[]): number {
  return items.reduce((maximum, item) => {
    const match = item.name.match(DISTRIBUTION_NAME_RE);
    return match ? Math.max(maximum, Number.parseInt(match[1], 10)) : maximum;
  }, 0);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFieldRef(value: unknown): value is FieldRef {
  return isObject(value)
    && typeof value.name === "string"
    && ["continuous", "nominal", "ordinal", "datetime", "id"].includes(String(value.type));
}

function normalizeFields(value: unknown): FieldRef[] {
  return Array.isArray(value) ? value.filter(isFieldRef).map((field) => ({ ...field })) : [];
}

function normalizeNullableField(value: unknown): FieldRef | null {
  return isFieldRef(value) ? { ...value } : null;
}

function normalizeSpecLimits(value: unknown): Record<string, SpecLimitsOverride> {
  if (!isObject(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([fieldName, limits]) => {
    if (!isObject(limits)) return [];
    const read = (key: "lsl" | "target" | "usl") =>
      typeof limits[key] === "number" && Number.isFinite(limits[key]) ? limits[key] as number : null;
    return [[fieldName, { lsl: read("lsl"), target: read("target"), usl: read("usl") }]];
  }));
}

function normalizeAnalysis(value: unknown): DistributionAnalysisConfig {
  const defaults = createDefaultDistributionAnalysisConfig();
  if (!isObject(value)) return defaults;
  const confidenceLevel = typeof value.confidenceLevel === "number"
    && Number.isFinite(value.confidenceLevel)
    && value.confidenceLevel > 0
    && value.confidenceLevel < 1
    ? value.confidenceLevel
    : defaults.confidenceLevel;
  const allowedFits = new Set(["normal", "lognormal", "exponential", "gamma", "weibull"]);
  const fitDistributions = Array.isArray(value.fitDistributions)
    ? [...new Set(value.fitDistributions.filter(
        (fit): fit is DistributionAnalysisConfig["fitDistributions"][number] =>
          typeof fit === "string" && allowedFits.has(fit),
      ))]
    : defaults.fitDistributions;
  return {
    confidenceLevel,
    specLimits: normalizeSpecLimits(value.specLimits),
    fitDistributions,
  };
}

function isLoadableGraph(value: unknown): value is EmbeddedGraphConfig {
  return isObject(value)
    && value.mode === "2d"
    && isObject(value.modeStates)
    && isObject(value.modeStates.twoD)
    && isObject(value.modeStates.threeD)
    && isObject(value.modeStates.multivariate);
}

function materializeGraph(
  value: unknown,
  fallback: EmbeddedGraphConfig,
  item: Pick<DistributionItem, "id" | "name" | "sourceDatasetId" | "createdAt">,
  graphName: keyof DistributionItem["graphs"],
  response: FieldRef,
): EmbeddedGraphConfig {
  if (!isLoadableGraph(value)) return fallback;
  const graph = createEmbeddedGraphItem({
    id: `distribution-graph:${item.id}:${graphName}`,
    name: `${item.name} ${graphName}`,
    sourceDatasetId: item.sourceDatasetId,
    config: value,
    createdAt: item.createdAt,
  });
  const candidate: EmbeddedGraphConfig = {
    mode: graph.mode,
    modeStates: graph.modeStates,
    filters: graph.filters,
    sampling: graph.sampling,
  };
  const binding = candidate.modeStates.twoD.encoding.x;
  const elements = candidate.modeStates.twoD.elements
    .filter((element) => element.enabled !== false)
    .map((element) => [element.kind, element.options?.elementId]);
  const expectedElements = fallback.modeStates.twoD.elements
    .filter((element) => element.enabled !== false)
    .map((element) => [element.kind, element.options?.elementId]);
  return binding?.name === response.name
    && binding.type === response.type
    && JSON.stringify(elements) === JSON.stringify(expectedElements)
    ? candidate
    : fallback;
}

function normalizeLoadedItem(value: unknown): DistributionItem | null {
  if (!isObject(value)
    || typeof value.id !== "string"
    || typeof value.name !== "string"
    || typeof value.sourceDatasetId !== "string"
    || typeof value.createdAt !== "string") {
    return null;
  }
  const responses = normalizeFields(value.responses);
  const weight = normalizeNullableField(value.weight);
  const frequency = normalizeNullableField(value.frequency);
  const by = normalizeFields(value.by);
  const metadata: DistributionFieldInfo[] = [
    ...responses.map((field) => ({ name: field.name, sqlType: field.type === "continuous" ? "DOUBLE" : "", integerCompatible: false, field })),
    ...(weight ? [{ name: weight.name, sqlType: "DOUBLE", integerCompatible: false, field: weight }] : []),
    ...(frequency ? [{ name: frequency.name, sqlType: "BIGINT", integerCompatible: true, field: frequency }] : []),
    ...by.map((field) => ({ name: field.name, sqlType: "VARCHAR", integerCompatible: false, field })),
  ];
  if (!validateDistributionRoles({ responses, weight, frequency, by }, metadata).ok) return null;

  const base = createDistributionItem({
    id: value.id,
    name: value.name,
    sourceDatasetId: value.sourceDatasetId,
    responses,
    weight,
    frequency,
    by,
    columns: metadata,
    analysis: normalizeAnalysis(value.analysis),
    createdAt: value.createdAt,
  });
  const rawGraphs = isObject(value.graphs) ? value.graphs : {};
  const defaults = createDefaultDistributionGraphs(responses[0]!);
  return {
    ...base,
    graphs: {
      overview: materializeGraph(rawGraphs.overview, defaults.overview, base, "overview", responses[0]!),
      boxPlot: materializeGraph(rawGraphs.boxPlot, defaults.boxPlot, base, "boxPlot", responses[0]!),
      ecdf: materializeGraph(rawGraphs.ecdf, defaults.ecdf, base, "ecdf", responses[0]!),
      normalQuantile: materializeGraph(rawGraphs.normalQuantile, defaults.normalQuantile, base, "normalQuantile", responses[0]!),
    },
  };
}

function assertMutable(): void {
  assertProjectMutable(useProjectStore.getState().readOnly);
}

export const useDistributionStore = create<DistributionStore>((set, get) => ({
  items: [],
  counter: 0,
  createItem: (input) => {
    assertMutable();
    const nextCounter = get().counter + 1;
    const name = input.name?.trim() || `Distribution ${nextCounter}`;
    const item = createDistributionItem({ ...input, name });
    set((state) => ({
      items: [...state.items, item],
      counter: input.name
        ? Math.max(state.counter, maxDistributionSuffix([item]))
        : nextCounter,
    }));
    return item;
  },
  addItem: (item) => {
    assertMutable();
    set((state) => ({
      items: [...state.items, structuredClone(item)],
      counter: Math.max(state.counter, maxDistributionSuffix([item])),
    }));
  },
  updateItem: (id, patch) => {
    assertMutable();
    set((state) => {
      const items = state.items.map((item) => item.id === id
        ? { ...item, ...structuredClone(patch) }
        : item);
      return { items, counter: Math.max(state.counter, maxDistributionSuffix(items)) };
    });
  },
  renameItem: (id, name) => {
    assertMutable();
    const trimmed = name.trim();
    if (!trimmed) return;
    set((state) => {
      const items = state.items.map((item) => item.id === id ? { ...item, name: trimmed } : item);
      return { items, counter: Math.max(state.counter, maxDistributionSuffix(items)) };
    });
  },
  deleteItem: (id) => {
    assertMutable();
    set((state) => ({ items: state.items.filter((item) => item.id !== id) }));
  },
  deleteByDataset: (datasetId) => {
    assertMutable();
    set((state) => ({ items: state.items.filter((item) => item.sourceDatasetId !== datasetId) }));
  },
  loadFromProject: (items) => {
    assertMutable();
    const normalized = items.flatMap((item) => {
      const loaded = normalizeLoadedItem(item);
      return loaded ? [loaded] : [];
    });
    set({ items: normalized, counter: maxDistributionSuffix(normalized) });
  },
  reset: () => {
    assertMutable();
    set({ items: [], counter: 0 });
  },
  nextName: () => {
    assertMutable();
    const counter = get().counter + 1;
    set({ counter });
    return `Distribution ${counter}`;
  },
}));
