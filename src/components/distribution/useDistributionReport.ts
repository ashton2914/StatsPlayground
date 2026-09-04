import { useEffect, useState } from "react";

import type {
  DistributionItem,
  DistributionReportResponse,
  DistributionRequest,
} from "@/types/distribution";

export interface DistributionReportDependencies {
  getDatasetGeneration: (datasetId: string) => Promise<number>;
  compute: (request: DistributionRequest) => Promise<DistributionReportResponse>;
  getCurrentItem?: () => DistributionItem | null | undefined;
}

export type DistributionReportState =
  | { status: "idle" }
  | {
      status: "loading";
      itemId: string;
      datasetId: string;
      request: DistributionRequest | null;
    }
  | {
      status: "success";
      itemId: string;
      datasetId: string;
      request: DistributionRequest;
      result: DistributionReportResponse;
    }
  | {
      status: "error";
      itemId: string;
      datasetId: string;
      request: DistributionRequest | null;
      error: string;
    };

export const DISTRIBUTION_IDLE_REPORT_STATE: DistributionReportState = { status: "idle" };

interface DistributionReportControllerOptions extends DistributionReportDependencies {
  onStateChange?: (state: DistributionReportState) => void;
}

interface ActiveDistributionRequest {
  token: number;
  itemId: string;
  datasetId: string;
  generation: number | null;
  fingerprint: string;
}

export interface DistributionReportController {
  getState: () => DistributionReportState;
  load: (item: DistributionItem) => Promise<void>;
  cancel: () => void;
  dispose: () => void;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  }
  return value;
}

export function distributionRequestFingerprint(item: DistributionItem): string {
  return JSON.stringify(stableValue({
    sourceDatasetId: item.sourceDatasetId,
    responses: item.responses,
    weight: item.weight,
    frequency: item.frequency,
    by: item.by,
    analysis: item.analysis,
  }));
}

export function createDistributionRequest(
  item: DistributionItem,
  generation: number,
): DistributionRequest {
  return {
    datasetId: item.sourceDatasetId,
    generation,
    responseColumns: item.responses.map((field) => field.name),
    weightColumn: item.weight?.name ?? null,
    freqColumn: item.frequency?.name ?? null,
    byColumns: item.by.map((field) => field.name),
    confidenceLevel: item.analysis.confidenceLevel,
    specLimits: stableValue(item.analysis.specLimits) as DistributionRequest["specLimits"],
    fitDistributions: [...item.analysis.fitDistributions],
  };
}

function normalizeError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "object" && error !== null) {
    const message = Reflect.get(error, "message");
    if (typeof message === "string" && message.trim()) return message;
  }
  if (typeof error === "string" && error.trim()) return error;
  return "Failed to load Distribution report.";
}

export function createDistributionReportController(
  options: DistributionReportControllerOptions,
): DistributionReportController {
  let state: DistributionReportState = DISTRIBUTION_IDLE_REPORT_STATE;
  let active: ActiveDistributionRequest | null = null;
  let nextToken = 0;
  let disposed = false;

  const emit = (nextState: DistributionReportState) => {
    state = nextState;
    options.onStateChange?.(nextState);
  };
  const isActive = (candidate: ActiveDistributionRequest) =>
    !disposed && active?.token === candidate.token
      && active.itemId === candidate.itemId
      && active.datasetId === candidate.datasetId
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
      emit(DISTRIBUTION_IDLE_REPORT_STATE);
    },
    dispose: () => {
      disposed = true;
      invalidate();
    },
    load: async (item) => {
      const pending: ActiveDistributionRequest = {
        token: ++nextToken,
        itemId: item.id,
        datasetId: item.sourceDatasetId,
        generation: null,
        fingerprint: distributionRequestFingerprint(item),
      };
      active = pending;
      emit({
        status: "loading",
        itemId: pending.itemId,
        datasetId: pending.datasetId,
        request: null,
      });

      let request: DistributionRequest | null = null;
      try {
        const generation = await options.getDatasetGeneration(pending.datasetId);
        if (!isActive(pending)) return;
        const running = { ...pending, generation };
        active = running;
        request = createDistributionRequest(item, generation);
        emit({
          status: "loading",
          itemId: running.itemId,
          datasetId: running.datasetId,
          request,
        });

        const result = await options.compute(request);
        if (!isActive(running)) return;

        const currentItem = options.getCurrentItem?.();
        if (currentItem != null && (
          currentItem.id !== running.itemId
          || currentItem.sourceDatasetId !== running.datasetId
          || distributionRequestFingerprint(currentItem) !== running.fingerprint
        )) {
          invalidate();
          emit(DISTRIBUTION_IDLE_REPORT_STATE);
          return;
        }

        const currentGeneration = await options.getDatasetGeneration(running.datasetId);
        if (!isActive(running)) return;
        if (currentGeneration !== running.generation) {
          invalidate();
          emit(DISTRIBUTION_IDLE_REPORT_STATE);
          return;
        }
        if (result.datasetId !== running.datasetId || result.generation !== running.generation) {
          active = null;
          emit({
            status: "error",
            itemId: running.itemId,
            datasetId: running.datasetId,
            request,
            error: "Distribution response identity did not match the request.",
          });
          return;
        }

        active = null;
        emit({
          status: "success",
          itemId: running.itemId,
          datasetId: running.datasetId,
          request,
          result,
        });
      } catch (error) {
        if (disposed || active?.token !== pending.token) return;
        active = null;
        emit({
          status: "error",
          itemId: pending.itemId,
          datasetId: pending.datasetId,
          request,
          error: normalizeError(error),
        });
      }
    },
  };
}

async function resolveDependencies(
  overrides?: Partial<DistributionReportDependencies>,
): Promise<DistributionReportDependencies> {
  if (overrides?.getDatasetGeneration && overrides.compute) {
    return overrides as DistributionReportDependencies;
  }
  const [{ dataService }, { distributionService }] = await Promise.all([
    import("../../services/dataService"),
    import("../../services/distributionService"),
  ]);
  return {
    getDatasetGeneration: overrides?.getDatasetGeneration ?? dataService.getDatasetGeneration,
    compute: overrides?.compute ?? distributionService.compute,
  };
}

export function useDistributionReport(
  item: DistributionItem | null | undefined,
  generationSignal: string | number | boolean | null | undefined,
  dependencies?: Partial<DistributionReportDependencies>,
): DistributionReportState {
  const [state, setState] = useState<DistributionReportState>(DISTRIBUTION_IDLE_REPORT_STATE);
  const getDatasetGeneration = dependencies?.getDatasetGeneration;
  const compute = dependencies?.compute;
  const getCurrentItem = dependencies?.getCurrentItem;
  const fingerprint = item == null ? null : distributionRequestFingerprint(item);

  useEffect(() => {
    if (item == null) {
      setState(DISTRIBUTION_IDLE_REPORT_STATE);
      return undefined;
    }
    let mounted = true;
    let controller: DistributionReportController | null = null;
    void (async () => {
      try {
        const resolved = await resolveDependencies({ getDatasetGeneration, compute });
        if (!mounted) return;
        controller = createDistributionReportController({
          ...resolved,
          getCurrentItem,
          onStateChange: setState,
        });
        await controller.load(item);
      } catch (error) {
        if (!mounted) return;
        setState({
          status: "error",
          itemId: item.id,
          datasetId: item.sourceDatasetId,
          request: null,
          error: normalizeError(error),
        });
      }
    })();
    return () => {
      mounted = false;
      controller?.dispose();
    };
  }, [compute, fingerprint, generationSignal, getCurrentItem, getDatasetGeneration]);

  return state;
}