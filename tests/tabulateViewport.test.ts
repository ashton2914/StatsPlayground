import assert from "node:assert/strict";
import test from "node:test";

import {
  buildVisibleHeaderSpans,
  calculateTabulateWindow,
  validateTabulateWindow,
} from "../src/components/tabulate/tabulateViewport.ts";
import type { TabulateWindowResult } from "../src/types/tabulate.ts";

const input = {
  rowStart: 0, columnStart: 0, rowMemberCount: 1_000_000,
  columnMemberCount: 100_000, statisticCount: 8, visibleRows: 40, visibleColumns: 12,
};

test("logical starts clamp independently without backing up final short windows", () => {
  assert.deepEqual(calculateTabulateWindow({ ...input, rowStart: 999_990, columnStart: 99_990 }),
    { rowStart: 999_990, rowCount: 10, columnStart: 99_990, columnCount: 10 });
  assert.deepEqual(calculateTabulateWindow({ ...input, rowStart: -20, columnStart: 200_000 }),
    { rowStart: 0, rowCount: 40, columnStart: 99_999, columnCount: 1 });
  assert.deepEqual(calculateTabulateWindow({ ...input, rowStart: 2_000_000, columnStart: -5 }),
    { rowStart: 999_999, rowCount: 1, columnStart: 0, columnCount: 12 });
});

test("deep logical indexes do not depend on browser pixel or signed 32-bit limits", () => {
  assert.deepEqual(calculateTabulateWindow({
    ...input, rowStart: 8_000_000_000, columnStart: 5_000_000_000,
    rowMemberCount: 9_000_000_000, columnMemberCount: 6_000_000_000,
  }), { rowStart: 8_000_000_000, rowCount: 40, columnStart: 5_000_000_000, columnCount: 12 });
  assert.deepEqual(calculateTabulateWindow({
    ...input, rowMemberCount: Number.MAX_SAFE_INTEGER, rowStart: Number.MAX_SAFE_INTEGER - 2,
  }), { rowStart: Number.MAX_SAFE_INTEGER - 2, rowCount: 2, columnStart: 0, columnCount: 12 });
});

test("visible resize changes counts without moving logical starts", () => {
  assert.deepEqual(calculateTabulateWindow({ ...input, rowStart: 500, columnStart: 200,
    visibleRows: 12, visibleColumns: 5 }),
  { rowStart: 500, rowCount: 12, columnStart: 200, columnCount: 5 });
  assert.deepEqual(calculateTabulateWindow({ ...input, rowStart: 500, columnStart: 200,
    visibleRows: 60, visibleColumns: 20 }),
  { rowStart: 500, rowCount: 60, columnStart: 200, columnCount: 20 });
});

test("synthetic role members remain real single slots and empty axes stay empty", () => {
  assert.deepEqual(calculateTabulateWindow({ ...input, rowMemberCount: 1, columnMemberCount: 1 }),
    { rowStart: 0, rowCount: 1, columnStart: 0, columnCount: 1 });
  assert.deepEqual(calculateTabulateWindow({ ...input, rowMemberCount: 0, rowStart: 10 }),
    { rowStart: 0, rowCount: 0, columnStart: 0, columnCount: 12 });
  assert.deepEqual(calculateTabulateWindow({ ...input, columnMemberCount: 0, columnStart: 10 }),
    { rowStart: 0, rowCount: 40, columnStart: 0, columnCount: 0 });
});

test("transport caps count statistics and preserve columns before reducing rows", () => {
  for (const [statisticCount, rowCount, columnCount] of [
    [1, 128, 64], [2, 128, 64], [3, 85, 64], [8, 32, 64],
    [257, 1, 63], [16_384, 1, 1],
  ]) {
    assert.deepEqual(calculateTabulateWindow({ ...input, statisticCount,
      visibleRows: 1_000, visibleColumns: 1_000 }),
    { rowStart: 0, rowCount, columnStart: 0, columnCount });
  }
  const exact = calculateTabulateWindow({ ...input, statisticCount: 8,
    visibleRows: 128, visibleColumns: 64 });
  assert.equal(exact.rowCount * exact.columnCount * 8, 16_384);
  assert.deepEqual(calculateTabulateWindow({ ...input, columnStart: 99_999,
    visibleRows: 128, visibleColumns: 64 }),
  { rowStart: 0, rowCount: 128, columnStart: 99_999, columnCount: 1 });
});

test("unsafe, fractional, nonfinite and impossible inputs are rejected", () => {
  for (const patch of [
    { rowStart: NaN }, { columnStart: Infinity }, { rowStart: 0.5 },
    { rowMemberCount: -1 }, { columnMemberCount: Number.MAX_SAFE_INTEGER + 1 },
    { visibleRows: 0 }, { visibleColumns: -1 }, { statisticCount: 0 },
    { statisticCount: 16_385 },
  ]) assert.throws(() => calculateTabulateWindow({ ...input, ...patch }), RangeError);
});

test("hierarchy spans carry boundary continuation using the entire parent prefix", () => {
  assert.deepEqual(buildVisibleHeaderSpans([["A", "x"], ["A", "y"], ["B", "y"]], {
    before: ["A", "x"], after: ["B", "y"],
  }), [
    { level: 0, label: "A", start: 0, span: 2, continuesBefore: true, continuesAfter: false },
    { level: 0, label: "B", start: 2, span: 1, continuesBefore: false, continuesAfter: true },
    { level: 1, label: "x", start: 0, span: 1, continuesBefore: true, continuesAfter: false },
    { level: 1, label: "y", start: 1, span: 1, continuesBefore: false, continuesAfter: false },
    { level: 1, label: "y", start: 2, span: 1, continuesBefore: false, continuesAfter: true },
  ]);
  assert.deepEqual(buildVisibleHeaderSpans([["B", null]], {
    before: ["A", null], after: ["B", null],
  }), [
    { level: 0, label: "B", start: 0, span: 1, continuesBefore: false, continuesAfter: true },
    { level: 1, label: null, start: 0, span: 1, continuesBefore: false, continuesAfter: true },
  ]);
});

test("hierarchy output is bounded, supports synthetic members, and rejects ragged context", () => {
  assert.deepEqual(buildVisibleHeaderSpans([[]], { before: null, after: null }), []);
  assert.deepEqual(buildVisibleHeaderSpans([], { before: null, after: null }), []);
  assert.throws(() => buildVisibleHeaderSpans(Array.from({ length: 129 }, () => ["A"]),
    { before: null, after: null }), RangeError);
  assert.throws(() => buildVisibleHeaderSpans([Array(129).fill("A")],
    { before: null, after: null }), RangeError);
  assert.throws(() => buildVisibleHeaderSpans([["A"], ["A", "x"]],
    { before: null, after: null }), RangeError);
  assert.throws(() => buildVisibleHeaderSpans([["A"]],
    { before: ["A", "x"], after: null }), RangeError);
});

const request = {
  sessionId: "session", fingerprint: "definition", sourceGeneration: 7, statisticCount: 1,
  requestId: "request", rowStart: 99, rowCount: 8, columnStart: 9, columnCount: 4,
};
const result: TabulateWindowResult = {
  sessionId: "session", fingerprint: "definition", sourceGeneration: 7, requestId: "request",
  rowStart: 99, columnStart: 9, rowMembers: [["R99"]], columnMembers: [["C9"]],
  rowMemberBefore: ["R98"], rowMemberAfter: null,
  columnMemberBefore: ["C8"], columnMemberAfter: null,
  statistics: [{ id: "count", field: "", kind: "count" }],
  cells: [{ rowIndex: 0, columnIndex: 0, statisticIndex: 0, value: 2 }],
  rowTotalsReady: false, columnTotalsReady: false, rowMemberCount: 100, columnMemberCount: 10,
};

test("response validation accepts sparse final windows and synthetic empty members", () => {
  assert.equal(validateTabulateWindow(request, result), true);
  assert.equal(validateTabulateWindow({ ...request, rowStart: 0, columnStart: 0 }, {
    ...result, rowStart: 0, columnStart: 0, rowMembers: [[]], columnMembers: [[]],
    rowMemberBefore: null, columnMemberBefore: null, rowMemberCount: 1, columnMemberCount: 1,
    cells: [],
  }), true);
});

test("response validation rejects stale identities, false short windows and bad sparse addresses", () => {
  for (const patch of [
    { requestId: "old" }, { sessionId: "old" }, { fingerprint: "old" }, { sourceGeneration: 6 },
    { rowStart: 98 }, { columnStart: 8 }, { rowMemberCount: 101 }, { columnMemberCount: 11 },
    { statistics: [] }, { rowMemberBefore: null }, { rowMemberAfter: ["unexpected"] },
    { cells: [{ rowIndex: 1, columnIndex: 0, statisticIndex: 0, value: 1 }] },
    { cells: [{ rowIndex: 0, columnIndex: 1, statisticIndex: 0, value: 1 }] },
    { cells: [{ rowIndex: 0, columnIndex: 0, statisticIndex: 1, value: 1 }] },
    { cells: [{ rowIndex: 0.5, columnIndex: 0, statisticIndex: 0, value: 1 }] },
    { cells: [{ rowIndex: 0, columnIndex: 0, statisticIndex: 0, value: NaN }] },
    { cells: [result.cells[0], result.cells[0]] },
  ]) assert.equal(validateTabulateWindow(request, { ...result, ...patch }), false, JSON.stringify(patch));
  assert.equal(validateTabulateWindow({ ...request, rowCount: 129 }, result), false);
});