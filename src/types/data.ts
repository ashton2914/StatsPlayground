/** 数据集元数据 */
export interface DatasetMeta {
  id: string;
  name: string;
  sourcePath: string | null;
  sourceType: "csv" | "excel" | "parquet" | "json" | "manual";
  rowCount: number;
  colCount: number;
  createdAt: string;
  updatedAt: string;
}

/** 列元数据 */
export interface ColumnMeta {
  colIndex: number;
  colName: string;
  colType: string;
  role: "continuous" | "nominal" | "ordinal" | "id";
  missingCount: number;
}

/** 表查询参数 */
export interface TableQueryParams {
  tableName: string;
  page: number;
  pageSize: number;
  sortBy?: string;
  sortOrder?: "asc" | "desc";
  filters?: TableFilter[];
}

/** 表筛选条件 */
export interface TableFilter {
  column: string;
  op: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "contains" | "is_null" | "not_null";
  value?: string | number;
}

/** 表查询结果 */
export interface TableQueryResult {
  columns: string[];
  columnTypes: string[];
  rows: unknown[][];
  totalRows: number;
  page: number;
  pageSize: number;
}
