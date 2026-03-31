import { useState, useEffect, useRef, useCallback } from "react";
import { dataService } from "@/services/dataService";
import type { DatasetMeta } from "@/types/data";

// ─── Types ───

export type TableOpType =
  | "summary" | "subset" | "sort" | "stack"
  | "split" | "transpose" | "join" | "update" | "concatenate";

interface Props {
  op: TableOpType;
  datasets: DatasetMeta[];
  activeDatasetId: string | null;
  onClose: () => void;
  onCreated: (ds: DatasetMeta) => void;     // new table created
  onUpdated: () => void;                     // existing table modified (update)
}

// ─── Shared helpers ───

function ColCheckList({
  cols, selected, onChange, label,
}: {
  cols: [string, string][];
  selected: Set<string>;
  onChange: (s: Set<string>) => void;
  label: string;
}) {
  const lastClickedRef = useRef<number | null>(null);

  const handleItemClick = useCallback((e: React.MouseEvent, index: number) => {
    // Prevent default label→checkbox toggle; we handle it ourselves
    e.preventDefault();
    const name = cols[index][0];
    const next = new Set(selected);

    if (e.shiftKey && lastClickedRef.current !== null) {
      // Shift+click: range select/deselect from last clicked to current
      const from = Math.min(lastClickedRef.current, index);
      const to = Math.max(lastClickedRef.current, index);
      const adding = !selected.has(name);
      for (let i = from; i <= to; i++) {
        if (adding) next.add(cols[i][0]); else next.delete(cols[i][0]);
      }
    } else if (e.ctrlKey || e.metaKey) {
      // Ctrl/Cmd+click: toggle single item without affecting others
      if (next.has(name)) next.delete(name); else next.add(name);
    } else {
      // Plain click: toggle single item
      if (next.has(name)) next.delete(name); else next.add(name);
    }

    lastClickedRef.current = index;
    onChange(next);
  }, [cols, selected, onChange]);

  return (
    <div className="sp-dialog-field">
      <label className="sp-dialog-label">{label}</label>
      <div className="sp-col-checklist">
        {cols.map(([name, type_], i) => (
          <label
            key={name}
            className="sp-col-check-item"
            title={type_}
            onMouseDown={(e) => handleItemClick(e, i)}
          >
            <input
              type="checkbox"
              checked={selected.has(name)}
              readOnly
              tabIndex={-1}
            />
            <span>{name}</span>
            <span className="sp-col-type-hint">{type_}</span>
          </label>
        ))}
      </div>
    </div>
  );
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
  const filtered = exclude ? datasets.filter(d => d.id !== exclude) : datasets;
  return (
    <div className="sp-dialog-field">
      <label className="sp-dialog-label">{label}</label>
      <select className="sp-dialog-select" value={value} onChange={e => onChange(e.target.value)}>
        <option value="">— 选择数据表 —</option>
        {filtered.map(d => (
          <option key={d.id} value={d.id}>{d.name} ({d.rowCount}×{d.colCount})</option>
        ))}
      </select>
    </div>
  );
}

// ─── Main Component ───

export function TableOpsDialog({ op, datasets, activeDatasetId, onClose, onCreated, onUpdated }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Source dataset (most ops work on the active dataset)
  const [sourceId, setSourceId] = useState(activeDatasetId ?? "");
  const [cols, setCols] = useState<[string, string][]>([]);

  // Load columns when source changes
  useEffect(() => {
    if (!sourceId) { setCols([]); return; }
    dataService.getColumns(sourceId).then(setCols).catch(() => setCols([]));
  }, [sourceId]);

  const sourceName = datasets.find(d => d.id === sourceId)?.name ?? "";

  const exec = async (fn: () => Promise<DatasetMeta | void>) => {
    setError(null);
    setBusy(true);
    try {
      const result = await fn();
      if (result && typeof result === "object" && "id" in result) {
        onCreated(result as DatasetMeta);
      } else {
        onUpdated();
      }
      onClose();
    } catch (e: unknown) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const title: Record<TableOpType, string> = {
    summary: "汇总", subset: "子集", sort: "排序", stack: "堆叠",
    split: "拆分", transpose: "转置", join: "连接", update: "更新", concatenate: "合并",
  };

  return (
    <div className="sp-dialog-overlay" onMouseDown={onClose}>
      <div className="sp-dialog sp-dialog-wide" onMouseDown={e => e.stopPropagation()}>
        <div className="sp-dialog-title">{title[op]}</div>
        <div className="sp-dialog-body">
          {/* Source dataset selector (for most ops) */}
          {op !== "join" && op !== "update" && op !== "concatenate" && (
            <DatasetSelect datasets={datasets} value={sourceId} onChange={setSourceId} label="源数据表" />
          )}

          {/* Per-op UI */}
          {op === "sort" && <SortForm sourceId={sourceId} cols={cols} sourceName={sourceName} exec={exec} busy={busy} />}
          {op === "subset" && <SubsetForm sourceId={sourceId} cols={cols} sourceName={sourceName} exec={exec} busy={busy} />}
          {op === "summary" && <SummaryForm sourceId={sourceId} cols={cols} sourceName={sourceName} exec={exec} busy={busy} />}
          {op === "transpose" && <TransposeForm sourceId={sourceId} sourceName={sourceName} exec={exec} busy={busy} />}
          {op === "stack" && <StackForm sourceId={sourceId} cols={cols} sourceName={sourceName} exec={exec} busy={busy} />}
          {op === "split" && <SplitForm sourceId={sourceId} cols={cols} sourceName={sourceName} exec={exec} busy={busy} />}
          {op === "join" && <JoinForm datasets={datasets} activeId={activeDatasetId} exec={exec} busy={busy} />}
          {op === "update" && <UpdateForm datasets={datasets} activeId={activeDatasetId} exec={exec} busy={busy} />}
          {op === "concatenate" && <ConcatenateForm datasets={datasets} activeId={activeDatasetId} exec={exec} busy={busy} />}

          {error && <div className="sp-dialog-error">{error}</div>}
        </div>
        <div className="sp-dialog-actions">
          <button className="sp-dialog-btn" onClick={onClose} disabled={busy}>取消</button>
        </div>
      </div>
    </div>
  );
}

// ─── Sort ───

function SortForm({ sourceId, cols, sourceName, exec, busy }: {
  sourceId: string; cols: [string, string][]; sourceName: string;
  exec: (fn: () => Promise<DatasetMeta | void>) => void; busy: boolean;
}) {
  const [sortCol, setSortCol] = useState("");
  const [sortOrder, setSortOrder] = useState("asc");

  useEffect(() => { if (cols.length > 0 && !sortCol) setSortCol(cols[0][0]); }, [cols]);

  return (
    <>
      <div className="sp-dialog-field">
        <label className="sp-dialog-label">排序列</label>
        <select className="sp-dialog-select" value={sortCol} onChange={e => setSortCol(e.target.value)}>
          {cols.map(([n]) => <option key={n} value={n}>{n}</option>)}
        </select>
      </div>
      <div className="sp-dialog-field">
        <label className="sp-dialog-label">排序方式</label>
        <select className="sp-dialog-select" value={sortOrder} onChange={e => setSortOrder(e.target.value)}>
          <option value="asc">升序</option>
          <option value="desc">降序</option>
        </select>
      </div>
      <div className="sp-dialog-actions">
        <button
          className="sp-dialog-btn sp-dialog-btn-primary"
          disabled={busy || !sourceId || !sortCol}
          onClick={() => exec(() => dataService.sortTable(sourceId, [sortCol], [sortOrder], `${sourceName} - 排序`))}
        >确定</button>
      </div>
    </>
  );
}

// ─── Subset ───

function SubsetForm({ sourceId, cols, sourceName, exec, busy }: {
  sourceId: string; cols: [string, string][]; sourceName: string;
  exec: (fn: () => Promise<DatasetMeta | void>) => void; busy: boolean;
}) {
  const [selectedCols, setSelectedCols] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");

  // Select all by default
  useEffect(() => { setSelectedCols(new Set(cols.map(([n]) => n))); }, [cols]);

  return (
    <>
      <ColCheckList cols={cols} selected={selectedCols} onChange={setSelectedCols} label="选择列" />
      <div className="sp-dialog-field">
        <label className="sp-dialog-label">行筛选 (SQL WHERE, 可选)</label>
        <input className="sp-dialog-input" value={filter} onChange={e => setFilter(e.target.value)}
          placeholder='例如: age > 18 AND name IS NOT NULL' />
      </div>
      <div className="sp-dialog-actions">
        <button
          className="sp-dialog-btn sp-dialog-btn-primary"
          disabled={busy || !sourceId || selectedCols.size === 0}
          onClick={() => exec(() => dataService.subsetTable(sourceId, [...selectedCols], filter || null, `${sourceName} - 子集`))}
        >确定</button>
      </div>
    </>
  );
}

// ─── Summary ───

function SummaryForm({ sourceId, cols, sourceName, exec, busy }: {
  sourceId: string; cols: [string, string][]; sourceName: string;
  exec: (fn: () => Promise<DatasetMeta | void>) => void; busy: boolean;
}) {
  const [statCols, setStatCols] = useState<Set<string>>(new Set());
  const [groupCols, setGroupCols] = useState<Set<string>>(new Set());
  const [stats, setStats] = useState<Set<string>>(new Set(["n", "mean", "std", "min", "max"]));

  const allStats = [
    { key: "n", label: "计数 (N)" },
    { key: "mean", label: "均值 (Mean)" },
    { key: "std", label: "标准差 (Std)" },
    { key: "min", label: "最小值 (Min)" },
    { key: "max", label: "最大值 (Max)" },
    { key: "sum", label: "求和 (Sum)" },
    { key: "median", label: "中位数 (Median)" },
  ];

  return (
    <>
      <ColCheckList cols={cols} selected={statCols} onChange={setStatCols} label="统计列" />
      <ColCheckList cols={cols} selected={groupCols} onChange={setGroupCols} label="分组列 (可选)" />
      <div className="sp-dialog-field">
        <label className="sp-dialog-label">统计量</label>
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
      <div className="sp-dialog-actions">
        <button
          className="sp-dialog-btn sp-dialog-btn-primary"
          disabled={busy || !sourceId || statCols.size === 0 || stats.size === 0}
          onClick={() => exec(() => dataService.summaryTable(sourceId, [...statCols], [...groupCols], [...stats], `${sourceName} - 汇总`))}
        >确定</button>
      </div>
    </>
  );
}

// ─── Transpose ───

function TransposeForm({ sourceId, sourceName, exec, busy }: {
  sourceId: string; sourceName: string;
  exec: (fn: () => Promise<DatasetMeta | void>) => void; busy: boolean;
}) {
  return (
    <div className="sp-dialog-actions">
      <button
        className="sp-dialog-btn sp-dialog-btn-primary"
        disabled={busy || !sourceId}
        onClick={() => exec(() => dataService.transposeTable(sourceId, `${sourceName} - 转置`))}
      >确定</button>
    </div>
  );
}

// ─── Stack ───

function StackForm({ sourceId, cols, sourceName, exec, busy }: {
  sourceId: string; cols: [string, string][]; sourceName: string;
  exec: (fn: () => Promise<DatasetMeta | void>) => void; busy: boolean;
}) {
  const [stackCols, setStackCols] = useState<Set<string>>(new Set());
  const [idCols, setIdCols] = useState<Set<string>>(new Set());

  return (
    <>
      <ColCheckList cols={cols} selected={stackCols} onChange={setStackCols} label="堆叠列 (值列)" />
      <ColCheckList cols={cols} selected={idCols} onChange={setIdCols} label="标识列 (保持不变)" />
      <div className="sp-dialog-actions">
        <button
          className="sp-dialog-btn sp-dialog-btn-primary"
          disabled={busy || !sourceId || stackCols.size === 0}
          onClick={() => exec(() => dataService.stackTable(sourceId, [...stackCols], [...idCols], `${sourceName} - 堆叠`))}
        >确定</button>
      </div>
    </>
  );
}

// ─── Split ───

function SplitForm({ sourceId, cols, sourceName, exec, busy }: {
  sourceId: string; cols: [string, string][]; sourceName: string;
  exec: (fn: () => Promise<DatasetMeta | void>) => void; busy: boolean;
}) {
  const [splitCol, setSplitCol] = useState("");
  const [valueCol, setValueCol] = useState("");
  const [idCols, setIdCols] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (cols.length >= 2 && !splitCol) {
      setSplitCol(cols[0][0]);
      setValueCol(cols[1][0]);
    }
  }, [cols]);

  return (
    <>
      <div className="sp-dialog-field">
        <label className="sp-dialog-label">拆分列 (值作为新列名)</label>
        <select className="sp-dialog-select" value={splitCol} onChange={e => setSplitCol(e.target.value)}>
          {cols.map(([n]) => <option key={n} value={n}>{n}</option>)}
        </select>
      </div>
      <div className="sp-dialog-field">
        <label className="sp-dialog-label">值列 (填充新列)</label>
        <select className="sp-dialog-select" value={valueCol} onChange={e => setValueCol(e.target.value)}>
          {cols.map(([n]) => <option key={n} value={n}>{n}</option>)}
        </select>
      </div>
      <ColCheckList cols={cols} selected={idCols} onChange={setIdCols} label="分组列 (可选)" />
      <div className="sp-dialog-actions">
        <button
          className="sp-dialog-btn sp-dialog-btn-primary"
          disabled={busy || !sourceId || !splitCol || !valueCol}
          onClick={() => exec(() => dataService.splitTable(sourceId, splitCol, valueCol, [...idCols], `${sourceName} - 拆分`))}
        >确定</button>
      </div>
    </>
  );
}

// ─── Join ───

function JoinForm({ datasets, activeId, exec, busy }: {
  datasets: DatasetMeta[]; activeId: string | null;
  exec: (fn: () => Promise<DatasetMeta | void>) => void; busy: boolean;
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

  return (
    <>
      <DatasetSelect datasets={datasets} value={leftId} onChange={setLeftId} label="左表" />
      <DatasetSelect datasets={datasets} value={rightId} onChange={setRightId} label="右表" exclude={leftId} />
      <div className="sp-dialog-field">
        <label className="sp-dialog-label">连接类型</label>
        <select className="sp-dialog-select" value={joinType} onChange={e => setJoinType(e.target.value)}>
          <option value="inner">内连接 (Inner)</option>
          <option value="left">左连接 (Left)</option>
          <option value="right">右连接 (Right)</option>
          <option value="full">全连接 (Full)</option>
        </select>
      </div>
      <div className="sp-dialog-field">
        <label className="sp-dialog-label">左表匹配列</label>
        <select className="sp-dialog-select" value={leftKey} onChange={e => setLeftKey(e.target.value)}>
          {leftCols.map(([n]) => <option key={n} value={n}>{n}</option>)}
        </select>
      </div>
      <div className="sp-dialog-field">
        <label className="sp-dialog-label">右表匹配列</label>
        <select className="sp-dialog-select" value={rightKey} onChange={e => setRightKey(e.target.value)}>
          {rightCols.map(([n]) => <option key={n} value={n}>{n}</option>)}
        </select>
      </div>
      <div className="sp-dialog-actions">
        <button
          className="sp-dialog-btn sp-dialog-btn-primary"
          disabled={busy || !leftId || !rightId || !leftKey || !rightKey}
          onClick={() => exec(() => dataService.joinTables(leftId, rightId, joinType, leftKey, rightKey, `${leftName} + ${rightName}`))}
        >确定</button>
      </div>
    </>
  );
}

// ─── Update ───

function UpdateForm({ datasets, activeId, exec, busy }: {
  datasets: DatasetMeta[]; activeId: string | null;
  exec: (fn: () => Promise<DatasetMeta | void>) => void; busy: boolean;
}) {
  const [leftId, setLeftId] = useState(activeId ?? "");
  const [rightId, setRightId] = useState("");
  const [matchCol, setMatchCol] = useState("");
  const [updateCols, setUpdateCols] = useState<Set<string>>(new Set());
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

  // Update cols = intersection of left and right cols (excluding matchCol)
  const commonCols: [string, string][] = rightCols.filter(
    ([n]) => n !== matchCol && leftCols.some(([ln]) => ln === n)
  );

  return (
    <>
      <DatasetSelect datasets={datasets} value={leftId} onChange={setLeftId} label="目标表 (被更新)" />
      <DatasetSelect datasets={datasets} value={rightId} onChange={setRightId} label="源表 (提供数据)" exclude={leftId} />
      <div className="sp-dialog-field">
        <label className="sp-dialog-label">匹配列</label>
        <select className="sp-dialog-select" value={matchCol} onChange={e => setMatchCol(e.target.value)}>
          {leftCols.map(([n]) => <option key={n} value={n}>{n}</option>)}
        </select>
      </div>
      {commonCols.length > 0 && (
        <ColCheckList cols={commonCols} selected={updateCols} onChange={setUpdateCols} label="更新列" />
      )}
      <div className="sp-dialog-actions">
        <button
          className="sp-dialog-btn sp-dialog-btn-primary"
          disabled={busy || !leftId || !rightId || !matchCol || updateCols.size === 0}
          onClick={() => exec(() => dataService.updateTable(leftId, rightId, matchCol, [...updateCols]))}
        >确定</button>
      </div>
    </>
  );
}

// ─── Concatenate ───

function ConcatenateForm({ datasets, activeId, exec, busy }: {
  datasets: DatasetMeta[]; activeId: string | null;
  exec: (fn: () => Promise<DatasetMeta | void>) => void; busy: boolean;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set(activeId ? [activeId] : []));

  const dsItems: [string, string][] = datasets.map(d => [d.id, `${d.name} (${d.rowCount}×${d.colCount})`]);

  return (
    <>
      <div className="sp-dialog-field">
        <label className="sp-dialog-label">选择要合并的数据表</label>
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
      <div className="sp-dialog-actions">
        <button
          className="sp-dialog-btn sp-dialog-btn-primary"
          disabled={busy || selected.size < 2}
          onClick={() => exec(() => dataService.concatenateTables([...selected], "合并结果"))}
        >确定</button>
      </div>
    </>
  );
}
