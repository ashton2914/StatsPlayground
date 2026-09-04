import assert from "node:assert/strict";

import { applyContinuousFitChange } from "../src/components/distribution/continuousFitRun.ts";
import type {
  DistributionContinuousFitConfigV1,
  DistributionDocV1,
  LoadedDistributionDocV1,
} from "../src/types/distribution.ts";

const continuousFit: DistributionContinuousFitConfigV1 = {
  enabledDistributionIds: ["normal", "gamma"],
  fitAll: false,
  diagnostics: { goodnessOfFit: false, qqPlot: false, cdfPlot: false, ppPlot: false },
};

const item: LoadedDistributionDocV1 = {
  schemaVersion: "1",
  analysisId: "analysis-1",
  name: "Distribution 1",
  sourceDatasetId: "dataset-1",
  status: "ready",
  loadStatus: "ready",
  configRevision: 2,
  currentConfig: {
    schemaVersion: "1",
    sourceDatasetId: "dataset-1",
    yColumns: [{ columnId: "value", modelingType: "continuous" }],
    weightColumnId: null,
    frequencyColumnId: null,
    byColumnIds: [],
    filterExpr: { kind: "and", exprs: [] },
    confidenceLevel: 0.95,
    histogramsOnly: false,
    enabledCapabilityIds: [],
    capabilityOverrides: [],
  },
};

{
  const events: string[] = [];
  let currentItem: DistributionDocV1 = structuredClone(item);
  let startedRevision = 0;
  let startedFit: DistributionContinuousFitConfigV1 | undefined;

  const changed = await applyContinuousFitChange(item, continuousFit, {
    getRun: () => ({
      analysisId: item.analysisId,
      configRevision: 2,
      runId: "run-old",
      status: "running",
      progress: null,
      snapshotId: "snapshot-old",
      cancelToken: "cancel-old",
    }),
    cancelBackendRun: async (token) => { events.push(`cancelBackend:${token}`); },
    cancelStoreRun: (token) => { events.push(`cancelStore:${token}`); },
    commitConfig: (_analysisId, baseRevision, config) => {
      events.push(`commit:${baseRevision}`);
      currentItem = {
        ...item,
        configRevision: baseRevision + 1,
        currentConfig: structuredClone(config),
      };
      return { ok: true, configRevision: baseRevision + 1 };
    },
    getItem: () => currentItem,
    markDirty: () => { events.push("markDirty"); },
    startRun: async (updated) => {
      events.push(`start:${updated.configRevision}`);
      startedRevision = updated.configRevision;
      startedFit = updated.currentConfig.continuousFit;
    },
  });

  assert.equal(changed, true);
  assert.deepEqual(events, ["cancelBackend:cancel-old", "cancelStore:cancel-old", "commit:2", "markDirty", "start:3"]);
  assert.equal(startedRevision, 3);
  assert.deepEqual(startedFit, continuousFit);
}

{
  const events: string[] = [];
  await assert.rejects(
    applyContinuousFitChange(item, continuousFit, {
      getRun: () => ({
        analysisId: item.analysisId,
        configRevision: 2,
        runId: "run-old",
        status: "running",
        progress: null,
        snapshotId: "snapshot-old",
        cancelToken: "cancel-old",
      }),
      cancelBackendRun: async () => {
        events.push("cancelBackend");
        throw new Error("cancel failed");
      },
      cancelStoreRun: () => { events.push("cancelStore"); },
      commitConfig: () => {
        events.push("commit");
        return { ok: true, configRevision: 3 };
      },
      getItem: () => item,
      markDirty: () => { events.push("markDirty"); },
      startRun: async () => { events.push("start"); },
    }),
    /cancel failed/,
  );
  assert.deepEqual(events, ["cancelBackend", "cancelStore"]);
}

console.log("distribution continuous fit run orchestration OK");
