import {invokeProjectExport} from "@/projectPersistence/exportRead";
import {useProjectStore} from "@/stores/useProjectStore";
import { invoke } from "@tauri-apps/api/core";
import type { DatasetMeta } from "@/types/data";

interface AuthorizedOutputRootGrant {
  rootId: string;
  displayName: string;
}

interface AuthorizedCsvTargetInspection {
  targetExists: boolean;
}

export const ioService = {
  /** 导出数据集为 CSV */
  exportCsv: (datasetId: string, outputPath: string) =>
    invokeProjectExport("export_csv", { datasetId, outputPath }),

  authorizeCsvExportRoot: (rootPath: string) =>
    invoke<AuthorizedOutputRootGrant>("authorize_csv_export_root", { rootPath }),

  revokeCsvExportRoot: (rootId: string) =>
    invoke<void>("revoke_csv_export_root", { rootId }),

  inspectAuthorizedCsvTarget: (datasetId: string, rootId: string, relativePath: string) =>
    invoke<AuthorizedCsvTargetInspection>("inspect_authorized_csv_target", {
      datasetId,
      rootId,
      relativePath,
    }),

  exportCsvAuthorized: async (
    datasetId: string,
    rootId: string,
    relativePath: string,
    overwriteConfirmed: boolean,
  ) => {
    const owner=useProjectStore.getState().persistence;
    if(owner)await owner.flushThrough(owner.captureBarrier());
    if(useProjectStore.getState().persistence!==owner)throw new Error("project_session_stale");
    if(owner)return invoke<void>("export_csv_authorized", { datasetId, rootId, relativePath, overwriteConfirmed,epoch:owner.snapshot().epoch });
    return invoke<void>("export_csv_authorized", { datasetId, rootId, relativePath, overwriteConfirmed });
  },

  /** 从 SQLite 数据库导入所有表 */
  importSqlite: (filePath: string) =>
    invoke<DatasetMeta[]>("import_sqlite", { filePath }),

  /** 导出所有数据表到 SQLite 数据库 */
  exportSqlite: (outputPath: string) =>
    invokeProjectExport("export_sqlite", { outputPath }),

  /** Subset SQLite export.
   *  `datasetIds` — if omitted, all datasets are exported.
   *  `nameOverrides` — `datasetId → table name` map. Used by the UI to encode
   *  folder structure into SQLite table names as `folder-tablename` (SQLite
   *  is flat so there's no other way to keep tables in the same folder
   *  together visually). */
  exportSqliteSubset: (
    outputPath: string,
    datasetIds?: string[],
    nameOverrides?: Record<string, string>,
  ) =>
    invokeProjectExport("export_sqlite_subset", {
      outputPath,
      datasetIds: datasetIds ?? null,
      nameOverrides: nameOverrides ?? null,
    }),

  /** 导出所有数据表为 CSV 打包成 ZIP */
  exportCsvZip: (outputPath: string) =>
    invokeProjectExport("export_csv_zip", { outputPath }),

  /** Subset CSV ZIP export.
   *  `datasetIds` — if omitted, all datasets are exported.
   *  `archivePaths` — `datasetId → path inside the zip` (without `.csv`).
   *  Used to preserve folder structure inside the archive. */
  exportCsvZipSubset: (
    outputPath: string,
    datasetIds?: string[],
    archivePaths?: Record<string, string>,
  ) =>
    invokeProjectExport("export_csv_zip_subset", {
      outputPath,
      datasetIds: datasetIds ?? null,
      archivePaths: archivePaths ?? null,
    }),
};
