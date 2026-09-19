import type { TabulateTotalsRequest, TabulateTotalsResult, TabulateWindowResult } from "@/types/tabulate";
import {
  assertTabulateInteger,
  assertTabulateTileRequest,
  TABULATE_MAX_CELLS,
  TABULATE_MAX_COLUMNS,
  TABULATE_MAX_ID_LENGTH,
  TABULATE_MAX_ROWS,
  tabulateIdentityKey,
  validateTabulateWindow,
} from "./tabulateViewport";
import type { TabulateIdentity, TabulateTileRequest } from "./tabulateViewport";

const DEFAULT_MAX_ENTRIES = 32;
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const MAX_VALUE_DEPTH = 64;

export interface TabulateTileCacheConfig {
  maxEntries?: number;
  maxBytes?: number;
}

export interface TabulateTotalsCacheRequest extends TabulateTotalsRequest, TabulateIdentity {}

type CacheEntry = {
  bytes: number;
} & ({ namespace: "tile"; value: TabulateWindowResult }
  | { namespace: "totals"; value: TabulateTotalsResult });

export function tabulateTileKey(request: TabulateTileRequest): string {
  assertTabulateTileRequest(request);
  return JSON.stringify(["tile", tabulateIdentityKey(request), request.rowStart,
    request.rowCount, request.columnStart, request.columnCount]);
}

export function tabulateTotalsKey(request: TabulateTotalsCacheRequest): string {
  const identity = tabulateIdentityKey(request);
  if (typeof request.requestId !== "string" || request.requestId.length === 0
    || request.requestId.length > TABULATE_MAX_ID_LENGTH) {
    throw new RangeError("Tabulate request ID must be a bounded nonempty string");
  }
  const totals = request.totals;
  if (totals.kind === "grand") return JSON.stringify(["totals", identity, "grand"]);
  if (totals.kind !== "rows" && totals.kind !== "columns") throw new RangeError("Invalid totals kind");
  assertTabulateInteger(totals.count, 1, totals.kind === "rows" ? TABULATE_MAX_ROWS : TABULATE_MAX_COLUMNS);
  assertTabulateInteger(totals.start, 0, Number.MAX_SAFE_INTEGER - totals.count);
  if (totals.count > Math.floor(TABULATE_MAX_CELLS / request.statisticCount)) {
    throw new RangeError("Tabulate totals exceed the numeric cell bound");
  }
  return JSON.stringify(["totals", identity, totals.kind, totals.start, totals.count]);
}

function validTotals(request: TabulateTotalsCacheRequest, result: TabulateTotalsResult): boolean {
  try {
    if (result.requestId !== request.requestId || result.sessionId !== request.sessionId
      || result.sourceGeneration !== request.sourceGeneration || result.fingerprint !== request.fingerprint
      || tabulateTotalsKey({ ...request, totals: result.totals }) !== tabulateTotalsKey(request)
      || !Array.isArray(result.rowTotals) || !Array.isArray(result.columnTotals)
      || !Array.isArray(result.grandTotals)) return false;
    if (request.totals.kind === "grand") {
      return result.rowTotals.length === 0 && result.columnTotals.length === 0
        && result.grandTotals.length === request.statisticCount
        && result.grandTotals.every((value) => value === null || (typeof value === "number" && Number.isFinite(value)));
    }
    const values = request.totals.kind === "rows" ? result.rowTotals : result.columnTotals;
    const other = request.totals.kind === "rows" ? result.columnTotals : result.rowTotals;
    if (other.length !== 0 || result.grandTotals.length !== 0
      || values.length > request.totals.count * request.statisticCount) return false;
    const addresses = new Set<number>();
    for (const value of values) {
      assertTabulateInteger(value.memberIndex, 0, request.totals.count - 1);
      assertTabulateInteger(value.statisticIndex, 0, request.statisticCount - 1);
      if (value.value !== null && (typeof value.value !== "number" || !Number.isFinite(value.value))) return false;
      const address = value.memberIndex * request.statisticCount + value.statisticIndex;
      if (addresses.has(address)) return false;
      addresses.add(address);
    }
    return true;
  } catch {
    return false;
  }
}

function estimateBytes(value: unknown, key: string, limit: number): number | null {
  let bytes = 128 + key.length * 2;
  const ancestors = new Set<object>();
  function visit(current: unknown, depth: number): boolean {
    if (bytes > limit || depth > MAX_VALUE_DEPTH) return false;
    if (current === null || typeof current === "number" || typeof current === "boolean") {
      bytes += 16;
    } else if (typeof current === "string") {
      bytes += 32 + current.length * 2;
    } else if (typeof current === "object") {
      if (ancestors.has(current)) return false;
      ancestors.add(current);
      if (Array.isArray(current)) {
        bytes += 32 + current.length * 8;
        if (bytes > limit) return false;
        for (const child of current) if (!visit(child, depth + 1)) return false;
      } else {
        const prototype = Object.getPrototypeOf(current);
        if (prototype !== Object.prototype && prototype !== null) return false;
        bytes += 64;
        for (const name in current) {
          if (!Object.prototype.hasOwnProperty.call(current, name)) continue;
          bytes += 32 + name.length * 2;
          if (!visit((current as Record<string, unknown>)[name], depth + 1)) return false;
        }
      }
      ancestors.delete(current);
    } else {
      return false;
    }
    return bytes <= limit;
  }
  return visit(value, 0) ? bytes : null;
}

export class TabulateTileCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private identity: string | null = null;
  private pinnedKey: string | null = null;
  private byteCount = 0;

  constructor(config: TabulateTileCacheConfig = {}) {
    this.maxEntries = config.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.maxBytes = config.maxBytes ?? DEFAULT_MAX_BYTES;
    assertTabulateInteger(this.maxEntries, 1);
    assertTabulateInteger(this.maxBytes, 1);
  }

  get entryCount(): number { return this.entries.size; }
  get estimatedBytes(): number { return this.byteCount; }

  setIdentity(identity: TabulateIdentity): void {
    const key = tabulateIdentityKey(identity);
    if (key === this.identity) return;
    this.clear();
    this.identity = key;
  }

  clear(): void {
    this.entries.clear();
    this.pinnedKey = null;
    this.identity = null;
    this.byteCount = 0;
  }

  pin(request: TabulateTileRequest): boolean {
    if (!this.matches(request)) return false;
    const key = tabulateTileKey(request);
    if (!this.entries.has(key)) return false;
    this.pinnedKey = key;
    return true;
  }

  unpin(): void { this.pinnedKey = null; }

  putTile(request: TabulateTileRequest, result: TabulateWindowResult): boolean {
    if (!this.matches(request) || !validateTabulateWindow(request, result)) return false;
    return this.put(tabulateTileKey(request), "tile", result);
  }

  getTile(request: TabulateTileRequest): TabulateWindowResult | undefined {
    if (!this.matches(request)) return undefined;
    const entry = this.get(tabulateTileKey(request));
    return entry?.namespace === "tile" ? structuredClone(entry.value) : undefined;
  }

  putTotals(request: TabulateTotalsCacheRequest, result: TabulateTotalsResult): boolean {
    if (!this.matches(request) || !validTotals(request, result)) return false;
    return this.put(tabulateTotalsKey(request), "totals", result);
  }

  getTotals(request: TabulateTotalsCacheRequest): TabulateTotalsResult | undefined {
    if (!this.matches(request)) return undefined;
    const entry = this.get(tabulateTotalsKey(request));
    return entry?.namespace === "totals" ? structuredClone(entry.value) : undefined;
  }

  private matches(identity: TabulateIdentity): boolean {
    try { return tabulateIdentityKey(identity) === this.identity; } catch { return false; }
  }

  private get(key: string): CacheEntry | undefined {
    const entry = this.entries.get(key);
    if (entry) {
      this.entries.delete(key);
      this.entries.set(key, entry);
    }
    return entry;
  }

  private put(key: string, namespace: "tile" | "totals", value: TabulateWindowResult | TabulateTotalsResult): boolean {
    const bytes = estimateBytes(value, key, this.maxBytes);
    if (bytes === null) return false;
    const previous = this.entries.get(key);
    const pinned = this.pinnedKey === null || this.pinnedKey === key ? undefined : this.entries.get(this.pinnedKey);
    if (bytes > this.maxBytes - (pinned?.bytes ?? 0)
      || (pinned !== undefined && this.maxEntries < 2)) return false;
    let entry: CacheEntry;
    try {
      entry = namespace === "tile"
        ? { namespace, bytes, value: structuredClone(value as TabulateWindowResult) }
        : { namespace, bytes, value: structuredClone(value as TabulateTotalsResult) };
    } catch {
      return false;
    }
    if (previous) this.remove(key, previous);
    for (const [candidateKey, candidate] of this.entries) {
      if (this.entries.size < this.maxEntries && this.byteCount <= this.maxBytes - bytes) break;
      if (candidateKey !== this.pinnedKey) this.remove(candidateKey, candidate);
    }
    this.entries.set(key, entry);
    this.byteCount += bytes;
    return true;
  }

  private remove(key: string, entry: CacheEntry): void {
    this.entries.delete(key);
    this.byteCount -= entry.bytes;
  }
}