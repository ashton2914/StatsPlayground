import type {
  GraphNewFrame,
  GraphNewFrameHeader,
  GraphNewFrameIdentity,
  GraphNewFrameMetrics,
  GraphNewFrameToken,
} from "../types/graphNew.ts";

export type { GraphNewFrameHeader } from "../types/graphNew.ts";

const MAX_FRAME_WIDTH = 3840;
const MAX_FRAME_HEIGHT = 2160;

export interface GraphNewFrameReceiverSnapshot {
  maximumQueueDepth: number;
  droppedSupersededFrames: number;
  rejectedFrames: number;
  presentedFrames: number;
  pendingFrameId: number | null;
}

export interface GraphNewFrameReceiver {
  begin: (header: GraphNewFrameHeader) => void;
  acceptPayload: (token: GraphNewFrameToken, payload: ArrayBuffer) => void;
  canPresent: (token: GraphNewFrameToken) => boolean;
  markPresented: (token: GraphNewFrameToken, presentedAtMs: number) => void;
  cancelGeneration: (cameraGeneration: number) => void;
  snapshot: () => GraphNewFrameReceiverSnapshot;
}

interface GraphNewFrameReceiverOptions {
  activeIdentity: () => GraphNewFrameIdentity;
  onFrame: (frame: GraphNewFrame) => void;
  onError?: (message: string) => void;
  onPresented?: (metrics: GraphNewFrameMetrics) => void;
}

function isPositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function validateHeader(header: GraphNewFrameHeader): string | null {
  if (!isPositiveInteger(header.width)) {
    return "graph-new frame width must be a positive integer";
  }
  if (header.width > MAX_FRAME_WIDTH) {
    return `graph-new frame width must not exceed ${MAX_FRAME_WIDTH}`;
  }
  if (!isPositiveInteger(header.height)) {
    return "graph-new frame height must be a positive integer";
  }
  if (header.height > MAX_FRAME_HEIGHT) {
    return `graph-new frame height must not exceed ${MAX_FRAME_HEIGHT}`;
  }
  if (!isPositiveInteger(header.frameId)) {
    return "graph-new frame ID must be a positive integer";
  }
  if (!isPositiveInteger(header.byteLength)) {
    return "graph-new frame byte length must be a positive integer";
  }
  if (header.format !== "rgba8" && header.format !== "png") {
    return "graph-new frame format is unsupported";
  }
  if (header.format === "rgba8") {
    const expectedLength = header.width * header.height * 4;
    if (header.byteLength !== expectedLength) {
      return `graph-new frame ${header.frameId} RGBA length ${header.byteLength} does not match ${expectedLength}`;
    }
  }
  return null;
}

function identitiesMatch(
  header: GraphNewFrameIdentity,
  active: GraphNewFrameIdentity,
): boolean {
  return header.requestId === active.requestId
    && header.datasetGeneration === active.datasetGeneration
    && header.rendererGeneration === active.rendererGeneration
    && header.cameraGeneration === active.cameraGeneration;
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

function tokensMatch(left: GraphNewFrameToken, right: GraphNewFrameToken): boolean {
  return left.frameId === right.frameId
    && left.requestId === right.requestId
    && left.datasetGeneration === right.datasetGeneration
    && left.rendererGeneration === right.rendererGeneration
    && left.cameraGeneration === right.cameraGeneration;
}

function streamIdentitiesMatch(
  left: GraphNewFrameToken,
  right: GraphNewFrameToken,
): boolean {
  return left.requestId === right.requestId
    && left.datasetGeneration === right.datasetGeneration
    && left.rendererGeneration === right.rendererGeneration;
}

export function createGraphNewFrameReceiver(
  options: GraphNewFrameReceiverOptions,
): GraphNewFrameReceiver {
  let pending: GraphNewFrameHeader | null = null;
  let maximumQueueDepth = 0;
  let droppedSupersededFrames = 0;
  let rejectedFrames = 0;
  let presentedFrames = 0;
  let pendingPresentation: GraphNewFrameToken | null = null;
  let lastPresented: GraphNewFrameToken | null = null;
  let lastDropped: GraphNewFrameToken | null = null;
  let highestAccepted: GraphNewFrameToken | null = null;
  let cancelledCameraGeneration: number | null = null;

  const reject = (message: string): void => {
    rejectedFrames += 1;
    options.onError?.(message);
  };

  const recordDropped = (token: GraphNewFrameToken): void => {
    if (!lastDropped || !tokensMatch(lastDropped, token)) {
      droppedSupersededFrames += 1;
      lastDropped = token;
    }
  };

  return {
    begin: (header): void => {
      const validationError = validateHeader(header);
      if (validationError) {
        reject(validationError);
        return;
      }
      if (!identitiesMatch(header, options.activeIdentity())
        || header.cameraGeneration === cancelledCameraGeneration) {
        recordDropped(tokenFromHeader(header));
        return;
      }

      const nextToken = tokenFromHeader(header);
      if ((pending && tokensMatch(tokenFromHeader(pending), nextToken))
        || (pendingPresentation && tokensMatch(pendingPresentation, nextToken))
        || (lastPresented && tokensMatch(lastPresented, nextToken))) {
        reject(`graph-new frame ${header.frameId} is a duplicate`);
        return;
      }
      const orderingReference = pending
        ? tokenFromHeader(pending)
        : highestAccepted;
      if (orderingReference
        && streamIdentitiesMatch(orderingReference, nextToken)
        && nextToken.frameId <= orderingReference.frameId) {
        reject(
          `graph-new frame ${nextToken.frameId} is not newer than frame ${orderingReference.frameId}`,
        );
        return;
      }

      if (pending) {
        recordDropped(tokenFromHeader(pending));
      }
      pending = header;
      maximumQueueDepth = 1;
    },
    acceptPayload: (token, payload): void => {
      const header = pending;
      if (!header) {
        return;
      }
      if (!tokensMatch(tokenFromHeader(header), token)) {
        recordDropped(token);
        return;
      }
      pending = null;
      if (payload.byteLength !== header.byteLength) {
        reject(
          `graph-new frame ${header.frameId} payload length ${payload.byteLength} does not match ${header.byteLength}`,
        );
        return;
      }
      if (!identitiesMatch(header, options.activeIdentity())) {
        recordDropped(token);
        return;
      }

      if (pendingPresentation) {
        recordDropped(pendingPresentation);
      }
      highestAccepted = token;
      pendingPresentation = token;
      options.onFrame({ header, payload });
    },
    canPresent: (token): boolean => pendingPresentation !== null
      && tokensMatch(pendingPresentation, token)
      && identitiesMatch(token, options.activeIdentity()),
    markPresented: (token, presentedAtMs): void => {
      if (!pendingPresentation
        || !tokensMatch(pendingPresentation, token)
        || !identitiesMatch(token, options.activeIdentity())
        || !Number.isFinite(presentedAtMs)) {
        return;
      }
      presentedFrames += 1;
      pendingPresentation = null;
      lastPresented = token;
      options.onPresented?.({ frameId: token.frameId, presentedAtMs });
    },
    cancelGeneration: (cameraGeneration): void => {
      cancelledCameraGeneration = cameraGeneration;
      if (pending?.cameraGeneration === cameraGeneration) {
        recordDropped(tokenFromHeader(pending));
        pending = null;
      }
      if (pendingPresentation?.cameraGeneration === cameraGeneration) {
        recordDropped(pendingPresentation);
        pendingPresentation = null;
      }
    },
    snapshot: (): GraphNewFrameReceiverSnapshot => ({
      maximumQueueDepth,
      droppedSupersededFrames,
      rejectedFrames,
      presentedFrames,
      pendingFrameId: pending?.frameId ?? pendingPresentation?.frameId ?? null,
    }),
  };
}