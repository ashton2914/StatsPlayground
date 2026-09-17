import type { TableWindowRequest, TableWindowResult } from "@/types/data";

const DEFAULT_MAX_ROWS = 5_000;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

export interface TableWindowCacheConfig {
  maxRows?: number;
  maxBytes?: number;
}

export interface TableWindowCacheRequest extends TableWindowRequest {
  sessionKey: string;
  columnIds: string[];
  transportVersion: number;
}

interface CacheEntry {
  key: string;
  scopeKey: string;
  datasetId: string;
  generation: number;
  rowCount: number;
  estimatedBytes: number;
  result: TableWindowResult;
  lastUsed: number;
}

function buildScopeKey(request: TableWindowCacheRequest): string {
  return JSON.stringify({
    datasetId: request.datasetId.trim(),
    generation: request.generation,
    sessionKey: request.sessionKey.trim(),
    columnIds: request.columnIds.map((columnId) => columnId.trim()),
    transportVersion: request.transportVersion,
  });
}

function buildEntryKey(request: TableWindowCacheRequest): string {
  return `${buildScopeKey(request)}:${request.start}:${request.count}`;
}

function estimateValueBytes(value: unknown, seen: Set<object>): number {
  if (value == null) {
    return 0;
  }
  if (typeof value === "string") {
    return 16 + value.length * 2;
  }
  if (typeof value === "number") {
    return 8;
  }
  if (typeof value === "boolean") {
    return 4;
  }
  if (typeof value === "bigint") {
    return 8;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return 0;
    }
    seen.add(value);
    let bytes = 24 + value.length * 8;
    for (const item of value) {
      bytes += estimateValueBytes(item, seen);
    }
    return bytes;
  }
  if (typeof value === "object") {
    if (seen.has(value as object)) {
      return 0;
    }
    seen.add(value as object);
    let bytes = 32;
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      bytes += 16 + key.length * 2;
      bytes += estimateValueBytes(item, seen);
    }
    return bytes;
  }
  return 16;
}

function estimateRetainedBytes(result: TableWindowResult): number {
  return estimateValueBytes(result, new Set<object>());
}

export class TableWindowCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly maxRows: number;
  private readonly maxBytes: number;
  private clock = 0;
  private rowCount = 0;
  private byteCount = 0;
  private pinnedKey: string | null = null;

  constructor(config: number | TableWindowCacheConfig = DEFAULT_MAX_ROWS) {
    const normalizedConfig = typeof config === "number"
      ? { maxRows: config, maxBytes: DEFAULT_MAX_BYTES }
      : {
        maxRows: config.maxRows ?? DEFAULT_MAX_ROWS,
        maxBytes: config.maxBytes ?? DEFAULT_MAX_BYTES,
      };
    const { maxRows, maxBytes } = normalizedConfig;
    if (!Number.isInteger(maxRows) || maxRows < 1) {
      throw new RangeError("maxRows must be a positive integer");
    }
    if (!Number.isInteger(maxBytes) || maxBytes < 1) {
      throw new RangeError("maxBytes must be a positive integer");
    }
    this.maxRows = maxRows;
    this.maxBytes = maxBytes;
  }

  get retainedRows(): number {
    return this.rowCount;
  }

  get estimatedBytes(): number {
    return this.byteCount;
  }

  get entryCount(): number {
    return this.entries.size;
  }

  put(request: TableWindowCacheRequest, result: TableWindowResult): boolean {
    if (
      result.start !== request.start
      || result.generation !== request.generation
      || result.rows.length > request.count
      || result.rows.length > this.maxRows
    ) {
      return false;
    }

    this.invalidateGeneration(request.datasetId, request.generation);

    const key = buildEntryKey(request);
    const estimatedBytes = estimateRetainedBytes(result);
    const previous = this.entries.get(key);
    if (previous) {
      this.removeEntry(previous.key);
    }
    this.entries.set(key, {
      key,
      scopeKey: buildScopeKey(request),
      datasetId: request.datasetId,
      generation: request.generation,
      rowCount: result.rows.length,
      estimatedBytes,
      result,
      lastUsed: ++this.clock,
    });
    this.rowCount += result.rows.length;
    this.byteCount += estimatedBytes;
    this.evictLeastRecentlyUsed();
    return true;
  }

  get(request: TableWindowCacheRequest): TableWindowResult | undefined {
    const scopeKey = buildScopeKey(request);
    const matching = [...this.entries.values()]
      .filter((entry) => entry.scopeKey === scopeKey)
      .sort((left, right) => left.result.start - right.result.start);
    if (matching.length === 0) {
      return undefined;
    }

    const first = matching[0];
    const targetEnd = Math.min(request.start + request.count, first.result.totalRows);
    const rows: unknown[][] = [];
    const used = new Set<CacheEntry>();
    let position = request.start;

    while (position < targetEnd) {
      const entry = matching.find((candidate) => {
        const end = candidate.result.start + candidate.result.rows.length;
        return candidate.result.start <= position && position < end;
      });
      if (!entry) {
        return undefined;
      }
      const offset = position - entry.result.start;
      const available = Math.min(entry.result.rows.length - offset, targetEnd - position);
      rows.push(...entry.result.rows.slice(offset, offset + available));
      position += available;
      used.add(entry);
    }

    for (const entry of used) {
      entry.lastUsed = ++this.clock;
    }
    return {
      columns: first.result.columns,
      columnTypes: first.result.columnTypes,
      rows,
      totalRows: first.result.totalRows,
      start: request.start,
      generation: request.generation,
    };
  }

  pin(request: TableWindowCacheRequest): void {
    this.pinnedKey = buildEntryKey(request);
  }

  unpin(): void {
    this.pinnedKey = null;
  }

  invalidateGeneration(datasetId: string, generation: number): void {
    for (const entry of [...this.entries.values()]) {
      if (entry.datasetId === datasetId && entry.generation !== generation) {
        this.removeEntry(entry.key);
      }
    }
  }

  invalidateRange(
    datasetId: string,
    generation: number,
    start: number,
    count: number,
  ): void {
    const end = start + count;
    for (const entry of [...this.entries.values()]) {
      const entryEnd = entry.result.start + entry.result.rows.length;
      if (
        entry.datasetId === datasetId
        && entry.generation === generation
        && entry.result.start < end
        && start < entryEnd
      ) {
        this.removeEntry(entry.key);
      }
    }
  }

  clear(): void {
    this.entries.clear();
    this.rowCount = 0;
    this.byteCount = 0;
    this.pinnedKey = null;
  }

  private evictLeastRecentlyUsed(): void {
    while (this.rowCount > this.maxRows || this.byteCount > this.maxBytes) {
      let oldestEntry: CacheEntry | undefined;
      for (const entry of this.entries.values()) {
        if (entry.key === this.pinnedKey) {
          continue;
        }
        if (!oldestEntry || entry.lastUsed < oldestEntry.lastUsed) {
          oldestEntry = entry;
        }
      }
      if (!oldestEntry) {
        return;
      }
      this.removeEntry(oldestEntry.key);
    }
  }

  private removeEntry(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) {
      return;
    }
    this.entries.delete(key);
    this.rowCount -= entry.rowCount;
    this.byteCount -= entry.estimatedBytes;
    if (this.pinnedKey === key) {
      this.pinnedKey = null;
    }
  }
}