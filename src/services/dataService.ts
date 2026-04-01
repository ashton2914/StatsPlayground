import { invoke } from "@tauri-apps/api/core";
import type { ColumnDisplayProps, DatasetMeta, TableQueryParams, TableQueryResult } from "@/types/data";

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

  /** 添加列 */
  addColumn: (datasetId: string, colName: string, colType: string) =>
    invoke<void>("add_column", { datasetId, colName, colType }),

  /** 删除列 */
  deleteColumn: (datasetId: string, colName: string) =>
    invoke<void>("delete_column", { datasetId, colName }),

  /** 重命名列 */
  renameColumn: (datasetId: string, oldName: string, newName: string) =>
    invoke<void>("rename_column", { datasetId, oldName, newName }),

  /** 修改列类型 */
  changeColumnType: (datasetId: string, colName: string, newType: string) =>
    invoke<void>("change_column_type", { datasetId, colName, newType }),

  /** 粘贴数据到指定位置 */
  pasteAtPosition: (datasetId: string, startRow: number, startCol: number, rows: string[][], headerNames: string[] | null, colTypes: string[]) =>
    invoke<void>("paste_at_position", { datasetId, startRow, startCol, rows, headerNames, colTypes }),

  /** 恢复表快照（撤销/重做） */
  restoreSnapshot: (datasetId: string, colNames: string[], colTypes: string[], rows: unknown[][]) =>
    invoke<void>("restore_snapshot", { datasetId, colNames, colTypes, rows }),

  /** 获取列显示属性 */
  getColumnDisplayProps: (datasetId: string) =>
    invoke<ColumnDisplayProps[]>("get_column_display_props", { datasetId }),

  /** 设置列显示属性 */
  setColumnDisplayProps: (datasetId: string, props: ColumnDisplayProps[]) =>
    invoke<void>("set_column_display_props", { datasetId, props }),

  // ─── Table Operations ───

  /** 获取列信息 */
  getColumns: (datasetId: string) =>
    invoke<[string, string][]>("get_columns", { datasetId }),

  /** 排序 */
  sortTable: (sourceId: string, sortCols: string[], sortOrders: string[], newName: string) =>
    invoke<DatasetMeta>("sort_table", { sourceId, sortCols, sortOrders, newName }),

  /** 子集 */
  subsetTable: (sourceId: string, columns: string[], rowFilter: string | null, newName: string) =>
    invoke<DatasetMeta>("subset_table", { sourceId, columns, rowFilter, newName }),

  /** 转置 */
  transposeTable: (sourceId: string, newName: string) =>
    invoke<DatasetMeta>("transpose_table", { sourceId, newName }),

  /** 堆叠 (宽→长) */
  stackTable: (sourceId: string, stackCols: string[], idCols: string[], newName: string) =>
    invoke<DatasetMeta>("stack_table", { sourceId, stackCols, idCols, newName }),

  /** 拆分 (长→宽) */
  splitTable: (sourceId: string, splitCol: string, valueCol: string, idCols: string[], newName: string) =>
    invoke<DatasetMeta>("split_table", { sourceId, splitCol, valueCol, idCols, newName }),

  /** 汇总统计 */
  summaryTable: (sourceId: string, statCols: string[], groupCols: string[], statistics: string[], newName: string) =>
    invoke<DatasetMeta>("summary_table", { sourceId, statCols, groupCols, statistics, newName }),

  /** 连接 */
  joinTables: (leftId: string, rightId: string, joinType: string, leftKey: string, rightKey: string, newName: string) =>
    invoke<DatasetMeta>("join_tables", { leftId, rightId, joinType, leftKey, rightKey, newName }),

  /** 更新 */
  updateTable: (leftId: string, rightId: string, matchCol: string, updateCols: string[]) =>
    invoke<void>("update_table", { leftId, rightId, matchCol, updateCols }),

  /** 合并 (纵向拼接) */
  concatenateTables: (sourceIds: string[], newName: string) =>
    invoke<DatasetMeta>("concatenate_tables", { sourceIds, newName }),
};
