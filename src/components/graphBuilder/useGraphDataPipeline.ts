import { SCATTER_RENDER_BUDGET } from "../../graphCore/scatterBudget.ts";
import { resolveEffectiveGraphSampling } from "./graphSamplingPolicy.ts";
import { MAX_MULTIVARIATE_COLUMNS } from "./updateMultivariateColumns.ts";
import { useEffect, useMemo, useState } from "react";
import {
  decodeGraphPayload,
  type GraphAggregatePacket,
  type CorrelationMethod,
  type DecodedGraphChunk,
  type DecodedRawPointChunk,
  type GraphChunkHeader,
  type GraphDataCompletion,
  type GraphDataFrame,
  type GraphDataRequest,
  type GraphFieldBinding,
  type GraphSampling,
  type GraphElementRequest,
  type GraphViewport,
} from "../../types/graphData.ts";
import type { GraphBuilderItem } from "../../types/graphBuilder.ts";
import type { DatasetMeta, TableWindowFilter } from "../../types/data";
import type { FilterRuleItem } from "../../types/filter";

const VIEWPORT_DEBOUNCE_MS = 120;

interface PendingGraphState {
  request: GraphDataRequest;
  chunks: DecodedRawPointChunk[];
  aggregates: GraphAggregatePacket[];
  chunkIndexes: Set<number>;
  finalChunkIndex: number | null;
  dictionaries: Record<string, readonly string[]>;
  extents: Record<string, { min: number; max: number }>;
  progress: GraphLoadProgress;
}

export interface GraphLoadProgress {
  processedRows: number;
  sourceRows: number;
  percent: number | null;
}

export interface GraphStreamState {
  committed: GraphDataFrame | null;
  pending: PendingGraphState | null;
  pendingHeader: GraphChunkHeader | null;
  progress: GraphLoadProgress | null;
  error: string | null;
  status: "idle" | "pending" | "ready" | "error";
}

export type GraphStreamMessage =
  | { type: "start"; request: GraphDataRequest }
  | { type: "cancel"; requestId: string; generation: number }
  | { type: "header"; header: GraphChunkHeader }
  | { type: "payload"; payload: ArrayBuffer }
  | { type: "aggregate"; packet: GraphAggregatePacket }
  | { type: "chunk"; chunk: DecodedGraphChunk }
  | { type: "complete"; completion: GraphDataCompletion }
  | { type: "error"; requestId: string; generation: number; error: string };

export interface GraphDataPipelineResult {
  frame: GraphDataFrame | null;
  status: GraphStreamState["status"];
  error: string | null;
  progress: GraphLoadProgress | null;
  pendingRequest: GraphDataRequest | null;
}

export type ExternalGraphDataState =
  | { status: "loading"; frame: null; error: null }
  | { status: "ready"; frame: GraphDataFrame; error: null }
  | { status: "error"; frame: null; error: string };

type GraphRuntimeDataState = Pick<GraphDataPipelineResult, "frame" | "status" | "error" | "progress">;

export function selectGraphRuntimeDataState(
  internalState: GraphRuntimeDataState,
  externalState: ExternalGraphDataState | undefined,
): GraphRuntimeDataState {
  if (!externalState) return internalState;
  if (externalState.status === "ready") {
    return { frame: externalState.frame, status: "ready", error: null, progress: null };
  }
  if (externalState.status === "error") {
    return { frame: null, status: "error", error: externalState.error, progress: null };
  }
  return { frame: null, status: "pending", error: null, progress: null };
}

function sanitizeCount(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.trunc(value));
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(100, Math.max(0, value));
}

function derivePercent(
  processedRows: number,
  sourceRows: number,
  forceCompleteForZeroRows = false,
): number | null {
  if (sourceRows <= 0) {
    return forceCompleteForZeroRows ? 100 : null;
  }
  return clampPercent((processedRows / sourceRows) * 100);
}

function createProgress(
  processedRows: number,
  sourceRows: number,
  forceCompleteForZeroRows = false,
): GraphLoadProgress {
  const safeProcessedRows = sanitizeCount(processedRows);
  const safeSourceRows = sanitizeCount(sourceRows);
  return {
    processedRows: safeProcessedRows,
    sourceRows: safeSourceRows,
    percent: derivePercent(safeProcessedRows, safeSourceRows, forceCompleteForZeroRows),
  };
}

function deriveCommittedProgress(committed: GraphDataFrame | null): GraphLoadProgress | null {
  if (!committed) {
    return null;
  }
  const zeroRowFrame = sanitizeCount(committed.sourceRows) === 0;
  return createProgress(committed.processedRows, committed.sourceRows, zeroRowFrame);
}

function mergeMonotonicProgress(
  previous: GraphLoadProgress,
  processedRows: number,
  sourceRows: number,
): GraphLoadProgress {
  const safeProcessedRows = Math.max(previous.processedRows, sanitizeCount(processedRows));
  const safeSourceRows = Math.max(previous.sourceRows, sanitizeCount(sourceRows));
  return {
    processedRows: safeProcessedRows,
    sourceRows: safeSourceRows,
    percent: derivePercent(safeProcessedRows, safeSourceRows),
  };
}

function idleStatus(committed: GraphDataFrame | null): GraphStreamState["status"] {
  return committed ? "ready" : "idle";
}

export function createInitialGraphStreamState(
  committed: GraphDataFrame | null = null,
): GraphStreamState {
  return {
    committed,
    pending: null,
    pendingHeader: null,
    progress: deriveCommittedProgress(committed),
    error: null,
    status: idleStatus(committed),
  };
}

function isMatchingPending(state: GraphStreamState, requestId: string, generation: number): boolean {
  if (!state.pending) {
    return false;
  }
  return (
    state.pending.request.requestId === requestId
    && state.pending.request.generation === generation
  );
}

function failPending(state: GraphStreamState, error: string): GraphStreamState {
  return {
    ...state,
    pending: null,
    pendingHeader: null,
    progress: deriveCommittedProgress(state.committed),
    error,
    status: "error",
  };
}

function bitIsSet(bitmap: Uint8Array | undefined, rowIndex: number): boolean {
  if (!bitmap) {
    return true;
  }
  const byteIndex = rowIndex >> 3;
  if (byteIndex >= bitmap.length) {
    return false;
  }
  const mask = 1 << (rowIndex & 7);
  return (bitmap[byteIndex] & mask) !== 0;
}

function updateExtent(
  extents: Record<string, { min: number; max: number }>,
  key: string,
  value: number,
): void {
  if (!Number.isFinite(value)) {
    return;
  }
  const current = extents[key];
  if (!current) {
    extents[key] = { min: value, max: value };
    return;
  }
  if (value < current.min) {
    current.min = value;
  }
  if (value > current.max) {
    current.max = value;
  }
}

function applyChunkExtents(
  extents: Record<string, { min: number; max: number }>,
  chunk: DecodedGraphChunk,
): Record<string, { min: number; max: number }> {
  const next = { ...extents };
  for (let row = 0; row < chunk.rowCount; row += 1) {
    if (bitIsSet(chunk.validity.x, row)) {
      updateExtent(next, "x", Number(chunk.xValues[row]));
    }
    if (bitIsSet(chunk.validity.y, row)) {
      updateExtent(next, "y", Number(chunk.yValues[row]));
    }
    if (chunk.sizeValues && bitIsSet(chunk.validity.size, row)) {
      updateExtent(next, "size", Number(chunk.sizeValues[row]));
    }
    if (chunk.zValues && bitIsSet(chunk.validity.z, row)) {
      updateExtent(next, "z", Number(chunk.zValues[row]));
    }
  }
  return next;
}

function toRawChunk(chunk: DecodedGraphChunk): DecodedRawPointChunk {
  return {
    chunkIndex: chunk.chunkIndex,
    rowOffset: chunk.rowOffset,
    rowCount: chunk.rowCount,
    xValues: chunk.xValues,
    yValues: chunk.yValues,
    rowIds: chunk.rowIds,
    zValues: chunk.zValues,
    groupCodes: chunk.groupCodes,
    sizeValues: chunk.sizeValues,
    sourceCodes: chunk.sourceCodes,
    facetXCodes: chunk.facetXCodes,
    facetYCodes: chunk.facetYCodes,
    facetZCodes: chunk.facetZCodes,
    wrapCodes: chunk.wrapCodes,
    roleVectors: chunk.roleVectors,
    validity: chunk.validity,
  };
}

function ingestDecodedChunk(state: GraphStreamState, chunk: DecodedGraphChunk): GraphStreamState {
  if (!state.pending) {
    return state;
  }
  if (
    chunk.requestId !== state.pending.request.requestId
    || chunk.generation !== state.pending.request.generation
  ) {
    return state;
  }
  if (state.pending.chunkIndexes.has(chunk.chunkIndex)) {
    return failPending(state, `duplicate graph chunk index ${chunk.chunkIndex}`);
  }
  if (
    state.pending.finalChunkIndex !== null
    && chunk.chunkIndex > state.pending.finalChunkIndex
  ) {
    return failPending(state, "graph chunk arrived after final chunk marker");
  }

  let finalChunkIndex = state.pending.finalChunkIndex;
  if (chunk.finalChunk) {
    if (finalChunkIndex !== null && finalChunkIndex !== chunk.chunkIndex) {
      return failPending(state, "graph stream emitted multiple final chunks");
    }
    finalChunkIndex = chunk.chunkIndex;
  }

  const chunkIndexes = new Set(state.pending.chunkIndexes);
  chunkIndexes.add(chunk.chunkIndex);

  const dictionaries = { ...state.pending.dictionaries, ...chunk.dictionaries };
  const chunks = [...state.pending.chunks, toRawChunk(chunk)];
  const extents = applyChunkExtents(state.pending.extents, chunk);
  const progress = mergeMonotonicProgress(
    state.pending.progress,
    chunk.processedRows,
    chunk.sourceRows,
  );

  return {
    ...state,
    pending: {
      ...state.pending,
      chunks,
      chunkIndexes,
      finalChunkIndex,
      dictionaries,
      extents,
      progress,
    },
    pendingHeader: null,
    progress,
    error: null,
    status: "pending",
  };
}

function hasCoherentCompletion(
  pending: PendingGraphState,
  completion: GraphDataCompletion,
): boolean {
  const { chunksSent, rawPointDisposition } = completion;
  if (!rawPointDisposition) return false;
  if (chunksSent === 0) {
    return pending.finalChunkIndex === null
      && pending.chunkIndexes.size === 0
      && (rawPointDisposition.status === "empty" || rawPointDisposition.status === "omitted");
  }
  if (rawPointDisposition.status !== "included" || rawPointDisposition.validRows <= 0) return false;
  if (pending.finalChunkIndex === null) {
    return false;
  }
  if (chunksSent !== pending.finalChunkIndex + 1) {
    return false;
  }
  if (pending.chunkIndexes.size !== chunksSent) {
    return false;
  }
  for (let index = 0; index <= pending.finalChunkIndex; index += 1) {
    if (!pending.chunkIndexes.has(index)) {
      return false;
    }
  }
  return true;
}

export function reduceGraphStream(state: GraphStreamState, message: GraphStreamMessage): GraphStreamState {
  switch (message.type) {
    case "start": {
      const progress = createProgress(0, 0);
      return {
        ...state,
        pending: {
          request: message.request,
          chunks: [],
          aggregates: [],
          chunkIndexes: new Set<number>(),
          finalChunkIndex: null,
          dictionaries: {},
          extents: {},
          progress,
        },
        pendingHeader: null,
        progress,
        error: null,
        status: "pending",
      };
    }
    case "cancel": {
      if (!isMatchingPending(state, message.requestId, message.generation)) {
        return state;
      }
      return {
        ...state,
        pending: null,
        pendingHeader: null,
        progress: deriveCommittedProgress(state.committed),
        error: null,
        status: idleStatus(state.committed),
      };
    }
    case "header": {
      if (!isMatchingPending(state, message.header.requestId, message.header.generation)) {
        return state;
      }
      const pending = state.pending;
      if (!pending) {
        return state;
      }
      const expectedIndex = pending.chunkIndexes.size;
      if (message.header.chunkIndex !== expectedIndex) {
        return failPending(
          state,
          `graph header chunk index ${message.header.chunkIndex} arrived out of order (expected ${expectedIndex})`,
        );
      }
      if (state.pendingHeader) {
        return failPending(state, "graph header arrived before payload for previous chunk");
      }
      if (pending.chunkIndexes.has(message.header.chunkIndex)) {
        return failPending(state, `duplicate graph chunk index ${message.header.chunkIndex}`);
      }
      const progress = mergeMonotonicProgress(
        pending.progress,
        message.header.processedRows,
        message.header.sourceRows,
      );
      return {
        ...state,
        pending: {
          ...pending,
          progress,
        },
        pendingHeader: message.header,
        progress,
      };
    }
    case "payload": {
      if (!state.pending) {
        return state;
      }
      const header = state.pendingHeader;
      if (!header) {
        return failPending(state, "graph payload arrived without a matching header");
      }
      try {
        const decoded = decodeGraphPayload(header, message.payload);
        return ingestDecodedChunk(state, decoded);
      } catch (error) {
        return failPending(state, `invalid graph payload: ${String(error)}`);
      }
    }
    case "chunk": {
      return ingestDecodedChunk(state, message.chunk);
    }
    case "aggregate": {
      if (!state.pending) {
        return state;
      }
      return {
        ...state,
        pending: {
          ...state.pending,
          aggregates: [...state.pending.aggregates, message.packet],
        },
      };
    }
    case "complete": {
      const completion = message.completion;
      if (!isMatchingPending(state, completion.requestId, completion.generation)) {
        return state;
      }
      if (completion.cancelled) {
        return {
          ...state,
          pending: null,
          pendingHeader: null,
          progress: deriveCommittedProgress(state.committed),
          error: null,
          status: idleStatus(state.committed),
        };
      }
      if (!state.pending) {
        return state;
      }
      if (state.pendingHeader) {
        return failPending(state, "graph terminal marker arrived with a pending header");
      }
      if (!hasCoherentCompletion(state.pending, completion)) {
        return failPending(state, "graph terminal marker has inconsistent chunksSent");
      }

      const zeroRowsComplete = completion.chunksSent === 0
        && sanitizeCount(completion.sourceRows) === 0
        && sanitizeCount(completion.processedRows) === 0;
      const completionProgress = {
        ...mergeMonotonicProgress(
          state.pending.progress,
          completion.processedRows,
          completion.sourceRows,
        ),
        percent: derivePercent(
          Math.max(state.pending.progress.processedRows, sanitizeCount(completion.processedRows)),
          Math.max(state.pending.progress.sourceRows, sanitizeCount(completion.sourceRows)),
          zeroRowsComplete,
        ),
      };

      const rawChunks = [...state.pending.chunks].sort(
        (left, right) => left.chunkIndex - right.chunkIndex,
      );

      const committed: GraphDataFrame = {
        requestId: state.pending.request.requestId,
        datasetId: completion.datasetId,
        generation: completion.generation,
        sourceRows: completionProgress.sourceRows,
        processedRows: completionProgress.processedRows,
        sampling: state.pending.request.sampling,
        dictionaries: state.pending.dictionaries,
        extents: state.pending.extents,
        rawChunks,
        aggregates: state.pending.aggregates,
        rawPointDisposition: completion.rawPointDisposition,
      };

      return {
        committed,
        pending: null,
        pendingHeader: null,
        progress: completionProgress,
        error: null,
        status: "ready",
      };
    }
    case "error": {
      if (!isMatchingPending(state, message.requestId, message.generation)) {
        return state;
      }
      return failPending(state, message.error);
    }
  }
}

function serializeFilters(filters: FilterRuleItem[]): TableWindowFilter[] {
  return filters.map(({ op, rule }) => {
    switch (rule.kind) {
      case "continuous":
        return {
          op,
          rule: { kind: rule.kind, field: rule.field.name, min: rule.min, max: rule.max },
        };
      case "categorical":
        return {
          op,
          rule: {
            kind: rule.kind,
            field: rule.field.name,
            selected: rule.selected,
            exclude: rule.exclude ?? false,
          },
        };
      case "date":
        return {
          op,
          rule: { kind: rule.kind, field: rule.field.name, start: rule.start, end: rule.end },
        };
    }
  });
}

const CORRELATION_METHOD_SET: ReadonlySet<CorrelationMethod> = new Set([
  "pearson",
  "spearman",
  "kendall",
]);

function normalizeCorrelationMethod(value: unknown): CorrelationMethod {
  if (typeof value === "string" && CORRELATION_METHOD_SET.has(value as CorrelationMethod)) {
    return value as CorrelationMethod;
  }
  return "pearson";
}

export function deriveElements(item: GraphBuilderItem): GraphElementRequest[] {
  if (item.mode === "multivariate") {
    return [{
      kind: "correlationMatrix",
      summaryStat: "none",
      correlationMethod: normalizeCorrelationMethod(item.modeStates.multivariate.correlationMethod),
    }];
  }

  const activeElements = item.mode === "3d"
    ? item.modeStates.threeD.elements
    : item.modeStates.twoD.elements;

  return activeElements
    .filter((element) => element.enabled !== false)
    .map((element) => {
      const requestElement: GraphElementRequest = {
        kind: element.kind,
        summaryStat:
          typeof element.options?.summaryStat === "string"
            ? String(element.options.summaryStat)
            : "none",
      };

      if (element.kind === "correlationMatrix") {
        return {
          ...requestElement,
          correlationMethod: normalizeCorrelationMethod(element.options?.correlationMethod),
        };
      }

      return requestElement;
    });
}

function isFitYByXAnalysisGraph(
  item: GraphBuilderItem,
  elements: readonly GraphElementRequest[],
): boolean {
  if (item.mode !== "2d" || !item.id.startsWith("fit-y-by-x-graph:")) {
    return false;
  }

  const kinds = new Set(elements.map((element) => String(element.kind).toLowerCase()));
  return kinds.has("boxplot") || kinds.has("fitline");
}

export function deriveGraphRequestParts(item: GraphBuilderItem): {
  fields: GraphFieldBinding[];
  filters: TableWindowFilter[];
  elements: GraphElementRequest[];
  sampling: GraphSampling;
} {
  const elements = deriveElements(item);
  return {
    fields: deriveFields(item),
    filters: serializeFilters(item.filters ?? []),
    elements,
    sampling: item.mode === "multivariate" || isFitYByXAnalysisGraph(item, elements)
      ? { mode: "full" }
      : resolveEffectiveGraphSampling(item.sampling, elements),
  };
}

export function canExecuteGraphRequest(
  item: GraphBuilderItem,
  fields: readonly GraphFieldBinding[],
  elements: readonly GraphElementRequest[],
): boolean {
  if (item.mode === "multivariate") {
    const selectedColumns = item.modeStates.multivariate.columns.length;
    return selectedColumns >= 2 && selectedColumns <= MAX_MULTIVARIATE_COLUMNS;
  }

  const hasCorrelationElement = elements.some((element) => element.kind === "correlationMatrix");
  if (hasCorrelationElement) {
    return fields.some((field) => /^multi[XY]\d+$/.test(field.role));
  }

  const hasX = fields.some((field) => field.role === "x");
  const hasY = fields.some((field) => field.role === "y");
  const activeState = item.mode === "3d" ? item.modeStates.threeD : item.modeStates.twoD;
  const hasNormalCurve = elements.some((element) => element.kind === "normalCurve");
  if (hasNormalCurve) {
    const continuousField = activeState.encoding.y?.type === "continuous"
      ? activeState.encoding.y
      : activeState.encoding.x?.type === "continuous"
        ? activeState.encoding.x
        : undefined;
    if (continuousField && fields.some((field) => field.column === continuousField.name)) return true;
  }
  const multiXCount = fields.filter((field) => /^multiX\d+$/.test(field.role)).length;
  const multiYCount = fields.filter((field) => /^multiY\d+$/.test(field.role)).length;
  return (hasX && hasY) || multiXCount >= 2 || multiYCount >= 2;
}

interface GraphRequestPlan {
  fields: GraphFieldBinding[];
  filters: TableWindowFilter[];
  elements: GraphElementRequest[];
  sampling: GraphSampling;
  executable: boolean;
}

function deriveGraphRequestPlan(item: GraphBuilderItem): GraphRequestPlan {
  const parts = deriveGraphRequestParts(item);
  return {
    ...parts,
    executable: canExecuteGraphRequest(item, parts.fields, parts.elements),
  };
}

export function deriveGraphRequestIdentity(item: GraphBuilderItem): string {
  return JSON.stringify(deriveGraphRequestPlan(item));
}

function hasEnabledElementKinds(elements: readonly GraphElementRequest[]): Set<string> {
  return new Set(
    elements
      .map((element) => String(element.kind).toLowerCase()),
  );
}

function deriveGroupingColumn(
  mode: GraphBuilderItem["mode"],
  encoding: Partial<Record<"x" | "y" | "z" | "color" | "size" | "overlay" | "groupX" | "groupY" | "groupZ" | "wrap", { name: string }>>,
): string | undefined {
  return (
    encoding.overlay?.name
    ?? encoding.color?.name
    ?? encoding.groupX?.name
    ?? encoding.groupY?.name
    ?? (mode === "3d" ? encoding.groupZ?.name : undefined)
    ?? encoding.wrap?.name
  );
}

function deriveActiveMultiFields(item: GraphBuilderItem): GraphFieldBinding[] {
  if (item.mode !== "2d") {
    return [];
  }

  const multiX = item.modeStates.twoD.multiX ?? [];
  const multiY = item.modeStates.twoD.multiY ?? [];
  const xActive = multiX.length >= 2;
  const yActive = multiY.length >= 2;

  if (!xActive && !yActive) {
    return [];
  }

  const out: GraphFieldBinding[] = [];
  if (xActive) {
    for (let index = 0; index < multiX.length; index += 1) {
      out.push({ role: `multiX${index}`, column: multiX[index].name });
    }
  }
  if (yActive) {
    for (let index = 0; index < multiY.length; index += 1) {
      out.push({ role: `multiY${index}`, column: multiY[index].name });
    }
  }
  return out;
}

export function deriveFields(item: GraphBuilderItem): GraphFieldBinding[] {
  if (item.mode === "multivariate") {
    const fields: GraphFieldBinding[] = [];
    const seen = new Set<string>();
    const columns = item.modeStates.multivariate.columns ?? [];

    const addField = (role: string, column: string | undefined): void => {
      if (!column || seen.has(`${role}:${column}`)) {
        return;
      }
      seen.add(`${role}:${column}`);
      fields.push({ role, column });
    };

    for (let index = 0; index < columns.length; index += 1) {
      addField(`multiY${index}`, columns[index].name);
    }

    for (const filter of item.filters ?? []) {
      addField("filter", filter.rule.field.name);
    }

    return fields;
  }

  const fields: GraphFieldBinding[] = [];
  const seen = new Set<string>();
  const activeMode = item.mode;
  const activeState = activeMode === "3d" ? item.modeStates.threeD : item.modeStates.twoD;
  const enabledKinds = hasEnabledElementKinds(deriveElements(item));
  const encoding = activeState.encoding;

  const addField = (role: string, column: string | undefined): void => {
    if (!column || seen.has(`${role}:${column}`)) {
      return;
    }
    seen.add(`${role}:${column}`);
    fields.push({ role, column });
  };

  const normalCurveXOnly =
    enabledKinds.has("normalcurve") &&
    encoding.x?.type === "continuous" &&
    !encoding.y;
  if (normalCurveXOnly) {
    addField("y", encoding.x?.name);
  } else {
    addField("x", encoding.x?.name);
    addField("y", encoding.y?.name);
  }
  const has3DElement = enabledKinds.has("surface") || enabledKinds.has("contour3d") || enabledKinds.has("scatter3d");
  if (activeMode === "3d" && has3DElement) {
    addField("z", item.modeStates.threeD.encoding.z?.name);
  }

  const canUseSize = enabledKinds.has("points") || enabledKinds.has("scatter3d");
  if (canUseSize) {
    addField("size", encoding.size?.name);
  }

  const hasHiddenGroups = (activeState.hiddenGroups?.length ?? 0) > 0;
  const canUseGroup = enabledKinds.size > 0 || hasHiddenGroups;
  if (canUseGroup) {
    addField("group", deriveGroupingColumn(activeMode, encoding));
  }

  addField("groupX", encoding.groupX?.name);
  if (activeMode === "3d") {
    addField("groupZ", item.modeStates.threeD.encoding.groupZ?.name);
  }
  addField("groupY", encoding.groupY?.name);
  addField("wrap", encoding.wrap?.name);

  for (const filter of item.filters ?? []) {
    addField("filter", filter.rule.field.name);
  }

  for (const multiField of deriveActiveMultiFields(item)) {
    addField(multiField.role, multiField.column);
  }

  return fields;
}

function createRequestId(datasetId: string, generation: number): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${datasetId}-${generation}-${crypto.randomUUID()}`;
  }
  return `${datasetId}-${generation}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

type StreamCancelFn = (() => Promise<void>) | (() => void);

function invokeCancelSafely(cancel: StreamCancelFn): void {
  try {
    const result = cancel();
    if (result && typeof (result as Promise<void>).then === "function") {
      void (result as Promise<void>).catch(() => {
        // Ignore transport cancellation failures. State fencing already prevents stale commits.
      });
    }
  } catch {
    // Ignore transport cancellation failures. State fencing already prevents stale commits.
  }
}

export interface StreamStartCancellationHandle {
  wrap: <TArgs extends unknown[]>(callback: (...args: TArgs) => void) => (...args: TArgs) => void;
  bindCancel: (cancel: StreamCancelFn) => void;
  cancel: () => void;
}

export interface StreamStartCancellationCoordinator {
  activate: (requestId: string, generation: number) => StreamStartCancellationHandle;
  cancelActive: () => void;
}

export function createStreamStartCancellationCoordinator(
  onCancelState: (requestId: string, generation: number) => void,
): StreamStartCancellationCoordinator {
  let activeHandle: StreamStartCancellationHandle | null = null;

  const activate = (requestId: string, generation: number): StreamStartCancellationHandle => {
    activeHandle?.cancel();

    let cancelled = false;
    let reducerCancelDispatched = false;
    let transportCancel: StreamCancelFn | null = null;
    let transportCancelInvoked = false;

    const cancel = (): void => {
      if (cancelled) {
        return;
      }
      cancelled = true;

      if (!reducerCancelDispatched) {
        reducerCancelDispatched = true;
        onCancelState(requestId, generation);
      }

      if (transportCancel && !transportCancelInvoked) {
        transportCancelInvoked = true;
        invokeCancelSafely(transportCancel);
      }
    };

    const handle: StreamStartCancellationHandle = {
      wrap: <TArgs extends unknown[]>(callback: (...args: TArgs) => void) =>
        (...args: TArgs) => {
          if (cancelled || activeHandle !== handle) {
            return;
          }
          callback(...args);
        },
      bindCancel: (cancelFn: StreamCancelFn) => {
        transportCancel = cancelFn;
        if (cancelled && !transportCancelInvoked) {
          transportCancelInvoked = true;
          invokeCancelSafely(cancelFn);
        }
      },
      cancel,
    };

    activeHandle = handle;
    return handle;
  };

  return {
    activate,
    cancelActive: () => {
      activeHandle?.cancel();
    },
  };
}

export function useGraphDataPipeline(
  item: GraphBuilderItem,
  dataset: DatasetMeta,
  viewport: GraphViewport,
  enabled = true,
): GraphDataPipelineResult {
  const [state, setState] = useState<GraphStreamState>(() => createInitialGraphStreamState());
  const [debouncedViewport, setDebouncedViewport] = useState<GraphViewport>(viewport);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedViewport(viewport);
    }, VIEWPORT_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [viewport.height, viewport.width]);

  const requestIdentity = deriveGraphRequestIdentity(item);
  const requestPlan = useMemo(
    () => JSON.parse(requestIdentity) as GraphRequestPlan,
    [requestIdentity],
  );
  const requestSkeleton = useMemo(() => {
    if (!enabled) return null;

    return {
      datasetId: dataset.id,
      ...requestPlan,
      viewport: debouncedViewport,
    };
  }, [dataset.generation, dataset.id, requestPlan, debouncedViewport, enabled]);

  useEffect(() => {
    if (!enabled || !requestSkeleton) {
      setState(createInitialGraphStreamState());
      return;
    }
    if (!requestSkeleton.executable) {
      setState((previous) => ({
        ...previous,
        pending: null,
        pendingHeader: null,
        error: null,
        status: idleStatus(previous.committed),
      }));
      return;
    }

    let disposed = false;
    const cancellationCoordinator = createStreamStartCancellationCoordinator((requestId, generation) => {
      setState((previous) => reduceGraphStream(previous, {
        type: "cancel",
        requestId,
        generation,
      }));
    });

    const load = async (): Promise<void> => {
      try {
        const [{ dataService }, { graphDataService }] = await Promise.all([
          import("../../services/dataService"),
          import("../../services/graphDataService"),
        ]);

        const generation = await dataService.getDatasetGeneration(dataset.id);
        if (disposed) {
          return;
        }

        const requestId = createRequestId(dataset.id, generation);
        const request: GraphDataRequest = {
          requestId,
          datasetId: dataset.id,
          generation,
          fields: requestSkeleton.fields,
          filters: requestSkeleton.filters,
          elements: requestSkeleton.elements,
          sampling: requestSkeleton.sampling,
          rawPointBudget: SCATTER_RENDER_BUDGET,
          viewport: requestSkeleton.viewport,
        };

        setState((previous) => reduceGraphStream(previous, { type: "start", request }));
        const streamHandle = cancellationCoordinator.activate(requestId, generation);

        const stream = graphDataService.stream(request, {
          onHeader: streamHandle.wrap((header) => {
            setState((previous) => reduceGraphStream(previous, { type: "header", header }));
          }),
          onPayload: streamHandle.wrap((payload) => {
            setState((previous) => reduceGraphStream(previous, { type: "payload", payload }));
          }),
          onAggregate: streamHandle.wrap((packet) => {
            setState((previous) => reduceGraphStream(previous, { type: "aggregate", packet }));
          }),
          onComplete: streamHandle.wrap((completion) => {
            setState((previous) => reduceGraphStream(previous, { type: "complete", completion }));
          }),
          onError: streamHandle.wrap((error) => {
            setState((previous) =>
              reduceGraphStream(previous, {
                type: "error",
                requestId,
                generation,
                error,
              }));
          }),
        });

        streamHandle.bindCancel(stream.cancel);
        if (disposed) {
          streamHandle.cancel();
        }
      } catch (error) {
        if (disposed) {
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        setState((previous) => ({
          ...previous,
          pending: null,
          pendingHeader: null,
          progress: deriveCommittedProgress(previous.committed),
          error: message,
          status: "error",
        }));
      }
    };

    void load();

    return () => {
      disposed = true;
      cancellationCoordinator.cancelActive();
    };
  }, [dataset.id, enabled, requestSkeleton]);

  return {
    frame: state.committed,
    status: state.status,
    error: state.error,
    progress: state.progress,
    pendingRequest: state.pending?.request ?? null,
  };
}
