import type {
  SnapshotCreateInput,
  SnapshotCreateResult,
  TableExportCsvInput,
  TableExportCsvResult,
} from "@/applicationCommands/types";
import { ioService } from "@/services/ioService";
import { useHistoryStore } from "@/stores/useHistoryStore";

export interface IoCommandDependencies {
  createSnapshot: (name?: string) => Promise<{ id?: string | null; name?: string | null; createdAt?: string | null }>;
  inspectCsvTarget: (input: TableExportCsvInput) => Promise<{ targetExists: boolean }>;
  exportCsv: (input: TableExportCsvInput) => Promise<void>;
}

export function createIoCommandHandlers(
  dependencyOverrides: Partial<IoCommandDependencies> = {},
) {
  const dependencies: IoCommandDependencies = {
    createSnapshot: async (name) => {
      const historyStore = useHistoryStore.getState();
      const beforeCount = historyStore.snapshots.length;
      await historyStore.createSnapshot(name);
      const latestSnapshot = useHistoryStore.getState().snapshots[0] ?? null;
      return {
        id: latestSnapshot?.id ?? (useHistoryStore.getState().snapshots.length > beforeCount ? latestSnapshot?.id ?? null : null),
        name: latestSnapshot?.name ?? null,
        createdAt: latestSnapshot?.timestamp ?? null,
      };
    },
    inspectCsvTarget: (input) =>
      ioService.inspectAuthorizedCsvTarget(input.datasetId, input.rootId, input.relativePath),
    exportCsv: async (input) => {
      await ioService.exportCsvAuthorized(input.datasetId, input.rootId, input.relativePath);
    },
    ...dependencyOverrides,
  };

  async function createSnapshot(input: SnapshotCreateInput): Promise<SnapshotCreateResult> {
    const snapshot = await dependencies.createSnapshot(input.name);
    return {
      snapshotId: snapshot.id ?? null,
      snapshotName: snapshot.name ?? input.name ?? null,
      createdAt: snapshot.createdAt ?? null,
    };
  }

  async function inspectTableExportCsvTarget(input: TableExportCsvInput): Promise<TableExportCsvResult> {
    const inspection = await dependencies.inspectCsvTarget(input);
    return {
      targetStatus: inspection.targetExists ? "overwriteExisting" : "createNew",
    };
  }

  async function exportTableCsv(input: TableExportCsvInput): Promise<TableExportCsvResult> {
    const inspection = await dependencies.inspectCsvTarget(input);
    await dependencies.exportCsv(input);
    return {
      targetStatus: inspection.targetExists ? "overwriteExisting" : "createNew",
    };
  }

  return {
    createSnapshot,
    inspectTableExportCsvTarget,
    exportTableCsv,
  };
}
