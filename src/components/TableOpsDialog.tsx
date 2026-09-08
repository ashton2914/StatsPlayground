import { useState, useEffect, useLayoutEffect, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { dataService } from "@/services/dataService";
import { useProjectStore } from "@/stores/useProjectStore";
import { DualListPicker } from "@/components/DualListPicker";
import { createTableTransformDraft } from "@/components/tableTransform/createTableTransformDraft";
import {
  DEFAULT_TABLE_TRANSFORM_TYPE,
  TABLE_TRANSFORM_TYPES,
  type TableTransformType,
} from "@/components/tableTransform/tableTransformOptions";
import type { DatasetMeta } from "@/types/data";
import type { TableFilterComparisonOperator, TableTransformDraft, TableTransformOperation } from "@/types/tableTransform";

// ─── Types ───

/**
 * Each form registers its primary (Confirm) action with the parent through
 * `setPrimary`, so that Confirm and Cancel can be rendered together in the
 * outer footer. `null` means no Confirm button is shown.
 */
export type PrimaryAction = { disabled: boolean; onClick: () => void };
export type SetPrimary = (p: PrimaryAction | null) => void;

interface Props {
  datasets: DatasetMeta[];
  activeDatasetId: string | null;
  onClose: () => void;
  onSubmit: (draft: TableTransformDraft) => Promise<void>;
}

type DraftExecutor = (operation: TableTransformOperation, tableIds: string[], outputName: string) => void;

// ─── Shared helpers ───

/**
 * Re-order a list of column keys back to the source table's natural order.
 * The DualListPicker tracks insertion order, but for table operations we want
 * the result columns to appear in their original positions.
 */
function sortByColOrder(keys: string[], cols: [string, string][]): string[] {
  const order = new Map(cols.map(([n], i) => [n, i]));
  return [...keys].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
}

function DatasetSelect({
  datasets, value, onChange, label, exclude,
}: {
  datasets: DatasetMeta[];
  value: string;
  onChange: (v: string) => void;
  label: string;
  exclude?: string;
}) {
  const { t } = useTranslation();
  const filtered = exclude ? datasets.filter(d => d.id !== exclude) : datasets;
  return (
    <div className="sp-dialog-field">
      <label className="sp-dialog-label">{label}</label>
      <select className="sp-dialog-select" value={value} onChange={e => onChange(e.target.value)}>
        <option value="">{t("tableOp.selectTablePlaceholder")}</option>
        {filtered.map(d => (
          <option key={d.id} value={d.id}>{d.name} ({d.rowCount}×{d.colCount})</option>
        ))}
      </select>
    </div>
  );
}

// ─── Main Component ───

export function TableOpsDialog({ datasets, activeDatasetId, onClose, onSubmit }: Props) {
  const { t } = useTranslation();
  const readOnly = useProjectStore((s) => s.readOnly);
  const [op, setOp] = useState<TableTransformType>(DEFAULT_TABLE_TRANSFORM_TYPE);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [primary, setPrimary] = useState<PrimaryAction | null>(null);

  // Source dataset (most ops work on the active dataset)
  const [sourceId, setSourceId] = useState(activeDatasetId ?? "");
  const [cols, setCols] = useState<[string, string][]>([]);

  // Load columns when source changes
  useEffect(() => {
    if (!sourceId) { setCols([]); return; }
    dataService.getColumns(sourceId).then(setCols).catch(() => setCols([]));
  }, [sourceId]);

  const sourceName = datasets.find(d => d.id === sourceId)?.name ?? "";

  // Memoized so child forms can put `exec` in their useLayoutEffect deps without
  // re-registering primary on every parent render.
  const exec = useCallback(async (operation: TableTransformOperation, tableIds: string[], outputName: string) => {
    setError(null);
    setBusy(true);
    try {
      await onSubmit(createTableTransformDraft(outputName, outputName, operation, tableIds));
      onClose();
    } catch (e: unknown) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [onSubmit, onClose]);

  const labels: Record<TableTransformType, string> = {
    summary: t("tableOp.summary"),
    subset: t("tableOp.subset"),
    sort: t("tableOp.sort"),
    stack: t("tableOp.stack"),
    split: t("tableOp.split"),
    transpose: t("tableOp.transpose"),
    join: t("tableOp.join"),
    update: t("tableOp.update"),
    concatenate: t("tableOp.concatenate"),
  };

  const confirmDisabled = busy || readOnly || !primary || primary.disabled;

  const handleOperationChange = (next: TableTransformType) => {
    setPrimary(null);
    setError(null);
    setOp(next);
  };

  return (
    <div className="sp-dialog-overlay" onMouseDown={onClose}>
      <div className="sp-dialog sp-dialog-wide" onMouseDown={e => e.stopPropagation()}>
        <div className="sp-dialog-title">{t("tableOp.transformTitle", { defaultValue: "Transform Table" })}</div>
        <div className="sp-dialog-body">
          <div className="sp-dialog-field">
            <label className="sp-dialog-label" htmlFor="table-transform-type">
              {t("tableOp.transformType", { defaultValue: "Transform type" })}
            </label>
            <select
              id="table-transform-type"
              className="sp-dialog-select"
              value={op}
              onChange={(event) => handleOperationChange(event.target.value as TableTransformType)}
            >
              {TABLE_TRANSFORM_TYPES.map((type) => (
                <option key={type} value={type}>{labels[type]}</option>
              ))}
            </select>
          </div>

          {/* Source dataset selector (for most ops) */}
          {op !== "join" && op !== "update" && op !== "concatenate" && (
            <DatasetSelect datasets={datasets} value={sourceId} onChange={setSourceId} label={t("tableOp.sourceTable")} />
          )}

          {/* Per-op UI */}
          {op === "sort" && <SortForm sourceId={sourceId} cols={cols} sourceName={sourceName} exec={exec} setPrimary={setPrimary} t={t} />}
          {op === "subset" && <SubsetForm sourceId={sourceId} cols={cols} sourceName={sourceName} exec={exec} setPrimary={setPrimary} t={t} />}
          {op === "summary" && <SummaryForm sourceId={sourceId} cols={cols} sourceName={sourceName} exec={exec} setPrimary={setPrimary} t={t} />}
          {op === "transpose" && <TransposeForm sourceId={sourceId} sourceName={sourceName} exec={exec} setPrimary={setPrimary} t={t} />}
          {op === "stack" && <StackForm sourceId={sourceId} cols={cols} sourceName={sourceName} exec={exec} setPrimary={setPrimary} t={t} />}
          {op === "split" && <SplitForm sourceId={sourceId} cols={cols} sourceName={sourceName} exec={exec} setPrimary={setPrimary} t={t} />}
          {op === "join" && <JoinForm datasets={datasets} activeId={activeDatasetId} exec={exec} setPrimary={setPrimary} t={t} />}
          {op === "update" && <UpdateForm datasets={datasets} activeId={activeDatasetId} exec={exec} setPrimary={setPrimary} t={t} />}
          {op === "concatenate" && <ConcatenateForm datasets={datasets} activeId={activeDatasetId} exec={exec} setPrimary={setPrimary} t={t} />}

          {error && <div className="sp-dialog-error">{error}</div>}
        </div>
        <div className="sp-dialog-actions">
          <button
            className="sp-dialog-btn sp-dialog-btn-primary"
            disabled={confirmDisabled}
            onClick={() => primary?.onClick()}
          >{t("common.confirm")}</button>
          <button className="sp-dialog-btn" onClick={onClose} disabled={busy}>{t("common.cancel")}</button>
        </div>
      </div>
    </div>
  );
}

// ─── Sort ───

function SortForm({ sourceId, cols, sourceName, exec, setPrimary, t }: {
  sourceId: string; cols: [string, string][]; sourceName: string;
  exec: DraftExecutor; setPrimary: SetPrimary; t: TFunction;
}) {
  const [sortCol, setSortCol] = useState("");
  const [sortOrder, setSortOrder] = useState("asc");

  useEffect(() => { if (cols.length > 0 && !sortCol) setSortCol(cols[0][0]); }, [cols]);

  useLayoutEffect(() => {
    setPrimary({
      disabled: !sourceId || !sortCol,
      onClick: () => exec({ kind: "sort", sortColumns: [{ column: sortCol, direction: sortOrder === "asc" ? "ascending" : "descending" }] }, [sourceId], t("tableOp.resultSuffix.sort", { name: sourceName })),
    });
  }, [setPrimary, sourceId, sortCol, sortOrder, sourceName, exec, t]);

  return (
    <>
      <div className="sp-dialog-field">
        <label className="sp-dialog-label">{t("tableOp.sortColumn")}</label>
        <select className="sp-dialog-select" value={sortCol} onChange={e => setSortCol(e.target.value)}>
          {cols.map(([n]) => <option key={n} value={n}>{n}</option>)}
        </select>
      </div>
      <div className="sp-dialog-field">
        <label className="sp-dialog-label">{t("tableOp.sortOrder")}</label>
        <select className="sp-dialog-select" value={sortOrder} onChange={e => setSortOrder(e.target.value)}>
          <option value="asc">{t("tableOp.sortAsc")}</option>
          <option value="desc">{t("tableOp.sortDesc")}</option>
        </select>
      </div>
    </>
  );
}

// ─── Subset ───

function SubsetForm({ sourceId, cols, sourceName, exec, setPrimary, t }: {
  sourceId: string; cols: [string, string][]; sourceName: string;
  exec: DraftExecutor; setPrimary: SetPrimary; t: TFunction;
}) {
  const [selectedCols, setSelectedCols] = useState<string[]>([]);
  const [filterColumn, setFilterColumn] = useState("");
  const [filterOperator, setFilterOperator] = useState<TableFilterComparisonOperator>("equal");
  const [filterValue, setFilterValue] = useState("");

  // Default: keep all columns whenever the source table changes.
  useEffect(() => { setSelectedCols(cols.map(([n]) => n)); }, [cols]);
  useEffect(() => { setFilterColumn(""); setFilterValue(""); }, [sourceId]);

  const items = useMemo(
    () => cols.map(([name, type_]) => ({ key: name, label: name, hint: type_ })),
    [cols],
  );

  useLayoutEffect(() => {
    setPrimary({
      disabled: !sourceId || selectedCols.length === 0,
      onClick: () => exec({
        kind: "subset",
        columns: sortByColOrder(selectedCols, cols),
        filter: filterColumn ? {
          kind: "comparison",
          column: filterColumn,
          operator: filterOperator,
          value: { type: "string", value: filterValue },
        } : undefined,
      }, [sourceId], t("tableOp.resultSuffix.subset", { name: sourceName })),
    });
  }, [setPrimary, sourceId, selectedCols, cols, filterColumn, filterOperator, filterValue, sourceName, exec, t]);

  return (
    <>
      <DualListPicker
        items={items}
        selected={selectedCols}
        onChange={setSelectedCols}
        availableLabel={t("picker.available", { defaultValue: "Available columns" })}
        selectedLabel={t("tableOp.subsetColumns")}
      />
      <div className="sp-dialog-field">
        <label className="sp-dialog-label">{t("tableOp.subsetWhere")}</label>
        <div className="sp-dialog-inline-fields">
          <select className="sp-dialog-select" aria-label={t("tableOp.subsetFilterColumn", { defaultValue: "Filter column" })} value={filterColumn} onChange={e => setFilterColumn(e.target.value)}>
            <option value="">{t("tableOp.subsetNoFilter", { defaultValue: "No filter" })}</option>
            {cols.map(([name]) => <option key={name} value={name}>{name}</option>)}
          </select>
          <select className="sp-dialog-select" aria-label={t("tableOp.subsetFilterOperator", { defaultValue: "Filter operator" })} value={filterOperator} disabled={!filterColumn} onChange={e => setFilterOperator(e.target.value as TableFilterComparisonOperator)}>
            <option value="equal">=</option><option value="notEqual">!=</option><option value="greaterThan">&gt;</option><option value="greaterThanOrEqual">&gt;=</option><option value="lessThan">&lt;</option><option value="lessThanOrEqual">&lt;=</option>
          </select>
          <input className="sp-dialog-input" aria-label={t("tableOp.subsetFilterValue", { defaultValue: "Filter value" })} value={filterValue} disabled={!filterColumn} onChange={e => setFilterValue(e.target.value)} />
        </div>
      </div>
    </>
  );
}

// ─── Summary ───

function SummaryForm({ sourceId, cols, sourceName, exec, setPrimary, t }: {
  sourceId: string; cols: [string, string][]; sourceName: string;
  exec: DraftExecutor; setPrimary: SetPrimary; t: TFunction;
}) {
  const [statCols, setStatCols] = useState<string[]>([]);
  const [groupCols, setGroupCols] = useState<string[]>([]);
  const [stats, setStats] = useState<Set<string>>(new Set(["n", "mean", "std", "min", "max"]));

  // Drop stale picks when source columns change.
  useEffect(() => {
    const valid = new Set(cols.map(c => c[0]));
    setStatCols(prev => prev.filter(k => valid.has(k)));
    setGroupCols(prev => prev.filter(k => valid.has(k)));
  }, [cols]);

  const items = useMemo(
    () => cols.map(([name, type_]) => ({ key: name, label: name, hint: type_ })),
    [cols],
  );

  const allStats = [
    { key: "n", label: t("tableOp.stat_count") },
    { key: "mean", label: t("tableOp.stat_mean") },
    { key: "std", label: t("tableOp.stat_std") },
    { key: "min", label: t("tableOp.stat_min") },
    { key: "max", label: t("tableOp.stat_max") },
    { key: "sum", label: t("tableOp.stat_sum") },
    { key: "median", label: t("tableOp.stat_median") },
  ];

  useLayoutEffect(() => {
    setPrimary({
      disabled: !sourceId || statCols.length === 0 || stats.size === 0,
      onClick: () => exec({ kind: "summary", statisticColumns: sortByColOrder(statCols, cols), groupColumns: sortByColOrder(groupCols, cols), statistics: [...stats] as Array<"n" | "mean" | "std" | "min" | "max" | "sum" | "median"> }, [sourceId], t("tableOp.resultSuffix.summary", { name: sourceName })),
    });
  }, [setPrimary, sourceId, statCols, groupCols, cols, stats, sourceName, exec, t]);

  const availableLabel = t("picker.available", { defaultValue: "Available columns" });

  return (
    <>
      <DualListPicker
        items={items}
        selected={statCols}
        onChange={setStatCols}
        availableLabel={availableLabel}
        selectedLabel={t("tableOp.summaryColumns")}
      />
      <DualListPicker
        items={items}
        selected={groupCols}
        onChange={setGroupCols}
        availableLabel={availableLabel}
        selectedLabel={t("tableOp.summaryGroupBy")}
      />
      <div className="sp-dialog-field">
        <label className="sp-dialog-label">{t("tableOp.summaryStats")}</label>
        <div className="sp-col-checklist">
          {allStats.map(s => (
            <label key={s.key} className="sp-col-check-item">
              <input type="checkbox" checked={stats.has(s.key)}
                onChange={e => {
                  const next = new Set(stats);
                  if (e.target.checked) next.add(s.key); else next.delete(s.key);
                  setStats(next);
                }} />
              <span>{s.label}</span>
            </label>
          ))}
        </div>
      </div>
    </>
  );
}

// ─── Transpose ───

function TransposeForm({ sourceId, sourceName, exec, setPrimary, t }: {
  sourceId: string; sourceName: string;
  exec: DraftExecutor; setPrimary: SetPrimary; t: TFunction;
}) {
  useLayoutEffect(() => {
    setPrimary({
      disabled: !sourceId,
      onClick: () => exec({ kind: "transpose" }, [sourceId], t("tableOp.resultSuffix.transpose", { name: sourceName })),
    });
  }, [setPrimary, sourceId, sourceName, exec, t]);
  return null;
}

// ─── Stack ───

function StackForm({ sourceId, cols, sourceName, exec, setPrimary, t }: {
  sourceId: string; cols: [string, string][]; sourceName: string;
  exec: DraftExecutor; setPrimary: SetPrimary; t: TFunction;
}) {
  const [stackOrder, setStackOrder] = useState<string[]>([]);

  // Reset whenever the source table changes.
  useEffect(() => { setStackOrder([]); }, [sourceId]);

  // Drop any stack entries that no longer exist in the current column list.
  useEffect(() => {
    const valid = new Set(cols.map(c => c[0]));
    setStackOrder(prev => prev.filter(n => valid.has(n)));
  }, [cols]);

  const items = useMemo(
    () => cols.map(([name, type_]) => ({ key: name, label: name, hint: type_ })),
    [cols],
  );
  const idCount = items.length - stackOrder.length;
  const idCols = useMemo(() => {
    const stacked = new Set(stackOrder);
    return cols.map(([n]) => n).filter(n => !stacked.has(n));
  }, [cols, stackOrder]);

  useLayoutEffect(() => {
    setPrimary({
      disabled: !sourceId || stackOrder.length === 0,
      onClick: () => exec({ kind: "stack", stackColumns: stackOrder, idColumns: idCols }, [sourceId], t("tableOp.resultSuffix.stack", { name: sourceName })),
    });
  }, [setPrimary, sourceId, stackOrder, idCols, sourceName, exec, t]);

  return (
    <>
      <DualListPicker
        items={items}
        selected={stackOrder}
        onChange={setStackOrder}
        availableLabel={t("tableOp.stackAvailable", { defaultValue: "Available columns" })}
        selectedLabel={t("tableOp.stackSelected", { defaultValue: "Stack columns" })}
        emptyHint={t("tableOp.stackEmptyHint", { defaultValue: "Select columns on the left, then click ‘Add’." })}
      />

      <div className="sp-dlp-info-note">
        {t("tableOp.stackInfoNote", {
          defaultValue: "Other {{count}} column(s) will be kept as identifier columns.",
          count: idCount,
        })}
      </div>
    </>
  );
}

// ─── Split ───

function SplitForm({ sourceId, cols, sourceName, exec, setPrimary, t }: {
  sourceId: string; cols: [string, string][]; sourceName: string;
  exec: DraftExecutor; setPrimary: SetPrimary; t: TFunction;
}) {
  const [splitCol, setSplitCol] = useState("");
  const [valueCol, setValueCol] = useState("");
  const [idCols, setIdCols] = useState<string[]>([]);

  useEffect(() => {
    if (cols.length >= 2 && !splitCol) {
      setSplitCol(cols[0][0]);
      setValueCol(cols[1][0]);
    }
  }, [cols]);

  const items = useMemo(
    () => cols
      .filter(([n]) => n !== splitCol && n !== valueCol)
      .map(([name, type_]) => ({ key: name, label: name, hint: type_ })),
    [cols, splitCol, valueCol],
  );

  // Drop any id-col picks that are no longer eligible (became split/value col
  // or vanished from the source).
  useEffect(() => {
    const valid = new Set(items.map(i => i.key));
    setIdCols(prev => prev.filter(k => valid.has(k)));
  }, [items]);

  useLayoutEffect(() => {
    setPrimary({
      disabled: !sourceId || !splitCol || !valueCol || splitCol === valueCol,
      onClick: () => exec({ kind: "split", splitColumn: splitCol, valueColumn: valueCol, idColumns: sortByColOrder(idCols, cols) }, [sourceId], t("tableOp.resultSuffix.split", { name: sourceName })),
    });
  }, [setPrimary, sourceId, splitCol, valueCol, idCols, cols, sourceName, exec, t]);

  return (
    <>
      <div className="sp-dialog-field">
        <label className="sp-dialog-label">{t("tableOp.splitKeyCol")}</label>
        <select className="sp-dialog-select" value={splitCol} onChange={e => setSplitCol(e.target.value)}>
          {cols.map(([n]) => <option key={n} value={n}>{n}</option>)}
        </select>
      </div>
      <div className="sp-dialog-field">
        <label className="sp-dialog-label">{t("tableOp.splitValueCol")}</label>
        <select className="sp-dialog-select" value={valueCol} onChange={e => setValueCol(e.target.value)}>
          {cols.map(([n]) => <option key={n} value={n}>{n}</option>)}
        </select>
      </div>
      <DualListPicker
        items={items}
        selected={idCols}
        onChange={setIdCols}
        availableLabel={t("picker.available", { defaultValue: "Available columns" })}
        selectedLabel={t("tableOp.splitGroupCols")}
      />
    </>
  );
}

// ─── Join ───

function JoinForm({ datasets, activeId, exec, setPrimary, t }: {
  datasets: DatasetMeta[]; activeId: string | null;
  exec: DraftExecutor; setPrimary: SetPrimary; t: TFunction;
}) {
  const [leftId, setLeftId] = useState(activeId ?? "");
  const [rightId, setRightId] = useState("");
  const [joinType, setJoinType] = useState("inner");
  const [leftKey, setLeftKey] = useState("");
  const [rightKey, setRightKey] = useState("");
  const [leftCols, setLeftCols] = useState<[string, string][]>([]);
  const [rightCols, setRightCols] = useState<[string, string][]>([]);

  useEffect(() => {
    if (leftId) dataService.getColumns(leftId).then(setLeftCols).catch(() => setLeftCols([]));
    else setLeftCols([]);
  }, [leftId]);
  useEffect(() => {
    if (rightId) dataService.getColumns(rightId).then(setRightCols).catch(() => setRightCols([]));
    else setRightCols([]);
  }, [rightId]);
  useEffect(() => { if (leftCols.length > 0 && !leftKey) setLeftKey(leftCols[0][0]); }, [leftCols]);
  useEffect(() => { if (rightCols.length > 0 && !rightKey) setRightKey(rightCols[0][0]); }, [rightCols]);

  const leftName = datasets.find(d => d.id === leftId)?.name ?? "";
  const rightName = datasets.find(d => d.id === rightId)?.name ?? "";

  useLayoutEffect(() => {
    setPrimary({
      disabled: !leftId || !rightId || !leftKey || !rightKey,
      onClick: () => exec({ kind: "join", joinType: joinType as "inner" | "left" | "right" | "full", leftKey, rightKey }, [leftId, rightId], t("tableOp.resultSuffix.join", { left: leftName, right: rightName })),
    });
  }, [setPrimary, leftId, rightId, joinType, leftKey, rightKey, leftName, rightName, exec, t]);

  return (
    <>
      <DatasetSelect datasets={datasets} value={leftId} onChange={setLeftId} label={t("tableOp.joinLeftTable")} />
      <DatasetSelect datasets={datasets} value={rightId} onChange={setRightId} label={t("tableOp.joinRightTable")} exclude={leftId} />
      <div className="sp-dialog-field">
        <label className="sp-dialog-label">{t("tableOp.joinType")}</label>
        <select className="sp-dialog-select" value={joinType} onChange={e => setJoinType(e.target.value)}>
          <option value="inner">{t("tableOp.joinInner")}</option>
          <option value="left">{t("tableOp.joinLeft")}</option>
          <option value="right">{t("tableOp.joinRight")}</option>
          <option value="full">{t("tableOp.joinFull")}</option>
        </select>
      </div>
      <div className="sp-dialog-field">
        <label className="sp-dialog-label">{t("tableOp.joinLeftCol")}</label>
        <select className="sp-dialog-select" value={leftKey} onChange={e => setLeftKey(e.target.value)}>
          {leftCols.map(([n]) => <option key={n} value={n}>{n}</option>)}
        </select>
      </div>
      <div className="sp-dialog-field">
        <label className="sp-dialog-label">{t("tableOp.joinRightCol")}</label>
        <select className="sp-dialog-select" value={rightKey} onChange={e => setRightKey(e.target.value)}>
          {rightCols.map(([n]) => <option key={n} value={n}>{n}</option>)}
        </select>
      </div>
    </>
  );
}

// ─── Update ───

function UpdateForm({ datasets, activeId, exec, setPrimary, t }: {
  datasets: DatasetMeta[]; activeId: string | null;
  exec: DraftExecutor; setPrimary: SetPrimary; t: TFunction;
}) {
  const [leftId, setLeftId] = useState(activeId ?? "");
  const [rightId, setRightId] = useState("");
  const [matchCol, setMatchCol] = useState("");
  const [updateCols, setUpdateCols] = useState<string[]>([]);
  const [leftCols, setLeftCols] = useState<[string, string][]>([]);
  const [rightCols, setRightCols] = useState<[string, string][]>([]);

  useEffect(() => {
    if (leftId) dataService.getColumns(leftId).then(setLeftCols).catch(() => setLeftCols([]));
    else setLeftCols([]);
  }, [leftId]);
  useEffect(() => {
    if (rightId) dataService.getColumns(rightId).then(setRightCols).catch(() => setRightCols([]));
    else setRightCols([]);
  }, [rightId]);
  useEffect(() => { if (leftCols.length > 0 && !matchCol) setMatchCol(leftCols[0][0]); }, [leftCols]);

  // Update cols = intersection of left and right cols (excluding matchCol).
  // Source order is the left table so the picker shows columns in target order.
  const commonCols: [string, string][] = useMemo(
    () => leftCols.filter(([n]) => n !== matchCol && rightCols.some(([rn]) => rn === n)),
    [leftCols, rightCols, matchCol],
  );
  const items = useMemo(
    () => commonCols.map(([name, type_]) => ({ key: name, label: name, hint: type_ })),
    [commonCols],
  );

  // Drop stale picks when the eligible set changes.
  useEffect(() => {
    const valid = new Set(items.map(i => i.key));
    setUpdateCols(prev => prev.filter(k => valid.has(k)));
  }, [items]);

  useLayoutEffect(() => {
    setPrimary({
      disabled: !leftId || !rightId || !matchCol || updateCols.length === 0,
      onClick: () => exec({ kind: "update", matchColumn: matchCol, updateColumns: sortByColOrder(updateCols, leftCols) }, [leftId, rightId], t("tableOp.resultSuffix.update", { name: datasets.find(d => d.id === leftId)?.name ?? "" })),
    });
  }, [setPrimary, leftId, rightId, matchCol, updateCols, leftCols, datasets, exec, t]);

  return (
    <>
      <DatasetSelect datasets={datasets} value={leftId} onChange={setLeftId} label={t("tableOp.updateTarget")} />
      <DatasetSelect datasets={datasets} value={rightId} onChange={setRightId} label={t("tableOp.updateSource")} exclude={leftId} />
      <div className="sp-dialog-field">
        <label className="sp-dialog-label">{t("tableOp.updateMatchCol")}</label>
        <select className="sp-dialog-select" value={matchCol} onChange={e => setMatchCol(e.target.value)}>
          {leftCols.map(([n]) => <option key={n} value={n}>{n}</option>)}
        </select>
      </div>
      {commonCols.length > 0 && (
        <DualListPicker
          items={items}
          selected={updateCols}
          onChange={setUpdateCols}
          availableLabel={t("picker.available", { defaultValue: "Available columns" })}
          selectedLabel={t("tableOp.updateCols")}
        />
      )}
    </>
  );
}

// ─── Concatenate ───

function ConcatenateForm({ datasets, activeId, exec, setPrimary, t }: {
  datasets: DatasetMeta[]; activeId: string | null;
  exec: DraftExecutor; setPrimary: SetPrimary; t: TFunction;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set(activeId ? [activeId] : []));

  const dsItems: [string, string][] = datasets.map(d => [d.id, `${d.name} (${d.rowCount}×${d.colCount})`]);

  useLayoutEffect(() => {
    setPrimary({
      disabled: selected.size < 2,
      onClick: () => exec({ kind: "concatenate", sourceCount: selected.size }, [...selected], t("tableOp.concatResult")),
    });
  }, [setPrimary, selected, exec, t]);

  return (
    <div className="sp-dialog-field">
      <label className="sp-dialog-label">{t("tableOp.concatPickTables")}</label>
      <div className="sp-col-checklist">
        {dsItems.map(([id, label]) => (
          <label key={id} className="sp-col-check-item">
            <input
              type="checkbox"
              checked={selected.has(id)}
              onChange={e => {
                const next = new Set(selected);
                if (e.target.checked) next.add(id); else next.delete(id);
                setSelected(next);
              }}
            />
            <span>{label}</span>
          </label>
        ))}
      </div>
    </div>
  );
}
