import { createStore, type StoreApi } from "zustand/vanilla";
import { useStore } from "zustand";

export interface TableViewportPosition {
  logicalStart: number;
  logicalQuerySignature: string;
  scrollLeft: number;
}

export interface TableViewportState {
  byDataset: Record<string, TableViewportPosition>;
  setPosition: (datasetId: string, patch: Partial<TableViewportPosition>) => void;
  removeDataset: (datasetId: string) => void;
  retainDatasets: (datasetIds: readonly string[]) => void;
  reset: () => void;
}

const DEFAULT_POSITION: TableViewportPosition = {
  logicalStart: 0,
  logicalQuerySignature: "",
  scrollLeft: 0,
};

export function createTableViewportStore(): StoreApi<TableViewportState> {
  return createStore<TableViewportState>((set, get) => ({
    byDataset: {},

    setPosition: (datasetId, patch) => {
      const current = get().byDataset[datasetId] ?? DEFAULT_POSITION;
      const next = { ...current, ...patch };
      if (
        next.logicalStart === current.logicalStart
        && next.logicalQuerySignature === current.logicalQuerySignature
        && next.scrollLeft === current.scrollLeft
      ) {
        return;
      }
      set((state) => ({
        byDataset: { ...state.byDataset, [datasetId]: next },
      }));
    },

    removeDataset: (datasetId) => {
      if (!(datasetId in get().byDataset)) return;
      set((state) => {
        const byDataset = { ...state.byDataset };
        delete byDataset[datasetId];
        return { byDataset };
      });
    },

    retainDatasets: (datasetIds) => {
      const retained = new Set(datasetIds);
      const current = get().byDataset;
      if (Object.keys(current).every((datasetId) => retained.has(datasetId))) return;
      set({
        byDataset: Object.fromEntries(
          Object.entries(current).filter(([datasetId]) => retained.has(datasetId)),
        ),
      });
    },

    reset: () => {
      set({ byDataset: {} });
    },
  }));
}

const tableViewportStore = createTableViewportStore();

export const useTableViewportStore = Object.assign(
  <T>(selector: (state: TableViewportState) => T): T => useStore(tableViewportStore, selector),
  tableViewportStore,
) as StoreApi<TableViewportState> & (<T>(selector: (state: TableViewportState) => T) => T);
