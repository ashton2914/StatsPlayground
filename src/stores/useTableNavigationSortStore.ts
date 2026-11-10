import { createStore, type StoreApi } from "zustand/vanilla";
import { useStore } from "zustand";

import type { ColumnDescriptor, TableWindowSort } from "@/types/data";
import { reconcileTableSortIdentity } from "@/utils/tableSortIdentity";
import { useProjectStore } from "./useProjectStore";
import { assertProjectMutable } from "@/utils/saveReadOnly";

export type DatasetTableSortMap = Record<string, TableWindowSort>;

export interface TableNavigationSortState {
  byDataset: DatasetTableSortMap;
  replaceSort: (datasetId: string, sort: TableWindowSort | null) => boolean;
  reconcileColumns: (datasetId: string, previous: readonly ColumnDescriptor[], current: readonly ColumnDescriptor[]) => TableWindowSort | null;
  removeDataset: (datasetId: string) => boolean;
  reset: () => void;
}

function mutable(): void {
  assertProjectMutable(useProjectStore.getState().readOnly);
}

export function createTableNavigationSortStore(): StoreApi<TableNavigationSortState> {
  return createStore<TableNavigationSortState>((set, get) => ({
    byDataset: {},

    // Schema refreshes resolve the existing navigation choice, including while a save locks edits.
    reconcileColumns: (datasetId, previous, current) => {
      const sort = get().byDataset[datasetId] ?? null;
      const resolved = reconcileTableSortIdentity(sort, previous, current);
      if (resolved === sort) return sort;
      set((state) => {
        const byDataset = { ...state.byDataset };
        if (resolved) byDataset[datasetId] = resolved;
        else delete byDataset[datasetId];
        return { byDataset };
      });
      return resolved;
    },

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
