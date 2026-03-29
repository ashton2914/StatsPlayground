import { create } from "zustand";
import type { DatasetMeta } from "@/types/data";
import { dataService } from "@/services/dataService";

interface StatusInfo {
  cellLabel: string;
  selectionLabel: string;
  dimensions: string;
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
  /** 更新状态栏信息 */
  setStatusInfo: (info: StatusInfo | null) => void;
}

export const useDataStore = create<DataStore>((set) => ({
  activeDatasetId: null,
  datasets: [],
  statusInfo: null,

  setActiveDataset: (id) => set({ activeDatasetId: id }),

  refreshDatasets: async () => {
    const datasets = await dataService.listDatasets();
    set({ datasets });
  },

  setStatusInfo: (info) => set({ statusInfo: info }),
}));
