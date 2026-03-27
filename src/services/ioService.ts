import { invoke } from "@tauri-apps/api/core";

export const ioService = {
  /** 导出数据集为 CSV */
  exportCsv: (datasetId: string, outputPath: string) =>
    invoke<void>("export_csv", { datasetId, outputPath }),
};
