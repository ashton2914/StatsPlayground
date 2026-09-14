import assert from "node:assert/strict";

import * as tableClipboard from "../src/utils/tableClipboard.ts";
import type { TableWindowRequest } from "../src/types/data.ts";

const { copyThenClear } = tableClipboard;

assert.equal(
  typeof (tableClipboard as Record<string, unknown>).buildClipboardTsv,
  "function",
  "large table copy must materialize logical rows outside the viewport",
);
assert.equal(
  typeof (tableClipboard as Record<string, unknown>).resolveClipboardSelection,
  "function",
  "table selection modes must resolve independently of the loaded viewport",
);
assert.equal(
  typeof (tableClipboard as Record<string, unknown>).createClipboardRowFetcher,
  "function",
  "clipboard copy must reuse loaded rows and fetch missing rows at a fixed generation",
);

const buildClipboardTsv = (tableClipboard as unknown as {
  buildClipboardTsv: (options: {
    rowSelection: { start: number; end: number } | { indices: number[] };
    columnIndexes: number[];
    columnNames: string[];
    withHeader: boolean;
    fetchRows: (start: number, count: number) => Promise<unknown[][]>;
  }) => Promise<string>;
}).buildClipboardTsv;

const resolveClipboardSelection = (tableClipboard as unknown as {
  resolveClipboardSelection: (options: {
    selectedRows: number[];
    selectedColumns: number[];
    range: { startRow: number; startCol: number; endRow: number; endCol: number } | null;
    activeCell: { row: number; col: number } | null;
    totalRows: number;
    columnCount: number;
  }) => {
    rowSelection: { start: number; end: number } | { indices: number[] };
    columnIndexes: number[];
  } | null;
}).resolveClipboardSelection;

const createClipboardRowFetcher = (tableClipboard as unknown as {
  createClipboardRowFetcher: (options: {
    datasetId: string;
    generation: number;
    filters: TableWindowRequest["filters"];
    windowStart: number;
    windowRows: unknown[][];
    queryWindow: (request: TableWindowRequest) => Promise<{
      columns: string[];
      rows: unknown[][];
    }>;
  }) => (start: number, count: number) => Promise<unknown[][]>;
}).createClipboardRowFetcher;

assert.deepEqual(
  resolveClipboardSelection({
    selectedRows: [],
    selectedColumns: [],
    range: { startRow: 0, startCol: 0, endRow: 1_199, endCol: 12 },
    activeCell: { row: 0, col: 0 },
    totalRows: 1_200,
    columnCount: 13,
  }),
  {
    rowSelection: { start: 0, end: 1_199 },
    columnIndexes: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
  },
);
assert.deepEqual(
  resolveClipboardSelection({
    selectedRows: [],
    selectedColumns: [4, 1],
    range: null,
    activeCell: null,
    totalRows: 4_501,
    columnCount: 6,
  }),
  { rowSelection: { start: 0, end: 4_500 }, columnIndexes: [1, 4] },
);
assert.deepEqual(
  resolveClipboardSelection({
    selectedRows: [2_501, 0, 2_500],
    selectedColumns: [],
    range: null,
    activeCell: null,
    totalRows: 4_501,
    columnCount: 3,
  }),
  { rowSelection: { indices: [0, 2_500, 2_501] }, columnIndexes: [0, 1, 2] },
);
assert.deepEqual(
  resolveClipboardSelection({
    selectedRows: [],
    selectedColumns: [],
    range: null,
    activeCell: { row: 701, col: 5 },
    totalRows: 1_200,
    columnCount: 13,
  }),
  { rowSelection: { start: 701, end: 701 }, columnIndexes: [5] },
);

{
  const requests: TableWindowRequest[] = [];
  const filters: TableWindowRequest["filters"] = [{
    op: "AND",
    rule: { kind: "categorical", field: "group", selected: ["A"] },
  }];
  const fetchRows = createClipboardRowFetcher({
    datasetId: "dataset-a",
    generation: 7,
    filters,
    windowStart: 0,
    windowRows: [["loaded-0"], ["loaded-1"]],
    queryWindow: async (request) => {
      requests.push(request);
      return { columns: ["_row_id", "value"], rows: [[2_501, "remote-2500"]] };
    },
  });

  assert.deepEqual(await fetchRows(0, 2), [["loaded-0"], ["loaded-1"]]);
  assert.deepEqual(requests, []);
  assert.deepEqual(await fetchRows(2_500, 1), [["remote-2500"]]);
  assert.deepEqual(requests, [{
    datasetId: "dataset-a",
    start: 2_500,
    count: 1,
    sort: null,
    filters,
    generation: 7,
  }]);
}

{
  const requests: Array<{ start: number; count: number }> = [];
  const tsv = await buildClipboardTsv({
    rowSelection: { start: 0, end: 4_500 },
    columnIndexes: [0, 2],
    columnNames: ["first", "ignored", "third"],
    withHeader: true,
    fetchRows: async (start, count) => {
      requests.push({ start, count });
      return Array.from({ length: count }, (_, offset) => {
        const row = start + offset;
        return [`row-${row}`, "unused", row];
      });
    },
  });

  assert.deepEqual(requests, [
    { start: 0, count: 2_000 },
    { start: 2_000, count: 2_000 },
    { start: 4_000, count: 501 },
  ]);
  const lines = tsv.split("\n");
  assert.equal(lines.length, 4_502);
  assert.equal(lines[0], "first\tthird");
  assert.equal(lines[1], "row-0\t0");
  assert.equal(lines[4_501], "row-4500\t4500");
}

{
  const requests: Array<{ start: number; count: number }> = [];
  const tsv = await buildClipboardTsv({
    rowSelection: { indices: [0, 2_500, 2_501] },
    columnIndexes: [0],
    columnNames: ["value"],
    withHeader: false,
    fetchRows: async (start, count) => {
      requests.push({ start, count });
      return Array.from({ length: count }, (_, offset) => [`row-${start + offset}`]);
    },
  });

  assert.deepEqual(requests, [
    { start: 0, count: 1 },
    { start: 2_500, count: 2 },
  ]);
  assert.equal(tsv, "row-0\nrow-2500\nrow-2501");
}

await assert.rejects(
  buildClipboardTsv({
    rowSelection: { start: 0, end: 2 },
    columnIndexes: [0],
    columnNames: ["value"],
    withHeader: false,
    fetchRows: async () => [["row-0"], ["row-1"]],
  }),
  /expected 3 rows, received 2/,
);

let cleared = false;
assert.equal(
  await copyThenClear(
    async () => { throw new Error("clipboard denied"); },
    async () => { cleared = true; },
  ),
  false,
);
assert.equal(cleared, false);

assert.equal(
  await copyThenClear(
    async () => true,
    async () => { cleared = true; },
  ),
  true,
);
assert.equal(cleared, true);

console.log("table-clipboard regression passed");
