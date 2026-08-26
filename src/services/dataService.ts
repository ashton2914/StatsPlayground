import { invoke } from "@tauri-apps/api/core";
import type {
  ColumnDisplayProps,
  CellPosition,
  CellUpdate,
  DatasetMeta,
  CreateTableFromRowsRequest,
  SqlQueryResult,
  TableQueryParams,
  TableQueryResult,
  TableWindowRequest,
  TableWindowResult,
} from "@/types/data";

export const dataService = {
  /** 执行 SQL 查询（分页） */
  executeSqlQuery: (sql: string, page: number, pageSize = 200) =>
    invoke<SqlQueryResult>("execute_sql_query", { sql, page, pageSize }),

  /** 根据 SQL 查询创建数据表 */
  createTableFromSqlQuery: (sql: string, name: string) =>
    invoke<DatasetMeta>("create_table_from_sql_query", { sql, name }),

  /** 查询数据表（分页） */
  queryTable: (params: TableQueryParams) =>
    invoke<TableQueryResult>("query_table", { ...params }),

  /** 查询数据表的有界行窗口 */
  queryTableWindow: (request: TableWindowRequest) =>
    invoke<TableWindowResult>("query_table_window", { request }),

  /** 获取数据表当前版本，用于窗口缓存失效 */
  getDatasetGeneration: (datasetId: string) =>
    invoke<number>("get_dataset_generation", { datasetId }),

  /** 定位行 ID 在当前服务端筛选顺序中的逻辑索引 */
  locateTableRow: (
    datasetId: string,
    rowId: number,
    filters: TableWindowRequest["filters"],
    generation: number,
  ) => invoke<number | null>("locate_table_row", { datasetId, rowId, filters, generation }),

  /** 搜索数据表列的分类筛选候选值，最多返回 limit 项 */
  queryTableFilterValues: (
    datasetId: string,
    field: string,
    search: string,
    limit: number,
    generation: number,
  ) => invoke<string[]>("query_table_filter_values", {
    datasetId,
    field,
    search,
    limit,
    generation,
  }),

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

  /** 通过类型化行数据原子创建数据表 */
  createTableFromRows: (request: CreateTableFromRowsRequest) =>
    invoke<DatasetMeta>("create_table_from_rows", { request }),

  /** 添加空行 */
  addRow: (datasetId: string) => invoke<number>("add_row", { datasetId }),

  /** 原子添加多个空行，并返回 compact history 所需的行 ID 和版本 */
  addRows: (datasetId: string, count: number) =>
    invoke<{ rowIds: number[]; generation: number }>("add_rows", { datasetId, count }),

  /** 撤销或重做一次新增空行操作 */
  applyAddedRows: (datasetId: string, rowIds: number[], undo: boolean, expectedGeneration: number) =>
    invoke<number>("apply_added_rows", { datasetId, rowIds, undo, expectedGeneration }),

  /** 更新单元格 */
  updateCell: (datasetId: string, rowId: number, columnName: string, value: string) =>
    invoke<void>("update_cell", { datasetId, rowId, columnName, value }),

  /** 原子清空多个单元格 */
  clearCells: (datasetId: string, cells: CellPosition[]) =>
    invoke<void>("clear_cells", { datasetId, cells }),

  /** 原子更新多个单元格，用于增量撤销/重做 */
  updateCells: (datasetId: string, updates: CellUpdate[], expectedGeneration: number) =>
    invoke<number>("update_cells", { datasetId, updates, expectedGeneration }),

  /** 删除行 */
  deleteRow: (datasetId: string, rowId: number) =>
    invoke<void>("delete_row", { datasetId, rowId }),

  /** 原子删除多行 */
  deleteRows: (datasetId: string, rowIds: number[]) =>
    invoke<void>("delete_rows", { datasetId, rowIds }),

  /** 原子删除多行，并在后端保留完整 before image */
  deleteRowsWithChangeSet: (datasetId: string, rowIds: number[], expectedGeneration: number) =>
    invoke<string>("delete_rows_with_change_set", { datasetId, rowIds, expectedGeneration }),

  /** 删除列并在后端保留完整列 before image */
  deleteColumnsWithChangeSet: (
    datasetId: string,
    columnNames: string[],
    expectedGeneration: number,
  ) => invoke<string>("delete_columns_with_change_set", {
    datasetId,
    columnNames,
    expectedGeneration,
  }),

  /** 原子重命名/转换列，并保留有损转换的 before/after image */
  alterColumnWithChangeSet: (
    datasetId: string,
    oldName: string,
    newName: string,
    newType: string,
    expectedGeneration: number,
  ) => invoke<string>("alter_column_with_change_set", {
    datasetId,
    oldName,
    newName,
    newType,
    expectedGeneration,
  }),

  /** 原子转换多列类型，并在后端保留有损转换 before/after image */
  alterColumnsTypeWithChangeSet: (
    datasetId: string,
    columnNames: string[],
    newType: string,
    expectedGeneration: number,
  ) => invoke<string>("alter_columns_type_with_change_set", {
    datasetId,
    columnNames,
    newType,
    expectedGeneration,
  }),

  /** 重命名数据集 */
  renameDataset: (datasetId: string, newName: string) =>
    invoke<void>("rename_dataset", { datasetId, newName }),

  /** 添加列 */
  addColumn: (datasetId: string, colName: string, colType: string) =>
    invoke<void>("add_column", { datasetId, colName, colType }),

  /** 添加列并返回 metadata-only history change set */
  addColumnWithChangeSet: (
    datasetId: string,
    colName: string,
    colType: string,
    atIndex: number | null,
    expectedGeneration: number,
  ) => invoke<string>("add_column_with_change_set", {
    datasetId,
    colName,
    colType,
    atIndex,
    expectedGeneration,
  }),

  /** 原子添加多列并返回一个 metadata-only history change set */
  addColumnsWithChangeSet: (
    datasetId: string,
    columns: Array<{ name: string; columnType: string }>,
    atIndex: number | null,
    expectedGeneration: number,
  ) => invoke<string>("add_columns_with_change_set", {
    datasetId,
    columns,
    atIndex,
    expectedGeneration,
  }),

  /** 在指定位置插入列（0 基，位于可见列中的索引） */
  insertColumnAt: (datasetId: string, colName: string, colType: string, atIndex: number) =>
    invoke<void>("insert_column_at", { datasetId, colName, colType, atIndex }),

  /** 调整列顺序（将 from 处的列移动到 to 处） */
  reorderColumn: (datasetId: string, from: number, to: number) =>
    invoke<void>("reorder_column", { datasetId, from, to }),

  /** 带版本保护地调整列顺序，用于 compact history replay */
  reorderColumnIfGeneration: (
    datasetId: string,
    from: number,
    to: number,
    expectedGeneration: number,
  ) => invoke<number>("reorder_column_if_generation", {
    datasetId,
    from,
    to,
    expectedGeneration,
  }),

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
  pasteAtPosition: (datasetId: string, startRow: number, startCol: number, rows: string[][], headerNames: string[] | null, colTypes: string[], expectedGeneration?: number) =>
    invoke<void>("paste_at_position", { datasetId, startRow, startCol, rows, headerNames, colTypes, expectedGeneration }),

  /** 粘贴并在后端保留有界 before/after image，前端只持有 opaque ID */
  pasteAtPositionWithChangeSet: (datasetId: string, startRow: number, startCol: number, rows: string[][], headerNames: string[] | null, colTypes: string[], expectedGeneration?: number) =>
    invoke<{ changeSetId: string }>("paste_at_position_with_change_set", { datasetId, startRow, startCol, rows, headerNames, colTypes, expectedGeneration }),

  /** 原子撤销或重做后端 change set */
  applyTableChangeSet: (changeSetId: string, undo: boolean) =>
    invoke<void>("apply_table_change_set", { changeSetId, undo }),

  /** 释放 history eviction/reset 后不再可达的后端 change set */
  dropTableChangeSet: (changeSetId: string) =>
    invoke<void>("drop_table_change_set", { changeSetId }),

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
