import { invoke } from "@tauri-apps/api/core";
import type { DatasetMeta, TableQueryParams, TableQueryResult } from "@/types/data";

export const dataService = {
  /** 查询数据表（分页） */
  queryTable: (params: TableQueryParams) =>
    invoke<TableQueryResult>("query_table", { ...params }),

  /** 导入文件 */
  importFile: (filePath: string) =>
    invoke<DatasetMeta>("import_file", { filePath }),

  /** 获取所有数据集元数据 */
  listDatasets: () => invoke<DatasetMeta[]>("list_datasets"),

  /** 删除数据集 */
  deleteDataset: (datasetId: string) =>
    invoke<void>("delete_dataset", { datasetId }),
};
