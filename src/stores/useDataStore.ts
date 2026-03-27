import { create } from "zustand";
import type { DatasetMeta } from "@/types/data";
import { dataService } from "@/services/dataService";

interface DataStore {
  /** 当前选中的数据集 ID */
  activeDatasetId: string | null;
  /** 所有数据集元信息 */
  datasets: DatasetMeta[];
  /** 设置当前活动数据集 */
  setActiveDataset: (id: string | null) => void;
  /** 从后端刷新数据集列表 */
  refreshDatasets: () => Promise<void>;
}

export const useDataStore = create<DataStore>((set) => ({
  activeDatasetId: null,
  datasets: [],

  setActiveDataset: (id) => set({ activeDatasetId: id }),

  refreshDatasets: async () => {
    const datasets = await dataService.listDatasets();
    set({ datasets });
  },
}));
