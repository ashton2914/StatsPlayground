import {
  createDistributionRequest,
  normalizeDistributionReportError,
  stableDistributionReportValue,
  type DistributionReportDependencies,
} from "@/components/distribution/useDistributionReport";
import { useEffect, useState } from "react";
import type { AnalysisDocument } from "@/types/analysis";
import type { DatasetMeta } from "@/types/data";
import type {
  DistributionItem,
  DistributionReportResponse,
  DistributionRequest,
} from "@/types/distribution";

export interface AnalysisExecutionDependencies extends DistributionReportDependencies {
  getCurrentAnalysis?: () => AnalysisDocument | null | undefined;
  getCurrentDataset?: () => DatasetMeta | null | undefined;
}

export type AnalysisExecutionState =
  | { status: "idle" }
  | {
      status: "loading";
      analysisId: string;
      datasetId: string;
      configRevision: number;
      request: DistributionRequest | null;
    }
  | {
      status: "success";
      analysisId: string;
      datasetId: string;
      configRevision: number;
      request: DistributionRequest;
      result: DistributionReportResponse;
    }
  | {
      status: "error";
      analysisId: string;
      datasetId: string;
      configRevision: number;
      request: DistributionRequest | null;
      error: string;
    };

export const ANALYSIS_EXECUTION_IDLE_STATE: AnalysisExecutionState = { status: "idle" };

interface AnalysisExecutionControllerOptions extends AnalysisExecutionDependencies {
  onStateChange?: (state: AnalysisExecutionState) => void;
}

interface ActiveAnalysisRequest {
  token: number;
  analysisId: string;
  configRevision: number;
  datasetId: string;
  sourceDataVersion: string;
  generation: number | null;
  fingerprint: string;
}

export interface AnalysisExecutionController {
  getState: () => AnalysisExecutionState;
  load: (item: AnalysisDocument, dataset: DatasetMeta) => Promise<void>;
  cancel: () => void;
  dispose: () => void;
}

function toDistributionItem(item: AnalysisDocument): DistributionItem {
  return {
    id: item.id,
    name: item.name,
    sourceDatasetId: item.source.datasetId,
    responses: item.definition.responses,
    weight: item.definition.weight,
    frequency: item.definition.frequency,
    by: item.definition.by,
    analysis: item.definition.analysis,
    graphs: item.definition.graphs,
    createdAt: item.createdAt,
  };
}

export function distributionAnalysisDefinitionFingerprint(item: AnalysisDocument): string {
  return JSON.stringify(stableDistributionReportValue({
    analysisKind: item.analysisKind,
    configRevision: item.configRevision,
    sourceDatasetId: item.source.datasetId,
    responses: item.definition.responses,
    weight: item.definition.weight,
    frequency: item.definition.frequency,
    by: item.definition.by,
    analysis: item.definition.analysis,
  }));
}

export function createAnalysisExecutionRequest(
  item: AnalysisDocument,
  generation: number,
): DistributionRequest {
  return createDistributionRequest(toDistributionItem(item), generation);
}

export function createAnalysisExecutionController(
  options: AnalysisExecutionControllerOptions,
): AnalysisExecutionController {
  let state: AnalysisExecutionState = ANALYSIS_EXECUTION_IDLE_STATE;
  let active: ActiveAnalysisRequest | null = null;
  let nextToken = 0;
  let disposed = false;

  const emit = (nextState: AnalysisExecutionState) => {
    state = nextState;
    options.onStateChange?.(nextState);
  };

  const isActive = (candidate: ActiveAnalysisRequest) =>
    !disposed
      && active?.token === candidate.token
      && active.analysisId === candidate.analysisId
      && active.configRevision === candidate.configRevision
      && active.datasetId === candidate.datasetId
      && active.sourceDataVersion === candidate.sourceDataVersion
      && active.generation === candidate.generation
      && active.fingerprint === candidate.fingerprint;

  const invalidate = () => {
    nextToken += 1;
    active = null;
  };

  return {
    getState: () => state,
    cancel: () => {
      if (disposed) return;
      invalidate();
      emit(ANALYSIS_EXECUTION_IDLE_STATE);
    },
    dispose: () => {
      disposed = true;
      invalidate();
    },
    load: async (item, dataset) => {
      const pending: ActiveAnalysisRequest = {
        token: ++nextToken,
        analysisId: item.id,
        configRevision: item.configRevision,
        datasetId: dataset.id,
        sourceDataVersion: dataset.updatedAt,
        generation: null,
        fingerprint: distributionAnalysisDefinitionFingerprint(item),
      };
      active = pending;
      emit({
        status: "loading",
        analysisId: pending.analysisId,
        datasetId: pending.datasetId,
        configRevision: pending.configRevision,
        request: null,
      });

      let request: DistributionRequest | null = null;
      try {
        const generation = await options.getDatasetGeneration(pending.datasetId);
        if (!isActive(pending)) return;

        const running = { ...pending, generation };
        active = running;
        request = createAnalysisExecutionRequest(item, generation);
        emit({
          status: "loading",
          analysisId: running.analysisId,
          datasetId: running.datasetId,
          configRevision: running.configRevision,
          request,
        });

        const result = await options.compute(request);
        if (!isActive(running)) return;

        const currentAnalysis = options.getCurrentAnalysis?.();
        if (currentAnalysis != null && (
          currentAnalysis.id !== running.analysisId
          || currentAnalysis.configRevision !== running.configRevision
          || currentAnalysis.source.datasetId !== running.datasetId
          || distributionAnalysisDefinitionFingerprint(currentAnalysis) !== running.fingerprint
        )) {
          invalidate();
          emit(ANALYSIS_EXECUTION_IDLE_STATE);
          return;
        }

        const currentDataset = options.getCurrentDataset?.();
        if (currentDataset != null && (
          currentDataset.id !== running.datasetId
          || currentDataset.updatedAt !== running.sourceDataVersion
          || currentDataset.generation !== running.generation
        )) {
          invalidate();
          emit(ANALYSIS_EXECUTION_IDLE_STATE);
          return;
        }

        const currentGeneration = await options.getDatasetGeneration(running.datasetId);
        if (!isActive(running)) return;
        if (currentGeneration !== running.generation) {
          invalidate();
          emit(ANALYSIS_EXECUTION_IDLE_STATE);
          return;
        }

        if (result.datasetId !== running.datasetId || result.generation !== running.generation) {
          active = null;
          emit({
            status: "error",
            analysisId: running.analysisId,
            datasetId: running.datasetId,
            configRevision: running.configRevision,
            request,
            error: "Distribution response identity did not match the request.",
          });
          return;
        }

        active = null;
        emit({
          status: "success",
          analysisId: running.analysisId,
          datasetId: running.datasetId,
          configRevision: running.configRevision,
          request,
          result,
        });
      } catch (error) {
        if (disposed || active?.token !== pending.token) return;
        active = null;
        emit({
          status: "error",
          analysisId: pending.analysisId,
          datasetId: pending.datasetId,
          configRevision: pending.configRevision,
          request,
          error: normalizeDistributionReportError(error),
        });
      }
    },
  };
}

export interface UseAnalysisExecutionRuntime extends Partial<AnalysisExecutionDependencies> {}

async function resolveDependencies(
  overrides?: Partial<AnalysisExecutionDependencies>,
): Promise<AnalysisExecutionDependencies> {
  if (overrides?.getDatasetGeneration && overrides.compute) {
    return overrides as AnalysisExecutionDependencies;
  }

  const [{ dataService }, { distributionService }] = await Promise.all([
    import("../../services/dataService"),
    import("../../services/distributionService"),
  ]);

  return {
    getDatasetGeneration: overrides?.getDatasetGeneration ?? dataService.getDatasetGeneration,
    compute: overrides?.compute ?? distributionService.compute,
    getCurrentAnalysis: overrides?.getCurrentAnalysis,
    getCurrentDataset: overrides?.getCurrentDataset,
  };
}

export function useAnalysisExecution(
  item: AnalysisDocument | null | undefined,
  dataset: DatasetMeta | null | undefined,
  dependencies?: UseAnalysisExecutionRuntime,
): AnalysisExecutionState {
  const [state, setState] = useState<AnalysisExecutionState>(ANALYSIS_EXECUTION_IDLE_STATE);
  const compute = dependencies?.compute;
  const getCurrentAnalysis = dependencies?.getCurrentAnalysis;
  const getCurrentDataset = dependencies?.getCurrentDataset;
  const getDatasetGeneration = dependencies?.getDatasetGeneration;
  const fingerprint = item == null ? null : distributionAnalysisDefinitionFingerprint(item);
  const datasetSignal = dataset == null ? null : `${dataset.id}:${dataset.generation}:${dataset.updatedAt}`;

  useEffect(() => {
    if (item == null || dataset == null) {
      setState(ANALYSIS_EXECUTION_IDLE_STATE);
      return undefined;
    }

    let mounted = true;
    let controller: AnalysisExecutionController | null = null;

    void (async () => {
      try {
        const resolved = await resolveDependencies({
          compute,
          getCurrentAnalysis,
          getCurrentDataset,
          getDatasetGeneration,
        });
        if (!mounted) return;

        controller = createAnalysisExecutionController({
          ...resolved,
          onStateChange: setState,
        });
        await controller.load(item, dataset);
      } catch (error) {
        if (!mounted) return;
        setState({
          status: "error",
          analysisId: item.id,
          datasetId: dataset.id,
          configRevision: item.configRevision,
          request: null,
          error: normalizeDistributionReportError(error),
        });
      }
    })();

    return () => {
      mounted = false;
      controller?.dispose();
    };
  }, [
    compute,
    datasetSignal,
    fingerprint,
    getCurrentAnalysis,
    getCurrentDataset,
    getDatasetGeneration,
    item?.configRevision,
    item?.id,
    item?.source.datasetId,
  ]);

  if (item == null || dataset == null) {
    return state.status === "idle" ? state : ANALYSIS_EXECUTION_IDLE_STATE;
  }

  return state;
}