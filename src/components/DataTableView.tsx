import React, { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { dataService } from "@/services/dataService";
import type { TableQueryResult, ColumnDisplayProps } from "@/types/data";
import { useDataStore } from "@/stores/useDataStore";
import { useProjectStore } from "@/stores/useProjectStore";
import { useHistoryStore } from "@/stores/useHistoryStore";
import { modKey, shiftKey } from "@/utils/platform";
import { ctxMenuRef } from "@/utils/ctxMenu";

interface DataTableViewProps {
  datasetId: string;
}

const COLUMN_TYPES = [
  { value: "VARCHAR", label: "文本" },
  { value: "INTEGER", label: "整数" },
  { value: "BIGINT", label: "长整数" },
  { value: "DOUBLE", label: "小数" },
  { value: "BOOLEAN", label: "布尔" },
  { value: "DATE", label: "日期" },
  { value: "TIMESTAMP", label: "时间戳" },
];

const DEFAULT_COL_WIDTH = 120;
const ROW_HEIGHT = 27; // 26px cell height + 1px border
const OVERSCAN = 10; // extra rows above/below viewport

type FormatKind = "asis" | "fixed" | "percent" | "scientific" | "currency";

interface ColumnFormat {
  kind: FormatKind;
  decimals?: number;
  currency?: string;
}

const FORMAT_OPTIONS: { value: FormatKind; label: string }[] = [
  { value: "asis", label: "原样" },
  { value: "fixed", label: "固定位数" },
  { value: "percent", label: "百分比" },
  { value: "scientific", label: "科学计数" },
  { value: "currency", label: "货币" },
];

const CURRENCY_OPTIONS = [
  { value: "CNY", label: "CNY ¥", symbol: "¥" },
  { value: "USD", label: "USD $", symbol: "$" },
  { value: "EUR", label: "EUR €", symbol: "€" },
  { value: "GBP", label: "GBP £", symbol: "£" },
  { value: "JPY", label: "JPY ¥", symbol: "¥" },
  { value: "KRW", label: "KRW ₩", symbol: "₩" },
  { value: "HKD", label: "HKD HK$", symbol: "HK$" },
  { value: "TWD", label: "TWD NT$", symbol: "NT$" },
];

const DEFAULT_FORMAT: ColumnFormat = { kind: "asis" };

function formatCellValue(value: unknown, fmt: ColumnFormat): string {
  if (value == null) return "";
  if (fmt.kind === "asis") return String(value);
  const num = Number(value);
  if (isNaN(num)) return String(value);
  switch (fmt.kind) {
    case "fixed":
      return num.toFixed(fmt.decimals ?? 2);
    case "percent":
      return (num * 100).toFixed(fmt.decimals ?? 2) + "%";
    case "scientific":
      return num.toExponential();
    case "currency": {
      const cur = CURRENCY_OPTIONS.find(c => c.value === fmt.currency);
      const symbol = cur?.symbol ?? "";
      return symbol + num.toFixed(fmt.decimals ?? 2);
    }
    default:
      return String(value);
  }
}

interface CellRange {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

function normalizeRange(r: CellRange) {
  return {
    r1: Math.min(r.startRow, r.endRow),
    c1: Math.min(r.startCol, r.endCol),
    r2: Math.max(r.startRow, r.endRow),
    c2: Math.max(r.startCol, r.endCol),
  };
}

function inRange(row: number, col: number, range: CellRange | null): boolean {
  if (!range) return false;
  const { r1, c1, r2, c2 } = normalizeRange(range);
  return row >= r1 && row <= r2 && col >= c1 && col <= c2;
}

// ---- Memoized row component ----
interface TableRowProps {
  ri: number;
  displayRow: unknown[];
  colFormats: ColumnFormat[];
  isRowSelected: boolean;
  isRowActive: boolean;
  isRowSelectedHdr: boolean;
  activeCol: number | null;
  selectedCols: Set<number>;
  editRow: number | null;
  editCol: number | null;
  editValue: string;
  editInputRef: React.RefObject<HTMLInputElement | null>;
  selection: CellRange | null;
  onEditValueChange: (v: string) => void;
  onCommitEdit: (dir: "none" | "down" | "right" | "left") => void;
  onCancelEdit: () => void;
}

const TableRow = React.memo(function TableRow({
  ri, displayRow, colFormats, isRowSelected, isRowActive, isRowSelectedHdr,
  activeCol, selectedCols, editRow, editCol, editValue, editInputRef,
  selection, onEditValueChange, onCommitEdit, onCancelEdit,
}: TableRowProps) {
  const isEditing = editRow === ri;
  return (
    <tr className={isRowSelected ? "sp-row-selected" : ""}>
      <td
        className={`sp-row-hdr${isRowActive ? " sp-row-active" : ""}${isRowSelectedHdr ? " sp-row-selected-hdr" : ""}`}
        data-row-hdr={ri}
      >
        {ri + 1}
      </td>
      {displayRow.map((cell, ci) => {
        const isColSelected = selectedCols.has(ci);
        const isCellActive = activeCol === ci && isRowActive && !isRowSelected && !isColSelected;
        const isCellEditing = isEditing && editCol === ci;
        const isCellSelected = inRange(ri, ci, selection);
        return (
          <td
            key={ci}
            data-row={ri}
            data-col={ci}
            className={`sp-cell${isCellActive ? " sp-cell-active" : ""}${isCellEditing ? " sp-cell-editing" : ""}${isCellSelected ? " sp-cell-selected" : ""}${isColSelected ? " sp-col-selected-cell" : ""}`}
          >
            <span className={cell == null ? "sp-null" : "sp-val"} style={isCellEditing ? { visibility: "hidden" } : undefined}>
              {formatCellValue(cell, colFormats[ci] ?? DEFAULT_FORMAT)}
            </span>
            {isCellEditing && (
              <input
                ref={editInputRef}
                className="sp-cell-input"
                value={editValue}
                onChange={(e) => onEditValueChange(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                onMouseDown={(e) => e.stopPropagation()}
                onDoubleClick={(e) => e.stopPropagation()}
                onBlur={() => onCommitEdit("none")}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    onCommitEdit("down");
                  } else if (e.key === "Escape") {
                    onCancelEdit();
                  } else if (e.key === "Tab") {
                    e.preventDefault();
                    onCommitEdit(e.shiftKey ? "left" : "right");
                  }
                  e.stopPropagation();
                }}
              />
            )}
          </td>
        );
      })}
      <td className="sp-add-col-cell" />
    </tr>
  );
});

export function DataTableView({ datasetId }: DataTableViewProps) {
  const [data, setData] = useState<TableQueryResult | null>(null);
  const [activeCell, setActiveCell] = useState<{ row: number; col: number } | null>(null);
  const [editCell, setEditCell] = useState<{ row: number; col: number } | null>(null);
  const [editValue, setEditValue] = useState("");
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set());
  const [selectedCols, setSelectedCols] = useState<Set<number>>(new Set());
  const [colMenu, setColMenu] = useState<{ colIdx: number; x: number; y: number } | null>(null);
  const [rowMenu, setRowMenu] = useState<{ rowIdx: number; x: number; y: number } | null>(null);
  const [showAddCol, setShowAddCol] = useState(false);
  const [newColName, setNewColName] = useState("");
  const [newColType, setNewColType] = useState("VARCHAR");
  const [renameCol, setRenameCol] = useState<{ colIdx: number; oldName: string; oldType: string } | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renameType, setRenameType] = useState("");
  const [renameWidth, setRenameWidth] = useState("");
  const [renameFormat, setRenameFormat] = useState<ColumnFormat>(DEFAULT_FORMAT);
  const [batchColProps, setBatchColProps] = useState<{ colIndices: number[]; checkedCols: Set<number> } | null>(null);
  const [batchColType, setBatchColType] = useState("VARCHAR");
  const [batchColWidth, setBatchColWidth] = useState("");
  const [batchColFormat, setBatchColFormat] = useState<ColumnFormat>(DEFAULT_FORMAT);
  const [showInsertMultiRows, setShowInsertMultiRows] = useState(false);
  const [insertRowCount, setInsertRowCount] = useState("5");
  const [showInsertMultiCols, setShowInsertMultiCols] = useState(false);
  const [insertColCount, setInsertColCount] = useState("3");
  const [insertColType, setInsertColType] = useState("VARCHAR");
  const [colWidths, setColWidths] = useState<number[]>([]);
  const [colFormats, setColFormats] = useState<ColumnFormat[]>([]);
  const colFormatsRef = useRef<ColumnFormat[]>([]);
  colFormatsRef.current = colFormats;
  const [selection, setSelection] = useState<CellRange | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const editInputRef = useRef<HTMLInputElement>(null);
  const addColInputRef = useRef<HTMLInputElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const tableRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const resizingRef = useRef<{ colIdx: number; startX: number; startW: number } | null>(null);
  const isDraggingRef = useRef(false);
  const didDragRef = useRef(false);
  const isDraggingRowRef = useRef(false);
  const isDraggingColRef = useRef(false);
  const didDragColRef = useRef(false);
  const didDragRowRef = useRef(false);
  const rowAnchorRef = useRef<number | null>(null);
  const colAnchorRef = useRef<number | null>(null);
  const suppressSelectionRef = useRef(false);
  const [isDragging, setIsDragging] = useState(false);
  const tabAnchorColRef = useRef<number | null>(null);
  const [cellMenu, setCellMenu] = useState<{ row: number; col: number; x: number; y: number } | null>(null);
  const [cornerMenu, setCornerMenu] = useState<{ x: number; y: number } | null>(null);
  const [cornerSelected, setCornerSelected] = useState(false);
  const autoScrollRef = useRef<number | null>(null);

  // Column filter state
  type DiscreteFilter = { kind: "discrete"; selected: Set<string> };
  type RangeFilter = { kind: "range"; min: string; max: string };
  type ColumnFilterState = DiscreteFilter | RangeFilter;
  const [columnFilters, setColumnFilters] = useState<Map<number, ColumnFilterState>>(new Map());
  const [filterPopover, setFilterPopover] = useState<{ colIdx: number; anchorRect: DOMRect } | null>(null);
  const [filterWorkingSet, setFilterWorkingSet] = useState<Set<string>>(new Set());
  const [filterRangeMin, setFilterRangeMin] = useState("");
  const [filterRangeMax, setFilterRangeMax] = useState("");
  const filterLastClickRef = useRef<number>(-1);

  interface UndoSnapshot {
    data: TableQueryResult;
    colWidths: number[];
    colFormats: ColumnFormat[];
  }
  const undoStackRef = useRef<UndoSnapshot[]>([]);
  const redoStackRef = useRef<UndoSnapshot[]>([]);
  const MAX_UNDO = 50;
  const { refreshDatasets, setStatusInfo } = useDataStore();
  const { markDirty } = useProjectStore();
  const { record: recordHistory } = useHistoryStore();

  const refreshAndMarkDirty = useCallback(async () => {
    await refreshDatasets();
    markDirty();
  }, [refreshDatasets, markDirty]);

  // Debounced history recording for batching rapid edits
  const historyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recordAction = useCallback((description: string, immediate = false) => {
    if (historyTimerRef.current) {
      clearTimeout(historyTimerRef.current);
      historyTimerRef.current = null;
    }
    if (immediate) {
      recordHistory(description);
    } else {
      historyTimerRef.current = setTimeout(() => {
        recordHistory(description);
        historyTimerRef.current = null;
      }, 300);
    }
  }, [recordHistory]);

  const load = useCallback(async () => {
    try {
      const result = await dataService.queryTable({
        datasetId,
        page: 0,
        pageSize: 10000,
      });
      setData(result);
      // Load saved display props
      try {
        const props = await dataService.getColumnDisplayProps(datasetId);
        if (props.length > 0) {
          const visCount = result.columns.filter(c => c !== "_row_id").length;
          const widths = Array.from({ length: visCount }, (_, i) => {
            const p = props.find(dp => dp.colIndex === i);
            return p?.width ?? DEFAULT_COL_WIDTH;
          });
          setColWidths(widths);
          const formats = Array.from({ length: visCount }, (_, i) => {
            const p = props.find(dp => dp.colIndex === i);
            return p?.format ? { kind: p.format.kind as FormatKind, decimals: p.format.decimals, currency: p.format.currency } : DEFAULT_FORMAT;
          });
          setColFormats(formats);
        }
      } catch { /* ignore display prop load errors */ }
    } catch (e) {
      console.error("Failed to load table:", e);
      setData({ columns: [], columnTypes: [], rows: [], totalRows: 0, page: 0, pageSize: 10000 });
    }
  }, [datasetId]);

  /** Save current display props to backend */
  const syncDisplayProps = useCallback(async (widths: number[], formats: ColumnFormat[]) => {
    const props: ColumnDisplayProps[] = [];
    const len = Math.max(widths.length, formats.length);
    for (let i = 0; i < len; i++) {
      const w = widths[i];
      const f = formats[i];
      const hasWidth = w !== undefined && w !== DEFAULT_COL_WIDTH;
      const hasFormat = f !== undefined && f.kind !== "asis";
      if (hasWidth || hasFormat) {
        props.push({
          colIndex: i,
          width: hasWidth ? w : undefined,
          format: hasFormat ? { kind: f.kind, decimals: f.decimals, currency: f.currency } : undefined,
        });
      }
    }
    try {
      await dataService.setColumnDisplayProps(datasetId, props);
    } catch { /* ignore */ }
  }, [datasetId]);

  useEffect(() => {
    load();
    setActiveCell(null);
    setEditCell(null);
    setSelectedRows(new Set());
    setSelectedCols(new Set());
    setSelection(null);
    setColMenu(null);
    setRowMenu(null);
    setBatchColProps(null);
    setShowInsertMultiRows(false);
    setShowInsertMultiCols(false);
    setRenameCol(null);
    setShowAddCol(false);
    setColumnFilters(new Map());
    setFilterPopover(null);
    undoStackRef.current = [];
    redoStackRef.current = [];
  }, [datasetId, load]);

  // Auto-scroll to keep activeCell visible (virtual scrolling)
  useEffect(() => {
    if (!activeCell || !tableRef.current) return;
    const wrapper = tableRef.current;
    const headerH = 48;
    const rowTop = activeCell.row * ROW_HEIGHT + headerH;
    const rowBottom = rowTop + ROW_HEIGHT;
    const viewTop = wrapper.scrollTop;
    const viewBottom = viewTop + wrapper.clientHeight;
    if (rowTop < viewTop + headerH) {
      wrapper.scrollTop = rowTop - headerH;
    } else if (rowBottom > viewBottom) {
      wrapper.scrollTop = rowBottom - wrapper.clientHeight;
    }
  }, [activeCell]);

  useEffect(() => {
    if (editCell && editInputRef.current) {
      editInputRef.current.focus();
      const len = editInputRef.current.value.length;
      editInputRef.current.setSelectionRange(len, len);
    }
  }, [editCell]);

  useEffect(() => {
    if (showAddCol && addColInputRef.current) {
      addColInputRef.current.focus();
    }
  }, [showAddCol]);

  useEffect(() => {
    if (renameCol && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renameCol]);

  // Auto-dismiss error toast
  useEffect(() => {
    if (errorMsg) {
      const timer = setTimeout(() => setErrorMsg(null), 4000);
      return () => clearTimeout(timer);
    }
  }, [errorMsg]);

  // Check if selection changes should be suppressed (menu open or resize just finished)
  const hasMenuOpen = () => !!(colMenu || rowMenu || cellMenu || cornerMenu);

  // Close menus on outside click
  useEffect(() => {
    const handler = () => {
      // If a menu is open, suppress the next selection change from this same click
      if (colMenu || rowMenu || cellMenu || cornerMenu) {
        suppressSelectionRef.current = true;
        requestAnimationFrame(() => { suppressSelectionRef.current = false; });
      }
      setColMenu(null); setRowMenu(null); setCellMenu(null); setCornerMenu(null);
    };
    document.addEventListener("click", handler);
    return () => document.removeEventListener("click", handler);
  }, [colMenu, rowMenu, cellMenu, cornerMenu]);

  // Initialize colWidths and colFormats when columns change
  const visibleColCount = data ? data.columns.filter(c => c !== "_row_id").length : 0;
  useEffect(() => {
    setColWidths((prev) => {
      if (prev.length === visibleColCount) return prev;
      return Array.from({ length: visibleColCount }, (_, i) => prev[i] ?? DEFAULT_COL_WIDTH);
    });
    setColFormats((prev) => {
      if (prev.length === visibleColCount) return prev;
      return Array.from({ length: visibleColCount }, (_, i) => prev[i] ?? DEFAULT_FORMAT);
    });
  }, [visibleColCount]);

  // Excel-style column letter (A, B, C, ... Z, AA, AB, ...)
  const colLetter = (i: number): string => {
    let s = "";
    let n = i;
    while (n >= 0) {
      s = String.fromCharCode(65 + (n % 26)) + s;
      n = Math.floor(n / 26) - 1;
    }
    return s;
  };

  // Filter _row_id from display — memoized (must be before early return for hooks rules)
  const rowIdIdx = data ? data.columns.indexOf("_row_id") : -1;
  const cols = useMemo(() => data ? data.columns.filter((_, i) => i !== rowIdIdx) : [], [data, rowIdIdx]);
  const colTypes = useMemo(() => data ? data.columnTypes.filter((_, i) => i !== rowIdIdx) : [], [data, rowIdIdx]);

  // Clear filters when column count changes (add/delete column shifts indices)
  const prevColCountRef = useRef<number>(0);
  useEffect(() => {
    if (prevColCountRef.current > 0 && cols.length !== prevColCountRef.current) {
      setColumnFilters(new Map());
      setFilterPopover(null);
    }
    prevColCountRef.current = cols.length;
  }, [cols.length]);

  // All rows stripped of _row_id (used by filter popover for unique values)
  const allRows = useMemo(() =>
    data ? data.rows.map((raw) => (raw as unknown[]).filter((_, i) => i !== rowIdIdx)) : [],
    [data, rowIdIdx]
  );

  // Filtered display rows + index mapping back to data.rows indices
  const { displayRows, displayIdxMap } = useMemo(() => {
    if (columnFilters.size === 0) return { displayRows: allRows, displayIdxMap: null as number[] | null };
    const rows: unknown[][] = [];
    const map: number[] = [];
    allRows.forEach((row, i) => {
      for (const [ci, filter] of columnFilters) {
        const val = row[ci];
        const str = val == null ? "" : String(val);
        if (filter.kind === "discrete") {
          if (!filter.selected.has(str)) return;
        } else {
          const num = val == null ? NaN : Number(val);
          if (filter.min !== "" && !isNaN(Number(filter.min)) && (isNaN(num) || num < Number(filter.min))) return;
          if (filter.max !== "" && !isNaN(Number(filter.max)) && (isNaN(num) || num > Number(filter.max))) return;
        }
      }
      rows.push(row);
      map.push(i);
    });
    return { displayRows: rows, displayIdxMap: map };
  }, [allRows, columnFilters]);

  // Convert visible row index to data.rows index (for _row_id lookup)
  const toDataIdx = useCallback((vi: number): number =>
    displayIdxMap ? displayIdxMap[vi] : vi,
    [displayIdxMap]);

  // Unique values for discrete filter popover (from unfiltered data)
  const filterUniqueValues = useMemo(() => {
    if (!filterPopover) return [];
    const ci = filterPopover.colIdx;
    const valSet = new Set<string>();
    allRows.forEach(row => {
      valSet.add(row[ci] == null ? "" : String(row[ci]));
    });
    return Array.from(valSet).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }, [filterPopover?.colIdx, allRows]);

  // Initialize filter working state when popover opens
  useEffect(() => {
    if (!filterPopover) return;
    const ci = filterPopover.colIdx;
    const colType = colTypes[ci];
    const existing = columnFilters.get(ci);
    if (colType !== "DOUBLE") {
      if (existing?.kind === "discrete") {
        setFilterWorkingSet(new Set(existing.selected));
      } else {
        const values = new Set(allRows.map(row => row[ci] == null ? "" : String(row[ci])));
        setFilterWorkingSet(values);
      }
    } else {
      if (existing?.kind === "range") {
        setFilterRangeMin(existing.min);
        setFilterRangeMax(existing.max);
      } else {
        setFilterRangeMin("");
        setFilterRangeMax("");
      }
    }
    filterLastClickRef.current = -1;
  }, [filterPopover?.colIdx]);

  // Sync status info to global status bar
  useEffect(() => {
    if (!data) { setStatusInfo(null); return; }

    // Build selection label
    let selLabel = "";
    if (selection) {
      const { r1, c1, r2, c2 } = normalizeRange(selection);
      if (r1 === r2 && c1 === c2) {
        selLabel = `${colLetter(c1)}${r1 + 1}`;
      } else {
        selLabel = `${colLetter(c1)}${r1 + 1}:${colLetter(c2)}${r2 + 1}`;
      }
    } else if (selectedRows.size > 0) {
      const rows = Array.from(selectedRows).sort((a, b) => a - b);
      selLabel = rows.map((r) => String(r + 1)).join(",");
    } else if (selectedCols.size > 0) {
      const sortedCols = Array.from(selectedCols).sort((a, b) => a - b);
      selLabel = sortedCols.map((c) => colLetter(c)).join(",");
    }

    // Compute selection statistics
    let selectionStats: { count: number; sum?: number; avg?: number; min?: number; max?: number } | undefined;
    const collectValues = (): unknown[] => {
      const vals: unknown[] = [];
      if (selection) {
        const { r1, c1, r2, c2 } = normalizeRange(selection);
        if (r1 !== r2 || c1 !== c2) {
          for (let r = r1; r <= r2; r++)
            for (let c = c1; c <= c2; c++)
              vals.push(displayRows[r]?.[c]);
        }
      } else if (selectedRows.size > 0) {
        const colCount = cols.length;
        for (const ri of selectedRows)
          for (let c = 0; c < colCount; c++)
            vals.push(displayRows[ri]?.[c]);
      } else if (selectedCols.size > 0) {
        for (let r = 0; r < displayRows.length; r++)
          for (const ci of selectedCols)
            vals.push(displayRows[r]?.[ci]);
      }
      return vals;
    };

    const vals = collectValues();
    if (vals.length > 0) {
      const nonNull = vals.filter(v => v != null);
      const nums = nonNull.map(v => Number(v)).filter(n => !isNaN(n));
      if (nums.length > 0 && nums.length === nonNull.length) {
        const sum = nums.reduce((a, b) => a + b, 0);
        selectionStats = {
          count: nonNull.length,
          sum,
          avg: sum / nums.length,
          min: Math.min(...nums),
          max: Math.max(...nums),
        };
      } else {
        selectionStats = { count: nonNull.length };
      }
    }

    setStatusInfo({
      cellLabel: activeCell ? `${colLetter(activeCell.col)}${activeCell.row + 1}` : "",
      selectionLabel: selLabel,
      dimensions: columnFilters.size > 0 ? `${displayRows.length} / ${data.totalRows} 行 × ${visibleColCount} 列` : `${data.totalRows} 行 × ${visibleColCount} 列`,
      selectionStats,
    });
  }, [activeCell, selection, selectedRows, selectedCols, data, displayRows, cols, visibleColCount, setStatusInfo, columnFilters]);

  // Precompute active row/col ranges for className computation
  const activeRowRange = useMemo(() => {
    const set = new Set<number>();
    if (activeCell) set.add(activeCell.row);
    if (selection) {
      const { r1, r2 } = normalizeRange(selection);
      for (let i = r1; i <= r2; i++) set.add(i);
    }
    return set;
  }, [activeCell, selection]);

  const activeColRange = useMemo(() => {
    const set = new Set<number>();
    if (activeCell) set.add(activeCell.col);
    if (selection) {
      const { c1, c2 } = normalizeRange(selection);
      for (let i = c1; i <= c2; i++) set.add(i);
    }
    return set;
  }, [activeCell, selection]);

  // Virtual scrolling: compute visible row range
  const wrapperHeight = tableRef.current?.clientHeight ?? 600;
  const headerHeight = 48; // approximate sticky header height
  const visibleAreaHeight = wrapperHeight - headerHeight;
  const totalRowCount = displayRows.length;
  const virtualRange = useMemo(() => {
    const startIdx = Math.max(0, Math.floor((scrollTop - headerHeight) / ROW_HEIGHT) - OVERSCAN);
    const visibleCount = Math.ceil(visibleAreaHeight / ROW_HEIGHT) + 2 * OVERSCAN;
    const endIdx = Math.min(totalRowCount, startIdx + visibleCount);
    return { startIdx, endIdx };
  }, [scrollTop, totalRowCount, visibleAreaHeight, headerHeight]);

  if (!data) return <div className="sp-loading">加载中...</div>;

  const getRowId = (row: unknown[]): number =>
    rowIdIdx >= 0 ? (row[rowIdIdx] as number) : 0;

  const getDisplayRow = (row: unknown[]): unknown[] =>
    (row as unknown[]).filter((_, i) => i !== rowIdIdx);

  // ---- Auto-generate column name ----
  const generateColName = (existingNames: string[]): string => {
    const nameSet = new Set(existingNames);
    let i = 1;
    while (nameSet.has(`列${i}`)) i++;
    return `列${i}`;
  };

  // ---- Undo / Redo ----
  const saveSnapshot = () => {
    if (!data) return;
    undoStackRef.current.push({
      data: structuredClone(data),
      colWidths: [...colWidths],
      colFormats: colFormats.map(f => ({ ...f })),
    });
    if (undoStackRef.current.length > MAX_UNDO) {
      undoStackRef.current.shift();
    }
    redoStackRef.current = [];
  };

  const restoreFromSnapshot = async (snapshot: UndoSnapshot) => {
    // Extract col info (skip _row_id)
    const rowIdIdx = snapshot.data.columns.indexOf("_row_id");
    const colNames = snapshot.data.columns.filter((_, i) => i !== rowIdIdx);
    const colTypesSnap = snapshot.data.columnTypes.filter((_, i) => i !== rowIdIdx);
    const rows = snapshot.data.rows;

    try {
      await dataService.restoreSnapshot(datasetId, colNames, colTypesSnap, rows);
      // Sync display props to backend first (so load() picks them up)
      await syncDisplayProps(snapshot.colWidths, snapshot.colFormats);
      await load();
      // Restore display props after load (override what load() set)
      setColWidths(snapshot.colWidths);
      setColFormats(snapshot.colFormats);
      await refreshAndMarkDirty();
    } catch (e) {
      setErrorMsg(String(e));
    }
  };

  const handleUndo = async () => {
    if (undoStackRef.current.length === 0) return;
    const snapshot = undoStackRef.current.pop()!;
    if (data) {
      redoStackRef.current.push({
        data: structuredClone(data),
        colWidths: [...colWidths],
        colFormats: colFormats.map(f => ({ ...f })),
      });
    }
    await restoreFromSnapshot(snapshot);
  };

  const handleRedo = async () => {
    if (redoStackRef.current.length === 0) return;
    const snapshot = redoStackRef.current.pop()!;
    if (data) {
      undoStackRef.current.push({
        data: structuredClone(data),
        colWidths: [...colWidths],
        colFormats: colFormats.map(f => ({ ...f })),
      });
    }
    await restoreFromSnapshot(snapshot);
  };

  // ---- Row operations ----
  const handleAddRow = async () => {
    saveSnapshot();
    await dataService.addRow(datasetId);
    await load();
    await refreshAndMarkDirty();
    recordAction("添加行", true);
  };

  const handleInsertMultiRows = async () => {
    const count = parseInt(insertRowCount, 10);
    if (isNaN(count) || count < 1) return;
    saveSnapshot();
    for (let i = 0; i < count; i++) {
      await dataService.addRow(datasetId);
    }
    setShowInsertMultiRows(false);
    setInsertRowCount("5");
    await load();
    await refreshAndMarkDirty();
    recordAction("批量添加行", true);
  };

  const handleDeleteRows = async () => {
    if (selectedRows.size === 0) return;
    saveSnapshot();
    for (const rowIdx of selectedRows) {
      const row = data.rows[toDataIdx(rowIdx)] as unknown[];
      if (row) await dataService.deleteRow(datasetId, getRowId(row));
    }
    setSelectedRows(new Set());
    setRowMenu(null);
    await load();
    await refreshAndMarkDirty();
    recordAction("删除行", true);
  };

  const handleDeleteSingleRow = async (rowIdx: number) => {
    saveSnapshot();
    const row = data.rows[toDataIdx(rowIdx)] as unknown[];
    await dataService.deleteRow(datasetId, getRowId(row));
    setRowMenu(null);
    await load();
    await refreshAndMarkDirty();
    recordAction("删除行", true);
  };

  const handleInsertRowAbove = async () => {
    saveSnapshot();
    await dataService.addRow(datasetId);
    setRowMenu(null);
    await load();
    await refreshAndMarkDirty();
    recordAction("插入行", true);
  };

  // ---- Column operations ----
  const handleAddColumnQuick = async () => {
    saveSnapshot();
    const name = generateColName(cols);
    await dataService.addColumn(datasetId, name, "VARCHAR");
    await load();
    await refreshAndMarkDirty();
    recordAction("添加列", true);
  };

  const handleAddColumn = async () => {
    const name = newColName.trim();
    if (!name) return;
    saveSnapshot();
    await dataService.addColumn(datasetId, name, newColType);
    setShowAddCol(false);
    setNewColName("");
    setNewColType("VARCHAR");
    await load();
    await refreshAndMarkDirty();
    recordAction(`添加列 "${name}"`, true);
  };

  const handleInsertMultiCols = async () => {
    const count = parseInt(insertColCount, 10);
    if (isNaN(count) || count < 1) return;
    saveSnapshot();
    const currentNames = [...cols];
    for (let i = 0; i < count; i++) {
      const name = generateColName(currentNames);
      currentNames.push(name);
      await dataService.addColumn(datasetId, name, insertColType);
    }
    setShowInsertMultiCols(false);
    setInsertColCount("3");
    setInsertColType("VARCHAR");
    await load();
    await refreshAndMarkDirty();
    recordAction("批量添加列", true);
  };

  const handleDeleteColumn = async (colName: string) => {
    if (cols.length <= 1) return;
    saveSnapshot();
    await dataService.deleteColumn(datasetId, colName);
    setColMenu(null);
    await load();
    await refreshAndMarkDirty();
    recordAction(`删除列 "${colName}"`, true);
  };

  const handleDeleteSelectedCols = async () => {
    if (selectedCols.size === 0) return;
    if (cols.length - selectedCols.size < 1) {
      setErrorMsg("不能删除所有列，至少保留一列");
      setColMenu(null);
      return;
    }
    saveSnapshot();
    for (const ci of selectedCols) {
      await dataService.deleteColumn(datasetId, cols[ci]);
    }
    setSelectedCols(new Set());
    setColMenu(null);
    await load();
    await refreshAndMarkDirty();
    recordAction("删除列", true);
  };

  const handleStartRenameCol = (colIdx: number) => {
    setRenameCol({ colIdx, oldName: cols[colIdx], oldType: colTypes[colIdx] });
    setRenameValue(cols[colIdx]);
    setRenameType(colTypes[colIdx]);
    setRenameWidth(String(Math.round(colWidths[colIdx] ?? DEFAULT_COL_WIDTH)));
    setRenameFormat(colFormats[colIdx] ?? DEFAULT_FORMAT);
    setColMenu(null);
  };

  const handleStartBatchColProps = () => {
    const indices = Array.from(selectedCols).sort((a, b) => a - b);
    if (indices.length === 0) return;
    setBatchColProps({ colIndices: indices, checkedCols: new Set(indices) });
    setBatchColType(colTypes[indices[0]] || "VARCHAR");
    setBatchColWidth(String(Math.round(colWidths[indices[0]] ?? DEFAULT_COL_WIDTH)));
    setBatchColFormat(colFormats[indices[0]] ?? DEFAULT_FORMAT);
    setColMenu(null);
  };

  const handleApplyBatchColProps = async () => {
    if (!batchColProps) return;
    saveSnapshot();
    // Apply column widths
    const newW = Math.max(DEFAULT_COL_WIDTH, Math.round(Number(batchColWidth) || DEFAULT_COL_WIDTH));
    const newWidths = [...colWidths];
    for (const ci of batchColProps.checkedCols) {
      newWidths[ci] = newW;
    }
    setColWidths(newWidths);
    // Apply column formats
    const newFormats = [...colFormats];
    for (const ci of batchColProps.checkedCols) {
      newFormats[ci] = { ...batchColFormat };
    }
    setColFormats(newFormats);
    // Sync display props to backend
    syncDisplayProps(newWidths, newFormats);
    markDirty();
    try {
      for (const ci of batchColProps.checkedCols) {
        if (colTypes[ci] !== batchColType) {
          await dataService.changeColumnType(datasetId, cols[ci], batchColType);
        }
      }
      await load();
      await refreshAndMarkDirty();
      setBatchColProps(null);
      recordAction("修改列属性", true);
    } catch (e) {
      setErrorMsg(String(e));
    }
  };

  const handleRenameColumn = async () => {
    if (!renameCol || !renameValue.trim()) return;
    saveSnapshot();
    const nameChanged = renameValue.trim() !== renameCol.oldName;
    const typeChanged = renameType !== renameCol.oldType;
    // Apply column width
    const newW = Math.max(DEFAULT_COL_WIDTH, Math.round(Number(renameWidth) || DEFAULT_COL_WIDTH));
    const newWidths = [...colWidths];
    newWidths[renameCol.colIdx] = newW;
    setColWidths(newWidths);
    // Apply column format
    const newFormats = [...colFormats];
    newFormats[renameCol.colIdx] = { ...renameFormat };
    setColFormats(newFormats);
    // Sync display props to backend
    syncDisplayProps(newWidths, newFormats);
    markDirty();
    try {
      if (nameChanged) {
        await dataService.renameColumn(datasetId, renameCol.oldName, renameValue.trim());
      }
      if (typeChanged) {
        const colName = nameChanged ? renameValue.trim() : renameCol.oldName;
        await dataService.changeColumnType(datasetId, colName, renameType);
      }
      if (nameChanged || typeChanged) {
        await load();
        await refreshAndMarkDirty();
      }
      setRenameCol(null);
      recordAction("修改列属性", true);
    } catch (e) {
      setErrorMsg(String(e));
    }
  };

  // ---- Cell operations ----
  const handleCellClick = (row: number, col: number, e?: React.MouseEvent) => {
    // If a drag just finished, don't override selection
    if (didDragRef.current) {
      didDragRef.current = false;
      return;
    }
    // If a menu was just dismissed or resize just finished, don't change selection
    if (suppressSelectionRef.current || hasMenuOpen()) return;
    if (e && (e.shiftKey) && activeCell) {
      // Shift+click extends/creates selection from activeCell to clicked cell
      setSelection({
        startRow: activeCell.row,
        startCol: activeCell.col,
        endRow: row,
        endCol: col,
      });
    } else {
      setActiveCell({ row, col });
      setSelection(null);
    }
    setEditCell(null);
    setSelectedRows(new Set());
    setSelectedCols(new Set());
    setColMenu(null);
    setRowMenu(null);
    setCornerSelected(false);
    // Focus the container so keyboard events fire
    containerRef.current?.focus();
  };

  const handleCellDoubleClick = (row: number, col: number, value: unknown) => {
    setActiveCell({ row, col });
    setEditCell({ row, col });
    setEditValue(value == null ? "" : String(value));
  };

  // ---- Cell value validation ----
  const validateCellValue = (value: string, colType: string): string | null => {
    if (value === "") return null; // Empty is always ok (NULL)
    switch (colType) {
      case "INTEGER": {
        if (!/^-?\d+$/.test(value.trim())) return `"${value}" 不是有效的整数`;
        return null;
      }
      case "DOUBLE": {
        if (isNaN(Number(value.trim())) || value.trim() === "") return `"${value}" 不是有效的数字`;
        return null;
      }
      case "BOOLEAN": {
        const v = value.trim().toLowerCase();
        if (!["true", "false", "1", "0", "yes", "no"].includes(v)) return `"${value}" 不是有效的布尔值（可输入 true/false/1/0）`;
        return null;
      }
      case "DATE": {
        if (isNaN(Date.parse(value.trim()))) return `"${value}" 不是有效的日期格式`;
        return null;
      }
      case "TIMESTAMP": {
        if (isNaN(Date.parse(value.trim()))) return `"${value}" 不是有效的时间戳格式`;
        return null;
      }
      default:
        return null; // VARCHAR etc. accepts anything
    }
  };

  const commitEdit = async (direction: "none" | "down" | "right" | "left" = "none") => {
    if (!editCell) return;
    const { row: editRow, col: editCol } = editCell;
    const colType = colTypes[editCol];
    const err = validateCellValue(editValue, colType);
    if (err) {
      setErrorMsg(err);
      return; // Don't commit, keep editing
    }
    setEditCell(null);
    const row = data.rows[toDataIdx(editRow)] as unknown[];
    const rowId = getRowId(row);
    const colName = cols[editCol];
    saveSnapshot();
    try {
      await dataService.updateCell(datasetId, rowId, colName, editValue);
    } catch (e) {
      setErrorMsg(String(e));
    }
    await load();
    markDirty();
    recordAction("编辑单元格");

    const maxRow = displayRows.length - 1;
    const maxCol = cols.length - 1;
    if (direction === "down") {
      // Enter: move down; if Tab anchor exists, return to that column
      const nextRow = Math.min(editRow + 1, maxRow);
      const nextCol = tabAnchorColRef.current != null ? tabAnchorColRef.current : editCol;
      tabAnchorColRef.current = null;
      setActiveCell({ row: nextRow, col: nextCol });
    } else if (direction === "right") {
      // Tab: move right; record anchor if first Tab in sequence
      if (tabAnchorColRef.current == null) tabAnchorColRef.current = editCol;
      if (editCol < maxCol) {
        setActiveCell({ row: editRow, col: editCol + 1 });
      } else if (editRow < maxRow) {
        setActiveCell({ row: editRow + 1, col: 0 });
      }
    } else if (direction === "left") {
      // Shift+Tab: move left
      if (editCol > 0) {
        setActiveCell({ row: editRow, col: editCol - 1 });
      } else if (editRow > 0) {
        setActiveCell({ row: editRow - 1, col: maxCol });
      }
    }
    // direction === "none": stay in place (blur)
    containerRef.current?.focus();
  };

  const cancelEdit = () => {
    setEditCell(null);
    tabAnchorColRef.current = null;
    containerRef.current?.focus();
  };

  // ---- Clear cells (Delete key) ----
  const clearCells = async (cells: { row: number; col: number }[]) => {
    saveSnapshot();
    try {
      for (const { row, col } of cells) {
        const rawRow = data.rows[toDataIdx(row)] as unknown[];
        const rowId = getRowId(rawRow);
        const colName = cols[col];
        await dataService.updateCell(datasetId, rowId, colName, "");
      }
    } catch (e) {
      setErrorMsg(String(e));
    }
    await load();
    markDirty();
    recordAction("清除单元格内容", true);
  };

  // ---- Helper: find boundary of continuous data (Excel Ctrl+Arrow behavior) ----
  const findEdge = (row: number, col: number, dRow: number, dCol: number): { row: number; col: number } => {
    const maxRow = displayRows.length - 1;
    const maxCol = cols.length - 1;
    const getCellVal = (r: number, c: number): unknown => {
      return displayRows[r]?.[c];
    };
    const currentVal = getCellVal(row, col);
    const currentEmpty = currentVal == null || currentVal === "";
    let r = row + dRow;
    let c = col + dCol;

    if (currentEmpty) {
      // Jump to next non-empty cell, or to the edge
      while (r >= 0 && r <= maxRow && c >= 0 && c <= maxCol) {
        const v = getCellVal(r, c);
        if (v != null && v !== "") return { row: r, col: c };
        r += dRow;
        c += dCol;
      }
      // Reached edge without finding data
      return { row: Math.max(0, Math.min(r - dRow, maxRow)), col: Math.max(0, Math.min(c - dCol, maxCol)) };
    } else {
      // Jump to last non-empty cell in this direction, or if next is empty, jump to next non-empty or edge
      const nextR = row + dRow;
      const nextC = col + dCol;
      if (nextR < 0 || nextR > maxRow || nextC < 0 || nextC > maxCol) return { row, col };
      const nextVal = getCellVal(nextR, nextC);
      const nextEmpty = nextVal == null || nextVal === "";
      if (nextEmpty) {
        // Jump to next non-empty or edge
        let nr = nextR + dRow;
        let nc = nextC + dCol;
        while (nr >= 0 && nr <= maxRow && nc >= 0 && nc <= maxCol) {
          const v = getCellVal(nr, nc);
          if (v != null && v !== "") return { row: nr, col: nc };
          nr += dRow;
          nc += dCol;
        }
        return { row: Math.max(0, Math.min(nr - dRow, maxRow)), col: Math.max(0, Math.min(nc - dCol, maxCol)) };
      } else {
        // Walk until empty, return last non-empty
        let prevR = nextR;
        let prevC = nextC;
        let nr = nextR + dRow;
        let nc = nextC + dCol;
        while (nr >= 0 && nr <= maxRow && nc >= 0 && nc <= maxCol) {
          const v = getCellVal(nr, nc);
          if (v == null || v === "") break;
          prevR = nr;
          prevC = nc;
          nr += dRow;
          nc += dCol;
        }
        return { row: prevR, col: prevC };
      }
    }
  };

  // ---- Type auto-detection ----
  const detectColumnType = (values: string[]): string => {
    const nonEmpty = values.filter((v) => v.trim() !== "");
    if (nonEmpty.length === 0) return "VARCHAR";

    const allInt = nonEmpty.every((v) => /^-?\d+$/.test(v.trim()));
    if (allInt) return "INTEGER";

    const allNum = nonEmpty.every((v) => !isNaN(Number(v.trim())) && v.trim() !== "");
    if (allNum) return "DOUBLE";

    const allBool = nonEmpty.every((v) => ["true", "false", "1", "0", "yes", "no"].includes(v.trim().toLowerCase()));
    if (allBool) return "BOOLEAN";

    const allDate = nonEmpty.every((v) => /^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(v.trim()) && !isNaN(Date.parse(v.trim())));
    if (allDate) return "DATE";

    return "VARCHAR";
  };

  // ---- Copy selected cells to clipboard as TSV ----
  const handleCopy = () => {
    if (!data) return;
    let rows: string[][] = [];

    if (selectedRows.size > 0) {
      // Copy selected rows (all columns)
      const sortedRows = Array.from(selectedRows).sort((a, b) => a - b);
      for (const ri of sortedRows) {
        const dr = displayRows[ri];
        rows.push(dr.map((v) => (v == null ? "" : String(v))));
      }
    } else if (selectedCols.size > 0) {
      // Copy selected columns (all rows)
      const sortedCols = Array.from(selectedCols).sort((a, b) => a - b);
      for (let ri = 0; ri < displayRows.length; ri++) {
        const dr = displayRows[ri];
        rows.push(sortedCols.map((ci) => (dr[ci] == null ? "" : String(dr[ci]))));
      }
    } else if (selection) {
      // Copy selection range
      const { r1, c1, r2, c2 } = normalizeRange(selection);
      for (let r = r1; r <= r2; r++) {
        const dr = displayRows[r];
        const row: string[] = [];
        for (let c = c1; c <= c2; c++) {
          row.push(dr[c] == null ? "" : String(dr[c]));
        }
        rows.push(row);
      }
    } else if (activeCell) {
      // Copy single cell
      const dr = displayRows[activeCell.row];
      rows.push([dr[activeCell.col] == null ? "" : String(dr[activeCell.col])]);
    }

    if (rows.length === 0) return;
    const tsv = rows.map((r) => r.join("\t")).join("\n");
    navigator.clipboard.writeText(tsv).catch(() => {
      setErrorMsg("无法写入剪贴板");
    });
  };

  // ---- Paste from clipboard (Excel TSV) ----
  const doPaste = async (text: string, withHeader: boolean) => {
    // Parse TSV (Excel copies as tab-separated)
    const lines = text.replace(/\r\n$/, "").split(/\r?\n/);
    const parsed = lines.map((line) => line.split("\t"));
    if (parsed.length === 0) return;

    let headerNames: string[] | null = null;
    let dataRows: string[][];

    if (withHeader && parsed.length > 1) {
      headerNames = parsed[0];
      dataRows = parsed.slice(1);
    } else {
      dataRows = parsed;
    }

    const startRow = activeCell?.row ?? 0;
    const startCol = activeCell?.col ?? 0;
    const numPasteCols = dataRows.reduce((max, r) => Math.max(max, r.length), 0);
    const numPasteRows = dataRows.length;

    // Detect types for each column from data rows
    const detectedTypes: string[] = [];
    for (let c = 0; c < numPasteCols; c++) {
      const colValues = dataRows.map((r) => r[c] ?? "");
      detectedTypes.push(detectColumnType(colValues));
    }

    // Type compatibility check for existing columns with data
    for (let c = 0; c < numPasteCols; c++) {
      const targetCol = startCol + c;
      if (targetCol < cols.length) {
        const existingType = colTypes[targetCol];
        const detectedType = detectedTypes[c];
        // Check if column has existing data
        const hasExistingData = data.rows.some((row) => {
          const dr = getDisplayRow(row as unknown[]);
          return dr[targetCol] != null && String(dr[targetCol]) !== "";
        });
        if (hasExistingData && existingType !== "VARCHAR" && detectedType !== existingType) {
          // Allow INTEGER into DOUBLE
          if (existingType === "DOUBLE" && detectedType === "INTEGER") continue;
          setErrorMsg(
            `列 ${colLetter(targetCol)}（${cols[targetCol]}）的类型为 ${existingType}，与粘贴数据的类型 ${detectedType} 不兼容`
          );
          return;
        }
      }
    }

    // Check for data conflicts in paste range
    let hasConflicts = false;
    for (let r = 0; r < numPasteRows && !hasConflicts; r++) {
      const targetRow = startRow + r;
      if (targetRow < displayRows.length) {
        const dr = displayRows[targetRow];
        for (let c = 0; c < numPasteCols; c++) {
          const targetCol = startCol + c;
          if (targetCol < dr.length) {
            const val = dr[targetCol];
            if (val != null && String(val) !== "") {
              hasConflicts = true;
              break;
            }
          }
        }
      }
    }

    if (hasConflicts) {
      const confirmed = window.confirm("粘贴区域存在已有数据，是否覆盖？");
      if (!confirmed) return;
    }

    try {
      saveSnapshot();
      await dataService.pasteAtPosition(
        datasetId, toDataIdx(startRow), startCol, dataRows, headerNames, detectedTypes
      );
      await load();
      await refreshAndMarkDirty();
      recordAction("粘贴数据", true);
    } catch (err) {
      setErrorMsg(String(err));
    }
  };

  const handlePaste = async (e: React.ClipboardEvent) => {
    if (editCell) return;
    const text = e.clipboardData.getData("text/plain");
    if (!text.trim()) return;
    e.preventDefault();
    await doPaste(text, false);
  };

  const handleCellContextMenu = (e: React.MouseEvent, row: number, col: number) => {
    e.preventDefault();
    e.stopPropagation();
    // If right-clicking within an existing selection, don't change activeCell or selection
    const inSelection = selection &&
      row >= Math.min(selection.startRow, selection.endRow) &&
      row <= Math.max(selection.startRow, selection.endRow) &&
      col >= Math.min(selection.startCol, selection.endCol) &&
      col <= Math.max(selection.startCol, selection.endCol);
    if (!inSelection) {
      setActiveCell({ row, col });
      setSelection(null);
    }
    setCornerSelected(false);
    setCellMenu({ row, col, x: e.clientX, y: e.clientY });
    setColMenu(null);
    setRowMenu(null);
  };

  const handleContextMenuPaste = async (withHeader: boolean) => {
    setCellMenu(null);
    setCornerMenu(null);
    try {
      const text = await navigator.clipboard.readText();
      if (!text.trim()) return;
      await doPaste(text, withHeader);
    } catch {
      setErrorMsg("无法读取剪贴板");
    }
  };

  const handleCornerClick = () => {
    // Don't set activeCell — paste defaults to (0,0) when null
    setActiveCell(null);
    setSelection(null);
    setSelectedRows(new Set());
    setSelectedCols(new Set());
    setCornerSelected(true);
  };

  const handleCornerContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setActiveCell(null);
    setCornerSelected(true);
    setCornerMenu({ x: e.clientX, y: e.clientY });
    setColMenu(null);
    setRowMenu(null);
    setCellMenu(null);
  };

  // ---- Keyboard navigation ----
  const handleKeyDown = (e: React.KeyboardEvent) => {
    const isMeta = e.ctrlKey || e.metaKey;

    // Cmd/Ctrl+Z: undo
    if (isMeta && !e.shiftKey && e.key.toLowerCase() === "z") {
      if (!editCell) {
        e.preventDefault();
        handleUndo();
        return;
      }
    }

    // Cmd/Ctrl+Shift+Z: redo
    if (isMeta && e.shiftKey && e.key.toLowerCase() === "z") {
      if (!editCell) {
        e.preventDefault();
        handleRedo();
        return;
      }
    }

    // Cmd/Ctrl+A: select all
    if (isMeta && !e.shiftKey && e.key.toLowerCase() === "a") {
      if (!editCell && data && displayRows.length > 0 && cols.length > 0) {
        e.preventDefault();
        setActiveCell({ row: 0, col: 0 });
        setSelection({
          startRow: 0,
          startCol: 0,
          endRow: displayRows.length - 1,
          endCol: cols.length - 1,
        });
        setSelectedRows(new Set());
        setSelectedCols(new Set());
        setCornerSelected(false);
        return;
      }
    }

    // Cmd/Ctrl+C: copy selected cells
    if (isMeta && !e.shiftKey && e.key.toLowerCase() === "c") {
      if (!editCell) {
        e.preventDefault();
        handleCopy();
        return;
      }
    }

    // Cmd/Ctrl+X: cut (copy + clear)
    if (isMeta && !e.shiftKey && e.key.toLowerCase() === "x") {
      if (!editCell) {
        e.preventDefault();
        // Collect cells to clear
        const cellsToCut: { row: number; col: number }[] = [];
        if (selectedRows.size > 0) {
          for (const ri of selectedRows) {
            for (let ci = 0; ci < cols.length; ci++) cellsToCut.push({ row: ri, col: ci });
          }
        } else if (selectedCols.size > 0) {
          for (const ci of selectedCols) {
            for (let ri = 0; ri < displayRows.length; ri++) cellsToCut.push({ row: ri, col: ci });
          }
        } else if (selection) {
          const { r1, c1, r2, c2 } = normalizeRange(selection);
          for (let r = r1; r <= r2; r++) {
            for (let c = c1; c <= c2; c++) cellsToCut.push({ row: r, col: c });
          }
        } else if (activeCell) {
          cellsToCut.push(activeCell);
        }
        if (cellsToCut.length > 0) {
          handleCopy();
          clearCells(cellsToCut);
        }
        return;
      }
    }

    // Cmd/Ctrl+Shift+V: paste with headers
    if (isMeta && e.shiftKey && e.key.toLowerCase() === "v") {
      e.preventDefault();
      navigator.clipboard.readText().then((text) => {
        if (text.trim()) doPaste(text, true);
      }).catch(() => {
        setErrorMsg("无法读取剪贴板");
      });
      return;
    }

    if (editCell) return; // Don't navigate while editing
    if (!activeCell) return;

    const { row, col } = activeCell;
    const maxRow = displayRows.length - 1;
    const maxCol = cols.length - 1;
    const isMod = e.ctrlKey || e.metaKey; // Ctrl (Windows/Linux) or Cmd (macOS)

    const arrows = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];
    if (arrows.includes(e.key)) {
      e.preventDefault();

      let targetRow = row;
      let targetCol = col;

      if (e.key === "ArrowUp") {
        if (isMod) {
          const edge = findEdge(row, col, -1, 0);
          targetRow = edge.row;
        } else {
          targetRow = Math.max(0, row - 1);
        }
      } else if (e.key === "ArrowDown") {
        if (isMod) {
          const edge = findEdge(row, col, 1, 0);
          targetRow = edge.row;
        } else {
          targetRow = Math.min(maxRow, row + 1);
        }
      } else if (e.key === "ArrowLeft") {
        if (isMod) {
          const edge = findEdge(row, col, 0, -1);
          targetCol = edge.col;
        } else {
          targetCol = Math.max(0, col - 1);
        }
      } else if (e.key === "ArrowRight") {
        if (isMod) {
          const edge = findEdge(row, col, 0, 1);
          targetCol = edge.col;
        } else {
          targetCol = Math.min(maxCol, col + 1);
        }
      }

      if (e.shiftKey) {
        // Extend selection
        const anchor = selection ? { row: selection.startRow, col: selection.startCol } : { row, col };
        setSelection({
          startRow: anchor.row,
          startCol: anchor.col,
          endRow: targetRow,
          endCol: targetCol,
        });
        setActiveCell({ row: targetRow, col: targetCol });
      } else {
        setActiveCell({ row: targetRow, col: targetCol });
        setSelection(null);
      }
      return;
    }

    switch (e.key) {
      case "Tab":
        e.preventDefault();
        setSelection(null);
        if (e.shiftKey) {
          if (col > 0) setActiveCell({ row, col: col - 1 });
          else if (row > 0) setActiveCell({ row: row - 1, col: maxCol });
        } else {
          if (col < maxCol) setActiveCell({ row, col: col + 1 });
          else if (row < maxRow) setActiveCell({ row: row + 1, col: 0 });
        }
        break;
      case "Enter": {
        e.preventDefault();
        // Move down; if Tab anchor exists, return to that column
        const nextRow = Math.min(row + 1, maxRow);
        const nextCol = tabAnchorColRef.current != null ? tabAnchorColRef.current : col;
        tabAnchorColRef.current = null;
        setActiveCell({ row: nextRow, col: nextCol });
        setSelection(null);
        break;
      }
      case "F2": {
        e.preventDefault();
        const displayRow = displayRows[row];
        handleCellDoubleClick(row, col, displayRow[col]);
        break;
      }
      case "Delete":
      case "Backspace": {
        e.preventDefault();
        const cellsToClear: { row: number; col: number }[] = [];
        if (selection) {
          const { r1, c1, r2, c2 } = normalizeRange(selection);
          for (let r = r1; r <= r2; r++)
            for (let c = c1; c <= c2; c++)
              cellsToClear.push({ row: r, col: c });
        } else {
          cellsToClear.push({ row, col });
        }
        clearCells(cellsToClear);
        break;
      }
      case "Escape":
        setSelection(null);
        break;
      default: {
        // Printable character: start editing with that key (replace mode)
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault();
          setActiveCell({ row, col });
          setEditCell({ row, col });
          setEditValue(e.key);
        }
        break;
      }
    }
  };

  // ---- Auto-scroll helper for drag selection ----

  const startAutoScroll = (ev: MouseEvent) => {
    stopAutoScroll();
    const wrapper = tableRef.current;
    if (!wrapper) return;
    const rect = wrapper.getBoundingClientRect();
    const EDGE = 30;
    const SPEED = 12;
    let dx = 0, dy = 0;
    if (ev.clientY > rect.bottom - EDGE) dy = SPEED;
    else if (ev.clientY < rect.top + EDGE) dy = -SPEED;
    if (ev.clientX > rect.right - EDGE) dx = SPEED;
    else if (ev.clientX < rect.left + EDGE) dx = -SPEED;
    if (dx === 0 && dy === 0) return;
    autoScrollRef.current = window.setInterval(() => {
      wrapper.scrollBy(dx, dy);
    }, 30);
  };

  const stopAutoScroll = () => {
    if (autoScrollRef.current != null) {
      clearInterval(autoScrollRef.current);
      autoScrollRef.current = null;
    }
  };

  // ---- Mouse drag selection ----
  const handleCellMouseDown = (row: number, col: number, e: React.MouseEvent) => {
    if (e.button !== 0) return; // Left button only
    if (editCell) return; // Don't start drag while editing
    // If a menu is open, this click is just dismissing it
    if (hasMenuOpen() || suppressSelectionRef.current) return;
    containerRef.current?.focus();
    setCornerSelected(false);

    if (e.shiftKey && activeCell) {
      // Shift+click: extend selection
      setSelection({
        startRow: activeCell.row,
        startCol: activeCell.col,
        endRow: row,
        endCol: col,
      });
      e.preventDefault();
      return;
    }

    // Start drag selection
    e.preventDefault();
    isDraggingRef.current = true;
    setIsDragging(true);
    didDragRef.current = false;
    setActiveCell({ row, col });
    setSelection({ startRow: row, startCol: col, endRow: row, endCol: col });
    setEditCell(null);
    setSelectedRows(new Set());
    setSelectedCols(new Set());

    document.body.style.userSelect = "none";

    const onMouseMove = (ev: MouseEvent) => {
      if (!isDraggingRef.current) return;
      didDragRef.current = true;
      startAutoScroll(ev);
      // Find which cell the mouse is over
      const target = document.elementFromPoint(ev.clientX, ev.clientY);
      if (!target) return;
      const td = target.closest("td.sp-cell") as HTMLElement | null;
      if (!td) return;
      const ri = td.dataset.row;
      const ci = td.dataset.col;
      if (ri != null && ci != null) {
        setSelection((prev) => prev ? { ...prev, endRow: Number(ri), endCol: Number(ci) } : null);
      }
    };

    const onMouseUp = () => {
      isDraggingRef.current = false;
      setIsDragging(false);
      stopAutoScroll();
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      // If selection is a single cell, clear it (just activeCell)
      setSelection((prev) => {
        if (prev && prev.startRow === prev.endRow && prev.startCol === prev.endCol) return null;
        return prev;
      });
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  };

  const handleRowSelect = (rowIdx: number, e: React.MouseEvent) => {
    // If a row drag just finished, don't override selection
    if (didDragRowRef.current) {
      didDragRowRef.current = false;
      return;
    }
    if (suppressSelectionRef.current || hasMenuOpen()) return;
    setCornerSelected(false);
    const newSet = new Set(selectedRows);
    if (e.ctrlKey || e.metaKey) {
      if (newSet.has(rowIdx)) newSet.delete(rowIdx);
      else newSet.add(rowIdx);
      rowAnchorRef.current = rowIdx;
    } else if (e.shiftKey && rowAnchorRef.current != null) {
      const start = Math.min(rowAnchorRef.current, rowIdx);
      const end = Math.max(rowAnchorRef.current, rowIdx);
      newSet.clear();
      for (let i = start; i <= end; i++) newSet.add(i);
    } else {
      newSet.clear();
      newSet.add(rowIdx);
      rowAnchorRef.current = rowIdx;
    }
    setSelectedRows(newSet);
    setSelectedCols(new Set());
    setSelection(null);
    setActiveCell(null);
  };

  const handleRowHeaderMouseDown = (rowIdx: number, e: React.MouseEvent) => {
    if (hasMenuOpen() || suppressSelectionRef.current) return;
    setCornerSelected(false);
    if (e.button !== 0) return;
    e.preventDefault();
    isDraggingRowRef.current = true;
    didDragRowRef.current = false;
    setIsDragging(true);
    const anchorRow = rowIdx;
    document.body.style.userSelect = "none";

    const onMouseMove = (ev: MouseEvent) => {
      if (!isDraggingRowRef.current) return;
      if (!didDragRowRef.current) {
        didDragRowRef.current = true;
        // Initialize selection on first move if no modifier
        if (!e.ctrlKey && !e.metaKey && !e.shiftKey) {
          setSelectedRows(new Set([rowIdx]));
          setSelectedCols(new Set());
          setSelection(null);
        }
      }
      startAutoScroll(ev);
      const target = document.elementFromPoint(ev.clientX, ev.clientY);
      if (!target) return;
      const td = target.closest("td.sp-row-hdr") as HTMLElement | null;
      if (!td) return;
      const txt = td.textContent;
      if (txt) {
        const ri = parseInt(txt, 10) - 1;
        if (!isNaN(ri)) {
          const start = Math.min(anchorRow, ri);
          const end = Math.max(anchorRow, ri);
          const newSet = new Set<number>();
          for (let i = start; i <= end; i++) newSet.add(i);
          setSelectedRows(newSet);
        }
      }
    };

    const onMouseUp = () => {
      isDraggingRowRef.current = false;
      setIsDragging(false);
      stopAutoScroll();
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    containerRef.current?.focus();
  };

  const handleColSelect = (colIdx: number, e: React.MouseEvent) => {
    // If a column drag just finished, don't override selection
    if (didDragColRef.current) {
      didDragColRef.current = false;
      return;
    }
    if (suppressSelectionRef.current || hasMenuOpen()) return;
    setCornerSelected(false);
    // Single click on column header to select column
    const newSet = new Set(selectedCols);
    if (e.ctrlKey || e.metaKey) {
      if (newSet.has(colIdx)) newSet.delete(colIdx);
      else newSet.add(colIdx);
      colAnchorRef.current = colIdx;
    } else if (e.shiftKey && colAnchorRef.current != null) {
      const start = Math.min(colAnchorRef.current, colIdx);
      const end = Math.max(colAnchorRef.current, colIdx);
      newSet.clear();
      for (let i = start; i <= end; i++) newSet.add(i);
    } else {
      newSet.clear();
      newSet.add(colIdx);
      colAnchorRef.current = colIdx;
    }
    setSelectedCols(newSet);
    setSelectedRows(new Set());
    setSelection(null);
    setActiveCell(null);
  };

  const handleColHeaderMouseDown = (colIdx: number, e: React.MouseEvent) => {
    if (hasMenuOpen() || suppressSelectionRef.current) return;
    setCornerSelected(false);
    if (e.button !== 0) return;
    e.preventDefault();
    isDraggingColRef.current = true;
    didDragColRef.current = false;
    setIsDragging(true);
    const anchorCol = colIdx;
    document.body.style.userSelect = "none";

    const onMouseMove = (ev: MouseEvent) => {
      if (!isDraggingColRef.current) return;
      if (!didDragColRef.current) {
        didDragColRef.current = true;
        // Initialize selection on first move if no modifier
        if (!e.ctrlKey && !e.metaKey && !e.shiftKey) {
          setSelectedCols(new Set([colIdx]));
          setSelectedRows(new Set());
          setSelection(null);
        }
      }
      startAutoScroll(ev);
      const target = document.elementFromPoint(ev.clientX, ev.clientY);
      if (!target) return;
      const th = target.closest("th.sp-col-hdr") as HTMLElement | null;
      if (!th) return;
      // Find column index from sibling position
      const row = th.parentElement;
      if (!row) return;
      const ths = Array.from(row.querySelectorAll("th.sp-col-hdr"));
      const ci = ths.indexOf(th);
      if (ci >= 0) {
        const start = Math.min(anchorCol, ci);
        const end = Math.max(anchorCol, ci);
        const newSet = new Set<number>();
        for (let i = start; i <= end; i++) newSet.add(i);
        setSelectedCols(newSet);
      }
    };

    const onMouseUp = () => {
      isDraggingColRef.current = false;
      setIsDragging(false);
      stopAutoScroll();
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    containerRef.current?.focus();
  };

  const handleColContextMenu = (e: React.MouseEvent, colIdx: number) => {
    e.preventDefault();
    e.stopPropagation();
    // If right-clicked column is not in selection, select just that one
    if (!selectedCols.has(colIdx)) {
      setSelectedCols(new Set([colIdx]));
    }
    setColMenu({ colIdx, x: e.clientX, y: e.clientY });
    setRowMenu(null);
  };

  const handleRowContextMenu = (e: React.MouseEvent, rowIdx: number) => {
    e.preventDefault();
    e.stopPropagation();
    // If right-clicked row is not in selection, select just that one
    if (!selectedRows.has(rowIdx)) {
      setSelectedRows(new Set([rowIdx]));
    }
    setRowMenu({ rowIdx, x: e.clientX, y: e.clientY });
    setColMenu(null);
  };

  // ---- Column resize (drag) — batch-aware (Excel-style) ----
  const handleResizeStart = (e: React.MouseEvent, colIdx: number) => {
    e.preventDefault();
    e.stopPropagation();
    saveSnapshot();
    const startX = e.clientX;
    // Calculate offset: distance from mouse to the actual right border of the column
    const th = (e.target as HTMLElement).closest("th");
    const borderX = th ? th.getBoundingClientRect().right : startX;
    const offsetX = startX - borderX;
    const startW = colWidths[colIdx] ?? DEFAULT_COL_WIDTH;
    const batchCols = selectedCols.has(colIdx) ? Array.from(selectedCols).filter(ci => ci !== colIdx) : [];
    resizingRef.current = { colIdx, startX, startW };

    const onMouseMove = (ev: MouseEvent) => {
      if (!resizingRef.current) return;
      const delta = ev.clientX - offsetX - resizingRef.current.startX;
      const newW = Math.max(DEFAULT_COL_WIDTH, startW + delta);
      setColWidths((prev) => {
        const next = [...prev];
        next[colIdx] = newW;
        return next;
      });
    };

    const onMouseUp = () => {
      resizingRef.current = null;
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      // Suppress the click event that follows mouseup from changing selection
      suppressSelectionRef.current = true;
      requestAnimationFrame(() => { suppressSelectionRef.current = false; });
      // Apply the final width to all other selected columns and sync
      setColWidths((prev) => {
        const next = [...prev];
        if (batchCols.length > 0) {
          const finalW = next[colIdx];
          for (const ci of batchCols) {
            next[ci] = finalW;
          }
        }
        // Sync display props to backend
        syncDisplayProps(next, colFormatsRef.current);
        markDirty();
        return next;
      });
    };

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  };

  // ---- Auto-fit column width using canvas measureText ----
  const autoFitColumn = (colIdx: number): number => {
    const CELL_PADDING = 14;
    const HDR_PADDING = 16;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d")!;
    // Measure cell content (13px font from .sp-grid)
    ctx.font = "13px system-ui, -apple-system, sans-serif";
    let maxW = 0;
    for (const row of displayRows) {
      const val = row[colIdx];
      const text = val == null ? "NULL" : String(val);
      maxW = Math.max(maxW, ctx.measureText(text).width + CELL_PADDING);
    }
    // Measure header: col letter + col name + col type label
    ctx.font = "bold 11px system-ui, -apple-system, sans-serif";
    const letter = colLetter(colIdx);
    ctx.font = "13px system-ui, -apple-system, sans-serif";
    const name = cols[colIdx] || "";
    const typeLabel = COLUMN_TYPES.find(t => t.value === colTypes[colIdx])?.label ?? colTypes[colIdx];
    ctx.font = "11px system-ui, -apple-system, sans-serif";
    // Header content is stacked vertically, widest element determines width
    const hdrTexts = [letter, name, typeLabel];
    for (const t of hdrTexts) {
      maxW = Math.max(maxW, ctx.measureText(t).width + HDR_PADDING);
    }
    return Math.max(DEFAULT_COL_WIDTH, Math.ceil(maxW));
  };

  // ---- Double-click resize to auto-fit (supports batch) ----
  const handleResizeDoubleClick = (e: React.MouseEvent, colIdx: number) => {
    e.preventDefault();
    e.stopPropagation();
    // If this column is in the selected set, auto-fit all selected columns
    const targetCols = selectedCols.has(colIdx) ? Array.from(selectedCols) : [colIdx];
    saveSnapshot();
    const newWidths = [...colWidths];
    for (const ci of targetCols) {
      newWidths[ci] = autoFitColumn(ci);
    }
    setColWidths(newWidths);
    syncDisplayProps(newWidths, colFormatsRef.current);
    markDirty();
  };

  return (
    <div className={`sp-spreadsheet${isDragging ? " sp-dragging" : ""}`} onKeyDown={handleKeyDown} onPaste={handlePaste} tabIndex={0} ref={containerRef}>

      {/* Add column inline form */}
      {showAddCol && (
        <div className="sp-add-col-bar">
          <input
            ref={addColInputRef}
            className="sp-input"
            placeholder="列名"
            value={newColName}
            onChange={(e) => setNewColName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleAddColumn(); if (e.key === "Escape") setShowAddCol(false); }}
          />
          <select className="sp-select" value={newColType} onChange={(e) => setNewColType(e.target.value)}>
            {COLUMN_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
          <button className="sp-tb-btn sp-btn-accent" onClick={handleAddColumn}>添加</button>
          <button className="sp-tb-btn" onClick={() => setShowAddCol(false)}>取消</button>
        </div>
      )}

      {/* Column properties dialog */}
      {renameCol && (
        <div className="sp-dialog-overlay">
          <div className="sp-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="sp-dialog-title">列属性</div>
            <div className="sp-dialog-body">
              <label className="sp-dialog-label">列名称</label>
              <input
                ref={renameInputRef}
                className="sp-dialog-input"
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleRenameColumn(); if (e.key === "Escape") setRenameCol(null); }}
              />
              <label className="sp-dialog-label">列类型</label>
              <select className="sp-dialog-select" value={renameType} onChange={(e) => setRenameType(e.target.value)}>
                {COLUMN_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
              <label className="sp-dialog-label">显示格式</label>
              <select className="sp-dialog-select" value={renameFormat.kind} onChange={(e) => {
                const kind = e.target.value as FormatKind;
                setRenameFormat(kind === "currency"
                  ? { kind, decimals: 2, currency: "CNY" }
                  : kind === "fixed" || kind === "percent"
                    ? { kind, decimals: 2 }
                    : { kind });
              }}>
                {FORMAT_OPTIONS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
              </select>
              {(renameFormat.kind === "fixed" || renameFormat.kind === "percent") && (
                <div style={{ marginTop: 6 }}>
                  <label className="sp-dialog-label">小数位数</label>
                  <input
                    className="sp-dialog-input"
                    type="number"
                    min={0}
                    max={20}
                    value={renameFormat.decimals ?? 2}
                    onChange={(e) => setRenameFormat((prev) => ({ ...prev, decimals: Math.max(0, Math.min(20, Number(e.target.value) || 0)) }))}
                  />
                </div>
              )}
              {renameFormat.kind === "currency" && (
                <>
                  <div style={{ marginTop: 6 }}>
                    <label className="sp-dialog-label">货币类型</label>
                    <select className="sp-dialog-select" value={renameFormat.currency ?? "CNY"} onChange={(e) => setRenameFormat((prev) => ({ ...prev, currency: e.target.value }))}>
                      {CURRENCY_OPTIONS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                    </select>
                  </div>
                  <div style={{ marginTop: 6 }}>
                    <label className="sp-dialog-label">小数位数</label>
                    <input
                      className="sp-dialog-input"
                      type="number"
                      min={0}
                      max={20}
                      value={renameFormat.decimals ?? 2}
                      onChange={(e) => setRenameFormat((prev) => ({ ...prev, decimals: Math.max(0, Math.min(20, Number(e.target.value) || 0)) }))}
                    />
                  </div>
                </>
              )}
              <label className="sp-dialog-label">列宽度</label>
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <input
                  className="sp-dialog-input"
                  type="number"
                  min={DEFAULT_COL_WIDTH}
                  style={{ flex: 1 }}
                  value={renameWidth}
                  onChange={(e) => setRenameWidth(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") handleRenameColumn(); if (e.key === "Escape") setRenameCol(null); }}
                />
                <button className="sp-dialog-btn" onClick={() => setRenameWidth(String(autoFitColumn(renameCol.colIdx)))}>自动</button>
              </div>
            </div>
            <div className="sp-dialog-actions">
              <button className="sp-dialog-btn" onClick={() => setRenameCol(null)}>取消</button>
              <button className="sp-dialog-btn sp-dialog-btn-primary" onClick={handleRenameColumn}>确定</button>
            </div>
          </div>
        </div>
      )}

      {/* Spreadsheet table */}
      <div className="sp-grid-wrapper" ref={tableRef} onScroll={(e) => setScrollTop((e.target as HTMLElement).scrollTop)}>
        <table className="sp-grid" style={{ width: 46 + cols.reduce((s, _, ci) => s + (colWidths[ci] ?? DEFAULT_COL_WIDTH), 0) + 40 }}>
          <colgroup>
            <col style={{ width: 46 }} />
            {cols.map((_, ci) => (
              <col key={ci} style={{ width: colWidths[ci] ?? DEFAULT_COL_WIDTH }} />
            ))}
            <col style={{ width: 40 }} />
          </colgroup>
          <thead>
            <tr>
              {/* Select-all corner */}
              <th
                className={`sp-corner${cornerSelected ? " sp-corner-active" : ""}`}
                onClick={handleCornerClick}
                onContextMenu={handleCornerContextMenu}
                style={{ cursor: "pointer" }}
              />
              {/* Column headers — event delegation via data-col-hdr */}
              {cols.map((col, ci) => (
                <th
                  key={ci}
                  data-col-hdr={ci}
                  className={`sp-col-hdr${activeColRange.has(ci) ? " sp-col-active" : ""}${selectedCols.has(ci) ? " sp-col-selected" : ""}`}
                  onClick={(e) => handleColSelect(ci, e)}
                  onMouseDown={(e) => handleColHeaderMouseDown(ci, e)}
                  onDoubleClick={() => handleStartRenameCol(ci)}
                  onContextMenu={(e) => handleColContextMenu(e, ci)}
                >
                  <div className="sp-col-hdr-content">
                    <span className="sp-col-letter">{colLetter(ci)}</span>
                    <span className="sp-col-name">{col}</span>
                    <span className="sp-col-type">{COLUMN_TYPES.find(t => t.value === colTypes[ci])?.label ?? colTypes[ci]}</span>
                    <span
                      className={`sp-filter-icon${columnFilters.has(ci) ? " sp-filter-active" : ""}`}
                      title="筛选"
                      onClick={(e) => {
                        e.stopPropagation();
                        const rect = (e.target as HTMLElement).getBoundingClientRect();
                        setFilterPopover(prev => prev?.colIdx === ci ? null : { colIdx: ci, anchorRect: rect });
                      }}
                    >
                      ▼
                    </span>
                  </div>
                  {/* Resize handle */}
                  <div
                    className="sp-resize-handle"
                    onMouseDown={(e) => handleResizeStart(e, ci)}
                    onClick={(e) => e.stopPropagation()}
                    onDoubleClick={(e) => handleResizeDoubleClick(e, ci)}
                  />
                </th>
              ))}
              {/* "+" column at end */}
              <th className="sp-add-col-hdr" onClick={handleAddColumnQuick} title="添加列">
                +
              </th>
            </tr>
          </thead>
          <tbody
            onClick={(e) => {
              const td = (e.target as HTMLElement).closest("td[data-row]") as HTMLElement | null;
              if (td) {
                const ri = Number(td.dataset.row);
                const ci = Number(td.dataset.col);
                handleCellClick(ri, ci, e as unknown as React.MouseEvent);
                return;
              }
              const rowHdr = (e.target as HTMLElement).closest("td[data-row-hdr]") as HTMLElement | null;
              if (rowHdr) {
                handleRowSelect(Number(rowHdr.dataset.rowHdr), e as unknown as React.MouseEvent);
              }
            }}
            onMouseDown={(e) => {
              const td = (e.target as HTMLElement).closest("td[data-row]") as HTMLElement | null;
              if (td) {
                handleCellMouseDown(Number(td.dataset.row), Number(td.dataset.col), e as unknown as React.MouseEvent);
                return;
              }
              const rowHdr = (e.target as HTMLElement).closest("td[data-row-hdr]") as HTMLElement | null;
              if (rowHdr) {
                handleRowHeaderMouseDown(Number(rowHdr.dataset.rowHdr), e as unknown as React.MouseEvent);
              }
            }}
            onDoubleClick={(e) => {
              const td = (e.target as HTMLElement).closest("td[data-row]") as HTMLElement | null;
              if (td) {
                const ri = Number(td.dataset.row);
                const ci = Number(td.dataset.col);
                handleCellDoubleClick(ri, ci, displayRows[ri]?.[ci]);
              }
            }}
            onContextMenu={(e) => {
              const td = (e.target as HTMLElement).closest("td[data-row]") as HTMLElement | null;
              if (td) {
                handleCellContextMenu(e as unknown as React.MouseEvent, Number(td.dataset.row), Number(td.dataset.col));
                return;
              }
              const rowHdr = (e.target as HTMLElement).closest("td[data-row-hdr]") as HTMLElement | null;
              if (rowHdr) {
                handleRowContextMenu(e as unknown as React.MouseEvent, Number(rowHdr.dataset.rowHdr));
              }
            }}
          >
            {/* Top spacer for virtual scroll */}
            {virtualRange.startIdx > 0 && (
              <tr style={{ height: virtualRange.startIdx * ROW_HEIGHT }} aria-hidden="true">
                <td colSpan={cols.length + 2} style={{ padding: 0, border: "none" }} />
              </tr>
            )}
            {displayRows.length > 0 && (
              displayRows.slice(virtualRange.startIdx, virtualRange.endIdx).map((displayRow, idx) => {
                const ri = virtualRange.startIdx + idx;
                return (
                  <TableRow
                    key={ri}
                    ri={ri}
                    displayRow={displayRow}
                    colFormats={colFormats}
                    isRowSelected={selectedRows.has(ri)}
                    isRowActive={activeRowRange.has(ri)}
                    isRowSelectedHdr={selectedRows.has(ri)}
                    activeCol={activeCell?.row === ri ? activeCell.col : null}
                    selectedCols={selectedCols}
                    editRow={editCell?.row ?? null}
                    editCol={editCell?.col ?? null}
                    editValue={editValue}
                    editInputRef={editInputRef}
                    selection={selection}
                    onEditValueChange={setEditValue}
                    onCommitEdit={commitEdit}
                    onCancelEdit={cancelEdit}
                  />
                );
              })
            )}
            {/* Bottom spacer for virtual scroll */}
            {virtualRange.endIdx < totalRowCount && (
              <tr style={{ height: (totalRowCount - virtualRange.endIdx) * ROW_HEIGHT }} aria-hidden="true">
                <td colSpan={cols.length + 2} style={{ padding: 0, border: "none" }} />
              </tr>
            )}
            {/* "Add row" bottom row */}
            <tr className="sp-add-row-tr">
              <td
                className="sp-add-row-hdr"
                onClick={handleAddRow}
                title="添加行"
              >
                +
              </td>
              {cols.map((_, ci) => (
                <td key={ci} className="sp-add-row-cell" />
              ))}
              <td className="sp-add-corner" />
            </tr>
          </tbody>
        </table>
      </div>

      {/* Error toast */}
      {errorMsg && (
        <div className="sp-toast-error">
          <span>{errorMsg}</span>
          <button onClick={() => setErrorMsg(null)}>✕</button>
        </div>
      )}

      {/* Column context menu */}
      {colMenu && (
        <div
          ref={ctxMenuRef}
          className="sp-ctx-menu"
          style={{ left: colMenu.x, top: colMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          {selectedCols.size > 1 ? (
            <>
              <div className="sp-ctx-item" onClick={handleStartBatchColProps}>
                列属性（{selectedCols.size} 列）
              </div>
              <div className="sp-ctx-item" onClick={() => { handleAddColumnQuick(); setColMenu(null); }}>
                插入列
              </div>
              <div className="sp-ctx-item" onClick={() => { setShowInsertMultiCols(true); setColMenu(null); }}>
                插入多列...
              </div>
              <div className="sp-ctx-sep" />
              <div
                className={`sp-ctx-item sp-ctx-danger ${cols.length - selectedCols.size < 1 ? "sp-ctx-disabled" : ""}`}
                onClick={handleDeleteSelectedCols}
              >
                删除选中的 {selectedCols.size} 列
              </div>
            </>
          ) : (
            <>
              <div className="sp-ctx-item" onClick={() => handleStartRenameCol(colMenu.colIdx)}>
                列属性
              </div>
              <div className="sp-ctx-item" onClick={() => { handleAddColumnQuick(); setColMenu(null); }}>
                插入列
              </div>
              <div className="sp-ctx-item" onClick={() => { setShowInsertMultiCols(true); setColMenu(null); }}>
                插入多列...
              </div>
              <div className="sp-ctx-sep" />
              <div
                className={`sp-ctx-item sp-ctx-danger ${cols.length <= 1 ? "sp-ctx-disabled" : ""}`}
                onClick={() => cols.length > 1 && handleDeleteColumn(cols[colMenu.colIdx])}
              >
                删除列 "{cols[colMenu.colIdx]}"
              </div>
            </>
          )}
        </div>
      )}

      {/* Cell context menu */}
      {cellMenu && (
        <div
          ref={ctxMenuRef}
          className="sp-ctx-menu"
          style={{ left: cellMenu.x, top: cellMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="sp-ctx-item" onClick={() => { handleCopy(); setCellMenu(null); }}>
            复制<span className="sp-ctx-shortcut">{modKey}C</span>
          </div>
          <div className="sp-ctx-item" onClick={() => handleContextMenuPaste(false)}>
            粘贴<span className="sp-ctx-shortcut">{modKey}V</span>
          </div>
          <div className="sp-ctx-item" onClick={() => handleContextMenuPaste(true)}>
            带表头数据粘贴<span className="sp-ctx-shortcut">{modKey}{shiftKey}V</span>
          </div>
        </div>
      )}

      {/* Corner context menu */}
      {cornerMenu && (
        <div
          ref={ctxMenuRef}
          className="sp-ctx-menu"
          style={{ left: cornerMenu.x, top: cornerMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="sp-ctx-item" onClick={() => { handleInsertRowAbove(); setCornerMenu(null); }}>
            插入行
          </div>
          <div className="sp-ctx-item" onClick={() => { setShowInsertMultiRows(true); setCornerMenu(null); }}>
            插入多行...
          </div>
          <div className="sp-ctx-sep" />
          <div className="sp-ctx-item" onClick={() => { handleAddColumnQuick(); setCornerMenu(null); }}>
            插入列
          </div>
          <div className="sp-ctx-item" onClick={() => { setShowInsertMultiCols(true); setCornerMenu(null); }}>
            插入多列...
          </div>
          <div className="sp-ctx-sep" />
          <div className="sp-ctx-item" onClick={() => handleContextMenuPaste(false)}>
            粘贴<span className="sp-ctx-shortcut">{modKey}V</span>
          </div>
          <div className="sp-ctx-item" onClick={() => handleContextMenuPaste(true)}>
            带表头数据粘贴<span className="sp-ctx-shortcut">{modKey}{shiftKey}V</span>
          </div>
        </div>
      )}

      {/* Row context menu */}
      {rowMenu && (
        <div
          ref={ctxMenuRef}
          className="sp-ctx-menu"
          style={{ left: rowMenu.x, top: rowMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="sp-ctx-item" onClick={handleInsertRowAbove}>
            插入行
          </div>
          <div className="sp-ctx-item" onClick={() => { setShowInsertMultiRows(true); setRowMenu(null); }}>
            插入多行...
          </div>
          <div className="sp-ctx-sep" />
          {selectedRows.size > 1 ? (
            <div className="sp-ctx-item sp-ctx-danger" onClick={handleDeleteRows}>
              删除选中的 {selectedRows.size} 行
            </div>
          ) : (
            <div className="sp-ctx-item sp-ctx-danger" onClick={() => handleDeleteSingleRow(rowMenu.rowIdx)}>
              删除此行
            </div>
          )}
        </div>
      )}

      {/* Column filter popover */}
      {filterPopover && (
        <>
          <div className="sp-filter-backdrop" onClick={() => setFilterPopover(null)} />
          {(() => {
            const ci = filterPopover.colIdx;
            const colType = colTypes[ci];
            const isDiscrete = colType !== "DOUBLE";
            return (
              <div
                ref={ctxMenuRef}
                className="sp-filter-popover"
                style={{ position: "fixed", left: filterPopover.anchorRect.left, top: filterPopover.anchorRect.bottom + 2 }}
                onClick={(e) => e.stopPropagation()}
              >
                <div className="sp-filter-title">筛选: {cols[ci]}</div>
                {isDiscrete ? (
                  <div className="sp-filter-body">
                    <div className="sp-filter-toolbar">
                      <button className="sp-filter-btn" onClick={() => setFilterWorkingSet(new Set(filterUniqueValues))}>全选</button>
                      <button className="sp-filter-btn" onClick={() => setFilterWorkingSet(new Set())}>全不选</button>
                    </div>
                    <div className="sp-filter-list">
                      {filterUniqueValues.map((val, idx) => (
                        <label
                          key={idx}
                          className={`sp-filter-item${filterWorkingSet.has(val) ? " sp-filter-item-checked" : ""}`}
                          onClick={(e) => {
                            e.preventDefault();
                            if (e.shiftKey && filterLastClickRef.current >= 0) {
                              const from = Math.min(filterLastClickRef.current, idx);
                              const to = Math.max(filterLastClickRef.current, idx);
                              setFilterWorkingSet(prev => {
                                const next = new Set(prev);
                                for (let i = from; i <= to; i++) next.add(filterUniqueValues[i]);
                                return next;
                              });
                            } else if (e.ctrlKey || e.metaKey) {
                              setFilterWorkingSet(prev => {
                                const next = new Set(prev);
                                if (next.has(val)) next.delete(val); else next.add(val);
                                return next;
                              });
                            } else {
                              setFilterWorkingSet(prev => {
                                const next = new Set(prev);
                                if (next.has(val)) next.delete(val); else next.add(val);
                                return next;
                              });
                            }
                            filterLastClickRef.current = idx;
                          }}
                        >
                          <input type="checkbox" checked={filterWorkingSet.has(val)} readOnly />
                          <span className="sp-filter-val">{val === "" ? "(空)" : val}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="sp-filter-body">
                    <div className="sp-filter-range">
                      <label className="sp-filter-range-label">最小值</label>
                      <input className="sp-filter-range-input" type="text" value={filterRangeMin} onChange={(e) => setFilterRangeMin(e.target.value)} />
                      <label className="sp-filter-range-label">最大值</label>
                      <input className="sp-filter-range-input" type="text" value={filterRangeMax} onChange={(e) => setFilterRangeMax(e.target.value)} />
                    </div>
                  </div>
                )}
                <div className="sp-filter-actions">
                  <button className="sp-filter-btn" onClick={() => {
                    setColumnFilters(prev => {
                      const next = new Map(prev);
                      next.delete(ci);
                      return next;
                    });
                    setFilterPopover(null);
                  }}>清除筛选</button>
                  <button className="sp-filter-btn sp-filter-btn-primary" onClick={() => {
                    if (isDiscrete) {
                      if (filterWorkingSet.size < filterUniqueValues.length) {
                        setColumnFilters(prev => {
                          const next = new Map(prev);
                          next.set(ci, { kind: "discrete", selected: new Set(filterWorkingSet) });
                          return next;
                        });
                      } else {
                        setColumnFilters(prev => {
                          const next = new Map(prev);
                          next.delete(ci);
                          return next;
                        });
                      }
                    } else {
                      if (filterRangeMin !== "" || filterRangeMax !== "") {
                        setColumnFilters(prev => {
                          const next = new Map(prev);
                          next.set(ci, { kind: "range", min: filterRangeMin, max: filterRangeMax });
                          return next;
                        });
                      } else {
                        setColumnFilters(prev => {
                          const next = new Map(prev);
                          next.delete(ci);
                          return next;
                        });
                      }
                    }
                    setFilterPopover(null);
                  }}>确定</button>
                </div>
              </div>
            );
          })()}
        </>
      )}

      {/* Insert multi-rows dialog */}
      {showInsertMultiRows && (
        <div className="sp-dialog-overlay" onClick={() => setShowInsertMultiRows(false)}>
          <div className="sp-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="sp-dialog-title">插入多行</div>
            <div className="sp-dialog-body">
              <label className="sp-dialog-label">行数</label>
              <input
                className="sp-dialog-input"
                type="number"
                min="1"
                value={insertRowCount}
                onChange={(e) => setInsertRowCount(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleInsertMultiRows(); }}
                autoFocus
              />
            </div>
            <div className="sp-dialog-actions">
              <button className="sp-dialog-btn" onClick={() => setShowInsertMultiRows(false)}>取消</button>
              <button className="sp-dialog-btn sp-dialog-btn-primary" onClick={handleInsertMultiRows}>确定</button>
            </div>
          </div>
        </div>
      )}

      {/* Insert multi-cols dialog */}
      {showInsertMultiCols && (
        <div className="sp-dialog-overlay" onClick={() => setShowInsertMultiCols(false)}>
          <div className="sp-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="sp-dialog-title">插入多列</div>
            <div className="sp-dialog-body">
              <label className="sp-dialog-label">列数</label>
              <input
                className="sp-dialog-input"
                type="number"
                min="1"
                value={insertColCount}
                onChange={(e) => setInsertColCount(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleInsertMultiCols(); }}
                autoFocus
              />
              <label className="sp-dialog-label">列类型</label>
              <select className="sp-dialog-select" value={insertColType} onChange={(e) => setInsertColType(e.target.value)}>
                {COLUMN_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </div>
            <div className="sp-dialog-actions">
              <button className="sp-dialog-btn" onClick={() => setShowInsertMultiCols(false)}>取消</button>
              <button className="sp-dialog-btn sp-dialog-btn-primary" onClick={handleInsertMultiCols}>确定</button>
            </div>
          </div>
        </div>
      )}

      {/* Batch column properties dialog */}
      {batchColProps && (
        <div className="sp-dialog-overlay">
          <div className="sp-dialog sp-dialog-wide" onClick={(e) => e.stopPropagation()}>
            <div className="sp-dialog-title">批量列属性（{batchColProps.colIndices.length} 列）</div>
            <div className="sp-dialog-body">
              <label className="sp-dialog-label">列类型</label>
              <select className="sp-dialog-select" value={batchColType} onChange={(e) => setBatchColType(e.target.value)}>
                {COLUMN_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
              <label className="sp-dialog-label">显示格式</label>
              <select className="sp-dialog-select" value={batchColFormat.kind} onChange={(e) => {
                const kind = e.target.value as FormatKind;
                setBatchColFormat(kind === "currency"
                  ? { kind, decimals: 2, currency: "CNY" }
                  : kind === "fixed" || kind === "percent"
                    ? { kind, decimals: 2 }
                    : { kind });
              }}>
                {FORMAT_OPTIONS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
              </select>
              {(batchColFormat.kind === "fixed" || batchColFormat.kind === "percent") && (
                <div style={{ marginTop: 6 }}>
                  <label className="sp-dialog-label">小数位数</label>
                  <input
                    className="sp-dialog-input"
                    type="number"
                    min={0}
                    max={20}
                    value={batchColFormat.decimals ?? 2}
                    onChange={(e) => setBatchColFormat((prev) => ({ ...prev, decimals: Math.max(0, Math.min(20, Number(e.target.value) || 0)) }))}
                  />
                </div>
              )}
              {batchColFormat.kind === "currency" && (
                <>
                  <div style={{ marginTop: 6 }}>
                    <label className="sp-dialog-label">货币类型</label>
                    <select className="sp-dialog-select" value={batchColFormat.currency ?? "CNY"} onChange={(e) => setBatchColFormat((prev) => ({ ...prev, currency: e.target.value }))}>
                      {CURRENCY_OPTIONS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                    </select>
                  </div>
                  <div style={{ marginTop: 6 }}>
                    <label className="sp-dialog-label">小数位数</label>
                    <input
                      className="sp-dialog-input"
                      type="number"
                      min={0}
                      max={20}
                      value={batchColFormat.decimals ?? 2}
                      onChange={(e) => setBatchColFormat((prev) => ({ ...prev, decimals: Math.max(0, Math.min(20, Number(e.target.value) || 0)) }))}
                    />
                  </div>
                </>
              )}
              <label className="sp-dialog-label">列宽度</label>
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <input
                  className="sp-dialog-input"
                  type="number"
                  min={DEFAULT_COL_WIDTH}
                  style={{ flex: 1 }}
                  value={batchColWidth}
                  onChange={(e) => setBatchColWidth(e.target.value)}
                />
                <button className="sp-dialog-btn" onClick={() => {
                  if (!batchColProps) return;
                  const maxW = Math.max(...batchColProps.checkedCols.size > 0
                    ? Array.from(batchColProps.checkedCols).map(ci => autoFitColumn(ci))
                    : [DEFAULT_COL_WIDTH]);
                  setBatchColWidth(String(maxW));
                }}>自动</button>
              </div>
              <label className="sp-dialog-label">应用到以下列：</label>
              <div className="sp-batch-col-list">
                {batchColProps.colIndices.map((ci) => (
                  <label key={ci} className="sp-batch-col-item">
                    <input
                      type="checkbox"
                      checked={batchColProps.checkedCols.has(ci)}
                      onChange={() => {
                        setBatchColProps((prev) => {
                          if (!prev) return prev;
                          const next = new Set(prev.checkedCols);
                          if (next.has(ci)) next.delete(ci);
                          else next.add(ci);
                          return { ...prev, checkedCols: next };
                        });
                      }}
                    />
                    <span className="sp-batch-col-name">{cols[ci]}</span>
                    <span className="sp-batch-col-type">{COLUMN_TYPES.find(t => t.value === colTypes[ci])?.label ?? colTypes[ci]}</span>
                  </label>
                ))}
              </div>
              <div className="sp-batch-col-actions-row">
                <button className="sp-batch-sel-btn" onClick={() => setBatchColProps((p) => p ? { ...p, checkedCols: new Set(p.colIndices) } : p)}>全选</button>
                <button className="sp-batch-sel-btn" onClick={() => setBatchColProps((p) => p ? { ...p, checkedCols: new Set() } : p)}>全不选</button>
              </div>
            </div>
            <div className="sp-dialog-actions">
              <button className="sp-dialog-btn" onClick={() => setBatchColProps(null)}>取消</button>
              <button className="sp-dialog-btn sp-dialog-btn-primary" onClick={handleApplyBatchColProps}>确定</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
