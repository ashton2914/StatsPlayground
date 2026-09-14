import type { TableWindowRequest, TableWindowResult } from "@/types/data";

const CLIPBOARD_QUERY_CHUNK_ROWS = 2_000;

export type ClipboardRowSelection =
  | { start: number; end: number }
  | { indices: readonly number[] };

interface ResolveClipboardSelectionOptions {
  selectedRows: readonly number[];
  selectedColumns: readonly number[];
  range: { startRow: number; startCol: number; endRow: number; endCol: number } | null;
  activeCell: { row: number; col: number } | null;
  totalRows: number;
  columnCount: number;
}

export function resolveClipboardSelection({
  selectedRows,
  selectedColumns,
  range,
  activeCell,
  totalRows,
  columnCount,
}: ResolveClipboardSelectionOptions): {
  rowSelection: ClipboardRowSelection;
  columnIndexes: number[];
} | null {
  if (totalRows <= 0 || columnCount <= 0) return null;
  if (selectedRows.length > 0) {
    return {
      rowSelection: { indices: [...selectedRows].sort((left, right) => left - right) },
      columnIndexes: Array.from({ length: columnCount }, (_, index) => index),
    };
  }
  if (selectedColumns.length > 0) {
    return {
      rowSelection: { start: 0, end: totalRows - 1 },
      columnIndexes: [...selectedColumns].sort((left, right) => left - right),
    };
  }
  if (range) {
    const firstColumn = Math.min(range.startCol, range.endCol);
    const lastColumn = Math.max(range.startCol, range.endCol);
    return {
      rowSelection: {
        start: Math.min(range.startRow, range.endRow),
        end: Math.max(range.startRow, range.endRow),
      },
      columnIndexes: Array.from(
        { length: lastColumn - firstColumn + 1 },
        (_, index) => firstColumn + index,
      ),
    };
  }
  return activeCell
    ? {
      rowSelection: { start: activeCell.row, end: activeCell.row },
      columnIndexes: [activeCell.col],
    }
    : null;
}

interface CreateClipboardRowFetcherOptions {
  datasetId: string;
  generation: number;
  filters: TableWindowRequest["filters"];
  windowStart: number;
  windowRows: unknown[][];
  queryWindow: (
    request: TableWindowRequest,
  ) => Promise<Pick<TableWindowResult, "columns" | "rows">>;
}

export function createClipboardRowFetcher({
  datasetId,
  generation,
  filters,
  windowStart,
  windowRows,
  queryWindow,
}: CreateClipboardRowFetcherOptions): (
  start: number,
  count: number,
) => Promise<unknown[][]> {
  return async (start, count) => {
    const loadedOffset = start - windowStart;
    if (loadedOffset >= 0 && loadedOffset + count <= windowRows.length) {
      return windowRows.slice(loadedOffset, loadedOffset + count);
    }
    const result = await queryWindow({
      datasetId,
      start,
      count,
      sort: null,
      filters,
      generation,
    });
    const rowIdIndex = result.columns.indexOf("_row_id");
    if (rowIdIndex < 0) {
      throw new Error("clipboard query result is missing _row_id");
    }
    return result.rows.map((row) => row.filter((_, index) => index !== rowIdIndex));
  };
}

interface BuildClipboardTsvOptions {
  rowSelection: ClipboardRowSelection;
  columnIndexes: readonly number[];
  columnNames: readonly string[];
  withHeader: boolean;
  fetchRows: (start: number, count: number) => Promise<unknown[][]>;
}

function clipboardRowRanges(
  selection: BuildClipboardTsvOptions["rowSelection"],
): Array<{ start: number; end: number }> {
  if ("start" in selection) {
    return [{
      start: Math.min(selection.start, selection.end),
      end: Math.max(selection.start, selection.end),
    }];
  }

  const indices = [...new Set(selection.indices)]
    .filter((index) => Number.isInteger(index) && index >= 0)
    .sort((left, right) => left - right);
  const ranges: Array<{ start: number; end: number }> = [];
  for (const index of indices) {
    const previous = ranges[ranges.length - 1];
    if (previous && index === previous.end + 1) {
      previous.end = index;
    } else {
      ranges.push({ start: index, end: index });
    }
  }
  return ranges;
}

export async function buildClipboardTsv({
  rowSelection,
  columnIndexes,
  columnNames,
  withHeader,
  fetchRows,
}: BuildClipboardTsvOptions): Promise<string> {
  const lines: string[] = [];

  if (withHeader) {
    lines.push(columnIndexes.map((columnIndex) => columnNames[columnIndex] ?? "").join("\t"));
  }

  for (const range of clipboardRowRanges(rowSelection)) {
    for (let chunkStart = range.start; chunkStart <= range.end; chunkStart += CLIPBOARD_QUERY_CHUNK_ROWS) {
      const count = Math.min(CLIPBOARD_QUERY_CHUNK_ROWS, range.end - chunkStart + 1);
      const rows = await fetchRows(chunkStart, count);
      if (rows.length !== count) {
        throw new Error(`clipboard query expected ${count} rows, received ${rows.length}`);
      }
      for (const row of rows) {
        lines.push(columnIndexes
          .map((columnIndex) => row[columnIndex] == null ? "" : String(row[columnIndex]))
          .join("\t"));
      }
    }
  }

  return lines.join("\n");
}

export async function copyThenClear(
  copy: () => Promise<boolean>,
  clear: () => void | Promise<void>,
): Promise<boolean> {
  try {
    if (!await copy()) return false;
    await clear();
    return true;
  } catch {
    return false;
  }
}
