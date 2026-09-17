import { createStore, type StoreApi } from "zustand/vanilla";
import { useStore } from "zustand";

import type { TableWindowSort } from "@/types/data";
import { useProjectStore } from "./useProjectStore";
import { assertProjectMutable } from "@/utils/saveReadOnly";

export type DatasetTableSortMap = Record<string, TableWindowSort>;

export interface TableNavigationSortState {
  byDataset: DatasetTableSortMap;
  replaceSort: (datasetId: string, sort: TableWindowSort | null) => boolean;
  removeDataset: (datasetId: string) => boolean;
  reset: () => void;
}

function mutable(): void {
  assertProjectMutable(useProjectStore.getState().readOnly);
}

export function createTableNavigationSortStore(): StoreApi<TableNavigationSortState> {
  return createStore<TableNavigationSortState>((set, get) => ({
    byDataset: {},

    replaceSort: (datasetId, sort) => {
      const current = get().byDataset[datasetId] ?? null;
      if (
        current?.column === sort?.column
        && current?.descending === sort?.descending
      ) {
        return false;
      }
      mutable();
      set((state) => {
        if (!sort) {
          if (!(datasetId in state.byDataset)) {
            return state;
          }
          const byDataset = { ...state.byDataset };
          delete byDataset[datasetId];
          return { byDataset };
        }
        return { byDataset: { ...state.byDataset, [datasetId]: sort } };
      });
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

    reset: () => {
      set({ byDataset: {} });
    },
  }));
}

const tableNavigationSortStore = createTableNavigationSortStore();

export const useTableNavigationSortStore = Object.assign(
  <T>(selector: (state: TableNavigationSortState) => T): T => useStore(tableNavigationSortStore, selector),
  tableNavigationSortStore,
) as StoreApi<TableNavigationSortState> & (<T>(selector: (state: TableNavigationSortState) => T) => T);