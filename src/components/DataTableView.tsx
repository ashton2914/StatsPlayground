import React, { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { dataService } from "@/services/dataService";
import type { TableQueryResult, ColumnDisplayProps } from "@/types/data";
import { EXTRA_DEFS, EXTRA_KINDS, type ExtraKind, summarizeExtraKinds, extraKindLabel, extraFieldLabel } from "@/types/columnExtras";
import { ManageExtrasDialog } from "./ManageExtrasDialog";
import type { TableOpType } from "./TableOpsDialog";
import { useDataStore } from "@/stores/useDataStore";
import { useProjectStore } from "@/stores/useProjectStore";
import { useHistoryStore } from "@/stores/useHistoryStore";
import { useTableZoomStore } from "@/stores/useTableZoomStore";
import { useTableSelectionStore } from "@/stores/useTableSelectionStore";
import { modKey, shiftKey } from "@/utils/platform";
import { ctxMenuRef } from "@/utils/ctxMenu";
import { copyThenClear } from "@/utils/tableClipboard";
import { TableWindowCache } from "@/utils/tableWindowCache";
import { calculatePlaceholderRange, canMaterializeSelection, calculateTableWindow, MAX_MATERIALIZED_SELECTION_ITEMS, RequestEpoch, serializeTableWindowFilters, windowRowAt } from "@/utils/tableViewport";
import { inferFieldType, type FieldRef, type GraphData } from "@/graphCore";
import { FilterPanel } from "@/components/filter";
import type { FilterRuleItem } from "@/types/filter";

interface DataTableViewProps {
  datasetId: string;
  onColumnRenamed?: (oldName: string, newName: string, sqlType: string) => void;
  /**
   * Open one of the JMP-style table operations (Summary / Subset / Sort /
   * Stack / Split / Transpose / Join / Update / Concatenate). Wired by the
   * Workspace so that the top-of-table toolbar can launch the same dialog
   * the legacy `Operations` menu used to launch. Optional so unit tests
   * and standalone renders still work without it.
   */
  onTableOp?: (op: TableOpType) => void;
}

const COLUMN_TYPE_VALUES = ["VARCHAR", "INTEGER", "BIGINT", "DOUBLE", "BOOLEAN", "DATE", "TIMESTAMP"] as const;
const typeLabel = (t: TFunction, v: string): string => t(`dataTable.type.${v}`, { defaultValue: v });
const typeLabelOf = (t: TFunction) => (v: string): string => typeLabel(t, v);

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

// Base (1.0×) dimensions. Inside the component, these are multiplied by
// the current table-zoom factor to produce the actual layout values used
// by virtualization math and column sizing. Stored column widths in
// `colWidths[]` are kept in base units so they remain stable across zoom
// changes; we scale when rendering and unscale when committing resizes.
const BASE_DEFAULT_COL_WIDTH = 120;
const BASE_ROW_HEIGHT = 27; // 26px cell height + 1px border
const BASE_ROW_HDR_WIDTH = 46;
const BASE_ADD_COL_WIDTH = 40;
const BASE_HEADER_HEIGHT = 48; // approximate sticky header height
const OVERSCAN = 10; // extra rows above/below viewport
const COLUMN_OVERSCAN = 4; // extra columns left/right of viewport
const TABLE_WINDOW_SIZE = 500;
const TABLE_CACHE_ROW_LIMIT = 5_000;

// Shared empty Set so resetting "selected rows/cols" to empty doesn't
// allocate a new reference every time and trigger downstream re-renders.
const EMPTY_NUM_SET: ReadonlySet<number> = new Set<number>();
// Stable empty set for `selectedCells` so identity-equality reset paths
// (and React.memo prop comparison) stay stable across renders. Each entry
// is the string `"row,col"` keyed by display-row index + column index — the
// same coordinate space used by `activeCell` and `selection`.
const EMPTY_CELL_SET: ReadonlySet<string> = new Set<string>();
const cellKey = (row: number, col: number) => `${row},${col}`;

type FormatKind = "asis" | "fixed" | "percent" | "scientific" | "currency";

interface ColumnFormat {
  kind: FormatKind;
  decimals?: number;
  currency?: string;
}

const FORMAT_KINDS: FormatKind[] = ["asis", "fixed", "percent", "scientific", "currency"];

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

// ---- Memoized row component ----
// Props are designed to be reference-stable when nothing in this row
// actually changed, so React.memo can skip re-renders.
interface TableRowProps {
  ri: number;
  displayRow: unknown[];
  colFormats: ColumnFormat[];
  isRowSelected: boolean;
  isRowActive: boolean;
  /** Active column index, or -1 if active cell is not in this row. */
  activeCol: number;
  selectedCols: ReadonlySet<number>;
  /** Column being edited in this row, or -1 if not editing this row. */
  editingCol: number;
  editValue: string;
  editInputRef: React.RefObject<HTMLInputElement | null>;
  /** Selection clamped to this row: -1/-1 if row is outside the selection. */
  selStartCol: number;
  selEndCol: number;
  /**
   * Set of column indices in THIS row that are individually selected via
   * Ctrl/Cmd+click (non-contiguous cell selection). Pass `undefined` when
   * the row has no Ctrl-selected cells so the prop stays referentially
   * stable (undefined === undefined) and React.memo doesn't re-render
   * unrelated rows whenever the global selectedCells Set changes.
   */
  selectedColsInRow?: ReadonlySet<number>;
  // Column virtualization window
  visStart: number;
  visEnd: number;
  leftSpacerW: number;
  rightSpacerW: number;
  onEditValueChange: (v: string) => void;
  onCommitEdit: (dir: "none" | "down" | "right" | "left") => void;
  onCancelEdit: () => void;
}

const TableRow = React.memo(function TableRow({
  ri, displayRow, colFormats, isRowSelected, isRowActive,
  activeCol, selectedCols, editingCol, editValue, editInputRef,
  selStartCol, selEndCol, selectedColsInRow,
  visStart, visEnd, leftSpacerW, rightSpacerW,
  onEditValueChange, onCommitEdit, onCancelEdit,
}: TableRowProps) {
  const totalCols = displayRow.length;
  const renderEnd = Math.min(visEnd, totalCols);
  const cells: React.ReactNode[] = [];
  for (let ci = visStart; ci < renderEnd; ci++) {
    const cell = displayRow[ci];
    const isColSelected = selectedCols.has(ci);
    const isCellActive = activeCol === ci && isRowActive && !isRowSelected && !isColSelected;
    const isCellEditing = editingCol === ci;
    const inRect = selStartCol >= 0 && ci >= selStartCol && ci <= selEndCol;
    const inDiscrete = selectedColsInRow ? selectedColsInRow.has(ci) : false;
    const isCellSelected = inRect || inDiscrete;
    cells.push(
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
  }
  return (
    <tr className={isRowSelected ? "sp-row-selected" : ""}>
      <td
        className={`sp-row-hdr${isRowActive ? " sp-row-active" : ""}${isRowSelected ? " sp-row-selected-hdr" : ""}`}
        data-row-hdr={ri}
      >
        {ri + 1}
      </td>
      {leftSpacerW > 0 && (
        <td className="sp-col-spacer" style={{ width: leftSpacerW, padding: 0, border: "none" }} aria-hidden="true" />
      )}
      {cells}
      {rightSpacerW > 0 && (
        <td className="sp-col-spacer" style={{ width: rightSpacerW, padding: 0, border: "none" }} aria-hidden="true" />
      )}
      <td className="sp-add-col-cell" />
    </tr>
  );
});

// ---- JMP-style ordered list editor for `valueList` extra fields ----
// Used inside ExtrasEditor when a kind declares a `valueList` field
// (currently only `valueOrder`). Behaves like JMP's Value Order custom list:
// add/remove/reorder items, reverse the whole list, clear it, or "pull from
// data" to seed the list with all unique values from the column in data
// order. The stored value is a string[]; downstream consumers (graph
// transform) read it and prepend matching values to the natural order.
interface ValueListEditorProps {
  values: string[];
  onChange: (next: string[]) => void;
  /** When provided, enables the "Pull from data" button. */
  getColumnUniqueValues?: () => string[];
}

const ValueListEditor = React.memo(function ValueListEditor({ values, onChange, getColumnUniqueValues }: ValueListEditorProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState("");

  const move = (i: number, di: number) => {
    const j = i + di;
    if (j < 0 || j >= values.length) return;
    const next = values.slice();
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  const remove = (i: number) => onChange(values.filter((_, k) => k !== i));
  const reverse = () => onChange(values.slice().reverse());
  const clear = () => onChange([]);
  const add = () => {
    const v = draft.trim();
    if (!v) return;
    if (values.includes(v)) { setDraft(""); return; }
    onChange([...values, v]);
    setDraft("");
  };
  const pull = () => {
    if (!getColumnUniqueValues) return;
    const uniq = getColumnUniqueValues();
    onChange(uniq);
  };

  return (
    <div className="sp-value-list">
      <div className="sp-value-list-toolbar">
        <button
          type="button"
          className="sp-value-list-toolbar-btn"
          onClick={pull}
          disabled={!getColumnUniqueValues}
          title={t("extras.valueOrder.pullFromDataTitle")}
        >{t("extras.valueOrder.pullFromData")}</button>
        <button
          type="button"
          className="sp-value-list-toolbar-btn"
          onClick={reverse}
          disabled={values.length < 2}
        >{t("extras.valueOrder.reverse")}</button>
        <button
          type="button"
          className="sp-value-list-toolbar-btn"
          onClick={clear}
          disabled={values.length === 0}
        >{t("extras.valueOrder.clear")}</button>
        {values.length > 0 && (
          <span style={{ marginLeft: "auto", alignSelf: "center", fontSize: 11, color: "var(--fg-hint)" }}>
            {t("extras.valueOrder.countSummary", { n: values.length })}
          </span>
        )}
      </div>
      <div className="sp-value-list-items">
        {values.length === 0 ? (
          <div className="sp-value-list-empty">{t("extras.valueOrder.empty")}</div>
        ) : (
          values.map((v, i) => (
            <div key={`${i}-${v}`} className="sp-value-list-item">
              <span className="sp-value-list-item-idx">{i + 1}.</span>
              <span className="sp-value-list-item-text" title={v}>{v === "" ? <em style={{ color: "var(--fg-hint)" }}>(empty)</em> : v}</span>
              <button
                type="button"
                className="sp-value-list-item-btn"
                onClick={() => move(i, -1)}
                disabled={i === 0}
                title={t("extras.valueOrder.moveUp")}
              >▲</button>
              <button
                type="button"
                className="sp-value-list-item-btn"
                onClick={() => move(i, 1)}
                disabled={i === values.length - 1}
                title={t("extras.valueOrder.moveDown")}
              >▼</button>
              <button
                type="button"
                className="sp-value-list-item-btn sp-value-list-item-remove"
                onClick={() => remove(i)}
                title={t("extras.valueOrder.remove")}
              >×</button>
            </div>
          ))
        )}
      </div>
      <div className="sp-value-list-add">
        <input
          className="sp-value-list-add-input"
          type="text"
          value={draft}
          placeholder={t("extras.valueOrder.addPlaceholder")}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); add(); }
          }}
        />
        <button
          type="button"
          className="sp-value-list-toolbar-btn"
          onClick={add}
          disabled={draft.trim() === ""}
        >{t("extras.valueOrder.add")}</button>
      </div>
      {values.length > 0 && (
        <div className="sp-value-list-hint">{t("extras.valueOrder.missingHint")}</div>
      )}
    </div>
  );
});

// ---- Column "Additional Properties" editor (used inside the column dialog) ----
// Lets the user attach optional kinds (unit / spec / range / notes / ...) to
// a single column. Each kind is defined in `EXTRA_DEFS`; this component
// renders one removable card per active kind plus an "+ Add" dropdown of the
// remaining kinds.
interface ExtrasEditorProps {
  extras: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  /**
   * Optional resolver that returns the unique values from the column being
   * edited (in data order). When provided, `valueList` fields gain a
   * "Pull from data" button.
   */
  getColumnUniqueValues?: () => string[];
}

const ExtrasEditor = React.memo(function ExtrasEditor({ extras, onChange, getColumnUniqueValues }: ExtrasEditorProps) {
  const { t } = useTranslation();
  const activeKinds = EXTRA_KINDS.filter((k) => extras[k] !== undefined);
  const remainingKinds = EXTRA_KINDS.filter((k) => extras[k] === undefined);

  const updateKindField = (kind: ExtraKind, key: string, raw: string, fieldType: string) => {
    const cur = (extras[kind] as Record<string, unknown> | undefined) ?? {};
    let value: unknown;
    if (fieldType === "number") {
      value = raw === "" ? null : Number(raw);
      if (typeof value === "number" && Number.isNaN(value)) value = null;
    } else {
      value = raw;
    }
    onChange({ ...extras, [kind]: { ...cur, [key]: value } });
  };

  const updateKindArrayField = (kind: ExtraKind, key: string, next: string[]) => {
    const cur = (extras[kind] as Record<string, unknown> | undefined) ?? {};
    onChange({ ...extras, [kind]: { ...cur, [key]: next } });
  };

  const removeKind = (kind: ExtraKind) => {
    const next = { ...extras };
    delete next[kind];
    onChange(next);
  };

  const addKind = (kind: ExtraKind) => {
    if (extras[kind] !== undefined) return;
    onChange({ ...extras, [kind]: EXTRA_DEFS[kind].defaultValue() });
  };

  return (
    <div className="sp-extras-editor">
      <div className="sp-extras-header">
        <span className="sp-extras-title">{t("extras.title")}</span>
        {remainingKinds.length > 0 && (
          <select
            className="sp-extras-add-select"
            value=""
            onChange={(e) => {
              const v = e.target.value as ExtraKind | "";
              if (v) addKind(v);
              e.currentTarget.value = "";
            }}
          >
            <option value="">{t("extras.addPlaceholder")}</option>
            {remainingKinds.map((k) => (
              <option key={k} value={k}>{extraKindLabel(k, t)}</option>
            ))}
          </select>
        )}
      </div>
      {activeKinds.length === 0 ? (
        <div className="sp-extras-empty">{t("extras.empty")}</div>
      ) : (
        activeKinds.map((kind) => {
          const def = EXTRA_DEFS[kind];
          const value = (extras[kind] as Record<string, unknown> | undefined) ?? {};
          return (
            <div key={kind} className="sp-extras-card">
              <div className="sp-extras-card-header">
                <span className="sp-extras-card-title">{extraKindLabel(kind, t)}</span>
                <button
                  type="button"
                  className="sp-extras-card-remove"
                  title={t("extras.removeOne")}
                  onClick={() => removeKind(kind)}
                >×</button>
              </div>
              <div className="sp-extras-card-body">
                {def.fields.map((f) => {
                  const raw = value[f.key];
                  const strVal = raw == null ? "" : String(raw);
                  return (
                    <div key={f.key} className="sp-extras-field-row">
                      <label className="sp-extras-field-label">{extraFieldLabel(kind, f.key, t)}</label>
                      {f.type === "longtext" ? (
                        <textarea
                          className="sp-dialog-input sp-extras-field-input"
                          rows={2}
                          value={strVal}
                          onChange={(e) => updateKindField(kind, f.key, e.target.value, f.type)}
                        />
                      ) : f.type === "valueList" ? (
                        <ValueListEditor
                          values={Array.isArray(raw) ? (raw as unknown[]).map((x) => String(x)) : []}
                          onChange={(next) => updateKindArrayField(kind, f.key, next)}
                          getColumnUniqueValues={getColumnUniqueValues}
                        />
                      ) : (
                        <input
                          className="sp-dialog-input sp-extras-field-input"
                          type={f.type === "number" ? "number" : "text"}
                          value={strVal}
                          onChange={(e) => updateKindField(kind, f.key, e.target.value, f.type)}
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })
      )}
    </div>
  );
});

// ---- Memoized columns side panel list ----
// Iterates every column (potentially hundreds) and previously re-rendered
// on every cell click because it lived inline in DataTableView. Behind
// React.memo + stable callback refs it bails out unless its data
// (cols / colTypes / selectedCols) actually changes.
interface ColsPanelListProps {
  cols: string[];
  colTypes: string[];
  selectedCols: ReadonlySet<number>;
  /** Per-column extras map (length matches cols); null means no extras. */
  colExtras: ReadonlyArray<Record<string, unknown> | null>;
  onItemClick: (colIdx: number, e: React.MouseEvent) => void;
  onItemContextMenu: (e: React.MouseEvent, colIdx: number) => void;
  /** Move the column at `from` to visible index `to` (drag-to-reorder). */
  onReorder: (from: number, to: number) => void;
}

const ColsPanelList = React.memo(function ColsPanelList({
  cols, colTypes, selectedCols, colExtras, onItemClick, onItemContextMenu, onReorder,
}: ColsPanelListProps) {
  const { t } = useTranslation();
  const labelOf = typeLabelOf(t);
  // Index of the row currently being dragged, and the row it is hovering over.
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);
  return (
    <div className="sp-cols-panel-list">
      {cols.map((name, ci) => {
        const tLabel = labelOf(colTypes[ci]);
        const isSel = selectedCols.has(ci);
        const extras = colExtras[ci];
        const extraSummary = extras ? summarizeExtraKinds(extras, t) : "";
        const extraCount = extras ? Object.keys(extras).length : 0;
        const isDragging = dragIdx === ci;
        const isDropTarget = overIdx === ci && dragIdx !== null && dragIdx !== ci;
        return (
          <div
            key={ci}
            className={`sp-cols-panel-item${isSel ? " sp-cols-panel-item-selected" : ""}${isDragging ? " sp-cols-panel-item-dragging" : ""}${isDropTarget ? " sp-cols-panel-item-dropbelow" : ""}`}
            onClick={(e) => onItemClick(ci, e)}
            onContextMenu={(e) => onItemContextMenu(e, ci)}
            onDragOver={(e) => {
              if (dragIdx === null) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              if (overIdx !== ci) setOverIdx(ci);
            }}
            onDrop={(e) => {
              e.preventDefault();
              if (dragIdx !== null && dragIdx !== ci) onReorder(dragIdx, ci);
              setDragIdx(null);
              setOverIdx(null);
            }}
            title={`${colLetter(ci)}  ${name}  (${tLabel})${extraSummary ? "\n" + t("dataTable.colsPanelExtraTooltip", { summary: extraSummary }) : ""}`}
          >
            <span className="sp-cols-panel-item-type">{tLabel}</span>
            <span className="sp-cols-panel-item-name">{name || t("dataTable.colsPanelItemFallback", { letter: colLetter(ci) })}</span>
            {extraCount > 0 && (
              <span className="sp-cols-panel-item-extras" title={t("dataTable.colsPanelExtraTooltip", { summary: extraSummary })}>
                📎{extraCount}
              </span>
            )}
            <span
              className="sp-cols-panel-item-drag"
              draggable
              title={t("dataTable.colsPanelDragHandle", { defaultValue: "Drag to reorder" })}
              onClick={(e) => e.stopPropagation()}
              onDragStart={(e) => {
                setDragIdx(ci);
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", String(ci));
              }}
              onDragEnd={() => { setDragIdx(null); setOverIdx(null); }}
            >☰</span>
          </div>
        );
      })}
    </div>
  );
});

// ---- Memoized Excel-like formula bar ----
// Owns its own input state (refValue / formulaValue / dirty flags) so typing
// in the bar does not trigger DataTableView re-renders. The parent only
// passes the active cell + its display value + a few stable callbacks; the
// bar re-renders only when those props change.
interface FormulaBarProps {
  activeCell: { row: number; col: number } | null;
  /** Active cell's display string (empty when none). */
  activeCellValue: string;
  maxRow: number;
  maxCol: number;
  /** Jump grid focus to (row, col). */
  onJumpToCell: (row: number, col: number) => void;
  /** Commit a value to the active cell. Returns true on success. */
  onWriteActiveCell: (value: string) => Promise<boolean>;
  /** Move focus to the active cell after Enter (one row down) when possible. */
  onMoveDownAfterCommit: () => void;
  onError: (msg: string) => void;
  onFocusGrid: () => void;
}

const FormulaBar = React.memo(function FormulaBar({
  activeCell, activeCellValue, maxRow, maxCol,
  onJumpToCell, onWriteActiveCell, onMoveDownAfterCommit, onError, onFocusGrid,
}: FormulaBarProps) {
  const { t } = useTranslation();
  const [refValue, setRefValue] = useState("");
  const [refDirty, setRefDirty] = useState(false);
  const [formulaValue, setFormulaValue] = useState("");
  const [formulaDirty, setFormulaDirty] = useState(false);

  // Sync ref input with active cell when not actively typed.
  useEffect(() => {
    if (refDirty) return;
    setRefValue(activeCell ? `${colLetter(activeCell.col)}${activeCell.row + 1}` : "");
  }, [activeCell, refDirty]);

  // Sync content input with active cell value when not actively typed.
  useEffect(() => {
    if (formulaDirty) return;
    setFormulaValue(activeCellValue);
  }, [activeCell, activeCellValue, formulaDirty]);

  return (
    <div className="sp-formula-bar">
      <input
        className="sp-formula-ref-input"
        type="text"
        value={refValue}
        placeholder="A1"
        spellCheck={false}
        onChange={(e) => { setRefValue(e.target.value); setRefDirty(true); }}
        onFocus={(e) => { e.currentTarget.select(); }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            const m = refValue.trim().toUpperCase().match(/^([A-Z]+)(\d+)$/);
            if (!m) {
              onError(t("dataTable.invalidCellRef", { ref: refValue }));
              return;
            }
            let col = 0;
            for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
            col -= 1;
            const row = parseInt(m[2], 10) - 1;
            if (col < 0 || col > maxCol || row < 0 || row > maxRow) {
              onError(t("dataTable.outOfRangeCellRef", { ref: refValue, max: `${colLetter(maxCol)}${maxRow + 1}` }));
              return;
            }
            setRefDirty(false);
            onJumpToCell(row, col);
            onFocusGrid();
          } else if (e.key === "Escape") {
            e.preventDefault();
            setRefDirty(false);
            setRefValue(activeCell ? `${colLetter(activeCell.col)}${activeCell.row + 1}` : "");
            onFocusGrid();
          }
        }}
        onBlur={() => {
          setRefDirty(false);
          setRefValue(activeCell ? `${colLetter(activeCell.col)}${activeCell.row + 1}` : "");
        }}
        title={t("dataTable.cellRefTitle")}
      />
      <input
        className="sp-formula-input"
        type="text"
        value={formulaValue}
        placeholder={activeCell ? "" : t("dataTable.selectCellPlaceholder")}
        disabled={!activeCell}
        onChange={(e) => { setFormulaValue(e.target.value); setFormulaDirty(true); }}
        onKeyDown={async (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            const ok = await onWriteActiveCell(formulaValue);
            if (ok) {
              setFormulaDirty(false);
              onMoveDownAfterCommit();
              onFocusGrid();
            }
          } else if (e.key === "Escape") {
            e.preventDefault();
            setFormulaDirty(false);
            setFormulaValue(activeCellValue);
            onFocusGrid();
          }
        }}
        onBlur={async () => {
          if (formulaDirty) {
            const ok = await onWriteActiveCell(formulaValue);
            if (ok) setFormulaDirty(false);
          }
        }}
      />
    </div>
  );
});

export function DataTableView({ datasetId, onColumnRenamed, onTableOp }: DataTableViewProps) {
  const { t } = useTranslation();
  const labelOf = useMemo(() => typeLabelOf(t), [t]);
  const [data, setData] = useState<TableQueryResult | null>(null);
  const [windowStart, setWindowStart] = useState(0);
  const [activeCell, setActiveCell] = useState<{ row: number; col: number } | null>(null);
  const [editCell, setEditCell] = useState<{ row: number; col: number } | null>(null);
  const [editValue, setEditValue] = useState("");
  const [selectedRows, setSelectedRows] = useState<ReadonlySet<number>>(EMPTY_NUM_SET);
  const [selectedCols, setSelectedCols] = useState<ReadonlySet<number>>(EMPTY_NUM_SET);
  // Non-contiguous, individually-toggled cells (Ctrl/Cmd+click on a cell).
  // Distinct from `selection` (rectangular range) and `selectedRows`
  // (whole-row sets). A cell is rendered "selected" if it falls inside the
  // rectangular range OR is present here. Keys are `"row,col"` in display
  // coordinates (same as activeCell / selection).
  const [selectedCells, setSelectedCells] = useState<ReadonlySet<string>>(EMPTY_CELL_SET);
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
  const [renameExtras, setRenameExtras] = useState<Record<string, unknown>>({});
  // "管理附加属性" dialog visibility — opened from the menu via a window
  // CustomEvent so DataTableView (which owns colExtras state) is the
  // single source of truth.
  const [showManageExtras, setShowManageExtras] = useState(false);
  const [batchColProps, setBatchColProps] = useState<{ colIndices: number[]; checkedCols: Set<number> } | null>(null);
  const [batchColType, setBatchColType] = useState("VARCHAR");
  const [batchColWidth, setBatchColWidth] = useState("");
  const [batchColFormat, setBatchColFormat] = useState<ColumnFormat>(DEFAULT_FORMAT);
  const [showInsertMultiRows, setShowInsertMultiRows] = useState(false);
  const [insertRowCount, setInsertRowCount] = useState("5");
  const [showInsertMultiCols, setShowInsertMultiCols] = useState(false);
  const [insertColCount, setInsertColCount] = useState("3");
  const [insertColType, setInsertColType] = useState("VARCHAR");
  // Visible index the multi-column insert should land after (null = append at
  // end). Captured when the dialog is opened from a column context menu.
  const [insertColAnchor, setInsertColAnchor] = useState<number | null>(null);
  const [colWidths, setColWidths] = useState<number[]>([]);
  const [colFormats, setColFormats] = useState<ColumnFormat[]>([]);
  const colFormatsRef = useRef<ColumnFormat[]>([]);
  colFormatsRef.current = colFormats;
  // Per-column "additional properties" (unit/spec/range/notes/...).
  // Same length as colFormats; entry is null when the column has no extras.
  const [colExtras, setColExtras] = useState<Array<Record<string, unknown> | null>>([]);
  const colExtrasRef = useRef<Array<Record<string, unknown> | null>>([]);
  colExtrasRef.current = colExtras;
  const [selection, setSelection] = useState<CellRange | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [scrollLeft, setScrollLeft] = useState(0);
  // rAF coalesce scroll updates: one state commit per animation frame instead
  // of one per scroll event (which can fire 60–120Hz on smooth wheels and was
  // a major source of full-table re-renders).
  const scrollRafRef = useRef<number | null>(null);
  const onGridScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (scrollRafRef.current != null) return;
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null;
      setScrollTop(el.scrollTop);
      setScrollLeft(el.scrollLeft);
    });
  }, []);
  const editInputRef = useRef<HTMLInputElement>(null);
  const addColInputRef = useRef<HTMLInputElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const tableRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const resizingRef = useRef<{ colIdx: number; startX: number; startW: number } | null>(null);
  const isDraggingRef = useRef(false);
  const didDragRef = useRef(false);
  // Ctrl/Cmd+drag on cells creates an additive rectangular region that
  // unions into selectedCells on mouseup. While the drag is in flight,
  // `pendingCtrlRect` is rendered as a live preview (merged into cellsByRow
  // so cells inside it show as selected without yet being committed).
  const isCtrlDraggingRef = useRef(false);
  const [pendingCtrlRect, setPendingCtrlRect] = useState<CellRange | null>(null);
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

  // Local Data Filter (shared module). Replaces the old per-column
  // popover filter. State held locally on the view; not persisted across
  // sessions for now — the dataset can shift indices arbitrarily and the
  // rules are cheap to re-add. Rule shape matches the Graph Builder so
  // future cross-view sharing is just a state lift.
  const [tableFilters, setTableFilters] = useState<FilterRuleItem[]>([]);
  const tableFiltersRef = useRef<FilterRuleItem[]>([]);
  tableFiltersRef.current = tableFilters;
  const [showTableFilters, setShowTableFilters] = useState(false);
  // Width of the FilterPanel column. Clamped at render time by the
  // splitter (see handler below). Same defaults as the Graph Builder.
  const [tableFilterWidth, setTableFilterWidth] = useState(260);

  // Left "Columns" panel (collapsible)
  const [colsPanelCollapsed, setColsPanelCollapsed] = useState(false);
  // Width of the left columns panel; user-resizable via the splitter on its
  // right edge. Clamped between 120 and 600 px.
  const [colsPanelWidth, setColsPanelWidth] = useState(200);
  const colsPanelAnchorRef = useRef<number | null>(null);

  // Excel-like formula bar state lives inside <FormulaBar /> now.

  const { refreshDatasets, setStatusInfo } = useDataStore();
  const { markDirty, readOnly } = useProjectStore();
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  const {
    record: recordHistory,
    recordTable,
    undo: historyUndo,
    redo: historyRedo,
    pendingRestore,
    historyRevision,
    historyError,
    pendingAction,
    tryBeginTableMutation,
    endTableMutation,
    clearPendingRestore,
    invalidateData,
  } = useHistoryStore();
  const zoom = useTableZoomStore((s) => s.zoom);
  const zoomIn = useTableZoomStore((s) => s.zoomIn);
  const zoomOut = useTableZoomStore((s) => s.zoomOut);
  const resetZoom = useTableZoomStore((s) => s.resetZoom);

  // Scaled layout dimensions. Stored column widths (`colWidths[]`) are kept
  // in base units (zoom-independent) and multiplied by `zoom` at render time
  // so resizing at 150% and viewing at 100% remain consistent.
  const ROW_HEIGHT = Math.max(1, Math.round(BASE_ROW_HEIGHT * zoom));
  const ROW_HDR_WIDTH = Math.max(1, Math.round(BASE_ROW_HDR_WIDTH * zoom));
  const ADD_COL_WIDTH = Math.max(1, Math.round(BASE_ADD_COL_WIDTH * zoom));
  const DEFAULT_COL_WIDTH = Math.max(1, Math.round(BASE_DEFAULT_COL_WIDTH * zoom));

  // Refs for tracking latest state (used by recordAction and pendingRestore)
  const dataRef = useRef<TableQueryResult | null>(null);
  const generationRef = useRef(0);
  const windowStartRef = useRef(0);
  const windowCacheRef = useRef<TableWindowCache | null>(null);
  const requestEpochRef = useRef<RequestEpoch | null>(null);
  const pendingWindowsRef = useRef<Set<string>>(new Set());
  const loadedFilterKeyRef = useRef("[]");
  const skipFilterReloadRef = useRef(false);
  if (!windowCacheRef.current) windowCacheRef.current = new TableWindowCache(TABLE_CACHE_ROW_LIMIT);
  if (!requestEpochRef.current) requestEpochRef.current = new RequestEpoch();
  const getTableCategoricalValues = useCallback(
    (field: string, search: string) => dataService.queryTableFilterValues(
      datasetId,
      field,
      search,
      500,
      generationRef.current,
    ),
    [datasetId],
  );
  const colWidthsRef = useRef<number[]>([]);
  if (data) dataRef.current = data;
  colWidthsRef.current = colWidths;

  useEffect(() => {
    if (!readOnly) return;
    const activeResize = resizingRef.current;
    if (!activeResize) return;
    resizingRef.current = null;
    setColWidths((previous) => {
      const next = [...previous];
      next[activeResize.colIdx] = activeResize.startW;
      colWidthsRef.current = next;
      return next;
    });
  }, [readOnly]);

  const refreshAndMarkDirty = useCallback(async () => {
    await refreshDatasets();
    markDirty();
  }, [refreshDatasets, markDirty]);

  // Window rows are not a complete dataset snapshot. Table history is
  // migrated to compact inverse operations in the next phase.
  const captureState = useCallback(() => {
    return undefined;
  }, []);

  // History recording — captures afterState for undo/redo
  const recordAction = useCallback((description: string) => {
    recordHistory(description, captureState());
  }, [recordHistory, captureState]);

  const load = useCallback(async (
    filters = tableFiltersRef.current,
    start = windowStartRef.current,
  ) => {
    const epoch = requestEpochRef.current!.advance();
    windowCacheRef.current!.clear();
    pendingWindowsRef.current.clear();
    const serializedFilters = serializeTableWindowFilters(filters);
    loadedFilterKeyRef.current = JSON.stringify(serializedFilters);
    try {
      const generation = await dataService.getDatasetGeneration(datasetId);
      const request = {
        datasetId,
        start,
        count: TABLE_WINDOW_SIZE,
        sort: null,
        filters: serializedFilters,
        generation,
      };
      const result = await dataService.queryTableWindow(request);
      if (!requestEpochRef.current!.isCurrent(epoch)) return;
      windowCacheRef.current!.put(request, result);
      const nextData: TableQueryResult = {
        columns: result.columns,
        columnTypes: result.columnTypes,
        rows: result.rows,
        totalRows: result.totalRows,
        page: 0,
        pageSize: result.rows.length,
      };
      generationRef.current = result.generation;
      windowStartRef.current = result.start;
      setWindowStart(result.start);
      setData(nextData);
      dataRef.current = nextData;
      // Load saved display props
      try {
        const props = await dataService.getColumnDisplayProps(datasetId);
        const visCount = result.columns.filter(c => c !== "_row_id").length;
        // Always rebuild the per-column arrays (even when props is empty), so
        // switching to a dataset with no saved props clears any state that
        // may have leaked from a previously-viewed dataset.
        const widths = Array.from({ length: visCount }, (_, i) => {
          const p = props.find(dp => dp.colIndex === i);
          return p?.width ?? BASE_DEFAULT_COL_WIDTH;
        });
        setColWidths(widths);
        colWidthsRef.current = widths;
        const formats = Array.from({ length: visCount }, (_, i) => {
          const p = props.find(dp => dp.colIndex === i);
          return p?.format ? { kind: p.format.kind as FormatKind, decimals: p.format.decimals, currency: p.format.currency } : DEFAULT_FORMAT;
        });
        setColFormats(formats);
        colFormatsRef.current = formats;
        const extras = Array.from({ length: visCount }, (_, i) => {
          const p = props.find(dp => dp.colIndex === i);
          const e = p?.extras;
          return e && Object.keys(e).length > 0 ? (e as Record<string, unknown>) : null;
        });
        setColExtras(extras);
        colExtrasRef.current = extras;
      } catch { /* ignore display prop load errors */ }
    } catch (e) {
      if (!requestEpochRef.current!.isCurrent(epoch)) return;
      console.error("Failed to load table:", e);
      setErrorMsg(String(e));
      setWindowStart(0);
      windowStartRef.current = 0;
      setData(null);
      dataRef.current = null;
    }
  }, [datasetId]);

  /** Save current display props to backend.
   *
   * Note: extras are read from `colExtrasRef` rather than passed in, so
   * existing call sites that only mutate widths/formats automatically
   * preserve the latest extras without needing to thread them through. */
  const syncDisplayProps = useCallback(async (widths: number[], formats: ColumnFormat[]) => {
    const props: ColumnDisplayProps[] = [];
    const extrasArr = colExtrasRef.current;
    const len = Math.max(widths.length, formats.length, extrasArr.length);
    for (let i = 0; i < len; i++) {
      const w = widths[i];
      const f = formats[i];
      const ex = extrasArr[i];
      const hasWidth = w !== undefined && w !== BASE_DEFAULT_COL_WIDTH;
      const hasFormat = f !== undefined && f.kind !== "asis";
      const hasExtras = ex != null && Object.keys(ex).length > 0;
      if (hasWidth || hasFormat || hasExtras) {
        props.push({
          colIndex: i,
          width: hasWidth ? w : undefined,
          format: hasFormat ? { kind: f.kind, decimals: f.decimals, currency: f.currency } : undefined,
          extras: hasExtras ? (ex as Record<string, unknown>) : undefined,
        });
      }
    }
    try {
      await dataService.setColumnDisplayProps(datasetId, props);
      invalidateData();
    } catch { /* ignore */ }
  }, [datasetId, invalidateData]);

  useEffect(() => {
    skipFilterReloadRef.current = true;
    tableFiltersRef.current = [];
    void load([], 0);
    setActiveCell(null);
    setEditCell(null);
    setSelectedRows(EMPTY_NUM_SET);
    setSelectedCols(EMPTY_NUM_SET);
    setSelectedCells(EMPTY_CELL_SET);
    setSelection(null);
    setColMenu(null);
    setRowMenu(null);
    setBatchColProps(null);
    setShowInsertMultiRows(false);
    setShowInsertMultiCols(false);
    setRenameCol(null);
    setShowAddCol(false);
    setTableFilters([]);
    setShowTableFilters(false);
  }, [datasetId, load]);

  useEffect(() => {
    if (skipFilterReloadRef.current) {
      skipFilterReloadRef.current = false;
      return;
    }
    const filterKey = JSON.stringify(serializeTableWindowFilters(tableFilters));
    if (filterKey === loadedFilterKeyRef.current) return;
    if (tableRef.current) tableRef.current.scrollTop = 0;
    setScrollTop(0);
    void load(tableFilters, 0);
  }, [tableFilters, load]);

  // Apply pending restore from history store (undo/redo/jumpTo)
  useEffect(() => {
    if (!pendingRestore) return;
    clearPendingRestore();
  }, [pendingRestore, clearPendingRestore]);

  useEffect(() => {
    if (historyError) setErrorMsg(historyError);
  }, [historyError]);

  useEffect(() => {
    if (historyRevision === 0) return;
    void load();
    void refreshAndMarkDirty();
  }, [historyRevision, load, refreshAndMarkDirty]);

  // Auto-scroll to keep activeCell visible (virtual scrolling) — both axes.
  useEffect(() => {
    if (!activeCell || !tableRef.current) return;
    const wrapper = tableRef.current;
    const headerH = Math.max(1, Math.round(BASE_HEADER_HEIGHT * zoom));
    const rowTop = activeCell.row * ROW_HEIGHT + headerH;
    const rowBottom = rowTop + ROW_HEIGHT;
    const viewTop = wrapper.scrollTop;
    const viewBottom = viewTop + wrapper.clientHeight;
    if (rowTop < viewTop + headerH) {
      wrapper.scrollTop = rowTop - headerH;
    } else if (rowBottom > viewBottom) {
      wrapper.scrollTop = rowBottom - wrapper.clientHeight;
    }
    // Horizontal: ensure activeCell column is visible (skip the sticky row hdr).
    const colLeft = ROW_HDR_WIDTH + (colOffsets[activeCell.col] ?? 0);
    const colRight = ROW_HDR_WIDTH + (colOffsets[activeCell.col + 1] ?? colLeft);
    const viewLeft = wrapper.scrollLeft;
    const viewRight = viewLeft + wrapper.clientWidth;
    if (colLeft < viewLeft + ROW_HDR_WIDTH) {
      wrapper.scrollLeft = colLeft - ROW_HDR_WIDTH;
    } else if (colRight > viewRight - ADD_COL_WIDTH) {
      wrapper.scrollLeft = colRight - wrapper.clientWidth + ADD_COL_WIDTH;
    }
  }, [activeCell]);

  // Auto-scroll to keep the selection's moving end visible (both axes).
  useEffect(() => {
    if (!selection || !tableRef.current) return;
    const wrapper = tableRef.current;
    const headerH = Math.max(1, Math.round(BASE_HEADER_HEIGHT * zoom));
    const rowTop = selection.endRow * ROW_HEIGHT + headerH;
    const rowBottom = rowTop + ROW_HEIGHT;
    const viewTop = wrapper.scrollTop;
    const viewBottom = viewTop + wrapper.clientHeight;
    if (rowTop < viewTop + headerH) {
      wrapper.scrollTop = rowTop - headerH;
    } else if (rowBottom > viewBottom) {
      wrapper.scrollTop = rowBottom - wrapper.clientHeight;
    }
    const colLeft = ROW_HDR_WIDTH + (colOffsets[selection.endCol] ?? 0);
    const colRight = ROW_HDR_WIDTH + (colOffsets[selection.endCol + 1] ?? colLeft);
    const viewLeft = wrapper.scrollLeft;
    const viewRight = viewLeft + wrapper.clientWidth;
    if (colLeft < viewLeft + ROW_HDR_WIDTH) {
      wrapper.scrollLeft = colLeft - ROW_HDR_WIDTH;
    } else if (colRight > viewRight - ADD_COL_WIDTH) {
      wrapper.scrollLeft = colRight - wrapper.clientWidth + ADD_COL_WIDTH;
    }
  }, [selection]);

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
      return Array.from({ length: visibleColCount }, (_, i) => prev[i] ?? BASE_DEFAULT_COL_WIDTH);
    });
    setColFormats((prev) => {
      if (prev.length === visibleColCount) return prev;
      return Array.from({ length: visibleColCount }, (_, i) => prev[i] ?? DEFAULT_FORMAT);
    });
    setColExtras((prev) => {
      if (prev.length === visibleColCount) return prev;
      return Array.from({ length: visibleColCount }, (_, i) => prev[i] ?? null);
    });
  }, [visibleColCount]);
  // Filter _row_id from display — memoized (must be before early return for hooks rules)
  const rowIdIdx = data ? data.columns.indexOf("_row_id") : -1;
  const cols = useMemo(() => data ? data.columns.filter((_, i) => i !== rowIdIdx) : [], [data, rowIdIdx]);
  const colTypes = useMemo(() => data ? data.columnTypes.filter((_, i) => i !== rowIdIdx) : [], [data, rowIdIdx]);

  // All rows stripped of _row_id (used by filter popover for unique values)
  const allRows = useMemo(() =>
    data ? data.rows.map((raw) => (raw as unknown[]).filter((_, i) => i !== rowIdIdx)) : [],
    [data, rowIdIdx]
  );

  // "Pull from data" resolver for the column-properties dialog's Value Order
  // editor: returns every unique value (in the order they first appear) from
  // the column being edited. Uses `allRows` (filters are an orthogonal
  // concern; the value-order list should cover the full vocabulary, not just
  // currently visible rows). MUST be declared after `allRows` to avoid the
  // useMemo callback closing over a TDZ binding (React would still invoke
  // it during render even if no rename dialog is open, throwing
  // "Cannot access 'allRows' before initialization").
  const renameUniqueValues = useMemo(() => {
    if (!renameCol) return undefined;
    const ci = renameCol.colIdx;
    return () => {
      const seen = new Set<string>();
      const out: string[] = [];
      for (const r of allRows) {
        const v = (r as unknown[])[ci];
        const s = v == null ? "" : String(v);
        if (!seen.has(s)) {
          seen.add(s);
          out.push(s);
        }
      }
      return out;
    };
  }, [renameCol, allRows]);

  // FieldRef metadata for each visible column. Used by FilterPanel to
  // route each rule to the right editor (continuous / categorical /
  // date) via `inferFieldType`. Recomputed only when names/types change.
  const tableFilterFields = useMemo<FieldRef[]>(
    () => cols.map((name, i) => ({ name, type: inferFieldType(colTypes[i] ?? "") })),
    [cols, colTypes],
  );

  // GraphData adapter — the shared FilterPanel + applyFilters speak the
  // graphCore { columns, rows } shape. `allRows` is already stripped of
  // `_row_id`, so this is just a re-shape, not a copy of the row arrays.
  const tableFilterData = useMemo<GraphData>(
    () => ({ columns: cols, rows: allRows }),
    [cols, allRows],
  );

  const displayRows = allRows;
  const displayRowAt = useCallback(
    (logicalIndex: number) => windowRowAt({ start: windowStart, rows: displayRows }, logicalIndex),
    [displayRows, windowStart],
  );

  const toDataIdx = useCallback((logicalIndex: number): number =>
    logicalIndex - windowStartRef.current,
    []);

  // ----- Cross-view cell pick (Graph → Table) -----------------------
  // The GraphBuilder writes a `{rowId, colName}` slot into
  // useTableSelectionStore whenever the user clicks a scatter point.
  // We consume it here: translate `rowId` → display-row index (going
  // through `data.rows`' `_row_id` column and then through the current
  // filter's index map), translate `colName` → visible column index,
  // then drive activeCell + selection so the existing auto-scroll
  // effect brings the cell into view.
  //
  // Re-runs when the pick OR the tick counter for this dataset changes
  // — the tick bump lets the user re-pick the same cell and still get
  // a fresh scroll-into-view (object identity alone wouldn't).
  // Filter changes also re-run so a previously-hidden row that becomes
  // visible after the user widens their filter gets selected.
  const pickedCell = useTableSelectionStore((s) => s.byDataset[datasetId] ?? null);
  const pickedTick = useTableSelectionStore((s) => s.ticks[datasetId] ?? 0);
  useEffect(() => {
    if (!pickedCell) return;
    if (!data || rowIdIdx < 0) return;
    let dataIdx = -1;
    const rows = data.rows as unknown[][];
    for (let i = 0; i < rows.length; i++) {
      if (Number(rows[i]?.[rowIdIdx]) === pickedCell.rowId) {
        dataIdx = i;
        break;
      }
    }
    const colIdx = cols.indexOf(pickedCell.colName);
    if (colIdx < 0) return;
    if (dataIdx < 0) {
      const epoch = requestEpochRef.current!.current;
      void dataService.locateTableRow(
        datasetId,
        pickedCell.rowId,
        serializeTableWindowFilters(tableFiltersRef.current),
        generationRef.current,
      ).then((logicalIndex) => {
        if (!requestEpochRef.current!.isCurrent(epoch) || logicalIndex == null) return;
        setActiveCell({ row: logicalIndex, col: colIdx });
        setSelection({
          startRow: logicalIndex,
          startCol: colIdx,
          endRow: logicalIndex,
          endCol: colIdx,
        });
      }).catch((error) => {
        if (requestEpochRef.current!.isCurrent(epoch)) setErrorMsg(String(error));
      });
      return;
    }
    const displayIdx = windowStart + dataIdx;
    setActiveCell({ row: displayIdx, col: colIdx });
    setSelection({ startRow: displayIdx, startCol: colIdx, endRow: displayIdx, endCol: colIdx });
    setSelectedRows(EMPTY_NUM_SET);
    setSelectedCols(EMPTY_NUM_SET);
    setSelectedCells(EMPTY_CELL_SET);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickedCell, pickedTick, data, rowIdIdx, cols, windowStart]);

  // ----- Cross-view multi-cell highlight (Graph brush → Table) --------
  // GraphBuilder writes an array of (rowId, colName) picks when the user
  // finishes a rubber-band drag over a scatter plot. Each scatter point
  // corresponds to one (row, column) cell, so we translate every pick
  // into `selectedCells` (non-contiguous cell selection model). Other
  // selection modes are cleared. The viewport is scrolled to the first
  // matched row so the result is visible immediately.
  const pickedCells = useTableSelectionStore((s) => s.cellsByDataset[datasetId] ?? null);
  const pickedCellsTick = useTableSelectionStore((s) => s.cellTicks[datasetId] ?? 0);
  useEffect(() => {
    if (!pickedCells || pickedCells.length === 0) {
      // Empty array = "clear" gesture (tiny rect with no points inside).
      if (pickedCells !== null) {
        setSelectedRows(EMPTY_NUM_SET);
        setSelectedCols(EMPTY_NUM_SET);
        setSelectedCells(EMPTY_CELL_SET);
        setActiveCell(null);
        setSelection(null);
      }
      return;
    }
    if (!data || rowIdIdx < 0) return;
    const rows = data.rows as unknown[][];
    // Pre-build a colName → colIdx lookup. `cols` already excludes
    // `_row_id`, so the resulting index is the display column index.
    const colIdxByName = new Map<string, number>();
    for (let i = 0; i < cols.length; i++) colIdxByName.set(cols[i], i);
    const cellSet = new Set<string>();
    let firstRow = Infinity;
    for (const pk of pickedCells) {
      const colIdx = colIdxByName.get(pk.colName);
      if (colIdx === undefined) continue;
      let dataIdx = -1;
      for (let i = 0; i < rows.length; i++) {
        if (Number(rows[i]?.[rowIdIdx]) === pk.rowId) { dataIdx = i; break; }
      }
      if (dataIdx < 0) continue;
      const displayIdx = windowStart + dataIdx;
      cellSet.add(cellKey(displayIdx, colIdx));
      if (displayIdx < firstRow) firstRow = displayIdx;
    }
    if (cellSet.size === 0) return;
    setSelectedCells(cellSet);
    setSelectedRows(EMPTY_NUM_SET);
    setSelectedCols(EMPTY_NUM_SET);
    setActiveCell(null);
    setSelection(null);
    // Scroll to the first selected row.
    const wrapper = tableRef.current;
    if (wrapper && firstRow !== Infinity) {
      const headerH = Math.max(1, Math.round(BASE_HEADER_HEIGHT * zoom));
      const rowTop = firstRow * ROW_HEIGHT + headerH;
      const rowBottom = rowTop + ROW_HEIGHT;
      const viewTop = wrapper.scrollTop;
      const viewBottom = viewTop + wrapper.clientHeight;
      if (rowTop < viewTop + headerH || rowBottom > viewBottom) {
        wrapper.scrollTop = rowTop - headerH;
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickedCells, pickedCellsTick, data, rowIdIdx, cols, windowStart]);

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
          const firstLoadedRow = Math.max(r1, windowStart);
          const lastLoadedRow = Math.min(r2, windowStart + displayRows.length - 1);
          for (let r = firstLoadedRow; r <= lastLoadedRow; r++)
            for (let c = c1; c <= c2; c++)
              vals.push(displayRowAt(r)?.[c]);
        }
      } else if (selectedRows.size > 0) {
        const colCount = cols.length;
        for (const ri of selectedRows)
          for (let c = 0; c < colCount; c++)
            vals.push(displayRowAt(ri)?.[c]);
      } else if (selectedCols.size > 0) {
        for (const row of displayRows)
          for (const ci of selectedCols)
            vals.push(row[ci]);
      }
      return vals;
    };

    const vals = collectValues();
    if (vals.length > 0) {
      const nonNull = vals.filter(v => v != null);
      const nums = nonNull.map(v => Number(v)).filter(n => !isNaN(n));
      if (nums.length > 0 && nums.length === nonNull.length) {
        // Compute sum/min/max in a single pass. We deliberately avoid
        // `Math.min(...nums)` / `Math.max(...nums)` because spreading a large
        // array as function arguments overflows the JS engine's argument
        // limit and throws `RangeError: Maximum call stack size exceeded`
        // once the selection covers more than ~10^5 numeric cells (easily
        // reachable on a 1000-column × 1000-row range select).
        let sum = 0;
        let min = Infinity;
        let max = -Infinity;
        for (let i = 0; i < nums.length; i++) {
          const n = nums[i];
          sum += n;
          if (n < min) min = n;
          if (n > max) max = n;
        }
        selectionStats = {
          count: nonNull.length,
          sum,
          avg: sum / nums.length,
          min,
          max,
        };
      } else {
        selectionStats = { count: nonNull.length };
      }
    }

    setStatusInfo({
      cellLabel: activeCell ? `${colLetter(activeCell.col)}${activeCell.row + 1}` : "",
      selectionLabel: selLabel,
      dimensions: tableFilters.length > 0
        ? t("dataTable.dimensionsFiltered", { shown: data.totalRows, total: data.totalRows, cols: visibleColCount })
        : t("dataTable.dimensions", { rows: data.totalRows, cols: visibleColCount }),
      selectionStats,
    });
  }, [activeCell, selection, selectedRows, selectedCols, data, displayRows, displayRowAt, cols, visibleColCount, setStatusInfo, tableFilters, t, windowStart]);

  // Precompute active row/col ranges for className computation.
  // Row/col headers light up for:
  //   - the active cell
  //   - any cell inside the contiguous `selection` rectangle
  //   - any cell inside the discrete `selectedCells` set (non-contiguous)
  //   - any cell inside the in-flight `pendingCtrlRect` (Ctrl+drag preview)
  // Whole-row / whole-column selections (`selectedRows`/`selectedCols`)
  // already light up their own headers via the dedicated `sp-row-selected-hdr`
  // / `sp-col-selected` classes, so we don't fold them in here.
  const activeRowRange = useMemo(() => {
    const set = new Set<number>();
    if (activeCell) set.add(activeCell.row);
    if (selection) {
      const { r1, r2 } = normalizeRange(selection);
      const firstLoadedRow = Math.max(r1, windowStart);
      const lastLoadedRow = Math.min(r2, windowStart + displayRows.length - 1);
      for (let i = firstLoadedRow; i <= lastLoadedRow; i++) set.add(i);
    }
    for (const key of selectedCells) {
      const ci = key.indexOf(",");
      if (ci < 0) continue;
      const r = Number(key.slice(0, ci));
      if (Number.isFinite(r)) set.add(r);
    }
    if (pendingCtrlRect) {
      const { r1, r2 } = normalizeRange(pendingCtrlRect);
      const firstLoadedRow = Math.max(r1, windowStart);
      const lastLoadedRow = Math.min(r2, windowStart + displayRows.length - 1);
      for (let i = firstLoadedRow; i <= lastLoadedRow; i++) set.add(i);
    }
    return set;
  }, [activeCell, selection, selectedCells, pendingCtrlRect, displayRows.length, windowStart]);

  const activeColRange = useMemo(() => {
    const set = new Set<number>();
    if (activeCell) set.add(activeCell.col);
    if (selection) {
      const { c1, c2 } = normalizeRange(selection);
      for (let i = c1; i <= c2; i++) set.add(i);
    }
    for (const key of selectedCells) {
      const ci = key.indexOf(",");
      if (ci < 0) continue;
      const c = Number(key.slice(ci + 1));
      if (Number.isFinite(c)) set.add(c);
    }
    if (pendingCtrlRect) {
      const { c1, c2 } = normalizeRange(pendingCtrlRect);
      for (let i = c1; i <= c2; i++) set.add(i);
    }
    return set;
  }, [activeCell, selection, selectedCells, pendingCtrlRect]);

  // Virtual scrolling: compute visible row range
  // wrapperSize is kept in state via ResizeObserver so virtualization recomputes
  // on container resize (instead of relying on a stale tableRef.current read).
  const [wrapperSize, setWrapperSize] = useState<{ width: number; height: number }>({ width: 1200, height: 600 });
  // Re-run when `data` flips from null → loaded, since the wrapper element with
  // ref={tableRef} is not mounted until then. Without this dep the observer
  // would attach to a null ref on first render and never observe the real
  // wrapper, leaving wrapperSize stuck at its initial 1200×600 and causing
  // the table to appear smaller than the window when maximized.
  useEffect(() => {
    const el = tableRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    // Seed with current size so virtualization is correct before the first
    // ResizeObserver callback fires.
    const initRect = el.getBoundingClientRect();
    setWrapperSize((prev) => (prev.width === initRect.width && prev.height === initRect.height ? prev : { width: initRect.width, height: initRect.height }));
    const obs = new ResizeObserver((entries) => {
      for (const ent of entries) {
        const r = ent.contentRect;
        setWrapperSize((prev) => (prev.width === r.width && prev.height === r.height ? prev : { width: r.width, height: r.height }));
      }
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, [data]);
  const wrapperHeight = wrapperSize.height;
  const wrapperWidth = wrapperSize.width;
  const headerHeight = Math.max(1, Math.round(BASE_HEADER_HEIGHT * zoom));
  const visibleAreaHeight = wrapperHeight - headerHeight;
  const totalRowCount = data?.totalRows ?? 0;
  const virtualRange = useMemo(() => {
    const startIdx = Math.max(0, Math.floor((scrollTop - headerHeight) / ROW_HEIGHT) - OVERSCAN);
    const visibleCount = Math.ceil(visibleAreaHeight / ROW_HEIGHT) + 2 * OVERSCAN;
    const endIdx = Math.min(totalRowCount, startIdx + visibleCount);
    return { startIdx, endIdx };
  }, [scrollTop, totalRowCount, visibleAreaHeight, headerHeight, ROW_HEIGHT]);
  const retainedRenderRange = useMemo(() => {
    const startIdx = Math.max(virtualRange.startIdx, windowStart);
    const endIdx = Math.min(virtualRange.endIdx, windowStart + displayRows.length);
    return endIdx > startIdx
      ? { startIdx, endIdx }
      : { startIdx: virtualRange.startIdx, endIdx: virtualRange.startIdx };
  }, [displayRows.length, virtualRange, windowStart]);
  const placeholderRange = useMemo(
    () => calculatePlaceholderRange(
      virtualRange.startIdx,
      virtualRange.endIdx,
      windowStart,
      displayRows.length,
    ),
    [displayRows.length, virtualRange, windowStart],
  );
  const renderedRange = placeholderRange ?? retainedRenderRange;

  useEffect(() => {
    if (!data || data.totalRows === 0) return;
    const range = calculateTableWindow({
      totalRows: data.totalRows,
      rowHeight: ROW_HEIGHT,
      scrollTop: Math.max(0, scrollTop - headerHeight),
      viewportHeight: visibleAreaHeight,
      overscanRows: OVERSCAN,
      pageSize: TABLE_WINDOW_SIZE,
    });
    if (range.count === 0) return;
    const request = {
      datasetId,
      ...range,
      sort: null,
      filters: serializeTableWindowFilters(tableFiltersRef.current),
      generation: generationRef.current,
    };
    const applyResult = (result: import("@/types/data").TableWindowResult) => {
      const nextData: TableQueryResult = {
        columns: result.columns,
        columnTypes: result.columnTypes,
        rows: result.rows,
        totalRows: result.totalRows,
        page: 0,
        pageSize: result.rows.length,
      };
      windowStartRef.current = result.start;
      setWindowStart(result.start);
      dataRef.current = nextData;
      setData(nextData);
    };
    const key = `${request.generation}:${request.start}:${request.count}:${loadedFilterKeyRef.current}`;
    const trackedRequest = requestEpochRef.current!.track(key);
    const cached = windowCacheRef.current!.get(request);
    if (cached) {
      if (cached.start !== windowStartRef.current) applyResult(cached);
      return;
    }
    if (pendingWindowsRef.current.has(key)) return;
    pendingWindowsRef.current.add(key);
    void dataService.queryTableWindow(request)
      .then((result) => {
        if (!requestEpochRef.current!.isCurrent(trackedRequest.epoch)) return;
        if (!windowCacheRef.current!.put(request, result)) return;
        if (!requestEpochRef.current!.isLatest(trackedRequest)) return;
        const assembled = windowCacheRef.current!.get(request);
        if (assembled) applyResult(assembled);
      })
      .catch((error) => {
        if (requestEpochRef.current!.isLatest(trackedRequest)) setErrorMsg(String(error));
      })
      .finally(() => pendingWindowsRef.current.delete(key));
  }, [data?.totalRows, datasetId, headerHeight, ROW_HEIGHT, scrollTop, visibleAreaHeight]);

  // Column virtualization: cumulative widths and visible column range.
  // Stored colWidths are in base (zoom-independent) units; scale on output.
  const colOffsets = useMemo(() => {
    const arr = new Array<number>(cols.length + 1);
    arr[0] = 0;
    for (let i = 0; i < cols.length; i++) {
      arr[i + 1] = arr[i] + (colWidths[i] ?? BASE_DEFAULT_COL_WIDTH) * zoom;
    }
    return arr;
  }, [cols.length, colWidths, zoom]);
  const totalColsWidth = colOffsets[cols.length] ?? 0;
  const colVirtRange = useMemo(() => {
    const totalCols = cols.length;
    if (totalCols === 0) return { startIdx: 0, endIdx: 0, leftSpacerW: 0, rightSpacerW: 0 };
    const viewportLeft = Math.max(0, scrollLeft - ROW_HDR_WIDTH);
    const viewportRight = viewportLeft + Math.max(0, wrapperWidth - ROW_HDR_WIDTH - ADD_COL_WIDTH);
    let startIdx = 0;
    while (startIdx < totalCols && colOffsets[startIdx + 1] <= viewportLeft) startIdx++;
    startIdx = Math.max(0, startIdx - COLUMN_OVERSCAN);
    let endIdx = startIdx;
    while (endIdx < totalCols && colOffsets[endIdx] < viewportRight) endIdx++;
    endIdx = Math.min(totalCols, endIdx + COLUMN_OVERSCAN);
    const leftSpacerW = colOffsets[startIdx];
    const rightSpacerW = totalColsWidth - colOffsets[endIdx];
    return { startIdx, endIdx, leftSpacerW, rightSpacerW };
  }, [scrollLeft, wrapperWidth, colOffsets, totalColsWidth, cols.length, ROW_HDR_WIDTH, ADD_COL_WIDTH]);
  // Build the visible column index list once (used by colgroup + thead).
  const visibleColIdxs = useMemo(() => {
    const arr: number[] = [];
    for (let i = colVirtRange.startIdx; i < colVirtRange.endIdx; i++) arr.push(i);
    return arr;
  }, [colVirtRange.startIdx, colVirtRange.endIdx]);
  // Normalized selection range (memoized once per selection change).
  const selRangeNorm = useMemo(() => selection ? normalizeRange(selection) : null, [selection]);

  // Bucket the discrete cell selection by row so each TableRow can receive a
  // referentially-stable per-row Set. Without this, every TableRow would have
  // to filter the global Set on every render, and React.memo would never
  // skip re-renders of rows that don't have any Ctrl-selected cells.
  // Returns a Map: rowIdx → Set<colIdx>. Lookup misses produce undefined,
  // which we pass straight to TableRow so untouched rows keep `undefined`
  // (a stable identity) as their prop.
  //
  // Also merges in the in-flight `pendingCtrlRect` (Ctrl+drag preview) so
  // cells inside the dragged rectangle render as selected before mouseup
  // commits them to selectedCells.
  const cellsByRow = useMemo(() => {
    if (selectedCells.size === 0 && !pendingCtrlRect) return null;
    const m = new Map<number, Set<number>>();
    for (const key of selectedCells) {
      const ci = key.indexOf(",");
      if (ci < 0) continue;
      const r = Number(key.slice(0, ci));
      const c = Number(key.slice(ci + 1));
      if (!Number.isFinite(r) || !Number.isFinite(c)) continue;
      let set = m.get(r);
      if (!set) {
        set = new Set<number>();
        m.set(r, set);
      }
      set.add(c);
    }
    if (pendingCtrlRect) {
      const { r1, c1, r2, c2 } = normalizeRange(pendingCtrlRect);
      for (let r = r1; r <= r2; r++) {
        let set = m.get(r);
        if (!set) {
          set = new Set<number>();
          m.set(r, set);
        }
        for (let c = c1; c <= c2; c++) set.add(c);
      }
    }
    return m;
  }, [selectedCells, pendingCtrlRect]);

  // Stable callback identities for memoized TableRow children — proxy to the
  // latest closures via refs so the props passed to <TableRow> never change
  // their reference between renders, allowing React.memo to skip rows that
  // haven't actually changed. Declared BEFORE the early return below so the
  // hook count stays constant across the data null → loaded transition.
  const commitEditRef = useRef<(dir: "none" | "down" | "right" | "left") => Promise<void> | void>(() => {});
  const cancelEditRef = useRef<() => void>(() => {});
  // When Escape cancels editing, the input unmounts and fires blur which would
  // otherwise commit the (already-discarded) value. This flag tells the next
  // commitEdit call to no-op exactly once.
  const suppressNextCommitRef = useRef(false);
  const stableCommitEdit = useCallback((dir: "none" | "down" | "right" | "left") => {
    return commitEditRef.current(dir);
  }, []);
  const stableCancelEdit = useCallback(() => {
    cancelEditRef.current();
  }, []);
  const stableSetEditValue = useCallback((v: string) => {
    setEditValue(v);
  }, []);

  // Stable proxy refs for the columns side panel so React.memo on ColsPanelList
  // can bail out across cell-click re-renders.
  const colsPanelClickRef = useRef<(colIdx: number, e: React.MouseEvent) => void>(() => {});
  const colsPanelCtxMenuRef = useRef<(e: React.MouseEvent, colIdx: number) => void>(() => {});
  const stableColsPanelClick = useCallback((colIdx: number, e: React.MouseEvent) => {
    colsPanelClickRef.current(colIdx, e);
  }, []);
  const stableColsPanelCtxMenu = useCallback((e: React.MouseEvent, colIdx: number) => {
    colsPanelCtxMenuRef.current(e, colIdx);
  }, []);
  const colsPanelReorderRef = useRef<(from: number, to: number) => void>(() => {});
  const stableColsPanelReorder = useCallback((from: number, to: number) => {
    colsPanelReorderRef.current(from, to);
  }, []);

  // Stable proxy refs for the formula bar so it can be memoized.
  const writeActiveCellRef = useRef<(value: string) => Promise<boolean>>(async () => false);
  const jumpToCellRef = useRef<(row: number, col: number) => void>(() => {});
  const moveDownAfterCommitRef = useRef<() => void>(() => {});
  const stableWriteActiveCell = useCallback((v: string) => writeActiveCellRef.current(v), []);
  const stableJumpToCell = useCallback((row: number, col: number) => {
    jumpToCellRef.current(row, col);
  }, []);
  const stableMoveDownAfterCommit = useCallback(() => {
    moveDownAfterCommitRef.current();
  }, []);
  const stableSetErrorMsg = useCallback((m: string) => setErrorMsg(m), []);
  const stableFocusGrid = useCallback(() => {
    containerRef.current?.focus();
  }, []);

  if (!data) return <div className="sp-loading">{errorMsg ?? t("dataTable.loading")}</div>;

  const getRowId = (row: unknown[]): number =>
    rowIdIdx >= 0 ? (row[rowIdIdx] as number) : 0;

  const getDisplayRow = (row: unknown[]): unknown[] =>
    (row as unknown[]).filter((_, i) => i !== rowIdIdx);

  // ---- Auto-generate column name ----
  const generateColName = (existingNames: string[]): string => {
    const nameSet = new Set(existingNames);
    let i = 1;
    while (nameSet.has(t("dataTable.colNameFallback", { n: i }))) i++;
    return t("dataTable.colNameFallback", { n: i });
  };

  // ---- Undo / Redo (unified with history store) ----
  const handleUndo = () => {
    historyUndo();
  };

  const handleRedo = () => {
    historyRedo();
  };

  // ---- Row operations ----
  const addRowsWithHistory = async (count: number, description: string) => {
    if (!tryBeginTableMutation()) return false;
    try {
      const result = await dataService.addRows(datasetId, count);
      recordTable(description, {
        kind: "addedRows",
        datasetId,
        generation: result.generation,
        rowIds: result.rowIds,
      });
      await load();
      await refreshAndMarkDirty();
      return true;
    } catch (error) {
      setErrorMsg(String(error));
      return false;
    } finally {
      endTableMutation();
    }
  };

  const handleAddRow = async () => {
    if (readOnly) return;
    await addRowsWithHistory(1, t("history.addRow"));
  };

  const handleInsertMultiRows = async () => {
    if (readOnly) return;
    if (pendingAction) return;
    const count = parseInt(insertRowCount, 10);
    if (isNaN(count) || count < 1) return;
    const added = await addRowsWithHistory(count, t("history.addRowsBatch"));
    if (!added) return;
    setShowInsertMultiRows(false);
    setInsertRowCount("5");
  };

  const handleDeleteRows = async () => {
    if (readOnly) return;
    if (pendingAction) return;
    if (selectedRows.size === 0) return;
    if ([...selectedRows].some((rowIdx) => !displayRowAt(rowIdx))) {
      setErrorMsg(t("dataTable.unloadedRangeUnsupported", {
        defaultValue: "This operation requires rows outside the loaded window.",
      }));
      return;
    }
    const rowIds = Array.from(selectedRows, (rowIdx) =>
      getRowId(data.rows[toDataIdx(rowIdx)] as unknown[]),
    );
    if (!tryBeginTableMutation()) return;
    try {
      const generation = await dataService.getDatasetGeneration(datasetId);
      const changeSetId = await dataService.deleteRowsWithChangeSet(
        datasetId,
        rowIds,
        generation,
      );
      recordTable(t("history.deleteRow"), { kind: "changeSet", datasetId, changeSetId });
      setSelectedRows(EMPTY_NUM_SET);
      setRowMenu(null);
      await load();
      await refreshAndMarkDirty();
    } catch (error) {
      setErrorMsg(String(error));
      return;
    } finally {
      endTableMutation();
    }
  };

  const handleDeleteSingleRow = async (rowIdx: number) => {
    if (readOnly) return;
    if (pendingAction) return;
    const row = data.rows[toDataIdx(rowIdx)] as unknown[];
    if (!row) {
      setErrorMsg(t("dataTable.unloadedRangeUnsupported", {
        defaultValue: "This operation requires rows outside the loaded window.",
      }));
      return;
    }
    if (!tryBeginTableMutation()) return;
    try {
      const generation = await dataService.getDatasetGeneration(datasetId);
      const changeSetId = await dataService.deleteRowsWithChangeSet(
        datasetId,
        [getRowId(row)],
        generation,
      );
      recordTable(t("history.deleteRow"), { kind: "changeSet", datasetId, changeSetId });
      setRowMenu(null);
      await load();
      await refreshAndMarkDirty();
    } catch (error) {
      setErrorMsg(String(error));
      return;
    } finally {
      endTableMutation();
    }
  };

  const handleInsertRowAbove = async () => {
    if (readOnly) return;
    if (pendingAction) return;
    const added = await addRowsWithHistory(1, t("history.insertRow"));
    if (!added) return;
    setRowMenu(null);
  };

  // ---- Column operations ----
  const addColumnWithHistory = async (
    name: string,
    columnType: string,
    atIndex: number | null,
    description: string,
  ) => {
    if (!tryBeginTableMutation()) return false;
    try {
      const generation = await dataService.getDatasetGeneration(datasetId);
      const changeSetId = await dataService.addColumnWithChangeSet(
        datasetId,
        name,
        columnType,
        atIndex,
        generation,
      );
      recordTable(description, { kind: "changeSet", datasetId, changeSetId });
      await load();
      await refreshAndMarkDirty();
      return true;
    } catch (error) {
      setErrorMsg(String(error));
      return false;
    } finally {
      endTableMutation();
    }
  };

  const handleAddColumnQuick = async () => {
    if (readOnly) return;
    if (pendingAction) return;
    const name = generateColName(cols);
    await addColumnWithHistory(name, "VARCHAR", null, t("history.addColumn"));
  };

  // Insert a single blank column immediately after the given visible index
  // (used by the column header context menu so "insert column" lands next to
  // the right-clicked column instead of at the far end).
  const handleInsertColumnAfter = async (index: number) => {
    if (readOnly) return;
    if (pendingAction) return;
    const name = generateColName(cols);
    const added = await addColumnWithHistory(
      name,
      "VARCHAR",
      index + 1,
      t("history.addColumn"),
    );
    if (!added) return;
    setColMenu(null);
  };

  const handleAddColumn = async () => {
    if (readOnly) return;
    if (pendingAction) return;
    const name = newColName.trim();
    if (!name) return;
    const added = await addColumnWithHistory(
      name,
      newColType,
      null,
      t("history.addColumnNamed", { name }),
    );
    if (!added) return;
    setShowAddCol(false);
    setNewColName("");
    setNewColType("VARCHAR");
  };

  const handleInsertMultiCols = async () => {
    if (readOnly) return;
    if (pendingAction) return;
    const count = parseInt(insertColCount, 10);
    if (isNaN(count) || count < 1) return;
    const anchor = insertColAnchor;
    const currentNames = [...cols];
    const columns: Array<{ name: string; columnType: string }> = [];
    for (let i = 0; i < count; i++) {
      const name = generateColName(currentNames);
      const at = anchor == null ? currentNames.length : anchor + 1 + i;
      currentNames.splice(at, 0, name);
      columns.push({ name, columnType: insertColType });
    }
    if (!tryBeginTableMutation()) return;
    try {
      const generation = await dataService.getDatasetGeneration(datasetId);
      const changeSetId = await dataService.addColumnsWithChangeSet(
        datasetId,
        columns,
        anchor == null ? null : anchor + 1,
        generation,
      );
      recordTable(t("history.addColumnsBatch"), {
        kind: "changeSet",
        datasetId,
        changeSetId,
      });
      await load();
      await refreshAndMarkDirty();
    } catch (error) {
      setErrorMsg(String(error));
      return;
    } finally {
      endTableMutation();
    }
    setShowInsertMultiCols(false);
    setInsertColCount("3");
    setInsertColType("VARCHAR");
    setInsertColAnchor(null);
  };

  // Reorder a column by dragging its handle in the COLUMNS side panel.
  // `from`/`to` are visible column indices; the backend renumbers col_index
  // and remaps any stored display props so widths/formats/extras follow.
  const handleColsPanelReorder = async (from: number, to: number) => {
    if (readOnly) return;
    if (pendingAction) return;
    if (from === to) return;
    if (!tryBeginTableMutation()) return;
    try {
      const expectedGeneration = await dataService.getDatasetGeneration(datasetId);
      const generation = await dataService.reorderColumnIfGeneration(
        datasetId,
        from,
        to,
        expectedGeneration,
      );
      recordTable(t("history.reorderColumn", { defaultValue: "Reorder columns" }), {
        kind: "reorderColumns",
        datasetId,
        generation,
        from,
        to,
      });
      setSelectedCols(EMPTY_NUM_SET);
      await load();
      await refreshAndMarkDirty();
    } catch (error) {
      setErrorMsg(String(error));
    } finally {
      endTableMutation();
    }
  };

  const handleDeleteColumn = async (colName: string) => {
    if (readOnly) return;
    if (pendingAction) return;
    if (cols.length <= 1) return;
    if (!tryBeginTableMutation()) return;
    try {
      const generation = await dataService.getDatasetGeneration(datasetId);
      const changeSetId = await dataService.deleteColumnsWithChangeSet(
        datasetId,
        [colName],
        generation,
      );
      recordTable(t("history.deleteColumnNamed", { name: colName }), {
        kind: "changeSet",
        datasetId,
        changeSetId,
      });
      setColMenu(null);
      await load();
      await refreshAndMarkDirty();
    } catch (error) {
      setErrorMsg(String(error));
    } finally {
      endTableMutation();
    }
  };

  const handleDeleteSelectedCols = async () => {
    if (readOnly) return;
    if (pendingAction) return;
    if (selectedCols.size === 0) return;
    if (cols.length - selectedCols.size < 1) {
      setErrorMsg(t("dataTable.cantDeleteAllCols"));
      setColMenu(null);
      return;
    }
    const columnNames = Array.from(selectedCols)
      .sort((left, right) => left - right)
      .map((columnIndex) => cols[columnIndex]);
    if (!tryBeginTableMutation()) return;
    try {
      const generation = await dataService.getDatasetGeneration(datasetId);
      const changeSetId = await dataService.deleteColumnsWithChangeSet(
        datasetId,
        columnNames,
        generation,
      );
      recordTable(t("history.deleteColumn"), {
        kind: "changeSet",
        datasetId,
        changeSetId,
      });
      setSelectedCols(EMPTY_NUM_SET);
      setColMenu(null);
      await load();
      await refreshAndMarkDirty();
    } catch (error) {
      setErrorMsg(String(error));
    } finally {
      endTableMutation();
    }
  };

  const handleStartRenameCol = (colIdx: number) => {
    setRenameCol({ colIdx, oldName: cols[colIdx], oldType: colTypes[colIdx] });
    setRenameValue(cols[colIdx]);
    setRenameType(colTypes[colIdx]);
    // Stored width is in base (1×) units; show as visual width at current zoom.
    setRenameWidth(String(Math.round((colWidths[colIdx] ?? BASE_DEFAULT_COL_WIDTH) * zoom)));
    setRenameFormat(colFormats[colIdx] ?? DEFAULT_FORMAT);
    const ex = colExtras[colIdx];
    setRenameExtras(ex ? { ...ex } : {});
    setColMenu(null);
  };

  const handleStartBatchColProps = () => {
    const indices = Array.from(selectedCols).sort((a, b) => a - b);
    if (indices.length === 0) return;
    setBatchColProps({ colIndices: indices, checkedCols: new Set(indices) });
    setBatchColType(colTypes[indices[0]] || "VARCHAR");
    // Stored width is in base (1×) units; show as visual width at current zoom.
    setBatchColWidth(String(Math.round((colWidths[indices[0]] ?? BASE_DEFAULT_COL_WIDTH) * zoom)));
    setBatchColFormat(colFormats[indices[0]] ?? DEFAULT_FORMAT);
    setColMenu(null);
  };

  const handleApplyBatchColProps = async () => {
    if (readOnly) return;
    if (pendingAction) return;
    if (!batchColProps) return;
    // Apply column widths — user-entered value is visual; store as base.
    const visualW = Math.max(DEFAULT_COL_WIDTH, Math.round(Number(batchColWidth) || DEFAULT_COL_WIDTH));
    const newW = Math.max(BASE_DEFAULT_COL_WIDTH, Math.round(visualW / zoom));
    const newWidths = [...colWidths];
    for (const ci of batchColProps.checkedCols) {
      newWidths[ci] = newW;
    }
    setColWidths(newWidths);
    colWidthsRef.current = newWidths;
    // Apply column formats
    const newFormats = [...colFormats];
    for (const ci of batchColProps.checkedCols) {
      newFormats[ci] = { ...batchColFormat };
    }
    setColFormats(newFormats);
    colFormatsRef.current = newFormats;
    // Sync display props to backend
    syncDisplayProps(newWidths, newFormats);
    markDirty();
    const changedColumnNames = Array.from(batchColProps.checkedCols)
      .filter((columnIndex) => colTypes[columnIndex] !== batchColType)
      .map((columnIndex) => cols[columnIndex]);
    const hasSchemaChanges = changedColumnNames.length > 0;
    if (hasSchemaChanges && !tryBeginTableMutation()) return;
    try {
      if (hasSchemaChanges) {
        const generation = await dataService.getDatasetGeneration(datasetId);
        const changeSetId = await dataService.alterColumnsTypeWithChangeSet(
          datasetId,
          changedColumnNames,
          batchColType,
          generation,
        );
        recordTable(t("history.modifyColumnProps"), {
          kind: "changeSet",
          datasetId,
          changeSetId,
        });
      } else {
        recordAction(t("history.modifyColumnProps"));
      }
      await load();
      await refreshAndMarkDirty();
      setBatchColProps(null);
    } catch (e) {
      setErrorMsg(String(e));
    } finally {
      if (hasSchemaChanges) endTableMutation();
    }
  };

  /** Apply the result of the manage-extras batch dialog. Replaces the entire
   *  per-column extras array, syncs to backend, marks dirty, records history. */
  const handleApplyManageExtras = (next: Array<Record<string, unknown> | null>) => {
    if (readOnly) return;
    setColExtras(next);
    colExtrasRef.current = next;
    syncDisplayProps(colWidthsRef.current, colFormatsRef.current);
    markDirty();
    recordAction(t("history.modifyExtrasBatch"));
  };

  const handleRenameColumn = async () => {
    if (readOnly) return;
    if (pendingAction) return;
    if (!renameCol || !renameValue.trim()) return;
    const nameChanged = renameValue.trim() !== renameCol.oldName;
    const typeChanged = renameType !== renameCol.oldType;
    // Apply column width — user-entered value is visual; store as base.
    const visualW = Math.max(DEFAULT_COL_WIDTH, Math.round(Number(renameWidth) || DEFAULT_COL_WIDTH));
    const newW = Math.max(BASE_DEFAULT_COL_WIDTH, Math.round(visualW / zoom));
    const newWidths = [...colWidths];
    newWidths[renameCol.colIdx] = newW;
    setColWidths(newWidths);
    colWidthsRef.current = newWidths;
    // Apply column format
    const newFormats = [...colFormats];
    newFormats[renameCol.colIdx] = { ...renameFormat };
    setColFormats(newFormats);
    colFormatsRef.current = newFormats;
    // Apply column extras (additional properties)
    const newExtras = [...colExtras];
    const cleanedExtras = Object.keys(renameExtras).length > 0 ? { ...renameExtras } : null;
    newExtras[renameCol.colIdx] = cleanedExtras;
    setColExtras(newExtras);
    colExtrasRef.current = newExtras;
    // Sync display props to backend
    syncDisplayProps(newWidths, newFormats);
    markDirty();
    try {
      if (nameChanged || typeChanged) {
        if (!tryBeginTableMutation()) return;
        const generation = await dataService.getDatasetGeneration(datasetId);
        const changeSetId = await dataService.alterColumnWithChangeSet(
          datasetId,
          renameCol.oldName,
          renameValue.trim(),
          renameType,
          generation,
        );
        recordTable(t("history.modifyColumnProps"), {
          kind: "changeSet",
          datasetId,
          changeSetId,
        });
        if (nameChanged) {
          onColumnRenamed?.(renameCol.oldName, renameValue.trim(), renameType);
        }
        await load();
        await refreshAndMarkDirty();
      } else {
        recordAction(t("history.modifyColumnProps"));
      }
      setRenameCol(null);
    } catch (e) {
      setErrorMsg(String(e));
    } finally {
      if (nameChanged || typeChanged) endTableMutation();
    }
  };

  // ---- Cell operations ----
  const handleCellClick = (row: number, col: number, e?: React.MouseEvent) => {
    // If a drag just finished, don't override selection
    if (didDragRef.current) {
      didDragRef.current = false;
      return;
    }
    // Ctrl/Cmd+click on a cell is handled in handleCellMouseDown as a
    // cell-level toggle (non-contiguous cell selection). The click event
    // that follows mousedown must NOT fall through to the default branch
    // below, or it would call setSelectedCells(EMPTY_CELL_SET) and wipe
    // the toggle. We check the modifier directly instead of relying on a
    // time-based flag (suppressSelectionRef + rAF) because the rAF can
    // fire before the click event when React is busy rendering between
    // rapid clicks.
    if (e && (e.ctrlKey || e.metaKey)) return;
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
    setSelectedRows(EMPTY_NUM_SET);
    setSelectedCols(EMPTY_NUM_SET);
    setSelectedCells(EMPTY_CELL_SET);
    setColMenu(null);
    setRowMenu(null);
    setCornerSelected(false);
    // Focus the container so keyboard events fire
    containerRef.current?.focus();
  };

  const handleCellDoubleClick = (row: number, col: number, value: unknown) => {
    if (readOnly) return;
    setActiveCell({ row, col });
    setEditCell({ row, col });
    setEditValue(value == null ? "" : String(value));
  };

  // ---- Cell value validation ----
  const validateCellValue = (value: string, colType: string): string | null => {
    if (value === "") return null; // Empty is always ok (NULL)
    switch (colType) {
      case "INTEGER": {
        if (!/^-?\d+$/.test(value.trim())) return t("dataTable.validInteger", { value });
        return null;
      }
      case "DOUBLE": {
        if (isNaN(Number(value.trim())) || value.trim() === "") return t("dataTable.validNumber", { value });
        return null;
      }
      case "BOOLEAN": {
        const v = value.trim().toLowerCase();
        if (!["true", "false", "1", "0", "yes", "no"].includes(v)) return t("dataTable.validBoolean", { value });
        return null;
      }
      case "DATE": {
        if (isNaN(Date.parse(value.trim()))) return t("dataTable.validDate", { value });
        return null;
      }
      case "TIMESTAMP": {
        if (isNaN(Date.parse(value.trim()))) return t("dataTable.validTimestamp", { value });
        return null;
      }
      default:
        return null; // VARCHAR etc. accepts anything
    }
  };

  const commitEdit = async (direction: "none" | "down" | "right" | "left" = "none") => {
    if (suppressNextCommitRef.current) {
      suppressNextCommitRef.current = false;
      return;
    }
    if (!editCell) return;
    if (pendingAction) return;
    const { row: editRow, col: editCol } = editCell;
    const colType = colTypes[editCol];
    const err = validateCellValue(editValue, colType);
    if (err) {
      setErrorMsg(err);
      return; // Don't commit, keep editing
    }
    setEditCell(null);
    const dataIdx = toDataIdx(editRow);
    const row = data.rows[dataIdx] as unknown[];
    if (!row) {
      setErrorMsg(t("dataTable.unloadedRangeUnsupported", {
        defaultValue: "This operation requires rows outside the loaded window.",
      }));
      return;
    }
    const rowId = getRowId(row);
    const colName = cols[editCol];
    const rawColIdx = editCol >= rowIdIdx ? editCol + 1 : editCol;
    const beforeValue = row[rawColIdx];

    // Optimistic UI update — immediately reflect new value, no flash
    const newData = { ...data, rows: [...data.rows] };
    const newRow = [...(newData.rows[dataIdx] as unknown[])];
    // Column index in raw row = editCol offset by _row_id position
    newRow[rawColIdx] = editValue === "" ? null : editValue;
    newData.rows[dataIdx] = newRow;

    if (!tryBeginTableMutation()) return;
    try {
      setData(newData);
      dataRef.current = newData;
      await dataService.updateCell(datasetId, rowId, colName, editValue);
      markDirty();
      await load();
      recordTable(t("history.editCell"), {
        kind: "cells",
        datasetId,
        generation: generationRef.current,
        cells: [{
          rowId,
          columnName: colName,
          before: beforeValue,
          after: editValue === "" ? null : editValue,
        }],
      });
    } catch (e) {
      setErrorMsg(String(e));
      await load(); // Revert on error
      return;
    } finally {
      endTableMutation();
    }

    const maxRow = data.totalRows - 1;
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
    // Mark so the imminent input blur (caused by unmount) won't commit.
    suppressNextCommitRef.current = true;
    setEditCell(null);
    tabAnchorColRef.current = null;
    containerRef.current?.focus();
  };

  // Wire up the stable proxy refs (declared before the early return so
  // hook order stays consistent across data null → loaded transitions).
  commitEditRef.current = commitEdit;
  cancelEditRef.current = cancelEdit;

  // ---- Write a value to the active cell from the formula bar ----
  const writeActiveCellValue = async (value: string) => {
    if (readOnly) return false;
    if (!activeCell) return;
    const { row: editRow, col: editCol } = activeCell;
    const colType = colTypes[editCol];
    const err = validateCellValue(value, colType);
    if (err) {
      setErrorMsg(err);
      return false;
    }
    const dataIdx = toDataIdx(editRow);
    const rawRow = data.rows[dataIdx] as unknown[];
    if (!rawRow) {
      setErrorMsg(t("dataTable.unloadedRangeUnsupported", {
        defaultValue: "This operation requires rows outside the loaded window.",
      }));
      return false;
    }
    const rowId = getRowId(rawRow);
    const colName = cols[editCol];
    const rawColIdx = editCol >= rowIdIdx ? editCol + 1 : editCol;
    const beforeValue = rawRow[rawColIdx];
    // Optimistic update
    const newData = { ...data, rows: [...data.rows] };
    const newRow = [...rawRow];
    newRow[rawColIdx] = value === "" ? null : value;
    newData.rows[dataIdx] = newRow;
    if (!tryBeginTableMutation()) return false;
    try {
      setData(newData);
      dataRef.current = newData;
      await dataService.updateCell(datasetId, rowId, colName, value);
      markDirty();
      await load();
      recordTable(t("history.editCell"), {
        kind: "cells",
        datasetId,
        generation: generationRef.current,
        cells: [{
          rowId,
          columnName: colName,
          before: beforeValue,
          after: value === "" ? null : value,
        }],
      });
      return true;
    } catch (e) {
      setErrorMsg(String(e));
      await load();
      return false;
    } finally {
      endTableMutation();
    }
  };

  // ---- Clear cells (Delete key) ----
  const clearCells = async (cells: { row: number; col: number }[]) => {
    if (readOnly) return;
    if (cells.some(({ row, col }) => !displayRowAt(row) || col < 0 || col >= cols.length)) {
      setErrorMsg(t("dataTable.unloadedRangeUnsupported", {
        defaultValue: "This operation requires rows outside the loaded window.",
      }));
      return;
    }
    // Optimistic UI update
    const newData = { ...data, rows: [...data.rows] };
    const updateInfos: { rowId: number; colName: string; before: unknown }[] = [];
    for (const { row, col } of cells) {
      const dataIdx = toDataIdx(row);
      const rawRow = [...(newData.rows[dataIdx] as unknown[])];
      const rowId = getRowId(rawRow as unknown[]);
      const rawColIdx = col >= rowIdIdx ? col + 1 : col;
      const before = rawRow[rawColIdx];
      rawRow[rawColIdx] = null;
      newData.rows[dataIdx] = rawRow;
      updateInfos.push({ rowId, colName: cols[col], before });
    }

    if (!tryBeginTableMutation()) return;
    try {
      setData(newData);
      dataRef.current = newData;
      await dataService.clearCells(
        datasetId,
        updateInfos.map(({ rowId, colName }) => ({ rowId, columnName: colName })),
      );
      markDirty();
      await load();
      recordTable(t("history.clearCells"), {
        kind: "cells",
        datasetId,
        generation: generationRef.current,
        cells: updateInfos.map(({ rowId, colName, before }) => ({
          rowId,
          columnName: colName,
          before,
          after: null,
        })),
      });
    } catch (e) {
      setErrorMsg(String(e));
      await load(); // Revert on error
      return;
    } finally {
      endTableMutation();
    }
  };

  // ---- Helper: find boundary of continuous data (Excel Ctrl+Arrow behavior) ----
  const findEdge = (row: number, col: number, dRow: number, dCol: number): { row: number; col: number } => {
    const maxRow = windowStart + displayRows.length - 1;
    const maxCol = cols.length - 1;
    const getCellVal = (r: number, c: number): unknown => {
      return displayRowAt(r)?.[c];
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
  const handleCopy = async (withHeader: boolean = false): Promise<boolean> => {
    if (!data) return false;
    let rows: string[][] = [];
    let headerCols: number[] | null = null;

    if (selectedRows.size > 0) {
      // Copy selected rows (all columns)
      const sortedRows = Array.from(selectedRows).sort((a, b) => a - b);
      headerCols = cols.map((_, i) => i);
      for (const ri of sortedRows) {
        const dr = displayRowAt(ri);
        if (!dr) {
          setErrorMsg(t("dataTable.unloadedRangeUnsupported", {
            defaultValue: "This operation requires rows outside the loaded window.",
          }));
          return false;
        }
        rows.push(dr.map((v) => (v == null ? "" : String(v))));
      }
    } else if (selectedCols.size > 0) {
      if (data.totalRows > displayRows.length) {
        setErrorMsg(t("dataTable.unloadedRangeUnsupported", {
          defaultValue: "This operation requires rows outside the loaded window.",
        }));
        return false;
      }
      // Copy selected columns (all rows)
      const sortedCols = Array.from(selectedCols).sort((a, b) => a - b);
      headerCols = sortedCols;
      for (const dr of displayRows) {
        rows.push(sortedCols.map((ci) => (dr[ci] == null ? "" : String(dr[ci]))));
      }
    } else if (selection) {
      // Copy selection range
      const { r1, c1, r2, c2 } = normalizeRange(selection);
      if (r1 < windowStart || r2 >= windowStart + displayRows.length) {
        setErrorMsg(t("dataTable.unloadedRangeUnsupported", {
          defaultValue: "This operation requires rows outside the loaded window.",
        }));
        return false;
      }
      headerCols = [];
      for (let c = c1; c <= c2; c++) headerCols.push(c);
      for (let r = r1; r <= r2; r++) {
        const dr = displayRowAt(r);
        if (!dr) return false;
        const row: string[] = [];
        for (let c = c1; c <= c2; c++) {
          row.push(dr[c] == null ? "" : String(dr[c]));
        }
        rows.push(row);
      }
    } else if (activeCell) {
      // Copy single cell
      const dr = displayRowAt(activeCell.row);
      if (!dr) return false;
      headerCols = [activeCell.col];
      rows.push([dr[activeCell.col] == null ? "" : String(dr[activeCell.col])]);
    }

    if (rows.length === 0) return false;
    if (withHeader && headerCols) {
      const headerRow = headerCols.map((ci) => cols[ci] ?? "");
      rows.unshift(headerRow);
    }
    const tsv = rows.map((r) => r.join("\t")).join("\n");
    try {
      await navigator.clipboard.writeText(tsv);
      return true;
    } catch {
      setErrorMsg(t("dataTable.clipboardWriteFail"));
      return false;
    }
  };

  // ---- Paste from clipboard (Excel TSV) ----
  const doPaste = async (text: string, withHeader: boolean) => {
    if (readOnly) return;
    if (tableFilters.length > 0) {
      setErrorMsg(t("dataTable.pasteFilteredUnsupported", {
        defaultValue: "Paste is unavailable while table filters are active.",
      }));
      return;
    }
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

    // Excel-style tiling: when the user has a multi-cell target selection AND
    // the selection is an integer multiple of the source clipboard, repeat the
    // source over the selection. Common case: copy 1 row, select N rows wide,
    // paste fills all N rows. Falls back to top-left paste otherwise.
    let startRow: number;
    let startCol: number;
    if (selection) {
      const selR0 = Math.min(selection.startRow, selection.endRow);
      const selR1 = Math.max(selection.startRow, selection.endRow);
      const selC0 = Math.min(selection.startCol, selection.endCol);
      const selC1 = Math.max(selection.startCol, selection.endCol);
      const selRows = selR1 - selR0 + 1;
      const selCols = selC1 - selC0 + 1;
      const srcRows = dataRows.length;
      const srcCols = dataRows.reduce((m, r) => Math.max(m, r.length), 0);
      const isMultiCell = selRows > 1 || selCols > 1;
      const rowsFit = srcRows > 0 && selRows % srcRows === 0;
      const colsFit = srcCols > 0 && selCols % srcCols === 0;
      // Header rows are not tiled — they must be written exactly once.
      if (isMultiCell && rowsFit && colsFit && !headerNames) {
        if (!canMaterializeSelection(
          selR0,
          selR1,
          selC0,
          selC1,
          windowStart,
          displayRows.length,
        )) {
          setErrorMsg(t("dataTable.unloadedRangeUnsupported", {
            defaultValue: "This operation requires rows outside the loaded window.",
          }));
          return;
        }
        const repR = selRows / srcRows;
        const repC = selCols / srcCols;
        if (repR > 1 || repC > 1) {
          const tiled: string[][] = [];
          for (let r = 0; r < selRows; r++) {
            const src = dataRows[r % srcRows];
            const row: string[] = new Array(selCols);
            for (let c = 0; c < selCols; c++) {
              row[c] = src[c % srcCols] ?? "";
            }
            tiled.push(row);
          }
          dataRows = tiled;
        }
      }
      startRow = selR0;
      startCol = selC0;
    } else {
      startRow = activeCell?.row ?? 0;
      startCol = activeCell?.col ?? 0;
    }
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
            t("dataTable.pasteTypeIncompatible", { letter: colLetter(targetCol), name: cols[targetCol], existing: existingType, detected: detectedType })
          );
          return;
        }
      }
    }

    // Check for data conflicts in paste range
    let hasConflicts = false;
    for (let r = 0; r < numPasteRows && !hasConflicts; r++) {
      const targetRow = startRow + r;
      if (targetRow < data.totalRows) {
        const dr = displayRowAt(targetRow);
        if (!dr) {
          hasConflicts = true;
          break;
        }
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
      const confirmed = window.confirm(t("dataTable.pasteOverwriteConfirm"));
      if (!confirmed) return;
    }

    if (!tryBeginTableMutation()) return;
    try {
      const { changeSetId } = await dataService.pasteAtPositionWithChangeSet(
        datasetId, startRow, startCol, dataRows, headerNames, detectedTypes, generationRef.current
      );
      recordTable(t("history.pasteData"), {
        kind: "changeSet",
        datasetId,
        changeSetId,
      });
      markDirty();
      try {
        await load();
        await refreshAndMarkDirty();
      } catch (refreshError) {
        setErrorMsg(String(refreshError));
      }
    } catch (err) {
      setErrorMsg(String(err));
    } finally {
      endTableMutation();
    }
  };

  const handlePaste = async (e: React.ClipboardEvent) => {
    if (editCell) return;
    // Don't hijack paste inside formula bar / other inputs.
    const tgt = e.target as HTMLElement | null;
    const tag = tgt?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tgt?.isContentEditable) return;
    const text = e.clipboardData.getData("text/plain");
    if (!text.trim()) return;
    e.preventDefault();
    await doPaste(text, false);
  };

  const handleCellContextMenu = (e: React.MouseEvent, row: number, col: number) => {
    if (readOnly) return;
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
    if (readOnly) return;
    setCellMenu(null);
    setCornerMenu(null);
    try {
      const text = await navigator.clipboard.readText();
      if (!text.trim()) return;
      await doPaste(text, withHeader);
    } catch {
      setErrorMsg(t("dataTable.clipboardReadFail"));
    }
  };

  const handleCornerClick = () => {
    // Don't set activeCell — paste defaults to (0,0) when null
    setActiveCell(null);
    setSelection(null);
    setSelectedRows(EMPTY_NUM_SET);
    setSelectedCols(EMPTY_NUM_SET);
    setSelectedCells(EMPTY_CELL_SET);
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
    // Don't intercept keys typed inside an input/textarea (e.g. the formula
    // bar's cell-ref input or the content input). Without this guard, every
    // letter / arrow / Enter would also drive the spreadsheet selection.
    const tgt = e.target as HTMLElement | null;
    const tag = tgt?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tgt?.isContentEditable) {
      // Allow our existing in-cell editor (.sp-cell-input) to keep using
      // this handler for Tab/Enter/Escape navigation — that one is wired
      // through props, so commit/cancel logic lives there. The formula bar
      // and other inputs handle their own keys.
      if (!tgt?.classList.contains("sp-cell-input")) return;
    }
    const isMeta = e.ctrlKey || e.metaKey;

    if (readOnly) {
      const key = e.key.toLowerCase();
      const isMutationShortcut = (isMeta && (key === "x" || key === "v" || key === "z" || key === "y"))
        || key === "delete"
        || key === "backspace";
      if (isMutationShortcut) {
        e.preventDefault();
        return;
      }
    }

    // Cmd/Ctrl + = or + : zoom in   |   Cmd/Ctrl + - : zoom out   |   Cmd/Ctrl + 0 : reset
    // Match both physical keys: `=` (Plus) and `+` (Shift+=) and `-`/`_`.
    if (isMeta && !editCell) {
      if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        zoomIn();
        return;
      }
      if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        zoomOut();
        return;
      }
      if (e.key === "0") {
        e.preventDefault();
        resetZoom();
        return;
      }
    }

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
      if (!editCell && data && data.totalRows > 0 && cols.length > 0) {
        e.preventDefault();
        setActiveCell({ row: 0, col: 0 });
        setSelection({
          startRow: 0,
          startCol: 0,
          endRow: data.totalRows - 1,
          endCol: cols.length - 1,
        });
        setSelectedRows(EMPTY_NUM_SET);
        setSelectedCols(EMPTY_NUM_SET);
        setSelectedCells(EMPTY_CELL_SET);
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
          if ([...selectedRows].some((row) => !displayRowAt(row))) {
            setErrorMsg(t("dataTable.unloadedRangeUnsupported", {
              defaultValue: "This operation requires rows outside the loaded window.",
            }));
            return;
          }
          if (selectedRows.size > Math.floor(MAX_MATERIALIZED_SELECTION_ITEMS / Math.max(1, cols.length))) {
            setErrorMsg(t("dataTable.unloadedRangeUnsupported", {
              defaultValue: "This operation requires rows outside the loaded window.",
            }));
            return;
          }
          for (const ri of selectedRows) {
            for (let ci = 0; ci < cols.length; ci++) cellsToCut.push({ row: ri, col: ci });
          }
        } else if (selectedCols.size > 0) {
          if (data.totalRows > displayRows.length) {
            setErrorMsg(t("dataTable.unloadedRangeUnsupported", {
              defaultValue: "This operation requires rows outside the loaded window.",
            }));
            return;
          }
          if (displayRows.length > Math.floor(MAX_MATERIALIZED_SELECTION_ITEMS / Math.max(1, selectedCols.size))) {
            setErrorMsg(t("dataTable.unloadedRangeUnsupported", {
              defaultValue: "This operation requires rows outside the loaded window.",
            }));
            return;
          }
          for (const ci of selectedCols) {
            for (let ri = windowStart; ri < windowStart + displayRows.length; ri++) cellsToCut.push({ row: ri, col: ci });
          }
        } else if (selection) {
          const { r1, c1, r2, c2 } = normalizeRange(selection);
          if (!canMaterializeSelection(r1, r2, c1, c2, windowStart, displayRows.length)) {
            setErrorMsg(t("dataTable.unloadedRangeUnsupported", {
              defaultValue: "This operation requires rows outside the loaded window.",
            }));
            return;
          }
          for (let r = r1; r <= r2; r++) {
            for (let c = c1; c <= c2; c++) cellsToCut.push({ row: r, col: c });
          }
        } else if (activeCell) {
          cellsToCut.push(activeCell);
        }
        if (cellsToCut.length > 0) {
          void copyThenClear(
            () => handleCopy(),
            () => clearCells(cellsToCut),
          );
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
        setErrorMsg(t("dataTable.clipboardReadFail"));
      });
      return;
    }

    if (editCell) return; // Don't navigate while editing
    if (!activeCell) return;

    const { row, col } = activeCell;
    const maxRow = data?.totalRows ? data.totalRows - 1 : -1;
    const maxCol = cols.length - 1;
    const isMod = e.ctrlKey || e.metaKey; // Ctrl (Windows/Linux) or Cmd (macOS)

    const arrows = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];
    if (arrows.includes(e.key)) {
      e.preventDefault();

      // When extending selection (Shift held), compute movement from the selection's moving end
      // so the selection grows from that edge; activeCell stays as the anchor.
      const srcRow = e.shiftKey && selection ? selection.endRow : row;
      const srcCol = e.shiftKey && selection ? selection.endCol : col;

      let targetRow = srcRow;
      let targetCol = srcCol;

      if (e.key === "ArrowUp") {
        if (isMod) {
          const edge = findEdge(srcRow, srcCol, -1, 0);
          targetRow = edge.row;
        } else {
          targetRow = Math.max(0, srcRow - 1);
        }
      } else if (e.key === "ArrowDown") {
        if (isMod) {
          const edge = findEdge(srcRow, srcCol, 1, 0);
          targetRow = edge.row;
        } else {
          targetRow = Math.min(maxRow, srcRow + 1);
        }
      } else if (e.key === "ArrowLeft") {
        if (isMod) {
          const edge = findEdge(srcRow, srcCol, 0, -1);
          targetCol = edge.col;
        } else {
          targetCol = Math.max(0, srcCol - 1);
        }
      } else if (e.key === "ArrowRight") {
        if (isMod) {
          const edge = findEdge(srcRow, srcCol, 0, 1);
          targetCol = edge.col;
        } else {
          targetCol = Math.min(maxCol, srcCol + 1);
        }
      }

      if (e.shiftKey) {
        // Extend selection; activeCell (anchor) stays in place
        setSelection({
          startRow: row,
          startCol: col,
          endRow: targetRow,
          endCol: targetCol,
        });
      } else {
        setActiveCell({ row: targetRow, col: targetCol });
        setSelection(null);
        setSelectedCells(EMPTY_CELL_SET);
      }
      return;
    }

    switch (e.key) {
      case "Tab":
        e.preventDefault();
        setSelection(null);
        setSelectedCells(EMPTY_CELL_SET);
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
        setSelectedCells(EMPTY_CELL_SET);
        break;
      }
      case "F2": {
        e.preventDefault();
        const displayRow = displayRowAt(row);
        if (!displayRow) break;
        handleCellDoubleClick(row, col, displayRow[col]);
        break;
      }
      case "Delete":
      case "Backspace": {
        e.preventDefault();
        const cellsToClear: { row: number; col: number }[] = [];
        if (selection) {
          const { r1, c1, r2, c2 } = normalizeRange(selection);
          if (!canMaterializeSelection(r1, r2, c1, c2, windowStart, displayRows.length)) {
            setErrorMsg(t("dataTable.unloadedRangeUnsupported", {
              defaultValue: "This operation requires rows outside the loaded window.",
            }));
            return;
          }
          const firstLoadedRow = Math.max(r1, windowStart);
          const lastLoadedRow = Math.min(r2, windowStart + displayRows.length - 1);
          for (let r = firstLoadedRow; r <= lastLoadedRow; r++)
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

    // Ctrl/Cmd+click and Ctrl/Cmd+drag on cells extend the non-contiguous
    // `selectedCells` set:
    //
    //   - Click (no movement): toggle that single cell. Excel-style with
    //     one tweak: on the very first Ctrl interaction we seed the set
    //     with the prior activeCell so the previously-focused cell stays
    //     visible — without this the first Ctrl+click would effectively
    //     just move focus instead of building a multi-selection.
    //
    //   - Drag (mouse moved to a different cell): commit the dragged
    //     rectangle as a union into selectedCells (additive — already-
    //     selected cells inside the rect stay selected). This lets the
    //     user paint multiple disjoint rectangular regions by holding
    //     Ctrl and dragging in different areas.
    //
    // During the drag, `pendingCtrlRect` renders as a live preview by
    // being merged into cellsByRow; on mouseup we move it into the
    // committed selectedCells Set.
    //
    // The subsequent onClick event hits handleCellClick, which has a
    // Ctrl/Cmd-modifier guard at the top that returns early — preventing
    // it from wiping selectedCells with setSelectedCells(EMPTY_CELL_SET).
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      // Seed the persistent set so prior committed selections survive
      // the new Ctrl operation:
      //   (1) Rectangular `selection` exists: fold every cell in it into
      //       selectedCells. Otherwise the setSelection(null) below would
      //       wipe the first region, leaving only the new Ctrl-drag.
      //   (2) Only activeCell exists (no rect, set was empty): include
      //       the previously-focused cell so it doesn't get lost when
      //       active moves to the clicked cell.
      //   (3) selectedCells already non-empty + no rect: nothing to
      //       seed; existing set persists naturally.
      if (selection) {
        const { r1, c1, r2, c2 } = normalizeRange(selection);
        if (!canMaterializeSelection(
          r1,
          r2,
          c1,
          c2,
          windowStart,
          displayRows.length,
          undefined,
          selectedCells.size,
        )) {
          setErrorMsg(t("dataTable.unloadedRangeUnsupported", {
            defaultValue: "This operation requires rows outside the loaded window.",
          }));
          return;
        }
        const seed = new Set(selectedCells);
        for (let r = r1; r <= r2; r++) {
          for (let c = c1; c <= c2; c++) seed.add(cellKey(r, c));
        }
        setSelectedCells(seed);
      } else if (selectedCells.size === 0 && activeCell &&
                 (activeCell.row !== row || activeCell.col !== col)) {
        const seed = new Set<string>();
        seed.add(cellKey(activeCell.row, activeCell.col));
        setSelectedCells(seed);
      }
      setActiveCell({ row, col });
      setSelection(null);
      setSelectedRows(EMPTY_NUM_SET);
      setSelectedCols(EMPTY_NUM_SET);

      isCtrlDraggingRef.current = true;
      setPendingCtrlRect({ startRow: row, startCol: col, endRow: row, endCol: col });
      document.body.style.userSelect = "none";

      // Same coalescing pattern as the normal drag: skip same-cell moves,
      // at most one setPendingCtrlRect per animation frame.
      let lastR = row;
      let lastC = col;
      let pendingRaf = 0;

      const onCtrlMove = (ev: MouseEvent) => {
        if (!isCtrlDraggingRef.current) return;
        startAutoScroll(ev);
        const target = document.elementFromPoint(ev.clientX, ev.clientY);
        if (!target) return;
        const td = (target as Element).closest("td.sp-cell") as HTMLElement | null;
        if (!td) return;
        const ri = td.dataset.row;
        const ci = td.dataset.col;
        if (ri == null || ci == null) return;
        const nr = Number(ri);
        const nc = Number(ci);
        if (!Number.isFinite(nr) || !Number.isFinite(nc)) return;
        if (nr === lastR && nc === lastC) return;
        lastR = nr;
        lastC = nc;
        if (pendingRaf) return;
        pendingRaf = requestAnimationFrame(() => {
          pendingRaf = 0;
          setPendingCtrlRect((prev) => prev ? { ...prev, endRow: lastR, endCol: lastC } : null);
        });
      };

      const onCtrlUp = () => {
        isCtrlDraggingRef.current = false;
        stopAutoScroll();
        if (pendingRaf) {
          cancelAnimationFrame(pendingRaf);
          pendingRaf = 0;
        }
        document.body.style.userSelect = "";
        document.removeEventListener("mousemove", onCtrlMove);
        document.removeEventListener("mouseup", onCtrlUp);
        setPendingCtrlRect(null);

        const r1 = Math.min(row, lastR);
        const r2 = Math.max(row, lastR);
        const c1 = Math.min(col, lastC);
        const c2 = Math.max(col, lastC);
        if (!canMaterializeSelection(
          r1,
          r2,
          c1,
          c2,
          windowStart,
          displayRows.length,
          undefined,
          selectedCells.size,
        )) {
          setErrorMsg(t("dataTable.unloadedRangeUnsupported", {
            defaultValue: "This operation requires rows outside the loaded window.",
          }));
          return;
        }
        if (r1 === r2 && c1 === c2) {
          // Pure click on a single cell — toggle it.
          setSelectedCells((prev) => {
            if (!canMaterializeSelection(row, row, col, col, windowStart, displayRows.length, undefined, prev.size)) {
              setErrorMsg(t("dataTable.unloadedRangeUnsupported", {
                defaultValue: "This operation requires rows outside the loaded window.",
              }));
              return prev;
            }
            const next = new Set(prev);
            const k = cellKey(row, col);
            if (next.has(k)) next.delete(k);
            else next.add(k);
            return next;
          });
        } else {
          // Drag covered multiple cells — union the whole rectangle. We
          // do not toggle here: Excel's additive Ctrl+drag never removes
          // cells, even if some inside the new rect were already selected.
          setSelectedCells((prev) => {
            if (!canMaterializeSelection(r1, r2, c1, c2, windowStart, displayRows.length, undefined, prev.size)) {
              setErrorMsg(t("dataTable.unloadedRangeUnsupported", {
                defaultValue: "This operation requires rows outside the loaded window.",
              }));
              return prev;
            }
            const next = new Set(prev);
            for (let r = r1; r <= r2; r++) {
              for (let c = c1; c <= c2; c++) next.add(cellKey(r, c));
            }
            return next;
          });
        }
      };

      document.addEventListener("mousemove", onCtrlMove);
      document.addEventListener("mouseup", onCtrlUp);
      return;
    }

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
    setSelectedRows(EMPTY_NUM_SET);
    setSelectedCols(EMPTY_NUM_SET);
    setSelectedCells(EMPTY_CELL_SET);

    document.body.style.userSelect = "none";

    // Skip-same-cell + rAF coalescing: every mousemove that lands on the same
    // td as last frame is a no-op, and at most one setSelection runs per
    // animation frame. Without this, dragging a few hundred pixels can fire
    // hundreds of setState calls/sec and re-render every visible cell.
    let lastDragR = row;
    let lastDragC = col;
    let pendingDragRaf = 0;
    const onMouseMove = (ev: MouseEvent) => {
      if (!isDraggingRef.current) return;
      didDragRef.current = true;
      startAutoScroll(ev);
      const target = document.elementFromPoint(ev.clientX, ev.clientY);
      if (!target) return;
      const td = (target as Element).closest("td.sp-cell") as HTMLElement | null;
      if (!td) return;
      const ri = td.dataset.row;
      const ci = td.dataset.col;
      if (ri == null || ci == null) return;
      const nr = Number(ri);
      const nc = Number(ci);
      if (nr === lastDragR && nc === lastDragC) return; // same cell — skip
      lastDragR = nr;
      lastDragC = nc;
      if (pendingDragRaf) return; // already scheduled this frame
      pendingDragRaf = requestAnimationFrame(() => {
        pendingDragRaf = 0;
        setSelection((prev) => prev ? { ...prev, endRow: lastDragR, endCol: lastDragC } : null);
      });
    };

    const onMouseUp = () => {
      isDraggingRef.current = false;
      setIsDragging(false);
      stopAutoScroll();
      if (pendingDragRaf) {
        cancelAnimationFrame(pendingDragRaf);
        pendingDragRaf = 0;
        // Flush the last pending update so final selection is correct.
        setSelection((prev) => prev ? { ...prev, endRow: lastDragR, endCol: lastDragC } : null);
      }
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
      if (start < windowStart || end >= windowStart + displayRows.length) {
        setErrorMsg(t("dataTable.unloadedRangeUnsupported", {
          defaultValue: "This operation requires rows outside the loaded window.",
        }));
        return;
      }
      newSet.clear();
      for (let i = start; i <= end; i++) newSet.add(i);
    } else {
      newSet.clear();
      newSet.add(rowIdx);
      rowAnchorRef.current = rowIdx;
    }
    setSelectedRows(newSet);
    setSelectedCols(EMPTY_NUM_SET);
    setSelectedCells(EMPTY_CELL_SET);
    setSelection(null);
    setActiveCell(null);
  };

  const handleRowHeaderMouseDown = (rowIdx: number, e: React.MouseEvent) => {
    if (hasMenuOpen() || suppressSelectionRef.current) return;
    setCornerSelected(false);
    if (e.button !== 0) return;
    // Ctrl/Cmd: support both pure-click row toggle and drag-additive
    // multi-row paint. Strategy:
    //
    //   - We register mousemove/mouseup handlers up front. While dragging,
    //     `selectedRows` is shown as snapshot ∪ (anchor..current) — additive,
    //     so previously selected rows stay highlighted even when the cursor
    //     leaves them.
    //   - If the cursor never crosses to another row (pure click), we leave
    //     `didDragRowRef` cleared and let the trailing click reach
    //     handleRowSelect, whose own Ctrl branch handles single-row toggle.
    //     This avoids the "1px jitter wipes the selection" failure mode the
    //     prior fix originally had: tiny mouse movement within the same row
    //     simply doesn't matter because we key off row-index change, not
    //     pixel motion.
    //   - If the user did cross to another row, we commit the range and
    //     set `didDragRowRef = true` so the trailing click (if any) early-
    //     returns instead of re-toggling the anchor row.
    //
    // The stale-flag reset at the top still matters: it covers prior drags
    // whose mouseup target differed from mousedown target — those produce
    // no click event, so handleRowSelect never had a chance to consume +
    // reset the flag.
    if (e.ctrlKey || e.metaKey) {
      didDragRowRef.current = false;
      e.preventDefault();

      const snapshot = new Set(selectedRows);
      const anchorRow = rowIdx;
      isDraggingRowRef.current = true;
      setIsDragging(true);
      document.body.style.userSelect = "none";

      let lastRow = rowIdx;
      let didMoveToOtherRow = false;
      let pendingRaf = 0;

      const commitRange = () => {
        const start = Math.min(anchorRow, lastRow);
        const end = Math.max(anchorRow, lastRow);
        if (!canMaterializeSelection(start, end, 0, 0, windowStart, displayRows.length)) {
          setErrorMsg(t("dataTable.unloadedRangeUnsupported", {
            defaultValue: "This operation requires rows outside the loaded window.",
          }));
          return;
        }
        const newSet = new Set(snapshot);
        for (let i = start; i <= end; i++) newSet.add(i);
        setSelectedRows(newSet);
      };

      const onMouseMove = (ev: MouseEvent) => {
        if (!isDraggingRowRef.current) return;
        startAutoScroll(ev);
        const target = document.elementFromPoint(ev.clientX, ev.clientY);
        if (!target) return;
        const td = (target as Element).closest("td.sp-row-hdr") as HTMLElement | null;
        if (!td) return;
        const riStr = td.dataset.rowHdr;
        if (riStr == null) return;
        const ri = Number(riStr);
        if (!Number.isFinite(ri)) return;
        if (ri === lastRow) return;
        if (!didMoveToOtherRow) {
          didMoveToOtherRow = true;
          // First cross-row move: switch the table out of cell-mode so the
          // visual is purely row-selection from this point onward.
          setSelectedCols(EMPTY_NUM_SET);
          setSelectedCells(EMPTY_CELL_SET);
          setSelection(null);
          setActiveCell(null);
        }
        lastRow = ri;
        if (pendingRaf) return;
        pendingRaf = requestAnimationFrame(() => {
          pendingRaf = 0;
          commitRange();
        });
      };

      const onMouseUp = () => {
        isDraggingRowRef.current = false;
        setIsDragging(false);
        stopAutoScroll();
        if (pendingRaf) {
          cancelAnimationFrame(pendingRaf);
          pendingRaf = 0;
          commitRange();
        }
        document.body.style.userSelect = "";
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        if (didMoveToOtherRow) {
          didDragRowRef.current = true;
          rowAnchorRef.current = lastRow;
        }
        // If !didMoveToOtherRow, leave didDragRowRef cleared so the click
        // event reaches handleRowSelect for the single-row Ctrl-toggle.
      };

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
      containerRef.current?.focus();
      return;
    }
    e.preventDefault();
    isDraggingRowRef.current = true;
    didDragRowRef.current = false;
    setIsDragging(true);
    // Same fix as column header: shift+click should drag from the existing
    // anchor, not the just-clicked row.
    const anchorRow = (e.shiftKey && rowAnchorRef.current != null) ? rowAnchorRef.current : rowIdx;
    document.body.style.userSelect = "none";

    const onMouseMove = (ev: MouseEvent) => {
      if (!isDraggingRowRef.current) return;
      if (!didDragRowRef.current) {
        didDragRowRef.current = true;
        // Initialize selection on first move if no modifier
        if (!e.ctrlKey && !e.metaKey && !e.shiftKey) {
          setSelectedRows(new Set([rowIdx]));
          setSelectedCols(EMPTY_NUM_SET);
          setSelectedCells(EMPTY_CELL_SET);
          setSelection(null);
        }
      }
      startAutoScroll(ev);
      const target = document.elementFromPoint(ev.clientX, ev.clientY);
      if (!target) return;
      const td = target.closest("td.sp-row-hdr") as HTMLElement | null;
      if (!td) return;
      // Read absolute row index from data attribute, not from textContent —
      // more robust against virtualization spacers / non-numeric content.
      const riStr = td.dataset.rowHdr;
      if (riStr == null) return;
      const ri = Number(riStr);
      if (Number.isFinite(ri)) {
        const start = Math.min(anchorRow, ri);
        const end = Math.max(anchorRow, ri);
        if (!canMaterializeSelection(start, end, 0, 0, windowStart, displayRows.length)) {
          setErrorMsg(t("dataTable.unloadedRangeUnsupported", {
            defaultValue: "This operation requires rows outside the loaded window.",
          }));
          return;
        }
        const newSet = new Set<number>();
        for (let i = start; i <= end; i++) newSet.add(i);
        setSelectedRows(newSet);
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
    setSelectedRows(EMPTY_NUM_SET);
    setSelectedCells(EMPTY_CELL_SET);
    setSelection(null);
    setActiveCell(null);
  };

  const handleColHeaderMouseDown = (colIdx: number, e: React.MouseEvent) => {
    if (hasMenuOpen() || suppressSelectionRef.current) return;
    setCornerSelected(false);
    if (e.button !== 0) return;
    // Ctrl/Cmd: same dual click-or-drag handling as handleRowHeaderMouseDown.
    // Pure click → trailing click event hits handleColSelect for single-col
    // toggle; drag across columns → additive range commit on mouseup.
    // See handleRowHeaderMouseDown for the full rationale.
    if (e.ctrlKey || e.metaKey) {
      didDragColRef.current = false;
      e.preventDefault();

      const snapshot = new Set(selectedCols);
      const anchorCol = colIdx;
      isDraggingColRef.current = true;
      setIsDragging(true);
      document.body.style.userSelect = "none";

      let lastCol = colIdx;
      let didMoveToOtherCol = false;
      let pendingRaf = 0;

      const commitRange = () => {
        const start = Math.min(anchorCol, lastCol);
        const end = Math.max(anchorCol, lastCol);
        const newSet = new Set(snapshot);
        for (let i = start; i <= end; i++) newSet.add(i);
        setSelectedCols(newSet);
      };

      const onMouseMove = (ev: MouseEvent) => {
        if (!isDraggingColRef.current) return;
        startAutoScroll(ev);
        const target = document.elementFromPoint(ev.clientX, ev.clientY);
        if (!target) return;
        const th = (target as Element).closest("th.sp-col-hdr") as HTMLElement | null;
        if (!th) return;
        const ciStr = th.dataset.colHdr;
        if (ciStr == null) return;
        const ci = Number(ciStr);
        if (!Number.isFinite(ci) || ci < 0) return;
        if (ci === lastCol) return;
        if (!didMoveToOtherCol) {
          didMoveToOtherCol = true;
          setSelectedRows(EMPTY_NUM_SET);
          setSelectedCells(EMPTY_CELL_SET);
          setSelection(null);
          setActiveCell(null);
        }
        lastCol = ci;
        if (pendingRaf) return;
        pendingRaf = requestAnimationFrame(() => {
          pendingRaf = 0;
          commitRange();
        });
      };

      const onMouseUp = () => {
        isDraggingColRef.current = false;
        setIsDragging(false);
        stopAutoScroll();
        if (pendingRaf) {
          cancelAnimationFrame(pendingRaf);
          pendingRaf = 0;
          commitRange();
        }
        document.body.style.userSelect = "";
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        if (didMoveToOtherCol) {
          didDragColRef.current = true;
          colAnchorRef.current = lastCol;
        }
      };

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
      containerRef.current?.focus();
      return;
    }
    e.preventDefault();
    isDraggingColRef.current = true;
    didDragColRef.current = false;
    setIsDragging(true);
    // For shift+click, drag should extend the existing selection from the
    // previous anchor — not from the just-clicked column. Otherwise a tiny
    // mouse jitter between mousedown and mouseup converts the shift-click
    // into a single-column selection (drag path overrides handleColSelect).
    const anchorCol = (e.shiftKey && colAnchorRef.current != null) ? colAnchorRef.current : colIdx;
    document.body.style.userSelect = "none";

    const onMouseMove = (ev: MouseEvent) => {
      if (!isDraggingColRef.current) return;
      if (!didDragColRef.current) {
        didDragColRef.current = true;
        // Initialize selection on first move if no modifier
        if (!e.ctrlKey && !e.metaKey && !e.shiftKey) {
          setSelectedCols(new Set([colIdx]));
          setSelectedRows(EMPTY_NUM_SET);
          setSelectedCells(EMPTY_CELL_SET);
          setSelection(null);
        }
      }
      startAutoScroll(ev);
      const target = document.elementFromPoint(ev.clientX, ev.clientY);
      if (!target) return;
      const th = target.closest("th.sp-col-hdr") as HTMLElement | null;
      if (!th) return;
      // Read absolute column index from data attribute. Using sibling position
      // (indexOf) is wrong under column virtualization because off-screen
      // columns are not in the DOM, so the visible-only index doesn't match
      // the real column number.
      const ciStr = th.dataset.colHdr;
      if (ciStr == null) return;
      const ci = Number(ciStr);
      if (Number.isFinite(ci) && ci >= 0) {
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
    if (readOnly) return;
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
    if (readOnly) return;
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
    if (readOnly) return;
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    // Calculate offset: distance from mouse to the actual right border of the column
    const th = (e.target as HTMLElement).closest("th");
    const borderX = th ? th.getBoundingClientRect().right : startX;
    const offsetX = startX - borderX;
    // `colWidths` stores base (1×) widths. The drag distance is in visual
    // pixels, so divide by zoom before adding to the base width.
    const startW = colWidths[colIdx] ?? BASE_DEFAULT_COL_WIDTH;
    const batchCols = selectedCols.has(colIdx) ? Array.from(selectedCols).filter(ci => ci !== colIdx) : [];
    resizingRef.current = { colIdx, startX, startW };

    const onMouseMove = (ev: MouseEvent) => {
      if (readOnlyRef.current) return;
      if (!resizingRef.current) return;
      const delta = ev.clientX - offsetX - resizingRef.current.startX;
      const newW = Math.max(BASE_DEFAULT_COL_WIDTH, startW + delta / zoom);
      setColWidths((prev) => {
        const next = [...prev];
        next[colIdx] = newW;
        return next;
      });
    };

    const onMouseUp = () => {
      const completedResize = resizingRef.current;
      resizingRef.current = null;
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      if (!completedResize || readOnlyRef.current) return;
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
        colWidthsRef.current = next;
        markDirty();
        return next;
      });
      recordAction(t("history.resizeColumn"));
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
    const typeLabel = labelOf(colTypes[colIdx]);
    ctx.font = "11px system-ui, -apple-system, sans-serif";
    // Header content is stacked vertically, widest element determines width
    const hdrTexts = [letter, name, typeLabel];
    for (const t of hdrTexts) {
      maxW = Math.max(maxW, ctx.measureText(t).width + HDR_PADDING);
    }
    // Measurement uses base 13px font, so the returned width is in base units.
    return Math.max(BASE_DEFAULT_COL_WIDTH, Math.ceil(maxW));
  };

  // ---- Double-click resize to auto-fit (supports batch) ----
  const handleResizeDoubleClick = (e: React.MouseEvent, colIdx: number) => {
    if (readOnly) return;
    e.preventDefault();
    e.stopPropagation();
    // If this column is in the selected set, auto-fit all selected columns
    const targetCols = selectedCols.has(colIdx) ? Array.from(selectedCols) : [colIdx];
    const newWidths = [...colWidths];
    for (const ci of targetCols) {
      newWidths[ci] = autoFitColumn(ci);
    }
    setColWidths(newWidths);
    colWidthsRef.current = newWidths;
    syncDisplayProps(newWidths, colFormatsRef.current);
    markDirty();
    recordAction(t("history.autoFitColumn"));
  };

  // ---- Columns panel item click: select column(s) and scroll into view ----
  const handleColsPanelItemClick = (colIdx: number, e: React.MouseEvent) => {
    if (hasMenuOpen() || suppressSelectionRef.current) return;
    setCornerSelected(false);
    const newSet = new Set(selectedCols);
    if (e.ctrlKey || e.metaKey) {
      if (newSet.has(colIdx)) newSet.delete(colIdx);
      else newSet.add(colIdx);
      colsPanelAnchorRef.current = colIdx;
      colAnchorRef.current = colIdx;
    } else if (e.shiftKey && colsPanelAnchorRef.current != null) {
      const start = Math.min(colsPanelAnchorRef.current, colIdx);
      const end = Math.max(colsPanelAnchorRef.current, colIdx);
      newSet.clear();
      for (let i = start; i <= end; i++) newSet.add(i);
    } else {
      newSet.clear();
      newSet.add(colIdx);
      colsPanelAnchorRef.current = colIdx;
      colAnchorRef.current = colIdx;
    }
    setSelectedCols(newSet);
    setSelectedRows(EMPTY_NUM_SET);
    setSelectedCells(EMPTY_CELL_SET);
    setSelection(null);
    setActiveCell(null);
    // Scroll the column into view in the grid
    const wrapper = tableRef.current;
    if (wrapper && colOffsets[colIdx] != null) {
      const colLeft = ROW_HDR_WIDTH + colOffsets[colIdx];
      const colRight = colLeft + (colWidths[colIdx] ?? BASE_DEFAULT_COL_WIDTH) * zoom;
      const viewLeft = wrapper.scrollLeft + ROW_HDR_WIDTH;
      const viewRight = wrapper.scrollLeft + wrapper.clientWidth;
      if (colLeft < viewLeft) wrapper.scrollLeft = colLeft - ROW_HDR_WIDTH;
      else if (colRight > viewRight) wrapper.scrollLeft = colRight - wrapper.clientWidth;
    }
  };

  // Wire up stable proxies for the cols-panel handlers (declared above the
  // early return so hook order stays constant; assigned each render to pick
  // up latest closure state).
  colsPanelClickRef.current = handleColsPanelItemClick;
  colsPanelCtxMenuRef.current = handleColContextMenu;
  colsPanelReorderRef.current = handleColsPanelReorder;

  // Wire up FormulaBar proxies + derive its inputs.
  writeActiveCellRef.current = async (v: string) => {
    const r = await writeActiveCellValue(v);
    return r === true;
  };
  jumpToCellRef.current = (row: number, col: number) => {
    setActiveCell({ row, col });
    setSelection({ startRow: row, startCol: col, endRow: row, endCol: col });
    setSelectedRows(EMPTY_NUM_SET);
    setSelectedCols(EMPTY_NUM_SET);
    setSelectedCells(EMPTY_CELL_SET);
  };
  moveDownAfterCommitRef.current = () => {
    if (!activeCell) return;
    const maxRow = data.totalRows - 1;
    if (activeCell.row < maxRow) {
      setActiveCell({ row: activeCell.row + 1, col: activeCell.col });
    }
  };
  const activeCellValueStr = (() => {
    if (!activeCell) return "";
    const dr = displayRowAt(activeCell.row);
    const v = dr ? dr[activeCell.col] : undefined;
    return v == null ? "" : String(v);
  })();
  const formulaMaxRow = data.totalRows - 1;
  const formulaMaxCol = cols.length - 1;

  return (
    <div
      className={`sp-spreadsheet${isDragging ? " sp-dragging" : ""}`}
      onKeyDown={handleKeyDown}
      onPaste={handlePaste}
      tabIndex={0}
      ref={containerRef}
      style={{ ["--sp-zoom" as string]: String(zoom) } as React.CSSProperties}
    >

      {/* Table operations toolbar (formerly the menu-bar `Operations`
          menu) + the local-data Filter toggle. The Filter button is
          always rendered because it doesn't depend on `onTableOp`; the
          ops buttons only render when the host wired the callback. */}
      <div className="sp-table-toolbar">
        {/* Local Data Filter toggle — opens the shared FilterPanel as a
            left sidebar (same component the Graph Builder uses). */}
        <button
          className={`sp-tb-btn${showTableFilters ? " sp-tb-btn-active" : ""}`}
          onClick={() => setShowTableFilters((v) => !v)}
          disabled={readOnly}
          title={t("graph.filter.toggleTitle", { defaultValue: "Show/Hide local data filter" })}
        >
          {t("graph.filter.toolbarBtn", { defaultValue: "Filter" })}
          {tableFilters.length > 0 && (
            <span className="sp-tb-badge">{tableFilters.length}</span>
          )}
        </button>
        {onTableOp && (
          <>
            <div className="sp-tb-sep" />
            <button className="sp-tb-btn" onClick={() => onTableOp("summary")} disabled={readOnly}>
              {t("menu.opSummary")}
            </button>
            <div className="sp-tb-sep" />
            <button className="sp-tb-btn" onClick={() => onTableOp("subset")} disabled={readOnly}>
              {t("menu.opSubset")}
            </button>
            <button className="sp-tb-btn" onClick={() => onTableOp("sort")} disabled={readOnly}>
              {t("menu.opSort")}
            </button>
            <div className="sp-tb-sep" />
            <button className="sp-tb-btn" onClick={() => onTableOp("stack")} disabled={readOnly}>
              {t("menu.opStack")}
            </button>
            <button className="sp-tb-btn" onClick={() => onTableOp("split")}>
              {t("menu.opSplit")}
            </button>
            <button className="sp-tb-btn" onClick={() => onTableOp("transpose")}>
              {t("menu.opTranspose")}
            </button>
            <div className="sp-tb-sep" />
            <button className="sp-tb-btn" onClick={() => onTableOp("join")}>
              {t("menu.opJoin")}
            </button>
            <button className="sp-tb-btn" onClick={() => onTableOp("update")}>
              {t("menu.opUpdate")}
            </button>
            <button className="sp-tb-btn" onClick={() => onTableOp("concatenate")}>
              {t("menu.opConcatenate")}
            </button>
            <div className="sp-tb-sep" />
            {/* Column-level admin (not a row-level transform), so it lives
                in its own trailing group separated by a divider. */}
            <button
              className="sp-tb-btn"
              onClick={() => setShowManageExtras(true)}
            >
              {t("menu.manageExtras")}
            </button>
          </>
        )}
      </div>

      {/* Add column inline form */}
      {showAddCol && (
        <div className="sp-add-col-bar">
          <input
            ref={addColInputRef}
            className="sp-input"
            placeholder={t("dataTable.colNamePlaceholder")}
            value={newColName}
            onChange={(e) => setNewColName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleAddColumn(); if (e.key === "Escape") setShowAddCol(false); }}
          />
          <select className="sp-select" value={newColType} onChange={(e) => setNewColType(e.target.value)}>
            {COLUMN_TYPE_VALUES.map((v) => <option key={v} value={v}>{labelOf(v)}</option>)}
          </select>
          <button className="sp-tb-btn sp-btn-accent" onClick={handleAddColumn}>{t("common.add")}</button>
          <button className="sp-tb-btn" onClick={() => setShowAddCol(false)}>{t("common.cancel")}</button>
        </div>
      )}

      {/* Column properties dialog */}
      {renameCol && (
        <div className="sp-dialog-overlay">
          <div className="sp-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="sp-dialog-title">{t("dataTable.colPropsTitle")}</div>
            <div className="sp-dialog-body">
              <label className="sp-dialog-label">{t("dataTable.colPropsName")}</label>
              <input
                ref={renameInputRef}
                className="sp-dialog-input"
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleRenameColumn(); if (e.key === "Escape") setRenameCol(null); }}
              />
              <label className="sp-dialog-label">{t("dataTable.colPropsType")}</label>
              <select className="sp-dialog-select" value={renameType} onChange={(e) => setRenameType(e.target.value)}>
                {COLUMN_TYPE_VALUES.map((v) => <option key={v} value={v}>{labelOf(v)}</option>)}
              </select>
              <label className="sp-dialog-label">{t("dataTable.colPropsFormat")}</label>
              <select className="sp-dialog-select" value={renameFormat.kind} onChange={(e) => {
                const kind = e.target.value as FormatKind;
                setRenameFormat(kind === "currency"
                  ? { kind, decimals: 2, currency: "CNY" }
                  : kind === "fixed" || kind === "percent"
                    ? { kind, decimals: 2 }
                    : { kind });
              }}>
                {FORMAT_KINDS.map((k) => <option key={k} value={k}>{t(`dataTable.format.${k}`)}</option>)}
              </select>
              {(renameFormat.kind === "fixed" || renameFormat.kind === "percent") && (
                <div style={{ marginTop: 6 }}>
                  <label className="sp-dialog-label">{t("dataTable.colPropsDigits")}</label>
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
                    <label className="sp-dialog-label">{t("dataTable.colPropsCurrency")}</label>
                    <select className="sp-dialog-select" value={renameFormat.currency ?? "CNY"} onChange={(e) => setRenameFormat((prev) => ({ ...prev, currency: e.target.value }))}>
                      {CURRENCY_OPTIONS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                    </select>
                  </div>
                  <div style={{ marginTop: 6 }}>
                    <label className="sp-dialog-label">{t("dataTable.colPropsDigits")}</label>
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
              <label className="sp-dialog-label">{t("dataTable.colPropsWidth")}</label>
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
                <button className="sp-dialog-btn" onClick={() => setRenameWidth(String(Math.round(autoFitColumn(renameCol.colIdx) * zoom)))}>{t("common.auto")}</button>
              </div>
              <ExtrasEditor extras={renameExtras} onChange={setRenameExtras} getColumnUniqueValues={renameUniqueValues} />
            </div>
            <div className="sp-dialog-actions">
              <button className="sp-dialog-btn" onClick={() => setRenameCol(null)}>{t("common.cancel")}</button>
              <button className="sp-dialog-btn sp-dialog-btn-primary" onClick={handleRenameColumn}>{t("common.confirm")}</button>
            </div>
          </div>
        </div>
      )}

      {/* Spreadsheet table area: filter panel + left columns panel +
          (formula bar + grid). The optional filter panel sits as the
          leftmost child when the toolbar Filter button is toggled on
          (mirrors the Graph Builder layout). */}
      <div className="sp-table-area">
        {/* Local Data Filter panel + splitter (leftmost, when toggled on).
            Uses the shared FilterPanel component, so its width/behaviour
            stays in sync with the Graph Builder's filter sidebar. */}
        {showTableFilters && (
          <>
            <FilterPanel
              data={tableFilterData}
              columns={tableFilterFields}
              filters={tableFilters}
              onChange={setTableFilters}
              onClose={() => setShowTableFilters(false)}
              width={tableFilterWidth}
              categoricalMode="exclude"
              getCategoricalValues={getTableCategoricalValues}
            />
            <div
              className="sp-cols-panel-splitter"
              title={t("graph.resizePanel", { defaultValue: "Drag to resize" })}
              onMouseDown={(e) => {
                e.preventDefault();
                const startX = e.clientX;
                const startW = tableFilterWidth;
                const onMove = (ev: MouseEvent) => {
                  const next = Math.max(200, Math.min(500, startW + (ev.clientX - startX)));
                  setTableFilterWidth(next);
                };
                const onUp = () => {
                  document.removeEventListener("mousemove", onMove);
                  document.removeEventListener("mouseup", onUp);
                };
                document.addEventListener("mousemove", onMove);
                document.addEventListener("mouseup", onUp);
              }}
              onDoubleClick={() => setTableFilterWidth(260)}
            />
          </>
        )}
        {/* Left "Columns" panel */}
        {colsPanelCollapsed ? (
          <div className="sp-cols-panel sp-cols-panel-collapsed">
            <button
              type="button"
              className="sp-cols-panel-toggle"
              title={t("dataTable.expandColPanel")}
              onClick={() => setColsPanelCollapsed(false)}
            >▶</button>
          </div>
        ) : (
          <>
          <div className="sp-cols-panel" style={{ width: colsPanelWidth, minWidth: colsPanelWidth }}>
            <div className="sp-cols-panel-header">
              <span className="sp-cols-panel-title">
                {t("dataTable.colsPanelHeader", { total: cols.length, sel: selectedCols.size > 0 ? t("dataTable.colsPanelSelSuffix", { n: selectedCols.size }) : "" })}
              </span>
              <button
                type="button"
                className="sp-cols-panel-toggle"
                title={t("dataTable.collapseColPanel")}
                onClick={() => setColsPanelCollapsed(true)}
              >◀</button>
            </div>
            <ColsPanelList
              cols={cols}
              colTypes={colTypes}
              selectedCols={selectedCols}
              colExtras={colExtras}
              onItemClick={stableColsPanelClick}
              onItemContextMenu={stableColsPanelCtxMenu}
              onReorder={stableColsPanelReorder}
            />
          </div>
          {/* Splitter: drag to resize the columns panel width. */}
          <div
            className="sp-cols-panel-splitter"
            title={t("dataTable.resizeColPanel")}
            onMouseDown={(e) => {
              e.preventDefault();
              const startX = e.clientX;
              const startW = colsPanelWidth;
              const onMove = (ev: MouseEvent) => {
                const next = Math.max(120, Math.min(600, startW + (ev.clientX - startX)));
                setColsPanelWidth(next);
              };
              const onUp = () => {
                document.removeEventListener("mousemove", onMove);
                document.removeEventListener("mouseup", onUp);
                document.body.style.cursor = "";
                document.body.style.userSelect = "";
              };
              document.addEventListener("mousemove", onMove);
              document.addEventListener("mouseup", onUp);
              document.body.style.cursor = "col-resize";
              document.body.style.userSelect = "none";
            }}
            onDoubleClick={() => setColsPanelWidth(200)}
          />
          </>
        )}

        {/* Right side: formula bar + grid (stacked vertically) */}
        <div className="sp-table-right">
          {/* Excel-like formula bar: editable cell ref + content editor */}
          <FormulaBar
            activeCell={activeCell}
            activeCellValue={activeCellValueStr}
            maxRow={formulaMaxRow}
            maxCol={formulaMaxCol}
            onJumpToCell={stableJumpToCell}
            onWriteActiveCell={stableWriteActiveCell}
            onMoveDownAfterCommit={stableMoveDownAfterCommit}
            onError={stableSetErrorMsg}
            onFocusGrid={stableFocusGrid}
          />

          {/* Spreadsheet table */}
          <div className="sp-grid-wrapper" ref={tableRef} onScroll={onGridScroll}>
        <table className="sp-grid" style={{ width: ROW_HDR_WIDTH + totalColsWidth + ADD_COL_WIDTH }}>
          <colgroup>
            <col style={{ width: ROW_HDR_WIDTH }} />
            {colVirtRange.leftSpacerW > 0 && <col style={{ width: colVirtRange.leftSpacerW }} />}
            {visibleColIdxs.map((ci) => (
              <col key={ci} style={{ width: (colWidths[ci] ?? BASE_DEFAULT_COL_WIDTH) * zoom }} />
            ))}
            {colVirtRange.rightSpacerW > 0 && <col style={{ width: colVirtRange.rightSpacerW }} />}
            <col style={{ width: ADD_COL_WIDTH }} />
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
              {colVirtRange.leftSpacerW > 0 && (
                <th className="sp-col-spacer-hdr" aria-hidden="true" style={{ background: "var(--bg-header)", borderBottom: "2px solid var(--border-header-bottom)" }} />
              )}
              {/* Column headers — event delegation via data-col-hdr (only visible cols) */}
              {visibleColIdxs.map((ci) => {
                const col = cols[ci];
                return (
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
                      <span className="sp-col-type">{labelOf(colTypes[ci])}</span>
                    </div>
                    {/* Resize handle */}
                    <div
                      className="sp-resize-handle"
                      onMouseDown={readOnly ? undefined : (e) => handleResizeStart(e, ci)}
                      onClick={(e) => e.stopPropagation()}
                      onDoubleClick={readOnly ? undefined : (e) => handleResizeDoubleClick(e, ci)}
                    />
                  </th>
                );
              })}
              {colVirtRange.rightSpacerW > 0 && (
                <th className="sp-col-spacer-hdr" aria-hidden="true" style={{ background: "var(--bg-header)", borderBottom: "2px solid var(--border-header-bottom)" }} />
              )}
              {/* "+" column at end */}
              <th className="sp-add-col-hdr" onClick={handleAddColumnQuick} title={t("dataTable.addColTitle")}>
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
                handleCellDoubleClick(
                  ri,
                  ci,
                  windowRowAt({ start: windowStart, rows: displayRows }, ri)?.[ci],
                );
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
            {renderedRange.startIdx > 0 && (
              <tr aria-hidden="true">
                <td colSpan={9999} style={{ padding: 0, border: "none", height: renderedRange.startIdx * ROW_HEIGHT }} />
              </tr>
            )}
            {!placeholderRange && retainedRenderRange.endIdx > retainedRenderRange.startIdx && (
              displayRows
                .slice(
                  retainedRenderRange.startIdx - windowStart,
                  retainedRenderRange.endIdx - windowStart,
                )
                .map((displayRow, idx) => {
                const ri = retainedRenderRange.startIdx + idx;
                const isRowSelected = selectedRows.has(ri);
                const isRowActive = activeRowRange.has(ri);
                const activeCol = activeCell?.row === ri ? activeCell.col : -1;
                const editingCol = editCell?.row === ri ? editCell.col : -1;
                let selStartCol = -1;
                let selEndCol = -1;
                if (selRangeNorm && ri >= selRangeNorm.r1 && ri <= selRangeNorm.r2) {
                  selStartCol = selRangeNorm.c1;
                  selEndCol = selRangeNorm.c2;
                }
                return (
                  <TableRow
                    key={ri}
                    ri={ri}
                    displayRow={displayRow}
                    colFormats={colFormats}
                    isRowSelected={isRowSelected}
                    isRowActive={isRowActive}
                    activeCol={activeCol}
                    selectedCols={selectedCols}
                    editingCol={editingCol}
                    editValue={editValue}
                    editInputRef={editInputRef}
                    selStartCol={selStartCol}
                    selEndCol={selEndCol}
                    selectedColsInRow={cellsByRow?.get(ri)}
                    visStart={colVirtRange.startIdx}
                    visEnd={colVirtRange.endIdx}
                    leftSpacerW={colVirtRange.leftSpacerW}
                    rightSpacerW={colVirtRange.rightSpacerW}
                    onEditValueChange={stableSetEditValue}
                    onCommitEdit={stableCommitEdit}
                    onCancelEdit={stableCancelEdit}
                  />
                );
              })
            )}
            {placeholderRange && Array.from(
              { length: placeholderRange.endIdx - placeholderRange.startIdx },
              (_, index) => {
                const rowIndex = placeholderRange.startIdx + index;
                return (
                  <tr key={`placeholder-${rowIndex}`} className="sp-placeholder-row" aria-hidden="true">
                    <td className="sp-row-hdr">{rowIndex + 1}</td>
                    {colVirtRange.leftSpacerW > 0 && (
                      <td className="sp-col-spacer" style={{ width: colVirtRange.leftSpacerW, padding: 0, border: "none" }} />
                    )}
                    {visibleColIdxs.map((columnIndex) => (
                      <td key={columnIndex} className="sp-cell sp-placeholder-cell" />
                    ))}
                    {colVirtRange.rightSpacerW > 0 && (
                      <td className="sp-col-spacer" style={{ width: colVirtRange.rightSpacerW, padding: 0, border: "none" }} />
                    )}
                    <td className="sp-add-col-cell" />
                  </tr>
                );
              },
            )}
            {/* Bottom spacer for virtual scroll */}
            {renderedRange.endIdx < totalRowCount && (
              <tr aria-hidden="true">
                <td colSpan={9999} style={{ padding: 0, border: "none", height: (totalRowCount - renderedRange.endIdx) * ROW_HEIGHT }} />
              </tr>
            )}
            {/* "Add row" bottom row */}
            <tr className="sp-add-row-tr">
              <td
                className="sp-add-row-hdr"
                onClick={handleAddRow}
                title={t("dataTable.addRowTitle")}
              >
                +
              </td>
              {colVirtRange.leftSpacerW > 0 && (
                <td className="sp-col-spacer" style={{ padding: 0, border: "none" }} aria-hidden="true" />
              )}
              {visibleColIdxs.map((ci) => (
                <td key={ci} className="sp-add-row-cell" />
              ))}
              {colVirtRange.rightSpacerW > 0 && (
                <td className="sp-col-spacer" style={{ padding: 0, border: "none" }} aria-hidden="true" />
              )}
              <td className="sp-add-corner" />
            </tr>
          </tbody>
        </table>
        </div>
        </div>
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
                {t("dataTable.ctxColPropsBatch", { n: selectedCols.size })}
              </div>
              <div className="sp-ctx-item" onClick={() => handleInsertColumnAfter(colMenu.colIdx)}>
                {t("dataTable.ctxInsertCol")}
              </div>
              <div className="sp-ctx-item" onClick={() => { setInsertColAnchor(colMenu.colIdx); setShowInsertMultiCols(true); setColMenu(null); }}>
                {t("dataTable.ctxInsertMultiCols")}
              </div>
              <div className="sp-ctx-sep" />
              <div
                className={`sp-ctx-item sp-ctx-danger ${cols.length - selectedCols.size < 1 ? "sp-ctx-disabled" : ""}`}
                onClick={handleDeleteSelectedCols}
              >
                {t("dataTable.ctxDeleteSelectedCols", { n: selectedCols.size })}
              </div>
            </>
          ) : (
            <>
              <div className="sp-ctx-item" onClick={() => handleStartRenameCol(colMenu.colIdx)}>
                {t("dataTable.ctxColProps")}
              </div>
              <div className="sp-ctx-item" onClick={() => handleInsertColumnAfter(colMenu.colIdx)}>
                {t("dataTable.ctxInsertCol")}
              </div>
              <div className="sp-ctx-item" onClick={() => { setInsertColAnchor(colMenu.colIdx); setShowInsertMultiCols(true); setColMenu(null); }}>
                {t("dataTable.ctxInsertMultiCols")}
              </div>
              <div className="sp-ctx-sep" />
              <div
                className={`sp-ctx-item sp-ctx-danger ${cols.length <= 1 ? "sp-ctx-disabled" : ""}`}
                onClick={() => cols.length > 1 && handleDeleteColumn(cols[colMenu.colIdx])}
              >
                {t("dataTable.ctxDeleteCol", { name: cols[colMenu.colIdx] })}
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
            {t("dataTable.ctxCopy")}<span className="sp-ctx-shortcut">{modKey}C</span>
          </div>
          <div className="sp-ctx-item" onClick={() => { handleCopy(true); setCellMenu(null); }}>
            {t("dataTable.ctxCopyHeader")}
          </div>
          <div className="sp-ctx-item" onClick={() => handleContextMenuPaste(false)}>
            {t("dataTable.ctxPaste")}<span className="sp-ctx-shortcut">{modKey}V</span>
          </div>
          <div className="sp-ctx-item" onClick={() => handleContextMenuPaste(true)}>
            {t("dataTable.ctxPasteHeader")}<span className="sp-ctx-shortcut">{modKey}{shiftKey}V</span>
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
            {t("dataTable.ctxInsertRow")}
          </div>
          <div className="sp-ctx-item" onClick={() => { setShowInsertMultiRows(true); setCornerMenu(null); }}>
            {t("dataTable.ctxInsertMultiRows")}
          </div>
          <div className="sp-ctx-sep" />
          <div className="sp-ctx-item" onClick={() => { handleAddColumnQuick(); setCornerMenu(null); }}>
            {t("dataTable.ctxInsertCol")}
          </div>
          <div className="sp-ctx-item" onClick={() => { setInsertColAnchor(null); setShowInsertMultiCols(true); setCornerMenu(null); }}>
            {t("dataTable.ctxInsertMultiCols")}
          </div>
          <div className="sp-ctx-sep" />
          <div className="sp-ctx-item" onClick={() => handleContextMenuPaste(false)}>
            {t("dataTable.ctxPaste")}<span className="sp-ctx-shortcut">{modKey}V</span>
          </div>
          <div className="sp-ctx-item" onClick={() => handleContextMenuPaste(true)}>
            {t("dataTable.ctxPasteHeader")}<span className="sp-ctx-shortcut">{modKey}{shiftKey}V</span>
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
            {t("dataTable.ctxInsertRow")}
          </div>
          <div className="sp-ctx-item" onClick={() => { setShowInsertMultiRows(true); setRowMenu(null); }}>
            {t("dataTable.ctxInsertMultiRows")}
          </div>
          <div className="sp-ctx-sep" />
          {selectedRows.size > 1 ? (
            <div className="sp-ctx-item sp-ctx-danger" onClick={handleDeleteRows}>
              {t("dataTable.ctxDeleteSelectedRows", { n: selectedRows.size })}
            </div>
          ) : (
            <div className="sp-ctx-item sp-ctx-danger" onClick={() => handleDeleteSingleRow(rowMenu.rowIdx)}>
              {t("dataTable.ctxDeleteRow")}
            </div>
          )}
        </div>
      )}

      {/* Insert multi-rows dialog */}
      {showInsertMultiRows && (
        <div className="sp-dialog-overlay" onClick={() => setShowInsertMultiRows(false)}>
          <div className="sp-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="sp-dialog-title">{t("dataTable.insertMultiRowsTitle")}</div>
            <div className="sp-dialog-body">
              <label className="sp-dialog-label">{t("dataTable.rowCount")}</label>
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
              <button className="sp-dialog-btn" onClick={() => setShowInsertMultiRows(false)}>{t("common.cancel")}</button>
              <button className="sp-dialog-btn sp-dialog-btn-primary" onClick={handleInsertMultiRows}>{t("common.confirm")}</button>
            </div>
          </div>
        </div>
      )}

      {/* Insert multi-cols dialog */}
      {showInsertMultiCols && (
        <div className="sp-dialog-overlay" onClick={() => { setShowInsertMultiCols(false); setInsertColAnchor(null); }}>
          <div className="sp-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="sp-dialog-title">{t("dataTable.insertMultiColsTitle")}</div>
            <div className="sp-dialog-body">
              <label className="sp-dialog-label">{t("dataTable.colCount")}</label>
              <input
                className="sp-dialog-input"
                type="number"
                min="1"
                value={insertColCount}
                onChange={(e) => setInsertColCount(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleInsertMultiCols(); }}
                autoFocus
              />
              <label className="sp-dialog-label">{t("dataTable.colPropsType")}</label>
              <select className="sp-dialog-select" value={insertColType} onChange={(e) => setInsertColType(e.target.value)}>
                {COLUMN_TYPE_VALUES.map((v) => <option key={v} value={v}>{labelOf(v)}</option>)}
              </select>
            </div>
            <div className="sp-dialog-actions">
              <button className="sp-dialog-btn" onClick={() => { setShowInsertMultiCols(false); setInsertColAnchor(null); }}>{t("common.cancel")}</button>
              <button className="sp-dialog-btn sp-dialog-btn-primary" onClick={handleInsertMultiCols}>{t("common.confirm")}</button>
            </div>
          </div>
        </div>
      )}

      {/* Batch column properties dialog */}
      {batchColProps && (
        <div className="sp-dialog-overlay">
          <div className="sp-dialog sp-dialog-wide" onClick={(e) => e.stopPropagation()}>
            <div className="sp-dialog-title">{t("dataTable.colPropsBatchTitle", { n: batchColProps.colIndices.length })}</div>
            <div className="sp-dialog-body">
              <label className="sp-dialog-label">{t("dataTable.colPropsType")}</label>
              <select className="sp-dialog-select" value={batchColType} onChange={(e) => setBatchColType(e.target.value)}>
                {COLUMN_TYPE_VALUES.map((v) => <option key={v} value={v}>{labelOf(v)}</option>)}
              </select>
              <label className="sp-dialog-label">{t("dataTable.colPropsFormat")}</label>
              <select className="sp-dialog-select" value={batchColFormat.kind} onChange={(e) => {
                const kind = e.target.value as FormatKind;
                setBatchColFormat(kind === "currency"
                  ? { kind, decimals: 2, currency: "CNY" }
                  : kind === "fixed" || kind === "percent"
                    ? { kind, decimals: 2 }
                    : { kind });
              }}>
                {FORMAT_KINDS.map((k) => <option key={k} value={k}>{t(`dataTable.format.${k}`)}</option>)}
              </select>
              {(batchColFormat.kind === "fixed" || batchColFormat.kind === "percent") && (
                <div style={{ marginTop: 6 }}>
                  <label className="sp-dialog-label">{t("dataTable.colPropsDigits")}</label>
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
                    <label className="sp-dialog-label">{t("dataTable.colPropsCurrency")}</label>
                    <select className="sp-dialog-select" value={batchColFormat.currency ?? "CNY"} onChange={(e) => setBatchColFormat((prev) => ({ ...prev, currency: e.target.value }))}>
                      {CURRENCY_OPTIONS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                    </select>
                  </div>
                  <div style={{ marginTop: 6 }}>
                    <label className="sp-dialog-label">{t("dataTable.colPropsDigits")}</label>
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
              <label className="sp-dialog-label">{t("dataTable.colPropsWidth")}</label>
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
                  // Avoid `Math.max(...arr)` spread: blows the JS argument
                  // limit on very wide tables. Iterate instead. Track in
                  // base units, then convert to visual for the input field.
                  let maxBaseW = BASE_DEFAULT_COL_WIDTH;
                  if (batchColProps.checkedCols.size > 0) {
                    maxBaseW = 0;
                    for (const ci of batchColProps.checkedCols) {
                      const w = autoFitColumn(ci);
                      if (w > maxBaseW) maxBaseW = w;
                    }
                    if (maxBaseW === 0) maxBaseW = BASE_DEFAULT_COL_WIDTH;
                  }
                  setBatchColWidth(String(Math.round(maxBaseW * zoom)));
                }}>{t("common.auto")}</button>
              </div>
              <label className="sp-dialog-label">{t("dataTable.colPropsApplyTo")}</label>
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
                    <span className="sp-batch-col-type">{labelOf(colTypes[ci])}</span>
                  </label>
                ))}
              </div>
              <div className="sp-batch-col-actions-row">
                <button className="sp-batch-sel-btn" onClick={() => setBatchColProps((p) => p ? { ...p, checkedCols: new Set(p.colIndices) } : p)}>{t("common.selectAll")}</button>
                <button className="sp-batch-sel-btn" onClick={() => setBatchColProps((p) => p ? { ...p, checkedCols: new Set() } : p)}>{t("common.selectNone")}</button>
              </div>
            </div>
            <div className="sp-dialog-actions">
              <button className="sp-dialog-btn" onClick={() => setBatchColProps(null)}>{t("common.cancel")}</button>
              <button className="sp-dialog-btn sp-dialog-btn-primary" onClick={handleApplyBatchColProps}>{t("common.confirm")}</button>
            </div>
          </div>
        </div>
      )}

      {showManageExtras && (
        <ManageExtrasDialog
          cols={cols}
          colExtras={colExtras}
          sourceDatasetName={useDataStore.getState().datasets.find((d) => d.id === datasetId)?.name}
          onApply={handleApplyManageExtras}
          onClose={() => setShowManageExtras(false)}
        />
      )}
    </div>
  );
}
