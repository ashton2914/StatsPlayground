import { invoke } from "@tauri-apps/api/core";
import type { DatasetMeta } from "@/types/data";

export const ioService = {
  /** 导出数据集为 CSV */
  exportCsv: (datasetId: string, outputPath: string) =>
    invoke<void>("export_csv", { datasetId, outputPath }),

  /** 从 SQLite 数据库导入所有表 */
  importSqlite: (filePath: string) =>
    invoke<DatasetMeta[]>("import_sqlite", { filePath }),

  /** 导出所有数据表到 SQLite 数据库 */
  exportSqlite: (outputPath: string) =>
    invoke<void>("export_sqlite", { outputPath }),

  /** 导出所有数据表为 CSV 打包成 ZIP */
  exportCsvZip: (outputPath: string) =>
    invoke<void>("export_csv_zip", { outputPath }),
};
