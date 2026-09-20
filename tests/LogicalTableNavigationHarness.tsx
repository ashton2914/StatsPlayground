import { useEffect, useRef, useState } from "react";

import { DataTableView } from "../src/components/DataTableView";
import i18n from "../src/i18n";
import { dataService } from "../src/services/dataService";
import { useDataStore } from "../src/stores/useDataStore";
import { useDatasetFilterStore } from "../src/stores/useDatasetFilterStore";
import { useHistoryStore } from "../src/stores/useHistoryStore";
import { useProjectStore } from "../src/stores/useProjectStore";
import { useTableNavigationSortStore } from "../src/stores/useTableNavigationSortStore";
import { useTableZoomStore } from "../src/stores/useTableZoomStore";
import type {
  ColumnDescriptor,
  DatasetMeta,
  TableWindowSort,
  TableNavigationRequest,
  TableNavigationResult,
  TableQuerySessionRequest,
  TableQuerySessionStatus,
  TableWindowFilter,
  TableWindowResult,
} from "../src/types/data";
import type { FilterRuleItem } from "../src/types/filter";

const GENERATION = 1;
const WINDOW_DELAY_MS = 120;
const FILTERED_TOTAL_ROWS = {
  none: 10_000_000,
  ev: 24,
  dv: 11,
} as const;

const SORTED_TOTAL_ROWS = 37;

type HarnessFilterMode = keyof typeof FILTERED_TOTAL_ROWS;
type HarnessSortMode = "natural" | "value-desc";

const FILTER_RULES: Record<Exclude<HarnessFilterMode, "none">, FilterRuleItem[]> = {
  ev: [
    {
      id: "logical-filter-ev",
      op: "AND",
      rule: {
        kind: "categorical",
        field: { name: "Column 1", type: "nominal" },
        selected: ["EV"],
        exclude: false,
      },
    },
  ],
  dv: [
    {
      id: "logical-filter-dv",
      op: "AND",
      rule: {
        kind: "categorical",
        field: { name: "Column 1", type: "nominal" },
        selected: ["DV"],
        exclude: false,
      },
    },
  ],
};

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function createDataset(
  rowCount: number,
  dataColumnCount: number,
  generation = GENERATION,
): DatasetMeta {
  return {
    id: "logical-scroll-dataset",
    name: "Logical scroll measurements",
    sourcePath: null,
    sourceType: "manual",
    rowCount,
    colCount: dataColumnCount,
    generation,
    createdAt: "2026-09-17T00:00:00.000Z",
    updatedAt: "2026-09-17T00:00:00.000Z",
  };
}

function resolveFilterModeFromRules(filters: readonly FilterRuleItem[] | TableWindowFilter[]): HarnessFilterMode {
  const selected = filters.find((filter) => filter.rule.kind === "categorical")?.rule.selected?.[0];
  if (selected === "EV") return "ev";
  if (selected === "DV") return "dv";
  return "none";
}

function createRow(
  rowIndex: number,
  dataColumnCount: number,
  edits: Map<string, unknown>,
  mode: HarnessFilterMode,
  sortMode: HarnessSortMode,
): unknown[] {
  const logicalRowNumber = rowIndex + 1;
  const prefix = sortMode === "value-desc"
    ? "sort-desc-row"
    : (mode === "none" ? "row" : `${mode}-row`);
  return [
    logicalRowNumber,
    ...Array.from({ length: dataColumnCount }, (_, columnIndex) => {
      const columnName = `Column ${columnIndex + 1}`;
      const valueKey = `${logicalRowNumber}:${columnName}`;
      return String(edits.get(valueKey) ?? `${prefix}-${logicalRowNumber}-col-${columnIndex + 1}`);
    }),
  ];
}

function buildWindow(
  totalRows: number,
  dataColumnCount: number,
  start: number,
  count: number,
  edits: Map<string, unknown>,
  mode: HarnessFilterMode,
  sortMode: HarnessSortMode,
  generation = GENERATION,
): TableWindowResult {
  const maxStart = Math.max(0, totalRows - 1);
  const safeStart = clamp(start, 0, maxStart);
  const safeCount = clamp(count, 0, Math.max(0, totalRows - safeStart));
  return {
    columns: ["_row_id", ...Array.from({ length: dataColumnCount }, (_, columnIndex) => `Column ${columnIndex + 1}`)],
    columnTypes: ["BIGINT", ...Array.from({ length: dataColumnCount }, () => "VARCHAR")],
    rows: Array.from({ length: safeCount }, (_, index) => createRow(safeStart + index, dataColumnCount, edits, mode, sortMode)),
    totalRows,
    start: safeStart,
    generation,
  };
}

function buildDescriptors(dataColumnCount: number): ColumnDescriptor[] {
  return Array.from({ length: dataColumnCount }, (_, columnIndex) => ({
    columnId: `column-${columnIndex + 1}`,
    name: `Column ${columnIndex + 1}`,
    sqlType: "VARCHAR",
  }));
}

function buildNavigationWindow(
  request: TableNavigationRequest,
  dataColumnCount: number,
  edits: Map<string, unknown>,
  totalRows: number,
  mode: HarnessFilterMode,
  sortMode: HarnessSortMode,
): TableNavigationResult {
  const window = buildWindow(
    totalRows,
    dataColumnCount,
    request.start,
    request.count,
    edits,
    mode,
    sortMode,
    request.generation,
  );
  return {
    version: 1,
    requestId: request.requestId,
    datasetId: request.datasetId,
    generation: request.generation,
    start: window.start,
    totalRows: window.totalRows,
    totalRowsExact: true,
    sessionId: request.sessionId ?? null,
    columns: window.columns,
    columnTypes: window.columnTypes,
    rows: window.rows,
    timings: { totalMs: 1 },
  };
}

interface LogicalTableNavigationHarnessProps {
  rowCount?: number;
  columnCount?: number;
  width?: number;
  height?: number;
  zoom?: number;
  initialFilterMode?: HarnessFilterMode;
  rejectCancelledNavigation?: boolean;
}

interface NavigationRequestObservation {
  requestId: string;
  start: number;
  sessionId: string | null;
  kind: "active" | "prefetch";
  visibleCellTextAtRequest: string | null;
  lastPaintedVisibleCellText: string | null;
  afterPaintObserved: boolean;
}

export function LogicalTableNavigationHarness({
  rowCount = 10_000_000,
  columnCount = 8,
  width = 920,
  height = 588,
  zoom = 1,
  initialFilterMode = "none",
  rejectCancelledNavigation = false,
}: LogicalTableNavigationHarnessProps) {
  const [ready, setReady] = useState(false);
  const dirty = useProjectStore((state) => state.dirty);
  const statusInfo = useDataStore((state) => state.statusInfo);
  const pendingAction = useHistoryStore((state) => state.pendingAction);
  const [dataset, setDataset] = useState(() => createDataset(rowCount, columnCount));
  const [navigationRequestStarts, setNavigationRequestStarts] = useState<number[]>([]);
  const [resolvedNavigationRequestStarts, setResolvedNavigationRequestStarts] = useState<number[]>([]);
  const [cancelledNavigationRequestStarts, setCancelledNavigationRequestStarts] = useState<number[]>([]);
  const [navigationRequestSessionIds, setNavigationRequestSessionIds] = useState<string[]>([]);
  const [navigationRequestObservations, setNavigationRequestObservations] = useState<NavigationRequestObservation[]>([]);
  const [preparedSessionIds, setPreparedSessionIds] = useState<string[]>([]);
  const [sessionStatusCalls, setSessionStatusCalls] = useState<string[]>([]);
  const [sessionExactCounts, setSessionExactCounts] = useState<number[]>([]);
  const [releasedSessionIds, setReleasedSessionIds] = useState<string[]>([]);
  const [addRowsRequests, setAddRowsRequests] = useState<Array<{
    count: number;
    beforeRowId: number | null;
    expectedGeneration: number;
  }>>([]);
  const [filterMode, setFilterMode] = useState<HarnessFilterMode>(initialFilterMode);
  const [sortMode, setSortMode] = useState<HarnessSortMode>("natural");
  const rootRef = useRef<HTMLDivElement | null>(null);
  const datasetRef = useRef(dataset);
  const editsRef = useRef<Map<string, unknown>>(new Map());
  const filterModeRef = useRef(filterMode);
  const sortModeRef = useRef(sortMode);
  const sessionReadyAtRef = useRef<Map<string, number>>(new Map());
  const navigationCancellersRef = useRef<Map<string, () => void>>(new Map());
  const navigationRequestStartsByIdRef = useRef<Map<string, number>>(new Map());
  const delayedWindowLoadsRef = useRef(0);
  const lastPaintedVisibleCellTextRef = useRef<string | null>(null);

  datasetRef.current = dataset;
  filterModeRef.current = filterMode;
  sortModeRef.current = sortMode;

  useEffect(() => {
    setDataset((current) => {
      if (current.rowCount === rowCount && current.colCount === columnCount) {
        return current;
      }
      return createDataset(rowCount, columnCount);
    });
    editsRef.current.clear();
    setNavigationRequestStarts([]);
    setResolvedNavigationRequestStarts([]);
    setCancelledNavigationRequestStarts([]);
    setNavigationRequestSessionIds([]);
    setNavigationRequestObservations([]);
    setPreparedSessionIds([]);
    setSessionStatusCalls([]);
    setSessionExactCounts([]);
    setReleasedSessionIds([]);
    setAddRowsRequests([]);
    setFilterMode(initialFilterMode);
    setSortMode("natural");
    sessionReadyAtRef.current.clear();
    lastPaintedVisibleCellTextRef.current = null;
  }, [columnCount, initialFilterMode, rowCount]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    let active = true;
    let firstFrame: number | null = null;
    let secondFrame: number | null = null;
    const readVisibleCellText = () => {
      const cell = root.querySelector('[data-viewport-slot="0"] td[data-row][data-col] .sp-val');
      const text = cell?.textContent?.trim();
      return text && text.length > 0 ? text : null;
    };
    const publishPaint = () => {
      if (!active) return;
      const paintedText = readVisibleCellText();
      lastPaintedVisibleCellTextRef.current = paintedText;
      setNavigationRequestObservations((previous) => previous.map((entry) => ({
        ...entry,
        lastPaintedVisibleCellText: paintedText,
        afterPaintObserved: entry.afterPaintObserved || (
          paintedText != null
          && entry.visibleCellTextAtRequest != null
          && entry.visibleCellTextAtRequest === paintedText
        ),
      })));
    };
    const schedulePaintObservation = () => {
      if (firstFrame != null || secondFrame != null) return;
      firstFrame = window.requestAnimationFrame(() => {
        firstFrame = null;
        secondFrame = window.requestAnimationFrame(() => {
          secondFrame = null;
          publishPaint();
        });
      });
    };

    publishPaint();
    const observer = new MutationObserver(() => {
      schedulePaintObservation();
    });
    observer.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["class", "data-row", "data-col"],
    });

    return () => {
      active = false;
      observer.disconnect();
      if (firstFrame != null) window.cancelAnimationFrame(firstFrame);
      if (secondFrame != null) window.cancelAnimationFrame(secondFrame);
    };
  }, [ready]);

  useEffect(() => {
    const previousDataState = useDataStore.getState();
    const previousFilterState = useDatasetFilterStore.getState();
    const previousProjectState = useProjectStore.getState();
    const previousHistoryState = useHistoryStore.getState();
    const previousSortState = useTableNavigationSortStore.getState();
    const previousZoom = useTableZoomStore.getState().zoom;
    const previousLanguage = i18n.resolvedLanguage ?? i18n.language;
    const previousGetDatasetGeneration = dataService.getDatasetGeneration;
    const previousQueryTableWindow = dataService.queryTableWindow;
    const previousQueryTableNavigationWindow = dataService.queryTableNavigationWindow;
    const previousPrepareTableQuerySession = dataService.prepareTableQuerySession;
    const previousGetTableQuerySessionStatus = dataService.getTableQuerySessionStatus;
    const previousReleaseTableQuerySession = dataService.releaseTableQuerySession;
    const previousCancelTableNavigationRequest = dataService.cancelTableNavigationRequest;
    const previousGetColumnDescriptors = dataService.getColumnDescriptors;
    const previousGetColumnDisplayProps = dataService.getColumnDisplayProps;
    const previousUpdateCell = dataService.updateCell;
    const previousAddRow = dataService.addRow;
    const previousAddRows = dataService.addRows;
    const currentDataset = datasetRef.current;
    let active = true;

    useDataStore.setState({
      ...previousDataState,
      activeDatasetId: currentDataset.id,
      datasets: [currentDataset],
      statusInfo: null,
    });
    useDatasetFilterStore.setState({
      ...previousFilterState,
      byDataset: filterModeRef.current === "none"
        ? {}
        : { [currentDataset.id]: FILTER_RULES[filterModeRef.current] },
    });
    useTableNavigationSortStore.setState({
      ...previousSortState,
      byDataset: sortModeRef.current === "natural"
        ? {}
        : { [currentDataset.id]: { column: "Column 2", descending: true } },
    });
    useProjectStore.setState({ ...previousProjectState, readOnly: false, dirty: false, saving: false, saveError: null });
    useHistoryStore.setState({ ...previousHistoryState, historyRevision: 0, historyError: null, pendingRestore: null });
    useTableZoomStore.setState({ zoom });

    dataService.getDatasetGeneration = async () => datasetRef.current.generation;
    dataService.queryTableWindow = async ({ start, count, filters }) => {
      const effectiveStart = typeof start === "number" ? start : 0;
      const effectiveCount = typeof count === "number" ? count : 500;
      const mode = resolveFilterModeFromRules(filters ?? []);
      if (delayedWindowLoadsRef.current > 0) {
        delayedWindowLoadsRef.current -= 1;
        await new Promise((resolve) => window.setTimeout(resolve, WINDOW_DELAY_MS));
      } else if (effectiveStart > 0) {
        await new Promise((resolve) => window.setTimeout(resolve, WINDOW_DELAY_MS));
      }
      return buildWindow(
        sortModeRef.current === "value-desc"
          ? SORTED_TOTAL_ROWS
          : mode === "none"
            ? datasetRef.current.rowCount
            : FILTERED_TOTAL_ROWS[mode],
        columnCount,
        effectiveStart,
        effectiveCount,
        editsRef.current,
        mode,
        sortModeRef.current,
        datasetRef.current.generation,
      );
    };
    dataService.queryTableNavigationWindow = async (request) => {
      navigationRequestStartsByIdRef.current.set(request.requestId, request.start);
      setNavigationRequestStarts((previous) => [...previous, request.start]);
      setNavigationRequestSessionIds((previous) => [...previous, request.sessionId ?? "natural"]);
      const visibleCellTextAtRequest = rootRef.current
        ?.querySelector('[data-viewport-slot="0"] td[data-row][data-col] .sp-val')
        ?.textContent
        ?.trim() ?? null;
      setNavigationRequestObservations((previous) => [
        ...previous,
        {
          requestId: request.requestId,
          start: request.start,
          sessionId: request.sessionId ?? null,
          kind: request.requestId.startsWith("table-nav-prefetch:") ? "prefetch" : "active",
          visibleCellTextAtRequest,
          lastPaintedVisibleCellText: lastPaintedVisibleCellTextRef.current,
          afterPaintObserved: lastPaintedVisibleCellTextRef.current != null
            && visibleCellTextAtRequest != null
            && lastPaintedVisibleCellTextRef.current === visibleCellTextAtRequest,
        },
      ]);
      if (request.start > 0) {
        await new Promise<void>((resolve, reject) => {
          const timeout = window.setTimeout(() => {
            navigationCancellersRef.current.delete(request.requestId);
            resolve();
          }, WINDOW_DELAY_MS);
          if (rejectCancelledNavigation) {
            navigationCancellersRef.current.set(request.requestId, () => {
              window.clearTimeout(timeout);
              navigationCancellersRef.current.delete(request.requestId);
              reject(new Error(`Cancelled: table navigation request ${request.requestId} was cancelled`));
            });
          }
        });
      }
      const mode = request.sessionId?.includes("session-dv")
        ? "dv"
        : request.sessionId?.includes("session-ev")
          ? "ev"
          : resolveFilterModeFromRules(request.filters);
      const sortMode = request.sort?.column === "Column 2" && request.sort.descending
        ? "value-desc"
        : "natural";
      const result = buildNavigationWindow(
        request,
        columnCount,
        editsRef.current,
        sortMode === "value-desc"
          ? SORTED_TOTAL_ROWS
          : mode === "none"
            ? datasetRef.current.rowCount
            : FILTERED_TOTAL_ROWS[mode],
        mode,
        sortMode,
      );
      if (!request.requestId.startsWith("table-nav-prefetch:")) {
        setResolvedNavigationRequestStarts((previous) => [...previous, request.start]);
      }
      return result;
    };
    dataService.prepareTableQuerySession = async (request: TableQuerySessionRequest) => {
      if (request.generation !== datasetRef.current.generation) {
        throw new Error(
          `stale generation ${request.generation}; current generation is ${datasetRef.current.generation}`,
        );
      }
      const mode = resolveFilterModeFromRules(request.filters);
      const sortSuffix = request.sort?.column === "Column 2" && request.sort.descending
        ? "sort-desc"
        : mode;
      const sessionId = `session-${sortSuffix}-${request.columnIds.join("-") || "none"}`;
      if (!sessionReadyAtRef.current.has(sessionId)) {
        sessionReadyAtRef.current.set(sessionId, performance.now() + WINDOW_DELAY_MS);
      }
      setPreparedSessionIds((previous) => [...previous, sessionId]);
      const readyAt = sessionReadyAtRef.current.get(sessionId) ?? performance.now();
      const isReady = performance.now() >= readyAt;
      const totalRows = sessionId.includes("sort-desc")
        ? SORTED_TOTAL_ROWS
        : FILTERED_TOTAL_ROWS[mode];
      return {
        sessionId,
        state: isReady ? "ready" : "preparing",
        totalRows: isReady ? totalRows : null,
        progress: isReady ? 1 : 0,
      } satisfies TableQuerySessionStatus;
    };
    dataService.getTableQuerySessionStatus = async (sessionId: string) => {
      setSessionStatusCalls((previous) => [...previous, sessionId]);
      const mode = sessionId.includes("session-dv") ? "dv" : sessionId.includes("session-ev") ? "ev" : "none";
      await new Promise((resolve) => window.setTimeout(resolve, 10));
      const readyAt = sessionReadyAtRef.current.get(sessionId) ?? performance.now();
      const isReady = performance.now() >= readyAt;
      const totalRows = sessionId.includes("sort-desc")
        ? SORTED_TOTAL_ROWS
        : FILTERED_TOTAL_ROWS[mode];
      if (isReady) {
        setSessionExactCounts((previous) => [...previous, totalRows]);
      }
      return {
        sessionId,
        state: isReady ? "ready" : "preparing",
        totalRows: isReady ? totalRows : null,
        progress: isReady ? 1 : 0,
      } satisfies TableQuerySessionStatus;
    };
    dataService.releaseTableQuerySession = async (sessionId: string) => {
      setReleasedSessionIds((previous) => [...previous, sessionId]);
      sessionReadyAtRef.current.delete(sessionId);
    };
    dataService.cancelTableNavigationRequest = async (requestId) => {
      const cancelledStart = navigationRequestStartsByIdRef.current.get(requestId);
      if (cancelledStart != null) {
        setCancelledNavigationRequestStarts((previous) => [...previous, cancelledStart]);
      }
      navigationCancellersRef.current.get(requestId)?.();
    };
    dataService.getColumnDescriptors = async () => buildDescriptors(columnCount);
    dataService.getColumnDisplayProps = async () => [];
    dataService.updateCell = async (_datasetId, rowId, columnName, value) => {
      editsRef.current.set(`${rowId}:${columnName}`, value === "" ? null : value);
    };
    dataService.addRows = async (_datasetId, count, beforeRowId, expectedGeneration) => {
      setAddRowsRequests((previous) => [
        ...previous,
        { count, beforeRowId, expectedGeneration },
      ]);
      const safeCount = Math.max(1, count);
      const startRowId = datasetRef.current.rowCount + 1;
      const rowIds = Array.from({ length: safeCount }, (_, index) => startRowId + index);
      const nextRowCount = datasetRef.current.rowCount + safeCount;
      const nextDataset = createDataset(
        nextRowCount,
        columnCount,
        datasetRef.current.generation + 1,
      );
      datasetRef.current = nextDataset;
      setDataset(nextDataset);
      useDataStore.setState((current) => ({
        ...current,
        datasets: current.datasets.map((item) => item.id === nextDataset.id ? nextDataset : item),
      }));
      return {
        rowIds,
        generation: nextDataset.generation,
        rowCount: nextDataset.rowCount,
        changeSetId: `add-rows-${nextDataset.generation}`,
      };
    };
    dataService.addRow = async () => datasetRef.current.rowCount + 1;

    void i18n.changeLanguage("en").then(() => {
      if (active) setReady(true);
    });

    return () => {
      active = false;
      dataService.getDatasetGeneration = previousGetDatasetGeneration;
      dataService.queryTableWindow = previousQueryTableWindow;
      dataService.queryTableNavigationWindow = previousQueryTableNavigationWindow;
      dataService.prepareTableQuerySession = previousPrepareTableQuerySession;
      dataService.getTableQuerySessionStatus = previousGetTableQuerySessionStatus;
      dataService.releaseTableQuerySession = previousReleaseTableQuerySession;
      dataService.cancelTableNavigationRequest = previousCancelTableNavigationRequest;
      dataService.getColumnDescriptors = previousGetColumnDescriptors;
      dataService.getColumnDisplayProps = previousGetColumnDisplayProps;
      dataService.updateCell = previousUpdateCell;
      dataService.addRow = previousAddRow;
      dataService.addRows = previousAddRows;
      navigationCancellersRef.current.clear();
      navigationRequestStartsByIdRef.current.clear();
      useDataStore.setState(previousDataState, true);
      useDatasetFilterStore.setState(previousFilterState, true);
      useTableNavigationSortStore.setState(previousSortState, true);
      useProjectStore.setState(previousProjectState, true);
      useHistoryStore.setState(previousHistoryState, true);
      useTableZoomStore.setState({ zoom: previousZoom });
      void i18n.changeLanguage(previousLanguage);
    };
  }, [columnCount, rejectCancelledNavigation, rowCount, zoom]);

  useEffect(() => {
    if (!ready) return;
    useDatasetFilterStore.getState().replaceFilters(
      dataset.id,
      filterMode === "none" ? [] : FILTER_RULES[filterMode],
    );
  }, [dataset.id, filterMode, ready]);

  useEffect(() => {
    if (!ready) return;
    const sort: TableWindowSort | null = sortMode === "value-desc"
      ? { column: "Column 2", descending: true }
      : null;
    useTableNavigationSortStore.getState().replaceSort(dataset.id, sort);
  }, [dataset.id, ready, sortMode]);

  if (!ready) return null;

  return (
    <div ref={rootRef} style={{ width, height }}>
      <div data-testid="project-dirty">{dirty ? "true" : "false"}</div>
      <div data-testid="dataset-row-count">{dataset.rowCount}</div>
      <div data-testid="add-rows-requests">{JSON.stringify(addRowsRequests)}</div>
      <div data-testid="mutation-pending">{pendingAction ?? ""}</div>
      <div data-testid="nav-request-starts">{navigationRequestStarts.join(",")}</div>
      <div data-testid="nav-request-resolved-starts">{resolvedNavigationRequestStarts.join(",")}</div>
      <div data-testid="nav-request-cancelled-starts">{cancelledNavigationRequestStarts.join(",")}</div>
      <div data-testid="nav-request-session-ids">{navigationRequestSessionIds.join(",")}</div>
      <div data-testid="nav-request-observations">{JSON.stringify(navigationRequestObservations)}</div>
      <div data-testid="prepared-session-ids">{preparedSessionIds.join(",")}</div>
      <div data-testid="session-status-calls">{sessionStatusCalls.join(",")}</div>
      <div data-testid="session-exact-counts">{sessionExactCounts.join(",")}</div>
      <div data-testid="released-session-ids">{releasedSessionIds.join(",")}</div>
      <div data-testid="table-cache-diagnostics">{JSON.stringify(statusInfo?.tableCacheDiagnostics ?? null)}</div>
      <button type="button" data-testid="delay-next-window-load" onClick={() => { delayedWindowLoadsRef.current += 1; }}>Delay next window load</button>
      <button
        type="button"
        data-testid="reset-navigation-telemetry"
        onClick={() => {
          setNavigationRequestStarts([]);
          setResolvedNavigationRequestStarts([]);
          setNavigationRequestSessionIds([]);
          setNavigationRequestObservations([]);
        }}
      >Reset telemetry</button>
      <button type="button" data-testid="apply-ev-filter" onClick={() => setFilterMode("ev")}>EV</button>
      <button type="button" data-testid="apply-dv-filter" onClick={() => setFilterMode("dv")}>DV</button>
      <button type="button" data-testid="clear-filter" onClick={() => setFilterMode("none")}>Clear</button>
      <button type="button" data-testid="apply-sort-desc" onClick={() => setSortMode("value-desc")}>Sort desc</button>
      <button type="button" data-testid="clear-sort" onClick={() => setSortMode("natural")}>Sort clear</button>
      <button
        type="button"
        data-testid="advance-dataset-generation"
        onClick={() => {
          const nextDataset = createDataset(
            datasetRef.current.rowCount,
            columnCount,
            datasetRef.current.generation + 1,
          );
          datasetRef.current = nextDataset;
          setDataset(nextDataset);
          useDataStore.setState((current) => ({
            ...current,
            datasets: current.datasets.map((item) => item.id === nextDataset.id ? nextDataset : item),
          }));
        }}
      >Advance generation</button>
      <DataTableView datasetId={dataset.id} />
    </div>
  );
}