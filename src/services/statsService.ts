import { invoke } from "@tauri-apps/api/core";
import type { ColumnStats, DescriptiveResult } from "@/types/stats";

export const statsService = {
  /** 获取单列描述性统计 */
  getColumnStats: (datasetId: string, columnName: string) =>
    invoke<ColumnStats>("get_column_stats", { datasetId, columnName }),

  /** 获取整表描述性统计 */
  getDescriptiveStats: (datasetId: string) =>
    invoke<DescriptiveResult>("get_descriptive_stats", { datasetId }),
};
