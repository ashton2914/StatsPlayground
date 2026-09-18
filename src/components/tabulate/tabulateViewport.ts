import type { TabulateWindowRequest, TabulateWindowResult } from "@/types/tabulate";

export const TABULATE_MAX_ROWS = 128;
export const TABULATE_MAX_COLUMNS = 64;
export const TABULATE_MAX_CELLS = 16_384;
export const TABULATE_MAX_HEADER_DEPTH = 128;
export const TABULATE_MAX_ID_LENGTH = 4_096;

export interface TabulateIdentity {
  sessionId: string;
  fingerprint: string;
  sourceGeneration: number;
  statisticCount: number;
}

export interface TabulateTileRequest extends TabulateWindowRequest, TabulateIdentity {}

export type TabulateWindowRange = Pick<TabulateWindowRequest,
  "rowStart" | "rowCount" | "columnStart" | "columnCount">;

export interface TabulateViewportInput {
  rowStart: number;
  columnStart: number;
  rowMemberCount: number;
  columnMemberCount: number;
  statisticCount: number;
  visibleRows: number;
  visibleColumns: number;
}

export interface HeaderSpan {
  level: number;
  label: unknown;
  start: number;
  span: number;
  continuesBefore: boolean;
  continuesAfter: boolean;
}

export interface HeaderBoundaryContext {
  before: readonly unknown[] | null;
  after: readonly unknown[] | null;
}

export function assertTabulateInteger(value: number, minimum: number, maximum = Number.MAX_SAFE_INTEGER): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError("Tabulate value is outside its safe integer bounds");
  }
}

export function tabulateIdentityKey(identity: TabulateIdentity): string {
  for (const value of [identity.sessionId, identity.fingerprint]) {
    if (typeof value !== "string" || value.length === 0 || value.length > TABULATE_MAX_ID_LENGTH) {
      throw new RangeError("Tabulate identity must be a bounded nonempty string");
    }
  }
  assertTabulateInteger(identity.sourceGeneration, 0);
  assertTabulateInteger(identity.statisticCount, 1, TABULATE_MAX_CELLS);
  return JSON.stringify([identity.sessionId, identity.fingerprint, identity.sourceGeneration, identity.statisticCount]);
}

export function assertTabulateTileRequest(request: TabulateTileRequest): void {
  tabulateIdentityKey(request);
  if (typeof request.requestId !== "string" || request.requestId.length === 0
    || request.requestId.length > TABULATE_MAX_ID_LENGTH) {
    throw new RangeError("Tabulate request ID must be a bounded nonempty string");
  }
  assertTabulateInteger(request.rowCount, 1, TABULATE_MAX_ROWS);
  assertTabulateInteger(request.columnCount, 1, TABULATE_MAX_COLUMNS);
  assertTabulateInteger(request.rowStart, 0, Number.MAX_SAFE_INTEGER - request.rowCount);
  assertTabulateInteger(request.columnStart, 0, Number.MAX_SAFE_INTEGER - request.columnCount);
  if (request.rowCount * request.columnCount > Math.floor(TABULATE_MAX_CELLS / request.statisticCount)) {
    throw new RangeError("Tabulate window exceeds the numeric cell bound");
  }
}

export function calculateTabulateWindow(input: TabulateViewportInput): TabulateWindowRange {
  assertTabulateInteger(input.rowStart, -Number.MAX_SAFE_INTEGER);
  assertTabulateInteger(input.columnStart, -Number.MAX_SAFE_INTEGER);
  assertTabulateInteger(input.rowMemberCount, 0);
  assertTabulateInteger(input.columnMemberCount, 0);
  assertTabulateInteger(input.visibleRows, 1);
  assertTabulateInteger(input.visibleColumns, 1);
  assertTabulateInteger(input.statisticCount, 1, TABULATE_MAX_CELLS);
  const rowStart = Math.max(0, Math.min(input.rowStart, input.rowMemberCount - 1));
  const columnStart = Math.max(0, Math.min(input.columnStart, input.columnMemberCount - 1));
  const cellBudget = Math.floor(TABULATE_MAX_CELLS / input.statisticCount);
  const columnCount = Math.min(input.visibleColumns, TABULATE_MAX_COLUMNS,
    input.columnMemberCount - columnStart, cellBudget);
  const rowCount = Math.min(input.visibleRows, TABULATE_MAX_ROWS,
    input.rowMemberCount - rowStart, Math.floor(cellBudget / Math.max(1, columnCount)));
  return { rowStart, rowCount, columnStart, columnCount };
}

function memberDepth(members: ReadonlyArray<ReadonlyArray<unknown>>, context: HeaderBoundaryContext): number {
  assertTabulateInteger(members.length, 0, TABULATE_MAX_ROWS);
  const depth = members[0]?.length ?? 0;
  assertTabulateInteger(depth, 0, TABULATE_MAX_HEADER_DEPTH);
  if (members.some((member) => !Array.isArray(member) || member.length !== depth)
    || (context.before !== null && (!Array.isArray(context.before) || context.before.length !== depth))
    || (context.after !== null && (!Array.isArray(context.after) || context.after.length !== depth))) {
    throw new RangeError("Tabulate hierarchy members must have consistent depth");
  }
  return depth;
}

function samePrefix(left: readonly unknown[] | null, right: readonly unknown[], length: number): boolean {
  if (left === null) return false;
  for (let index = 0; index < length; index += 1) {
    if (!Object.is(left[index], right[index])) return false;
  }
  return true;
}

export function buildVisibleHeaderSpans(
  members: ReadonlyArray<ReadonlyArray<unknown>>,
  boundaryContext: HeaderBoundaryContext,
): HeaderSpan[] {
  const depth = memberDepth(members, boundaryContext);
  const spans: HeaderSpan[] = [];
  for (let level = 0; level < depth; level += 1) {
    let start = 0;
    while (start < members.length) {
      let end = start + 1;
      while (end < members.length && samePrefix(members[start], members[end], level + 1)) end += 1;
      spans.push({
        level, label: members[start][level], start, span: end - start,
        continuesBefore: start === 0 && samePrefix(boundaryContext.before, members[start], level + 1),
        continuesAfter: end === members.length && samePrefix(boundaryContext.after, members[start], level + 1),
      });
      start = end;
    }
  }
  return spans;
}

function validMembers(
  members: unknown[][], before: unknown[] | null, after: unknown[] | null,
  start: number, count: number, total: number,
): boolean {
  assertTabulateInteger(total, 0);
  if (!Array.isArray(members) || start > Math.max(0, total - 1)
    || members.length !== Math.min(count, total - start)) return false;
  memberDepth(members, { before, after });
  return (before !== null) === (start > 0)
    && (after !== null) === (start + members.length < total);
}

export function validateTabulateWindow(request: TabulateTileRequest, result: TabulateWindowResult): boolean {
  try {
    assertTabulateTileRequest(request);
    if (result.sessionId !== request.sessionId || result.requestId !== request.requestId
      || result.sourceGeneration !== request.sourceGeneration || result.fingerprint !== request.fingerprint
      || result.rowStart !== request.rowStart || result.columnStart !== request.columnStart
      || !Array.isArray(result.statistics) || result.statistics.length !== request.statisticCount
      || typeof result.rowTotalsReady !== "boolean" || typeof result.columnTotalsReady !== "boolean"
      || !validMembers(result.rowMembers, result.rowMemberBefore, result.rowMemberAfter,
        request.rowStart, request.rowCount, result.rowMemberCount)
      || !validMembers(result.columnMembers, result.columnMemberBefore, result.columnMemberAfter,
        request.columnStart, request.columnCount, result.columnMemberCount)) return false;
    const maximumCells = result.rowMembers.length * result.columnMembers.length * request.statisticCount;
    if (!Array.isArray(result.cells) || result.cells.length > maximumCells) return false;
    const addresses = new Set<number>();
    for (const cell of result.cells) {
      assertTabulateInteger(cell.rowIndex, 0, result.rowMembers.length - 1);
      assertTabulateInteger(cell.columnIndex, 0, result.columnMembers.length - 1);
      assertTabulateInteger(cell.statisticIndex, 0, request.statisticCount - 1);
      if (cell.value !== null && (typeof cell.value !== "number" || !Number.isFinite(cell.value))) return false;
      const address = (cell.rowIndex * result.columnMembers.length + cell.columnIndex)
        * request.statisticCount + cell.statisticIndex;
      if (addresses.has(address)) return false;
      addresses.add(address);
    }
    return true;
  } catch {
    return false;
  }
}