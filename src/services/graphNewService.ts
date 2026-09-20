import { Channel, invoke } from "@tauri-apps/api/core";
import type { GraphNewRawMode, GraphNewXMode } from "../types/graphBuilderNew";

import { isCameraDomain, normalizedAxisValue, type CameraDomain, type PlotRect } from "../components/graphBuilderNew/graphNewCamera";
import {
  createGraphNewFrameReceiver,
  type GraphNewFrameReceiverSnapshot,
} from "./graphNewTransport";
import type {
  GraphNewFrame,
  GraphNewFrameHeader,
  GraphNewFrameIdentity,
  GraphNewFrameMetrics,
  GraphNewFrameToken,
} from "../types/graphNew";

let lastRender: GraphNewRenderRequest | null = null;
const GROUP_ID = /^sha256:[0-9a-f]{64}$/;
const MAX_HIDDEN_OVERLAY_GROUPS = 64;
const MAX_OVERLAY_LABEL_BYTES = 512;
const textEncoder = new TextEncoder();

export interface GraphNewTransportProbeRequest {
  requestId: string;
  width: number;
  height: number;
  frames: number;
  format: "rgba8";
}

export interface GraphNewTransportProbeCompletion {
  requestId: string;
  framesRequested: number;
  framesSent: number;
  droppedSupersededFrames: number;
  peakTransportBytes: number;
  maximumQueueDepth: number;
  renderMs: number[];
  readbackMs: number[];
}

export interface GraphNewProbeHandlers {
  activeIdentity: () => GraphNewFrameIdentity;
  onFrame: (frame: GraphNewFrame) => void;
  onPresented?: (metrics: GraphNewFrameMetrics) => void;
  onError: (message: string) => void;
}

export interface GraphNewProbeController {
  completion: Promise<GraphNewTransportProbeCompletion>;
  canPresent: (token: GraphNewFrameToken) => boolean;
  markPresented: (token: GraphNewFrameToken, presentedAtMs: number) => void;
  snapshot: () => GraphNewFrameReceiverSnapshot;
}

export interface GraphNewRenderRequest extends GraphNewFrameIdentity {
  sessionId: string;
  datasetId: string;
  xColumnId: string;
  yColumnId: string;
  width: number;
  height: number;
  devicePixelRatio: number;
  cameraDomain?: CameraDomain | null;
  showMean?: boolean;
  xMode?: GraphNewXMode;
  rawMode?: GraphNewRawMode;
  overlayColumnId?: string | null;
  hiddenOverlayGroupIds?: string[];
}

export interface GraphNewAxis {
  kind: Exclude<GraphNewXMode, "auto">;
  utc: boolean;
  origin?: { epochNanos: string; unitNanos: number } | null;
  ticks: { value: number; position: number; label: string | null }[];
}

export interface GraphNewRenderCompletion {
  requestId: string;
  xAxis?: GraphNewAxis;
  rawMode?: GraphNewRawMode;
  rawLineAvailable?: boolean;
  rawLineSegments?: number;
  overlayGroups: GraphNewOverlayGroup[];
  overlayActive: boolean;
  hiddenOverlayGroups: number;
  processedRows: number;
  finiteRows: number;
  excludedNonFiniteRows: number;
  selectedMarks: number;
  meanAvailable?: boolean;
  meanGroups?: number | null;
  meanVisible?: boolean;
  exactVisible: boolean;
  visibleRows: number | null;
  rawIndexEntriesInspected: number;
  rawBlocksInspected: number;
  rawPointsInspected: number;
  buildMs: number;
  renderMs: number;
  readbackMs: number;
  width: number;
  height: number;
  cameraDomain: CameraDomain;
  plotRect: PlotRect;
  sourceProjectionQueryCount: number;
  renderGenerationCheckCount: number;
}

export interface GraphNewOverlayGroup {
  id: string;
  code: number;
  label: string;
  color: [number, number, number, number];
  totalRows: number;
  missing: boolean;
}

export interface GraphNewRenderController extends Omit<GraphNewProbeController, "completion"> {
  completion: Promise<GraphNewRenderCompletion>;
  cancel: (preserveCache?: boolean) => Promise<void>;
}

function safeReason(error: unknown): string {
  const message = describeError(error);
  const match = /^(?:(?:Stats error|Invalid parameter|Busy|Cancelled): )?(graph_new_(?:cancelled|stale_dataset|invalid_request|busy|render_failed|channel_closed|missing_cache|x_unrepresentable|cache_pressure|gpu_validation|overlay_too_many_groups|overlay_value_too_large|overlay_group_missing|overlay_cache_incompatible))$/.exec(message);
  return match?.[1] ?? "graph_new_render_failed";
}

function validateRenderRequest(request: GraphNewRenderRequest): void {
  if (request.xMode !== undefined && !["auto", "numeric", "time", "duration", "category"].includes(request.xMode)) throw new Error("graph_new_invalid_request");
  if (request.rawMode !== undefined && !["scatter", "line", "pointsLine"].includes(request.rawMode)) throw new Error("graph_new_invalid_request");
  if (request.showMean !== undefined && typeof request.showMean !== "boolean") throw new Error("graph_new_invalid_request");
  if (request.cameraDomain != null && !isCameraDomain(request.cameraDomain)) throw new Error("graph_new_invalid_request");
  if (request.overlayColumnId != null && (typeof request.overlayColumnId !== "string"
    || !request.overlayColumnId.trim()
    || request.overlayColumnId.trim() !== request.overlayColumnId
    || textEncoder.encode(request.overlayColumnId).length > 256)) {
    throw new Error("graph_new_invalid_request");
  }
  const hiddenOverlayGroupIds = request.hiddenOverlayGroupIds ?? [];
  if (!Array.isArray(hiddenOverlayGroupIds)
    || hiddenOverlayGroupIds.length > MAX_HIDDEN_OVERLAY_GROUPS
    || new Set(hiddenOverlayGroupIds).size !== hiddenOverlayGroupIds.length
    || hiddenOverlayGroupIds.some((id) => typeof id !== "string" || !GROUP_ID.test(id))
    || (request.overlayColumnId == null && hiddenOverlayGroupIds.length > 0)) {
    throw new Error("graph_new_invalid_request");
  }
  const identifiers = [request.requestId, request.sessionId, request.datasetId, request.xColumnId, request.yColumnId];
  const generations = [request.datasetGeneration, request.rendererGeneration, request.cameraGeneration];
  if (identifiers.some((value) => typeof value !== "string" || !value.trim() || value.trim() !== value || textEncoder.encode(value).length > 256)
    || generations.some((value) => !Number.isSafeInteger(value) || value < 0)
    || request.rendererGeneration === 0
    || !Number.isSafeInteger(request.width) || request.width < 96
    || !Number.isSafeInteger(request.height) || request.height < 64
    || !Number.isFinite(request.devicePixelRatio) || request.devicePixelRatio < 0.5 || request.devicePixelRatio > 8
    || Math.ceil(request.width * request.devicePixelRatio) > 3840
    || Math.ceil(request.height * request.devicePixelRatio) > 2160) {
    throw new Error("graph_new_invalid_request");
  }
}

function validateCompletion(completion: GraphNewRenderCompletion, request: GraphNewRenderRequest): void {
  const overlayGroups = completion?.overlayGroups;
  const requestedHidden = request.hiddenOverlayGroupIds ?? [];
  if (typeof completion?.overlayActive !== "boolean"
    || !Array.isArray(overlayGroups)
    || overlayGroups.length > MAX_HIDDEN_OVERLAY_GROUPS
    || !Number.isSafeInteger(completion.hiddenOverlayGroups)
    || completion.hiddenOverlayGroups < 0
    || completion.hiddenOverlayGroups > overlayGroups.length
    || overlayGroups.some((group) => !group
      || typeof group.id !== "string" || !GROUP_ID.test(group.id)
      || !Number.isSafeInteger(group.code) || group.code < 0 || group.code > 0xffff
      || typeof group.label !== "string" || textEncoder.encode(group.label).length > MAX_OVERLAY_LABEL_BYTES
      || !Array.isArray(group.color) || group.color.length !== 4
      || group.color.some((channel) => !Number.isSafeInteger(channel) || channel < 0 || channel > 255)
      || !Number.isSafeInteger(group.totalRows) || group.totalRows < 0 || group.totalRows > completion.finiteRows
      || typeof group.missing !== "boolean")
    || new Set(overlayGroups.map((group) => group.id)).size !== overlayGroups.length
    || new Set(overlayGroups.map((group) => group.code)).size !== overlayGroups.length) {
    throw new Error("graph_new_render_failed");
  }
  if (completion.overlayActive) {
    if (request.overlayColumnId == null
      || requestedHidden.length !== completion.hiddenOverlayGroups
      || requestedHidden.some((id) => !overlayGroups.some((group) => group.id === id))
      || overlayGroups.reduce((sum, group) => sum + group.totalRows, 0) !== completion.finiteRows) {
      throw new Error("graph_new_render_failed");
    }
  } else if (overlayGroups.length !== 0 || completion.hiddenOverlayGroups !== 0) {
    throw new Error("graph_new_render_failed");
  }
  if (request.xMode !== undefined || completion?.xAxis !== undefined) {
    const axis = completion?.xAxis;
    if (!axis || !["numeric", "time", "duration", "category"].includes(axis.kind) || typeof axis.utc !== "boolean"
      || (axis.origin != null && (axis.kind !== "time" || typeof axis.origin.epochNanos !== "string"
        || !/^-?\d{1,25}$/.test(axis.origin.epochNanos) || ![1, 1000, 1000000, 1000000000].includes(axis.origin.unitNanos)))
      || (request.xMode && request.xMode !== "auto" && axis.kind !== request.xMode)
      || !Array.isArray(axis.ticks) || axis.ticks.length > 12
      || axis.ticks.some((tick, index) => !tick || !Number.isFinite(tick.value) || !Number.isFinite(tick.position)
        || tick.position < 0 || tick.position > 1 || (index > 0 && tick.position <= axis.ticks[index - 1].position)
        || (axis.kind === "category" ? typeof tick.label !== "string" || textEncoder.encode(tick.label).length > 512 : tick.label !== null)
        || !completion.cameraDomain || !(Math.abs(normalizedAxisValue(tick.value, completion.cameraDomain.xMin, completion.cameraDomain.xMax) - tick.position) <= 1e-6))) {
      throw new Error("graph_new_render_failed");
    }
  }
  if (request.rawMode !== undefined || completion?.rawMode !== undefined) {
    if (completion?.rawMode !== (request.rawMode ?? "scatter") || typeof completion.rawLineAvailable !== "boolean"
      || !Number.isSafeInteger(completion.rawLineSegments) || completion.rawLineSegments! < 0
      || completion.rawLineSegments! > Math.max(0, completion.finiteRows - 1)
      || ((!completion.rawLineAvailable || completion.rawMode === "scatter") && completion.rawLineSegments !== 0)
      || (completion.rawLineAvailable && completion.finiteRows > 0 && !completion.exactVisible)) {
      throw new Error("graph_new_render_failed");
    }
  }
  if (request.showMean || completion?.meanAvailable !== undefined || completion?.meanGroups !== undefined || completion?.meanVisible !== undefined) {
    const groups = completion?.meanGroups;
    const computed = request.showMean === true && completion?.meanAvailable === true;
    if (typeof completion?.meanAvailable !== "boolean" || typeof completion?.meanVisible !== "boolean"
      || (completion.meanAvailable && completion.finiteRows > 0 && !completion.exactVisible)
      || (computed ? (typeof groups !== "number" || !Number.isSafeInteger(groups) || groups < 0
        || groups > completion.finiteRows || (completion.finiteRows > 0 && groups === 0)) : groups !== null)
      || completion.meanVisible !== (computed && typeof groups === "number" && groups >= 2)) {
      throw new Error("graph_new_render_failed");
    }
  }
  const submitsWholeGeometry = completion?.exactVisible === true
    && completion.selectedMarks === completion.finiteRows;
  if (!completion || completion.requestId !== request.requestId
    || completion.width !== Math.ceil(request.width * request.devicePixelRatio)
    || completion.height !== Math.ceil(request.height * request.devicePixelRatio)
    || [completion.processedRows, completion.finiteRows, completion.excludedNonFiniteRows, completion.selectedMarks,
      completion.rawIndexEntriesInspected, completion.rawBlocksInspected, completion.rawPointsInspected]
      .some((value) => !Number.isSafeInteger(value) || value < 0)
    || completion.processedRows !== completion.finiteRows + completion.excludedNonFiniteRows
    || typeof completion.exactVisible !== "boolean"
    || (completion.visibleRows !== null && (!Number.isSafeInteger(completion.visibleRows)
      || completion.visibleRows < 0 || completion.visibleRows > completion.finiteRows
      || (!submitsWholeGeometry && completion.selectedMarks > completion.visibleRows)))
    || (completion.exactVisible && (completion.visibleRows === null
      || (!submitsWholeGeometry && completion.selectedMarks !== completion.visibleRows)))
    || completion.rawBlocksInspected > completion.rawIndexEntriesInspected
    || completion.rawPointsInspected > completion.finiteRows
    || completion.selectedMarks > completion.finiteRows || completion.selectedMarks > 2_100_000
    || [completion.buildMs, completion.renderMs, completion.readbackMs].some((value) => !Number.isFinite(value) || value < 0)
    || !completion.cameraDomain || !completion.plotRect
    || [completion.cameraDomain.xMin, completion.cameraDomain.xMax, completion.cameraDomain.yMin, completion.cameraDomain.yMax].some((value) => !Number.isFinite(value))
    || completion.cameraDomain.xMin > completion.cameraDomain.xMax || completion.cameraDomain.yMin > completion.cameraDomain.yMax
    || [completion.plotRect.x, completion.plotRect.y, completion.plotRect.width, completion.plotRect.height,
      completion.sourceProjectionQueryCount, completion.renderGenerationCheckCount].some((value) => !Number.isSafeInteger(value) || value < 0)
    || completion.plotRect.width === 0 || completion.plotRect.height === 0
    || completion.plotRect.x + completion.plotRect.width > completion.width
    || completion.plotRect.y + completion.plotRect.height > completion.height
    || (request.cameraDomain != null && (completion.sourceProjectionQueryCount !== 0
      || (Object.keys(request.cameraDomain) as (keyof CameraDomain)[]).some((key) => request.cameraDomain![key] !== completion.cameraDomain[key])))) {
    throw new Error("graph_new_render_failed");
  }
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? value as Record<string, unknown>
    : null;
}

function parseHeader(message: unknown): GraphNewFrameHeader | null {
  let structured = message;
  if (typeof message === "string") {
    try {
      structured = JSON.parse(message) as unknown;
    } catch {
      return null;
    }
  }
  const envelope = toRecord(structured);
  const header = toRecord(envelope?.header);
  if (!envelope || envelope.messageType !== "header" || !header) return null;
  if (typeof header.requestId !== "string"
    || !header.requestId.trim() || header.requestId.length > 256
    || [header.datasetGeneration, header.rendererGeneration, header.cameraGeneration, header.readbackCompletedAtUnixMicros].some((value) => typeof value !== "number" || value < 0)
    || !Number.isSafeInteger(header.datasetGeneration)
    || !Number.isSafeInteger(header.rendererGeneration)
    || !Number.isSafeInteger(header.cameraGeneration)
    || !Number.isSafeInteger(header.frameId)
    || !Number.isSafeInteger(header.width)
    || !Number.isSafeInteger(header.height)
    || !Number.isSafeInteger(header.byteLength)
    || !Number.isSafeInteger(header.readbackCompletedAtUnixMicros)
    || (header.format !== "rgba8" && header.format !== "png")) {
    return null;
  }
  return header as unknown as GraphNewFrameHeader;
}

function toRawPayload(message: unknown): ArrayBuffer | null {
  if (message instanceof ArrayBuffer) return message;
  if (ArrayBuffer.isView(message)
    && message.buffer instanceof ArrayBuffer
    && message.byteOffset === 0
    && message.byteLength === message.buffer.byteLength) {
    return message.buffer;
  }
  return null;
}

function tokenFromHeader(header: GraphNewFrameHeader): GraphNewFrameToken {
  return {
    requestId: header.requestId,
    datasetGeneration: header.datasetGeneration,
    rendererGeneration: header.rendererGeneration,
    cameraGeneration: header.cameraGeneration,
    frameId: header.frameId,
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function startRequest<Completion>(
    command: string,
    request: GraphNewTransportProbeRequest | GraphNewRenderRequest,
    handlers: GraphNewProbeHandlers,
    safe = false,
    validate?: (completion: Completion) => void,
  ) {
    const channel = new Channel<unknown>();
    let pendingToken: GraphNewFrameToken | null = null;
    let failed = false;
    let cancelled = false;
    const fail = (message: string): void => {
      if (failed || cancelled) return;
      failed = true;
      handlers.onError(safe ? safeReason(message) : message);
      if (safe && "sessionId" in request) {
        void invoke<void>("cancel_graph_new", { sessionId: request.sessionId, requestId: request.requestId, rendererGeneration: request.rendererGeneration }).catch(() => {});
      }
    };
    const receiver = createGraphNewFrameReceiver({
      activeIdentity: handlers.activeIdentity,
      onFrame: handlers.onFrame,
      onPresented: handlers.onPresented,
      onError: fail,
    });

    channel.onmessage = (message: unknown): void => {
      if (failed || cancelled) return;
      const header = parseHeader(message);
      if (header) {
        pendingToken = tokenFromHeader(header);
        receiver.begin(header);
        return;
      }
      const payload = toRawPayload(message);
      if (payload && pendingToken) {
        const token = pendingToken;
        pendingToken = null;
        receiver.acceptPayload(token, payload);
        return;
      }
      fail("graph-new channel received a non-raw or unpaired payload");
    };

    const completion = invoke<Completion>(
      command,
      { request, onFrame: channel },
    ).then((value) => {
      validate?.(value);
      if (failed) throw new Error("graph_new_render_failed");
      return value;
    }).catch((error: unknown) => {
      fail(describeError(error));
      throw safe ? new Error(safeReason(error)) : error;
    });

    return {
      completion,
      canPresent: (token: GraphNewFrameToken) => !cancelled && !failed && receiver.canPresent(token),
      markPresented: (token: GraphNewFrameToken, at: number) => {
        if (!cancelled && !failed) receiver.markPresented(token, at);
      },
      snapshot: receiver.snapshot,
      cancel: () => { cancelled = true; pendingToken = null; },
    };
}

export const graphNewService = {
  probe(request: GraphNewTransportProbeRequest, handlers: GraphNewProbeHandlers): GraphNewProbeController {
    return startRequest<GraphNewTransportProbeCompletion>("probe_graph_new_transport", request, handlers);
  },
  render(request: GraphNewRenderRequest, handlers: GraphNewProbeHandlers): GraphNewRenderController {
    validateRenderRequest(request);
    lastRender = request;
    const controller = startRequest<GraphNewRenderCompletion>("render_graph_new", request, handlers, true, (completion) => validateCompletion(completion, request));
    return { ...controller, cancel: async (preserveCache = false) => {
      controller.cancel();
      await invoke<void>("cancel_graph_new", { sessionId: request.sessionId, requestId: request.requestId, rendererGeneration: request.rendererGeneration,
        ...(preserveCache ? { preserveCache: true } : {}) })
        .catch(() => { throw new Error("graph_new_render_failed"); });
    } };
  },
  async close(sessionId: string): Promise<void> {
    if (!lastRender || lastRender.sessionId !== sessionId) return;
    await invoke<void>("close_graph_new", { sessionId, rendererGeneration: lastRender.rendererGeneration })
      .catch(() => { throw new Error("graph_new_render_failed"); });
  },
};