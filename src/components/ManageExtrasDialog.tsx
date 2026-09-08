import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { EXTRA_DEFS, EXTRA_KINDS, extraKindLabel, extraFieldLabel, type ExtraKind } from "@/types/columnExtras";
import { useDataStore } from "@/stores/useDataStore";
import { useProjectStore } from "@/stores/useProjectStore";
import { dataService } from "@/services/dataService";
import {
  resolveProjectBasenameForKind,
  type ProjectBasenameValidationError,
} from "@/utils/projectFileNaming";

/**
 * Per-column "additional properties" bag (same shape as ColumnDisplayProps.extras).
 * Indexed by visible column index (matching DataTableView's `cols`).
 */
export type ColExtrasArray = ReadonlyArray<Record<string, unknown> | null>;

interface ManageExtrasDialogProps {
  cols: string[];
  colExtras: ColExtrasArray;
  /** Source dataset (for default export name; not used to link). */
  sourceDatasetName?: string;
  /** User confirmed edits — caller updates state + persists. */
  onApply: (next: Array<Record<string, unknown> | null>) => void;
  onClose: () => void;
}

interface FlatField {
  kind: ExtraKind;
  fieldKey: string;
  /** Header text e.g. "规格 / 下限" or just "单位" for single-field kinds. */
  header: string;
  type: "text" | "number" | "longtext";
}

/** Build the flat list of grid sub-columns from selected kinds. */
function flattenFields(kinds: ExtraKind[], t: TFunction): FlatField[] {
  const out: FlatField[] = [];
  for (const k of kinds) {
    const def = EXTRA_DEFS[k];
    if (def.batchExcluded) continue; // belt-and-braces: shouldn't be selectable
    const single = def.fields.length === 1;
    const kindLabel = extraKindLabel(k, t);
    for (const f of def.fields) {
      // Skip fields whose editor doesn't fit a flat grid cell (e.g.
      // valueList). Defensive — `batchExcluded` already excludes the whole
      // kind, but a future kind could mix flat and list fields.
      if (f.type === "valueList") continue;
      out.push({
        kind: k,
        fieldKey: f.key,
        header: single ? kindLabel : `${kindLabel} / ${extraFieldLabel(k, f.key, t)}`,
        type: f.type,
      });
    }
  }
  return out;
}

/** Reverse lookup: header text → (kind, fieldKey, type). Built across ALL
 *  registered kinds so that import can recognize headers regardless of which
 *  kinds the user currently has selected. */
function buildHeaderIndex(t: TFunction): Map<string, FlatField> {
  const idx = new Map<string, FlatField>();
  for (const k of EXTRA_KINDS) {
    const def = EXTRA_DEFS[k];
    if (def.batchExcluded) continue;
    const single = def.fields.length === 1;
    const kindLabel = extraKindLabel(k, t);
    for (const f of def.fields) {
      if (f.type === "valueList") continue;
      const header = single ? kindLabel : `${kindLabel} / ${extraFieldLabel(k, f.key, t)}`;
      idx.set(header, { kind: k, fieldKey: f.key, header, type: f.type });
    }
  }
  return idx;
}

function invalidNameMessage(t: TFunction, code: ProjectBasenameValidationError): string {
  if (code === "empty") {
    return t("alert.invalidName.empty", {
      defaultValue: "Name cannot be empty.",
    });
  }
  if (code === "invalidChars") {
    return t("alert.invalidName.invalidChars", {
      defaultValue: "Name contains invalid characters: / \\ : * ? \" < > |",
    });
  }
  if (code === "edgeDots") {
    return t("alert.invalidName.edgeDots", {
      defaultValue: "Name cannot start or end with a dot or space.",
    });
  }
  if (code === "controlChars") {
    return t("alert.invalidName.controlChars", {
      defaultValue: "Name contains control characters.",
    });
  }
  return t("alert.invalidName.reserved", {
    defaultValue: "Name is reserved by Windows and cannot be used.",
  });
}

/**
 * 管理附加属性 dialog.
 *
 * Step 1 — select which columns and which extra kinds to include in the
 *          batch table. Defaults: all columns checked; kinds = union of
 *          kinds already present on any column (none if no column has extras).
 * Step 2 — editable grid: rows = selected columns, columns = expanded
 *          fields of the selected kinds. Edits stage locally; "应用" writes
 *          back via onApply, "重新载入" discards local edits.
 */
export function ManageExtrasDialog({
  cols, colExtras, sourceDatasetName, onApply, onClose,
}: ManageExtrasDialogProps) {
  const { t } = useTranslation();
  const readOnly = useProjectStore((s) => s.readOnly);
  // Datasets list — used by export (avoid name collision) and by import (picker).
  const datasets = useDataStore((s) => s.datasets);
  const refreshDatasets = useDataStore((s) => s.refreshDatasets);

  // ---- Step 1 state ----
  const initialCheckedCols = useMemo(() => new Set(cols.map((_, i) => i)), [cols]);
  const initialCheckedKinds = useMemo<Set<ExtraKind>>(() => {
    const present = new Set<ExtraKind>();
    for (const e of colExtras) {
      if (!e) continue;
      for (const k of EXTRA_KINDS) {
        if (e[k] !== undefined) present.add(k);
      }
    }
    return present.size > 0 ? present : new Set<ExtraKind>();
  }, [colExtras]);

  const [step, setStep] = useState<1 | 2>(1);
  const [checkedCols, setCheckedCols] = useState<Set<number>>(initialCheckedCols);
  const [checkedKinds, setCheckedKinds] = useState<Set<ExtraKind>>(initialCheckedKinds);

  // ---- Step 2 state: staged edits, shape ColExtrasArray scoped to selected cols ----
  // Map keyed by col index for sparse edits; values mirror the extras shape.
  // Initialized when entering step 2.
  const [staged, setStaged] = useState<Map<number, Record<string, unknown>>>(new Map());

  // ---- Step 2 import/export auxiliary state ----
  // Inline status message shown beneath the toolbar (e.g. "已导入 12 列;跳过 3 列").
  const [statusMsg, setStatusMsg] = useState<{ text: string; tone: "info" | "warn" | "error" } | null>(null);
  // Selected dataset id in the "从属性表导入" picker.
  const [importPickId, setImportPickId] = useState<string>("");

  const selectedColIndices = useMemo(
    () => Array.from(checkedCols).sort((a, b) => a - b),
    [checkedCols],
  );
  const selectedKinds = useMemo(
    () => EXTRA_KINDS.filter((k) => checkedKinds.has(k)),
    [checkedKinds],
  );
  const flatFields = useMemo(() => flattenFields(selectedKinds, t), [selectedKinds, t]);

  const enterStep2 = () => {
    if (selectedColIndices.length === 0 || selectedKinds.length === 0) return;
    // Seed staged with current extras for selected cols (deep-ish copy)
    const seeded = new Map<number, Record<string, unknown>>();
    for (const ci of selectedColIndices) {
      const cur = colExtras[ci];
      seeded.set(ci, cur ? structuredClone(cur) as Record<string, unknown> : {});
    }
    setStaged(seeded);
    setStep(2);
  };

  const reload = () => {
    const seeded = new Map<number, Record<string, unknown>>();
    for (const ci of selectedColIndices) {
      const cur = colExtras[ci];
      seeded.set(ci, cur ? structuredClone(cur) as Record<string, unknown> : {});
    }
    setStaged(seeded);
  };

  const getCellValue = (ci: number, f: FlatField): string => {
    const colE = staged.get(ci);
    if (!colE) return "";
    const kindObj = colE[f.kind] as Record<string, unknown> | undefined;
    const v = kindObj?.[f.fieldKey];
    return v == null ? "" : String(v);
  };

  const setCellValue = (ci: number, f: FlatField, raw: string) => {
    if (readOnly) return;
    setStaged((prev) => {
      const next = new Map(prev);
      const colE = { ...(next.get(ci) ?? {}) };
      const kindObj: Record<string, unknown> = { ...((colE[f.kind] as Record<string, unknown> | undefined) ?? {}) };
      let value: unknown;
      if (f.type === "number") {
        value = raw === "" ? null : Number(raw);
        if (typeof value === "number" && Number.isNaN(value)) value = null;
      } else {
        value = raw;
      }
      kindObj[f.fieldKey] = value;
      colE[f.kind] = kindObj;
      next.set(ci, colE);
      return next;
    });
  };

  /** Export the current batch grid (staged edits + read-only列名 column) to a
   *  brand-new普通数据表. The user can then edit it like any other table and
   *  reimport via "从属性表导入". */
  const handleExport = async () => {
    if (readOnly) return;
    if (selectedColIndices.length === 0 || flatFields.length === 0) return;
    const baseName = sourceDatasetName
      ? t("extras.exportBaseName", { name: sourceDatasetName })
      : t("extras.exportBaseNameDefault");
    const suggested = resolveProjectBasenameForKind(baseName, "table", datasets.map((dataset) => dataset.name));
    const proposed = window.prompt(t("extras.exportPromptTitle"), suggested.error ? baseName : suggested.basename);
    if (!proposed) return;
    const resolved = resolveProjectBasenameForKind(proposed, "table", datasets.map((dataset) => dataset.name));
    if (resolved.error === "wrongExtension") {
      setStatusMsg({
        text: t("extras.exportWrongExtension", {
          defaultValue: "Use the {{expected}} extension for table names (not {{actual}}).",
          expected: resolved.expectedExtension,
          actual: resolved.actualExtension,
        }),
        tone: "error",
      });
      return;
    }
    if (resolved.error) {
      setStatusMsg({ text: invalidNameMessage(t, resolved.error), tone: "error" });
      return;
    }
    const name = resolved.basename;
    try {
      const colNames = [t("extras.columnNameHeader"), ...flatFields.map((f) => f.header)];
      const colTypes = ["VARCHAR", ...flatFields.map((f) => (f.type === "number" ? "DOUBLE" : "VARCHAR"))];
      const rows = selectedColIndices.map((ci) => {
        const payload: Array<string | number | null> = [cols[ci]];
        for (const field of flatFields) {
          const raw = getCellValue(ci, field);
          if (field.type === "number") {
            const numeric = raw === "" ? null : Number(raw);
            payload.push(Number.isFinite(numeric) ? numeric : null);
          } else {
            payload.push(raw);
          }
        }
        return payload;
      });
      const created = await dataService.createTableFromRows({
        name,
        columnNames: colNames,
        columnTypes: colTypes,
        rows,
      });
      await refreshDatasets();
      setStatusMsg({ text: t("extras.exportSuccess", { name: created.name, rows: rows.length }), tone: "info" });
    } catch (e) {
      setStatusMsg({ text: t("extras.exportFailed", { err: String(e) }), tone: "error" });
    }
  };

  /** Import from a user-picked dataset. Matches by 列名 (first column expected
   *  to be either "列名" or whatever its first column is); other column headers
   *  must match the standard naming scheme ("kindLabel" or "kindLabel / fieldLabel").
   *  Unmatched columns / rows are summarized in statusMsg. */
  const handleImport = async () => {
    if (readOnly) return;
    if (!importPickId) {
      setStatusMsg({ text: t("extras.importPickFirst"), tone: "warn" });
      return;
    }
    try {
      // Pull the full table in one big page (max 100k rows is plenty for属性表).
      const result = await dataService.queryTable({
        datasetId: importPickId, page: 0, pageSize: 100000,
      });
      // First non-_row_id column is the key; remaining are field columns.
      const allCols = result.columns;
      const visibleCols = allCols.filter((c) => c !== "_row_id");
      if (visibleCols.length < 2) {
        setStatusMsg({ text: t("extras.importTooFewCols"), tone: "error" });
        return;
      }
      const colIndexInRows = (name: string) => allCols.indexOf(name);
      const keyColName = visibleCols[0];
      const keyColIdx = colIndexInRows(keyColName);

      // Map each subsequent header → FlatField via the global header index.
      const headerIdx = buildHeaderIndex(t);
      const fieldMappings: Array<{ rowColIdx: number; field: FlatField } | null> =
        visibleCols.slice(1).map((h) => {
          const f = headerIdx.get(h);
          return f ? { rowColIdx: colIndexInRows(h), field: f } : null;
        });
      const unknownHeaders = visibleCols.slice(1).filter((h) => !headerIdx.has(h));

      // Build name → source col index map for the cols currently in view.
      const nameToCi = new Map<string, number>();
      cols.forEach((n, i) => nameToCi.set(n, i));

      // Merge into staged Map. We replace values for matched (col, field) pairs
      // entirely from the imported value (including blanks → null, so users
      // can clear a field by emptying it in the spec table).
      const next = new Map(staged);
      let matchedRows = 0;
      const skippedRowKeys: string[] = [];
      // Auto-extend selectedKinds with any kind that appears in the imported
      // file but isn't currently selected — so the batch grid actually shows
      // the imported data after the import completes.
      const kindsSeen = new Set<ExtraKind>(selectedKinds);
      for (const m of fieldMappings) if (m) kindsSeen.add(m.field.kind);
      for (const row of result.rows) {
        const keyVal = row[keyColIdx];
        const key = keyVal == null ? "" : String(keyVal);
        const ci = nameToCi.get(key);
        if (ci === undefined) {
          if (key) skippedRowKeys.push(key);
          continue;
        }
        // Only apply if this col is in the current selectedColIndices set;
        // otherwise the user opted not to manage it this round.
        if (!checkedCols.has(ci)) {
          skippedRowKeys.push(t("extras.skippedUnchecked", { name: key }));
          continue;
        }
        const colE: Record<string, unknown> = { ...(next.get(ci) ?? {}) };
        for (let i = 0; i < fieldMappings.length; i++) {
          const m = fieldMappings[i];
          if (!m) continue;
          const raw = row[m.rowColIdx];
          const kindObj: Record<string, unknown> = { ...((colE[m.field.kind] as Record<string, unknown> | undefined) ?? {}) };
          let value: unknown;
          if (raw == null || raw === "") {
            value = null;
          } else if (m.field.type === "number") {
            const n = Number(raw);
            value = Number.isFinite(n) ? n : null;
          } else {
            value = String(raw);
          }
          kindObj[m.field.fieldKey] = value;
          colE[m.field.kind] = kindObj;
        }
        next.set(ci, colE);
        matchedRows += 1;
      }
      setStaged(next);
      if (kindsSeen.size > checkedKinds.size) setCheckedKinds(kindsSeen);
      const parts = [t("extras.importDoneRows", { n: matchedRows })];
      if (skippedRowKeys.length > 0) {
        parts.push(t("extras.importSkippedRows", {
          n: skippedRowKeys.length,
          names: skippedRowKeys.slice(0, 3).join(", "),
          more: skippedRowKeys.length > 3 ? "…" : "",
        }));
      }
      if (unknownHeaders.length > 0) {
        parts.push(t("extras.importIgnoredCols", { names: unknownHeaders.join(", ") }));
      }
      setStatusMsg({ text: parts.join("; "), tone: skippedRowKeys.length || unknownHeaders.length ? "warn" : "info" });
    } catch (e) {
      setStatusMsg({ text: t("extras.importFailed", { err: String(e) }), tone: "error" });
    }
  };

  /** Compose the final extras array, merging staged edits into the existing
   *  per-column extras. Untouched columns are preserved as-is. Kinds NOT in
   *  the user's selected-kinds set are also preserved as-is (we only edit
   *  the kinds the user explicitly chose). */
  const apply = () => {
    if (readOnly) return;
    const result: Array<Record<string, unknown> | null> = cols.map((_, i) => {
      const cur = colExtras[i];
      return cur ? { ...cur } : null;
    });
    for (const ci of selectedColIndices) {
      const stagedE = staged.get(ci) ?? {};
      const merged: Record<string, unknown> = { ...(result[ci] ?? {}) };
      // Replace each selected kind from the staged edits; if the staged
      // kind value is empty (all fields null/blank), drop the kind.
      for (const k of selectedKinds) {
        const stagedVal = stagedE[k] as Record<string, unknown> | undefined;
        if (stagedVal === undefined) continue;
        const allEmpty = Object.values(stagedVal).every(
          (v) => v == null || v === "",
        );
        if (allEmpty) {
          delete merged[k];
        } else {
          merged[k] = stagedVal;
        }
      }
      result[ci] = Object.keys(merged).length > 0 ? merged : null;
    }
    onApply(result);
    onClose();
  };

  // ---- Render ----
  return (
    <div className="sp-dialog-overlay">
      <div
        className="sp-dialog"
        style={{ width: step === 1 ? 540 : "min(960px, 90vw)", maxWidth: "90vw" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sp-dialog-title">
          {t("extras.manageTitle")} {step === 1 ? t("extras.manageStep1") : t("extras.manageStep2", { n: selectedColIndices.length })}
        </div>
        <div className="sp-dialog-body">
          {step === 1 ? (
            <Step1
              cols={cols}
              checkedCols={checkedCols}
              setCheckedCols={setCheckedCols}
              checkedKinds={checkedKinds}
              setCheckedKinds={setCheckedKinds}
            />
          ) : (
            <Step2
              cols={cols}
              selectedColIndices={selectedColIndices}
              flatFields={flatFields}
              getCellValue={getCellValue}
              setCellValue={setCellValue}
              readOnly={readOnly}
              datasets={datasets}
              importPickId={importPickId}
              setImportPickId={setImportPickId}
              onExport={handleExport}
              onImport={handleImport}
              statusMsg={statusMsg}
            />
          )}
        </div>
        <div className="sp-dialog-actions">
          <button className="sp-dialog-btn" onClick={onClose}>{t("common.cancel")}</button>
          {step === 1 ? (
            <button
              className="sp-dialog-btn sp-dialog-btn-primary"
              onClick={enterStep2}
              disabled={readOnly || selectedColIndices.length === 0 || selectedKinds.length === 0}
            >{t("extras.next")}</button>
          ) : (
            <>
              <button className="sp-dialog-btn" onClick={() => setStep(1)}>{t("common.back")}</button>
              <button className="sp-dialog-btn" onClick={reload} disabled={readOnly}>{t("extras.reload")}</button>
              <button className="sp-dialog-btn sp-dialog-btn-primary" onClick={apply} disabled={readOnly}>{t("extras.applyToCols")}</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ---- Step 1 sub-view ----
interface Step1Props {
  cols: string[];
  checkedCols: Set<number>;
  setCheckedCols: (next: Set<number>) => void;
  checkedKinds: Set<ExtraKind>;
  setCheckedKinds: (next: Set<ExtraKind>) => void;
}

function Step1({
  cols, checkedCols, setCheckedCols, checkedKinds, setCheckedKinds,
}: Step1Props) {
  const { t } = useTranslation();
  // Anchor for shift-range selection. Reset when the user plain-clicks (no
  // modifier), so the next shift-click defines a fresh range from there.
  const lastClickedRef = useRef<number | null>(null);
  // Tracked in state too so we can render the anchor with a persistent
  // highlight — without this, users lose the visual reference as soon as the
  // mouse moves off the row, making shift-range hard to predict.
  const [anchor, setAnchor] = useState<number | null>(null);

  /**
   * Click handler for column rows.
   * - Plain click: toggle just this row, set anchor.
   * - Ctrl/Cmd click: same as plain click but is conceptually "additive" (we
   *   already preserve other rows, so behavior matches Excel/file-explorer
   *   ctrl-click toggle), update anchor.
   * - Shift click: set [anchor, i] to the same checked state as the anchor
   *   row. If no anchor yet, fall back to plain toggle.
   */
  const handleColClick = (i: number, e: React.MouseEvent) => {
    // We drive everything from the row click; suppress the synthetic checkbox
    // event so it doesn't double-toggle.
    e.preventDefault();
    const next = new Set(checkedCols);
    if (e.shiftKey && lastClickedRef.current !== null) {
      const anchor = lastClickedRef.current;
      const lo = Math.min(anchor, i);
      const hi = Math.max(anchor, i);
      // Make the entire range match the anchor's checked state. If the anchor
      // was checked, fill checked; otherwise clear.
      const fill = checkedCols.has(anchor);
      for (let j = lo; j <= hi; j++) {
        if (fill) next.add(j); else next.delete(j);
      }
    } else {
      if (next.has(i)) next.delete(i); else next.add(i);
      lastClickedRef.current = i;
    }
    setAnchor(i);
    setCheckedCols(next);
  };

  const toggleKind = (k: ExtraKind) => {
    const next = new Set(checkedKinds);
    if (next.has(k)) next.delete(k); else next.add(k);
    setCheckedKinds(next);
  };
  const allColsChecked = checkedCols.size === cols.length;
  return (
    <div style={{ display: "flex", gap: 12 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="sp-dialog-label" style={{ display: "flex", justifyContent: "space-between" }}>
          <span>{t("extras.columnsHeader", { sel: checkedCols.size, total: cols.length })}</span>
          <button
            className="sp-dialog-btn"
            style={{ padding: "0 6px", fontSize: 11 }}
            onClick={() => setCheckedCols(allColsChecked ? new Set() : new Set(cols.map((_, i) => i)))}
          >{allColsChecked ? t("common.selectNone") : t("common.selectAll")}</button>
        </div>
        <div className="sp-extras-picker-list">
          {cols.map((name, i) => (
            <label
              key={i}
              className={`sp-extras-picker-item${anchor === i ? " sp-extras-picker-item-anchor" : ""}`}
              onClick={(e) => handleColClick(i, e)}
            >
              <input
                type="checkbox"
                checked={checkedCols.has(i)}
                readOnly
                tabIndex={-1}
              />
              <span className="sp-extras-picker-item-name">{name || t("dataTable.colsPanelItemFallback", { letter: i + 1 })}</span>
            </label>
          ))}
        </div>
      </div>
      <div style={{ flex: "0 0 200px" }}>
        <div className="sp-dialog-label">{t("extras.kindsHeader")}</div>
        <div className="sp-extras-picker-list">
          {EXTRA_KINDS.filter((k) => !EXTRA_DEFS[k].batchExcluded).map((k) => (
            <label key={k} className="sp-extras-picker-item">
              <input
                type="checkbox"
                checked={checkedKinds.has(k)}
                onChange={() => toggleKind(k)}
              />
              <span className="sp-extras-picker-item-name">{extraKindLabel(k, t)}</span>
            </label>
          ))}
        </div>
        {EXTRA_KINDS.some((k) => EXTRA_DEFS[k].batchExcluded) && (
          <div style={{ fontSize: 10, color: "var(--fg-hint)", fontStyle: "italic", marginTop: 4 }}>
            {t("extras.valueOrder.batchHint")}
          </div>
        )}
      </div>
    </div>
  );
}

// ---- Step 2 sub-view ----
interface Step2Props {
  cols: string[];
  selectedColIndices: number[];
  flatFields: FlatField[];
  getCellValue: (ci: number, f: FlatField) => string;
  setCellValue: (ci: number, f: FlatField, raw: string) => void;
  readOnly: boolean;
  datasets: ReadonlyArray<{ id: string; name: string }>;
  importPickId: string;
  setImportPickId: (id: string) => void;
  onExport: () => void;
  onImport: () => void;
  statusMsg: { text: string; tone: "info" | "warn" | "error" } | null;
}

function Step2({
  cols, selectedColIndices, flatFields, getCellValue, setCellValue,
  readOnly, datasets, importPickId, setImportPickId, onExport, onImport, statusMsg,
}: Step2Props) {
  const { t } = useTranslation();
  return (
    <div className="sp-extras-batch-wrapper">
      <div className="sp-extras-batch-toolbar">
        <div className="sp-extras-batch-toolbar-group">
          <select
            className="sp-extras-batch-select"
            value={importPickId}
            onChange={(e) => setImportPickId(e.target.value)}
            disabled={readOnly}
          >
            <option value="">{t("extras.selectPropTable")}</option>
            {datasets.map((d) => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>
          <button
            className="sp-dialog-btn"
            onClick={onImport}
            disabled={readOnly || !importPickId}
            title={t("extras.importTitleHint")}
          >{t("extras.importFrom")}</button>
        </div>
        <div className="sp-extras-batch-toolbar-group">
          <button
            className="sp-dialog-btn"
            onClick={onExport}
            disabled={readOnly}
            title={t("extras.exportTitleHint")}
          >{t("extras.exportTo")}</button>
        </div>
      </div>
      {statusMsg && (
        <div className={`sp-extras-batch-status sp-extras-batch-status-${statusMsg.tone}`}>
          {statusMsg.text}
        </div>
      )}
      <div className="sp-extras-batch-hint">
        {t("extras.hint")}
      </div>
      <div className="sp-extras-batch-scroll">
        <table className="sp-extras-batch-table">
          <thead>
            <tr>
              <th className="sp-extras-batch-th-name">{t("extras.columnNameHeader")}</th>
              {flatFields.map((f, i) => (
                <th key={i} className="sp-extras-batch-th">{f.header}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {selectedColIndices.map((ci) => (
              <tr key={ci}>
                <td className="sp-extras-batch-td-name" title={cols[ci]}>{cols[ci]}</td>
                {flatFields.map((f, fi) => (
                  <td key={fi} className="sp-extras-batch-td">
                    <input
                      className="sp-extras-batch-input"
                      type={f.type === "number" ? "number" : "text"}
                      value={getCellValue(ci, f)}
                      onChange={(e) => setCellValue(ci, f, e.target.value)}
                      disabled={readOnly}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
