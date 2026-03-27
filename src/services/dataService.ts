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

  /** 创建空数据表 */
  createTable: (name: string, columnNames: string[], columnTypes: string[]) =>
    invoke<DatasetMeta>("create_table", { name, columnNames, columnTypes }),

  /** 添加空行 */
  addRow: (datasetId: string) => invoke<number>("add_row", { datasetId }),

  /** 更新单元格 */
  updateCell: (datasetId: string, rowId: number, columnName: string, value: string) =>
    invoke<void>("update_cell", { datasetId, rowId, columnName, value }),

  /** 删除行 */
  deleteRow: (datasetId: string, rowId: number) =>
    invoke<void>("delete_row", { datasetId, rowId }),

  /** 重命名数据集 */
  renameDataset: (datasetId: string, newName: string) =>
    invoke<void>("rename_dataset", { datasetId, newName }),
};
