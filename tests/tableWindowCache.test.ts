import assert from "node:assert/strict";

import { TableWindowCache } from "../src/utils/tableWindowCache.ts";
import type { TableWindowRequest, TableWindowResult } from "../src/types/data.ts";

type CacheRequest = TableWindowRequest & {
  sessionKey: string;
  columnIds: string[];
  transportVersion: number;
};

type CacheStats = {
  retainedRows: number;
  estimatedBytes: number;
  entryCount: number;
};

function request(
  start: number,
  count: number,
  overrides: Partial<CacheRequest> = {},
): CacheRequest {
  return {
    datasetId: "dataset-a",
    start,
    count,
    sort: null,
    filters: [],
    generation: 0,
    sessionKey: "natural",
    columnIds: ["value"],
    transportVersion: 1,
    ...overrides,
  };
}

function result(
  start: number,
  count: number,
  generation = 0,
  columns = ["_row_id", "value"],
): TableWindowResult {
  return {
    columns,
    columnTypes: columns.map((column) => (column === "_row_id" ? "BIGINT" : "VARCHAR")),
    rows: Array.from({ length: count }, (_, index) => [start + index + 1, `row-${start + index}`]),
    totalRows: 10_000,
    start,
    generation,
  };
}

{
  const cache = new TableWindowCache(5_000);
  assert.equal(cache.put(request(0, 500), result(0, 500)), true);
  assert.equal(cache.put(request(500, 500), result(500, 500)), true);

  const reused = cache.get(request(250, 500));
  assert.equal(reused?.rows.length, 500);
  assert.equal(reused?.rows[0][0], 251);
  assert.equal(reused?.rows[499][0], 750);
}

{
  const cache = new TableWindowCache(1_000);
  cache.put(request(0, 500), result(0, 500));
  cache.put(request(500, 500), result(500, 500));
  assert.ok(cache.get(request(0, 1)));
  cache.put(request(1_000, 500), result(1_000, 500));

  assert.equal(cache.retainedRows, 1_000);
  assert.ok(cache.get(request(0, 1)));
  assert.equal(cache.get(request(500, 1)), undefined);
  assert.ok(cache.get(request(1_000, 1)));
}

{
  const cache = new TableWindowCache(5_000);
  cache.put(request(0, 500, { generation: 1 }), result(0, 500, 1));

  assert.ok(cache.get(request(0, 500, { generation: 1 })));
  assert.equal(cache.get(request(0, 500, { generation: 2 })), undefined);
}

{
  const cache = new TableWindowCache(5_000);
  cache.put(request(0, 500), result(0, 500));
  cache.put(request(500, 500), result(500, 500));
  cache.invalidateRange("dataset-a", 0, 400, 200);

  assert.equal(cache.get(request(0, 500)), undefined);
  assert.equal(cache.get(request(500, 500)), undefined);
  assert.equal(cache.retainedRows, 0);
}

{
  const cache = new TableWindowCache(5_000);
  assert.equal(cache.put(request(0, 500), result(500, 500)), false);
  assert.equal(cache.put(request(0, 500, { generation: 1 }), result(0, 500, 2)), false);
  assert.equal(cache.retainedRows, 0);
}

{
  const cache = new TableWindowCache(5_000);
  const activeRequest = request(0, 500, {
    sessionKey: "session-a",
    columnIds: ["value"],
  });
  cache.put(activeRequest, result(0, 500, 0, ["_row_id", "value"]));

  const wrongColumns = cache.get(request(0, 500, {
    sessionKey: "session-a",
    columnIds: ["other"],
  }));
  assert.equal(wrongColumns, undefined, "different ordered column ids must not alias an existing window");

  const wrongSession = cache.get(request(0, 500, {
    sessionKey: "session-b",
    columnIds: ["value"],
  }));
  assert.equal(wrongSession, undefined, "different prepared sessions must not alias an existing window");
}

{
  const CacheCtor = TableWindowCache as unknown as new (config?: {
    maxRows?: number;
    maxBytes?: number;
  }) => TableWindowCache & CacheStats;
  const defaultCache = new CacheCtor();
  const tunedCache = new CacheCtor({ maxRows: 10, maxBytes: 512 });
  assert.equal(defaultCache.retainedRows, 0);
  assert.equal(defaultCache.entryCount, 0);
  assert.equal(defaultCache.estimatedBytes, 0);
  assert.equal(tunedCache.entryCount, 0);
}

{
  const sharedRow = [1, "shared-row"];
  const duplicateRowsResult: TableWindowResult = {
    columns: ["_row_id", "value"],
    columnTypes: ["BIGINT", "VARCHAR"],
    rows: [sharedRow, sharedRow],
    totalRows: 2,
    start: 0,
    generation: 0,
  };
  const CacheCtor = TableWindowCache as unknown as new (config?: {
    maxRows?: number;
    maxBytes?: number;
  }) => TableWindowCache & CacheStats;
  const cache = new CacheCtor({ maxRows: 10, maxBytes: 4_096 });
  cache.put(request(0, 2), duplicateRowsResult);

  assert.equal(cache.retainedRows, 2);
  assert.ok(cache.estimatedBytes > 0, "retained-byte diagnostics must be populated");

  const uniqueRowsResult: TableWindowResult = {
    ...duplicateRowsResult,
    rows: [[1, "shared-row"], [1, "shared-row"]],
  };
  const comparisonCache = new CacheCtor({ maxRows: 10, maxBytes: 4_096 });
  comparisonCache.put(request(0, 2), uniqueRowsResult);

  assert.ok(
    cache.estimatedBytes < comparisonCache.estimatedBytes,
    "shared row arrays within one entry must not be double-counted",
  );
}

{
  const CacheCtor = TableWindowCache as unknown as new (config?: {
    maxRows?: number;
    maxBytes?: number;
  }) => TableWindowCache & CacheStats & {
    pin(request: CacheRequest): void;
    invalidateGeneration(datasetId: string, generation: number): void;
  };
  const cache = new CacheCtor({ maxRows: 700, maxBytes: 40_000 });
  const active = request(0, 200);
  const neighbor = request(200, 200);
  const distant = request(400, 200);
  const newerGeneration = request(0, 200, { generation: 1 });

  cache.put(active, result(0, 200));
  cache.put(neighbor, result(200, 200));
  cache.pin(active);
  cache.put(distant, result(400, 200));

  assert.ok(cache.get(active), "pinning the active target must preserve it during pressure");
  assert.equal(cache.get(neighbor), undefined, "least-recently-used unpinned entries should be evicted first");
  assert.ok(cache.get(distant), "newly inserted entries should remain resident when within limits");

  cache.put(newerGeneration, result(0, 200, 1));
  cache.invalidateGeneration("dataset-a", 1);
  assert.equal(cache.get(active), undefined, "generation invalidation must clear incompatible retained entries");
  assert.ok(cache.get(newerGeneration), "generation invalidation must preserve entries that match the active generation");
  assert.equal(cache.entryCount, 1, "generation invalidation should leave only the current-generation entries behind");
}

console.log("table-window-cache regression passed");