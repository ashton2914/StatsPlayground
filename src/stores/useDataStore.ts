import { create } from "zustand";
import type { DatasetMeta } from "@/types/data";
import {useProjectStore} from "./useProjectStore";
import { dataService } from "@/services/dataService";

interface SelectionStats {
  count: number;
  sum?: number;
  avg?: number;
  min?: number;
  max?: number;
}

interface TableCacheDiagnostics {
  cacheHit: boolean | null;
  diagnosticJsonEncodeMs: number | null;
  postReceivePaintMs: number | null;
  diagnosticJsonBytes: number | null;
  retainedRows: number;
  estimatedBytes: number;
  entryCount: number;
}

interface StatusInfo {
  cellLabel: string;
  selectionLabel: string;
  dimensions: string;
  selectionStats?: SelectionStats;
  tableCacheDiagnostics?: TableCacheDiagnostics;
}

interface DataStore {
  /** 当前选中的数据集 ID */
  activeDatasetId: string | null;
  /** 所有数据集元信息 */
  datasets: DatasetMeta[];
  /** 状态栏信息：单元格位置 + 表格维度 */
  statusInfo: StatusInfo | null;
  /** 设置当前活动数据集 */
  setActiveDataset: (id: string | null) => void;
  /** 从后端刷新数据集列表 */
  refreshDatasets: () => Promise<void>;
  /** Apply authoritative metadata returned by a scoped table mutation. */
  applyDatasetMutationMeta: (
    datasetId: string,
    patch: { generation: number; rowCount?: number; colCount?: number },
  ) => void;
  /** 更新状态栏信息 */
  setStatusInfo: (info: StatusInfo | null) => void;
}

let refreshSequence=0;

export const useDataStore = create<DataStore>((set) => ({
  activeDatasetId: null,
  datasets: [],
  statusInfo: null,

  setActiveDataset: (id) => set({ activeDatasetId: id }),

  refreshDatasets: async () => {
    const {persistence:owner,project}=useProjectStore.getState();
    const revision=owner?.snapshot().committedRevision;
    const request=++refreshSequence;
    const datasets = await dataService.listDatasets();
    const current=useProjectStore.getState();
    if(current.persistence!==owner||(!owner&&current.project!==project)||request!==refreshSequence
      ||owner?.snapshot().committedRevision!==revision) return;
    set({ datasets });
  },

  applyDatasetMutationMeta: (datasetId, patch) => set((state) => ({
    datasets: state.datasets.map((dataset) => dataset.id === datasetId
      ? {
          ...dataset,
          generation: patch.generation,
          ...(patch.rowCount === undefined ? {} : { rowCount: patch.rowCount }),
          ...(patch.colCount === undefined ? {} : { colCount: patch.colCount }),
        }
      : dataset),
  })),

  setStatusInfo: (info) => set({ statusInfo: info }),
}));
