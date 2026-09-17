/** 数据集元数据 */
export interface DatasetMeta {
  id: string;
  name: string;
  sourcePath: string | null;
  sourceType: "csv" | "excel" | "parquet" | "json" | "sqlite" | "sptb" | "manual" | "query";
  rowCount: number;
  colCount: number;
  generation: number;
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

export interface ColumnDescriptor {
  columnId: string;
  name: string;
  sqlType: string;
  calculated?: CalculatedColumnDescriptor;
}

export type CalculatedNumberV1 = number;

export type CalculatedUnaryOperatorV1 = "plus" | "minus" | "not";

export type CalculatedBinaryOperatorV1 = "add" | "subtract" | "multiply" | "divide";

export type CalculatedComparisonOperatorV1 =
  | "eq"
  | "notEq"
  | "lt"
  | "lte"
  | "gt"
  | "gte";

export type CalculatedLogicalOperatorV1 = "and" | "or";

export type CalculatedFunctionV1 = "abs" | "coalesce" | "if" | "max" | "min" | "round";

export type CalculatedExpressionV1 =
  | { kind: "columnRef"; columnId: string }
  | { kind: "numberLiteral"; value: CalculatedNumberV1 }
  | { kind: "booleanLiteral"; value: boolean }
  | { kind: "nullLiteral" }
  | { kind: "unary"; operator: CalculatedUnaryOperatorV1; operand: CalculatedExpressionV1 }
  | {
      kind: "binary";
      operator: CalculatedBinaryOperatorV1;
      left: CalculatedExpressionV1;
      right: CalculatedExpressionV1;
    }
  | {
      kind: "comparison";
      operator: CalculatedComparisonOperatorV1;
      left: CalculatedExpressionV1;
      right: CalculatedExpressionV1;
    }
  | {
      kind: "logical";
      operator: CalculatedLogicalOperatorV1;
      left: CalculatedExpressionV1;
      right: CalculatedExpressionV1;
    }
  | {
      kind: "function";
      function: CalculatedFunctionV1;
      arguments: CalculatedExpressionV1[];
    };

export type CalculatedOutputTypeV1 =
  | "boolean"
  | "continuous"
  | "integer"
  | "null"
  | "text"
  | "unknown";

export type CalculatedColumnStatus =
  | "draft"
  | "ready"
  | "disabled"
  | "broken"
  | "unsupported";

export type CalculatedDiagnosticLevel = "error" | "warning";

export interface CalculatedColumnDiagnostic {
  level: CalculatedDiagnosticLevel;
  code: string;
  message: string;
  relatedColumnIds?: string[];
}

export interface CalculatedColumnWarningCount {
  total: number;
  expression: number;
  dependencyGraph: number;
  validation: number;
}

export interface CalculatedColumnDefinitionV1 {
  formulaId: string;
  schemaVersion: string;
  outputColumnId: string;
  expression: CalculatedExpressionV1;
  dependencyColumnIds: string[];
  inferredOutputType: CalculatedOutputTypeV1;
  fingerprint: string;
}

export interface CalculatedColumnDescriptor {
  formulaId: string;
  schemaVersion: string;
  outputColumnId: string;
  displayFormulaText: string;
  status: CalculatedColumnStatus;
  dependencyColumnIds: string[];
  inferredOutputType: CalculatedOutputTypeV1;
  fingerprint: string;
}

export interface ValidateCalculatedColumnRequest {
  datasetId: string;
  outputName: string;
  formulaText: string;
  atIndex: number | null;
  outputColumnId: string | null;
  formulaId: string | null;
  expectedGeneration: number | null;
}

export interface UpsertCalculatedColumnRequest {
  datasetId: string;
  outputName: string;
  formulaText: string;
  atIndex: number | null;
  outputColumnId: string | null;
  formulaId: string | null;
  expectedGeneration: number | null;
}

export interface CalculatedColumnValidation {
  status: CalculatedColumnStatus;
  diagnostics?: CalculatedColumnDiagnostic[];
  warningCount: CalculatedColumnWarningCount;
  definition: CalculatedColumnDefinitionV1;
}

export interface CalculatedColumnMutationResult {
  columnId: string;
  datasetGeneration: number;
  changeSetId: string;
  calculated?: CalculatedColumnDescriptor;
  diagnostics?: CalculatedColumnDiagnostic[];
  warningCount: CalculatedColumnWarningCount;
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
