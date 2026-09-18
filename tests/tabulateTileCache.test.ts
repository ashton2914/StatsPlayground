import assert from "node:assert/strict";
import test from "node:test";

import { TabulateTileCache, tabulateTileKey, tabulateTotalsKey }
  from "../src/components/tabulate/tabulateTileCache.ts";
import type { TabulateWindowResult, TabulateTotalsResult } from "../src/types/tabulate.ts";

const identity = { sessionId: "session", fingerprint: "fingerprint", sourceGeneration: 3, statisticCount: 1 };
const tile = (rowStart = 0) => ({ ...identity, requestId: `tile-${rowStart}`,
  rowStart, rowCount: 1, columnStart: 0, columnCount: 1 });
function result(rowStart = 0): TabulateWindowResult {
  return { ...identity, requestId: `tile-${rowStart}`, rowStart, columnStart: 0,
    rowMembers: [[rowStart]], columnMembers: [[]],
    rowMemberBefore: rowStart === 0 ? null : [rowStart - 1],
    rowMemberAfter: rowStart === 99 ? null : [rowStart + 1],
    columnMemberBefore: null, columnMemberAfter: null,
    statistics: [{ id: "count", field: "", kind: "count" }],
    cells: [{ rowIndex: 0, columnIndex: 0, statisticIndex: 0, value: rowStart }],
    rowTotalsReady: false, columnTotalsReady: false, rowMemberCount: 100, columnMemberCount: 1 };
}
const totalsRequest = { ...identity, requestId: "totals", totals: { kind: "rows" as const, start: 0, count: 1 } };
const totalsResult: TabulateTotalsResult = { ...identity, requestId: "totals", totals: totalsRequest.totals,
  rowTotals: [{ memberIndex: 0, statisticIndex: 0, value: 12 }], columnTotals: [], grandTotals: [] };

test("keys include full identity, both ranges and statistic count but not transport request ID", () => {
  const original = tabulateTileKey(tile());
  assert.equal(tabulateTileKey({ ...tile(), requestId: "another" }), original);
  for (const patch of [
    { sessionId: "other" }, { fingerprint: "other" }, { sourceGeneration: 4 },
    { rowStart: 1 }, { rowCount: 2 }, { columnStart: 1 }, { columnCount: 2 }, { statisticCount: 2 },
  ]) assert.notEqual(tabulateTileKey({ ...tile(), ...patch }), original);
  assert.notEqual(tabulateTileKey({ ...tile(), sessionId: "a:b", fingerprint: "c" }),
    tabulateTileKey({ ...tile(), sessionId: "a", fingerprint: "b:c" }));
  assert.notEqual(original, tabulateTotalsKey(totalsRequest));
  for (const patch of [{ sessionId: "other" }, { fingerprint: "other" }, { sourceGeneration: 4 },
    { statisticCount: 2 }, { totals: { kind: "rows" as const, start: 1, count: 1 } },
    { totals: { kind: "rows" as const, start: 0, count: 2 } },
    { totals: { kind: "columns" as const, start: 0, count: 1 } }, { totals: { kind: "grand" as const } },
  ]) assert.notEqual(tabulateTotalsKey({ ...totalsRequest, ...patch }), tabulateTotalsKey(totalsRequest));
});

test("entry eviction is LRU and reads refresh recency", () => {
  const cache = new TabulateTileCache({ maxEntries: 2, maxBytes: 100_000 });
  cache.setIdentity(identity);
  assert.equal(cache.putTile(tile(0), result(0)), true);
  assert.equal(cache.putTile(tile(1), result(1)), true);
  assert.equal(cache.getTile(tile(0))?.cells[0].value, 0);
  assert.equal(cache.putTile(tile(2), result(2)), true);
  assert.equal(cache.getTile(tile(1)), undefined);
  assert.equal(cache.getTile(tile(0))?.cells[0].value, 0);
  assert.equal(cache.entryCount, 2);
});

test("byte pressure independently evicts and oversize admission preserves resident entries", () => {
  const probe = new TabulateTileCache({ maxEntries: 10, maxBytes: 100_000 });
  probe.setIdentity(identity);
  assert.equal(probe.putTile(tile(1), result(1)), true);
  const oneTileBytes = probe.estimatedBytes;
  assert.ok(oneTileBytes > 0);
  const cache = new TabulateTileCache({ maxEntries: 10, maxBytes: oneTileBytes });
  cache.setIdentity(identity);
  assert.equal(cache.putTile(tile(1), result(1)), true);
  assert.equal(cache.putTile(tile(2), result(2)), true);
  assert.equal(cache.entryCount, 1);
  assert.equal(cache.getTile(tile(1)), undefined);
  assert.ok(cache.estimatedBytes <= oneTileBytes);
  assert.equal(cache.putTile(tile(2), { ...result(2), rowMembers: [["X".repeat(100_000)]] }), false);
  assert.equal(cache.getTile(tile(2))?.cells[0].value, 2);
});

test("tile and totals namespaces coexist but share the same global budget", () => {
  const cache = new TabulateTileCache({ maxEntries: 2, maxBytes: 100_000 });
  cache.setIdentity(identity);
  assert.equal(cache.putTile(tile(), result()), true);
  assert.equal(cache.putTotals(totalsRequest, totalsResult), true);
  assert.equal(cache.getTile(tile())?.cells[0].value, 0);
  assert.equal(cache.getTotals(totalsRequest)?.rowTotals[0].value, 12);
  cache.putTile(tile(1), result(1));
  assert.equal(cache.getTile(tile()), undefined);
  assert.equal(cache.getTotals(totalsRequest)?.rowTotals[0].value, 12);
  assert.equal(cache.entryCount, 2);
});

test("generation, fingerprint, session and statistic changes clear both namespaces and reject late puts", () => {
  for (const patch of [{ sourceGeneration: 4 }, { fingerprint: "new" }, { sessionId: "new" }, { statisticCount: 2 }]) {
    const cache = new TabulateTileCache();
    cache.setIdentity(identity);
    cache.putTile(tile(), result());
    cache.putTotals(totalsRequest, totalsResult);
    cache.pin(tile());
    cache.setIdentity({ ...identity, ...patch });
    assert.equal(cache.entryCount, 0);
    assert.equal(cache.estimatedBytes, 0);
    assert.equal(cache.putTile(tile(), result()), false);
    assert.equal(cache.putTotals(totalsRequest, totalsResult), false);
    assert.equal(cache.getTile(tile()), undefined);
    assert.equal(cache.getTotals(totalsRequest), undefined);
  }
});

test("same identity retains entries; clear removes the active identity", () => {
  const cache = new TabulateTileCache();
  assert.equal(cache.putTile(tile(), result()), false);
  cache.setIdentity(identity);
  cache.putTile(tile(), result());
  cache.setIdentity({ ...identity });
  assert.equal(cache.entryCount, 1);
  cache.clear();
  assert.equal(cache.entryCount, 0);
  assert.equal(cache.estimatedBytes, 0);
  assert.equal(cache.putTile(tile(), result()), false);
});

test("one pinned foreground survives entry and byte pressure without exceeding either cap", () => {
  const cache = new TabulateTileCache({ maxEntries: 1, maxBytes: 100_000 });
  cache.setIdentity(identity);
  cache.putTile(tile(), result());
  assert.equal(cache.pin(tile()), true);
  assert.equal(cache.putTile(tile(1), result(1)), false);
  assert.equal(cache.putTotals(totalsRequest, totalsResult), false);
  assert.equal(cache.getTile(tile())?.cells[0].value, 0);
  assert.equal(cache.entryCount, 1);
  cache.unpin();
  assert.equal(cache.putTile(tile(1), result(1)), true);
  assert.equal(cache.getTile(tile()), undefined);
  const bytes = cache.estimatedBytes;
  const byteBound = new TabulateTileCache({ maxEntries: 10, maxBytes: bytes });
  byteBound.setIdentity(identity);
  byteBound.putTile(tile(1), result(1));
  byteBound.pin(tile(1));
  assert.equal(byteBound.putTile(tile(2), result(2)), false);
  assert.equal(byteBound.estimatedBytes, bytes);
});

test("pin replacement is bounded and invalid pins cannot unprotect the foreground", () => {
  const cache = new TabulateTileCache({ maxEntries: 2, maxBytes: 100_000 });
  cache.setIdentity(identity);
  cache.putTile(tile(), result());
  cache.putTile(tile(1), result(1));
  cache.pin(tile());
  assert.equal(cache.pin(tile(9)), false);
  cache.putTile(tile(2), result(2));
  assert.ok(cache.getTile(tile()));
  cache.pin(tile(2));
  cache.putTile(tile(3), result(3));
  assert.equal(cache.getTile(tile()), undefined);
  assert.ok(cache.getTile(tile(2)));
});

test("cache snapshots cannot be mutated by caller inputs or returned values", () => {
  const cache = new TabulateTileCache();
  cache.setIdentity(identity);
  const mutable = result();
  cache.putTile(tile(), mutable);
  mutable.cells[0].value = 999;
  const firstRead = cache.getTile(tile())!;
  assert.equal(firstRead.cells[0].value, 0);
  firstRead.rowMembers.push(["injected"]);
  assert.equal(cache.getTile(tile())?.rowMembers.length, 1);
});

test("invalid window and totals payloads cannot enter the cache", () => {
  const cache = new TabulateTileCache();
  cache.setIdentity(identity);
  assert.equal(cache.putTile(tile(), { ...result(), fingerprint: "wrong" }), false);
  for (const patch of [
    { requestId: "wrong" }, { sourceGeneration: 2 }, { fingerprint: "wrong" },
    { totals: { kind: "rows" as const, start: 1, count: 1 } },
    { columnTotals: totalsResult.rowTotals }, { grandTotals: [1] },
    { rowTotals: [{ memberIndex: 1, statisticIndex: 0, value: 1 }] },
    { rowTotals: [{ memberIndex: 0, statisticIndex: 1, value: 1 }] },
    { rowTotals: [{ memberIndex: 0, statisticIndex: 0, value: Infinity }] },
    { rowTotals: [totalsResult.rowTotals[0], totalsResult.rowTotals[0]] },
  ]) assert.equal(cache.putTotals(totalsRequest, { ...totalsResult, ...patch }), false);
  assert.equal(cache.entryCount, 0);
  assert.equal(cache.putTotals({ ...totalsRequest, totals: { kind: "grand" } },
    { ...totalsResult, totals: { kind: "grand" }, rowTotals: [], grandTotals: [12] }), true);
  assert.equal(cache.putTotals({ ...totalsRequest, totals: { kind: "columns", start: 0, count: 1 } },
    { ...totalsResult, totals: { kind: "columns", start: 0, count: 1 }, rowTotals: [],
      columnTotals: totalsResult.rowTotals }), true);
});

test("budgets and keys reject unsafe or unbounded inputs", () => {
  for (const config of [{ maxEntries: 0 }, { maxBytes: Infinity }, { maxEntries: 1.5 }]) {
    assert.throws(() => new TabulateTileCache(config), RangeError);
  }
  assert.throws(() => tabulateTileKey({ ...tile(), rowCount: 129 }), RangeError);
  assert.throws(() => tabulateTileKey({ ...tile(), fingerprint: "X".repeat(4097) }), RangeError);
  assert.throws(() => tabulateTotalsKey({ ...totalsRequest, totals: { kind: "rows", start: 0, count: 129 } }), RangeError);
});