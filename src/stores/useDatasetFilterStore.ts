import { createStore, type StoreApi } from "zustand/vanilla";
import { useStore } from "zustand";

import type { FilterRuleItem } from "@/types/filter";
import { useProjectStore } from "./useProjectStore";
import { assertProjectMutable } from "@/utils/saveReadOnly";

export type DatasetFilterMap = Record<string, FilterRuleItem[]>;

export interface DatasetFilterState {
  byDataset: DatasetFilterMap;
  replaceFilters: (datasetId: string, filters: readonly FilterRuleItem[]) => boolean;
  renameColumn: (datasetId: string, oldName: string, newName: string) => boolean;
  removeDataset: (datasetId: string) => boolean;
  loadFromProject: (payload: DatasetFilterMap) => void;
  toProjectPayload: () => DatasetFilterMap;
  reset: () => void;
}

export type DatasetFilterStoreState = DatasetFilterState;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function equal(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a)
      && Array.isArray(b)
      && a.length === b.length
      && a.every((value, index) => equal(value, b[index]));
  }
  const aRecord = a as Record<string, unknown>;
  const bRecord = b as Record<string, unknown>;
  const aKeys = Object.keys(aRecord).sort();
  const bKeys = Object.keys(bRecord).sort();
  return aKeys.length === bKeys.length
    && aKeys.every((key, index) => key === bKeys[index] && equal(aRecord[key], bRecord[key]));
}

function mutable(): void {
  assertProjectMutable(useProjectStore.getState().readOnly);
}

export function createDatasetFilterStore(): StoreApi<DatasetFilterStoreState> {
  return createStore<DatasetFilterStoreState>((set, get) => ({
    byDataset: {},

    replaceFilters: (datasetId, filters) => {
      const current = get().byDataset[datasetId] ?? [];
      if (filters.length === 0) {
        if (!(datasetId in get().byDataset)) return false;
        mutable();
        set((state) => {
          const byDataset = { ...state.byDataset };
          delete byDataset[datasetId];
          return { byDataset };
        });
        return true;
      }
      if (equal(current, filters)) return false;
      mutable();
      set((state) => ({
        byDataset: { ...state.byDataset, [datasetId]: clone([...filters]) },
      }));
      return true;
    },

    renameColumn: (datasetId, oldName, newName) => {
      const filters = get().byDataset[datasetId];
      if (!filters) return false;
      let changed = false;
      const renamed = clone(filters).map((item) => {
        if (item.rule.field.name !== oldName) return item;
        changed = true;
        return {
          ...item,
          rule: {
            ...item.rule,
            field: { ...item.rule.field, name: newName },
          },
        };
      });
      if (!changed) return false;
      mutable();
      set((state) => ({ byDataset: { ...state.byDataset, [datasetId]: renamed } }));
      return true;
    },

    removeDataset: (datasetId) => {
      if (!(datasetId in get().byDataset)) return false;
      mutable();
      set((state) => {
        const byDataset = { ...state.byDataset };
        delete byDataset[datasetId];
        return { byDataset };
      });
      return true;
    },

    loadFromProject: (payload) => {
      const byDataset: DatasetFilterMap = {};
      for (const [datasetId, filters] of Object.entries(payload)) {
        if (filters.length > 0) byDataset[datasetId] = clone(filters);
      }
      set({ byDataset });
    },

    toProjectPayload: () => clone(get().byDataset),

    reset: () => {
      set({ byDataset: {} });
    },
  }));
}

const datasetFilterStore = createDatasetFilterStore();

export const useDatasetFilterStore = Object.assign(
  <T>(selector: (state: DatasetFilterState) => T): T => useStore(datasetFilterStore, selector),
  datasetFilterStore,
) as StoreApi<DatasetFilterStoreState> & (<T>(selector: (state: DatasetFilterState) => T) => T);
