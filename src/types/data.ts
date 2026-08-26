/** 数据集元数据 */
export interface DatasetMeta {
  id: string;
  name: string;
  sourcePath: string | null;
  sourceType: "csv" | "excel" | "parquet" | "json" | "manual" | "query";
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
  datasetId: string;
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

export interface TableWindowSort {
  column: string;
  descending: boolean;
}

export type TableWindowFilterRule =
  | { kind: "continuous"; field: string; min: number | null; max: number | null }
  | { kind: "categorical"; field: string; selected: string[]; exclude?: boolean }
  | { kind: "date"; field: string; start: string | null; end: string | null };

export interface TableWindowFilter {
  op: "AND" | "OR";
  rule: TableWindowFilterRule;
}

export interface TableWindowRequest {
  datasetId: string;
  start: number;
  count: number;
  sort: TableWindowSort | null;
  filters: TableWindowFilter[];
  generation: number;
}

export interface TableWindowResult {
  columns: string[];
  columnTypes: string[];
  rows: unknown[][];
  totalRows: number;
  start: number;
  generation: number;
}

export interface CellPosition {
  rowId: number;
  columnName: string;
}

export interface CellUpdate extends CellPosition {
  value: string | null;
}

/** SQL query result */
export interface SqlQueryResult {
  columns: string[];
  columnTypes: string[];
  rows: unknown[][];
  totalRows: number;
  page: number;
  pageSize: number;
  executionTimeMs: number;
}

/** 列显示格式 */
export interface ColumnFormatInfo {
  kind: string;
  decimals?: number;
  currency?: string;
}

/** 列显示属性（含可选的"附加属性"） */
export interface ColumnDisplayProps {
  colIndex: number;
  width?: number;
  format?: ColumnFormatInfo;
  /**
   * 附加属性键值表，键为附加属性 kind（如 "unit"/"spec"/"range"/"notes"），
   * 值的形状由前端 `columnExtras` 注册表定义；后端按不透明 JSON 处理。
   */
  extras?: Record<string, unknown>;
}

export interface CreateTableFromRowsRequest {
  name: string;
  columnNames: string[];
  columnTypes: string[];
  rows: Array<Array<string | number | boolean | null>>;
}
