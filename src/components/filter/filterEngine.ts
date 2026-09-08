/**
 * Apply a list of `FilterRuleItem`s to a GraphData column-wise table.
 *
 * Combination semantics: strict left-to-right with no precedence. The
 * first rule's `op` is ignored; subsequent rules combine via their own
 * `op` into a running boolean. This matches the way the UI exposes "add
 * another column with AND or OR" one at a time.
 *
 * Rules that reference a column missing from the dataset (e.g. the user
 * deleted the column) are skipped — treated as if they always pass — so
 * a stale filter doesn't silently delete every row.
 */

import type { FieldRef, GraphData } from "@/graphCore";
import type {
  FilterCategoricalRule,
  FilterContinuousRule,
  FilterDateRule,
  FilterRule,
  FilterRuleItem,
} from "@/types/filter";

export function createInitialCategoricalRule(
  field: FieldRef,
  data: GraphData | null,
  mode: "include" | "exclude",
): FilterCategoricalRule {
  if (mode === "exclude") {
    return { kind: "categorical", field, selected: [], exclude: true };
  }
  const values = distinctColumnValues(data, field.name);
  if (values.length === 0 && (data?.rows.length ?? 0) === 0) {
    return { kind: "categorical", field, selected: [], exclude: true };
  }
  return { kind: "categorical", field, selected: values, exclude: false };
}

export function applyFilters(
  data: GraphData | null,
  filters: FilterRuleItem[] | undefined,
): GraphData | null {
  if (!data) return null;
  if (!filters || filters.length === 0) return data;
  const { rows } = runFilters(data, filters);
  return { columns: data.columns, rows };
}

/**
 * Same predicates as `applyFilters`, but also returns the kept-row indices
 * (positions in the ORIGINAL `data.rows`). Callers that need to map a
 * visible-row position back to the source row (e.g. the Data Table needs
 * the underlying `_row_id` for in-place edits) use this variant. Returns
 * `null` for null `data` and a pass-through (full indices) for empty
 * filters so the caller doesn't need to special-case.
 */
export function applyFiltersWithIndex(
  data: GraphData | null,
  filters: FilterRuleItem[] | undefined,
): { data: GraphData; indices: number[] } | null {
  if (!data) return null;
  if (!filters || filters.length === 0) {
    const indices = new Array<number>(data.rows.length);
    for (let i = 0; i < indices.length; i++) indices[i] = i;
    return { data, indices };
  }
  const { rows, indices } = runFilters(data, filters);
  return { data: { columns: data.columns, rows }, indices };
}

/** Shared core: returns kept rows AND their original indices. */
function runFilters(
  data: GraphData,
  filters: FilterRuleItem[],
): { rows: unknown[][]; indices: number[] } {
  // Pre-resolve each rule's column index and build a per-rule predicate.
  // Rules referencing a missing column become a constant-true predicate.
  const colIndex = new Map<string, number>();
  data.columns.forEach((c, i) => colIndex.set(c, i));
  const evaluators: Array<{ op: "AND" | "OR"; pred: (row: unknown[]) => boolean }> = filters.map(
    (item) => {
      const idx = colIndex.get(item.rule.field.name);
      if (idx == null) {
        return { op: item.op, pred: () => true };
      }
      return { op: item.op, pred: buildPredicate(item.rule, idx) };
    },
  );

  // Iterate rows once; combine predicates strictly left-to-right.
  const outRows: unknown[][] = [];
  const outIdx: number[] = [];
  for (let r = 0; r < data.rows.length; r++) {
    const row = data.rows[r];
    let pass = evaluators[0].pred(row);
    for (let i = 1; i < evaluators.length; i++) {
      const v = evaluators[i].pred(row);
      pass = evaluators[i].op === "AND" ? pass && v : pass || v;
    }
    if (pass) {
      outRows.push(row);
      outIdx.push(r);
    }
  }
  return { rows: outRows, indices: outIdx };
}

function buildPredicate(rule: FilterRule, idx: number): (row: unknown[]) => boolean {
  switch (rule.kind) {
    case "continuous":
      return continuousPred(rule, idx);
    case "categorical":
      return categoricalPred(rule, idx);
    case "date":
      return datePred(rule, idx);
  }
}

function continuousPred(rule: FilterContinuousRule, idx: number) {
  const lo = rule.min;
  const hi = rule.max;
  // Open on both ends — pass-through.
  if (lo == null && hi == null) return () => true;
  return (row: unknown[]) => {
    const v = row[idx];
    // Treat null / undefined / blank string as missing so a numeric
    // range filter doesn't silently keep rows whose cell is empty
    // (Number("") === 0 would otherwise let them slip past a 0-anchored
    // range like [-1, 1]).
    if (v == null) return false;
    if (typeof v === "string" && v.trim() === "") return false;
    const n = typeof v === "number" ? v : Number(v);
    if (!Number.isFinite(n)) return false;
    if (lo != null && n < lo) return false;
    if (hi != null && n > hi) return false;
    return true;
  };
}

function categoricalPred(rule: FilterCategoricalRule, idx: number) {
  const selected = new Set(rule.selected);
  return (row: unknown[]) => {
    const v = row[idx];
    const s = v == null ? "" : String(v);
    return rule.exclude ? !selected.has(s) : selected.has(s);
  };
}

function datePred(rule: FilterDateRule, idx: number) {
  const start = rule.start;
  const end = rule.end;
  if (!start && !end) return () => true;
  return (row: unknown[]) => {
    const v = row[idx];
    if (v == null) return false;
    // ISO-8601 strings (YYYY-MM-DD or full timestamps) compare correctly
    // by lexicographic order. Numbers (epoch) are coerced via Date.
    let iso: string;
    if (typeof v === "number") {
      const d = new Date(v);
      if (Number.isNaN(d.getTime())) return false;
      iso = d.toISOString().slice(0, 10);
    } else {
      iso = String(v).slice(0, 10);
    }
    if (start && iso < start) return false;
    if (end && iso > end) return false;
    return true;
  };
}

/**
 * Collect distinct string-formatted values from a column. Used by the
 * categorical filter card to populate its checkbox list. Computed from
 * the ORIGINAL (pre-filter) data so toggling one filter doesn't make
 * other filters' value lists shrink.
 *
 * Caps at `limit` distinct values to keep DOM size sane on huge tables.
 */
export function distinctColumnValues(
  data: GraphData | null,
  colName: string,
  limit = 2000,
): string[] {
  if (!data) return [];
  const idx = data.columns.indexOf(colName);
  if (idx < 0) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (let r = 0; r < data.rows.length && out.length < limit; r++) {
    const v = data.rows[r][idx];
    if (v == null) continue;
    const s = String(v);
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  // Best-effort natural sort: numeric strings ascending, others alpha.
  out.sort((a, b) => {
    const na = Number(a);
    const nb = Number(b);
    if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
    return a.localeCompare(b);
  });
  return out;
}

/**
 * Numeric extent of a column ([min, max]). Used by continuous filter cards
 * to show placeholder text in the min/max inputs. Returns null for empty
 * or non-numeric columns.
 */
export function numericColumnExtent(
  data: GraphData | null,
  colName: string,
): [number, number] | null {
  if (!data) return null;
  const idx = data.columns.indexOf(colName);
  if (idx < 0) return null;
  let min = Infinity;
  let max = -Infinity;
  let any = false;
  for (let r = 0; r < data.rows.length; r++) {
    const v = data.rows[r][idx];
    if (v == null) continue;
    if (typeof v === "string" && v.trim() === "") continue;
    const n = typeof v === "number" ? v : Number(v);
    if (!Number.isFinite(n)) continue;
    any = true;
    if (n < min) min = n;
    if (n > max) max = n;
  }
  return any ? [min, max] : null;
}
