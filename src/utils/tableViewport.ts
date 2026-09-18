import type {
  TableQuerySessionRequest,
  TableWindowFilter,
  TableWindowRequest,
  TableWindowResult,
  TableWindowSort,
} from "@/types/data";
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
  generation: number;
  rowCount: number;
  updatedAt: string;
}

export function shouldReloadDatasetRevision(
  previous: DatasetRevision | null,
  current: DatasetRevision,
): boolean {
  return previous !== null
    && previous.datasetId === current.datasetId
    && (
      previous.generation !== current.generation
      || previous.rowCount !== current.rowCount
      || previous.updatedAt !== current.updatedAt
    );
}

export function isStaleDatasetGenerationError(error: unknown): boolean {
  return String(error).includes("stale dataset generation:");
}

export async function queryTableWindowWithFreshGeneration(
  request: Omit<TableWindowRequest, "generation">,
  getGeneration: () => Promise<number>,
  queryWindow: (request: TableWindowRequest) => Promise<TableWindowResult>,
): Promise<TableWindowResult> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const generation = await getGeneration();
    try {
      return await queryWindow({ ...request, generation });
    } catch (error) {
      if (attempt > 0 || !isStaleDatasetGenerationError(error)) throw error;
    }
  }
  throw new Error("table window generation retry exhausted");
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
  private mutationDepth = 0;

  get current(): number {
    return this.value;
  }

  get canIssueViewportRequest(): boolean {
    return this.mutationDepth === 0;
  }

  advance(): number {
    this.value += 1;
    this.latestKey = null;
    return this.value;
  }

  beginMutation(): void {
    this.mutationDepth += 1;
    this.advance();
  }

  endMutation(): void {
    this.mutationDepth = Math.max(0, this.mutationDepth - 1);
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
        {
          const selected = [...rule.selected]
            .sort((left, right) => left.localeCompare(right))
            .filter((value, index, values) => index === 0 || values[index - 1] !== value);
        return {
          op,
          rule: {
            kind: rule.kind,
            field: rule.field.name,
            selected,
            exclude: rule.exclude ?? false,
          },
        };
        }
      case "date":
        return {
          op,
          rule: { kind: rule.kind, field: rule.field.name, start: rule.start, end: rule.end },
        };
    }
  });
}

function canonicalizeTableWindowSort(sort: TableWindowSort | null): Array<{ column: string; descending: boolean }> {
  if (!sort) {
    return [{ column: "_row_id", descending: false }];
  }
  const column = sort.column.trim();
  if (column.length === 0) {
    return [{ column: "_row_id", descending: false }];
  }
  if (column === "_row_id") {
    return [{ column, descending: sort.descending }];
  }
  return [
    { column, descending: sort.descending },
    { column: "_row_id", descending: false },
  ];
}

function canonicalizeTableWindowFilter(filter: TableWindowFilter): TableWindowFilter {
  const op = filter.op.toUpperCase() === "OR" ? "OR" : "AND";
  switch (filter.rule.kind) {
    case "continuous":
      return {
        op,
        rule: {
          kind: "continuous",
          field: filter.rule.field.trim(),
          min: filter.rule.min,
          max: filter.rule.max,
        },
      };
    case "categorical": {
      const selected = [...filter.rule.selected].sort((left, right) => left.localeCompare(right));
      return {
        op,
        rule: {
          kind: "categorical",
          field: filter.rule.field.trim(),
          selected,
          exclude: filter.rule.exclude ?? false,
        },
      };
    }
    case "date":
      return {
        op,
        rule: {
          kind: "date",
          field: filter.rule.field.trim(),
          start: filter.rule.start,
          end: filter.rule.end,
        },
      };
  }
}

function canonicalizeTableWindowFilters(filters: TableWindowFilter[]): TableWindowFilter[] {
  const normalized = filters.map(canonicalizeTableWindowFilter);
  if (normalized.length <= 1) {
    return normalized;
  }
  const firstOp = normalized[0]?.op;
  if (!firstOp || normalized.some((filter) => filter.op !== firstOp)) {
    return normalized;
  }
  return [...normalized].sort((left, right) => {
    const leftKey = JSON.stringify(left.rule);
    const rightKey = JSON.stringify(right.rule);
    return leftKey.localeCompare(rightKey);
  });
}

export function buildTableQuerySignature(
  filters: TableWindowFilter[],
  sort: TableWindowSort | null,
): string {
  return JSON.stringify({
    filters: canonicalizeTableWindowFilters(filters),
    sort: canonicalizeTableWindowSort(sort),
  });
}

export function buildTableQuerySessionSignature(request: TableQuerySessionRequest): string {
  return JSON.stringify({
    datasetId: request.datasetId.trim(),
    generation: request.generation,
    query: {
      filters: canonicalizeTableWindowFilters(request.filters),
      sort: canonicalizeTableWindowSort(request.sort),
    },
    columnIds: request.columnIds.map((columnId) => columnId.trim()),
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
