import type {
  DistributionAnalysisConfigV1,
  DistributionContinuousFitConfigV1,
  DistributionDocV1,
  DistributionRunStateV1,
  LoadedDistributionDocV1,
} from "@/types/distribution";

export interface ContinuousFitRunDependencies {
  getRun: (analysisId: string) => DistributionRunStateV1 | undefined;
  cancelBackendRun: (cancelToken: string) => Promise<void>;
  cancelStoreRun: (cancelToken: string) => void;
  commitConfig: (
    analysisId: string,
    baseConfigRevision: number,
    config: DistributionAnalysisConfigV1,
  ) => { ok: true; configRevision: number } | { ok: false; code: string };
  getItem: (analysisId: string) => DistributionDocV1 | undefined;
  markDirty: () => void;
  startRun: (item: LoadedDistributionDocV1) => Promise<void>;
}

export async function applyContinuousFitChange(
  item: DistributionDocV1,
  continuousFit: DistributionContinuousFitConfigV1,
  dependencies: ContinuousFitRunDependencies,
): Promise<boolean> {
  if (item.loadStatus !== "ready") return false;

  const activeRun = dependencies.getRun(item.analysisId);
  if (activeRun?.status === "running") {
    try {
      await dependencies.cancelBackendRun(activeRun.cancelToken);
    } finally {
      dependencies.cancelStoreRun(activeRun.cancelToken);
    }
  }

  const committed = dependencies.commitConfig(
    item.analysisId,
    item.configRevision,
    { ...item.currentConfig, continuousFit },
  );
  if (!committed.ok) return false;

  const updated = dependencies.getItem(item.analysisId);
  if (!updated || updated.loadStatus !== "ready") return false;
  dependencies.markDirty();
  await dependencies.startRun(updated);
  return true;
}
