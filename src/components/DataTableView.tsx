import { useEffect, useState, useRef, useCallback } from "react";
import { dataService } from "@/services/dataService";
import type { TableQueryResult } from "@/types/data";
import { useDataStore } from "@/stores/useDataStore";

interface DataTableViewProps {
  datasetId: string;
}

const COLUMN_TYPES = [
  { value: "VARCHAR", label: "文本" },
  { value: "INTEGER", label: "整数" },
  { value: "DOUBLE", label: "小数" },
  { value: "BOOLEAN", label: "布尔" },
  { value: "DATE", label: "日期" },
  { value: "TIMESTAMP", label: "时间戳" },
];

const DEFAULT_COL_WIDTH = 120;

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
  const [batchColProps, setBatchColProps] = useState<{ colIndices: number[]; checkedCols: Set<number> } | null>(null);
  const [batchColType, setBatchColType] = useState("VARCHAR");
  const [showInsertMultiRows, setShowInsertMultiRows] = useState(false);
  const [insertRowCount, setInsertRowCount] = useState("5");
  const [showInsertMultiCols, setShowInsertMultiCols] = useState(false);
  const [insertColCount, setInsertColCount] = useState("3");
  const [insertColType, setInsertColType] = useState("VARCHAR");
  const [colWidths, setColWidths] = useState<number[]>([]);
  const [selection, setSelection] = useState<CellRange | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
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
  const tabAnchorColRef = useRef<number | null>(null);
  const autoScrollRef = useRef<number | null>(null);
  const { refreshDatasets, setStatusInfo } = useDataStore();

  const load = useCallback(async () => {
    try {
      const result = await dataService.queryTable({
        datasetId,
        page: 0,
        pageSize: 10000,
      });
      setData(result);
    } catch (e) {
      console.error("Failed to load table:", e);
      setData({ columns: [], columnTypes: [], rows: [], totalRows: 0, page: 0, pageSize: 10000 });
    }
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
  }, [datasetId, load]);

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

  // Close menus on outside click
  useEffect(() => {
    const handler = () => { setColMenu(null); setRowMenu(null); };
    document.addEventListener("click", handler);
    return () => document.removeEventListener("click", handler);
  }, []);

  // Initialize colWidths when columns change
  const visibleColCount = data ? data.columns.filter(c => c !== "_row_id").length : 0;
  useEffect(() => {
    setColWidths((prev) => {
      if (prev.length === visibleColCount) return prev;
      return Array.from({ length: visibleColCount }, (_, i) => prev[i] ?? DEFAULT_COL_WIDTH);
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

    setStatusInfo({
      cellLabel: activeCell ? `${colLetter(activeCell.col)}${activeCell.row + 1}` : "",
      selectionLabel: selLabel,
      dimensions: `${data.totalRows} 行 × ${visibleColCount} 列`,
    });
  }, [activeCell, selection, selectedRows, selectedCols, data, visibleColCount, setStatusInfo]);

  if (!data) return <div className="sp-loading">加载中...</div>;

  // Filter _row_id from display
  const rowIdIdx = data.columns.indexOf("_row_id");
  const cols = data.columns.filter((_, i) => i !== rowIdIdx);
  const colTypes = data.columnTypes.filter((_, i) => i !== rowIdIdx);

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

  // ---- Row operations ----
  const handleAddRow = async () => {
    await dataService.addRow(datasetId);
    await load();
    await refreshDatasets();
  };

  const handleInsertMultiRows = async () => {
    const count = parseInt(insertRowCount, 10);
    if (isNaN(count) || count < 1) return;
    for (let i = 0; i < count; i++) {
      await dataService.addRow(datasetId);
    }
    setShowInsertMultiRows(false);
    setInsertRowCount("5");
    await load();
    await refreshDatasets();
  };

  const handleDeleteRows = async () => {
    if (selectedRows.size === 0) return;
    for (const rowIdx of selectedRows) {
      const row = data.rows[rowIdx] as unknown[];
      if (row) await dataService.deleteRow(datasetId, getRowId(row));
    }
    setSelectedRows(new Set());
    setRowMenu(null);
    await load();
    await refreshDatasets();
  };

  const handleDeleteSingleRow = async (rowIdx: number) => {
    const row = data.rows[rowIdx] as unknown[];
    await dataService.deleteRow(datasetId, getRowId(row));
    setRowMenu(null);
    await load();
    await refreshDatasets();
  };

  const handleInsertRowAbove = async () => {
    await dataService.addRow(datasetId);
    setRowMenu(null);
    await load();
    await refreshDatasets();
  };

  // ---- Column operations ----
  const handleAddColumnQuick = async () => {
    const name = generateColName(cols);
    await dataService.addColumn(datasetId, name, "VARCHAR");
    await load();
    await refreshDatasets();
  };

  const handleAddColumn = async () => {
    const name = newColName.trim();
    if (!name) return;
    await dataService.addColumn(datasetId, name, newColType);
    setShowAddCol(false);
    setNewColName("");
    setNewColType("VARCHAR");
    await load();
    await refreshDatasets();
  };

  const handleInsertMultiCols = async () => {
    const count = parseInt(insertColCount, 10);
    if (isNaN(count) || count < 1) return;
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
    await refreshDatasets();
  };

  const handleDeleteColumn = async (colName: string) => {
    if (cols.length <= 1) return;
    await dataService.deleteColumn(datasetId, colName);
    setColMenu(null);
    await load();
    await refreshDatasets();
  };

  const handleDeleteSelectedCols = async () => {
    if (selectedCols.size === 0) return;
    if (cols.length - selectedCols.size < 1) {
      setErrorMsg("不能删除所有列，至少保留一列");
      setColMenu(null);
      return;
    }
    for (const ci of selectedCols) {
      await dataService.deleteColumn(datasetId, cols[ci]);
    }
    setSelectedCols(new Set());
    setColMenu(null);
    await load();
    await refreshDatasets();
  };

  const handleStartRenameCol = (colIdx: number) => {
    setRenameCol({ colIdx, oldName: cols[colIdx], oldType: colTypes[colIdx] });
    setRenameValue(cols[colIdx]);
    setRenameType(colTypes[colIdx]);
    setColMenu(null);
  };

  const handleStartBatchColProps = () => {
    const indices = Array.from(selectedCols).sort((a, b) => a - b);
    if (indices.length === 0) return;
    setBatchColProps({ colIndices: indices, checkedCols: new Set(indices) });
    setBatchColType(colTypes[indices[0]] || "VARCHAR");
    setColMenu(null);
  };

  const handleApplyBatchColProps = async () => {
    if (!batchColProps) return;
    try {
      for (const ci of batchColProps.checkedCols) {
        if (colTypes[ci] !== batchColType) {
          await dataService.changeColumnType(datasetId, cols[ci], batchColType);
        }
      }
      await load();
      await refreshDatasets();
      setBatchColProps(null);
    } catch (e) {
      setErrorMsg(String(e));
    }
  };

  const handleRenameColumn = async () => {
    if (!renameCol || !renameValue.trim()) return;
    const nameChanged = renameValue.trim() !== renameCol.oldName;
    const typeChanged = renameType !== renameCol.oldType;
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
        await refreshDatasets();
      }
      setRenameCol(null);
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
    const row = data.rows[editRow] as unknown[];
    const rowId = getRowId(row);
    const colName = cols[editCol];
    try {
      await dataService.updateCell(datasetId, rowId, colName, editValue);
    } catch (e) {
      setErrorMsg(String(e));
    }
    await load();

    const maxRow = data.rows.length - 1;
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
    try {
      for (const { row, col } of cells) {
        const rawRow = data.rows[row] as unknown[];
        const rowId = getRowId(rawRow);
        const colName = cols[col];
        await dataService.updateCell(datasetId, rowId, colName, "");
      }
    } catch (e) {
      setErrorMsg(String(e));
    }
    await load();
  };

  // ---- Helper: find boundary of continuous data (Excel Ctrl+Arrow behavior) ----
  const findEdge = (row: number, col: number, dRow: number, dCol: number): { row: number; col: number } => {
    const maxRow = data.rows.length - 1;
    const maxCol = cols.length - 1;
    const getCellVal = (r: number, c: number): unknown => {
      const raw = data.rows[r] as unknown[];
      const display = getDisplayRow(raw);
      return display[c];
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

  // ---- Keyboard navigation ----
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (editCell) return; // Don't navigate while editing
    if (!activeCell) return;

    const { row, col } = activeCell;
    const maxRow = data.rows.length - 1;
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
        const displayRow = getDisplayRow(data.rows[row] as unknown[]);
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
    containerRef.current?.focus();

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
    const newSet = new Set(selectedRows);
    if (e.ctrlKey || e.metaKey) {
      if (newSet.has(rowIdx)) newSet.delete(rowIdx);
      else newSet.add(rowIdx);
    } else if (e.shiftKey && activeCell) {
      const start = Math.min(activeCell.row, rowIdx);
      const end = Math.max(activeCell.row, rowIdx);
      for (let i = start; i <= end; i++) newSet.add(i);
    } else {
      newSet.clear();
      newSet.add(rowIdx);
    }
    setSelectedRows(newSet);
    setSelectedCols(new Set());
    setSelection(null);
  };

  const handleRowHeaderMouseDown = (rowIdx: number, e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    if (!e.ctrlKey && !e.metaKey && !e.shiftKey) {
      setSelectedRows(new Set([rowIdx]));
      setSelectedCols(new Set());
      setSelection(null);
    }
    isDraggingRowRef.current = true;
    const anchorRow = rowIdx;
    document.body.style.userSelect = "none";

    const onMouseMove = (ev: MouseEvent) => {
      if (!isDraggingRowRef.current) return;
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
    // Single click on column header to select column
    const newSet = new Set(selectedCols);
    if (e.ctrlKey || e.metaKey) {
      if (newSet.has(colIdx)) newSet.delete(colIdx);
      else newSet.add(colIdx);
    } else if (e.shiftKey && selectedCols.size > 0) {
      const existing = Array.from(selectedCols);
      const anchor = existing[0];
      const start = Math.min(anchor, colIdx);
      const end = Math.max(anchor, colIdx);
      newSet.clear();
      for (let i = start; i <= end; i++) newSet.add(i);
    } else {
      newSet.clear();
      newSet.add(colIdx);
    }
    setSelectedCols(newSet);
    setSelectedRows(new Set());
    setSelection(null);
    setActiveCell({ row: activeCell?.row ?? 0, col: colIdx });
  };

  const handleColHeaderMouseDown = (colIdx: number, e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    if (!e.ctrlKey && !e.metaKey && !e.shiftKey) {
      setSelectedCols(new Set([colIdx]));
      setSelectedRows(new Set());
      setSelection(null);
    }
    isDraggingColRef.current = true;
    const anchorCol = colIdx;
    document.body.style.userSelect = "none";

    const onMouseMove = (ev: MouseEvent) => {
      if (!isDraggingColRef.current) return;
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

  // ---- Column resize (drag) ----
  const handleResizeStart = (e: React.MouseEvent, colIdx: number) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = colWidths[colIdx] ?? DEFAULT_COL_WIDTH;
    // Calculate offset: distance from mouse to the actual right border of the column
    const th = (e.target as HTMLElement).closest("th");
    const borderX = th ? th.getBoundingClientRect().right : startX;
    const offsetX = startX - borderX;
    resizingRef.current = { colIdx, startX, startW };

    const onMouseMove = (ev: MouseEvent) => {
      if (!resizingRef.current) return;
      const delta = ev.clientX - offsetX - resizingRef.current.startX;
      const newW = Math.max(DEFAULT_COL_WIDTH, resizingRef.current.startW + delta);
      setColWidths((prev) => {
        const next = [...prev];
        next[resizingRef.current!.colIdx] = newW;
        return next;
      });
    };

    const onMouseUp = () => {
      resizingRef.current = null;
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  };

  // ---- Double-click resize to auto-fit ----
  const handleResizeDoubleClick = (e: React.MouseEvent, colIdx: number) => {
    e.preventDefault();
    e.stopPropagation();
    if (!tableRef.current) return;
    // Measure max content width in this column
    const table = tableRef.current.querySelector("table");
    if (!table) return;
    const rows = table.querySelectorAll("tbody tr");
    let maxW = 0;
    rows.forEach((tr) => {
      // colIdx + 1 because first td is row header
      const td = tr.children[colIdx + 1] as HTMLElement | undefined;
      if (td) {
        const span = td.querySelector(".sp-val, .sp-null") as HTMLElement | null;
        if (span) maxW = Math.max(maxW, span.scrollWidth + 14); // 14 = padding
      }
    });
    // Also measure header text
    const headerCells = table.querySelectorAll("thead th.sp-col-hdr");
    const hdr = headerCells[colIdx] as HTMLElement | undefined;
    if (hdr) {
      const content = hdr.querySelector(".sp-col-hdr-content") as HTMLElement | null;
      if (content) maxW = Math.max(maxW, content.scrollWidth + 16);
    }
    // Enforce minimum = DEFAULT_COL_WIDTH
    const fitW = Math.max(DEFAULT_COL_WIDTH, maxW);
    setColWidths((prev) => {
      const next = [...prev];
      next[colIdx] = fitW;
      return next;
    });
  };

  return (
    <div className="sp-spreadsheet" onKeyDown={handleKeyDown} tabIndex={0} ref={containerRef}>

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
        <div className="sp-dialog-overlay" onClick={() => setRenameCol(null)}>
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
            </div>
            <div className="sp-dialog-actions">
              <button className="sp-dialog-btn" onClick={() => setRenameCol(null)}>取消</button>
              <button className="sp-dialog-btn sp-dialog-btn-primary" onClick={handleRenameColumn}>确定</button>
            </div>
          </div>
        </div>
      )}

      {/* Spreadsheet table */}
      <div className="sp-grid-wrapper" ref={tableRef}>
        <table className="sp-grid">
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
              <th className="sp-corner" />
              {/* Column headers */}
              {cols.map((col, ci) => (
                <th
                  key={ci}
                  className={`sp-col-hdr ${activeCell?.col === ci || (selection && (() => { const { c1, c2 } = normalizeRange(selection); return ci >= c1 && ci <= c2; })()) ? "sp-col-active" : ""} ${selectedCols.has(ci) ? "sp-col-selected" : ""}`}
                  onClick={(e) => handleColSelect(ci, e)}
                  onMouseDown={(e) => handleColHeaderMouseDown(ci, e)}
                  onContextMenu={(e) => handleColContextMenu(e, ci)}
                >
                  <div className="sp-col-hdr-content">
                    <span className="sp-col-letter">{colLetter(ci)}</span>
                    <span className="sp-col-name">{col}</span>
                    <span className="sp-col-type">{COLUMN_TYPES.find(t => t.value === colTypes[ci])?.label ?? colTypes[ci]}</span>
                  </div>
                  {/* Resize handle */}
                  <div
                    className="sp-resize-handle"
                    onMouseDown={(e) => handleResizeStart(e, ci)}
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
          <tbody>
            {data.rows.length > 0 && (
              data.rows.map((rawRow, ri) => {
                const displayRow = getDisplayRow(rawRow as unknown[]);
                const isSelected = selectedRows.has(ri);
                return (
                  <tr key={ri} className={isSelected ? "sp-row-selected" : ""}>
                    {/* Row number */}
                    <td
                      className={`sp-row-hdr ${activeCell?.row === ri || (selection && (() => { const { r1, r2 } = normalizeRange(selection); return ri >= r1 && ri <= r2; })()) ? "sp-row-active" : ""} ${selectedRows.has(ri) ? "sp-row-selected-hdr" : ""}`}
                      onClick={(e) => handleRowSelect(ri, e)}
                      onMouseDown={(e) => handleRowHeaderMouseDown(ri, e)}
                      onContextMenu={(e) => handleRowContextMenu(e, ri)}
                    >
                      {ri + 1}
                    </td>
                    {displayRow.map((cell, ci) => {
                      const isActive = activeCell?.row === ri && activeCell?.col === ci;
                      const isEditing = editCell?.row === ri && editCell?.col === ci;
                      return (
                        <td
                          key={ci}
                          data-row={ri}
                          data-col={ci}
                          className={`sp-cell ${isActive ? "sp-cell-active" : ""} ${isEditing ? "sp-cell-editing" : ""} ${inRange(ri, ci, selection) ? "sp-cell-selected" : ""}`}
                          onClick={(e) => handleCellClick(ri, ci, e)}
                          onMouseDown={(e) => handleCellMouseDown(ri, ci, e)}
                          onDoubleClick={() => handleCellDoubleClick(ri, ci, cell)}
                        >
                          <span className={cell == null ? "sp-null" : "sp-val"} style={isEditing ? { visibility: "hidden" } : undefined}>
                            {cell == null ? "" : String(cell)}
                          </span>
                          {isEditing && (
                            <input
                              ref={editInputRef}
                              className="sp-cell-input"
                              value={editValue}
                              onChange={(e) => setEditValue(e.target.value)}
                              onClick={(e) => e.stopPropagation()}
                              onMouseDown={(e) => e.stopPropagation()}
                              onDoubleClick={(e) => e.stopPropagation()}
                              onBlur={() => commitEdit("none")}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                  e.preventDefault();
                                  commitEdit("down");
                                } else if (e.key === "Escape") {
                                  cancelEdit();
                                } else if (e.key === "Tab") {
                                  e.preventDefault();
                                  commitEdit(e.shiftKey ? "left" : "right");
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
              })
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

      {/* Row context menu */}
      {rowMenu && (
        <div
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
        <div className="sp-dialog-overlay" onClick={() => setBatchColProps(null)}>
          <div className="sp-dialog sp-dialog-wide" onClick={(e) => e.stopPropagation()}>
            <div className="sp-dialog-title">批量列属性（{batchColProps.colIndices.length} 列）</div>
            <div className="sp-dialog-body">
              <label className="sp-dialog-label">列类型</label>
              <select className="sp-dialog-select" value={batchColType} onChange={(e) => setBatchColType(e.target.value)}>
                {COLUMN_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
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
