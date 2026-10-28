import { useProjectStore } from "@/stores/useProjectStore";
import type { ProjectMutationCommand } from "@/projectPersistence/coordinator";
import { invoke } from "@tauri-apps/api/core";
import type {
  ColumnDisplayProps,
  ColumnDescriptor,
  ColumnMutationResult,
  CalculatedColumnMutationResult,
  CalculatedColumnValidation,
  CellPosition,
  CellUpdate,
  CreateManagedTableRequest,
  ManagedTableCreateResult,
  DatasetMeta,
  CreateTableFromRowsRequest,
  SqlQueryResult,
  TableFilterValue,
  TableNavigationBenchmarkFixture,
  TableNavigationBenchmarkRequest,
  TableNavigationRequest,
  TableNavigationResult,
  TableQuerySessionRequest,
  TableQuerySessionStatus,
  TableQueryParams,
  TableQueryResult,
  TableWindowRequest,
  TableWindowResult,
  RowMutationResult,
  UpsertCalculatedColumnRequest,
  ValidateCalculatedColumnRequest,
} from "@/types/data";

async function invokeProjectTableMutation<T>(command: ProjectMutationCommand, args: Record<string, unknown>, datasetId: string, expectedGeneration?: number): Promise<T> {
  const persistence = useProjectStore.getState().persistence;
  if (!persistence) return invoke<T>(command,args);
  const generation = expectedGeneration ?? await invoke<number>("get_dataset_generation",{ datasetId });
  if (useProjectStore.getState().persistence !== persistence) throw new Error("Project changed before mutation");
  const commit = await persistence.submit<T>({ command,payload:args,datasetGenerations:[{id:datasetId,generation}] });
  return commit.value;
}

async function invokeProjectCreation<T>(command: ProjectMutationCommand,args: Record<string,unknown>): Promise<T> {
  const persistence=useProjectStore.getState().persistence;
  if (!persistence) return invoke<T>(command,args);
  return (await persistence.submit<T>({command,payload:args})).value;
}

/** Resolve only physical row IDs, in bounded pages of the current query mapping. */
async function resolveTablePasteRowIds(
  request: Omit<TableNavigationRequest, "requestId">,
  isCurrent: () => boolean,
): Promise<number[]> {
  if (!Number.isSafeInteger(request.start) || request.start < 0 || !Number.isSafeInteger(request.count) || request.count < 1 || request.count > 100_000) {
    throw new Error("paste_row_identity_range_invalid");
  }
  const ids: number[] = [];
  const unique = new Set<number>();
  while (ids.length < request.count) {
    if (!isCurrent()) throw new Error("paste_row_identity_owner_changed");
    const start = request.start + ids.length;
    const count = Math.min(2000, request.count - ids.length);
    const requestId = `paste-rows:${crypto.randomUUID()}`;
    const result = await invoke<TableNavigationResult>("query_table_navigation_row_ids", {
      request: { ...request, start, count, requestId, includeTransportDiagnostics: false },
    });
    if (!isCurrent()) throw new Error("paste_row_identity_owner_changed");
    if (result.version !== 1 || result.requestId !== requestId || result.datasetId !== request.datasetId
      || result.generation !== request.generation || result.start !== start
      || (result.sessionId ?? null) !== (request.sessionId ?? null)
      || result.columns.length !== 1 || result.columns[0] !== "_row_id" || result.rows.length !== count) {
      throw new Error("paste_row_identity_window_stale_or_incomplete");
    }
    for (const row of result.rows) {
      const id = row[0];
      if (row.length !== 1 || typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0 || unique.has(id)) {
        throw new Error("paste_row_identity_invalid");
      }
      unique.add(id); ids.push(id);
    }
  }
  return ids;
}

export const dataService = {
  resolveTablePasteRowIds,
  /** 执行 SQL 查询（分页） */
  executeSqlQuery: (sql: string, page: number, pageSize = 200) =>
    invoke<SqlQueryResult>("execute_sql_query", { sql, page, pageSize }),

  /** 根据 SQL 查询创建数据表 */
  preflightCreateTableFromSqlQuery: (sql: string, name: string) =>
    invoke<void>("preflight_create_table_from_sql_query", { sql, name }),

  /** 根据 SQL 查询创建数据表 */
  createTableFromSqlQuery: (sql: string, name: string) =>
    invokeProjectCreation<DatasetMeta>("create_table_from_sql_query", { sql, name }),

  /** 查询数据表（分页） */
  queryTable: (params: TableQueryParams) =>
    invoke<TableQueryResult>("query_table", { ...params }),

  /** 查询数据表的有界行窗口 */
  queryTableWindow: (request: TableWindowRequest) =>
    invoke<TableWindowResult>("query_table_window", { request }),

  /** 按稳定列 ID 查询数据表的可见列窗口 */
  queryTableNavigationWindow: (request: TableNavigationRequest) =>
    invoke<TableNavigationResult>("query_table_navigation_window", { request }),

  /** 准备仅供本地基准使用的确定性大表导航数据集 */
  prepareTableNavigationBenchmark: (request: TableNavigationBenchmarkRequest) =>
    invoke<TableNavigationBenchmarkFixture>("prepare_table_navigation_benchmark", { request }),

  /** 为筛选/排序签名准备或复用后端窗口查询会话 */
  prepareTableQuerySession: (request: TableQuerySessionRequest) =>
    invoke<TableQuerySessionStatus>("prepare_table_query_session", { request }),

  /** 查询后端窗口查询会话状态 */
  getTableQuerySessionStatus: (sessionId: string) =>
    invoke<TableQuerySessionStatus>("get_table_query_session_status", { sessionId }),

  /** 释放后端窗口查询会话 */
  releaseTableQuerySession: (sessionId: string) =>
    invoke<void>("release_table_query_session", { sessionId }),

  /** 取消指定的可见列窗口导航请求 */
  cancelTableNavigationRequest: (requestId: string) =>
    invoke<void>("cancel_table_navigation_request", { requestId }),

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
  ) => invoke<TableFilterValue[]>("query_table_filter_values", {
    datasetId,
    field,
    search,
    limit,
    generation,
  }),

  /** 导入文件 */
  importFile: (filePath: string) =>
    invokeProjectCreation<DatasetMeta>("import_file", { filePath }),

  /** 获取所有数据集元数据 */
  listDatasets: () => invoke<DatasetMeta[]>("list_datasets"),

  /** 删除数据集 */
  deleteDataset: (datasetId: string) =>
    invokeProjectTableMutation<void>("delete_dataset", { datasetId },datasetId),

  /** 创建空数据表 */
  createTable: (name: string, columnNames: string[], columnTypes: string[]) => {
    if (!useProjectStore.getState().persistence) return invoke<DatasetMeta>("create_table", { name, columnNames, columnTypes });
    return invokeProjectCreation<DatasetMeta>("create_table_from_rows",{request:{name,columnNames,columnTypes,rows:[]}});
  },

  /** 通过类型化行数据原子创建数据表 */
  createTableFromRows: (request: CreateTableFromRowsRequest) =>
    invokeProjectCreation<DatasetMeta>("create_table_from_rows", { request }),

  /** 原子创建数据表并持久化完整列显示属性 */
  createManagedTable: (request: CreateManagedTableRequest) =>
    invokeProjectCreation<ManagedTableCreateResult>("create_managed_table", { request }),

  /** 添加空行 */
  addRow: (datasetId: string) => invoke<number>("add_row", { datasetId }),

  /** 原子添加多个空行，并返回 compact history 所需的行 ID 和版本 */
  addRows: (
    datasetId: string,
    count: number,
    beforeRowId: number | null,
    expectedGeneration: number,
  ) => invokeProjectTableMutation<RowMutationResult>("add_rows", {
    datasetId,
    count,
    beforeRowId,
    expectedGeneration,
  },datasetId,expectedGeneration),

  /** 撤销或重做一次新增空行操作 */
  applyAddedRows: (datasetId: string, rowIds: number[], undo: boolean, expectedGeneration: number) =>
    invoke<number>("apply_added_rows", { datasetId, rowIds, undo, expectedGeneration }),

  /** 更新单元格 */
  updateCell: (datasetId: string, rowId: number, columnName: string, value: string, expectedGeneration?: number) => {
    if(!useProjectStore.getState().persistence)return invoke<void>("update_cell", { datasetId, rowId, columnName, value });
    return invokeProjectTableMutation<number>("update_cells",{datasetId,updates:[{rowId,columnName,value:value===""?null:value}],expectedGeneration},datasetId,expectedGeneration).then(()=>undefined);
  },

  /** 原子清空多个单元格 */
  clearCells: (datasetId: string, cells: CellPosition[]) =>
    invokeProjectTableMutation<void>("clear_cells", { datasetId, cells },datasetId),

  /** 原子更新多个单元格，用于增量撤销/重做 */
  updateCells: (datasetId: string, updates: CellUpdate[], expectedGeneration: number) =>
    invokeProjectTableMutation<number>("update_cells", { datasetId, updates, expectedGeneration },datasetId,expectedGeneration),

  /** 删除行 */
  deleteRow: (datasetId: string, rowId: number) =>
    invoke<void>("delete_row", { datasetId, rowId }),

  /** 原子删除多行 */
  deleteRows: (datasetId: string, rowIds: number[]) =>
    invoke<void>("delete_rows", { datasetId, rowIds }),

  /** 原子删除多行，并在后端保留完整 before image */
  deleteRowsWithChangeSet: (datasetId: string, rowIds: number[], expectedGeneration: number) =>
    invokeProjectTableMutation<RowMutationResult>("delete_rows_with_change_set", {
      datasetId,
      rowIds,
      expectedGeneration,
    },datasetId,expectedGeneration),

  /** 删除列并在后端保留完整列 before image */
  deleteColumnsWithChangeSet: (
    datasetId: string,
    columns: ColumnDescriptor[],
    expectedGeneration: number,
  ) => invokeProjectTableMutation<ColumnMutationResult>("delete_columns_with_change_set", {
    datasetId,
    columns,
    expectedGeneration,
  },datasetId,expectedGeneration),

  /** 原子重命名/转换列，并保留有损转换的 before/after image */
  alterColumnWithChangeSet: (
    datasetId: string,
    oldName: string,
    newName: string,
    newType: string,
    expectedGeneration: number,
  ) => invokeProjectTableMutation<string>("alter_column_with_change_set", {
    datasetId,
    oldName,
    newName,
    newType,
    expectedGeneration,
  },datasetId,expectedGeneration),

  /** 原子转换多列类型，并在后端保留有损转换 before/after image */
  alterColumnsTypeWithChangeSet: (
    datasetId: string,
    columnNames: string[],
    newType: string,
    expectedGeneration: number,
  ) => invokeProjectTableMutation<string>("alter_columns_type_with_change_set", {
    datasetId,
    columnNames,
    newType,
    expectedGeneration,
  },datasetId,expectedGeneration),

  /** 重命名数据集 */
  renameDataset: (datasetId: string, newName: string) =>
    invokeProjectTableMutation<void>("rename_dataset", { datasetId, newName },datasetId),

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
    columns: ColumnDescriptor[],
    atIndex: number | null,
    expectedGeneration: number,
  ) => invokeProjectTableMutation<ColumnMutationResult>("add_columns_with_change_set", {
    datasetId,
    columns,
    atIndex,
    expectedGeneration,
  },datasetId,expectedGeneration),

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
  ) => invokeProjectTableMutation<number>("reorder_column_if_generation", {
    datasetId,
    from,
    to,
    expectedGeneration,
  },datasetId,expectedGeneration),

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
  pasteAtPositionWithChangeSet: async (datasetId: string, startRow: number, startCol: number, rows: string[][], headerNames: string[] | null, colTypes: string[], expectedGeneration?: number, rowIds?:number[], columnIds?:string[]) => {
    type Result={changeSetId:string;generation?:number;rowCount?:number;columnCount?:number};
    const owner=useProjectStore.getState().persistence;
    const args={datasetId,startRow,startCol,rows,headerNames,colTypes,expectedGeneration};
    if(!owner) return invoke<Result>("paste_at_position_with_change_set",args);
    const boundColumns=columnIds??(await invoke<ColumnDescriptor[]>("get_column_descriptors",{datasetId})).map(column=>column.columnId);
    if(useProjectStore.getState().persistence!==owner) throw new Error("Project changed before mutation");
    return invokeProjectTableMutation<Result>("paste_at_position_with_change_set",{...args,columnIds:boundColumns,...(rowIds?{rowIds}:{})},datasetId,expectedGeneration);
  },

  /** 原子撤销或重做后端 change set */
  applyTableLifecycle: async (eventId:string,undo:boolean):Promise<void> => {
    const owner=useProjectStore.getState().persistence;
    if(!owner) throw new Error("Native project required for table history");
    const {projectService}=await import("./projectService");
    if(useProjectStore.getState().persistence!==owner)throw new Error("Project changed before table history replay");
    const event=await projectService.getTableLifecycleEvent(owner.snapshot().epoch,eventId);
    if(useProjectStore.getState().persistence!==owner)throw new Error("Project changed before table history replay");
    if(event.id!==eventId||typeof event.datasetId!=="string"||!event.datasetId
      ||!["create_table","delete_table"].includes(event.operation)||typeof event.applied!=="boolean"
      ||!Number.isSafeInteger(event.revision)||event.revision<1
      ||!Number.isSafeInteger(event.historyOrdinal)||event.historyOrdinal<0
      ||!Number.isSafeInteger(event.projectRevision)||event.projectRevision<1
      ||(event.datasetGeneration!==null&&(!Number.isSafeInteger(event.datasetGeneration)||event.datasetGeneration<0)))throw new Error("table_lifecycle_event_invalid");
    if(event.applied!==undo)throw new Error("table_lifecycle_event_stale");
    await owner.submit<null>({command:"apply_project_table_lifecycle",payload:{eventId,eventRevision:event.revision,undo},
      datasetGenerations:event.datasetGeneration===null?[]:[{id:event.datasetId,generation:event.datasetGeneration}]});
  },

  applyTableChangeSet: (changeSetId: string, undo: boolean, datasetId?: string) => {
    if (!useProjectStore.getState().persistence) return invoke<void>("apply_table_change_set", { changeSetId, undo });
    if (!datasetId) return Promise.reject(new Error("Native history replay requires its dataset"));
    return invokeProjectTableMutation<void>("apply_table_change_set", { changeSetId, undo, datasetId },datasetId);
  },

  /** 释放 history eviction/reset 后不再可达的后端 change set */
  dropTableChangeSet: (changeSetId: string) =>
    invoke<void>("drop_table_change_set", { changeSetId }),

  /** 恢复表快照（撤销/重做） */
  restoreSnapshot: (datasetId: string, colNames: string[], colTypes: string[], rows: unknown[][]) =>
    invoke<void>("restore_snapshot", { datasetId, colNames, colTypes, rows }),

  /** 获取列显示属性 */
  getColumnDisplayProps: (datasetId: string) => {
    const persistence=useProjectStore.getState().persistence;
    return invoke<ColumnDisplayProps[]>("get_column_display_props",persistence?{datasetId,epoch:persistence.snapshot().epoch}:{datasetId});
  },

  /** 设置列显示属性 */
  setColumnDisplayProps: async (datasetId: string, props: ColumnDisplayProps[]) => {
    const persistence=useProjectStore.getState().persistence;
    if(!persistence) return invoke<void>("set_column_display_props",{datasetId,props});
    const columns=await invoke<ColumnDescriptor[]>("get_column_descriptors",{datasetId});
    if(useProjectStore.getState().persistence!==persistence) throw new Error("Project changed before mutation");
    return invokeProjectTableMutation<void>("set_column_display_props",{datasetId,props,columnIds:columns.map(column=>column.columnId)},datasetId);
  },

  // ─── Table Operations ───

  /** 获取列信息 */
  getColumns: (datasetId: string) =>
    invoke<[string, string][]>("get_columns", { datasetId }),

  /** 获取带稳定 ID 的列描述符 */
  getColumnDescriptors: (datasetId: string) =>
    invoke<ColumnDescriptor[]>("get_column_descriptors", { datasetId }),

  validateCalculatedColumn: (request: ValidateCalculatedColumnRequest) =>
    invoke<CalculatedColumnValidation>("validate_calculated_column", { request }),

  upsertCalculatedColumn: (request: UpsertCalculatedColumnRequest) =>
    invokeProjectTableMutation<CalculatedColumnMutationResult>("upsert_calculated_column", { request },request.datasetId,request.expectedGeneration??undefined),

  convertCalculatedColumnToValues: (datasetId: string, columnId: string, expectedGeneration: number) =>
    invokeProjectTableMutation<CalculatedColumnMutationResult>("convert_calculated_column_to_values", {
      datasetId,
      columnId,
      expectedGeneration,
    },datasetId,expectedGeneration),

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
