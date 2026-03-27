/** 单列描述性统计 */
export interface ColumnStats {
  columnName: string;
  count: number;
  missing: number;
  mean?: number;
  median?: number;
  stdDev?: number;
  min?: number;
  max?: number;
  q1?: number;
  q3?: number;
  skewness?: number;
  kurtosis?: number;
  uniqueCount?: number;
}

/** 整表描述性统计结果 */
export interface DescriptiveResult {
  datasetId: string;
  columns: ColumnStats[];
}
