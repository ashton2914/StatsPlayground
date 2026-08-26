import type { CreateTableFromRowsRequest } from "@/types/data";
import type { TabulateItem, TabulateResult, TabulateStatistic } from "@/types/tabulate";

export interface HeaderSpan {
  label: unknown;
  start: number;
  span: number;
}

const NUMERIC_DUCKDB_TYPES = new Set([
  "TINYINT",
  "SMALLINT",
  "INTEGER",
  "BIGINT",
  "UTINYINT",
  "USMALLINT",
  "UINTEGER",
  "UBIGINT",
  "HUGEINT",
  "UHUGEINT",
  "FLOAT",
  "REAL",
  "DOUBLE",
  "DECIMAL",
  "NUMERIC",
]);

export function isNumericDuckDbType(dataType: string): boolean {
  return NUMERIC_DUCKDB_TYPES.has(dataType.trim().toUpperCase().split("(", 1)[0]);
}

export function canShowReadyResult(
  cellCount: number,
  datasetAvailable: boolean,
  statisticCount: number,
): boolean {
  return datasetAvailable && statisticCount > 0 && cellCount > 0;
}

export function canExportTabulateResult(
  resultReady: boolean,
  requestCurrent: boolean,
  loading: boolean,
  readOnly: boolean,
  exporting: boolean,
): boolean {
  return resultReady && requestCurrent && !loading && !readOnly && !exporting;
}

export function cellIndex(
  rowIndex: number,
  columnIndex: number,
  statisticIndex: number,
  columnCount: number,
  statisticCount: number,
): number {
  return ((rowIndex * columnCount) + columnIndex) * statisticCount + statisticIndex;
}

export function totalIndex(memberIndex: number, statisticIndex: number, statisticCount: number): number {
  return (memberIndex * statisticCount) + statisticIndex;
}

export function buildHeaderSpans(members: ReadonlyArray<ReadonlyArray<unknown>>): HeaderSpan[][] {
  if (members.length === 0) {
    return [];
  }

  const depth = members[0]?.length ?? 0;
  const spansByDepth: HeaderSpan[][] = [];

  for (let level = 0; level < depth; level += 1) {
    const levelSpans: HeaderSpan[] = [];
    let start = 0;

    while (start < members.length) {
      const label = members[start][level];
      let end = start + 1;

      while (end < members.length && samePrefix(members[start], members[end], level + 1)) {
        end += 1;
      }

      levelSpans.push({ label, start, span: end - start });
      start = end;
    }

    spansByDepth.push(levelSpans);
  }

  return spansByDepth;
}

export function isLatestSequence(sequence: number, latestSequence: number): boolean {
  return sequence === latestSequence;
}

export function parseQuantileInput(value: string): number | null {
  if (value.trim() === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : null;
}

export function reorderForDrop<T>(items: readonly T[], from: number, target: number): T[] {
  if (from < 0 || from >= items.length) {
    return [...items];
  }
  const next = [...items];
  const [entry] = next.splice(from, 1);
  const boundedTarget = Math.max(0, Math.min(items.length, target));
  const insertionIndex = from < boundedTarget ? boundedTarget - 1 : boundedTarget;
  next.splice(insertionIndex, 0, entry);
  return next;
}

function samePrefix(
  left: ReadonlyArray<unknown>,
  right: ReadonlyArray<unknown>,
  prefixLength: number,
): boolean {
  for (let index = 0; index < prefixLength; index += 1) {
    if (!Object.is(left[index], right[index])) {
      return false;
    }
  }
  return true;
}

type TabulateAssignmentRole = "rows" | "columns" | "statistics";
type TabulateExportItem = Pick<TabulateItem, "rowFields" | "columnFields" | "statistics">;
type TabulateExportResult = Pick<TabulateResult, "rowMembers" | "columnMembers" | "statistics" | "cells">;

export function canAssignTabulateField(
  role: TabulateAssignmentRole,
  currentFields: readonly string[],
  fieldName: string,
): boolean {
  if (role === "rows") {
    return currentFields.length === 0 && !currentFields.includes(fieldName);
  }
  if (role === "columns") {
    return !currentFields.includes(fieldName);
  }
  return true;
}

export function buildTabulateExportRequest(
  item: TabulateExportItem,
  result: TabulateExportResult,
  options: {
    tableName: string;
    missingLabel: string;
    statisticLabel: (statistic: TabulateStatistic) => string;
  },
): CreateTableFromRowsRequest {
  const { rowFields, columnFields } = item;
  const { statistics, columnMembers, rowMembers, cells } = result;

  if (rowFields.length > 1) {
    throw new Error("Tabulate export accepts at most one row field");
  }
  if (statistics.length === 0) {
    throw new Error("Tabulate export requires at least one statistic");
  }
  if (statistics.length !== item.statistics.length) {
    throw new Error("Tabulate export statistic count does not match the item");
  }
  if (rowMembers.some((member) => member.length !== rowFields.length)) {
    throw new Error("Tabulate export row member depth does not match row fields");
  }
  if (columnMembers.some((member) => member.length !== columnFields.length)) {
    throw new Error("Tabulate export column member depth does not match column fields");
  }

  const expectedCellCount = rowMembers.length * columnMembers.length * statistics.length;
  if (cells.length !== expectedCellCount) {
    throw new Error(`Tabulate export cell count must be ${expectedCellCount}, received ${cells.length}`);
  }

  const dedupe = new Map<string, number>();
  const columnNames: string[] = [];
  const columnTypes: string[] = [];

  function uniqueName(base: string): string {
    const count = dedupe.get(base) ?? 0;
    if (count === 0) {
      dedupe.set(base, 1);
      return base;
    }
    const next = count + 1;
    dedupe.set(base, next);
    return `${base} (${next})`;
  }

  if (rowFields.length > 0) {
    columnNames.push(uniqueName(rowFields[0]));
    columnTypes.push("VARCHAR");
  }

  const columnCount = columnMembers.length;
  const statisticCount = statistics.length;

  for (let c = 0; c < columnCount; c += 1) {
    const member = columnMembers[c] ?? [];
    for (let s = 0; s < statisticCount; s += 1) {
      const stat = statistics[s];
      const memberLabels = member.map((m) => (m == null ? options.missingLabel : String(m)));
      const parts = [...memberLabels, options.statisticLabel(stat), stat.field];
      const base = parts.join(" - ");
      columnNames.push(uniqueName(base));
      columnTypes.push("DOUBLE");
    }
  }

  const rows: Array<Array<string | number | boolean | null>> = [];

  for (let r = 0; r < rowMembers.length; r += 1) {
    const row: Array<string | number | boolean | null> = [];
    if (rowFields.length > 0) {
      const label = rowMembers[r]?.[0];
      row.push(label == null ? options.missingLabel : String(label));
    }

    for (let c = 0; c < columnCount; c += 1) {
      for (let s = 0; s < statisticCount; s += 1) {
        const idx = cellIndex(r, c, s, columnCount, statisticCount);
        const value = cells[idx];
        row.push(typeof value === "number" && Number.isNaN(value) ? null : value);
      }
    }

    rows.push(row);
  }

  return {
    name: options.tableName,
    columnNames,
    columnTypes,
    rows,
  };
}