/**
 * Local Data Filter panel (JMP-inspired).
 *
 * Renders the left-most vertical column when the host view's Filter
 * button is toggled on. Each rule maps one source column to a
 * type-appropriate selector:
 *
 *   - continuous (numeric)             → min / max number inputs
 *   - categorical (ordinal/nominal/id) → search + scrollable checkbox list
 *   - datetime                         → start / end <input type="date">
 *
 * Rules are joined with explicit AND/OR; the first rule's connector is
 * hidden. Combination is strict left-to-right (no precedence) — see
 * filterEngine.ts.
 *
 * Originally lived under graphBuilder/; now shared by GraphBuilderView
 * and DataTableView via this module. The legacy `gb-filter-*` class
 * names are preserved (see filter.css) to keep the diff bounded.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { FieldRef, GraphData, FieldType } from "@/graphCore";
import type {
  FilterCategoricalRule,
  FilterContinuousRule,
  FilterDateRule,
  FilterRuleItem,
  FilterOp,
  FilterRule,
} from "@/types/filter";
import {
  createInitialCategoricalRule,
  distinctColumnValues,
  numericColumnExtent,
} from "./filterEngine";
import "./filter.css";

interface FilterPanelProps {
  data: GraphData | null;
  columns: FieldRef[];
  filters: FilterRuleItem[];
  onChange: (next: FilterRuleItem[]) => void;
  onClose: () => void;
  width: number;
  categoricalMode?: "include" | "exclude";
  getCategoricalValues?: (field: string, search: string) => Promise<string[]>;
}

/** Map a column FieldType to the filter rule kind we render for it. */
function ruleKindFor(t: FieldType): FilterRule["kind"] {
  if (t === "continuous") return "continuous";
  if (t === "datetime") return "date";
  return "categorical";
}

/** Seed a rule with sensible defaults for the column's data. */
function makeRule(
  field: FieldRef,
  data: GraphData | null,
  categoricalMode: "include" | "exclude",
): FilterRule {
  const kind = ruleKindFor(field.type);
  if (kind === "continuous") {
    return { kind: "continuous", field, min: null, max: null };
  }
  if (kind === "date") {
    return { kind: "date", field, start: null, end: null };
  }
  return createInitialCategoricalRule(field, data, categoricalMode);
}

let _ruleIdSeq = 0;
function nextRuleId(): string {
  _ruleIdSeq++;
  return `flt-${Date.now().toString(36)}-${_ruleIdSeq}`;
}

export function FilterPanel({
  data,
  columns,
  filters,
  onChange,
  onClose,
  width,
  categoricalMode = "include",
  getCategoricalValues,
}: FilterPanelProps) {
  const { t } = useTranslation();

  // Columns not yet used as a filter — keeps the "Add filter" dropdown
  // free of duplicates. Multiple rules per column could be useful but
  // adds UX cost; collapse to one per column for v1.
  const usedNames = useMemo(
    () => new Set(filters.map((f) => f.rule.field.name)),
    [filters],
  );
  const available = useMemo(
    () => columns.filter((c) => !usedNames.has(c.name)),
    [columns, usedNames],
  );

  // Local "Add filter" picker state — a controlled <select> reset to ""
  // after each add so the next add starts fresh.
  const [picked, setPicked] = useState("");

  const addRule = (name: string) => {
    const field = columns.find((c) => c.name === name);
    if (!field) return;
    const item: FilterRuleItem = {
      id: nextRuleId(),
      op: filters.length === 0 ? "AND" : "AND",
      rule: makeRule(field, data, categoricalMode),
    };
    onChange([...filters, item]);
    setPicked("");
  };

  const updateRule = (id: string, patch: Partial<FilterRuleItem>) => {
    onChange(filters.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  };

  const removeRule = (id: string) => {
    onChange(filters.filter((f) => f.id !== id));
  };

  return (
    <div className="gb-filter-panel" style={{ width }}>
      <div className="sp-panel-header gb-filter-header">
        <span className="sp-panel-header-title">
          {t("graph.filter.title", { defaultValue: "Filters" })}
        </span>
        <div className="gb-filter-header-actions">
          {filters.length > 0 && (
            <button
              className="gb-filter-clear-all"
              onClick={() => onChange([])}
              title={t("graph.filter.clearAllTitle", {
                defaultValue: "Remove every filter rule",
              })}
            >
              {t("graph.filter.clearAllRules", { defaultValue: "Clear all" })}
            </button>
          )}
          <button
            className="gb-filter-close"
            onClick={onClose}
            title={t("graph.filter.close", { defaultValue: "Hide filters" })}
          >
            ×
          </button>
        </div>
      </div>

      <div className="gb-filter-body">
        <div className="gb-filter-add">
          <select
            className="gb-filter-add-select"
            value={picked}
            onChange={(e) => {
              const v = e.target.value;
              if (v) addRule(v);
            }}
          >
            <option value="">
              {available.length === 0
                ? t("graph.filter.allUsed", {
                    defaultValue: "All columns already filtered",
                  })
                : t("graph.filter.addPlaceholder", {
                    defaultValue: "Add filter column…",
                  })}
            </option>
            {available.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name}
              </option>
            ))}
          </select>
        </div>

        {filters.length === 0 ? (
          <div className="gb-filter-empty">
            {t("graph.filter.empty", {
              defaultValue: "Pick a column above to add a filter rule.",
            })}
          </div>
        ) : (
          <div className="gb-filter-list">
            {filters.map((item, i) => (
              <FilterCard
                key={item.id}
                index={i}
                item={item}
                data={data}
                getCategoricalValues={getCategoricalValues}
                onChange={(patch) => updateRule(item.id, patch)}
                onRemove={() => removeRule(item.id)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ---- One rule card -------------------------------------------------------

interface FilterCardProps {
  index: number;
  item: FilterRuleItem;
  data: GraphData | null;
  getCategoricalValues?: (field: string, search: string) => Promise<string[]>;
  onChange: (patch: Partial<FilterRuleItem>) => void;
  onRemove: () => void;
}

function FilterCard({
  index,
  item,
  data,
  getCategoricalValues,
  onChange,
  onRemove,
}: FilterCardProps) {
  const { t } = useTranslation();
  const { rule } = item;

  // Card height drag state. We track the in-progress pixel height in a
  // ref so pointer-move can read/write without spamming React re-renders;
  // a separate `liveHeight` state mirrors it so the DOM updates. On
  // pointer-up we commit the final value back to `item.height` via
  // `onChange`, so it persists in the project JSON.
  const cardRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);
  const [liveHeight, setLiveHeight] = useState<number | undefined>(item.height);

  // Keep liveHeight in sync if the item's persisted height changes from
  // the outside (e.g. project reload). Skipped while a drag is active.
  if (!dragRef.current && liveHeight !== item.height) {
    // Setting state during render is fine here because the comparison
    // guarantees we only do it on an actual external change.
    setLiveHeight(item.height);
  }

  const MIN_H = 80;
  const MAX_H = 800;

  const onResizeDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const cur = cardRef.current?.getBoundingClientRect().height ?? liveHeight ?? 220;
    dragRef.current = { startY: e.clientY, startH: cur };
    (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
  };

  const onResizeMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const raw = drag.startH + (e.clientY - drag.startY);
    const next = Math.round(Math.max(MIN_H, Math.min(MAX_H, raw)));
    setLiveHeight(next);
  };

  const onResizeUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    dragRef.current = null;
    (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId);
    if (!drag) return;
    const finalH = cardRef.current?.getBoundingClientRect().height ?? liveHeight;
    if (finalH != null) onChange({ height: Math.round(finalH) });
  };

  // Double-click resets to intrinsic height (clears persisted override).
  const onResizeDblClick = () => {
    setLiveHeight(undefined);
    onChange({ height: undefined });
  };

  // Inline op toggle: first rule has no preceding rule to join with.
  const opBar =
    index === 0 ? null : (
      <div className="gb-filter-op-bar">
        <button
          className={`gb-filter-op-btn${item.op === "AND" ? " active" : ""}`}
          onClick={() => onChange({ op: "AND" })}
          title={t("graph.filter.andTitle", { defaultValue: "AND with previous" })}
        >
          AND
        </button>
        <button
          className={`gb-filter-op-btn${item.op === "OR" ? " active" : ""}`}
          onClick={() => onChange({ op: "OR" as FilterOp })}
          title={t("graph.filter.orTitle", { defaultValue: "OR with previous" })}
        >
          OR
        </button>
      </div>
    );

  return (
    <>
      {opBar}
      <div
        className={`gb-filter-card${liveHeight != null ? " gb-filter-card-sized" : ""}`}
        ref={cardRef}
        style={liveHeight != null ? { height: liveHeight } : undefined}
      >
        <div className="gb-filter-card-head">
          <span className="gb-filter-card-name" title={rule.field.name}>
            {rule.field.name}
          </span>
          <button
            className="gb-filter-card-x"
            onClick={onRemove}
            title={t("graph.filter.removeRule", { defaultValue: "Remove rule" })}
          >
            ×
          </button>
        </div>
        <div className="gb-filter-card-body">
          {rule.kind === "continuous" && (
            <ContinuousEditor
              rule={rule}
              data={data}
              onChange={(next) => onChange({ rule: next })}
            />
          )}
          {rule.kind === "date" && (
            <DateEditor rule={rule} onChange={(next) => onChange({ rule: next })} />
          )}
          {rule.kind === "categorical" && (
            <CategoricalEditor
              rule={rule}
              data={data}
              getCategoricalValues={getCategoricalValues}
              onChange={(next) => onChange({ rule: next })}
            />
          )}
        </div>
        {/* Drag-to-resize handle. Pointer events are captured on the
            handle itself so the drag survives pointer leaving the bar.
            Double-click clears the persisted height so the card returns
            to its intrinsic content-driven size. */}
        <div
          className="gb-filter-card-resize"
          onPointerDown={onResizeDown}
          onPointerMove={onResizeMove}
          onPointerUp={onResizeUp}
          onPointerCancel={onResizeUp}
          onDoubleClick={onResizeDblClick}
          title={t("graph.filter.resizeCardTitle", {
            defaultValue: "Drag to resize · double-click to reset",
          })}
        />
      </div>
    </>
  );
}

// ---- Type-specific editors ----------------------------------------------

function ContinuousEditor({
  rule,
  data,
  onChange,
}: {
  rule: FilterContinuousRule;
  data: GraphData | null;
  onChange: (next: FilterContinuousRule) => void;
}) {
  const { t } = useTranslation();
  // Extent recomputed only when the data/column identity changes — the
  // extent is over the UN-filtered data so it's stable across rule edits.
  const extent = useMemo(
    () => numericColumnExtent(data, rule.field.name),
    [data, rule.field.name],
  );
  const minPh = extent ? String(extent[0]) : "min";
  const maxPh = extent ? String(extent[1]) : "max";

  const parse = (s: string): number | null => {
    if (s.trim() === "") return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  };

  return (
    <div className="gb-filter-range">
      <label className="gb-filter-range-row">
        <span className="gb-filter-range-label">
          {t("graph.filter.min", { defaultValue: "Min" })}
        </span>
        <input
          type="number"
          className="gb-filter-num"
          value={rule.min ?? ""}
          placeholder={minPh}
          onChange={(e) => onChange({ ...rule, min: parse(e.target.value) })}
        />
      </label>
      <label className="gb-filter-range-row">
        <span className="gb-filter-range-label">
          {t("graph.filter.max", { defaultValue: "Max" })}
        </span>
        <input
          type="number"
          className="gb-filter-num"
          value={rule.max ?? ""}
          placeholder={maxPh}
          onChange={(e) => onChange({ ...rule, max: parse(e.target.value) })}
        />
      </label>
    </div>
  );
}

function DateEditor({
  rule,
  onChange,
}: {
  rule: FilterDateRule;
  onChange: (next: FilterDateRule) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="gb-filter-range">
      <label className="gb-filter-range-row">
        <span className="gb-filter-range-label">
          {t("graph.filter.start", { defaultValue: "Start" })}
        </span>
        <input
          type="date"
          className="gb-filter-date"
          value={rule.start ?? ""}
          onChange={(e) => onChange({ ...rule, start: e.target.value || null })}
        />
      </label>
      <label className="gb-filter-range-row">
        <span className="gb-filter-range-label">
          {t("graph.filter.end", { defaultValue: "End" })}
        </span>
        <input
          type="date"
          className="gb-filter-date"
          value={rule.end ?? ""}
          onChange={(e) => onChange({ ...rule, end: e.target.value || null })}
        />
      </label>
    </div>
  );
}

function CategoricalEditor({
  rule,
  data,
  getCategoricalValues,
  onChange,
}: {
  rule: FilterCategoricalRule;
  data: GraphData | null;
  getCategoricalValues?: (field: string, search: string) => Promise<string[]>;
  onChange: (next: FilterCategoricalRule) => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  // Anchor for shift-click range selection. Indexes into the currently
  // `visible` list. Reset to null whenever the visible list shifts (e.g.
  // user types into the search box) so a stale index can't pick a wrong
  // range.
  const [anchorIdx, setAnchorIdx] = useState<number | null>(null);

  // Distinct values from the UN-filtered data (filterEngine helper) —
  // this list stays stable while the user toggles boxes within the rule.
  const localValues = useMemo(
    () => distinctColumnValues(data, rule.field.name),
    [data, rule.field.name],
  );
  const [remoteValues, setRemoteValues] = useState<string[]>([]);
  useEffect(() => {
    if (!getCategoricalValues) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void getCategoricalValues(rule.field.name, query)
        .then((values) => {
          if (!cancelled) setRemoteValues(values);
        })
        .catch(() => {
          if (!cancelled) setRemoteValues([]);
        });
    }, 150);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [getCategoricalValues, query, rule.field.name]);
  const all = getCategoricalValues ? remoteValues : localValues;

  const storedSet = useMemo(() => new Set(rule.selected), [rule.selected]);
  const selectedSet = useMemo(
    () => rule.exclude
      ? new Set(all.filter((value) => !storedSet.has(value)))
      : storedSet,
    [all, rule.exclude, storedSet],
  );

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return all;
    return all.filter((v) => v.toLowerCase().includes(q));
  }, [all, query]);

  // Commit a new Set as the rule's selection, preserving `all`'s order so
  // re-renders are deterministic.
  const commit = (next: Set<string>) => {
    if (rule.exclude) {
      const visibleValues = new Set(all);
      const excluded = rule.selected.filter((value) => !visibleValues.has(value));
      excluded.push(...all.filter((value) => !next.has(value)));
      onChange({ ...rule, selected: excluded });
    } else {
      onChange({ ...rule, selected: all.filter((x) => next.has(x)) });
    }
  };

  const toggle = (v: string) => {
    const next = new Set(selectedSet);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    commit(next);
  };

  /**
   * Click handler with modifier support:
   *   - plain click           → toggle this item, update anchor
   *   - Ctrl/Cmd click        → toggle this item, update anchor (non-contiguous "skip-select")
   *   - Shift click           → range select from anchor → current within
   *                             the *visible* list; range items all take
   *                             the *opposite* state of the clicked item
   *                             before the click (matches the just-flipped
   *                             state of the clicked item, so the whole
   *                             range ends up uniform). Anchor is NOT
   *                             advanced, so subsequent shift-clicks keep
   *                             extending from the same origin.
   *   - Ctrl+Shift click      → additive range select: range items set to
   *                             selected (added) without touching items
   *                             outside the range.
   */
  const handleRowClick = (
    e: React.MouseEvent<HTMLDivElement>,
    v: string,
    idx: number,
  ) => {
    // Suppress accidental text selection when shift-clicking.
    e.preventDefault();
    const shift = e.shiftKey;
    const ctrl = e.ctrlKey || e.metaKey;

    if (shift && anchorIdx !== null && anchorIdx < visible.length) {
      const [a, b] = anchorIdx <= idx ? [anchorIdx, idx] : [idx, anchorIdx];
      const range = visible.slice(a, b + 1);
      const next = new Set(selectedSet);
      if (ctrl) {
        // Ctrl+Shift: additive — always select the range.
        for (const item of range) next.add(item);
      } else {
        // Plain shift: fill range to match the *flipped* state of the
        // clicked anchor end (so a uniform block results).
        const target = !selectedSet.has(v);
        for (const item of range) {
          if (target) next.add(item);
          else next.delete(item);
        }
      }
      commit(next);
      // Keep anchor so further shift-clicks can extend/shrink the range.
      return;
    }

    // Plain or Ctrl/Cmd click: toggle and (re)set anchor.
    toggle(v);
    setAnchorIdx(idx);
  };

  const selectAll = () => {
    onChange({ ...rule, selected: rule.exclude ? [] : all.slice() });
    setAnchorIdx(null);
  };
  const clearAll = () => {
    onChange({ ...rule, selected: [], exclude: false });
    setAnchorIdx(null);
  };

  return (
    <div className="gb-filter-cats">
      <input
        type="text"
        className="gb-filter-search"
        value={query}
        placeholder={t("graph.filter.searchValues", { defaultValue: "Search…" })}
        onChange={(e) => {
          setQuery(e.target.value);
          // Visible list is about to change — drop the anchor so a stale
          // index can't pick a wrong range on the next shift-click.
          setAnchorIdx(null);
        }}
      />
      <div className="gb-filter-cats-actions">
        <button className="gb-filter-mini-btn" onClick={selectAll}>
          {t("graph.filter.selectAll", { defaultValue: "All" })}
        </button>
        <button className="gb-filter-mini-btn" onClick={clearAll}>
          {t("graph.filter.clearAll", { defaultValue: "None" })}
        </button>
        <span className="gb-filter-cats-count">
          {selectedSet.size}/{all.length}
        </span>
      </div>
      <div className="gb-filter-cats-list">
        {visible.length === 0 ? (
          <div className="gb-filter-cats-empty">
            {t("graph.filter.noMatches", { defaultValue: "No matches" })}
          </div>
        ) : (
          visible.map((v, i) => (
            <div
              key={v}
              className={`gb-filter-cat-item${anchorIdx === i ? " gb-filter-cat-item-anchor" : ""}`}
              onClick={(e) => handleRowClick(e, v, i)}
              onMouseDown={(e) => {
                // Block the browser's native shift-click text-range
                // selection before it starts.
                if (e.shiftKey) e.preventDefault();
              }}
            >
              <input
                type="checkbox"
                checked={selectedSet.has(v)}
                readOnly
                tabIndex={-1}
                // Stop propagation isn't needed — the row's onClick is the
                // single source of truth — but readOnly + tabIndex=-1 keep
                // the checkbox purely visual so we can't double-toggle.
              />
              <span className="gb-filter-cat-label" title={v}>
                {v === "" ? <em>(blank)</em> : v}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
