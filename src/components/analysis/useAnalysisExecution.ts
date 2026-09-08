import { useEffect, useState } from "react";
import type { AnalysisDocument, AnalysisKind } from "@/types/analysis";
import type { DatasetMeta } from "@/types/data";
import type {
  DistributionRequest,
} from "@/types/distribution";
import type { FitYByXRequest } from "@/types/fitYByX";

import {
  analysisExecutors,
  createAnalysisExecutionRequest,
  distributionAnalysisDefinitionFingerprint,
  fitYByXAnalysisDefinitionFingerprint,
  type AnalysisExecutionDependencies,
  type AnalysisExecutionRequestByKind,
  type AnalysisExecutionResponseByKind,
} from "./analysisExecutors";

export {
  createAnalysisExecutionRequest,
  distributionAnalysisDefinitionFingerprint,
  fitYByXAnalysisDefinitionFingerprint,
};
export type { AnalysisExecutionDependencies };

interface AnalysisExecutionControllerDependencies extends AnalysisExecutionDependencies {
  getCurrentAnalysis?: () => AnalysisDocument | null | undefined;
  getCurrentDataset?: () => DatasetMeta | null | undefined;
}

type AnalysisExecutionActiveState<Kind extends AnalysisKind> =
  | {
      status: "loading";
      analysisKind: Kind;
      analysisId: string;
      datasetId: string;
      configRevision: number;
      request: AnalysisExecutionRequestByKind[Kind] | null;
    }
  | {
      status: "success";
      analysisKind: Kind;
      analysisId: string;
      datasetId: string;
      configRevision: number;
      request: AnalysisExecutionRequestByKind[Kind];
      result: AnalysisExecutionResponseByKind[Kind];
    }
  | {
      status: "error";
      analysisKind: Kind;
      analysisId: string;
      datasetId: string;
      configRevision: number;
      request: AnalysisExecutionRequestByKind[Kind] | null;
      error: string;
    };

export type AnalysisExecutionState = { status: "idle" } | {
  [Kind in AnalysisKind]: AnalysisExecutionActiveState<Kind>;
}[AnalysisKind];

export const ANALYSIS_EXECUTION_IDLE_STATE: AnalysisExecutionState = { status: "idle" };

interface AnalysisExecutionControllerOptions extends AnalysisExecutionControllerDependencies {
  onStateChange?: (state: AnalysisExecutionState, fence: AnalysisExecutionFence | null) => void;
}

interface AnalysisExecutionFence {
  analysisKind: AnalysisDocument["analysisKind"];
  analysisId: string;
  configRevision: number;
  datasetId: string;
  datasetGeneration: number;
  sourceDataVersion: string;
  fingerprint: string;
  requestIdentity: string | null;
}

interface AnalysisExecutionSnapshot {
  state: AnalysisExecutionState;
  fence: AnalysisExecutionFence | null;
}

interface ActiveAnalysisRequest {
  token: number;
  analysisKind: AnalysisDocument["analysisKind"];
  analysisId: string;
  configRevision: number;
  datasetId: string;
  sourceDataVersion: string;
  generation: number | null;
  fingerprint: string;
  requestIdentity: string | null;
}

export interface AnalysisExecutionController {
  getState: () => AnalysisExecutionState;
  load: (item: AnalysisDocument, dataset: DatasetMeta) => Promise<void>;
  cancel: () => void;
  dispose: () => void;
}

function analysisExecutionRequestIdentity(
  item: AnalysisDocument,
  request: AnalysisExecutionRequestByKind[AnalysisKind] | null,
): string | null {
  return item.analysisKind === "distribution"
    ? analysisExecutors.distribution.requestIdentity(request as DistributionRequest | null)
    : analysisExecutors.fitYByX.requestIdentity(request as FitYByXRequest | null);
}

function analysisDefinitionFingerprint(item: AnalysisDocument): string {
  return item.analysisKind === "distribution"
    ? analysisExecutors.distribution.fingerprint(item)
    : analysisExecutors.fitYByX.fingerprint(item);
}

function createAnalysisExecutionFence(
  item: AnalysisDocument,
  dataset: DatasetMeta,
  request: AnalysisExecutionRequestByKind[AnalysisKind] | null,
): AnalysisExecutionFence {
  return {
    analysisKind: item.analysisKind,
    analysisId: item.id,
    configRevision: item.configRevision,
    datasetId: dataset.id,
    datasetGeneration: dataset.generation,
    sourceDataVersion: dataset.updatedAt,
    fingerprint: analysisDefinitionFingerprint(item),
    requestIdentity: analysisExecutionRequestIdentity(item, request),
  };
}

function fenceMatchesCurrentInputs(
  captured: AnalysisExecutionFence | null,
  current: AnalysisExecutionFence,
): boolean {
  return captured != null
    && captured.analysisKind === current.analysisKind
    && captured.analysisId === current.analysisId
    && captured.configRevision === current.configRevision
    && captured.datasetId === current.datasetId
    && captured.datasetGeneration === current.datasetGeneration
    && captured.sourceDataVersion === current.sourceDataVersion
    && captured.fingerprint === current.fingerprint
    && (captured.requestIdentity == null || captured.requestIdentity === current.requestIdentity);
}

function createMaskedLoadingState(
  item: AnalysisDocument,
  dataset: DatasetMeta,
): AnalysisExecutionState {
  return {
    status: "loading",
    analysisKind: item.analysisKind,
    analysisId: item.id,
    datasetId: dataset.id,
    configRevision: item.configRevision,
    request: null,
  };
}

function maskAnalysisExecutionState(
  snapshot: AnalysisExecutionSnapshot,
  item: AnalysisDocument | null | undefined,
  dataset: DatasetMeta | null | undefined,
): AnalysisExecutionState {
  if (item == null || dataset == null) {
    return snapshot.state.status === "idle" ? snapshot.state : ANALYSIS_EXECUTION_IDLE_STATE;
  }

  const currentFence = createAnalysisExecutionFence(
    item,
    dataset,
    createAnalysisExecutionRequest(item, dataset.generation),
  );
  if (fenceMatchesCurrentInputs(snapshot.fence, currentFence)) {
    return snapshot.state;
  }

  return createMaskedLoadingState(item, dataset);
}

export function createAnalysisExecutionController(
  options: AnalysisExecutionControllerOptions,
): AnalysisExecutionController {
  let state: AnalysisExecutionState = ANALYSIS_EXECUTION_IDLE_STATE;
  let active: ActiveAnalysisRequest | null = null;
  let nextToken = 0;
  let disposed = false;

  const emit = (nextState: AnalysisExecutionState, fence: AnalysisExecutionFence | null = null) => {
    state = nextState;
    options.onStateChange?.(nextState, fence);
  };

  const isActive = (candidate: ActiveAnalysisRequest) =>
    !disposed
      && active?.token === candidate.token
      && active.analysisKind === candidate.analysisKind
      && active.analysisId === candidate.analysisId
      && active.configRevision === candidate.configRevision
      && active.datasetId === candidate.datasetId
      && active.sourceDataVersion === candidate.sourceDataVersion
      && active.generation === candidate.generation
      && active.fingerprint === candidate.fingerprint
      && active.requestIdentity === candidate.requestIdentity;

  const invalidate = () => {
    nextToken += 1;
    active = null;
  };

  return {
    getState: () => state,
    cancel: () => {
      if (disposed) return;
      invalidate();
      emit(ANALYSIS_EXECUTION_IDLE_STATE, null);
    },
    dispose: () => {
      disposed = true;
      invalidate();
    },
    load: async (item, dataset) => {
      const pendingFence = createAnalysisExecutionFence(item, dataset, null);
      const pending: ActiveAnalysisRequest = {
        token: ++nextToken,
        analysisKind: item.analysisKind,
        analysisId: item.id,
        configRevision: item.configRevision,
        datasetId: dataset.id,
        sourceDataVersion: dataset.updatedAt,
        generation: null,
        fingerprint: analysisDefinitionFingerprint(item),
        requestIdentity: null,
      };
      active = pending;
      emit({
        status: "loading",
        analysisKind: pending.analysisKind,
        analysisId: pending.analysisId,
        datasetId: pending.datasetId,
        configRevision: pending.configRevision,
        request: null,
      }, pendingFence);

      let request: AnalysisExecutionRequestByKind[AnalysisKind] | null = null;
      try {
        const generation = await options.getDatasetGeneration(pending.datasetId);
        if (!isActive(pending)) return;

        request = createAnalysisExecutionRequest(item, generation);
        const running = {
          ...pending,
          generation,
          requestIdentity: analysisExecutionRequestIdentity(item, request),
        };
        active = running;
        const runningFence = createAnalysisExecutionFence(item, dataset, request);
        emit({
          status: "loading",
          analysisKind: running.analysisKind,
          analysisId: running.analysisId,
          datasetId: running.datasetId,
          configRevision: running.configRevision,
          request,
        } as AnalysisExecutionState, runningFence);

        const result = item.analysisKind === "distribution"
          ? await analysisExecutors.distribution.compute(options, request as DistributionRequest)
          : await analysisExecutors.fitYByX.compute(options, request as FitYByXRequest);
        if (!isActive(running)) return;

        const currentAnalysis = options.getCurrentAnalysis?.();
        if (currentAnalysis != null && (
          currentAnalysis.analysisKind !== running.analysisKind
          || currentAnalysis.id !== running.analysisId
          || currentAnalysis.configRevision !== running.configRevision
          || currentAnalysis.source.datasetId !== running.datasetId
          || analysisDefinitionFingerprint(currentAnalysis) !== running.fingerprint
        )) {
          invalidate();
          emit(ANALYSIS_EXECUTION_IDLE_STATE, null);
          return;
        }

        const currentDataset = options.getCurrentDataset?.();
        if (currentDataset != null && (
          currentDataset.id !== running.datasetId
          || currentDataset.updatedAt !== running.sourceDataVersion
          || currentDataset.generation !== running.generation
        )) {
          invalidate();
          emit(ANALYSIS_EXECUTION_IDLE_STATE, null);
          return;
        }

        const currentGeneration = await options.getDatasetGeneration(running.datasetId);
        if (!isActive(running)) return;
        if (currentGeneration !== running.generation) {
          invalidate();
          emit(ANALYSIS_EXECUTION_IDLE_STATE, null);
          return;
        }

        const responseMatches = item.analysisKind === "distribution"
          ? analysisExecutors.distribution.responseMatches(
            result as AnalysisExecutionResponseByKind["distribution"],
            request as DistributionRequest,
          )
          : analysisExecutors.fitYByX.responseMatches(
            result as AnalysisExecutionResponseByKind["fitYByX"],
            request as FitYByXRequest,
          );
        if (!responseMatches) {
          active = null;
          emit({
            status: "error",
            analysisKind: running.analysisKind,
            analysisId: running.analysisId,
            datasetId: running.datasetId,
            configRevision: running.configRevision,
            request,
            error: item.analysisKind === "distribution"
              ? analysisExecutors.distribution.responseIdentityError
              : analysisExecutors.fitYByX.responseIdentityError,
              } as AnalysisExecutionState, createAnalysisExecutionFence(item, dataset, request));
          return;
        }

        active = null;
        emit({
          status: "success",
          analysisKind: running.analysisKind,
          analysisId: running.analysisId,
          datasetId: running.datasetId,
          configRevision: running.configRevision,
          request,
          result,
        } as AnalysisExecutionState, createAnalysisExecutionFence(item, dataset, request));
      } catch (error) {
        if (disposed || active?.token !== pending.token) return;
        active = null;
        emit({
          status: "error",
          analysisKind: pending.analysisKind,
          analysisId: pending.analysisId,
          datasetId: pending.datasetId,
          configRevision: pending.configRevision,
          request,
          error: item.analysisKind === "distribution"
            ? analysisExecutors.distribution.normalizeError(error)
            : analysisExecutors.fitYByX.normalizeError(error),
        } as AnalysisExecutionState, createAnalysisExecutionFence(item, dataset, request));
      }
    },
  };
}

export interface UseAnalysisExecutionRuntime extends Partial<AnalysisExecutionControllerDependencies> {}

export function useAnalysisExecution(
  item: AnalysisDocument | null | undefined,
  dataset: DatasetMeta | null | undefined,
  dependencies?: UseAnalysisExecutionRuntime,
): AnalysisExecutionState {
  const [snapshot, setSnapshot] = useState<AnalysisExecutionSnapshot>({
    state: ANALYSIS_EXECUTION_IDLE_STATE,
    fence: null,
  });
  const compute = dependencies?.compute;
  const computeFitYByX = dependencies?.computeFitYByX;
  const getCurrentAnalysis = dependencies?.getCurrentAnalysis;
  const getCurrentDataset = dependencies?.getCurrentDataset;
  const getDatasetGeneration = dependencies?.getDatasetGeneration;
  const fingerprint = item == null ? null : analysisDefinitionFingerprint(item);
  const datasetSignal = dataset == null ? null : `${dataset.id}:${dataset.generation}:${dataset.updatedAt}`;

  useEffect(() => {
    if (item == null || dataset == null) {
      setSnapshot({ state: ANALYSIS_EXECUTION_IDLE_STATE, fence: null });
      return undefined;
    }

    let mounted = true;
    let controller: AnalysisExecutionController | null = null;

    void (async () => {
      try {
        const resolved = item.analysisKind === "distribution"
          ? await analysisExecutors.distribution.resolveDependencies({ compute, getDatasetGeneration })
          : await analysisExecutors.fitYByX.resolveDependencies({ computeFitYByX, getDatasetGeneration });
        if (!mounted) return;

        controller = createAnalysisExecutionController({
          ...resolved,
          getCurrentAnalysis,
          getCurrentDataset,
          onStateChange: (nextState, fence) => {
            setSnapshot({ state: nextState, fence });
          },
        });
        await controller.load(item, dataset);
      } catch (error) {
        if (!mounted) return;
        setSnapshot({
          state: {
            status: "error",
            analysisKind: item.analysisKind,
            analysisId: item.id,
            datasetId: dataset.id,
            configRevision: item.configRevision,
            request: null,
            error: item.analysisKind === "distribution"
              ? analysisExecutors.distribution.normalizeError(error)
              : analysisExecutors.fitYByX.normalizeError(error),
          },
          fence: createAnalysisExecutionFence(item, dataset, null),
        });
      }
    })();

    return () => {
      mounted = false;
      controller?.dispose();
    };
  }, [
    compute,
    computeFitYByX,
    datasetSignal,
    fingerprint,
    getCurrentAnalysis,
    getCurrentDataset,
    getDatasetGeneration,
    item?.analysisKind,
    item?.configRevision,
    item?.id,
    item?.source.datasetId,
  ]);

  return maskAnalysisExecutionState(snapshot, item, dataset);
}