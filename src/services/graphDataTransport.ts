import type {
  GraphAggregatePacket,
  GraphChunkHeader,
  GraphDataCompletion,
  GraphDataRequest,
} from "../types/graphData.ts";
import { isGraphAggregatePacket as isStrictGraphAggregatePacket } from "../types/graphData.ts";

export interface GraphStreamTransportHandlers {
  onHeader: (header: GraphChunkHeader) => void;
  onPayload: (payload: ArrayBuffer) => void;
  onAggregate: (packet: GraphAggregatePacket) => void;
  onComplete: (completion: GraphDataCompletion) => void;
  onError: (message: string) => void;
}

export interface GraphStreamTransport {
  onChannelMessage: (message: unknown) => void;
  onInvokeResolved: (completion: GraphDataCompletion) => void;
  onInvokeRejected: (error: unknown) => void;
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function toRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  return value as Record<string, unknown>;
}

function toBinaryPayload(value: unknown): ArrayBuffer | null {
  if (value instanceof ArrayBuffer) {
    return value;
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice().buffer;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const byte = value[index];
      if (!Object.prototype.hasOwnProperty.call(value, index)
        || !Number.isInteger(byte)
        || byte < 0
        || byte > 255) {
        return null;
      }
    }
    return Uint8Array.from(value).buffer;
  }
  return null;
}

function normalizeStructuredValue(value: unknown): unknown {
  if (value === null) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value.map(normalizeStructuredValue);
  }
  const record = toRecord(value);
  if (!record) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(record).map(([key, entry]) => [key, normalizeStructuredValue(entry)]),
  );
}

function parseStructuredMessage(message: unknown): Record<string, unknown> | null {
  if (typeof message === "string") {
    try {
      const parsed = JSON.parse(message) as unknown;
      return toRecord(normalizeStructuredValue(parsed));
    } catch {
      return null;
    }
  }
  return toRecord(normalizeStructuredValue(message));
}

function isMessageType(record: Record<string, unknown>, expected: string): boolean {
  const value = record.messageType;
  return value === undefined || value === expected;
}

function isGraphChunkHeader(value: unknown): value is GraphChunkHeader {
  const record = toRecord(value);
  if (!record || !isMessageType(record, "header")) {
    return false;
  }
  return (
    typeof record.requestId === "string"
    && typeof record.generation === "number"
    && Number.isInteger(record.chunkIndex)
    && typeof record.finalChunk === "boolean"
  );
}

function isGraphDataCompletion(value: unknown): value is GraphDataCompletion {
  const record = toRecord(value);
  if (!record || !isMessageType(record, "complete")) {
    return false;
  }
  return (
    typeof record.requestId === "string"
    && typeof record.datasetId === "string"
    && typeof record.generation === "number"
    && Number.isInteger(record.chunksSent)
    && typeof record.cancelled === "boolean"
    && isRawPointDisposition(record.rawPointDisposition)
  );
}

function isRawPointDisposition(value: unknown): boolean {
  const record = toRecord(value);
  if (!record || !Number.isInteger(record.validRows) || !Number.isInteger(record.budget)) {
    return false;
  }
  if ((record.validRows as number) < 0 || (record.budget as number) <= 0) {
    return false;
  }
  if (record.status === "included") {
    return true;
  }
  if (record.status === "empty") {
    return record.validRows === 0;
  }
  return record.status === "omitted"
    && record.reason === "pointBudgetExceeded"
    && (record.validRows as number) > (record.budget as number);
}

function isGraphAggregatePacket(value: unknown): value is GraphAggregatePacket {
  const record = toRecord(value);
  if (!record || !isMessageType(record, "aggregate")) {
    return false;
  }
  return isStrictGraphAggregatePacket(record);
}

function completionEquals(left: GraphDataCompletion, right: GraphDataCompletion): boolean {
  return (
    left.requestId === right.requestId
    && left.datasetId === right.datasetId
    && left.generation === right.generation
    && left.sourceRows === right.sourceRows
    && left.processedRows === right.processedRows
    && left.chunksSent === right.chunksSent
    && left.cancelled === right.cancelled
    && JSON.stringify(left.rawPointDisposition) === JSON.stringify(right.rawPointDisposition)
  );
}

export function createGraphStreamTransport(
  request: GraphDataRequest,
  handlers: GraphStreamTransportHandlers,
): GraphStreamTransport {
  const aggregateOnlyCorrelation =
    request.elements.length > 0
    && request.elements.every((element) => element.kind === "correlationMatrix");

  const seenChunkIndexes = new Set<number>();
  let nextChunkIndex = 0;
  let pendingHeader: GraphChunkHeader | null = null;
  let invokeCompletion: GraphDataCompletion | null = null;
  let sawFinalChunkPayload = false;
  const pendingZeroChunkAggregates: GraphAggregatePacket[] = [];
  let closed = false;
  let failed = false;

  const isExpectedRequest = (requestId: string, generation: number): boolean =>
    requestId === request.requestId && generation === request.generation;

  const fail = (message: string): void => {
    if (closed || failed) {
      return;
    }
    failed = true;
    handlers.onError(message);
  };

  return {
    onChannelMessage: (message: unknown): void => {
      if (closed || failed) {
        return;
      }

      const payload = toBinaryPayload(message);
      if (payload) {
        if (!pendingHeader) {
          fail("graph payload arrived before header");
          return;
        }

        const header = pendingHeader;
        pendingHeader = null;
        handlers.onHeader(header);
        handlers.onPayload(payload);
        if (header.finalChunk) {
          sawFinalChunkPayload = true;
        }
        return;
      }

      const structured = parseStructuredMessage(message);
      if (!structured) {
        fail("graph stream emitted an unknown chunk message");
        return;
      }

      if (isGraphChunkHeader(structured)) {
        if (!isExpectedRequest(structured.requestId, structured.generation)) {
          fail("graph header does not match active request");
          return;
        }
        if (pendingHeader) {
          fail("graph header arrived before payload for the previous chunk");
          return;
        }
        if (seenChunkIndexes.has(structured.chunkIndex)) {
          fail(`duplicate graph chunk index ${structured.chunkIndex}`);
          return;
        }
        if (structured.chunkIndex !== nextChunkIndex) {
          fail(
            `graph chunk index ${structured.chunkIndex} arrived out of order (expected ${nextChunkIndex})`,
          );
          return;
        }

        seenChunkIndexes.add(structured.chunkIndex);
        nextChunkIndex += 1;
        pendingHeader = structured;
        return;
      }

      if (isGraphDataCompletion(structured)) {
        if (!isExpectedRequest(structured.requestId, structured.generation)) {
          fail("graph terminal marker does not match active request");
          return;
        }
        if (pendingHeader) {
          fail("graph terminal marker arrived with a pending header");
          return;
        }
        if (!structured.cancelled && structured.chunksSent !== seenChunkIndexes.size) {
          fail("graph terminal marker has inconsistent chunksSent");
          return;
        }
        if (pendingZeroChunkAggregates.length > 0) {
          const disposition = structured.rawPointDisposition;
          if (structured.chunksSent !== 0
            || (disposition.status !== "empty" && disposition.status !== "omitted")) {
            fail("graph aggregate packet arrived before all raw chunks were delivered");
            return;
          }
          for (const packet of pendingZeroChunkAggregates) {
            handlers.onAggregate(packet);
          }
          pendingZeroChunkAggregates.length = 0;
        }
        if (invokeCompletion && !completionEquals(invokeCompletion, structured)) {
          fail("graph terminal marker does not match invoke completion");
          return;
        }

        closed = true;
        handlers.onComplete(structured);
        return;
      }

      if (isGraphAggregatePacket(structured)) {
        if (!pendingHeader) {
          if (!sawFinalChunkPayload) {
            if (aggregateOnlyCorrelation) {
              if (structured.kind !== "correlationMatrix") {
                fail("graph aggregate packet kind does not match correlation-only request");
                return;
              }
              handlers.onAggregate(structured);
              return;
            }
            pendingZeroChunkAggregates.push(structured);
          } else {
            handlers.onAggregate(structured);
          }
          return;
        }
        fail("graph aggregate packet arrived before payload for the previous chunk");
        return;
      }

      fail("graph stream emitted an unknown chunk message");
    },

    onInvokeResolved: (completion: GraphDataCompletion): void => {
      if (closed || failed) {
        return;
      }
      invokeCompletion = completion;
    },

    onInvokeRejected: (error: unknown): void => {
      fail(describeError(error));
    },
  };
}
