import type { TableWindowFilter } from "@/types/data";
import type { FilterRuleItem } from "@/types/filter";

interface TableViewportInput {
  totalRows: number;
  rowHeight: number;
  scrollTop: number;
  viewportHeight: number;
  overscanRows: number;
  pageSize: number;
}

interface TableWindowRange {
  start: number;
  count: number;
}

interface TableRenderRange {
  startIdx: number;
  endIdx: number;
}

const MAX_WINDOW_ROWS = 2_000;
export const MAX_MATERIALIZED_SELECTION_ITEMS = 100_000;

export interface DatasetRevision {
  datasetId: string;
  rowCount: number;
  updatedAt: string;
}

export function shouldReloadDatasetRevision(
  previous: DatasetRevision | null,
  current: DatasetRevision,
): boolean {
  return previous !== null
    && previous.datasetId === current.datasetId
    && (previous.rowCount !== current.rowCount || previous.updatedAt !== current.updatedAt);
}

export function canMaterializeSelection(
  firstRow: number,
  lastRow: number,
  firstCol: number,
  lastCol: number,
  windowStart: number,
  windowRowCount: number,
  maxItems = MAX_MATERIALIZED_SELECTION_ITEMS,
  existingItems = 0,
): boolean {
  const rowStart = Math.min(firstRow, lastRow);
  const rowEnd = Math.max(firstRow, lastRow);
  const colStart = Math.min(firstCol, lastCol);
  const colEnd = Math.max(firstCol, lastCol);
  if (rowStart < windowStart || rowEnd >= windowStart + windowRowCount) return false;
  if (colStart < 0 || existingItems < 0 || maxItems <= existingItems) return false;
  const rowCount = rowEnd - rowStart + 1;
  const colCount = colEnd - colStart + 1;
  return rowCount > 0
    && colCount > 0
    && rowCount <= Math.floor((maxItems - existingItems) / colCount);
}

export class RequestEpoch {
  private value = 0;
  private latestKey: string | null = null;

  get current(): number {
    return this.value;
  }

  advance(): number {
    this.value += 1;
    this.latestKey = null;
    return this.value;
  }

  isCurrent(epoch: number): boolean {
    return epoch === this.value;
  }

  track(key: string): { epoch: number; key: string } {
    this.latestKey = key;
    return { epoch: this.value, key };
  }

  isLatest(request: { epoch: number; key: string }): boolean {
    return request.epoch === this.value && request.key === this.latestKey;
  }
}

export function windowRowAt<T>(
  window: { start: number; rows: T[] },
  logicalIndex: number,
): T | undefined {
  const localIndex = logicalIndex - window.start;
  return localIndex >= 0 ? window.rows[localIndex] : undefined;
}

export function calculatePlaceholderRange(
  viewportStart: number,
  viewportEnd: number,
  windowStart: number,
  windowRowCount: number,
): TableRenderRange | null {
  if (viewportEnd <= viewportStart) return null;
  const windowEnd = windowStart + windowRowCount;
  const hasLoadedRows = viewportStart < windowEnd && windowStart < viewportEnd;
  return hasLoadedRows ? null : { startIdx: viewportStart, endIdx: viewportEnd };
}

export function serializeTableWindowFilters(filters: FilterRuleItem[]): TableWindowFilter[] {
  return filters.map(({ op, rule }) => {
    switch (rule.kind) {
      case "continuous":
        return {
          op,
          rule: { kind: rule.kind, field: rule.field.name, min: rule.min, max: rule.max },
        };
      case "categorical":
        return {
          op,
          rule: {
            kind: rule.kind,
            field: rule.field.name,
            selected: rule.selected,
            exclude: rule.exclude ?? false,
          },
        };
      case "date":
        return {
          op,
          rule: { kind: rule.kind, field: rule.field.name, start: rule.start, end: rule.end },
        };
    }
  });
}

export function calculateTableWindow(input: TableViewportInput): TableWindowRange {
  if (input.totalRows <= 0) {
    return { start: 0, count: 0 };
  }
  if (input.rowHeight <= 0 || input.pageSize <= 0) {
    throw new RangeError("rowHeight and pageSize must be positive");
  }

  const visibleStart = Math.min(
    input.totalRows - 1,
    Math.floor(Math.max(0, input.scrollTop) / input.rowHeight),
  );
  const visibleEnd = Math.ceil(
    (Math.max(0, input.scrollTop) + Math.max(0, input.viewportHeight)) / input.rowHeight,
  );
  const rangeStart = Math.max(0, visibleStart - input.overscanRows);
  const rangeEnd = Math.min(input.totalRows, visibleEnd + input.overscanRows);
  const start = Math.floor(rangeStart / input.pageSize) * input.pageSize;
  const alignedEnd = Math.min(
    input.totalRows,
    Math.ceil(rangeEnd / input.pageSize) * input.pageSize,
  );

  return {
    start,
    count: Math.min(MAX_WINDOW_ROWS, alignedEnd - start),
  };
}
