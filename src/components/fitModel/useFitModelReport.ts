import { useEffect, useState } from "react";

import { canonicalizeFitModelTerms } from "@/components/fitModel/fitModelConfig";
import type { FitModelItem, FitModelRequest, FitModelResult, FitModelTerm } from "@/types/fitModel";

const FIT_MODEL_CONFIDENCE_LEVEL = 0.95;

export interface FitModelReportDependencies {
  getDatasetGeneration: (datasetId: string) => Promise<number>;
  run: (request: FitModelRequest) => Promise<FitModelResult>;
}

export type FitModelReportGenerationSignal = string | number | boolean | null | undefined;

export type FitModelReportState =
  | { status: "idle"; result: null; error: null; configurationKey: null }
  | { status: "loading"; result: FitModelResult | null; error: null; configurationKey: string }
  | { status: "success"; result: FitModelResult; error: null; configurationKey: string }
  | { status: "stale"; result: FitModelResult; error: string | null; configurationKey: string }
  | { status: "error"; result: FitModelResult | null; error: string; configurationKey: string | null };

export const FIT_MODEL_IDLE_REPORT_STATE: FitModelReportState = {
  status: "idle",
  result: null,
  error: null,
  configurationKey: null,
};

export function resolveFitModelReportStateForSignal(
  state: FitModelReportState,
  stateSignal: FitModelReportGenerationSignal,
  currentSignal: FitModelReportGenerationSignal,
): FitModelReportState {
  if (Object.is(stateSignal, currentSignal) || state.status !== "success") {
    return state;
  }

  return {
    status: "stale",
    result: state.result,
    error: null,
    configurationKey: state.configurationKey,
  };
}

interface FitModelReportControllerOptions extends FitModelReportDependencies {
  onStateChange?: (state: FitModelReportState) => void;
}

interface ActiveFitModelRequest {
  token: number;
  itemId: string;
  datasetId: string;
  generation: number | null;
  configurationKey: string | null;
}

export interface FitModelReportController {
  getState: () => FitModelReportState;
  load: (item: FitModelItem) => Promise<void>;
  cancel: () => void;
  dispose: () => void;
}

export function fitModelConfigurationKey(config: {
  responseColumn: string;
  terms: ReadonlyArray<FitModelTerm>;
  centeringMethod: FitModelItem["centeringMethod"];
  confidenceLevel: number;
  generation: number;
}): string {
  const canonicalTerms = canonicalizeFitModelTerms(config.terms);

  return JSON.stringify({
    responseColumn: config.responseColumn,
    terms: canonicalTerms.map((term) => ({
      kind: term.kind,
      columnNames: [...term.columnNames],
    })),
    centeringMethod: config.centeringMethod,
    confidenceLevel: config.confidenceLevel,
    generation: config.generation,
  });
}

export function createFitModelRequest(item: FitModelItem, generation: number): FitModelRequest {
  return {
    datasetId: item.sourceDatasetId,
    generation,
    responseColumn: item.response.name,
    terms: canonicalizeFitModelTerms(item.terms),
    centeringMethod: item.centeringMethod,
    confidenceLevel: FIT_MODEL_CONFIDENCE_LEVEL,
  };
}

function normalizeFitModelReportError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  if (typeof error === "object" && error !== null) {
    const message = Reflect.get(error, "message");
    if (typeof message === "string" && message.trim().length > 0) {
      return message;
    }
  }

  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }

  return "Failed to load Fit Model report.";
}

function resultFromState(state: FitModelReportState): FitModelResult | null {
  return state.result;
}

function generationFromConfigurationKey(configurationKey: string | null): number | null {
  if (configurationKey == null) {
    return null;
  }

  try {
    const parsed = JSON.parse(configurationKey) as { generation?: unknown };
    if (typeof parsed.generation === "number" && Number.isFinite(parsed.generation)) {
      return parsed.generation;
    }
  } catch {
    return null;
  }

  return null;
}

export function createFitModelReportController(
  options: FitModelReportControllerOptions,
): FitModelReportController {
  let state: FitModelReportState = FIT_MODEL_IDLE_REPORT_STATE;
  let disposed = false;
  let nextToken = 0;
  let active: ActiveFitModelRequest | null = null;

  const emit = (nextState: FitModelReportState) => {
    state = nextState;
    options.onStateChange?.(nextState);
  };

  const clearActive = () => {
    active = null;
  };

  const isActive = (candidate: ActiveFitModelRequest): boolean => {
    if (disposed || active == null) {
      return false;
    }

    return active.token === candidate.token
      && active.itemId === candidate.itemId
      && active.datasetId === candidate.datasetId
      && active.generation === candidate.generation
      && active.configurationKey === candidate.configurationKey;
  };

  const start = (item: FitModelItem): ActiveFitModelRequest => {
    const current: ActiveFitModelRequest = {
      token: nextToken + 1,
      itemId: item.id,
      datasetId: item.sourceDatasetId,
      generation: null,
      configurationKey: null,
    };
    nextToken = current.token;
    active = current;
    return current;
  };

  return {
    getState: () => state,
    cancel: () => {
      if (disposed) {
        return;
      }

      nextToken += 1;
      clearActive();
      emit(FIT_MODEL_IDLE_REPORT_STATE);
    },
    dispose: () => {
      disposed = true;
      nextToken += 1;
      clearActive();
    },
    load: async (item) => {
      const pending = start(item);

      let nextConfigurationKey: string | null = null;

      try {
        const generation = await options.getDatasetGeneration(pending.datasetId);
        if (disposed || active?.token !== pending.token || active?.itemId !== pending.itemId || active?.datasetId !== pending.datasetId) {
          return;
        }

        const request = createFitModelRequest(item, generation);
        nextConfigurationKey = fitModelConfigurationKey({
          responseColumn: request.responseColumn,
          terms: request.terms,
          centeringMethod: request.centeringMethod,
          confidenceLevel: request.confidenceLevel,
          generation: request.generation,
        });

        const running: ActiveFitModelRequest = {
          ...pending,
          generation,
          configurationKey: nextConfigurationKey,
        };
        active = running;

        const previousResult = resultFromState(state);
        if (previousResult !== null && state.configurationKey !== nextConfigurationKey) {
          emit({
            status: "stale",
            result: previousResult,
            error: null,
            configurationKey: nextConfigurationKey,
          });
        } else {
          emit({
            status: "loading",
            result: previousResult,
            error: null,
            configurationKey: nextConfigurationKey,
          });
        }

        const result = await options.run(request);
        if (!isActive(running)) {
          return;
        }

        emit({
          status: "success",
          result,
          error: null,
          configurationKey: nextConfigurationKey,
        });
      } catch (error) {
        const current = active;
        if (current == null || current.token !== pending.token || current.itemId !== pending.itemId || current.datasetId !== pending.datasetId) {
          return;
        }

        const message = normalizeFitModelReportError(error);
        const previousResult = resultFromState(state);
        const previousConfigurationKey = state.configurationKey;
        const inferredGeneration = generationFromConfigurationKey(previousConfigurationKey);
        const inferredConfigurationKey = inferredGeneration == null
          ? null
          : fitModelConfigurationKey({
            responseColumn: item.response.name,
            terms: item.terms,
            centeringMethod: item.centeringMethod,
            confidenceLevel: FIT_MODEL_CONFIDENCE_LEVEL,
            generation: inferredGeneration,
          });

        if (previousResult !== null) {
          const staleConfigurationKey = nextConfigurationKey
            ?? current.configurationKey
            ?? inferredConfigurationKey
            ?? previousConfigurationKey;
          if (staleConfigurationKey == null) {
            emit({
              status: "error",
              result: previousResult,
              error: message,
              configurationKey: null,
            });
            return;
          }

          emit({
            status: "stale",
            result: previousResult,
            error: message,
            configurationKey: staleConfigurationKey,
          });
          return;
        }

        const configurationKey = nextConfigurationKey
          ?? current.configurationKey
          ?? inferredConfigurationKey
          ?? previousConfigurationKey;

        emit({
          status: "error",
          result: null,
          error: message,
          configurationKey,
        });
      }
    },
  };
}

async function resolveFitModelReportDependencies(
  overrides: Partial<FitModelReportDependencies> | undefined,
): Promise<FitModelReportDependencies> {
  if (overrides?.getDatasetGeneration && overrides.run) {
    return {
      getDatasetGeneration: overrides.getDatasetGeneration,
      run: overrides.run,
    };
  }

  const [{ dataService }, { fitModelService }] = await Promise.all([
    import("../../services/dataService"),
    import("../../services/fitModelService"),
  ]);

  return {
    getDatasetGeneration: overrides?.getDatasetGeneration ?? dataService.getDatasetGeneration,
    run: overrides?.run ?? fitModelService.run,
  };
}

export function useFitModelReport(
  item: FitModelItem | null | undefined,
  generationSignal: FitModelReportGenerationSignal,
  dependencies?: Partial<FitModelReportDependencies>,
): FitModelReportState {
  const [snapshot, setSnapshot] = useState<{
    state: FitModelReportState;
    generationSignal: FitModelReportGenerationSignal;
  }>({
    state: FIT_MODEL_IDLE_REPORT_STATE,
    generationSignal,
  });
  const getDatasetGeneration = dependencies?.getDatasetGeneration;
  const run = dependencies?.run;

  useEffect(() => {
    if (item == null) {
      setSnapshot({
        state: FIT_MODEL_IDLE_REPORT_STATE,
        generationSignal,
      });
      return undefined;
    }

    let mounted = true;
    let controller: FitModelReportController | null = null;

    void (async () => {
      try {
        const resolved = await resolveFitModelReportDependencies({
          getDatasetGeneration,
          run,
        });
        if (!mounted) {
          return;
        }

        controller = createFitModelReportController({
          ...resolved,
          onStateChange: (state) => setSnapshot({ state, generationSignal }),
        });
        await controller.load(item);
      } catch (error) {
        if (!mounted) {
          return;
        }

        setSnapshot({
          state: {
            status: "error",
            result: null,
            error: normalizeFitModelReportError(error),
            configurationKey: null,
          },
          generationSignal,
        });
      }
    })();

    return () => {
      mounted = false;
      controller?.dispose();
    };
  }, [
    getDatasetGeneration,
    generationSignal,
    item,
    run,
  ]);

  return resolveFitModelReportStateForSignal(
    snapshot.state,
    snapshot.generationSignal,
    generationSignal,
  );
}