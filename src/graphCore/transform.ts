/**
 * GraphSpec + GraphData → ECharts option
 *
 * 这是 Graph Core 的核心：一个图形规范如何转译成具体的渲染配置。
 * 当前实现支持 points / line / bar / histogram / boxplot / smoother 6 种元素，
 * 以及 X / Y / Color / Size / Overlay / GroupX / GroupY / Wrap 编码通道。
 */

import type { GraphSpec, GraphData, ChartElement, FieldRef, GroupStyle, MarkerShape, RefLineY, RefLineX, RefLineStyle, BandRefLine, YAxisConfig, GridLineStyle, AutoSpec } from "./types.ts";
import { DEFAULT_GROUP_KEY } from "./types.ts";
import { buildAxisCommon, buildCorrelationDivergingPalette, type GraphTheme } from "./theme.ts";
import { buildBandSeries, FIT_BAND_ID_PREFIX } from "./confidenceBand.ts";
import type {
  BoxPlotPacket,
  CorrelationMatrixPacket,
  GraphDataFrame,
  GraphAggregatePacket,
  HeatmapPacket,
  HistogramPacket,
  PrecomputedCurvePacket,
  PrecomputedPointPacket,
  SummaryPacket,
} from "../types/graphData.ts";
import { buildFrameScatterItems, type FrameScatterItem } from "./frameScatter.ts";
import {
  computeJitterOffsets as computeStableJitterOffsets,
  estimateJitterXBandwidth,
  type JitterPoint,
} from "./jitter.ts";
import i18next from "i18next";

type EChartsOption = Record<string, unknown>;

interface FrameScatterCoordinates {
  x: {
    vector: "x" | "y" | "constant";
    column?: string;
    type: "continuous" | "nominal" | "datetime";
    categories?: readonly string[];
    constant?: number | string;
  };
  y?: {
    vector: "x" | "y";
    column: string;
  };
}

/** Resolved per-group style. Whichever element kinds are active in the
 *  group will pull styling from the matching sub-mark (line for line/
 *  smoother/box border/error bar, fill for box body/area band, point
 *  for scatter/summary dot/outliers). */
export interface ResolvedGroupStyle {
  line: { color: string; width: number; opacity: number };
  fill: { color: string; opacity: number };
  point: {
    color: string;          // border / stroke color
    fillColor: string;      // body color (transparent for hollow markers)
    marker: MarkerShape;
    size: number;
    opacity: number;
  };
  /** Outlier dots inherit the point style but default to a smaller, gray
   *  dot when the user hasn't overridden the point color. */
  outlier: { color: string; size: number; opacity: number };
}

/** Per-mark shade ratios — Point darkest, Line mid (base), Fill lightest.
 *  Must stay in sync with the panel's GraphBuilderView constants so the
 *  legend swatch on the right matches what ECharts renders on the canvas. */
const SHADE_RATIO_POINT = -0.2;
const SHADE_RATIO_LINE = 0;
const SHADE_RATIO_FILL = 0.55;

/** Hidden columns the renderer recognises in `GraphData.columns`. */
// Backend-issued stable row identifier — present on every dataset query
// result, used as the bridge back to the corresponding DataTableView cell
// when the user clicks a scatter point.
const ROW_ID_COL = "_row_id";
// Synthetic "variable" column introduced by GraphBuilder's multi-column
// melt mode. When present, the original source column for a melted point
// is the row's value in this column (not the renderer's `yIdx` column,
// which would be the synthetic `__sp_value__`).
const MELT_VAR_COL = "__sp_variable__";

interface PanelFacetContext {
  groupXValue: string | null;
  groupYValue: string | null;
  wrapValue?: string | null;
}

function matchesPanelFacet(
  value: { facetX?: string; facetY?: string; wrap?: string },
  panelFacet: PanelFacetContext,
): boolean {
  if (panelFacet.groupXValue !== null && value.facetX !== panelFacet.groupXValue) {
    return false;
  }
  if (panelFacet.groupYValue !== null && value.facetY !== panelFacet.groupYValue) {
    return false;
  }
  if (panelFacet.wrapValue != null && value.wrap !== panelFacet.wrapValue) {
    return false;
  }
  return true;
}

function bitIsSet(bitmap: Uint8Array | undefined, rowIndex: number): boolean {
  if (!bitmap) return true;
  const byteIndex = rowIndex >> 3;
  if (byteIndex >= bitmap.length) return false;
  return (bitmap[byteIndex] & (1 << (rowIndex & 7))) !== 0;
}

/** Marker attached to scatter `data` items so the GraphBuilder can map
 *  a click back to the source dataset row and the user-visible column.
 *  Optional — emitted only for raw scatter (not for aggregated summary
 *  dots, where a point represents many rows and "the" source row is
 *  undefined). */
export interface ScatterPointPick {
  /** Value of the dataset's `_row_id` for the source row, or `-1` when
   *  the dataset lacked an `_row_id` column (e.g. derived/synthetic
   *  data — clicks on these are ignored downstream). */
  rowId: number;
  /** User-visible column name. In multi-column melt mode this is the
   *  ORIGINAL column the point's value came from (read from
   *  `__sp_variable__`), never the synthetic melt column. */
  colName: string;
}

/** Mix `hex` toward black (ratio<0) or white (ratio>0). ratio in [-1,1]. */
function shade(hex: string, ratio: number): string {
  if (!hex || ratio === 0) return hex;
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const hh = m[1];
  const r = parseInt(hh.slice(0, 2), 16);
  const g = parseInt(hh.slice(2, 4), 16);
  const b = parseInt(hh.slice(4, 6), 16);
  const mix = (c: number) =>
    ratio < 0 ? Math.round(c * (1 + ratio)) : Math.round(c + (255 - c) * ratio);
  const clamp = (n: number) => Math.max(0, Math.min(255, n));
  const toHex = (n: number) => clamp(n).toString(16).padStart(2, "0");
  return `#${toHex(mix(r))}${toHex(mix(g))}${toHex(mix(b))}`;
}

/** Bake an alpha channel into a hex color so the fill alpha can be set
 *  independently of any shape-level `opacity` (which otherwise affects
 *  both fill and border together — see boxplot itemStyle). */
function withAlpha(color: string, alpha: number): string {
  if (!color || color === "transparent") return color;
  const a = Math.max(0, Math.min(1, alpha));
  const m = /^#?([0-9a-f]{6})$/i.exec(color);
  if (!m) return color;
  const r = parseInt(m[1].slice(0, 2), 16);
  const g = parseInt(m[1].slice(2, 4), 16);
  const b = parseInt(m[1].slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/** Compute the JMP-style defaults plus any per-group overrides.
 *
 *  Each legend group is auto-themed: from one base hue we derive a
 *  darker shade for the Point, the base shade for the Line, and a much
 *  lighter shade for the Fill. The shading keeps the three sub-marks
 *  visually distinguishable when they're layered on top of each other
 *  (otherwise the fill swallows the line and the point disappears). */
function resolveGroupStyle(
  groupKey: string,
  groupColor: string,
  grouping: boolean,
  theme: GraphTheme,
  styles: Record<string, GroupStyle> | undefined,
): ResolvedGroupStyle {
  const stored: GroupStyle = (styles && (styles[groupKey] ?? styles[DEFAULT_GROUP_KEY])) || {};
  // For ungrouped charts the panel's STYLE editor treats "no override" as
  // equivalent to the first preset theme (LINE_PALETTE[0] = '#000000',
  // FILL_PALETTE[0] = shade('#000000', 0.55), POINT_PALETTE[0] = '#000000')
  // — that's how the THEME picker auto-highlights theme[0] when nothing
  // is stored. Use the same literal '#000000' here (instead of
  // theme.fgPrimary, which is '#1a1a2e' in light mode) so the chart
  // actually paints theme[0]'s colors when the user clicks Reset.
  // Otherwise the legend swatch says "theme[0] selected" but the chart
  // renders a slightly different shade, making Reset look broken.
  const baseColor = grouping ? groupColor : "#000000";

  // Line defaults: thin, solid, baseColor (mid shade).
  const lineColor = stored.line?.color ?? (grouping ? shade(baseColor, SHADE_RATIO_LINE) : baseColor);
  const lineWidth = stored.line?.lineWidth ?? 1.5;
  const lineOpacity = stored.line?.opacity ?? 1;

  // Fill defaults: hollow when single-group (preserves the JMP look),
  // lighter shade of the categorical color when grouped so multiple
  // groups stay distinguishable without being noisy. Opacity defaults
  // to fully opaque — the lightened shade already provides enough
  // visual breathing room for the line/point on top to read clearly.
  const fillColor = stored.fill?.color ?? stored.fill?.fillColor
    ?? (grouping ? shade(baseColor, SHADE_RATIO_FILL) : "transparent");
  const fillOpacity = stored.fill?.opacity ?? 1;

  // Point defaults: filled circle 4px. When grouping, use the darker
  // shade so points read clearly on top of the lighter fill.
  const pointMarker: MarkerShape = stored.point?.marker ?? "circle";
  const pointDefault = grouping ? shade(baseColor, SHADE_RATIO_POINT) : baseColor;
  const pointStroke = stored.point?.color ?? pointDefault;
  const pointFill = stored.point?.fillColor ?? pointStroke;
  const pointSize = stored.point?.markerSize ?? 4;
  const pointOpacity = stored.point?.opacity ?? (grouping ? 0.9 : 1);

  // Outlier defaults: gray when point is at default; otherwise inherit.
  const outlierColor = stored.point?.color ?? (theme.fgDim || "#999");
  const outlierSize = Math.max(2, (stored.point?.markerSize ?? 4));
  const outlierOpacity = stored.point?.opacity ?? 0.85;

  return {
    line: { color: lineColor, width: lineWidth, opacity: lineOpacity },
    fill: { color: fillColor, opacity: fillOpacity },
    point: {
      color: pointStroke,
      fillColor: pointFill,
      marker: pointMarker,
      size: pointSize,
      opacity: pointOpacity,
    },
    outlier: { color: outlierColor, size: outlierSize, opacity: outlierOpacity },
  };
}

/** Translate a marker shape into ECharts symbol + whether it's filled. */
function markerToSymbol(m: MarkerShape): { symbol: string; hollow: boolean } {
  switch (m) {
    case "emptyCircle": return { symbol: "emptyCircle", hollow: true };
    case "square": return { symbol: "rect", hollow: false };
    case "emptySquare": return { symbol: "rect", hollow: true };
    case "diamond": return { symbol: "diamond", hollow: false };
    case "emptyDiamond": return { symbol: "diamond", hollow: true };
    case "triangle": return { symbol: "triangle", hollow: false };
    case "emptyTriangle": return { symbol: "triangle", hollow: true };
    case "circle":
    default: return { symbol: "circle", hollow: false };
  }
}

/** Build itemStyle for a point series given the resolved point sub-mark. */
function pointItemStyle(p: ResolvedGroupStyle["point"], hollow: boolean) {
  return hollow
    ? { color: "transparent", borderColor: p.color, borderWidth: 1, opacity: p.opacity }
    : { color: p.fillColor, borderColor: p.color, opacity: p.opacity };
}

/** 取列索引 */
function colIndex(data: GraphData, name: string | undefined): number {
  if (!name) return -1;
  return data.columns.indexOf(name);
}

/** 数值化：null/undefined/空/纯空白 -> NaN
 *
 *  Notably this guards against the silent `Number("")===0` and
 *  `Number(" ")===0` traps in JavaScript: without the explicit
 *  emptiness check below, a blank cell would be plotted at y=0 (or
 *  bucketed into the "0" bin) instead of being dropped as missing.
 *  We also `trim()` short strings to catch CSV imports that leave a
 *  stray space/tab in cells the user perceives as empty. */
function toNum(v: unknown): number {
  if (v == null) return NaN;
  if (typeof v === "string" && v.trim() === "") return NaN;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : NaN;
}

/** True when `v` should be treated as a missing observation (null,
 *  undefined, empty string, or whitespace-only string). Centralises the
 *  policy used by both numeric and categorical paths so the graph
 *  doesn't render phantom "" categories alongside real ones.
 *
 *  Exported because the legend builder in GraphBuilderView reuses the
 *  same predicate to drop legend entries whose group has no plottable
 *  rows (matches the per-element missing-data policy used here). */
export function isMissing(v: unknown): boolean {
  if (v == null) return true;
  if (typeof v === "string" && v.trim() === "") return true;
  return false;
}

/** 字符串化（用于分类轴 / 分组键） */
function toStr(v: unknown): string {
  if (v == null) return "";
  return String(v);
}

/**
 * Reorder a list of category names by the user-defined value order.
 * - Values present in `order` come first, in the order declared.
 * - Values NOT in `order` keep their natural (data) order, appended at
 *   the end. This matches the JMP behavior described in the i18n
 *   `missingHint` string and avoids surprising data loss when the user
 *   adds a new category to the column without updating Value Order.
 * - Returns the original `values` reference when `order` is empty (no
 *   re-shuffling needed), so downstream code that holds onto the array
 *   stays referentially stable.
 */
function applyValueOrder(values: string[], order: string[] | undefined): string[] {
  if (!order || order.length === 0) return values;
  const valueSet = new Set(values);
  const head: string[] = [];
  const headSet = new Set<string>();
  for (const v of order) {
    if (valueSet.has(v) && !headSet.has(v)) {
      head.push(v);
      headSet.add(v);
    }
  }
  const tail = values.filter((v) => !headSet.has(v));
  if (head.length === 0) return values;
  return [...head, ...tail];
}

/** Reorder a Map's keys by `applyValueOrder`. Preserves the value arrays. */
function reorderMapByValueOrder<V>(m: Map<string, V>, order: string[] | undefined): Map<string, V> {
  if (!order || order.length === 0) return m;
  const keys = Array.from(m.keys());
  const reordered = applyValueOrder(keys, order);
  if (reordered === keys) return m;
  const out = new Map<string, V>();
  for (const k of reordered) out.set(k, m.get(k)!);
  return out;
}

/** 按字段对行进行分组
 *
 *  Rows whose grouping value is missing (null / undefined / blank
 *  string) are excluded entirely instead of collapsing into a phantom
 *  empty-string bucket. This keeps blanks out of the X axis, the
 *  legend, and downstream aggregations such as the boxplot's per-X
 *  cells, where they would otherwise have rendered as a category
 *  labelled "" sitting next to a flat box at zero. */
function groupBy(
  data: GraphData,
  field: FieldRef | undefined,
): Map<string, number[]> {
  const out = new Map<string, number[]>();
  if (!field) {
    out.set("__all__", data.rows.map((_, i) => i));
    return out;
  }
  const idx = colIndex(data, field.name);
  if (idx < 0) {
    out.set("__all__", data.rows.map((_, i) => i));
    return out;
  }
  data.rows.forEach((row, i) => {
    const raw = row[idx];
    if (isMissing(raw)) return;
    const key = toStr(raw);
    let arr = out.get(key);
    if (!arr) {
      arr = [];
      out.set(key, arr);
    }
    arr.push(i);
  });
  return out;
}

/** 简单移动平均平滑器（以 X 排序后窗口平均） */
function movingAverage(points: [number, number][], window: number): [number, number][] {
  if (points.length === 0) return [];
  const sorted = [...points].sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  const half = Math.max(1, Math.floor(window / 2));
  for (let i = 0; i < sorted.length; i++) {
    const lo = Math.max(0, i - half);
    const hi = Math.min(sorted.length - 1, i + half);
    let sum = 0;
    let n = 0;
    for (let j = lo; j <= hi; j++) {
      sum += sorted[j][1];
      n++;
    }
    out.push([sorted[i][0], sum / n]);
  }
  return out;
}

/** Moving box (running median) — same window semantics as `movingAverage`
 *  but takes the per-window median of Y instead of the mean. Robust to
 *  outliers; sister algorithm to MA in the smoother panel. */
function movingMedian(points: [number, number][], window: number): [number, number][] {
  if (points.length === 0) return [];
  const sorted = [...points].sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  const half = Math.max(1, Math.floor(window / 2));
  for (let i = 0; i < sorted.length; i++) {
    const lo = Math.max(0, i - half);
    const hi = Math.min(sorted.length - 1, i + half);
    const ys: number[] = [];
    for (let j = lo; j <= hi; j++) ys.push(sorted[j][1]);
    ys.sort((a, b) => a - b);
    const m = ys.length;
    const med = m % 2 === 1 ? ys[m >> 1] : (ys[m / 2 - 1] + ys[m / 2]) / 2;
    out.push([sorted[i][0], med]);
  }
  return out;
}

/** Solve a small linear system A x = b via partial-pivot Gaussian
 *  elimination. Used by the local-polynomial fits inside the
 *  Savitzky-Golay smoother. Returns null when the system is singular
 *  (rank-deficient neighbourhood, e.g. all neighbours collapse to one
 *  x value); callers fall back to NaN at that sample. */
function solveLinearSystem(A: number[][], b: number[]): number[] | null {
  const n = A.length;
  const M: number[][] = A.map((row, i) => [...row, b[i]]);
  for (let i = 0; i < n; i++) {
    let pivot = i;
    for (let r = i + 1; r < n; r++) {
      if (Math.abs(M[r][i]) > Math.abs(M[pivot][i])) pivot = r;
    }
    [M[i], M[pivot]] = [M[pivot], M[i]];
    if (Math.abs(M[i][i]) < 1e-12) return null;
    for (let r = i + 1; r < n; r++) {
      const f = M[r][i] / M[i][i];
      for (let c = i; c <= n; c++) M[r][c] -= f * M[i][c];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = M[i][n];
    for (let c = i + 1; c < n; c++) s -= M[i][c] * x[c];
    x[i] = s / M[i][i];
  }
  return x;
}

/** Second derivatives at each knot of a natural cubic spline through
 *  (xs, ys). `xs` MUST be strictly increasing. Used by `splineSmoother`
 *  to interpolate between bin-averaged knots. Standard tridiagonal
 *  algorithm (Numerical Recipes §3.3 / Burden & Faires Alg. 3.4). */
function naturalCubicSpline2nd(xs: number[], ys: number[]): number[] {
  const n = xs.length;
  if (n < 3) return new Array<number>(n).fill(0);
  const h = new Array<number>(n - 1);
  for (let i = 0; i < n - 1; i++) h[i] = xs[i + 1] - xs[i];
  const alpha = new Array<number>(n).fill(0);
  for (let i = 1; i < n - 1; i++) {
    alpha[i] =
      (3 / h[i]) * (ys[i + 1] - ys[i]) -
      (3 / h[i - 1]) * (ys[i] - ys[i - 1]);
  }
  const l = new Array<number>(n).fill(0);
  const mu = new Array<number>(n).fill(0);
  const z = new Array<number>(n).fill(0);
  l[0] = 1;
  for (let i = 1; i < n - 1; i++) {
    l[i] = 2 * (xs[i + 1] - xs[i - 1]) - h[i - 1] * mu[i - 1];
    mu[i] = h[i] / l[i];
    z[i] = (alpha[i] - h[i - 1] * z[i - 1]) / l[i];
  }
  l[n - 1] = 1;
  const c = new Array<number>(n).fill(0);
  for (let j = n - 2; j >= 0; j--) c[j] = z[j] - mu[j] * c[j + 1];
  return c;
}

/** Evaluate the natural cubic spline (knots `xs`/`ys`, 2nd derivs `c`)
 *  at `x`. Extrapolates linearly via the first/last segment when `x`
 *  falls outside the knot range. */
function evalCubicSpline(
  xs: number[],
  ys: number[],
  c: number[],
  x: number,
): number {
  const n = xs.length;
  if (n === 0) return NaN;
  if (n === 1) return ys[0];
  let lo = 0;
  let hi = n - 1;
  if (x <= xs[0]) {
    lo = 0;
    hi = 1;
  } else if (x >= xs[n - 1]) {
    lo = n - 2;
    hi = n - 1;
  } else {
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (xs[mid] > x) hi = mid;
      else lo = mid;
    }
  }
  const hSeg = xs[hi] - xs[lo];
  if (hSeg <= 0) return ys[lo];
  const a = ys[lo];
  const b = (ys[hi] - ys[lo]) / hSeg - (hSeg * (2 * c[lo] + c[hi])) / 3;
  const d = (c[hi] - c[lo]) / (3 * hSeg);
  const dx = x - xs[lo];
  return a + b * dx + c[lo] * dx * dx + d * dx * dx * dx;
}

/** Spline smoother: bin-average to K knots, then natural cubic spline
 *  through the knot centres. `smoothness` ∈ [0, 1] picks the knot count
 *  — 0 = ~n knots (close to raw data interpolation), 1 = 4 knots (very
 *  smooth). Sampled at `sampleCount` evenly-spaced points across the
 *  data X range so the rendered line stays crisp regardless of data
 *  density. */
function splineSmoother(
  points: [number, number][],
  smoothness: number,
  sampleCount = 200,
): [number, number][] {
  if (points.length < 2) return points;
  const sorted = [...points].sort((a, b) => a[0] - b[0]);
  const n = sorted.length;
  const xMin = sorted[0][0];
  const xMax = sorted[n - 1][0];
  if (!(xMax > xMin)) return points;
  const s = Math.max(0, Math.min(1, smoothness));
  const K = Math.max(4, Math.min(n, Math.round(n - s * (n - 4))));
  const kxs: number[] = [];
  const kys: number[] = [];
  const binW = (xMax - xMin) / K;
  let cursor = 0;
  for (let k = 0; k < K; k++) {
    const lo = xMin + k * binW;
    const hi = k === K - 1 ? xMax + 1 : lo + binW;
    let sx = 0;
    let sy = 0;
    let cnt = 0;
    // sorted is monotonic in x → advance a moving cursor instead of
    // re-scanning the whole array per bin (O(n) total vs O(n·K)).
    while (cursor < n && sorted[cursor][0] < lo) cursor++;
    let j = cursor;
    while (j < n && sorted[j][0] < hi) {
      sx += sorted[j][0];
      sy += sorted[j][1];
      cnt++;
      j++;
    }
    if (cnt > 0) {
      kxs.push(sx / cnt);
      kys.push(sy / cnt);
    }
  }
  if (kxs.length < 2) return points;
  // Strict-increasing fix: identical knot xs (multiple rows at the
  // same X) would zero a segment width and explode the tridiagonal
  // solve. Nudge duplicates forward by a sub-pixel epsilon.
  for (let i = 1; i < kxs.length; i++) {
    if (kxs[i] <= kxs[i - 1]) kxs[i] = kxs[i - 1] + 1e-9;
  }
  const c = naturalCubicSpline2nd(kxs, kys);
  const out: [number, number][] = [];
  for (let i = 0; i < sampleCount; i++) {
    const x = xMin + (i / (sampleCount - 1)) * (xMax - xMin);
    out.push([x, evalCubicSpline(kxs, kys, c, x)]);
  }
  return out;
}

/** Nadaraya–Watson kernel regression with Gaussian kernel.
 *  `bandwidth` is the kernel standard deviation expressed as a
 *  fraction of the X-range (clamped to [0.01, 0.5]). */
function kernelSmoother(
  points: [number, number][],
  bandwidth: number,
  sampleCount = 200,
): [number, number][] {
  if (points.length === 0) return [];
  const sorted = [...points].sort((a, b) => a[0] - b[0]);
  const n = sorted.length;
  const xMin = sorted[0][0];
  const xMax = sorted[n - 1][0];
  if (!(xMax > xMin)) return points;
  const h = Math.max(
    (xMax - xMin) * Math.max(0.01, Math.min(0.5, bandwidth)),
    1e-9,
  );
  const out: [number, number][] = [];
  for (let i = 0; i < sampleCount; i++) {
    const x = xMin + (i / (sampleCount - 1)) * (xMax - xMin);
    let num = 0;
    let den = 0;
    for (let j = 0; j < n; j++) {
      const u = (x - sorted[j][0]) / h;
      const w = Math.exp(-0.5 * u * u);
      num += w * sorted[j][1];
      den += w;
    }
    out.push([x, den > 0 ? num / den : NaN]);
  }
  return out;
}

/** Savitzky–Golay smoother generalised to IRREGULARLY-SPACED data:
 *  at each sample x*, fit a degree-`polyOrder` polynomial via
 *  ordinary least squares through the `window` nearest neighbours and
 *  evaluate at x*. Reduces to the classic SG filter on uniform grids.
 *  `window` is clamped to be odd and ≥ polyOrder+1; `polyOrder` to
 *  [1, 4]. */
function savgolSmoother(
  points: [number, number][],
  window: number,
  polyOrder: number,
  sampleCount = 200,
): [number, number][] {
  if (points.length === 0) return [];
  const sorted = [...points].sort((a, b) => a[0] - b[0]);
  const n = sorted.length;
  const xMin = sorted[0][0];
  const xMax = sorted[n - 1][0];
  if (!(xMax > xMin)) return points;
  const p = Math.max(1, Math.min(4, Math.floor(polyOrder)));
  let win = Math.max(p + 1, Math.min(n, Math.floor(window)));
  if (win % 2 === 0) win = Math.min(n, win + 1);
  const half = Math.floor(win / 2);
  const m = p + 1;
  const out: [number, number][] = [];
  for (let i = 0; i < sampleCount; i++) {
    const x = xMin + (i / (sampleCount - 1)) * (xMax - xMin);
    // Binary-search the nearest sample to `x`, then take the window
    // centred there (clamped at the data edges).
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid][0] < x) lo = mid;
      else hi = mid;
    }
    const center =
      Math.abs(sorted[lo][0] - x) <= Math.abs(sorted[hi][0] - x) ? lo : hi;
    const start = Math.max(0, Math.min(n - win, center - half));
    const end = start + win;
    // Build normal equations (AᵀA) a = Aᵀb for the local polynomial
    // y ≈ Σ_k aₖ (xᵢ − x*)ᵏ. Power matrix is constructed on the fly
    // to skip materialising A explicitly.
    const ATA: number[][] = Array.from({ length: m }, () =>
      new Array<number>(m).fill(0),
    );
    const ATb: number[] = new Array<number>(m).fill(0);
    const row = new Array<number>(m);
    for (let j = start; j < end; j++) {
      const dx = sorted[j][0] - x;
      let v = 1;
      for (let k = 0; k < m; k++) {
        row[k] = v;
        v *= dx;
      }
      const yj = sorted[j][1];
      for (let r = 0; r < m; r++) {
        ATb[r] += row[r] * yj;
        for (let c = 0; c < m; c++) ATA[r][c] += row[r] * row[c];
      }
    }
    const a = solveLinearSystem(ATA, ATb);
    out.push([x, a ? a[0] : NaN]);
  }
  return out;
}

// ---- Polynomial / Robust regression -----------------------------------
// Helpers backing the `fitline` element. Polynomial OLS supports any
// degree 1–6 with proper confidence (`Fit`) and prediction (`Pred`)
// intervals. Robust Cauchy is an IRLS variant that down-weights
// outliers via the Cauchy ψ function — useful when the data contains
// heavy-tailed noise or a few influential outliers.

/** Invert a small dense matrix via Gauss-Jordan elimination with
 *  partial pivoting. Returns null when `A` is singular. Used by the
 *  polynomial fit to compute fit / prediction confidence intervals
 *  via the quadratic form x*ᵀ(XᵀX)⁻¹x*. */
function invertMatrix(A: number[][]): number[][] | null {
  const n = A.length;
  const M: number[][] = A.map((row, i) => {
    const r = [...row];
    for (let j = 0; j < n; j++) r.push(i === j ? 1 : 0);
    return r;
  });
  for (let i = 0; i < n; i++) {
    let pivot = i;
    for (let r = i + 1; r < n; r++) {
      if (Math.abs(M[r][i]) > Math.abs(M[pivot][i])) pivot = r;
    }
    [M[i], M[pivot]] = [M[pivot], M[i]];
    if (Math.abs(M[i][i]) < 1e-12) return null;
    const piv = M[i][i];
    for (let c = 0; c < 2 * n; c++) M[i][c] /= piv;
    for (let r = 0; r < n; r++) {
      if (r === i) continue;
      const f = M[r][i];
      if (f === 0) continue;
      for (let c = 0; c < 2 * n; c++) M[r][c] -= f * M[i][c];
    }
  }
  return M.map((row) => row.slice(n));
}

/** Two-tailed Student's t critical value at α = 0.05 (i.e. 95% CI).
 *  Fisher-Cornish expansion around the normal z = 1.96 — accurate to
 *  ~3 decimal places for df ≥ 5 and asymptotes to 1.96 as df → ∞.
 *  We only need 95% CIs in the UI so a fixed-α implementation keeps
 *  the call site simple. */
function tCritical95(df: number): number {
  if (!(df > 0)) return 1.96;
  if (df >= 1000) return 1.96;
  const z = 1.96;
  const z2 = z * z;
  return (
    z +
    (z * z2 + z) / (4 * df) +
    (5 * z2 * z2 * z + 16 * z * z2 + 3 * z) / (96 * df * df)
  );
}

/** Output of a polynomial regression. Coefficients live in NORMALISED
 *  x-space (x' = (x − xMean) / xScale) so the design matrix stays
 *  well-conditioned even at degree 6 with widely-ranged or large X
 *  values (e.g. epoch ms). Callers that want to display the equation
 *  in raw x must run `denormalizeCoefs` first. */
interface PolyFit {
  coefs: number[];
  xMean: number;
  xScale: number;
  rmse: number;
  r2: number;
  fStat: number;
  n: number;
  degree: number;
  /** (XᵀX)⁻¹ in normalised space; null when the design is singular —
   *  callers must skip CI computation in that case. */
  invXTX: number[][] | null;
  /** Residual variance σ̂² = SSE / (n − p − 1). */
  sigma2: number;
}

/** Ordinary least-squares polynomial fit of degree `degree` (1–6).
 *  Returns null when the sample size is too small for a meaningful
 *  variance estimate or when X has no spread. */
function fitPolynomial(
  xs: number[],
  ys: number[],
  degree: number,
): PolyFit | null {
  const n = xs.length;
  const m = degree + 1;
  if (n < m + 1) return null;
  let xMean = 0;
  for (const x of xs) xMean += x;
  xMean /= n;
  // Use the max absolute deviation as the scale (cheaper than std and
  // keeps x' inside [-1, 1] so xⁿ never overflows for n ≤ 6).
  let xScale = 0;
  for (const x of xs) {
    const d = Math.abs(x - xMean);
    if (d > xScale) xScale = d;
  }
  if (!(xScale > 0)) return null;
  const XTX: number[][] = Array.from({ length: m }, () =>
    new Array<number>(m).fill(0),
  );
  const XTy: number[] = new Array<number>(m).fill(0);
  const xp = new Array<number>(m);
  for (let i = 0; i < n; i++) {
    const xn = (xs[i] - xMean) / xScale;
    let v = 1;
    for (let k = 0; k < m; k++) {
      xp[k] = v;
      v *= xn;
    }
    for (let r = 0; r < m; r++) {
      XTy[r] += xp[r] * ys[i];
      for (let c = 0; c < m; c++) XTX[r][c] += xp[r] * xp[c];
    }
  }
  const coefs = solveLinearSystem(XTX, XTy);
  if (!coefs) return null;
  let yMean = 0;
  for (const y of ys) yMean += y;
  yMean /= n;
  let sse = 0;
  let sst = 0;
  for (let i = 0; i < n; i++) {
    const xn = (xs[i] - xMean) / xScale;
    let yhat = 0;
    let v = 1;
    for (let k = 0; k < m; k++) {
      yhat += coefs[k] * v;
      v *= xn;
    }
    const r = ys[i] - yhat;
    sse += r * r;
    const d = ys[i] - yMean;
    sst += d * d;
  }
  const dfRes = n - m;
  const sigma2 = dfRes > 0 ? sse / dfRes : 0;
  const rmse = dfRes > 0 ? Math.sqrt(sigma2) : 0;
  const r2 = sst > 0 ? Math.max(0, 1 - sse / sst) : 0;
  const fStat =
    sse > 0 && dfRes > 0 && degree > 0
      ? ((sst - sse) / degree) / (sse / dfRes)
      : 0;
  return {
    coefs,
    xMean,
    xScale,
    rmse,
    r2,
    fStat,
    n,
    degree,
    invXTX: invertMatrix(XTX),
    sigma2,
  };
}

/** Iteratively-reweighted least squares with the Cauchy ψ function —
 *  a robust M-estimator that pulls outlier weights toward zero
 *  smoothly (unlike Huber's clipped weighting). Tuning constant
 *  c = 2.385 matches JMP's "Robust Cauchy" preset. The reported
 *  RMSE / R² / F / invXTX are computed from the UNWEIGHTED residuals
 *  against the robust coefs so the confidence band still has a
 *  meaningful frequentist interpretation. */
function fitRobustCauchy(
  xs: number[],
  ys: number[],
  degree: number,
  maxIter = 50,
): PolyFit | null {
  const init = fitPolynomial(xs, ys, degree);
  if (!init) return null;
  const n = xs.length;
  const m = degree + 1;
  const { xMean, xScale } = init;
  const c = 2.385;
  let coefs = [...init.coefs];
  const xp = new Array<number>(m);
  const resid = new Array<number>(n);
  for (let iter = 0; iter < maxIter; iter++) {
    for (let i = 0; i < n; i++) {
      const xn = (xs[i] - xMean) / xScale;
      let yhat = 0;
      let v = 1;
      for (let k = 0; k < m; k++) {
        yhat += coefs[k] * v;
        v *= xn;
      }
      resid[i] = ys[i] - yhat;
    }
    // MAD-based robust scale (0.6745 ≈ inverse normal CDF at .75 so
    // σ̂ matches the std-dev of a Normal sample in the absence of
    // outliers).
    const sortedR = [...resid].sort((a, b) => a - b);
    const med = sortedR[n >> 1];
    const absDev = resid.map((x) => Math.abs(x - med)).sort((a, b) => a - b);
    const mad = absDev[n >> 1];
    const sigma = mad / 0.6745 || 1e-9;
    const XTX: number[][] = Array.from({ length: m }, () =>
      new Array<number>(m).fill(0),
    );
    const XTy: number[] = new Array<number>(m).fill(0);
    for (let i = 0; i < n; i++) {
      const ratio = resid[i] / (c * sigma);
      const w = 1 / (1 + ratio * ratio);
      const xn = (xs[i] - xMean) / xScale;
      let v = 1;
      for (let k = 0; k < m; k++) {
        xp[k] = v;
        v *= xn;
      }
      for (let r = 0; r < m; r++) {
        XTy[r] += w * xp[r] * ys[i];
        for (let cc = 0; cc < m; cc++) XTX[r][cc] += w * xp[r] * xp[cc];
      }
    }
    const next = solveLinearSystem(XTX, XTy);
    if (!next) break;
    let maxDelta = 0;
    for (let k = 0; k < m; k++) {
      const d = Math.abs(next[k] - coefs[k]);
      if (d > maxDelta) maxDelta = d;
    }
    coefs = next;
    if (maxDelta < 1e-7) break;
  }
  // Recompute summary stats + unweighted XTX from the final coefs.
  let yMean = 0;
  for (const y of ys) yMean += y;
  yMean /= n;
  let sse = 0;
  let sst = 0;
  const XTX: number[][] = Array.from({ length: m }, () =>
    new Array<number>(m).fill(0),
  );
  for (let i = 0; i < n; i++) {
    const xn = (xs[i] - xMean) / xScale;
    let yhat = 0;
    let v = 1;
    for (let k = 0; k < m; k++) {
      xp[k] = v;
      yhat += coefs[k] * v;
      v *= xn;
    }
    const r = ys[i] - yhat;
    sse += r * r;
    const d = ys[i] - yMean;
    sst += d * d;
    for (let rr = 0; rr < m; rr++) {
      for (let cc = 0; cc < m; cc++) XTX[rr][cc] += xp[rr] * xp[cc];
    }
  }
  const dfRes = n - m;
  const sigma2 = dfRes > 0 ? sse / dfRes : 0;
  const rmse = dfRes > 0 ? Math.sqrt(sigma2) : 0;
  const r2 = sst > 0 ? Math.max(0, 1 - sse / sst) : 0;
  const fStat =
    sse > 0 && dfRes > 0 && degree > 0
      ? ((sst - sse) / degree) / (sse / dfRes)
      : 0;
  return {
    coefs,
    xMean,
    xScale,
    rmse,
    r2,
    fStat,
    n,
    degree,
    invXTX: invertMatrix(XTX),
    sigma2,
  };
}

/** Convert polynomial coefficients fit in normalised x' = (x − μ)/s
 *  back to the original x basis, so the equation we display matches
 *  what the user sees on the X axis. Uses the binomial expansion of
 *  x'ᵏ; numerically fine up to degree 6 because the precomputed
 *  binomial table is exact. */
function denormalizeCoefs(
  coefs: number[],
  mean: number,
  scale: number,
): number[] {
  const m = coefs.length;
  const out = new Array<number>(m).fill(0);
  const invS = new Array<number>(m);
  invS[0] = 1;
  for (let k = 1; k < m; k++) invS[k] = invS[k - 1] / scale;
  const negMu = new Array<number>(m);
  negMu[0] = 1;
  for (let k = 1; k < m; k++) negMu[k] = negMu[k - 1] * -mean;
  const C: number[][] = Array.from({ length: m }, () =>
    new Array<number>(m).fill(0),
  );
  for (let i = 0; i < m; i++) {
    C[i][0] = 1;
    C[i][i] = 1;
    for (let j = 1; j < i; j++) C[i][j] = C[i - 1][j - 1] + C[i - 1][j];
  }
  for (let j = 0; j < m; j++) {
    let bj = 0;
    for (let k = j; k < m; k++) {
      bj += coefs[k] * invS[k] * C[k][j] * negMu[k - j];
    }
    out[j] = bj;
  }
  return out;
}

/** Pretty-print a polynomial equation. Uses Unicode superscripts for
 *  exponents 2–6 (the only degrees this UI exposes) so the equation
 *  reads naturally without a math-typesetter. */
function formatEquation(coefs: number[]): string {
  const SUP = ["", "", "²", "³", "⁴", "⁵", "⁶"];
  const fmt = (v: number): string => {
    const a = Math.abs(v);
    if (a !== 0 && (a >= 1e4 || a < 1e-3)) return v.toExponential(3);
    // toPrecision then strip trailing zeros / dangling decimal.
    return parseFloat(v.toPrecision(4)).toString();
  };
  let s = "y = ";
  for (let k = 0; k < coefs.length; k++) {
    const c = coefs[k];
    if (k === 0) {
      s += fmt(c);
      continue;
    }
    const sign = c >= 0 ? " + " : " − ";
    const mag = Math.abs(c);
    const term =
      k === 1 ? `${fmt(mag)}·x` : `${fmt(mag)}·x${SUP[k] ?? `^${k}`}`;
    s += sign + term;
  }
  return s;
}

/** Auto-tick density tuning constants. Both are deliberately "round"
 *  numbers so the resulting tick labels and bin boundaries land on
 *  values like 0.5 / 0.1 instead of 0.42 / 0.083.
 *
 *  - `AUTO_TARGET_TICKS` is the approximate number of MAJOR ticks the
 *    nice-snap algorithm aims for on a continuous axis. Bumped from
 *    the historic 8 to 10 so the chart frame doesn't feel sparse on
 *    typical 600–900 px plot widths/heights. The nice-step picker
 *    then snaps to a {1, 2, 2.5, 5, 10} × 10^k multiplier, so the
 *    actual on-screen tick count drifts within ±2 of the target.
 *  - `AUTO_MINOR_SPLIT` is how many SEGMENTS each major interval is
 *    divided into for minor ticks (ECharts `minorTick.splitNumber`).
 *    5 → 4 visible minor ticks between every pair of majors, which
 *    aligns with the standard "10ths" grid most measurement charts
 *    use. The user can still override via the axis dialog
 *    (`minorTickCount = N` → splitNumber = N + 1, or
 *    `minorTickCount = 0` → minor ticks off entirely). */
const AUTO_TARGET_TICKS = 10;
const AUTO_MINOR_SPLIT = 5;

/** Target tick count for HISTOGRAM bin-width computation. Must match
 *  what ECharts' axis renderer will actually pick, NOT our internal
 *  nice-snap density.
 *
 *  Why this is different from `AUTO_TARGET_TICKS`: we deliberately do
 *  NOT pass `interval` to ECharts (it baked stale steps into the
 *  option during drag, causing tick labels to drift off the nice
 *  grid). ECharts then picks its own interval using its built-in
 *  `splitNumber` (default 5 for value axes). So if our bin-width
 *  computation uses `AUTO_TARGET_TICKS=10` to derive `majorStep`, the
 *  bars come out at a finer width than the minor-tick segments the
 *  user actually sees on the rendered axis — exactly the bug the
 *  "histogram width follows minor tick width" requirement is trying
 *  to avoid.
 *
 *  Concrete example: data [0.10, 0.30], range 0.20.
 *  - niceStep(0.20, 10) → 0.02 (too fine; ECharts won't show 0.02
 *    majors here, it shows 0.05 majors).
 *  - niceStep(0.20, 5)  → 0.05 (matches the visible major labels).
 *  Bin width = 0.05 / 5 = 0.01 = one visible minor segment. */
const BIN_GRID_TARGET_TICKS = 5;

/** Resolve the effective minor-tick split (segments per major) for an
 *  axis, applying the same tri-state contract used in
 *  `buildAxisOverrides`:
 *    undefined  → auto default (`AUTO_MINOR_SPLIT`)
 *    > 0        → user explicit N visible minors → N+1 segments
 *    0          → user explicit off; we still return `AUTO_MINOR_SPLIT`
 *                 for grid math (histogram bin width, etc.) since "no
 *                 minor ticks rendered" should not collapse the bin
 *                 density to one-bar-per-major. */
function resolveMinorSplit(axisCfg: YAxisConfig | undefined): number {
  const raw = axisCfg?.minorTickCount;
  if (Number.isFinite(raw as number) && (raw as number) > 0) {
    return Math.max(1, Math.round(raw as number)) + 1;
  }
  return AUTO_MINOR_SPLIT;
}

/** Compute a sensible histogram bin count from a value range and an
 *  axis config so the histogram's bin edges align with the chart's
 *  MINOR tick grid. Concretely:
 *
 *  - Snap a nice major step over [lo, hi] using `AUTO_TARGET_TICKS`.
 *  - Resolve the active minor split for that axis: user explicit
 *    `minorTickCount + 1`, or `AUTO_MINOR_SPLIT` when auto.
 *  - bin width = step / minorSplit  (= the minor tick interval).
 *  - bin count = round(range / binWidth), clamped to [10, 80] so
 *    extreme axis configs (e.g. user-pinned `tickInterval = 1` on
 *    a tiny range) don't explode into hundreds of degenerate bars.
 *
 *  When the user has explicitly pinned `tickInterval`, prefer that
 *  over the auto nice-step so the histogram still aligns visually.
 *  Returns the legacy default of 20 for degenerate inputs. */
function computeAutoBinCount(
  lo: number,
  hi: number,
  axisCfg: YAxisConfig | undefined,
): number {
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return 20;
  const range = hi - lo;
  // Major step: user override → auto nice-snap fallback. We use
  // `BIN_GRID_TARGET_TICKS` (not `AUTO_TARGET_TICKS`) so the
  // computed bin grid lines up with the major step ECharts actually
  // renders on the axis — the histogram code does NOT emit `interval`
  // to ECharts (see yFinalBounds rationale), so the axis renderer's
  // own default `splitNumber=5` picks the visible major ticks.
  const userStep = axisCfg?.tickInterval;
  const majorStep =
    Number.isFinite(userStep as number) && (userStep as number) > 0
      ? (userStep as number)
      : niceStep(range, BIN_GRID_TARGET_TICKS);
  // Minor split: shared with the axis renderer via `resolveMinorSplit`
  // so bin edges land exactly on the rendered minor tick positions.
  const minorSplit = resolveMinorSplit(axisCfg);
  const binWidth = majorStep / minorSplit;
  if (!Number.isFinite(binWidth) || binWidth <= 0) return 20;
  const count = Math.round(range / binWidth);
  return Math.max(10, Math.min(80, count));
}

/** 直方图分箱 */
function histogramBins(values: number[], binCount = 20): {
  centers: number[];
  counts: number[];
  width: number;
} {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return { centers: [], counts: [], width: 1 };
  // Use a single-pass loop instead of Math.min/max(...finite) so large
  // datasets don't overflow V8's argument-count limit (RangeError).
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < finite.length; i++) {
    const v = finite[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (min === max) return { centers: [min], counts: [finite.length], width: 1 };
  const width = (max - min) / binCount;
  const counts = new Array<number>(binCount).fill(0);
  for (const v of finite) {
    let bin = Math.floor((v - min) / width);
    if (bin >= binCount) bin = binCount - 1;
    counts[bin]++;
  }
  const centers = counts.map((_, i) => min + width * (i + 0.5));
  return { centers, counts, width };
}

/** Mean + sample std-dev for a numeric array. Used by the histogram stats
 *  overlay ("Mean=… Std Dev=…"). Non-finite values are filtered upstream by
 *  `histogramBins`; this helper does the same defensively so callers can
 *  pass raw column values without re-filtering. */
function meanStd(values: number[]): { mean: number; std: number; n: number } {
  let n = 0;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (Number.isFinite(v)) {
      sum += v;
      n++;
    }
  }
  if (n === 0) return { mean: NaN, std: NaN, n: 0 };
  const mean = sum / n;
  if (n < 2) return { mean, std: 0, n };
  let sq = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (Number.isFinite(v)) {
      const d = v - mean;
      sq += d * d;
    }
  }
  return { mean, std: Math.sqrt(sq / (n - 1)), n };
}

/** Kernel Density Estimate using a Gaussian kernel.
 *
 *  Bandwidth = Silverman's rule of thumb (h = 1.06 σ n^(-1/5)) multiplied
 *  by `smoothness ∈ [0.25, 3]` so the user's 0..1 slider gives a sensible
 *  range from a tighter-than-Silverman fit to a heavy oversmooth.
 *
 *  Returns [x, density × n × binWidth] pairs so the curve sits at the same
 *  vertical scale as a count histogram (∫density dx = 1, scaled to total
 *  count over one bin's worth of x for visual comparability).
 *
 *  `npoints` controls the curve resolution; 200 is enough for a smooth
 *  rendering at any chart size without overwhelming ECharts. */
function kdeCurve(
  values: number[],
  smoothness: number,
  binWidth: number,
  npoints = 200,
): [number, number][] {
  const finite: number[] = [];
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (Number.isFinite(v)) {
      finite.push(v);
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  const n = finite.length;
  if (n === 0 || min === max) return [];
  const { std } = meanStd(finite);
  // Silverman; guard against std=0 (constant column) using range/6.
  const sigma = std > 0 ? std : (max - min) / 6;
  const silverman = 1.06 * sigma * Math.pow(n, -1 / 5);
  // Map smoothness [0,1] → multiplier [0.25, 3]; default 0.5 → ~1.6.
  const mult = 0.25 + Math.max(0, Math.min(1, smoothness)) * 2.75;
  const h = Math.max(silverman * mult, 1e-9);
  const pad = h * 3;
  const x0 = min - pad;
  const x1 = max + pad;
  const step = (x1 - x0) / (npoints - 1);
  const out: [number, number][] = [];
  // Precompute the Gaussian coefficient.
  const coeff = 1 / (Math.sqrt(2 * Math.PI) * h);
  // Scale density to count-per-bin so the KDE overlay reads on the same
  // axis as a count histogram (caller already binned at `binWidth`).
  const scale = n * binWidth;
  for (let i = 0; i < npoints; i++) {
    const x = x0 + step * i;
    let sum = 0;
    for (let j = 0; j < n; j++) {
      const u = (x - finite[j]) / h;
      sum += Math.exp(-0.5 * u * u);
    }
    out.push([x, (coeff * sum / n) * scale]);
  }
  return out;
}

function normalCurveDomain(
  mean: number,
  std: number,
  min: number,
  max: number,
): [number, number] | null {
  if (
    !Number.isFinite(mean) || !Number.isFinite(std) || std <= 0 ||
    !Number.isFinite(min) || !Number.isFinite(max)
  ) return null;
  const x0 = Math.min(min, mean - 4 * std);
  const x1 = Math.max(max, mean + 4 * std);
  return Number.isFinite(x0) && Number.isFinite(x1) && x1 > x0 ? [x0, x1] : null;
}

function normalCurve(
  mean: number,
  std: number,
  count: number,
  binWidth: number,
  min: number,
  max: number,
  npoints = 201,
): [number, number][] {
  if (
    !Number.isFinite(mean) || !Number.isFinite(std) || std <= 0 ||
    !Number.isFinite(count) || count < 2 || !Number.isFinite(binWidth) || binWidth <= 0
  ) return [];
  const domain = normalCurveDomain(mean, std, min, max);
  if (!domain || npoints < 2) return [];
  const [x0, x1] = domain;
  const step = (x1 - x0) / (npoints - 1);
  const coefficient = count * binWidth / (std * Math.sqrt(2 * Math.PI));
  return Array.from({ length: npoints }, (_, index) => {
    const x = x0 + step * index;
    const z = (x - mean) / std;
    return [x, coefficient * Math.exp(-0.5 * z * z)];
  });
}

/** 箱线图统计：min, Q1, median, Q3, max */
function boxStats(values: number[]): [number, number, number, number, number] | null {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const q = (p: number) => {
    const idx = (v.length - 1) * p;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    return lo === hi ? v[lo] : v[lo] + (v[hi] - v[lo]) * (idx - lo);
  };
  return [v[0], q(0.25), q(0.5), q(0.75), v[v.length - 1]];
}

// ---- MODE C per-category histogram bar renderer ---------------------------
//
// Shared renderItem for MODE C bar/shadowgram series. Per-bar data
// (count, bin half-height, per-cat max, group total) is passed via
// `info` rather than read with `api.value(i)` — ECharts custom series
// only allocate dimensions up to the maximum index named in `encode`,
// so `api.value(3+)` returns NaN even when the data tuple has more
// columns. We use the data tuple ONLY to feed the axis (cat + a
// representative bin center) and look up the rest by data index from
// a closure-bound array.
//
// Orientation is detected from the series id suffix (`__t` appended
// by `transposeSeriesData` after the X↔Y swap). When `catIsX` the
// bar is horizontal in a vertical slot (cat on X); otherwise it is
// vertical in a horizontal slot (cat on Y, post-transpose).
type RenderHistCatBarOpts = {
  fillColor: string;
  strokeColor: string;
  grouping: boolean;
  showLabel: boolean;
  showCounts: boolean;
  showPercents: boolean;
  theme: GraphTheme;
  /** Override the per-bar opacity (e.g. shadowgram layers use ~0.18). */
  layerOpacity?: number;
  /** Fraction of the cat slot the longest bar should fill, in [0.1, 1.0].
   *  1.0 keeps the legacy default (85% of the slot, leaving a ~15% safe
   *  gap from the next category divider). User-controlled via the
   *  "histogram height" slider. */
  heightScale?: number;
};
type HistBarInfo = {
  cat: string;
  binCenter: number;
  count: number;
  binHalfH: number;
  catMaxCount: number;
  groupTotal: number;
};
function renderHistCatBar(
  params: any,
  api: any,
  info: HistBarInfo,
  opts: RenderHistCatBarOpts,
): unknown {
  const catIsX = !String(params.seriesId || "").endsWith("__t");
  const { cat, binCenter, count, binHalfH, catMaxCount, groupTotal } = info;

  const xy = (val: number): [any, any] =>
    catIsX ? [cat, val] : [val, cat];
  const ctrCoord = api.coord(xy(binCenter));
  const aCoord = api.coord(xy(binCenter + binHalfH));
  const bCoord = api.coord(xy(binCenter - binHalfH));
  if (!ctrCoord || !aCoord || !bCoord) return null;

  const slotPx = catIsX ? api.size([1, 0])[0] : api.size([0, 1])[1];
  const insetMargin = 1; // small gap from the divider line
  // Reserve ~15% of the slot on the trailing edge so the longest bar
  // doesn't touch the next category's divider line.
  const rightSafePct = 0.15;
  // User-controlled "histogram height" scale in [0.1, 1.0]. 1.0 keeps
  // the legacy fill; values < 1.0 shrink every bar proportionally so
  // the histogram occupies a smaller fraction of the cat slot.
  const heightScale = Math.max(0.1, Math.min(1, opts.heightScale ?? 1));
  const maxBarExtent =
    Math.max(0, slotPx * (1 - rightSafePct) - insetMargin) * heightScale;
  const barExtent =
    catMaxCount > 0 ? (count / catMaxCount) * maxBarExtent : 0;

  let rectShape: { x: number; y: number; width: number; height: number };
  let labelX: number;
  let labelY: number;
  let labelAlign: "left" | "center";
  let labelBaseline: "middle" | "top" | "bottom";

  if (catIsX) {
    // Vertical slot (cat on X), bar grows rightward.
    // aCoord = (binCenter + binHalfH) → larger Y value → smaller pixel y (top)
    // bCoord = (binCenter - binHalfH) → smaller Y value → larger pixel y (bottom)
    const yTop = aCoord[1];
    const yBot = bCoord[1];
    const slotLeft = ctrCoord[0] - slotPx / 2 + insetMargin;
    // NOTE: we deliberately DO NOT clip yTop/yBot to coordSys bounds here.
    // The series sets `clip: true` (see option spec), so ECharts applies
    // its own clip-path to the series group — only the in-bounds portion
    // of the full bar is painted, while the bar's logical position and
    // size remain stable. An earlier in-renderItem clip resized the
    // rect (and shifted the label to the clipped midpoint), which made
    // edge bins visibly "jump" / "shrink" the moment the axis cut
    // through them. Letting ECharts clip the rendered output keeps the
    // visible portion identical to the corresponding slice of the full,
    // unclipped bar.
    if (yBot - yTop < 1) return null;
    rectShape = {
      x: slotLeft,
      y: yTop,
      width: barExtent,
      height: yBot - yTop,
    };
    labelX = slotLeft + barExtent + 2;
    labelY = (yTop + yBot) / 2;
    labelAlign = "left";
    labelBaseline = "middle";
  } else {
    // Horizontal slot (cat on Y, post-transpose). X is the value
    // axis here. Bar grows UPWARD from the BOTTOM edge of the cat
    // slot — i.e. anchored to the larger pixel-y (lower edge in
    // screen space). This mirrors the catIsX=true convention where
    // bars hug the axis-line edge of their slot; with X as the
    // value axis, the "natural" axis-adjacent edge of each cat slot
    // is the bottom one.
    //
    // aCoord = (binCenter + binHalfH) → larger value → larger pixel x (right)
    // bCoord = (binCenter - binHalfH) → smaller value → smaller pixel x (left)
    const xLeft = bCoord[0];
    const xRight = aCoord[0];
    const slotBot = ctrCoord[1] + slotPx / 2 - insetMargin;
    // See matching note in the `catIsX` branch above — we let
    // ECharts' own `clip: true` handle the coord-system clipping via
    // the series-group clip-path, so the rect's logical position and
    // width stay stable when the axis cuts through a bin. Resizing
    // the rect in renderItem made edge bins visibly "jump" and shifted
    // their labels to the clipped midpoint.
    if (xRight - xLeft < 1) return null;
    rectShape = {
      x: xLeft,
      y: slotBot - barExtent,
      width: xRight - xLeft,
      height: barExtent,
    };
    // Label sits just ABOVE the bar tip (the upper edge of the
    // upward-growing bar).
    labelX = (xLeft + xRight) / 2;
    labelY = slotBot - barExtent - 2;
    labelAlign = "center";
    labelBaseline = "bottom";
  }

  const rectEl = {
    type: "rect",
    shape: rectShape,
    style: {
      fill: opts.fillColor,
      stroke: opts.strokeColor,
      lineWidth: 0.5,
      // Slightly higher opacity since bars overlap (rather than sit
      // side-by-side) — JMP's grouped histograms read clearly at
      // ~50% alpha. Shadowgram layers pass a much lower override.
      opacity:
        opts.layerOpacity ?? (opts.grouping ? 0.5 : 0.55),
    },
  };

  if (!opts.showLabel || !(barExtent > 0)) return rectEl;

  // Compose count and/or percent text. Percent base is the group's
  // total within this category. Label always renders OUTSIDE the bar
  // tip — per UX request, never inside, to avoid mid-bar text clutter
  // and contrast issues against the translucent fill.
  const parts: string[] = [];
  if (opts.showCounts) parts.push(String(count));
  if (opts.showPercents) {
    const pct = groupTotal > 0 ? (count / groupTotal) * 100 : 0;
    parts.push(`${pct.toFixed(1)}%`);
  }
  const labelText = parts.join(" ");
  const textEl = {
    type: "text",
    style: {
      text: labelText,
      x: labelX,
      y: labelY,
      fill: opts.theme.fgPrimary,
      font: "10px sans-serif",
      textAlign: labelAlign,
      textVerticalAlign: labelBaseline,
    },
  };

  return { type: "group", children: [rectEl, textEl] };
}

// ---- Aggregate / interval helpers (used by per-element options) -----------

function getOpt<T>(opts: Record<string, unknown> | undefined, key: string, def: T): T {
  const v = opts?.[key];
  return v === undefined ? def : (v as T);
}

function _mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
}
function _median(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function _sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}
function _stddev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = _mean(xs);
  const v = xs.reduce((a, b) => a + (b - m) * (b - m), 0) / (xs.length - 1);
  return Math.sqrt(v);
}
function _stderr(xs: number[]): number {
  return xs.length < 2 ? 0 : _stddev(xs) / Math.sqrt(xs.length);
}
function aggregateY(ys: number[], stat: string): number {
  switch (stat) {
    case "median": return _median(ys);
    case "sum": return _sum(ys);
    case "mean": return _mean(ys);
    default: return _mean(ys);
  }
}
function intervalHalf(ys: number[], kind: string): number {
  if (!ys.length || ys.length < 2) return 0;
  switch (kind) {
    case "stdDev": return _stddev(ys);
    case "ci95": return 1.96 * _stderr(ys);
    case "stdErr":
    case "auto":
      return _stderr(ys);
    default: return 0;
  }
}

function findSummaryPacket(
  aggregatePackets: readonly GraphAggregatePacket[] | undefined,
  panelFacet?: PanelFacetContext,
): SummaryPacket | null {
  if (!aggregatePackets || aggregatePackets.length === 0) return null;
  const packet = aggregatePackets.find((candidate) => candidate.kind === "summary");
  if (!packet || packet.kind !== "summary") return null;
  if (!panelFacet) return packet;
  return {
    ...packet,
    summaries: packet.summaries.filter((entry) => matchesPanelFacet(entry, panelFacet)),
  };
}

function findBoxPlotPacket(
  aggregatePackets: readonly GraphAggregatePacket[] | undefined,
  panelFacet?: PanelFacetContext,
): BoxPlotPacket | null {
  if (!aggregatePackets || aggregatePackets.length === 0) return null;
  const packet = aggregatePackets.find((candidate) => candidate.kind === "boxPlot");
  if (!packet || packet.kind !== "boxPlot") return null;
  if (!panelFacet) return packet;
  return {
    ...packet,
    entries: packet.entries.filter((entry) => matchesPanelFacet(entry, panelFacet)),
  };
}

function findHistogramPacket(
  aggregatePackets: readonly GraphAggregatePacket[] | undefined,
  panelFacet?: PanelFacetContext,
): HistogramPacket | null {
  if (!aggregatePackets || aggregatePackets.length === 0) return null;
  const packet = aggregatePackets.find((candidate) => candidate.kind === "histogram");
  if (!packet || packet.kind !== "histogram") return null;
  if (!panelFacet) return packet;
  return {
    ...packet,
    bins: packet.bins.filter((entry) => matchesPanelFacet(entry, panelFacet)),
  };
}

function findHeatmapPacket(
  aggregatePackets: readonly GraphAggregatePacket[] | undefined,
  panelFacet?: PanelFacetContext,
): HeatmapPacket | null {
  if (!aggregatePackets || aggregatePackets.length === 0) return null;
  const packet = aggregatePackets.find((candidate) => candidate.kind === "heatmap");
  if (!packet || packet.kind !== "heatmap") return null;
  if (!panelFacet) return packet;
  return {
    ...packet,
    cells: packet.cells.filter((entry) => matchesPanelFacet(entry, panelFacet)),
  };
}

function findCorrelationMatrixPacket(
  aggregatePackets: readonly GraphAggregatePacket[] | undefined,
  _panelFacet?: PanelFacetContext,
): CorrelationMatrixPacket | null {
  if (!aggregatePackets || aggregatePackets.length === 0) return null;
  const packet = aggregatePackets.find((candidate) => candidate.kind === "correlationMatrix");
  if (!packet || packet.kind !== "correlationMatrix") return null;
  return packet;
}

function findPrecomputedPointPackets(
  aggregatePackets: readonly GraphAggregatePacket[] | undefined,
  elementId: string,
): PrecomputedPointPacket[] {
  if (!aggregatePackets || aggregatePackets.length === 0) return [];
  return aggregatePackets.filter((candidate): candidate is PrecomputedPointPacket =>
    candidate.kind === "precomputedPoints" && candidate.elementId === elementId,
  );
}

function findPrecomputedCurvePackets(
  aggregatePackets: readonly GraphAggregatePacket[] | undefined,
  elementId: string,
): PrecomputedCurvePacket[] {
  if (!aggregatePackets || aggregatePackets.length === 0) return [];
  return aggregatePackets.filter((candidate): candidate is PrecomputedCurvePacket =>
    candidate.kind === "precomputedCurve" && candidate.elementId === elementId,
  );
}

function buildPrecomputedPointSeries(
  packet: PrecomputedPointPacket,
  seriesName: string,
  style: ResolvedGroupStyle,
): Record<string, unknown> {
  const symbol = markerToSymbol(style.point.marker);
  return {
    id: packet.seriesId ?? packet.elementId,
    type: "scatter",
    name: packet.seriesName ?? seriesName,
    clip: true,
    symbol: symbol.symbol,
    symbolSize: style.point.size,
    itemStyle: pointItemStyle(style.point, symbol.hollow),
    data: packet.points.map((point) => [point.x, point.y]),
    progressive: 0,
    z: 5,
  };
}

function buildPrecomputedCurveSeries(
  packet: PrecomputedCurvePacket,
  seriesName: string,
  style: ResolvedGroupStyle,
): Record<string, unknown> {
  return {
    id: packet.seriesId ?? packet.elementId,
    type: "line",
    name: packet.seriesName ?? seriesName,
    clip: true,
    showSymbol: false,
    symbol: "none",
    smooth: false,
    step: packet.interpolation === "stepEnd" ? "end" : undefined,
    lineStyle: {
      color: style.line.color,
      width: style.line.width,
      opacity: style.line.opacity,
    },
    data: packet.points.map((point) => [point.x, point.y]),
    z: 3,
  };
}

function formatCorrelationCoefficient(value: number): string {
  if (!Number.isFinite(value)) return "";
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 }).format(value);
}

function fallbackCorrelationMethodLabel(method: string): string {
  switch (method) {
    case "pearson":
      return "Pearson";
    case "spearman":
      return "Spearman";
    case "kendall":
      return "Kendall";
    default:
      return method;
  }
}

function fallbackCorrelationUnavailableReasonLabel(reason: string): string {
  switch (reason) {
    case "insufficientData":
      return "Insufficient data";
    case "zeroVariance":
      return "Zero variance";
    default:
      return "Unknown";
  }
}

function tOr(key: string, fallback: string): string {
  const resolved = i18next.t(key);
  if (typeof resolved === "string" && resolved.trim().length > 0 && resolved !== key) return resolved;
  return fallback;
}

function buildCorrelationMatrixOption(
  packet: CorrelationMatrixPacket,
  theme: GraphTheme,
  axis: ReturnType<typeof buildAxisCommon>,
  aggregateMode: "legacyRows" | "frameBacked",
  spec: GraphSpec,
): EChartsOption {
  const { negative, neutral, positive, unavailable } = buildCorrelationDivergingPalette(theme);
  const columns = packet.columns.slice();
  const matrixSize = columns.length;
  const cellByIndex = new Map<string, { coefficient?: number | null; sampleCount: number; unavailableReason?: string }>();
  for (const cell of packet.cells) {
    cellByIndex.set(`${cell.xIndex}:${cell.yIndex}`, {
      coefficient: cell.coefficient,
      sampleCount: cell.sampleCount,
      unavailableReason: cell.unavailableReason,
    });
  }

  const data = [] as Array<Record<string, unknown>>;
  for (let yIndex = 0; yIndex < matrixSize; yIndex += 1) {
    for (let xIndex = 0; xIndex < matrixSize; xIndex += 1) {
      const xName = columns[xIndex] ?? "";
      const yName = columns[yIndex] ?? "";
      const entry = cellByIndex.get(`${xIndex}:${yIndex}`);
      const coeff = Number.isFinite(entry?.coefficient) ? Number(entry?.coefficient) : undefined;
      const unavailableReason = entry?.unavailableReason;
      const sampleCount = Number.isFinite(entry?.sampleCount) ? Number(entry?.sampleCount) : 0;
      const isDefined = Number.isFinite(coeff);

      data.push({
        value: [xIndex, yIndex, isDefined ? coeff : -2],
        xName,
        yName,
        coefficient: isDefined ? coeff : undefined,
        sampleCount,
        unavailableReason,
        label: isDefined
          ? {
            show: true,
            formatter: formatCorrelationCoefficient(coeff!),
            color: Math.abs(coeff!) >= 0.5 ? theme.bgCanvas : theme.fgPrimary,
            fontSize: 10,
          }
          : { show: false },
        ...(isDefined ? {} : { itemStyle: { color: unavailable } }),
      });
    }
  }

  const methodValueKey = `graph.opt.correlation.${packet.method}`;
  const methodLabel = tOr("graph.opt.correlationMethod", "Method");
  const methodName = tOr(methodValueKey, fallbackCorrelationMethodLabel(packet.method));
  const pairLabel = tOr("graph.correlation.pair", "Pair");
  const coefficientLabel = tOr("graph.correlation.coefficient", "Coefficient");
  const unavailableLabel = tOr("graph.correlation.unavailableLabel", "Unavailable");
  const sampleLabel = tOr("graph.correlation.sampleCount", "n");
  const unknownReasonLabel = tOr("graph.correlation.unavailableReason.unknown", "Unknown");

  return {
    backgroundColor: "transparent",
    textStyle: { color: theme.fgPrimary },
    animation: false,
    grid: {
      left: 88,
      right: 88,
      top: 64,
      bottom: 92,
      width: "70%",
      height: "70%",
      show: true,
      borderColor: theme.axisLine,
      borderWidth: 0.5,
      containLabel: true,
    },
    tooltip: {
      trigger: "item",
      confine: true,
      appendToBody: true,
      formatter: (params: any) => {
        const cell = params?.data ?? {};
        const xName = String(cell.xName ?? "");
        const yName = String(cell.yName ?? "");
        const coeffValue = Number(cell.coefficient);
        const n = Number.isFinite(Number(cell.sampleCount)) ? Number(cell.sampleCount) : 0;
        const unavailableReason = String(cell.unavailableReason ?? "unknown");
        const reasonKey = `graph.correlation.unavailableReason.${unavailableReason}`;
        const reasonLabel = tOr(
          reasonKey,
          unavailableReason === "unknown"
            ? unknownReasonLabel
            : fallbackCorrelationUnavailableReasonLabel(unavailableReason),
        );
        const coefficientLine = Number.isFinite(coeffValue)
          ? `${coefficientLabel}: ${formatCorrelationCoefficient(coeffValue)}`
          : `${unavailableLabel}: ${reasonLabel}`;
        return [
          `${pairLabel}: ${xName} × ${yName}`,
          `${methodLabel}: ${methodName}`,
          coefficientLine,
          `${sampleLabel}: ${n}`,
        ].join("<br/>");
      },
    },
    xAxis: mergeAxis(
      {
        type: "category",
        ...axis,
        data: columns,
        splitArea: { show: true },
        axisLabel: { ...axis.axisLabel, interval: 0, rotate: columns.length > 8 ? 45 : 0, showMinLabel: true, showMaxLabel: true },
      },
      buildAxisOverrides(spec.xAxis, aggregateMode),
    ),
    yAxis: mergeAxis(
      {
        type: "category",
        ...axis,
        data: columns,
        splitArea: { show: true },
        inverse: true,
        axisLabel: { ...axis.axisLabel, interval: 0, showMinLabel: true, showMaxLabel: true },
      },
      buildAxisOverrides(spec.yAxis, aggregateMode),
    ),
    visualMap: {
      min: -1,
      max: 1,
      calculable: false,
      orient: "horizontal",
      left: "center",
      bottom: 12,
      inRange: { color: [negative, neutral, positive] },
      textStyle: { color: theme.fgSecondary },
    },
    series: [
      {
        id: "__correlation_matrix",
        type: "heatmap",
        data,
        animation: false,
        progressive: 0,
        emphasis: { itemStyle: { shadowBlur: 0 } },
      },
    ],
  } as EChartsOption;
}

function summaryPointFromPacket(
  packet: SummaryPacket,
  xIsCategory: boolean,
  summaryStat: string,
  errorInterval: string,
  groupKey: string | null,
): Array<{ x: unknown; y: number; lo: number; hi: number }> {
  const rows = packet.summaries.filter((entry) => {
    if (groupKey == null) {
      return entry.group == null || entry.group === "";
    }
    return entry.group === groupKey;
  });
  const points = rows.map((entry) => {
    const y = summaryStat === "median"
      ? entry.median
      : summaryStat === "sum"
        ? entry.mean * entry.count
        : entry.mean;
    let half = 0;
    if (errorInterval === "stdDev") {
      half = entry.stddev;
    } else if (errorInterval === "ci95") {
      if (Number.isFinite(entry.intervalHigh ?? NaN) && Number.isFinite(entry.intervalLow ?? NaN)) {
        half = ((entry.intervalHigh ?? y) - (entry.intervalLow ?? y)) / 2;
      } else {
        half = entry.count > 1 ? 1.96 * (entry.stddev / Math.sqrt(entry.count)) : 0;
      }
    } else if (errorInterval === "stdErr" || errorInterval === "auto") {
      half = entry.count > 1 ? entry.stddev / Math.sqrt(entry.count) : 0;
    }

    const xValue = xIsCategory ? (entry.category ?? "") : toNum(entry.category);
    return { x: xValue, y, lo: y - half, hi: y + half };
  });
  if (!xIsCategory) {
    points.sort((left, right) => toNum(left.x) - toNum(right.x));
  }
  return points;
}

/** Build (x, y[, lo, hi]) per X group. Used by points/line summary modes. */
function aggregatePoints(
  rowIdxs: number[],
  data: GraphData,
  xIdx: number,
  yIdx: number,
  xIsCategory: boolean,
  summaryStat: string,
  errorInterval: string,
  summaryPacket?: SummaryPacket | null,
  groupKey?: string | null,
  requirePacket?: boolean,
): Array<{ x: unknown; y: number; lo: number; hi: number }> {
  if (summaryPacket) {
    const fromPacket = summaryPointFromPacket(
      summaryPacket,
      xIsCategory,
      summaryStat,
      errorInterval,
      groupKey ?? null,
    );
    if (fromPacket.length > 0) {
      return fromPacket;
    }
  }
  if (requirePacket) return [];

  const map = new Map<string, { xv: unknown; ys: number[] }>();
  for (const i of rowIdxs) {
    const xv = data.rows[i][xIdx];
    // Drop missing X up-front so blank cells don't all collapse into a
    // phantom "NaN" / "" bucket that plots near zero on a value axis.
    if (isMissing(xv)) continue;
    const yv = toNum(data.rows[i][yIdx]);
    if (!Number.isFinite(yv)) continue;
    const key = xIsCategory ? toStr(xv) : String(toNum(xv));
    const cur = map.get(key);
    if (cur) cur.ys.push(yv);
    else map.set(key, { xv, ys: [yv] });
  }
  const out = Array.from(map.values()).map(({ xv, ys }) => {
    const y = aggregateY(ys, summaryStat);
    const half = errorInterval === "none" ? 0 : intervalHalf(ys, errorInterval);
    return { x: xv, y, lo: y - half, hi: y + half };
  });
  if (!xIsCategory) {
    out.sort((a, b) => toNum(a.x) - toNum(b.x));
  }
  return out;
}

/** Render error bars / band as additional ECharts series. */
function buildIntervalSeries(
  agg: Array<{ x: unknown; y: number; lo: number; hi: number }>,
  xIsCategory: boolean,
  intervalStyle: string,
  color: string,
  seriesName: string,
): any[] {
  const hasInterval = agg.some((p) => p.hi !== p.lo);
  if (!hasInterval) return [];
  const xv = (p: { x: unknown }) => (xIsCategory ? toStr(p.x) : toNum(p.x));
  if (intervalStyle === "band") {
    // Low line + transparent stack to high; areaStyle fills between.
    return [
      {
        id: `${seriesName}__band_lo`,
        type: "line",
        name: `${seriesName} _lo`,
        stack: `band-${seriesName}`,
        data: agg.map((p) => [xv(p), p.lo]),
        lineStyle: { opacity: 0 },
        symbol: "none",
        animation: false,
        silent: true,
        z: 1,
        legendHoverLink: false,
      },
      {
        id: `${seriesName}__band_hi`,
        type: "line",
        name: `${seriesName} _hi`,
        stack: `band-${seriesName}`,
        data: agg.map((p) => [xv(p), p.hi - p.lo]),
        lineStyle: { opacity: 0 },
        symbol: "none",
        areaStyle: { color, opacity: 0.18 },
        animation: false,
        silent: true,
        z: 1,
        legendHoverLink: false,
      },
    ];
  }
  // Default: error bars via custom series
  return [
    {
      id: `${seriesName}__ci`,
      type: "custom",
      name: `${seriesName} CI`,
      // `series-custom.clip` defaults to FALSE — without this, error
      // bars near the edge stay visible past the axis line during
      // drag-zoom / drag-pan (only the next full setOption pass
      // re-runs renderItem and applies the in-renderItem clip),
      // while standard series like scatter clip live. Enabling
      // ECharts' own clip path on the series group keeps the
      // visible region consistent on every frame.
      clip: true,
      renderItem(_params: any, api: any) {
        const x = api.coord([api.value(0), api.value(1)])[0];
        const yLo = api.coord([api.value(0), api.value(2)])[1];
        const yHi = api.coord([api.value(0), api.value(3)])[1];
        const cap = 4;
        return {
          type: "group",
          children: [
            {
              type: "line",
              shape: { x1: x, y1: yLo, x2: x, y2: yHi },
              style: { stroke: color, lineWidth: 1.5 },
            },
            {
              type: "line",
              shape: { x1: x - cap, y1: yLo, x2: x + cap, y2: yLo },
              style: { stroke: color, lineWidth: 1.5 },
            },
            {
              type: "line",
              shape: { x1: x - cap, y1: yHi, x2: x + cap, y2: yHi },
              style: { stroke: color, lineWidth: 1.5 },
            },
          ],
        };
      },
      encode: { x: 0, y: [2, 3] },
      data: agg.map((p) => [xv(p), p.y, p.lo, p.hi]),
      // Disable transition; animated interpolation can leave the bars
      // stranded a frame behind the matching summary dot during option
      // updates, producing apparent misalignment until the next resize.
      animation: false,
      progressive: 0,
      z: 3,
      silent: true,
      legendHoverLink: false,
    },
  ];
}

/** 构建一个简单的「分面」标题
 *
 *  Encoded as "<X-field>=<X-val> | <Y-field>=<Y-val>" so the user can read
 *  both facet axes off a panel header when a Trellis grid is active.
 *  Either key may be null when only one facet axis is bound. */
function facetTitle(
  xKey: string | null,
  yKey: string | null,
  encoding: GraphSpec["encoding"],
): string {
  const parts: string[] = [];
  if (encoding.groupX && xKey !== null) parts.push(`${encoding.groupX.name}=${xKey}`);
  if (encoding.groupY && yKey !== null) parts.push(`${encoding.groupY.name}=${yKey}`);
  return parts.join(" | ");
}

/** Shared axis ranges computed across the FULL faceted dataset.
 *
 *  When `buildGraph` splits data into multiple panels, each panel's
 *  subset has its own min/max — left unconstrained, ECharts auto-scales
 *  each axis independently, so the same numeric value lands at different
 *  pixel heights across panels. That makes side-by-side comparison
 *  visually misleading (the exact failure mode the user called out:
 *  "严重的判断失误"). The faceted caller therefore pre-computes the
 *  global bounds once over the full dataset and forwards them here so
 *  every panel pins its axes to the same range. */
interface SharedAxisRanges {
  /** Forced numeric min/max for the X axis (value or time type). */
  xMin?: number;
  xMax?: number;
  /** Nice-snapped tick interval matching xMin/xMax for VALUE-type X
   *  axes (continuous numeric X — scatter / line / bar paths with a
   *  quantitative X binding). Lets every faceted panel render the
   *  same tick density even when local data ranges differ. Absent
   *  for category / time axes (those don't go through the nice-fit
   *  helper) and absent when no nice fit was produced. */
  xInterval?: number;
  /** Union of all X categories across panels — used when xAxis.type ===
   *  "category" so missing categories still occupy the same slot on each
   *  panel's axis. */
  xCats?: string[];
  /** Forced numeric min/max for the Y axis (always value type). */
  yMin?: number;
  yMax?: number;
  /** Nice-snapped tick interval matching yMin/yMax — emitted by
   *  computeSharedRanges so every faceted panel uses the same tick
   *  spacing (otherwise ECharts could re-pick density per panel even
   *  with identical bounds). Absent when no nice fit was produced. */
  yInterval?: number;
  /** Union of all Y categories across panels — populated when Y is
   *  bound to a nominal/ordinal/id column (horizontal-mode chart). In
   *  the vertical orientation Y is always a value axis and this stays
   *  undefined. Mirrors `xCats` and gets routed to `xCats` of the
   *  swapped recursive call via `swapSharedRanges` so every faceted
   *  horizontal panel renders with the same Y category list. */
  yCats?: string[];
}

/** Map our `RefLineStyle` enum to ECharts' `lineStyle.type`. */
function refDashFor(style: RefLineStyle): "solid" | "dashed" | "dotted" {
  if (style === "dashed") return "dashed";
  if (style === "dotted") return "dotted";
  return "solid";
}

/** Build an invisible scatter "carrier" series whose only job is to host
 *  user-defined Y-axis `markLine`s. We attach the markLines to a series
 *  that has no data points so they always render regardless of which
 *  data elements (points / line / boxplot …) the user has enabled or
 *  hidden. Returns null when no reference lines are configured so we
 *  avoid emitting a noise series.
 *
 *  Auto spec-limit overlay: when `autoSpec` is non-null we append up to
 *  three more markLines (LSL / Target / USL) with hardcoded red /
 *  green / red coloring. These are merged into the SAME carrier so the
 *  chart only ends up with one extra series no matter how many sources
 *  contribute lines, and so a future tooltip / hover handler only has
 *  one place to look. The auto lines are NOT folded back into the
 *  user-editable `refLinesY` list — they're an ambient, data-driven
 *  overlay that the user toggles globally via the Reference Lines
 *  editor checkbox.
 *
 *  Note: ECharts' markLine reads `data[i].yAxis` for a horizontal line;
 *  `name` becomes the label text, and `lineStyle` / `label` override the
 *  appearance. The `silent: true` flag prevents the markLine from
 *  participating in tooltips or hover halos, which would distract from
 *  the data series. */
/** Orientation-agnostic snapshot of one reference line. `RefLineY` and
 *  `RefLineX` are normalized to this shape at the call boundary so
 *  `buildRefLinesCarrier` can emit either a horizontal markLine
 *  (`yAxis: value`) or a vertical markLine (`xAxis: value`) from a
 *  single code path — only the markLine field name flips with `axis`.
 *  Keeping a single carrier keeps the rendered series count low and
 *  centralizes the dash / label / color rendering logic. */
interface RefLineNorm {
  id: string;
  value: number;
  label: string;
  style: RefLineStyle;
  color: string;
  width: number;
}

function normalizeRefLinesY(arr: RefLineY[] | undefined): RefLineNorm[] {
  return (arr ?? []).map((r) => ({
    id: r.id,
    value: r.y,
    label: r.label,
    style: r.style,
    color: r.color,
    width: r.width,
  }));
}

function normalizeRefLinesX(arr: RefLineX[] | undefined): RefLineNorm[] {
  return (arr ?? []).map((r) => ({
    id: r.id,
    value: r.x,
    label: r.label,
    style: r.style,
    color: r.color,
    width: r.width,
  }));
}

function buildRefLinesCarrier(
  refLines: RefLineNorm[],
  autoSpec: AutoSpec | undefined,
  theme: GraphTheme,
  axis: "x" | "y",
): any | null {
  const userValid = refLines.filter((r) => Number.isFinite(r.value));
  // Auto-spec entries are pre-resolved per axis by the caller (it passes
  // `spec.autoSpecY` for the Y carrier and `spec.autoSpecX` for the X
  // carrier). Pass `axis` through so the helper emits the right
  // markLine field (`yAxis` → horizontal line, `xAxis` → vertical
  // line) and matches the user-line label-position convention below.
  const autoEntries = buildAutoSpecMarkLineData(autoSpec, axis);
  if (userValid.length === 0 && autoEntries.length === 0) return null;
  const axisField = axis === "y" ? "yAxis" : "xAxis";
  // Position the label so it sits inside the chart area at the
  // *near* end of the line: top for horizontal (Y) lines and left for
  // vertical (X) lines. ECharts' positional vocabulary uses
  // "insideEndTop" for horizontal lines (the line runs left→right, so
  // the "end" of the run is the right edge) and "insideStartTop" for
  // vertical lines (which run top→bottom, so the "start" is the top
  // edge). Picking these so X-axis lines stay readable when several
  // are stacked along the bottom of the plot.
  const labelPosition = axis === "y" ? "insideEndTop" : "insideStartTop";
  return {
    id: axis === "y" ? "__ref_lines_y__" : "__ref_lines_x__",
    type: "scatter",
    name: "",
    data: [],
    // Keep this series out of the legend the renderer might one day
    // surface (we already disable the in-chart legend, but this is
    // defensive in case that changes).
    legendHoverLink: false,
    silent: true,
    z: 5,
    markLine: {
      symbol: ["none", "none"],
      silent: true,
      animation: false,
      // Per-line styling is encoded into each data entry via `lineStyle`
      // and `label`; the series-level defaults below are just fallbacks.
      label: {
        show: true,
        position: labelPosition,
        color: theme.fgPrimary,
        fontSize: 11,
      },
      lineStyle: { color: theme.fgPrimary, width: 1, type: "dashed" },
      data: [
        ...userValid.map((r) => {
          const hasLabel = r.label != null && r.label !== "";
          return {
            [axisField]: r.value,
            name: r.label || "",
            lineStyle: {
              color: r.color,
              width: r.width,
              type: refDashFor(r.style),
            },
            label: {
              show: hasLabel,
              position: labelPosition,
              formatter: r.label || "",
              color: r.color,
              fontSize: 11,
            },
          };
        }),
        ...autoEntries,
      ],
    },
  };
}

/** Hardcoded colors for auto spec-limit lines. Saturated red for the
 *  pass/fail boundary (LSL / USL) and a vivid green for the target,
 *  picked to read clearly against both light- and dark-theme grids
 *  without colliding with any data-series color in our muted
 *  categorical palette. */
const AUTO_SPEC_LIMIT_COLOR = "#E60000";
const AUTO_SPEC_TARGET_COLOR = "#00C853";

/** Translate an `AutoSpec` into ECharts markLine data entries. Skips
 *  any limit whose value isn't a finite number so a partially-filled
 *  spec (e.g. only USL set) only emits the lines it can.
 *
 *  `axis` controls orientation:
 *    - `"y"` → emits horizontal lines (`yAxis: value`) with the label
 *      pinned to the right edge (`insideEndTop`).
 *    - `"x"` → emits vertical lines (`xAxis: value`) with the label
 *      pinned to the top-left (`insideStartTop`).
 *  Same convention used for user-defined ref lines in
 *  `buildRefLinesCarrier`, so both kinds of lines look identical
 *  along the same axis. */
function buildAutoSpecMarkLineData(autoSpec: AutoSpec | undefined, axis: "x" | "y"): any[] {
  if (!autoSpec) return [];
  const out: any[] = [];
  const axisField = axis === "y" ? "yAxis" : "xAxis";
  const labelPosition = axis === "y" ? "insideEndTop" : "insideStartTop";
  const push = (v: number | undefined, label: string, color: string) => {
    if (!Number.isFinite(v as number)) return;
    // Append the numeric value to the label so the user can read the
    // spec limit at a glance without hunting for a tooltip. Round to
    // 10 significant digits to suppress IEEE-754 noise like
    // `4.2228965400000001` while still preserving the natural
    // representation of clean spec values (e.g. 4.5 stays "4.5").
    const text = `${label} = ${Number((v as number).toPrecision(10)).toString()}`;
    out.push({
      [axisField]: v,
      name: label,
      lineStyle: { color, width: 1, type: "dashed" },
      label: {
        show: true,
        position: labelPosition,
        formatter: text,
        color,
        fontSize: 11,
      },
    });
  };
  // Render in LSL → Target → USL order so when limits sit close
  // together the labels stack in a predictable sequence (vertical for
  // horizontal lines, horizontal for vertical lines).
  push(autoSpec.lsl, "LSL", AUTO_SPEC_LIMIT_COLOR);
  push(autoSpec.target, "Target", AUTO_SPEC_TARGET_COLOR);
  push(autoSpec.usl, "USL", AUTO_SPEC_LIMIT_COLOR);
  return out;
}

/** Half-width of each category band, in fractional category-index
 *  units. ECharts category axes with `boundaryGap: true` (the default
 *  used for non-time category axes throughout this renderer) place
 *  category N at the integer index N and extend its band ±0.5 around
 *  that center. We pull the segment endpoints in by a small gap so
 *  adjacent bands don't visually touch — at 0.45 each band's spec
 *  line spans 90 % of its slot width, leaving a 10 % gutter between
 *  neighbors that mirrors the inter-category gap used by the
 *  scatter / box renderers. */
const BAND_REF_HALF_WIDTH = 0.45;

/** Stable id prefix shared by the X-anchored and Y-anchored band
 *  carriers. Used by `transposeSeriesData` to spot the carrier and
 *  apply the dim-flip needed when the outer transpose swaps axes
 *  (custom series data is otherwise pass-through). */
const BAND_REF_CARRIER_ID_PREFIX = "__band_ref_lines_";

/** Build a `custom` series that draws per-category reference-line
 *  segments. Each `BandRefLine` becomes one line primitive whose
 *  extent on the OPPOSITE axis is exactly one category band wide
 *  (scaled by `BAND_REF_HALF_WIDTH × 2`).
 *
 *  Why `custom` instead of `markLine` with fractional `coord`
 *  indices: ECharts category axes interpret numeric `coord` values
 *  as data-values to look up by name (e.g. `coord: [0.55, val]`
 *  searches the category list for a literal entry named "0.55",
 *  finds none, and silently drops the line). The only reliable way
 *  to position a marker BETWEEN two category centers is via
 *  pixel-space arithmetic in a `renderItem`, mirroring the
 *  error-bar custom-series pattern used elsewhere in this file.
 *
 *  Data layout per row: `[dim0, dim1, color, width, dashType, "h"|"v"]`.
 *  Dim 0 / dim 1 are the (X-value, Y-value) pair fed into `api.coord`;
 *  the 6th column encodes which axis the segment runs along so
 *  `transposeSeriesData` can flip both the dim order AND the
 *  orientation flag together when the outer pipeline transposes
 *  axes. With the flag readable inside `renderItem`, the carrier
 *  needs no closure state and survives the transpose unchanged.
 *
 *  Returns `null` when nothing emits so callers can use a simple
 *  `if (carrier) series.push(carrier)` pattern. */
function buildBandRefLinesCarrier(
  bandLines: BandRefLine[] | undefined,
  cats: string[],
  valueAxisFilter: "x" | "y",
  aggregateMode: "legacyRows" | "frameBacked",
  _theme: GraphTheme,
): any | null {
  if (!bandLines || bandLines.length === 0) return null;
  if (!cats || cats.length === 0) return null;
  const catSet = new Set(cats);
  const rows: any[] = [];
  for (const ln of bandLines) {
    if (ln.valueAxis !== valueAxisFilter) continue;
    if (!Number.isFinite(ln.value)) continue;
    if (!catSet.has(ln.category)) continue;
    const dash = refDashFor(ln.style);
    if (valueAxisFilter === "y") {
      // Horizontal segment, cat axis is X. Dim 0 = catName (→ X),
      // dim 1 = value (→ Y). Orientation flag "h" so the renderItem
      // knows to draw a horizontal line and pull band width from
      // api.size([1, 0])[0].
      rows.push([ln.category, ln.value, ln.color, ln.width, dash, "h"]);
    } else if (aggregateMode === "legacyRows") {
      // Vertical segment, cat axis is Y. Dim 0 = value (→ X),
      // dim 1 = catName (→ Y). Orientation flag "v".
      rows.push([ln.value, ln.category, ln.color, ln.width, dash, "v"]);
    }
  }
  if (rows.length === 0) return null;
  return {
    id: `${BAND_REF_CARRIER_ID_PREFIX}${valueAxisFilter}`,
    type: "custom",
    name: "",
    legendHoverLink: false,
    silent: true,
    z: 5,
    animation: false,
    progressive: 0,
    // See note on the CI custom series above — custom series default
    // is `clip: false`, so band reference lines would spill past the
    // axis during drag without this.
    clip: true,
    encode: { x: 0, y: 1 },
    renderItem(_params: any, api: any) {
      const d0 = api.value(0);
      const d1 = api.value(1);
      const center = api.coord([d0, d1]);
      const color = api.value(2) as string;
      const width = api.value(3) as number;
      const dashType = api.value(4) as "solid" | "dashed" | "dotted";
      const orientation = api.value(5) as "h" | "v";
      const lineDash =
        dashType === "dashed" ? [6, 4] : dashType === "dotted" ? [2, 3] : undefined;
      let shape: any;
      if (orientation === "h") {
        // api.size([1, 0]) returns the pixel size of one unit on each
        // axis at the current zoom level. For a category axis, one
        // unit = one band's width; we pull the X-pixel size since the
        // cat axis is X in this orientation.
        const halfBand = api.size([1, 0])[0] * BAND_REF_HALF_WIDTH;
        shape = {
          x1: center[0] - halfBand,
          y1: center[1],
          x2: center[0] + halfBand,
          y2: center[1],
        };
      } else {
        const halfBand = api.size([0, 1])[1] * BAND_REF_HALF_WIDTH;
        shape = {
          x1: center[0],
          y1: center[1] - halfBand,
          x2: center[0],
          y2: center[1] + halfBand,
        };
      }
      return {
        type: "line",
        shape,
        style: {
          stroke: color,
          lineWidth: width,
          ...(lineDash ? { lineDash } : {}),
        },
      };
    },
    data: rows,
  };
}

/** Collect every finite reference-line Y value contributed by the
 *  user-defined `refLinesY` list and the auto-spec overlay. Used by
 *  the Y-axis auto-scale logic to guarantee that every ref line stays
 *  visible — without this, a spec limit drawn well outside the data
 *  range (e.g. USL at 120 when the column maxes out at 95) would be
 *  clipped against the auto-fitted axis and the user wouldn't see
 *  whether their data is even close to the limit. Returns an empty
 *  array when no ref lines are configured. */
function collectRefLineYs(spec: GraphSpec): number[] {
  const out: number[] = [];
  for (const r of spec.refLinesY ?? []) {
    if (Number.isFinite(r.y)) out.push(r.y);
  }
  const a = spec.autoSpecY;
  if (a) {
    if (Number.isFinite(a.lsl as number)) out.push(a.lsl as number);
    if (Number.isFinite(a.target as number)) out.push(a.target as number);
    if (Number.isFinite(a.usl as number)) out.push(a.usl as number);
  }
  // Band ref lines anchored to the Y axis still need to influence
  // the Y auto-fit even though they only span one category band on
  // X — otherwise a per-column USL above the data extent would be
  // clipped by the auto-scaled Y range and the user wouldn't see
  // their data hitting (or missing) the limit.
  for (const ln of spec.bandRefLines ?? []) {
    if (ln.valueAxis === "y" && Number.isFinite(ln.value)) out.push(ln.value);
  }
  return out;
}

/** Collect every finite reference-line X value contributed by the
 *  user-defined `refLinesX` list AND the auto spec-limit overlay
 *  resolved for the X column (`spec.autoSpecX`). Mirrors
 *  `collectRefLineYs`. Used by the X-axis auto-scale logic so a
 *  vertical reference line drawn outside the data extent (e.g. a
 *  spec limit at X = 120 when the column maxes out at 95) is still
 *  rendered inside the visible chart area. */
function collectRefLineXs(spec: GraphSpec): number[] {
  const out: number[] = [];
  for (const r of spec.refLinesX ?? []) {
    if (Number.isFinite(r.x)) out.push(r.x);
  }
  const a = spec.autoSpecX;
  if (a) {
    if (Number.isFinite(a.lsl as number)) out.push(a.lsl as number);
    if (Number.isFinite(a.target as number)) out.push(a.target as number);
    if (Number.isFinite(a.usl as number)) out.push(a.usl as number);
  }
  // Symmetric to `collectRefLineYs`: include band ref lines anchored
  // to the X axis so the X auto-fit still pads out to keep them in
  // view even though they only span one Y-category band.
  for (const ln of spec.bandRefLines ?? []) {
    if (ln.valueAxis === "x" && Number.isFinite(ln.value)) out.push(ln.value);
  }
  return out;
}

/** Snap a continuous range to a clean tick step from the
 *  {1, 2, 2.5, 5, 10} × 10^k family. Classic "nice numbers for graph
 *  labels" (Heckbert 1990): pick a base power of ten from the rough
 *  step, then promote the fractional multiplier to a preferred set
 *  so a data range like [4.22, 4.59] resolves to ticks at 4.20 /
 *  4.25 / 4.30 / … instead of float-precision artifacts. */
function niceStep(range: number, targetTicks: number): number {
  if (!Number.isFinite(range) || range <= 0 || targetTicks <= 0) return 1;
  const rough = range / targetTicks;
  const exp = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm = rough / exp;
  // Ladder MUST match ECharts' internal `nice(val, round=true)` exactly
  // (echarts/src/scale/helper.ts) so the major step we use for the
  // histogram bin grid coincides with whatever ECharts auto-picks for
  // the axis major ticks. ECharts uses {1, 2, 3, 5, 10} with break
  // points {1.5, 2.5, 4, 7}; using a different ladder here (e.g.
  // {1, 2, 2.5, 5, 10}) lets the bin grid pick 0.02 while ECharts
  // picks 0.03 for the same range — bars then never align with the
  // visible tick lines. Keep this in lock-step with the upstream
  // implementation; if ECharts changes its ladder, mirror it here.
  let nice: number;
  if (norm < 1.5) nice = 1;
  else if (norm < 2.5) nice = 2;
  else if (norm < 4) nice = 3;
  else if (norm < 7) nice = 5;
  else nice = 10;
  return nice * exp;
}

/** Compute a nice-snapped {min, max, interval} for a value axis from
 *  optional data extent plus any reference values that must stay
 *  visible (e.g. user / spec ref-line Ys on the Y axis). Axis-agnostic:
 *  callers pass the data range and any reference values, get back a
 *  fit that snaps to the {1, 2, 3, 5, 10} × 10^k tick family (matches
 *  ECharts' internal `nice(round=true)` ladder so our snapped bounds
 *  fall on whatever interval ECharts auto-picks for the axis).
 *  Returns null when there's nothing to fit (no data and no refs) so
 *  the caller can fall back to ECharts' auto-scale. A 2 % visual pad
 *  is applied BEFORE the snap so a reference value sitting at the
 *  exact data edge isn't flush against the axis frame.
 *
 *  Why static instead of the older callback approach: passing
 *  `min`/`max` as functions to ECharts pinned the axis to raw float
 *  values, which then showed at the canvas edges as labels like
 *  "4.2228965400000001". Pre-snapping gives clean tick labels and
 *  also lets us emit a matching `interval` for predictable density.
 *
 *  Used for BOTH axes — Y (with refLinesY folded in) and value-type
 *  X (no ref lines today, so callers pass `refs: []`). Keep this
 *  function axis-neutral; if X ever grows ref lines, just pipe them
 *  in through the same `refs` argument. */
function computeNiceBounds(
  dataMin: number | undefined,
  dataMax: number | undefined,
  refs: number[],
  targetTicks: number,
): { min: number; max: number; interval: number } | null {
  const all: number[] = [];
  if (Number.isFinite(dataMin)) all.push(dataMin as number);
  if (Number.isFinite(dataMax)) all.push(dataMax as number);
  for (const y of refs) if (Number.isFinite(y)) all.push(y);
  if (all.length === 0) return null;
  let lo = Math.min(...all);
  let hi = Math.max(...all);
  if (lo === hi) {
    // Degenerate single-point range — fan out symmetrically so
    // niceStep doesn't divide by zero and the axis still shows ticks
    // above/below the point.
    const d = Math.abs(lo) * 0.05 || 1;
    lo -= d;
    hi += d;
  }
  const pad = (hi - lo) * 0.02;
  lo -= pad;
  hi += pad;
  const interval = niceStep(hi - lo, targetTicks);
  return {
    min: Math.floor(lo / interval) * interval,
    max: Math.ceil(hi / interval) * interval,
    interval,
  };
}

/** Build a Y-axis option fragment that expands the auto-fitted range
 *  to encompass every finite ref-line Y value. Returns `{}` when
 *  there's nothing to expand for, so the caller can spread it
 *  unconditionally without disturbing the default behavior.
 *
 *  Implementation: ECharts' `min` / `max` accept a function callback
 *  that receives the data-derived `{min, max}` and returns the final
 *  bound. We take min/max of the data extent unioned with the ref Ys,
 *  then add a small (2 %) pad matching `computeSharedRanges`'s padding
 *  so the line never sits flush against the axis edge.
 *
 *  Callsite contract: the caller spreads any `sharedRanges` /
 *  user-pinned `min` / `max` AFTER this fragment so explicit bounds
 *  always win — this fragment only contributes to the truly-auto path.
 *
 *  Kept for the histogram path; the main (boxplot/scatter/line/bar)
 *  path uses `computeNiceBounds` for snapped tick labels. */
function buildYAxisRefLineExpand(refYs: number[]): EChartsOption {
  if (refYs.length === 0) return {};
  const expand = (v: { min: number; max: number }, dir: "min" | "max"): number => {
    const m = Math.min(v.min, ...refYs);
    const M = Math.max(v.max, ...refYs);
    // Match computeSharedRanges' pad heuristic so the visual feel is
    // identical whether the range was computed up-front (faceted) or
    // resolved via this callback (single panel).
    const span = M - m || Math.abs(dir === "min" ? m : M) * 0.02 || 1;
    return dir === "min" ? m - span * 0.02 : M + span * 0.02;
  };
  return {
    min: (v: { min: number; max: number }) => expand(v, "min"),
    max: (v: { min: number; max: number }) => expand(v, "max"),
  };
}

/** Build the ECharts xAxis-option fragment that expands the auto-fit
 *  range to keep every X-axis reference line inside the visible area.
 *  Mirrors `buildYAxisRefLineExpand` — used by the histogram path
 *  (and any future X-value path that goes through the auto-callback
 *  range) so a vertical spec limit at X = 120 stays on-screen when
 *  the data tops out at 95. */
function buildXAxisRefLineExpand(refXs: number[]): EChartsOption {
  if (refXs.length === 0) return {};
  const expand = (v: { min: number; max: number }, dir: "min" | "max"): number => {
    const m = Math.min(v.min, ...refXs);
    const M = Math.max(v.max, ...refXs);
    const span = M - m || Math.abs(dir === "min" ? m : M) * 0.02 || 1;
    return dir === "min" ? m - span * 0.02 : M + span * 0.02;
  };
  return {
    min: (v: { min: number; max: number }) => expand(v, "min"),
    max: (v: { min: number; max: number }) => expand(v, "max"),
  };
}

/** Build the ECharts yAxis-option fragment that materializes a
 *  user-defined `YAxisConfig`. Returns `{}` when no overrides are set
 *  so the caller can spread it unconditionally without changing the
 *  auto-scaled default. Only emits keys for fields the user has
 *  actually pinned — undefined fields stay auto.
 *
 *  Notes on `scale`: when the user pins `min` or `max` we drop ECharts'
 *  `scale: true` because it's incompatible with explicit bounds (ECharts
 *  would expand them outward). Leaving `scale` to the caller means our
 *  fragment only adds behavior, never silently removes it. */
/** Build an ECharts axis-option fragment that materializes a user-defined
 *  `YAxisConfig`. Axis-agnostic — used for BOTH the Y axis and the
 *  primary X axis (the X dialog reuses the same config type). Returns
 *  `{}` when no overrides are set so the caller can spread it
 *  unconditionally without changing the auto-scaled default. Only
 *  emits keys for fields the user has actually pinned — undefined
 *  fields stay auto.
 *
 *  Numeric bounds (`min` / `max`) have an effect on ALL axis types —
 *  ECharts accepts numeric-index min/max on category axes to control the
 *  visible window (this is how smooth pan/zoom on category axes works).
 *  `interval` (tick-step) is numeric-only; ECharts ignores it on category
 *  and time axes, so emitting it unconditionally is safe. The decimal
 *  formatter passes string axis values (category labels) through
 *  unchanged so we never corrupt category fallbacks.
 *
 *  Notes on `scale`: when the user pins `min` or `max` we drop ECharts'
 *  `scale: true` because it's incompatible with explicit bounds (ECharts
 *  would expand them outward). Leaving `scale` to the caller means our
 *  fragment only adds behavior, never silently removes it. */
function buildAxisOverrides(
  cfg: YAxisConfig | undefined,
  aggregateMode: "legacyRows" | "frameBacked",
): EChartsOption {
  if (!cfg) return {};
  const out: EChartsOption = {};
  if (Number.isFinite(cfg.min as number)) out.min = cfg.min;
  if (Number.isFinite(cfg.max as number)) out.max = cfg.max;
  // Tick increment: ECharts' `interval` is the exact value distance
  // between adjacent major ticks. Floats are allowed (e.g. 0.5 ticks
  // every half unit). We guard against non-positive values, which
  // would either crash ECharts or produce an infinite tick loop.
  //
  // Only emit `interval` when the user has explicitly pinned one in
  // the dialog. When the user only pins min/max (e.g. via the drag
  // gesture), we deliberately leave interval AUTO so ECharts picks a
  // nice step that lands on round values within the new range. This
  // is what keeps drag-zoom smooth (no snap-to-grid needed) AND the
  // tick labels clean (0.1, 0.2, 0.3 … not 0.12, 0.22, 0.32 …) at
  // every cursor position.
  if (Number.isFinite(cfg.tickInterval as number) && (cfg.tickInterval as number) > 0) {
    out.interval = cfg.tickInterval;
  }
  if (cfg.inverse === true) out.inverse = true;
  // Decimal precision: format every numeric tick with the requested
  // number of decimal places. Strings (rare on a value axis) pass
  // through unchanged so we don't corrupt category fallbacks.
  if (Number.isFinite(cfg.decimals as number) && (cfg.decimals as number) >= 0) {
    const d = Math.max(0, Math.round(cfg.decimals as number));
    out.axisLabel = {
      formatter: (v: number | string) => (typeof v === "number" ? v.toFixed(d) : String(v)),
    };
  }
  // When the user explicitly pins a bound, disable ECharts' `scale: true`
  // so the pinned value isn't padded outward. The caller spreads our
  // overrides AFTER its own defaults, so setting `scale: false` here
  // correctly overrides the upstream `scale: true`.
  if (out.min !== undefined || out.max !== undefined) {
    out.scale = false;
  }

  // ----- Axis boundary line + tick orientation ------------------------
  // The single "Show axis line & ticks" checkbox in the dialog flips
  // both the axis boundary line and the tick marks together: if either
  // is hidden the user loses the visual frame, so we keep them as one
  // toggle in the UI and mirror that here. axisTick.inside (tick
  // position) still rides on top of show==true.
  if (cfg.showAxisLine !== undefined) {
    out.axisLine = { show: cfg.showAxisLine };
    out.axisTick = { show: cfg.showAxisLine };
  }
  // Tick position is only meaningful when ticks are visible — ECharts
  // ignores `axisTick.inside` quietly if the line is hidden, so emitting
  // it unconditionally is harmless. We still gate on the user actually
  // selecting a non-default value to keep the option object minimal.
  if (cfg.tickPosition === "inside") {
    out.axisTick = { ...(out.axisTick as object | undefined), inside: true };
  } else if (cfg.tickPosition === "outside") {
    out.axisTick = { ...(out.axisTick as object | undefined), inside: false };
  }

  // ----- Minor ticks --------------------------------------------------
  // The user-facing input means "how many visible minor tick marks sit
  // between two adjacent major ticks". ECharts' `minorTick.splitNumber`
  // is the number of *segments* the major interval is divided into,
  // which renders splitNumber-1 visible minor ticks (the endpoints are
  // already the majors). So we translate by adding 1, e.g. user N=2
  // yields splitNumber=3 → exactly 2 minor ticks visible.
  //
  // Tri-state contract (matters because the base axis now defaults
  // minor ticks ON via AUTO_MINOR_SPLIT — see `buildSingleOption`):
  //   undefined  → no override, base auto-default wins
  //   0          → user explicitly OFF, override the base default
  //   > 0        → user explicitly N visible minors
  if (cfg.minorTickCount !== undefined && Number.isFinite(cfg.minorTickCount as number)) {
    const n = cfg.minorTickCount as number;
    if (n > 0) {
      const visible = Math.max(1, Math.round(n));
      out.minorTick = {
        show: true,
        splitNumber: visible + 1,
      };
    } else if (aggregateMode === "legacyRows") {
      // Explicit 0 → suppress minor ticks (and minor gridlines via
      // the `hasMinorTicks` gate below).
      out.minorTick = { show: false };
    }
  }

  // ----- Major / minor split lines (grid) -----------------------------
  // Each branch only emits when the user has touched the toggle or
  // styled the lines, so completely-unset configs preserve the theme's
  // splitLine default (both major and minor hidden — opt-in via the
  // Tick Grid editor).
  if (cfg.showMajorGrid !== undefined || cfg.majorGridStyle) {
    out.splitLine = buildGridLineFragment(cfg.showMajorGrid, cfg.majorGridStyle);
  }
  // Minor gridlines additionally REQUIRE at least one minor tick.
  // ECharts decouples `minorSplitLine.show` from `minorTick.show` and
  // will happily render minor gridlines at its built-in default of 5
  // sub-segments per major tick whenever `minorSplitLine.show: true`
  // — even with `minorTick.show: false`. That produces the confusing
  // "minor gridlines without minor ticks" state the editor's hint
  // explicitly warns against. Mirror that contract here.
  //
  // Tri-state matches the minor-tick block above (the base axis now
  // auto-enables minor ticks via AUTO_MINOR_SPLIT, so undefined is
  // also "on"):
  //   undefined → auto minor ticks present → gridlines allowed
  //   0         → user explicit off → gridlines suppressed
  //   > 0       → user explicit on → gridlines allowed
  const minorOff =
    Number.isFinite(cfg.minorTickCount as number) &&
    (cfg.minorTickCount as number) === 0;
  const hasMinorTicks = !minorOff;
  if (hasMinorTicks && (cfg.showMinorGrid !== undefined || cfg.minorGridStyle)) {
    out.minorSplitLine = buildGridLineFragment(cfg.showMinorGrid, cfg.minorGridStyle);
  }

  return out;
}

/** Translate a (show, style) pair into an ECharts `splitLine`-shaped
 *  fragment. When `show` is undefined the fragment omits the `show`
 *  field so the caller's upstream defaults win; the style sub-fields
 *  similarly only appear when the user has set them, so each lineStyle
 *  key falls back to the theme. */
function buildGridLineFragment(
  show: boolean | undefined,
  style: GridLineStyle | undefined,
): EChartsOption {
  const out: EChartsOption = {};
  if (show !== undefined) out.show = show;
  if (style) {
    const ls: EChartsOption = {};
    if (style.color) ls.color = style.color;
    if (Number.isFinite(style.width as number) && (style.width as number) > 0) {
      ls.width = style.width;
    }
    if (style.style) ls.type = refDashFor(style.style);
    if (Object.keys(ls).length > 0) out.lineStyle = ls;
  }
  return out;
}

/** Shallow-merge a base ECharts axis option with a user-overrides
 *  fragment, taking care to *deep-merge* the small set of nested
 *  objects that both sides can populate. Without this merge a user's
 *  `axisLine: { show: true }` would wipe out the base's
 *  `axisLine: { lineStyle: { color } }` and the axis would render in
 *  the wrong color; same hazard for `axisTick`, `axisLabel`,
 *  `splitLine`, and `minorSplitLine`. Axis-agnostic — used for both
 *  the X and Y axis literals (the override shape is identical for
 *  the two axes). */
function mergeAxis(base: EChartsOption, userY: EChartsOption): EChartsOption {
  // `minorTick` is in here so a user `minorTickCount` override (which only
  // sets `show + splitNumber`) doesn't clobber the theme's `lineStyle`
  // (color + 0.5px width). Without the deep merge, ECharts would fall
  // back to its 1px default and make minors visually thicker than majors.
  const NESTED = ["axisLine", "axisTick", "axisLabel", "splitLine", "minorSplitLine", "minorTick"] as const;
  const merged: EChartsOption = { ...base, ...userY };
  for (const key of NESTED) {
    const b = base[key] as EChartsOption | undefined;
    const u = userY[key] as EChartsOption | undefined;
    if (b && u) {
      // Deep-merge the immediate children; both sides typically only
      // populate `show`, `inside`, and `lineStyle`, so a one-level deep
      // merge of `lineStyle` is enough.
      const childMerged: EChartsOption = { ...b, ...u };
      const bls = (b as { lineStyle?: EChartsOption }).lineStyle;
      const uls = (u as { lineStyle?: EChartsOption }).lineStyle;
      if (bls && uls) {
        (childMerged as { lineStyle?: EChartsOption }).lineStyle = { ...bls, ...uls };
      }
      merged[key] = childMerged;
    }
  }
  return merged;
}

// ─────────────────────────────────────────────────────────────────────────
// Horizontal-mode transpose
// ─────────────────────────────────────────────────────────────────────────
// The vertical builder below (`buildSingleOption`) assumes "Y is the
// quantitative axis, X is the category / time / value axis". That
// asymmetry is baked into many places (yAxis is always built as `type:
// "value"`, jitter / aggregation / boxplot data shape all key off X).
//
// To support the mirror case (user binds X to a numeric column and Y to
// a categorical column, OR leaves Y unbound entirely — JMP, Tableau,
// Spotfire etc. all let users freely choose orientation), we run the
// vertical builder against an internally-SWAPPED spec, then flip the
// output. Concretely:
//   1. Detect `isHorizontal` at the top of `buildSingleOption`.
//   2. Build a swapped spec: encoding.x ↔ encoding.y, xAxis ↔ yAxis,
//      and sharedRanges with x/y bounds swapped.
//   3. Recurse into `buildSingleOption` with that swapped spec. The
//      swapped X (= original Y) is now categorical, swapped Y (=
//      original X) is now numeric — exactly the layout the vertical
//      code already handles. (Termination: post-swap, the new yField
//      is the original xField which is numeric, so `isHorizontal` is
//      false and no further recursion happens.)
//   4. Transpose the resulting ECharts option: swap top-level xAxis/
//      yAxis, and flip every series' per-point `[x, y]` data tuple to
//      `[y, x]`. Same for markLine / markArea anchor descriptors.
//
// This keeps the X-as-variable and Y-as-variable code paths fully
// symmetric without forking the entire builder. The user's verbatim
// requirement: "X 做变量轴和 Y 做变量轴时的表现应该完全一致".

/** Transpose one markLine / markArea data entry: swap `xAxis` ↔ `yAxis`
 *  fields and flip any `coord: [x, y]` arrays. Pass-through entries
 *  like `{ type: "min" }` (handled internally by ECharts and orientation-
 *  agnostic) are returned unchanged. */
function transposeMarkPoint(m: any): any {
  if (!m || typeof m !== "object") return m;
  const out: any = { ...m };
  const hasX = "xAxis" in out;
  const hasY = "yAxis" in out;
  const xAxis = out.xAxis;
  const yAxis = out.yAxis;
  delete out.xAxis;
  delete out.yAxis;
  if (hasX) out.yAxis = xAxis;
  if (hasY) out.xAxis = yAxis;
  if (Array.isArray(out.coord) && out.coord.length >= 2) {
    out.coord = [out.coord[1], out.coord[0], ...out.coord.slice(2)];
  }
  return out;
}

/** Transpose a markLine.data / markArea.data array. markArea entries
 *  are 2-element arrays of mark points (start, end); markLine entries
 *  are single mark points (or 2-element pairs for free-form lines). */
function transposeMarkData(arr: any[] | undefined): any[] | undefined {
  if (!Array.isArray(arr)) return arr;
  return arr.map((entry) =>
    Array.isArray(entry) ? entry.map(transposeMarkPoint) : transposeMarkPoint(entry),
  );
}

/** Transpose all per-point coordinates in a single ECharts series so
 *  the rendered chart is the horizontal mirror of the vertical build.
 *
 *  Data-flip is gated by series type:
 *  - `scatter` / `effectScatter` / `line` / `bar` carry `[x, y]` tuples
 *    (or `{ value: [x, y], symbolOffset: [dx, dy], ... }` objects). Flip
 *    both `value` and `symbolOffset`: jitter offset has to rotate with
 *    the axes or the JMP-style stacking lands in the wrong direction.
 *  - `boxplot` carries the 5-tuple `[min, q1, med, q3, max]` POSITIONALLY
 *    — the category comes from the matching xAxis.data slot, not the
 *    tuple itself. Naively flipping these would corrupt the stats. Skip
 *    the data flip; ECharts auto-orients the box rendering once the
 *    top-level xAxis ↔ yAxis swap completes.
 *  - `custom` (used for error-bar caps via `renderItem`) carries
 *    `[x, y, lo, hi]` and a vertical-only renderItem. Skip its data
 *    flip too — its renderItem reads `value(0)`/`value(1)` etc. and
 *    needs a horizontal-aware variant before its geometry can mirror.
 *    Known limitation: error bars stay vertically oriented in horizontal
 *    mode for now; the scatter dots they're anchored to render correctly.
 *
 *  markLine / markArea sit on the series, not the data points, and
 *  always need the xAxis ↔ yAxis key flip via `transposeMarkData`. */
function transposeSeriesData(s: any): any {
  if (!s || typeof s !== "object") return s;
  const out: any = { ...s };
  const seriesType = s.type;
  const FLIP_TYPES = new Set(["scatter", "effectScatter", "line", "bar"]);
  if (FLIP_TYPES.has(seriesType) && Array.isArray(s.data)) {
    out.data = s.data.map((pt: any) => {
      if (Array.isArray(pt) && pt.length >= 2) {
        return [pt[1], pt[0], ...pt.slice(2)];
      }
      if (
        pt &&
        typeof pt === "object" &&
        Array.isArray(pt.value) &&
        pt.value.length >= 2
      ) {
        const v = [pt.value[1], pt.value[0], ...pt.value.slice(2)];
        const newPt: any = { ...pt, value: v };
        if (Array.isArray(pt.symbolOffset) && pt.symbolOffset.length >= 2) {
          newPt.symbolOffset = [pt.symbolOffset[1], pt.symbolOffset[0]];
        }
        return newPt;
      }
      return pt;
    });
  }
  // Custom band-ref-line carriers: same shape on input as `scatter`
  // (data rows are `[dim0, dim1, …]` arrays) but custom series are
  // otherwise pass-through. We DO want to flip these so the segments
  // re-anchor to the swapped axes — flipping dims 0/1 keeps the
  // (catName, value) ↔ (value, catName) alignment correct, and
  // flipping the orientation flag at index 5 keeps the renderItem
  // drawing along the right axis. Detect by id-prefix so the rest
  // of the custom-series ecosystem (error-bar caps, etc.) stays
  // skipped exactly as before.
  if (
    seriesType === "custom" &&
    typeof s.id === "string" &&
    s.id.startsWith(BAND_REF_CARRIER_ID_PREFIX) &&
    Array.isArray(s.data)
  ) {
    out.data = s.data.map((row: any) => {
      if (!Array.isArray(row) || row.length < 6) return row;
      const flipped = [row[1], row[0], row[2], row[3], row[4], row[5] === "h" ? "v" : "h"];
      return flipped;
    });
  }
  // Per-category histogram custom series (MODE C in `buildSingleOption`):
  // bars, polygon/KDE fills, stats overlays and divider lines all share
  // the `__hist_cat_` id prefix. When the parent path swaps X↔Y axes
  // and recurses into the vertical builder, the recursed call emits
  // these series assuming X = cat. transposeOption then flips the
  // axes — so to keep the renderItems anchored to the correct axis we
  // also flip tuple[0]↔tuple[1] here, AND append a `__t` suffix to
  // the series id. Each MODE C renderItem reads `params.seriesId` to
  // detect the transposed orientation and adjusts geometry (cat axis
  // becomes Y, value axis becomes X).
  if (
    seriesType === "custom" &&
    typeof s.id === "string" &&
    (s.id.startsWith("__hist_cat_") || s.id.startsWith("__normal_cat_")) &&
    !s.id.endsWith("__t") &&
    Array.isArray(s.data)
  ) {
    out.data = s.data.map((row: any) => {
      if (Array.isArray(row) && row.length >= 2) {
        return [row[1], row[0], ...row.slice(2)];
      }
      return row;
    });
    out.id = `${s.id}__t`;
  }
  if (
    seriesType === "custom" &&
    typeof s.id === "string" &&
    s.id.startsWith(FIT_BAND_ID_PREFIX) &&
    !s.id.endsWith("__t") &&
    Array.isArray(s.data)
  ) {
    out.data = s.data.map((row: any) =>
      Array.isArray(row) && row.length >= 2
        ? [row[1], row[0], ...row.slice(2)]
        : row,
    );
    out.id = `${s.id}__t`;
  }
  if (s.markLine && Array.isArray(s.markLine.data)) {
    out.markLine = { ...s.markLine, data: transposeMarkData(s.markLine.data) };
  }
  if (s.markArea && Array.isArray(s.markArea.data)) {
    out.markArea = { ...s.markArea, data: transposeMarkData(s.markArea.data) };
  }
  if (s.markPoint && Array.isArray(s.markPoint.data)) {
    out.markPoint = { ...s.markPoint, data: transposeMarkData(s.markPoint.data) };
  }
  return out;
}

/** Transpose a full ECharts option built by the vertical pipeline so
 *  the rendered chart becomes its horizontal mirror. Swaps top-level
 *  `xAxis` ↔ `yAxis` and rewrites every series' data shape. The
 *  surrounding `grid`, `tooltip`, `textStyle`, `backgroundColor`,
 *  `animationDuration`, etc. are orientation-agnostic and copied
 *  verbatim. */
export function transposeOption(opt: EChartsOption): EChartsOption {
  if (!opt || typeof opt !== "object") return opt;
  const out: EChartsOption = { ...opt };
  out.xAxis = opt.yAxis;
  out.yAxis = opt.xAxis;
  const series = Array.isArray(opt.series) ? (opt.series as any[]) : [];
  out.series = series.map((s) => transposeSeriesData(s));
  return out;
}

/** Swap x/y bounds in a `SharedAxisRanges` so a faceted horizontal-mode
 *  panel still pins to the global numeric range AND the global Y
 *  category list. The caller swaps `encoding.x` ↔ `encoding.y` before
 *  recursing; this helper does the same swap on the precomputed axis
 *  bounds.
 *
 *  - `xMin / xMax / xInterval` (from the originally-numeric X) become
 *    the swapped `yMin / yMax / yInterval` (the internal value axis).
 *  - `yCats` (from the originally-categorical Y, populated by the
 *    horizontal-mode branch of `computeSharedRanges`) becomes the
 *    swapped `xCats` so every panel renders with the same internal
 *    category list — after transpose, these are the same Y categories
 *    on every faceted panel. Without this forwarding, each panel
 *    computes its categories locally from its row subset and the
 *    label sets diverge (the user's screenshot 1 symptom: EV1 shows
 *    3 cats, DV shows 2 cats).
 *  - The outgoing `yCats` is dropped — in the swapped vertical build,
 *    Y is the value axis and category data has no meaning there. */
function swapSharedRanges(r: SharedAxisRanges): SharedAxisRanges {
  return {
    xMin: r.yMin,
    xMax: r.yMax,
    xInterval: r.yInterval,
    xCats: r.yCats,
    yMin: r.xMin,
    yMax: r.xMax,
    yInterval: r.xInterval,
  };
}

/** 渲染一个单图（不分面）的 ECharts option
 *
 *  When called from the faceted path (`buildGraph` with `groupX`/`wrap`),
 *  each panel only sees its own subset of rows — so the panel-local
 *  ordering of overlay groups can collapse to a single group. Without
 *  `globalGroupKeys`, every panel would then pick color[0] and lose the
 *  per-group theming. Passing the full-dataset ordering keeps EV1 = blue,
 *  TC1.6 = orange, … across every panel.
 *
 *  `sharedRanges` is set by the faceted caller to force every panel to
 *  the same axis bounds (see SharedAxisRanges above). */
function buildSingleOption(
  spec: GraphSpec,
  data: GraphData,
  theme: GraphTheme,
  globalGroupKeys?: string[],
  valueOrders?: Record<string, string[]>,
  sharedRanges?: SharedAxisRanges,
  aggregatePackets?: readonly GraphAggregatePacket[],
  panelFacet?: PanelFacetContext,
  frame?: GraphDataFrame,
  frameScatterCoordinates?: FrameScatterCoordinates,
): EChartsOption {
  const { encoding, elements } = spec;
  const xField = encoding.x;
  const yField = encoding.y;
  const colorField = encoding.color;
  const overlayField = encoding.overlay;
  const sizeField = encoding.size;
  const enabledElements = elements.filter((e) => e.enabled !== false);
  const frameBackedAggregateMode = aggregatePackets !== undefined;
  const aggregateMode: "legacyRows" | "frameBacked" = frameBackedAggregateMode
    ? "frameBacked"
    : "legacyRows";
  const hasCorrelationMatrix = enabledElements.some((element) => element.kind === "correlationMatrix");
  const correlationMatrixPacket = findCorrelationMatrixPacket(aggregatePackets, panelFacet);

  if (hasCorrelationMatrix && frameBackedAggregateMode && correlationMatrixPacket) {
    return buildCorrelationMatrixOption(
      correlationMatrixPacket,
      theme,
      buildAxisCommon(theme),
      aggregateMode,
      spec,
    );
  }

  const resolvedFrameScatterCoordinates = frameScatterCoordinates ?? {
    x: xField
      ? {
        vector: "x" as const,
        column: xField.name,
        type: xField.type === "datetime"
          ? "datetime" as const
          : xField.type === "continuous"
            ? "continuous" as const
            : "nominal" as const,
        categories: frame?.dictionaries.x ?? valueOrders?.[xField.name],
      }
      : {
        vector: "constant" as const,
        type: "nominal" as const,
        constant: "",
      },
    y: yField ? { vector: "y" as const, column: yField.name } : undefined,
  };

  // ─── Horizontal-mode early exit ────────────────────────────────────────
  // See the `transposeOption` helper above for the full rationale. The
  // vertical builder below assumes Y is numeric; to make X-as-variable
  // and Y-as-variable fully symmetric we swap the spec and recurse
  // through the existing vertical pipeline whenever the chart would
  // otherwise need a numeric X axis. Two trigger cases, both of which
  // mirror the Y-as-variable behavior the vertical path handles
  // natively:
  //
  //   (a) Y absent + X present. This is the user's "single variable
  //       dropped on X" case. The mirror "single variable dropped on
  //       Y" already works (vertical strip of points at x=""), so we
  //       swap so the recursive call sees Y bound + X absent and
  //       transpose back to a horizontal strip at y="".
  //
  //   (b) Y categorical + X continuous. Orientation-swap for
  //       bar / scatter / box plots where the user has put the
  //       category column on Y on purpose.
  //
  // Histogram special-case: vertical histogram has X = bin centers,
  // Y = "Count". Horizontal histogram swaps those (bins on Y, "Count"
  // on X). Trigger horizontal mode only when the user has bound the
  // continuous column to Y (and left X empty) AND a histogram element
  // is enabled — that's the user expressing "I want bars going
  // horizontally". When a histogram element is enabled but X is bound
  // instead, opt out of the generic orientation swap so the vertical
  // histogram branch wins.
  const xIsContinuous = xField?.type === "continuous";
  const yIsCatOrAbsent =
    !yField ||
    yField.type === "nominal" ||
    yField.type === "ordinal" ||
    yField.type === "id";
  const hasHistogramEl = elements.some(
    (e) => e.kind === "histogram" && e.enabled !== false,
  );
  const hasNormalCurveEl = elements.some(
    (e) => e.kind === "normalCurve" && e.enabled !== false,
  );
  const hasDistributionEl = hasHistogramEl || hasNormalCurveEl;
  const yOnlyHistogram =
    !xField && !!yField && yField.type === "continuous" && hasDistributionEl;
  // Case (a): single-variable-on-X. Fires regardless of X type so the
  // mirror of "drop one continuous column on Y" (which always
  // renders a strip) works for any X type the column might have.
  const xOnlyMirror = !yField && !!xField;
  // Case (b): orientation-swap when Y is categorical and X is the
  // numeric value column. Kept restricted to `continuous` to avoid
  // sending datetime through the value-only internal Y axis
  // (datetime horizontal is a follow-up).
  const orientationSwap = !!xIsContinuous && yIsCatOrAbsent && !!yField;
  // Histogram element gating: the per-category mode (MODE C)
  // implementation assumes the CATEGORICAL axis is X. To make
  // "X = continuous, Y = categorical, + histogram" behave
  // symmetrically to "X = cat, Y = continuous, + histogram", we
  // route X-cont/Y-cat through the same swap → recurse → transpose
  // pipeline `yOnlyHistogram` uses. After the swap the recursive
  // call sees X=cat / Y=cont and hits MODE C, then `transposeOption`
  // flips it back so bars render vertically inside each Y-categorical
  // row of the user's original orientation.
  //
  // xOnlyMirror is intentionally NOT extended this way — its purpose
  // is to put a Y-bound continuous strip on the user's vertical axis
  // when only one axis is bound, and the histogram exclusive vertical
  // case (MODE A) already handles X-only correctly.
  const isHorizontal =
    yOnlyHistogram ||
    (xOnlyMirror && !hasDistributionEl) ||
    orientationSwap;
  if (isHorizontal) {
    const swappedSpec: GraphSpec = {
      ...spec,
      encoding: {
        ...encoding,
        x: encoding.y,
        y: encoding.x,
      },
      xAxis: spec.yAxis,
      yAxis: spec.xAxis,
      // Reference lines are anchored to the value axis. In horizontal
      // mode the value axis becomes the rendered X; pass the user's
      // X-axis ref lines through as `refLinesY` of the swapped spec
      // (with the `{x}` → `{y}` field rename) so the internal vertical
      // build emits them on its (numeric) Y, then `transposeMarkData`
      // flips each `{ yAxis: v }` to `{ xAxis: v }` on the way out and
      // they render as vertical lines on the user's rendered X axis.
      // Original `refLinesY` is dropped on the floor here: post-swap
      // it would feed the inner build's X axis which is the user's
      // categorical Y — lines on a categorical axis have no meaningful
      // position so the inner build's own gating skips them anyway,
      // but clearing them here keeps the swapped spec self-consistent.
      refLinesY: (spec.refLinesX ?? []).map((r) => ({
        id: r.id,
        y: r.x,
        label: r.label,
        style: r.style,
        color: r.color,
        width: r.width,
      })),
      refLinesX: undefined,
      // Band ref lines: in horizontal mode the user's original X axis
      // becomes the inner Y (numeric value axis post-transpose), so
      // any band lines whose `valueAxis === "x"` must flip to `"y"`
      // before the inner build sees them. The `category` field still
      // names whichever axis ISN'T `valueAxis` — pre-swap that was
      // the (now inner-X) categorical axis, post-swap it's still on
      // the categorical axis the inner build sees. Band lines with
      // `valueAxis === "y"` pre-swap would land on the inner X (the
      // user's original categorical Y) which has no meaningful
      // numeric position, so we drop them, mirroring the user-line
      // policy above. `transposeMarkData` doesn't touch the markLine
      // `coord` arrays the band carrier emits, so flipping the spec
      // here is the only translation needed.
      bandRefLines: (spec.bandRefLines ?? [])
        .filter((ln) => ln.valueAxis === "x")
        .map((ln) => ({ ...ln, valueAxis: "y" as const })),
      // Auto-spec extras follow the column — swap them with the
      // encoding so the inner build reads spec metadata off the right
      // source. The user's original X column becomes the inner Y
      // (value axis post-transpose), so its `autoSpecX` snapshot
      // becomes the inner `autoSpecY`. The user's original Y column
      // becomes the inner X (categorical post-transpose); spec lines
      // on a categorical axis have no meaningful position so we drop
      // its `autoSpec` here, mirroring the user-defined-line policy.
      autoSpecY: spec.autoSpecX,
      autoSpecX: undefined,
    };
    const swappedShared = sharedRanges ? swapSharedRanges(sharedRanges) : undefined;
    const swappedFrameScatterCoordinates: FrameScatterCoordinates = {
      x: resolvedFrameScatterCoordinates.y
        ? {
          vector: resolvedFrameScatterCoordinates.y.vector,
          column: yField?.name,
          type: yField?.type === "datetime"
            ? "datetime"
            : yField?.type === "continuous"
              ? "continuous"
              : "nominal",
          categories: resolvedFrameScatterCoordinates.y.vector === "x"
            ? (frame?.dictionaries.x ?? valueOrders?.[yField?.name ?? ""])
            : (frame?.dictionaries.y ?? valueOrders?.[yField?.name ?? ""]),
        }
        : { vector: "constant", type: "nominal", constant: "" },
      y: resolvedFrameScatterCoordinates.x.vector === "constant"
        ? undefined
        : {
          vector: resolvedFrameScatterCoordinates.x.vector,
          column: resolvedFrameScatterCoordinates.x.column ?? xField?.name ?? "",
        },
    };
    const verticalOpt = buildSingleOption(
      swappedSpec,
      data,
      theme,
      globalGroupKeys,
      valueOrders,
      swappedShared,
      aggregatePackets,
      panelFacet,
      frame,
      swappedFrameScatterCoordinates,
    );
    return transposeOption(verticalOpt);
  }

  const xIdx = colIndex(data, xField?.name);
  const yIdx = colIndex(data, yField?.name);
  const sizeIdx = colIndex(data, sizeField?.name);

  // 决定 X 轴类型
  // Y-only fallback collapses all points onto a single category position.
  // Box plots also force a category axis (their categories come from the
  // unique values in `xField`, or a single bucket if no X is bound).
  const useRowIdxX = !xField;
  const hasBoxplot = elements.some((e) => e.kind === "boxplot" && e.enabled !== false);
  const xIsCategory =
    useRowIdxX || hasBoxplot ||
    xField?.type === "nominal" || xField?.type === "ordinal";
  const xIsTime = !useRowIdxX && !hasBoxplot && xField?.type === "datetime";
  const framePointsOnly = !!frame
    && enabledElements.length === 1
    && enabledElements[0].kind === "points"
    && getOpt<string>(enabledElements[0].options, "summaryStat", "none") === "none";
  const summaryPacket = findSummaryPacket(aggregatePackets, panelFacet);

  if (frame) {
    const frameRanges: SharedAxisRanges = {};
    const xVector = resolvedFrameScatterCoordinates.x.vector;
    const yVector = resolvedFrameScatterCoordinates.y?.vector;
    const xExtent = xVector === "constant" ? undefined : frame.extents[xVector];
    const yExtent = yVector ? frame.extents[yVector] : undefined;
    if (xIsCategory) {
      if (resolvedFrameScatterCoordinates.x.categories?.length) {
        frameRanges.xCats = [...resolvedFrameScatterCoordinates.x.categories];
      }
    } else if (!framePointsOnly && xIsTime && resolvedFrameScatterCoordinates.x.categories?.length) {
      const times = resolvedFrameScatterCoordinates.x.categories
        .map((value) => Date.parse(value))
        .filter(Number.isFinite);
      if (times.length > 0) {
        let minTime = Infinity;
        let maxTime = -Infinity;
        for (const time of times) {
          if (time < minTime) minTime = time;
          if (time > maxTime) maxTime = time;
        }
        frameRanges.xMin = minTime;
        frameRanges.xMax = maxTime;
      }
    } else if (!framePointsOnly && xExtent) {
      frameRanges.xMin = xExtent.min;
      frameRanges.xMax = xExtent.max;
    }
    if (!framePointsOnly && yExtent) {
      frameRanges.yMin = yExtent.min;
      frameRanges.yMax = yExtent.max;
    }
    if (xIsCategory && yField?.type === "continuous" && hasNormalCurveEl && summaryPacket) {
      let curveMin = frameRanges.yMin ?? Infinity;
      let curveMax = frameRanges.yMax ?? -Infinity;
      for (const entry of summaryPacket.summaries) {
        if (entry.count < 2) continue;
        const domain = normalCurveDomain(entry.mean, entry.stddev, entry.min, entry.max);
        if (!domain) continue;
        curveMin = Math.min(curveMin, domain[0]);
        curveMax = Math.max(curveMax, domain[1]);
      }
      const fit = computeNiceBounds(
        Number.isFinite(curveMin) ? curveMin : undefined,
        Number.isFinite(curveMax) ? curveMax : undefined,
        collectRefLineYs(spec),
        AUTO_TARGET_TICKS,
      );
      if (fit) {
        frameRanges.yMin = fit.min;
        frameRanges.yMax = fit.max;
        frameRanges.yInterval = fit.interval;
      }
    }
    sharedRanges = { ...frameRanges, ...sharedRanges };
  }

  const axis = buildAxisCommon(theme);

  const series: any[] = [];
  let framePointExtents: {
    x?: { min: number; max: number };
    y?: { min: number; max: number };
  } | undefined;
  const boxPlotPacket = findBoxPlotPacket(aggregatePackets, panelFacet);
  const histogramPacket = findHistogramPacket(aggregatePackets, panelFacet);
  const heatmapPacket = findHeatmapPacket(aggregatePackets, panelFacet);
  const histogramElementCount = enabledElements.filter((e) => e.kind === "histogram").length;
  const histogramOnlyPacketMode =
    frameBackedAggregateMode &&
    !!histogramPacket &&
    enabledElements.length === 1 &&
    histogramElementCount === 1;
  const boxplotPacketMode = frameBackedAggregateMode && hasBoxplot && !!boxPlotPacket;
  const normalSummaryPacketMode = frameBackedAggregateMode && hasNormalCurveEl && !!summaryPacket;

  // 按 overlay/color 分组，Overlay 是 GraphBuilder 的主 group identity。
  const grouping = overlayField ?? colorField;
  const groupingOrder = grouping ? valueOrders?.[grouping.name] : undefined;
  const packetGroupKeys = histogramPacket
    ? Array.from(new Set(histogramPacket.bins.map((bin) => String(bin.group ?? DEFAULT_GROUP_KEY))))
    : summaryPacket
      ? Array.from(new Set(summaryPacket.summaries.map((entry) => String(entry.group ?? DEFAULT_GROUP_KEY))))
      : [];
  const boxplotPacketGroupKeys = boxPlotPacket
    ? Array.from(new Set(boxPlotPacket.entries.map((entry) => String(entry.group ?? DEFAULT_GROUP_KEY))))
    : [];
  let groups: Map<string, number[]>;
  if (histogramOnlyPacketMode || boxplotPacketMode || normalSummaryPacketMode) {
    groups = new Map<string, number[]>();
    if (grouping) {
      const ownedGroupKeys = boxplotPacketMode
        ? boxplotPacketGroupKeys
        : packetGroupKeys;
      const orderedPacketGroups = groupingOrder
        ? applyValueOrder(ownedGroupKeys, groupingOrder)
        : ownedGroupKeys;
      for (const key of orderedPacketGroups) {
        groups.set(key, []);
      }
    } else {
      groups.set(DEFAULT_GROUP_KEY, []);
    }
  } else if (frameBackedAggregateMode && grouping && globalGroupKeys) {
    if (data.rows.length > 0) {
      groups = reorderMapByValueOrder(groupBy(data, grouping), groupingOrder);
    } else {
      groups = new Map(globalGroupKeys.map((key) => [key, []]));
    }
  } else {
    const rawGroups = groupBy(data, grouping);
    // Respect Value Order on the grouping column so the legend and color
    // assignment follow the user-defined order. With no grouping field this
    // is a no-op (the map has a single "__all__" key).
    groups = reorderMapByValueOrder(rawGroups, groupingOrder);
  }

  // Drop groups with no plottable rows under the bound encodings — i.e.
  // every row of the group has a missing value in some encoded channel
  // ({x, y}). This keeps the legend, color indexing, and downstream
  // series iteration in lock-step with GraphBuilderView.groupKeys, which
  // applies the same predicate so an "all-Y-null" overlay value never
  // produces a dead legend swatch with nothing on the canvas.
  // We skip this prune when there is no grouping field (the lone
  // "__all__" bucket must survive even if rows are missing some channel).
  if (grouping && !frameBackedAggregateMode) {
    const xIdxCheck = colIndex(data, xField?.name);
    const yIdxCheck = colIndex(data, yField?.name);
    const pruned = new Map<string, number[]>();
    for (const [k, idxs] of groups) {
      const hasPlottable = idxs.some((i) => {
        const row = data.rows[i];
        if (xIdxCheck >= 0 && isMissing(row[xIdxCheck])) return false;
        if (yIdxCheck >= 0 && isMissing(row[yIdxCheck])) return false;
        return true;
      });
      if (hasPlottable) pruned.set(k, idxs);
    }
    groups = pruned;
  }
  const groupKeys = Array.from(groups.keys());

  /** Stable color index for a group: prefers the global ordering passed
   *  in by the faceted caller; falls back to the panel-local order. */
  const colorIndexOf = (gKey: string): number => {
    if (globalGroupKeys) {
      const i = globalGroupKeys.indexOf(gKey);
      if (i >= 0) return i;
    }
    return Math.max(0, groupKeys.indexOf(gKey));
  };

  const resolvedStyleFor = (groupKey: string): ResolvedGroupStyle => {
    const fallbackColor = theme.categorical[colorIndexOf(groupKey) % theme.categorical.length];
    return resolveGroupStyle(groupKey, fallbackColor, !!grouping, theme, spec.styles);
  };

  /** Set of group values the user has hidden via the legend show/hide
   *  toggle. Only meaningful when there's a grouping field; ignored
   *  otherwise (a single ungrouped chart has nothing to hide against). */
  const hiddenSet = new Set(spec.hiddenGroups ?? []);
  const isHidden = (gKey: string): boolean =>
    !!grouping && hiddenSet.has(gKey);
  // Row-level variant of `isHidden` for code paths that scan raw
  // `data.rows` (axis bound fitting, empty-category filtering). Those
  // need to know "is this row in a hidden group?" without going
  // through the `groups` map. Returns false when no grouping is bound.
  const groupingIdx = grouping ? colIndex(data, grouping.name) : -1;
  const isRowHidden = (r: unknown[]): boolean => {
    if (!grouping || groupingIdx < 0 || hiddenSet.size === 0) return false;
    const v = r[groupingIdx];
    return hiddenSet.has(v == null ? "" : String(v));
  };

  // Resolve the X axis category list early so the boxplot path can
  // iterate the *same* list ECharts will render — otherwise series
  // data indices fall out of sync with the axis (e.g. an empty
  // category EV2 dropped from xCats but still iterated by the box
  // builder pushes a `{value:'-'}` marker into the slot that should
  // belong to DV, blanking DV's box and orphaning DV's real stats at
  // a non-existent axis index).
  //   - rawXCats: panel-local cats whose Y is finite for at least
  //     one row (mirrors the legend's hide-empty-group filter).
  //   - localXCats: rawXCats reordered by the user's Value Order.
  //   - xCats: when faceted, use the FULL cross-panel union
  //     (sharedRanges.xCats) rather than the local intersection.
  //     Reason: when users compare panels side-by-side under Group X
  //     they expect every panel to expose the SAME X slots — a panel
  //     whose data is missing one category should leave that slot
  //     empty (ECharts auto-fills `{value:'-'}` markers via the box
  //     builder's `xGroups.get(cat) ?? []` path) rather than silently
  //     compress its X axis so identical X positions line up across
  //     panels at different pixel offsets. The "drop empty local
  //     slots" intent from earlier rounds is now handled one level
  //     up at the facet expansion in `buildGraph`, which drops the
  //     whole panel when there's no data to show at all.
  const histogramPacketCats =
    frameBackedAggregateMode && histogramPacket && xIsCategory
      ? Array.from(
        new Set(
          histogramPacket.bins
            .map((bin) => (bin.category == null ? "" : String(bin.category)))
            .filter((value) => value.length > 0),
        ),
      )
      : [];
  const boxplotPacketCats =
    boxplotPacketMode && xIsCategory
      ? Array.from(
        new Set(
          boxPlotPacket.entries
            .map((entry) => (entry.category == null ? "" : String(entry.category)))
            .filter((value) => value.length > 0),
        ),
      )
      : [];
  const normalPacketCats =
    normalSummaryPacketMode && xIsCategory
      ? Array.from(
        new Set(
          summaryPacket.summaries
            .map((entry) => (entry.category == null ? "" : String(entry.category)))
            .filter((value) => value.length > 0),
        ),
      )
      : [];
  const rawXCats =
    useRowIdxX
      ? [""]
      : xIsCategory
        ? boxplotPacketMode
          ? boxplotPacketCats
          : histogramOnlyPacketMode
            ? histogramPacketCats
            : normalSummaryPacketMode
              ? normalPacketCats
              : collectCategories(data, xIdx, yIdx)
        : [];
  const localXCats = xField ? applyValueOrder(rawXCats, valueOrders?.[xField.name]) : rawXCats;
  let xCats: string[] = xIsCategory && sharedRanges?.xCats
    ? sharedRanges.xCats
    : localXCats;
  if (xCats.length === 0 && histogramPacket && xIsCategory) {
    const catSet = new Set<string>();
    for (const bin of histogramPacket.bins) {
      if (bin.category != null && String(bin.category).length > 0) {
        catSet.add(String(bin.category));
      }
    }
    xCats = xField ? applyValueOrder(Array.from(catSet), valueOrders?.[xField.name]) : Array.from(catSet);
  }

  // MODE C category-divider flag. Set true inside the histogram block
  // when per-category horizontal histograms are emitted; consumed by
  // the xAxis builder far below to turn on `splitLine` (vertical
  // hairlines between every category slot). We use the built-in axis
  // splitLine feature here instead of a custom-series carrier because
  // ECharts silently filters custom-series rows whose value-axis dim
  // falls outside the visible range — the carrier rendered nothing
  // when the value axis was zoomed away from 0.
  let perCategoryHistogramOn = false;

  if (enabledElements.some((e) => e.kind === "heatmap")) {
    if (frameBackedAggregateMode && heatmapPacket && heatmapPacket.cells.length > 0) {
      type HeatCell = { x: number; y: number; count: number; group: string };
      const byGroup = new Map<string, HeatCell[]>();
      let maxCount = 0;
      for (const cell of heatmapPacket.cells) {
        const g = (cell.group ?? DEFAULT_GROUP_KEY);
        if (isHidden(g)) continue;
        const x = (cell.xBinStart + cell.xBinEnd) / 2;
        const y = (cell.yBinStart + cell.yBinEnd) / 2;
        const count = Math.max(0, cell.count);
        if (count > maxCount) maxCount = count;
        let arr = byGroup.get(g);
        if (!arr) {
          arr = [];
          byGroup.set(g, arr);
        }
        arr.push({ x, y, count, group: g });
      }

      const groupOrder = grouping
        ? groupKeys.filter((key) => byGroup.has(key))
        : [DEFAULT_GROUP_KEY];
      const emitGroups = groupOrder.length > 0 ? groupOrder : Array.from(byGroup.keys());

      emitGroups.forEach((gKey) => {
        const cells = byGroup.get(gKey) ?? [];
        if (cells.length === 0) return;
        const styleKey = grouping ? gKey : DEFAULT_GROUP_KEY;
        const heatStyle = resolvedStyleFor(styleKey);
        series.push({
          type: "heatmap",
          name: grouping ? gKey : (yField?.name || "heatmap"),
          data: cells.map((cell) => [cell.x, cell.y, cell.count]),
          pointSize: [Math.max(1, heatmapPacket.xBinWidth), Math.max(1, heatmapPacket.yBinWidth)],
          blurSize: 0,
          itemStyle: {
            color: grouping ? heatStyle.fill.color : theme.categorical[0],
            opacity: grouping ? 0.55 : 0.7,
          },
          progressive: 2000,
          animation: false,
          z: 1,
        });
      });

      if (frame) {
        const frameScatter = buildFrameBackedScatterSeries(
          spec,
          frame,
          panelFacet,
          theme,
          valueOrders,
          sharedRanges,
          resolvedFrameScatterCoordinates,
        );
        series.push(...frameScatter.series);
      }

      const refCarrierY = buildRefLinesCarrier(normalizeRefLinesY(spec.refLinesY), spec.autoSpecY, theme, "y");
      if (refCarrierY) series.push(refCarrierY);
      const refCarrierX = buildRefLinesCarrier(normalizeRefLinesX(spec.refLinesX), spec.autoSpecX, theme, "x");
      if (refCarrierX) series.push(refCarrierX);

      return {
        backgroundColor: "transparent",
        textStyle: { color: theme.fgPrimary },
        grid: { left: 56, right: 24, top: 32, bottom: 48, show: true, borderColor: theme.axisLine, borderWidth: 0.5 },
        tooltip: { trigger: "item", confine: true, appendToBody: true },
        xAxis: mergeAxis(
          {
            type: "value",
            ...axis,
            ...(sharedRanges?.xMin != null ? { min: sharedRanges.xMin } : {}),
            ...(sharedRanges?.xMax != null ? { max: sharedRanges.xMax } : {}),
          },
          buildAxisOverrides(spec.xAxis, aggregateMode),
        ),
        yAxis: mergeAxis(
          {
            type: "value",
            ...axis,
            ...(sharedRanges?.yMin != null ? { min: sharedRanges.yMin } : {}),
            ...(sharedRanges?.yMax != null ? { max: sharedRanges.yMax } : {}),
          },
          buildAxisOverrides(spec.yAxis, aggregateMode),
        ),
        ...(!grouping
          ? {
            visualMap: {
              min: 0,
              max: Math.max(1, maxCount),
              calculable: false,
              orient: "horizontal",
              left: "center",
              bottom: 8,
              inRange: { color: [theme.sequential[0], theme.sequential[1]] },
              textStyle: { color: theme.fgSecondary },
            },
          }
          : {}),
        series,
      } as EChartsOption;
    }
    if (frameBackedAggregateMode) {
      return {
        backgroundColor: "transparent",
        textStyle: { color: theme.fgPrimary },
        grid: { left: 56, right: 24, top: 32, bottom: 48, show: true, borderColor: theme.axisLine, borderWidth: 0.5 },
        xAxis: mergeAxis({ type: "value", ...axis }, buildAxisOverrides(spec.xAxis, aggregateMode)),
        yAxis: mergeAxis({ type: "value", ...axis }, buildAxisOverrides(spec.yAxis, aggregateMode)),
        series,
      } as EChartsOption;
    }
  }

  // —— 直方图：两种模式 ——
  //
  // MODE A (exclusive): X bound to continuous, Y empty. Histogram
  //   takes over the entire chart — X = bin centers, Y = "Count".
  //   Other layers don't compose with this mode (their semantics
  //   don't fit "Count" on Y). Early-returns the full ECharts option.
  //
  // MODE C (per-category): X categorical, Y continuous. Histogram
  //   renders as JMP-style per-category horizontal bars — one mini
  //   horizontal histogram inside each X-category slot, with bins
  //   along the Y axis. Composes with box / scatter / line layers
  //   so they overlay in the same coordinate space. Implemented as
  //   a `custom` series so each bar can be drawn at a precise
  //   pixel offset within its category slot.
  //
  // The horizontal-orientation case (Y bound continuous, X empty)
  // is handled by the outer `yOnlyHistogram` swap, which recurses
  // into MODE A with the column on X then transposes the option.
  const hasRenderableHistogram = !frameBackedAggregateMode || !!histogramPacket;
  if ((hasHistogramEl && hasRenderableHistogram) || hasNormalCurveEl) {
    const histogramSeriesStart = series.length;
    const hasNormalCurve = hasNormalCurveEl;
    const histEl = enabledElements.find((e) => e.kind === "histogram");
    const opts = histEl?.options;
    const histStyle = getOpt<string>(opts, "histStyle", "bar"); // bar|polygon|kde|shadowgram
    const smoothness = Math.max(0, Math.min(1, getOpt<number>(opts, "smoothness", 0.5)));
    const showCounts = getOpt<boolean>(opts, "showCounts", false);
    const showPercents = getOpt<boolean>(opts, "showPercents", false);
    // "Histogram height" — fraction of the cat slot the longest bar
    // fills in MODE C. Default 1.0 = legacy (~85% of slot, leaving a
    // safe gap before the next category divider). Range clamped to
    // [0.1, 1.0]; user-controlled via the GraphBuilder slider.
    const histHeight = Math.max(
      0.1,
      Math.min(1, getOpt<number>(opts, "histHeight", 1)),
    );

    // Resolve the iteration list of groups, shared by both modes.
    // With no grouping, fall back to a single ungrouped layer keyed
    // by `DEFAULT_GROUP_KEY` so the `resolveGroupStyle` lookup still
    // picks up any user overrides saved under that key.
    type HistGroupSlot = { key: string; rowIdxs: number[]; baseColor: string };
    const histGroupSlots: HistGroupSlot[] = [];
    if (grouping) {
      const iterGroups = groupKeys.length > 0
      ? (frameBackedAggregateMode && (histogramPacket || summaryPacket)
          ? groupKeys.filter((key) => packetGroupKeys.includes(key))
          : groupKeys)
        : (frameBackedAggregateMode && (histogramPacket || summaryPacket)
          ? packetGroupKeys
          : []);
      for (const gKey of iterGroups) {
        if (isHidden(gKey)) continue;
        const rowIdxs = frameBackedAggregateMode ? [] : (groups.get(gKey) ?? []);
        if (rowIdxs.length === 0 && !(frameBackedAggregateMode && (histogramPacket || summaryPacket))) continue;
        histGroupSlots.push({
          key: gKey,
          rowIdxs,
          baseColor: theme.categorical[colorIndexOf(gKey) % theme.categorical.length],
        });
      }
    } else {
      histGroupSlots.push({
        key: DEFAULT_GROUP_KEY,
        rowIdxs: frameBackedAggregateMode ? [] : data.rows.map((_, i) => i),
        baseColor: theme.categorical[0],
      });
    }

    // —— MODE C: per-category horizontal histograms ——
    //
    // Active whenever X is categorical AND Y is continuous. This is
    // the JMP convention: the histogram layer adds a per-category
    // mini-histogram (bins on Y, bars extending horizontally within
    // the category slot) alongside box / scatter / line layers. We
    // do NOT early-return so the rest of the layer pipeline runs.
    const perCategoryMode = xIsCategory && yField?.type === "continuous" && yIdx >= 0;
    if (perCategoryMode) {
      // Bin grid alignment contract: the histogram bars in MODE C are
      // horizontal, so their THICKNESS on Y is the bin width. To make
      // each bar visually span exactly one minor-tick segment on the
      // Y axis (the user's "histogram width follows minor tick width"
      // ask), we must:
      //
      //   1. Use the same nice-snapped [yLo, yHi] the axis renders to,
      //      NOT the raw data extent. Otherwise the rendered axis pads
      //      outward by 2% and bin edges drift off the gridlines.
      //   2. Set bin width = niceStep / minorSplit, NOT
      //      (yHi - yLo) / round(N). Even with the right range,
      //      dividing by a rounded integer bin count introduces a tiny
      //      offset that accumulates across bins.
      //
      // When faceted, we honor the shared snapped range +
      // shared interval so every panel uses identical bin edges.
      let yLo: number;
      let yHi: number;
      let yMajorStep: number | undefined;
      // RAW data extent on Y, also captured for the bin-grid
      // over-render path further below (extend bins past the visible
      // axis range so an outward drag exposes pre-rendered bars
      // instead of a blank band).
      let dataLo: number;
      let dataHi: number;
      if (sharedRanges?.yMin != null && sharedRanges?.yMax != null) {
        yLo = sharedRanges.yMin;
        yHi = sharedRanges.yMax;
        // In faceted shared-range mode the shared axis already covers
        // every panel's data, so there's no extra "past the axis"
        // extent to over-render into.
        dataLo = yLo;
        dataHi = yHi;
        // Deliberately NOT using `sharedRanges.yInterval` for the bin
        // step. `yInterval` comes from `computeNiceBounds(...,
        // AUTO_TARGET_TICKS=10)` which is ~2× finer than what ECharts'
        // axis picks for its major step (`splitNumber=5` default). If
        // we used `yInterval`, bin width = `yInterval / 5` would be
        // ~½ the axis minor tick step, leaving bars misaligned by half
        // a tick. We derive `yMajorStep` from `niceStep(span,
        // BIN_GRID_TARGET_TICKS)` below — the exact step ECharts will
        // pick — so bin width matches the minor tick step.
      } else {
        let lo = Infinity;
        let hi = -Infinity;
        if (frameBackedAggregateMode && histogramPacket) {
          const pLo = histogramPacket.minValue;
          const pHi = histogramPacket.maxValue;
          if (Number.isFinite(pLo as number)) lo = pLo as number;
          if (Number.isFinite(pHi as number)) hi = pHi as number;
        }
        if ((!Number.isFinite(lo) || !Number.isFinite(hi)) && frameBackedAggregateMode && histogramPacket) {
          for (const bin of histogramPacket.bins) {
            if (Number.isFinite(bin.binStart)) {
              if (bin.binStart < lo) lo = bin.binStart;
              if (bin.binStart > hi) hi = bin.binStart;
            }
            if (Number.isFinite(bin.binEnd)) {
              if (bin.binEnd < lo) lo = bin.binEnd;
              if (bin.binEnd > hi) hi = bin.binEnd;
            }
          }
        }
        if ((!Number.isFinite(lo) || !Number.isFinite(hi)) && frameBackedAggregateMode && summaryPacket && hasNormalCurve) {
          for (const entry of summaryPacket.summaries) {
            if (Number.isFinite(entry.min) && entry.min < lo) lo = entry.min;
            if (Number.isFinite(entry.max) && entry.max > hi) hi = entry.max;
          }
        }
        if ((!Number.isFinite(lo) || !Number.isFinite(hi)) && frameBackedAggregateMode && histogramPacket) {
          // Frame-backed histogram mode must never fall back to raw rows.
          // Use axis pins when present, otherwise an explicit safe empty span.
          const yPinMin = spec.yAxis?.min;
          const yPinMax = spec.yAxis?.max;
          if (Number.isFinite(yPinMin)) lo = yPinMin as number;
          if (Number.isFinite(yPinMax)) hi = yPinMax as number;
          if (!Number.isFinite(lo) && Number.isFinite(hi)) lo = (hi as number) - 1;
          if (!Number.isFinite(hi) && Number.isFinite(lo)) hi = (lo as number) + 1;
          if (!Number.isFinite(lo)) lo = 0;
          if (!Number.isFinite(hi)) hi = 1;
        }
        if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
          for (let i = 0; i < data.rows.length; i++) {
            if (isRowHidden(data.rows[i])) continue;
            const v = toNum(data.rows[i][yIdx]);
            if (!Number.isFinite(v)) continue;
            if (v < lo) lo = v;
            if (v > hi) hi = v;
          }
        }
        dataLo = Number.isFinite(lo) ? lo : 0;
        dataHi = Number.isFinite(hi) ? hi : 1;
        // Bin-grid bounds MUST follow the EXACT same path the axis
        // takes (`yFinalBounds` block + `mergeAxis` overrides below):
        //   1. Auto-fit on RAW dataMin/dataMax (NOT user pin).
        //   2. Apply user pins RAW on top — same as `mergeAxis` →
        //      `buildAxisOverrides` spreading `cfg.min`/`cfg.max`
        //      unmodified over the auto-fit.
        // Earlier code passed user pins THROUGH `computeNiceBounds`
        // which re-snapped them to a local nice grid, producing a
        // DIFFERENT span than the axis ended up with. When the pin
        // happens to land on a non-nice value (e.g. 4.345), the
        // re-snap shifts `yLo` down to 4.32 → bin span 0.36 →
        // `niceStep(0.36, 5)=0.1` while axis span stays 0.335 →
        // ECharts step 0.05 → bin width 0.02 vs axis minor tick 0.01
        // → bars are 2× the minor tick width. Mirroring the axis
        // exactly keeps the two spans identical.
        const fit = computeNiceBounds(
          Number.isFinite(lo) ? lo : undefined,
          Number.isFinite(hi) ? hi : undefined,
          collectRefLineYs(spec),
          AUTO_TARGET_TICKS,
        );
        const autoLo = fit ? fit.min : (Number.isFinite(lo) ? lo : 0);
        const autoHi = fit ? fit.max : (Number.isFinite(hi) ? hi : 1);
        const yPinMin = spec.yAxis?.min;
        const yPinMax = spec.yAxis?.max;
        yLo = Number.isFinite(yPinMin) ? (yPinMin as number) : autoLo;
        yHi = Number.isFinite(yPinMax) ? (yPinMax as number) : autoHi;
      }
      // Derive bin-grid step against `BIN_GRID_TARGET_TICKS` — the
      // same `splitNumber` ECharts uses by default — so the resulting
      // bin width = `majorStep / minorSplit` lines up with the major
      // tick step ECharts auto-picks for the axis from the IDENTICAL
      // `[yLo, yHi]` span.
      yMajorStep = niceStep(yHi - yLo, BIN_GRID_TARGET_TICKS);
      // User-pinned `tickInterval` overrides the auto-fit step so bins
      // realign with whatever the user dialed in.
      const userYStep = spec.yAxis?.tickInterval;
      if (Number.isFinite(userYStep as number) && (userYStep as number) > 0) {
        yMajorStep = userYStep as number;
      }
      const yMinorSplit = resolveMinorSplit(spec.yAxis);
      let yWidth: number;
      let binCount: number;
      // Bin grid ORIGIN — separate from `yLo` so the bin edges land
      // on the same nice multiples ECharts uses for its minor tick
      // grid. Without this snap, drag-zooming the axis to a non-nice
      // min (e.g. 4.31 instead of 4.30) leaves bin edges at
      // 4.310, 4.314, 4.318, … while ECharts' minor ticks land on
      // 4.32, 4.34, 4.36, …  → permanent visual misalignment that
      // only "fixes itself" when the user happens to drag the axis
      // back onto a nice multiple. Snapping the origin to the next
      // nice multiple below `yLo` keeps both grids on the same
      // ladder regardless of where the user dragged.
      let yGridOrigin: number;
      if (yMajorStep && yMajorStep > 0 && yHi > yLo) {
        // Aligned mode: bin edges land on minor tick positions.
        yWidth = yMajorStep / yMinorSplit;
        // Over-render the bin grid OUTWARD past the visible
        // [yLo, yHi] axis range so it spans the full raw data
        // extent. Off-screen bins still get emitted as custom-series
        // tuples and rendered to the canvas; `clip: true` on the
        // series masks them visually. During a pan/zoom drag, we
        // only push a partial axis-only `setOption` (lazyUpdate +
        // animation:false) — the transform pipeline doesn't re-run
        // until pointerup, so the bin tuples are FROZEN at their
        // build-time set. If we only emitted tuples inside [yLo,
        // yHi], dragging the axis OUTWARD would expose a blank band
        // (no tuples → no shapes → nothing for the expanding clip
        // region to reveal) until mouseup triggered the full
        // rebuild. By extending to [dataLo, dataHi] up-front, the
        // bars in any newly-revealed area are already on the canvas
        // the instant the clip path expands past them. The bin
        // width (= minor tick step) is unchanged, so tick
        // alignment is preserved.
        const extLo = Math.min(yLo, dataLo);
        const extHi = Math.max(yHi, dataHi);
        yGridOrigin = Math.floor(extLo / yWidth) * yWidth;
        const yGridEnd = Math.ceil(extHi / yWidth) * yWidth;
        binCount = Math.max(1, Math.round((yGridEnd - yGridOrigin) / yWidth));
      } else {
        // Fallback: shouldn't normally hit this (only if the fit
        // failed and data is degenerate). Keep the legacy density.
        binCount = computeAutoBinCount(yLo, yHi, spec.yAxis);
        yWidth = yHi > yLo ? (yHi - yLo) / binCount : 1;
        yGridOrigin = yLo;
      }
      const yHalf = yWidth / 2;
      const yCenters: number[] = [];
      for (let i = 0; i < binCount; i++) yCenters.push(yGridOrigin + yWidth * (i + 0.5));

      // Compute per-(cat, group) bin counts and per-cat max count
      // (used to normalize bar widths so the longest bar in each
      // category fills its sub-slot).
      const perCatPerGroup = new Map<string, Map<string, number[]>>();
      const perCatMaxCount = new Map<string, number>();

      const packetMode = frameBackedAggregateMode && !!histogramPacket;
      const packetBinsByCatGroup = new Map<string, number[]>();
      if (packetMode) {
        const packetMin = Number.isFinite(histogramPacket.minValue as number)
          ? (histogramPacket.minValue as number)
          : yGridOrigin;
        const packetWidth = Number.isFinite(histogramPacket.binWidth) && histogramPacket.binWidth > 0
          ? histogramPacket.binWidth
          : yWidth;
        const packetCount = Math.max(1, histogramPacket.binCount || 1);
        for (const bin of histogramPacket.bins) {
          const cat = String(bin.category ?? "");
          const g = String(bin.group ?? DEFAULT_GROUP_KEY);
          const center = (bin.binStart + bin.binEnd) / 2;
          const visualIndex = Math.floor((center - yGridOrigin) / yWidth);
          if (visualIndex < 0 || visualIndex >= binCount) continue;
          const k = `${cat}||${g}`;
          let arr = packetBinsByCatGroup.get(k);
          if (!arr) {
            arr = new Array<number>(binCount).fill(0);
            packetBinsByCatGroup.set(k, arr);
          }
          arr[visualIndex] += Math.max(0, Number(bin.count) || 0);
          if (packetCount > 0 && packetWidth > 0 && center >= packetMin) {
            // no-op branch keeps packet metadata reads alive for guardrails
          }
        }
      }

      for (const cat of xCats) {
        const perGroup = new Map<string, number[]>();
        // `binCount` covers the FULL data range (over-render block
        // above), so per-cat bin counts taken straight from
        // `buckets[]` already reflect the global per-cat max. No
        // separate "all-bin tally" Map is needed; an earlier
        // workaround tracked off-screen bins explicitly because the
        // bin grid only covered [yLo, yHi] and the visible max
        // would drop when the tallest bin scrolled off-axis.
        let catMax = 0;
        for (const slot of histGroupSlots) {
          const buckets = new Array<number>(binCount).fill(0);
          if (packetMode) {
            const fromPacket = packetBinsByCatGroup.get(`${cat}||${slot.key}`)
              ?? packetBinsByCatGroup.get(`${cat}||${DEFAULT_GROUP_KEY}`)
              ?? [];
            for (let bi = 0; bi < Math.min(binCount, fromPacket.length); bi++) {
              buckets[bi] = fromPacket[bi] ?? 0;
              if (buckets[bi] > catMax) catMax = buckets[bi];
            }
          } else {
            // Intersect this group's row indices with this category.
            for (const i of slot.rowIdxs) {
              const row = data.rows[i];
              const rowCat = row[xIdx] == null ? "" : String(row[xIdx]);
              if (rowCat !== cat) continue;
              const v = toNum(row[yIdx]);
              if (!Number.isFinite(v)) continue;
              if (yWidth <= 0) {
                buckets[0]++;
                if (buckets[0] > catMax) catMax = buckets[0];
              } else {
                const bin = Math.floor((v - yGridOrigin) / yWidth);
                // Guard kept as a safety net for floating-point
                // edge cases. The extended grid should cover every
                // valid data point.
                if (bin < 0 || bin >= binCount) continue;
                buckets[bin]++;
                if (buckets[bin] > catMax) catMax = buckets[bin];
              }
            }
          }
          perGroup.set(slot.key, buckets);
        }
        perCatPerGroup.set(cat, perGroup);
        perCatMaxCount.set(cat, catMax);
      }

      // —— PHASE 2 (precompute): KDE curves per (cat, group) when
      // `histStyle === "kde"`. We normalize bar/curve extent within
      // each category to a shared per-cat max so all groups in a cat
      // are visually comparable. For KDE this means tracking the max
      // density across all groups in the cat.
      type KdePoints = [number, number][];
      let perCatKde: Map<string, Map<string, KdePoints>> | null = null;
      let perCatMaxDensity: Map<string, number> | null = null;
      if (histStyle === "kde") {
        perCatKde = new Map();
        perCatMaxDensity = new Map();
        for (const cat of xCats) {
          const groupKde = new Map<string, KdePoints>();
          let catMaxDensity = 0;
          for (const slot of histGroupSlots) {
            let pts: KdePoints = [];
            if (packetMode) {
              const bins = perCatPerGroup.get(cat)?.get(slot.key) ?? [];
              const raw = bins.map((count, index) => [yCenters[index], count] as [number, number]);
              if (raw.length > 0) {
                const alpha = Math.max(0.05, Math.min(0.95, smoothness));
                let prev = raw[0][1];
                pts = raw.map(([center, value]) => {
                  const next = prev * (1 - alpha) + value * alpha;
                  prev = next;
                  return [center, next] as [number, number];
                });
              }
            } else {
              const vals: number[] = [];
              for (const i of slot.rowIdxs) {
                const row = data.rows[i];
                if (isRowHidden(row)) continue;
                const rowCat = row[xIdx] == null ? "" : String(row[xIdx]);
                if (rowCat !== cat) continue;
                const v = toNum(row[yIdx]);
                if (Number.isFinite(v)) vals.push(v);
              }
              if (vals.length > 0) {
                pts = kdeCurve(vals, smoothness, yWidth);
              }
            }
            if (pts.length === 0) {
              groupKde.set(slot.key, []);
              continue;
            }
            groupKde.set(slot.key, pts);
            for (const p of pts) if (p[1] > catMaxDensity) catMaxDensity = p[1];
          }
          perCatKde.set(cat, groupKde);
          perCatMaxDensity.set(cat, catMaxDensity);
        }
      }

      // Per-(cat, group) totals — only needed when showCounts /
      // showPercents render labels. For showPercents the percent base
      // is the group's total count within that category (matches the
      // bar style most naturally).
      let perCatGroupTotal: Map<string, Map<string, number>> | null = null;
      if (showCounts || showPercents) {
        perCatGroupTotal = new Map();
        for (const cat of xCats) {
          const totals = new Map<string, number>();
          const groupBins = perCatPerGroup.get(cat);
          if (groupBins) {
            for (const [k, bins] of groupBins) {
              let sum = 0;
              for (const c of bins) sum += c;
              totals.set(k, sum);
            }
          }
          perCatGroupTotal.set(cat, totals);
        }
      }

      // Push one custom series per group so each carries its own
      // color and shows up in the external legend (the
      // `LegendStylePanel` reads `groupKeys` and matches series by
      // name). The renderer used depends on `histStyle`:
      //   - bar (default): per-bar rect renderItem
      //   - polygon: per-cat closed polygon through bin tops
      //   - kde: per-cat closed polygon through KDE curve points
      //   - shadowgram: multi-bin-count bar overlay at low alpha
      //
      // All renderItems are orientation-aware: they detect whether
      // the cat axis is X (original) or Y (after `transposeOption`
      // post-swap) by inspecting `params.seriesId` for a `__t`
      // suffix appended in `transposeSeriesData`. Geometry is then
      // computed against the appropriate axis.
      histGroupSlots.forEach((slot) => {
        const styleKey = grouping ? slot.key : DEFAULT_GROUP_KEY;
        const rs = resolvedStyleFor(styleKey);
        // Visible fill color: same fallback logic as the bar layer —
        // `resolveGroupStyle` defaults ungrouped fill to "transparent"
        // which would render the histogram invisible.
        const userFill = spec.styles?.[styleKey]?.fill;
        const hasUserFill = !!(userFill?.color ?? userFill?.fillColor);
        const fillColor = hasUserFill
          ? rs.fill.color
          : grouping
            ? rs.fill.color
            : slot.baseColor;
        const strokeColor = rs.line.color || slot.baseColor;

        // ——— Polygon / KDE branch ———
        // Both styles render as a single closed polygon per (cat,
        // group): anchored on the slot's leading edge, fanning
        // outward through the per-bin (polygon) or per-sample (kde)
        // "intensity" points. Anchoring on the leading edge mirrors
        // the JMP convention used by the bar layer.
        //
        // Polygon points + per-cat max weight are stored in a
        // closure-bound Map rather than nested-array data fields.
        // ECharts custom series with `coordinateSystem: 'cartesian2d'`
        // only declares 2 numeric dimensions by default, so non-numeric
        // values at indices ≥ 2 in the data tuple get coerced to NaN
        // and lost — which is why a previous attempt that packed
        // `pts` into tuple[2] rendered nothing.
        if (histStyle === "polygon" || histStyle === "kde") {
          type CatPolyInfo = { pts: [number, number][]; catMaxW: number };
          const catData = new Map<string, CatPolyInfo>();
          for (const cat of xCats) {
            let pts: [number, number][];
            let catMaxWeight: number;
            if (histStyle === "kde") {
              pts = perCatKde!.get(cat)?.get(slot.key) ?? [];
              catMaxWeight = perCatMaxDensity!.get(cat) ?? 0;
            } else {
              const bins = perCatPerGroup.get(cat)?.get(slot.key) ?? [];
              catMaxWeight = perCatMaxCount.get(cat) ?? 0;
              pts = bins.map((c, i) => [yCenters[i], c]);
            }
            if (pts.length === 0 || catMaxWeight <= 0) continue;
            catData.set(cat, { pts, catMaxW: catMaxWeight });
          }
          if (catData.size === 0) return;
          // Per-cat tuple emitted into ECharts. tuple[1] MUST be a
          // numeric value strictly INSIDE the visible value-axis
          // range, otherwise ECharts silently filters the row and
          // `renderItem` is never invoked — the original code used
          // `info.pts[0][0]` which:
          //   • For polygon = `yCenters[0]` = `yLo + yWidth/2`. In
          //     range, but boundary-adjacent — works on most builds.
          //   • For KDE     = `min(vals) - 3·bandwidth`. ALWAYS
          //     outside `[yLo, yHi]`, so KDE rendered nothing.
          // Picking the middle bin center guarantees the tuple lands
          // safely inside the axis range for every histStyle.
          const safeMidY =
            yCenters.length > 0
              ? yCenters[Math.floor(yCenters.length / 2)]
              : (yLo + yHi) / 2;
          // Capture cats in tuple order so renderItem can look up
          // info by `params.dataIndex` directly. We cannot rely on
          // `api.value(catDim)` to return the original cat string:
          // when ECharts encodes a string column onto a categorical
          // axis it replaces the raw value with the cat ordinal
          // index ('0', '1', …) inside `api.value`, which causes
          // `catData.get(api.value(catDim))` to miss every row.
          const tupleCats: string[] = [];
          const tuples: any[][] = [];
          for (const [cat] of catData) {
            tupleCats.push(cat);
            tuples.push([cat, safeMidY]);
          }

          const polyPadY = histStyle === "kde" ? 0 : yWidth / 2;
          // Clamp to a hair INSIDE [yLo, yHi] so api.coord doesn't
          // return null at the exact boundary (some ECharts builds
          // reject `==max`). The epsilon is a tiny fraction of the
          // axis span so it's invisible after pixel rounding.
          const valEps = Math.max((yHi - yLo) * 1e-6, 1e-9);
          const clampVal = (v: number) =>
            Math.max(yLo + valEps, Math.min(yHi - valEps, v));

          series.push({
            id: `__hist_cat_${slot.key}_${histStyle}`,
            type: "custom",
            name: slot.key,
            coordinateSystem: "cartesian2d",
            // `series-custom.clip` defaults to FALSE — without this,
            // bars at the edge stay visible past the axis line
            // during drag-zoom / drag-pan (only mouseup triggers a
            // full rebuild that re-runs renderItem and applies the
            // in-renderItem clip). Standard series like scatter
            // clip live because ECharts maintains a clip path on
            // the series group, which we opt into here.
            clip: true,
            encode: { x: 0, y: 1, tooltip: [0] },
            data: tuples,
            renderItem: (params: any, api: any) => {
              const catIsX = !String(params.seriesId || "").endsWith("__t");
              // Use dataIndex → tupleCats lookup. See `tupleCats`
              // comment above: api.value on a categorical-axis dim
              // returns the cat ordinal, not the original string.
              const di = params.dataIndex ?? 0;
              const catName = tupleCats[di];
              if (catName == null) return null;
              const info = catData.get(catName);
              if (!info) return null;
              const { pts, catMaxW } = info;
              if (pts.length === 0 || catMaxW <= 0) return null;

              const xy = (val: number): [any, any] =>
                catIsX ? [catName, val] : [val, catName];
              // Reference center coord — uses the safe in-range
              // value so api.coord never returns null here.
              const ctrCoord = api.coord(xy(safeMidY));
              if (!ctrCoord) return null;
              const slotPx = catIsX
                ? api.size([1, 0])[0]
                : api.size([0, 1])[1];
              const insetMargin = 1;
              const rightSafePct = 0.15;
              // User "histogram height" scale (closed over from MODE C scope).
              // See `renderHistCatBar` for the rationale; same formula keeps
              // polygon/KDE silhouettes proportional to the bar version.
              const maxBarExtent =
                Math.max(0, slotPx * (1 - rightSafePct) - insetMargin) *
                histHeight;

              // Start/end "phantom anchor" points — clamped INSIDE
              // the visible axis range so the polygon closes cleanly
              // even when the source pts extend beyond it (KDE
              // tails) or sit exactly on the boundary (polygon).
              const firstV = pts[0][0];
              const lastV = pts[pts.length - 1][0];
              const startCoord = api.coord(xy(clampVal(firstV - polyPadY)));
              const endCoord = api.coord(xy(clampVal(lastV + polyPadY)));
              if (!startCoord || !endCoord) return null;

              // Walk pts, dropping any whose data value maps outside
              // the axis (KDE samples below yLo / above yHi). For
              // each in-range pt, project onto the value-axis pixel
              // line for this slot.
              const inRange: Array<{ pixel: number; w: number }> = [];
              for (const [v, w] of pts) {
                if (v < yLo || v > yHi) continue;
                const c = api.coord(xy(v));
                if (!c) continue;
                inRange.push({ pixel: catIsX ? c[1] : c[0], w });
              }
              if (inRange.length === 0) return null;

              const polyPts: number[][] = [];
              if (catIsX) {
                // Vertical slot, polygon fans rightward.
                const slotLeft = ctrCoord[0] - slotPx / 2 + insetMargin;
                polyPts.push([slotLeft, startCoord[1]]);
                for (const { pixel, w } of inRange) {
                  polyPts.push([
                    slotLeft + (w / catMaxW) * maxBarExtent,
                    pixel,
                  ]);
                }
                polyPts.push([slotLeft, endCoord[1]]);
              } else {
                // Horizontal slot (cat on Y, X is value axis).
                // Polygon fans UPWARD from the BOTTOM edge of the
                // cat slot to match the bar branch's bottom-alignment
                // convention — the per-cat histogram should always
                // hug the axis-adjacent edge (bottom when X is the
                // value axis) so all per-cat shapes share the same
                // visual baseline.
                const slotBot = ctrCoord[1] + slotPx / 2 - insetMargin;
                polyPts.push([startCoord[0], slotBot]);
                for (const { pixel, w } of inRange) {
                  polyPts.push([
                    pixel,
                    slotBot - (w / catMaxW) * maxBarExtent,
                  ]);
                }
                polyPts.push([endCoord[0], slotBot]);
              }

              return {
                type: "polygon",
                shape: { points: polyPts },
                style: {
                  fill: fillColor,
                  stroke: strokeColor,
                  lineWidth: 1.2,
                  opacity: grouping ? 0.35 : 0.45,
                },
              };
            },
            z: 1,
            silent: false,
            tooltip: {
              formatter: (p: any) => {
                const v = p.value as any[];
                return `${v[0]} (${histStyle})`;
              },
            },
          });
          return;
        }

        // ——— Shadowgram branch ———
        // Multi-bin-count overlay: render several semi-transparent
        // bar layers at varying bin densities so the union reads as
        // a density estimate (no single bin count is privileged).
        // The minor-tick alignment guarantee is intentionally
        // relaxed here — shadowgram is about exploring multiple
        // interpretations of the same data, not gridline alignment.
        if (histStyle === "shadowgram") {
          // Cap depth to keep series count and render cost bounded.
          const binChoices = [
            Math.max(6, Math.round(binCount * 0.5)),
            Math.max(8, Math.round(binCount * 0.75)),
            binCount,
            Math.round(binCount * 1.25),
            Math.round(binCount * 1.5),
          ];
          binChoices.forEach((bc, layerIdx) => {
            const layerYWidth = (yHi - yLo) / Math.max(1, bc);
            const layerYHalf = layerYWidth / 2;
            // Over-render this layer's bin grid OUTWARD past
            // [yLo, yHi] (same rationale as the primary bin grid
            // above). `layerYWidth` is derived from the visible
            // span — we DON'T change it — but we walk the grid
            // outward to cover [dataLo, dataHi] so off-screen
            // bars are emitted and the expanding clip region
            // can reveal them mid-drag.
            const layerExtLo = Math.min(yLo, dataLo);
            const layerExtHi = Math.max(yHi, dataHi);
            const layerGridOrigin =
              layerYWidth > 0
                ? Math.floor(layerExtLo / layerYWidth) * layerYWidth
                : yLo;
            const layerBinCount =
              layerYWidth > 0
                ? Math.max(
                    bc,
                    Math.round((layerExtHi - layerGridOrigin) / layerYWidth),
                  )
                : bc;
            const layerCenters: number[] = [];
            for (let i = 0; i < layerBinCount; i++)
              layerCenters.push(layerGridOrigin + layerYWidth * (i + 0.5));
            // Build per-cat layer counts and per-cat max for this bin
            // count (each layer is independently normalized).
            const layerCatMax = new Map<string, number>();
            const layerCatGroupCounts = new Map<string, number[]>();
            for (const cat of xCats) {
              const buckets = new Array<number>(layerBinCount).fill(0);
              // `layerBinCount` spans the full data extent (extended
              // grid above), so per-cat max read straight from
              // `buckets[]` is stable as the visible axis pans/zooms.
              let mx = 0;
              if (packetMode) {
                const baseBins = perCatPerGroup.get(cat)?.get(slot.key) ?? [];
                for (let bi = 0; bi < baseBins.length; bi++) {
                  const count = baseBins[bi] ?? 0;
                  if (count <= 0) continue;
                  const center = yCenters[bi];
                  const layerBin = Math.floor((center - layerGridOrigin) / layerYWidth);
                  if (layerBin < 0 || layerBin >= layerBinCount) continue;
                  buckets[layerBin] += count;
                  if (buckets[layerBin] > mx) mx = buckets[layerBin];
                }
              } else {
                for (const i of slot.rowIdxs) {
                  const row = data.rows[i];
                  if (isRowHidden(row)) continue;
                  const rowCat = row[xIdx] == null ? "" : String(row[xIdx]);
                  if (rowCat !== cat) continue;
                  const v = toNum(row[yIdx]);
                  if (!Number.isFinite(v)) continue;
                  const bin = Math.floor((v - layerGridOrigin) / layerYWidth);
                  // Guard kept as a floating-point safety net; the
                  // extended grid covers every valid data point.
                  if (bin < 0 || bin >= layerBinCount) continue;
                  buckets[bin]++;
                  if (buckets[bin] > mx) mx = buckets[bin];
                }
              }
              layerCatGroupCounts.set(cat, buckets);
              layerCatMax.set(cat, mx);
            }
            const layerBarInfos: HistBarInfo[] = [];
            const tuples: any[][] = [];
            for (const cat of xCats) {
              const bins = layerCatGroupCounts.get(cat) ?? [];
              const catMax = layerCatMax.get(cat) ?? 0;
              if (catMax <= 0) continue;
              for (let bi = 0; bi < bins.length; bi++) {
                if (bins[bi] <= 0) continue;
                layerBarInfos.push({
                  cat,
                  binCenter: layerCenters[bi],
                  count: bins[bi],
                  binHalfH: layerYHalf,
                  catMaxCount: catMax,
                  groupTotal: 0,
                });
                tuples.push([cat, layerCenters[bi]]);
              }
            }
            if (tuples.length === 0) return;

            series.push({
              id: `__hist_cat_${slot.key}_shadowgram_${layerIdx}`,
              type: "custom",
              name: slot.key,
              coordinateSystem: "cartesian2d",
              // See note on the sibling __hist_cat_ series above —
              // custom series default is `clip: false`, so without
              // this the shadowgram layers spill past the axis
              // during axis drag.
              clip: true,
              encode: { x: 0, y: 1, tooltip: [0, 1] },
              data: tuples,
              renderItem: (params: any, api: any) => {
                const info = layerBarInfos[params.dataIndex];
                if (!info) return null;
                return renderHistCatBar(params, api, info, {
                  fillColor,
                  strokeColor,
                  grouping: !!grouping,
                  showLabel: false,
                  showCounts: false,
                  showPercents: false,
                  theme,
                  layerOpacity: 0.18,
                  heightScale: histHeight,
                });
              },
              z: 1,
              silent: true,
              tooltip: { show: false },
              legendHoverLink: false,
            });
          });
          return;
        }

        // ——— Bar branch (default) ———
        // Per-bar info is stored in a closure-bound array because
        // ECharts custom series only allocate data dimensions up to
        // the maximum index named in `encode`, so `api.value(3+)`
        // would return NaN even though our tuples carry six values.
        // Tuples therefore carry only the two axis-relevant fields
        // (cat + bin center); everything else is looked up by
        // `params.dataIndex` from `barInfos`.
        const barInfos: HistBarInfo[] = [];
        const tuples: any[][] = [];
        for (const cat of xCats) {
          const bins = perCatPerGroup.get(cat)?.get(slot.key) ?? [];
          const catMax = perCatMaxCount.get(cat) ?? 0;
          if (catMax <= 0) continue;
          const groupTotal = perCatGroupTotal?.get(cat)?.get(slot.key) ?? 0;
          for (let bi = 0; bi < bins.length; bi++) {
            if (bins[bi] <= 0) continue;
            barInfos.push({
              cat,
              binCenter: yCenters[bi],
              count: bins[bi],
              binHalfH: yHalf,
              catMaxCount: catMax,
              groupTotal,
            });
            tuples.push([cat, yCenters[bi]]);
          }
        }
        if (tuples.length === 0) return;

        const showLabel = showCounts || showPercents;

        series.push({
          id: `__hist_cat_${slot.key}`,
          type: "custom",
          name: slot.key,
          coordinateSystem: "cartesian2d",
          // See note on the sibling __hist_cat_${slot.key}_${histStyle}
          // series above — custom series default is `clip: false`,
          // so without this the per-category bin bars spill past the
          // axis during drag-zoom / drag-pan.
          clip: true,
          encode: { x: 0, y: 1, tooltip: [0, 1] },
          data: tuples,
          renderItem: (params: any, api: any) => {
            const info = barInfos[params.dataIndex];
            if (!info) return null;
            return renderHistCatBar(params, api, info, {
              fillColor,
              strokeColor,
              grouping: !!grouping,
              showLabel,
              showCounts,
              showPercents,
              theme,
              heightScale: histHeight,
            });
          },
          // Render below scatter/box outlines so they remain readable
          // on top of the histogram bars.
          z: 1,
          silent: false,
          tooltip: {
            formatter: (p: any) => {
              const info = barInfos[p.dataIndex];
              if (!info) return "";
              return `${info.cat}<br/>bin: ${info.binCenter.toFixed(3)}<br/>count: ${info.count}`;
            },
          },
        });
      });

      if (hasNormalCurve) {
        type NormalCatInfo = { cat: string; points: [number, number][]; maxWeight: number };
        const byGroup = new Map<string, NormalCatInfo[]>();
        const maxByCat = new Map<string, number>();
        for (const slot of histGroupSlots) {
          const infos: NormalCatInfo[] = [];
          for (const cat of xCats) {
            const packetEntry = summaryPacket?.summaries.find((entry) =>
              String(entry.category ?? "") === cat &&
              (!grouping || String(entry.group ?? DEFAULT_GROUP_KEY) === slot.key)
            );
            let values: number[] = [];
            if (!packetEntry) {
              values = slot.rowIdxs
                .filter((index) => String(data.rows[index]?.[xIdx] ?? "") === cat)
                .map((index) => toNum(data.rows[index]?.[yIdx]))
                .filter(Number.isFinite);
            }
            const raw = meanStd(values);
            const points = normalCurve(
              packetEntry?.mean ?? raw.mean,
              packetEntry?.stddev ?? raw.std,
              packetEntry?.count ?? raw.n,
              yWidth,
              packetEntry?.min ?? dataLo,
              packetEntry?.max ?? dataHi,
            );
            if (points.length === 0) continue;
            let maxWeight = 0;
            for (const point of points) if (point[1] > maxWeight) maxWeight = point[1];
            infos.push({ cat, points, maxWeight });
            maxByCat.set(cat, Math.max(maxByCat.get(cat) ?? 0, maxWeight));
          }
          byGroup.set(slot.key, infos);
        }

        for (const slot of histGroupSlots) {
          const infos = byGroup.get(slot.key) ?? [];
          if (infos.length === 0) continue;
          const styleKey = grouping ? slot.key : DEFAULT_GROUP_KEY;
          const resolved = resolveGroupStyle(styleKey, slot.baseColor, !!grouping, theme, spec.styles);
          const strokeColor = resolved.line.color || slot.baseColor;
          const safeMidY = (yLo + yHi) / 2;
          const tuples = infos.map((info) => [info.cat, safeMidY]);
          series.push({
            id: `__normal_cat_${slot.key}`,
            type: "custom",
            name: slot.key,
            coordinateSystem: "cartesian2d",
            clip: true,
            data: tuples,
            renderItem: (params: any, api: any) => {
              const info = infos[params.dataIndex];
              if (!info) return null;
              const catIsX = !String(params.seriesId || "").endsWith("__t");
              const xy = (value: number): [string | number, string | number] =>
                catIsX ? [info.cat, value] : [value, info.cat];
              const center = api.coord(xy(safeMidY));
              if (!center) return null;
              const slotSize = catIsX ? api.size([1, 0])[0] : api.size([0, 1])[1];
              const maxExtent = Math.max(0, slotSize * 0.85 - 1) * histHeight;
              const maxWeight = hasHistogramEl
                ? (perCatMaxCount.get(info.cat) ?? 0)
                : (maxByCat.get(info.cat) ?? info.maxWeight);
              if (maxWeight <= 0) return null;
              const shapePoints: number[][] = [];
              for (const [value, weight] of info.points) {
                if (value < yLo || value > yHi) continue;
                const coordinate = api.coord(xy(value));
                if (!coordinate) continue;
                if (catIsX) {
                  const baseline = center[0] - slotSize / 2 + 1;
                  shapePoints.push([baseline + (weight / maxWeight) * maxExtent, coordinate[1]]);
                } else {
                  const baseline = center[1] + slotSize / 2 - 1;
                  shapePoints.push([coordinate[0], baseline - (weight / maxWeight) * maxExtent]);
                }
              }
              if (shapePoints.length < 2) return null;
              return {
                type: "polyline",
                shape: { points: shapePoints },
                style: { stroke: strokeColor, fill: null, lineWidth: 2 },
              };
            },
            z: 3,
          });
        }
      }

      // Category divider lines: JMP draws thin vertical guides at
      // each category boundary when a histogram is added, so the
      // left-anchored bars read against a clear visual edge. We use
      // ECharts' built-in category-axis `splitLine` (set on the X
      // axis below) instead of a custom-series carrier — the carrier
      // approach was unreliable because ECharts silently filters
      // custom-series rows whose value-axis dim is outside the
      // visible range, so the dividers disappeared whenever the
      // value axis was zoomed away from 0.
      perCategoryHistogramOn = true;

      if (histogramOnlyPacketMode) {
        return {
          backgroundColor: "transparent",
          textStyle: { color: theme.fgPrimary },
          grid: { left: 52, right: 16, top: 16, bottom: 56, show: true, borderColor: theme.axisLine, borderWidth: 0.5 },
          tooltip: { trigger: "item", confine: true, appendToBody: true },
          legend: undefined,
          xAxis: mergeAxis(
            {
              type: "category",
              data: xCats,
              ...axis,
              axisLabel: {
                ...(axis.axisLabel as object),
                interval: 0,
                hideOverlap: false,
              },
            },
            buildAxisOverrides(spec.xAxis, aggregateMode),
          ),
          yAxis: mergeAxis(
            {
              type: "value",
              ...axis,
              ...(Number.isFinite(yLo) ? { min: yLo } : {}),
              ...(Number.isFinite(yHi) ? { max: yHi } : {}),
            },
            buildAxisOverrides(spec.yAxis, aggregateMode),
          ),
          series,
          animationDuration: 250,
        } as EChartsOption;
      }

      // Fall through — boxplot / scatter / line layers below render
      // alongside the per-category histogram.
    } else if (xIdx >= 0) {
      // —— MODE A: exclusive vertical histogram ——
      //
      // X = bin centers (value axis), Y = "Count" (value axis).
      // Other layers don't compose with this mode so we early-return
      // the full ECharts option.

      // Bin grid is computed once on the FULL dataset (or shared facet
      // range when faceted) so stacked / overlaid per-group series
      // share identical bin centers and widths.
      const packetModeA = frameBackedAggregateMode && !!histogramPacket;
      const summaryModeA = frameBackedAggregateMode && !!summaryPacket && hasNormalCurve;
      const allXs = packetModeA || summaryModeA ? [] : data.rows.map((r) => toNum(r[xIdx]));
      // Pick bin count so bar edges align with the X axis minor-tick
      // grid (one bar per minor segment). Mirror the EXACT same path
      // the X axis takes (`xFinalBounds` block + `mergeAxis`
      // overrides further down):
      //   1. Auto-fit on RAW dataMin/dataMax via
      //      `computeNiceBounds(..., AUTO_TARGET_TICKS=10)`.
      //   2. Apply user pins RAW on top — same as `mergeAxis` →
      //      `buildAxisOverrides` spreading `cfg.min`/`cfg.max`
      //      unmodified over the auto-fit.
      // Using the raw data extent here (without `computeNiceBounds`)
      // produces a DIFFERENT span than the axis ends up with, so
      // `niceStep(span, 5)` returns a different step → bar width
      // doesn't match the minor tick step → bars misalign at certain
      // zooms (e.g. "bar width = 2× minor tick"). Replicating the
      // axis pipeline keeps both spans identical.
      let xDataLo = Infinity;
      let xDataHi = -Infinity;
      if (packetModeA) {
        if (Number.isFinite(histogramPacket.minValue as number)) xDataLo = histogramPacket.minValue as number;
        if (Number.isFinite(histogramPacket.maxValue as number)) xDataHi = histogramPacket.maxValue as number;
      }
      if ((!Number.isFinite(xDataLo) || !Number.isFinite(xDataHi)) && packetModeA) {
        for (const bin of histogramPacket.bins) {
          if (Number.isFinite(bin.binStart)) {
            if (bin.binStart < xDataLo) xDataLo = bin.binStart;
            if (bin.binStart > xDataHi) xDataHi = bin.binStart;
          }
          if (Number.isFinite(bin.binEnd)) {
            if (bin.binEnd < xDataLo) xDataLo = bin.binEnd;
            if (bin.binEnd > xDataHi) xDataHi = bin.binEnd;
          }
        }
      }
      if ((!Number.isFinite(xDataLo) || !Number.isFinite(xDataHi)) && summaryModeA) {
        for (const entry of summaryPacket.summaries) {
          if (Number.isFinite(entry.min) && entry.min < xDataLo) xDataLo = entry.min;
          if (Number.isFinite(entry.max) && entry.max > xDataHi) xDataHi = entry.max;
        }
      }
      if (!Number.isFinite(xDataLo) || !Number.isFinite(xDataHi)) {
        for (const v of allXs) {
          if (!Number.isFinite(v)) continue;
          if (v < xDataLo) xDataLo = v;
          if (v > xDataHi) xDataHi = v;
        }
      }
      const xFit = computeNiceBounds(
        Number.isFinite(xDataLo) ? xDataLo : undefined,
        Number.isFinite(xDataHi) ? xDataHi : undefined,
        collectRefLineXs(spec),
        AUTO_TARGET_TICKS,
      );
      const autoXLo = xFit ? xFit.min : (Number.isFinite(xDataLo) ? xDataLo : 0);
      const autoXHi = xFit ? xFit.max : (Number.isFinite(xDataHi) ? xDataHi : 1);
      const xPinMin = spec.xAxis?.min;
      const xPinMax = spec.xAxis?.max;
      const xLoForBins = Number.isFinite(xPinMin)
        ? (xPinMin as number)
        : autoXLo;
      const xHiForBins = Number.isFinite(xPinMax)
        ? (xPinMax as number)
        : autoXHi;
      // Tick-aligned bin grid. Two invariants must hold for bars to
      // sit on ECharts' minor tick lines:
      //   (1) `width` MUST equal ECharts' minor tick step exactly:
      //       `niceStep(span, BIN_GRID_TARGET_TICKS) / minorSplit`
      //       — i.e. the same major step ECharts auto-picks divided
      //       by the same `minorTick.splitNumber` we configure on the
      //       axis. An older version of this code re-derived width
      //       as `span / round(span/width)` after rounding the bin
      //       count to an integer, which silently shifted width off
      //       the exact minor-tick step (e.g. span=0.11 → rounded
      //       count=28 → width=0.003928 instead of the correct 0.004).
      //   (2) `gridLo` MUST snap to a multiple of `width` (= multiple
      //       of the minor tick ladder), otherwise drag-zooming to a
      //       non-nice axis min leaves bin edges at offsets ECharts'
      //       ticks never visit.
      // `histogramBins` would violate both invariants (anchors at
      // data min, derives width from rounded count), so build the
      // grid manually:
      const xMinorSplit = resolveMinorSplit(spec.xAxis);
      const xSpan = xHiForBins - xLoForBins;
      const userXStep = spec.xAxis?.tickInterval;
      const xMajorStep =
        Number.isFinite(userXStep as number) && (userXStep as number) > 0
          ? (userXStep as number)
          : niceStep(xSpan, BIN_GRID_TARGET_TICKS);
      const width =
        xMajorStep > 0 && xMinorSplit > 0 ? xMajorStep / xMinorSplit : 1;
      const gridLo = Number.isFinite(xLoForBins)
        ? Math.floor(xLoForBins / width) * width
        : 0;
      const gridHi = Number.isFinite(xHiForBins)
        ? Math.ceil(xHiForBins / width) * width
        : gridLo + width;
      const binCountA = Math.max(1, Math.round((gridHi - gridLo) / width));
      const centers: number[] = new Array(binCountA);
      for (let i = 0; i < binCountA; i++) centers[i] = gridLo + width * (i + 0.5);
      const totalCounts = new Array<number>(binCountA).fill(0);
      if (packetModeA) {
        for (const bin of histogramPacket.bins) {
          const center = (bin.binStart + bin.binEnd) / 2;
          const idx = Math.floor((center - gridLo) / width);
          if (idx < 0 || idx >= binCountA) continue;
          totalCounts[idx] += Math.max(0, Number(bin.count) || 0);
        }
      } else {
        for (const v of allXs) {
          if (!Number.isFinite(v)) continue;
          const bin = Math.floor((v - gridLo) / width);
          if (bin < 0 || bin >= binCountA) continue;
          totalCounts[bin]++;
        }
      }
      const total = packetModeA
        ? (histogramPacket.totalCount || totalCounts.reduce((a, b) => a + b, 0))
        : totalCounts.reduce((a, b) => a + b, 0);

      // Bucket a per-group slice of values onto the shared grid.
      const binOntoGrid = (vals: number[], groupKey?: string): number[] => {
        const buckets = new Array<number>(centers.length).fill(0);
        if (centers.length === 0 || width <= 0) return buckets;
        if (packetModeA) {
          for (const bin of histogramPacket.bins) {
            const packetGroup = String(bin.group ?? DEFAULT_GROUP_KEY);
            if (groupKey && packetGroup !== groupKey) continue;
            const center = (bin.binStart + bin.binEnd) / 2;
            const idx = Math.floor((center - gridLo) / width);
            if (idx < 0 || idx >= centers.length) continue;
            buckets[idx] += Math.max(0, Number(bin.count) || 0);
          }
          return buckets;
        }
        for (const v of vals) {
          if (!Number.isFinite(v)) continue;
          const bin = Math.floor((v - gridLo) / width);
          // Skip out-of-range values. Panning the axis to narrow
          // the visible range used to pile off-screen values into
          // the edge bin, producing a spurious tall bar at the
          // axis boundary; only count values that actually fall
          // inside the visible bin grid.
          if (bin < 0 || bin >= centers.length) continue;
          buckets[bin]++;
        }
        return buckets;
      };

      // Per-bin label formatter shared by bar/polygon styles. Returns empty
      // string when neither counts nor percents are requested (so ECharts
      // skips the label render entirely instead of drawing a 0-px label).
      const formatBinLabel = (count: number): string => {
        if (!showCounts && !showPercents) return "";
        const pct = total > 0 ? (count / total) * 100 : 0;
        if (showCounts && showPercents) return `${count}, ${pct.toFixed(0)}%`;
        if (showCounts) return `${count}`;
        return `${pct.toFixed(0)}%`;
      };
      const labelCfg = (showCounts || showPercents)
        ? {
            label: {
              show: true,
              // Inside-position keeps stacked-bar labels from colliding
              // with the bar above; ungrouped bars (and polygon) can sit
              // above the data point unobstructed.
              position: histStyle === "bar" && !!grouping ? "inside" : "top",
              color: theme.fgPrimary,
              fontSize: 10,
              formatter: (p: { value: [number, number] }) =>
                formatBinLabel(p.value?.[1] ?? 0),
            },
          }
        : {};

      // Emit one (or more) series per group based on the chosen style.
      // Shared `stackId` ensures grouped bars stack within each bin.
      const stackId = "__hist_stack__";
      histGroupSlots.forEach((slot) => {
        const styleKey = grouping ? slot.key : DEFAULT_GROUP_KEY;
        const rs = resolvedStyleFor(styleKey);
        const gxs = packetModeA || summaryModeA
          ? []
          : slot.rowIdxs.map((i) => toNum(data.rows[i][xIdx]));
  const groupCounts = binOntoGrid(gxs, grouping ? slot.key : undefined);

        // Resolve the visible fill color for bars. `resolveGroupStyle`
        // defaults ungrouped fill to "transparent" (so JMP-style point
        // overlays stay see-through), but a transparent histogram bar
        // is invisible — fall back to the group's base color in that
        // case. User-set fill colors still win.
        const userFill = spec.styles?.[styleKey]?.fill;
        const hasUserFill = !!(userFill?.color ?? userFill?.fillColor);
        const barFillColor = hasUserFill
          ? rs.fill.color
          : grouping
            ? rs.fill.color
            : slot.baseColor;

        // Line / area colors for polygon and KDE styles. Same fallback
        // logic: prefer the user's line override, then the resolved
        // line style, finally the base color.
        const lineColor = rs.line.color || slot.baseColor;
        const areaColor = hasUserFill ? rs.fill.color : slot.baseColor;

        if (hasHistogramEl && histStyle === "shadowgram") {
          // Multi-binCount overlay using this group's data only. Heavy
          // translucency means the union of bars reads as a "shadow"
          // density estimate — no single bin count is privileged.
          const binChoices = [10, 14, 18, 22, 26, 30];
          for (const bc of binChoices) {
            const layer = histogramBins(gxs, bc);
            series.push({
              type: "bar",
              name: slot.key,
              data: layer.centers.map((c, i) => [c, layer.counts[i]]),
              barWidth: "99%",
              itemStyle: { color: lineColor, opacity: 0.15 },
              silent: true,
              tooltip: { show: false },
              legendHoverLink: false,
            });
          }
        } else if (hasHistogramEl && histStyle === "polygon") {
          // Frequency polygon: line through bin-top points. Phantom
          // zero anchors at each end close the polygon back to the
          // axis (matches JMP's polygon style).
          const polyData: [number, number][] = [
            [centers[0] - width, 0],
            ...centers.map((c, i) => [c, groupCounts[i]] as [number, number]),
            [centers[centers.length - 1] + width, 0],
          ];
          series.push({
            type: "line",
            name: slot.key,
            data: polyData,
            showSymbol: showCounts || showPercents, // need symbols to host labels
            symbolSize: 4,
            lineStyle: { color: lineColor, width: 2 },
            itemStyle: { color: lineColor },
            ...labelCfg,
          });
        } else if (hasHistogramEl && histStyle === "kde") {
          // Smoothed kernel density curve scaled to count-per-bin so it
          // shares the Y axis with a count histogram. Each group's
          // curve is scaled by its OWN count, so a small group's curve
          // has proportionally smaller area than a large group's.
          const kde = kdeCurve(gxs, smoothness, width);
          series.push({
            type: "line",
            name: slot.key,
            data: kde,
            showSymbol: false,
            smooth: true,
            lineStyle: { color: lineColor, width: 2 },
            itemStyle: { color: lineColor },
            areaStyle: { color: areaColor, opacity: grouping ? 0.12 : 0.18 },
          });
        } else if (hasHistogramEl) {
          // Default: filled bar histogram. Stacked when grouped so
          // each bin shows the per-group contribution as a segment.
          series.push({
            type: "bar",
            name: slot.key,
            data: centers.map((c, i) => [c, groupCounts[i]]),
            barWidth: "99%",
            itemStyle: { color: barFillColor },
            ...(grouping ? { stack: stackId } : {}),
            ...labelCfg,
          });
        }

        if (hasNormalCurve) {
          const packetSummary = summaryPacket?.summaries.find((entry) =>
            !grouping || String(entry.group ?? DEFAULT_GROUP_KEY) === slot.key
          );
          const rawSummary = meanStd(gxs);
          const points = normalCurve(
            packetSummary?.mean ?? rawSummary.mean,
            packetSummary?.stddev ?? rawSummary.std,
            packetSummary?.count ?? rawSummary.n,
            width,
            packetSummary?.min ?? xDataLo,
            packetSummary?.max ?? xDataHi,
          );
          if (points.length > 0) {
            series.push({
              id: `__normal_curve_${slot.key}`,
              type: "line",
              name: slot.key,
              data: points,
              showSymbol: false,
              smooth: true,
              lineStyle: { color: lineColor, width: 2 },
              itemStyle: { color: lineColor },
              z: 3,
            });
          }
        }
      });

      const refCarrierY = buildRefLinesCarrier(normalizeRefLinesY(spec.refLinesY), spec.autoSpecY, theme, "y");
      if (refCarrierY) series.push(refCarrierY);
      // Histogram X is always a value-type axis (binned numeric data),
      // so any user-defined X ref lines render here as vertical markers.
      const refCarrierX = buildRefLinesCarrier(normalizeRefLinesX(spec.refLinesX), spec.autoSpecX, theme, "x");
      if (refCarrierX) series.push(refCarrierX);

      if (packetModeA && Number(histogramPacket.totalCount) === 0 && series.length === 0) {
        const fallbackRows = histogramPacket.bins
          .map((bin) => [
            (bin.binStart + bin.binEnd) / 2,
            Math.max(0, Number(bin.count) || 0),
          ] as [number, number])
          .sort((a, b) => a[0] - b[0]);
        if (fallbackRows.length > 0) {
          series.push({
            id: "__hist_packet_fallback_mode_a",
            type: "bar",
            name: i18next.t("graph.frequency"),
            data: fallbackRows,
            barGap: "0%",
            z: 1,
          });
        }
      }

      return {
        backgroundColor: "transparent",
        textStyle: { color: theme.fgPrimary },
        // `grid.show:true` draws a rectangle around the plot area so the
        // top + right edges are bounded. The left + bottom already get
        // drawn by the value-axis `axisLine`, but ECharts paints both at
        // the same color (`theme.axisLine`); `borderWidth: 0.5` keeps
        // the new top/right edges visually equal to the 1px axisLine
        // (the grid border is rendered as a stroked rect, so its width
        // straddles the rect boundary and effectively reads ~1 device
        // pixel at width 0.5).
        grid: {
          left: 56,
          right: 24,
          top: 32,
          bottom: 48,
          show: true,
          borderColor: theme.axisLine,
          borderWidth: 0.5,
        },
        // appendToBody + confine: rendering the tooltip into document.body
        // keeps it from briefly enlarging the chart container (which made
        // the parent's overflow:auto flash a 1-px scrollbar at the bottom
        // edge); `confine` then keeps the tooltip inside the chart's
        // bounding box so it still visually anchors to the data point.
        tooltip: { trigger: "axis", confine: true, appendToBody: true },
        xAxis: mergeAxis(
          {
            type: "value",
            name: xField?.name,
            nameLocation: "middle",
            nameGap: 28,
            ...axis,
            // Auto-enable minor ticks — mirrors the main path so an
            // exclusive histogram chart inherits the same denser grid
            // by default. User overrides still win via mergeAxis. The
            // `...axis.minorTick` spread preserves theme.minorTick.
            // lineStyle (color + 0.5px width) so minor tick marks
            // render at the same stroke width as the majors instead
            // of ECharts' default 1px (which made them look thicker).
            minorTick: { ...(axis.minorTick as object | undefined), show: true, splitNumber: AUTO_MINOR_SPLIT },
            // Faceted histograms still benefit from a shared X span so the
            // bin centers are visually comparable across panels.
            ...(sharedRanges?.xMin != null ? { min: sharedRanges.xMin } : {}),
            ...(sharedRanges?.xMax != null ? { max: sharedRanges.xMax } : {}),
            // Single-panel: expand auto-fit so vertical ref lines drawn
            // outside the data extent stay visible. The shared-range
            // spreads above already include refXs via computeSharedRanges,
            // so this only matters when those are absent.
            ...(sharedRanges?.xMin == null && sharedRanges?.xMax == null
              ? buildXAxisRefLineExpand(collectRefLineXs(spec))
              : {}),
          },
          buildAxisOverrides(spec.xAxis, aggregateMode),
        ),
        yAxis: mergeAxis(
          {
            type: "value",
            name: i18next.t("graph.frequency"),
            nameLocation: "middle",
            nameGap: 40,
            ...axis,
            // Auto-enable minor ticks on the frequency axis too.
            // See the X-axis comment above for the spread rationale.
            minorTick: { ...(axis.minorTick as object | undefined), show: true, splitNumber: AUTO_MINOR_SPLIT },
            // Expand auto-fit so ref lines (manual or auto-spec) stay
            // visible on the frequency axis. User-pinned min/max from
            // `buildAxisOverrides` still wins via the merge spread.
            ...buildYAxisRefLineExpand(collectRefLineYs(spec)),
          },
          buildAxisOverrides(spec.yAxis, aggregateMode),
        ),
        series,
        animationDuration: 250,
        _binWidth: width, // 调试用
      } as EChartsOption;
    }

    // Safety net for packet-backed mode: if style-specific histogram logic
    // emitted no series, synthesize a packet-derived fallback so frame-backed
    // transforms never regress to an empty histogram layer.
    if (
      frameBackedAggregateMode &&
      histogramPacket &&
      histogramPacket.totalCount === 0 &&
      series.length === histogramSeriesStart
    ) {
      if (xIsCategory) {
        const totalsByCategory = new Map<string, number>();
        for (const bin of histogramPacket.bins) {
          const category = String(bin.category ?? "");
          if (!category) continue;
          totalsByCategory.set(category, (totalsByCategory.get(category) ?? 0) + Math.max(0, Number(bin.count) || 0));
        }
        if (totalsByCategory.size > 0) {
          const fallbackCats = xCats.length > 0 ? xCats : Array.from(totalsByCategory.keys());
          series.push({
            id: "__hist_packet_fallback_cat",
            type: "bar",
            name: yField?.name || "histogram",
            data: fallbackCats.map((cat) => totalsByCategory.get(cat) ?? 0),
            z: 1,
          });
        }
      } else {
        const byCenter = new Map<number, number>();
        for (const bin of histogramPacket.bins) {
          const center = (bin.binStart + bin.binEnd) / 2;
          byCenter.set(center, (byCenter.get(center) ?? 0) + Math.max(0, Number(bin.count) || 0));
        }
        if (byCenter.size > 0) {
          const rows = Array.from(byCenter.entries()).sort((a, b) => a[0] - b[0]);
          series.push({
            id: "__hist_packet_fallback_val",
            type: "bar",
            name: yField?.name || "histogram",
            data: rows.map(([center, count]) => [center, count]),
            barGap: "0%",
            z: 1,
          });
        }
      }
    }
  }

  // —— 箱线图：X 分类，Y 连续。作为一个可与点图/线图叠加的图层，
  //   不再 early-return，而是直接 push 到共享的 series 数组中。
  //
  // When an Overlay/Color column is set, the box plot splits into one
  // box series per group, rendered side-by-side within each X category
  // (matching how the right-side legend panel lists those groups). With
  // no grouping we fall back to a single box per X category.
  if (hasBoxplot && yIdx >= 0) {
    const boxEl = enabledElements.find((e) => e.kind === "boxplot")!;
    const opts = boxEl.options;
    const showOutliers = getOpt<boolean>(opts, "outliers", true);
    const boxType = getOpt<string>(opts, "boxType", "outlier");
    const showFiveNum = getOpt<boolean>(opts, "fiveNumberSummary", false);
    const widthProp = Math.max(0, Math.min(1, getOpt<number>(opts, "widthProportion", 0)));

    if (boxPlotPacket && boxPlotPacket.entries.length > 0) {
      const maxBoxPx = 60 + widthProp * 80;
      const boxIterGroups: string[] = grouping ? groupKeys : [DEFAULT_GROUP_KEY];
      boxIterGroups.forEach((gKey) => {
        if (isHidden(gKey)) return;
        const seriesName = grouping ? gKey : (yField?.name ?? "");
        const styleKey = grouping ? gKey : DEFAULT_GROUP_KEY;
        const groupColor = grouping
          ? theme.categorical[colorIndexOf(gKey) % theme.categorical.length]
          : theme.categorical[0];
        const boxGroupStyle = resolvedStyleFor(styleKey);
        const userFill = spec.styles?.[styleKey]?.fill;
        const hasUserFill = !!(userFill?.color ?? userFill?.fillColor);
        const neutralBoxFill = shade("#000000", SHADE_RATIO_FILL);
        const effectiveBoxFillColor = hasUserFill
          ? boxGroupStyle.fill.color
          : grouping
            ? shade(groupColor, SHADE_RATIO_FILL)
            : neutralBoxFill;

        const byCategory = new Map<string, (typeof boxPlotPacket.entries)[number]>();
        for (const entry of boxPlotPacket.entries) {
          const entryGroup = entry.group ?? DEFAULT_GROUP_KEY;
          if (entryGroup !== gKey && !(gKey === DEFAULT_GROUP_KEY && !grouping)) continue;
          const category = entry.category ?? "";
          if (!byCategory.has(category)) {
            byCategory.set(category, entry);
          }
        }

        const boxData: Array<[number, number, number, number, number] | { value: string }> = [];
        const outlierPts: Array<[string, number]> = [];
        const labelMarks: Array<{ x: string; y: number; text: string }> = [];

        for (const cat of xCats) {
          const entry = byCategory.get(cat);
          if (!entry) {
            boxData.push({ value: "-" });
            continue;
          }
          const lower = boxType === "outlier" ? entry.whiskerLow : entry.min;
          const upper = boxType === "outlier" ? entry.whiskerHigh : entry.max;
          boxData.push([lower, entry.q1, entry.median, entry.q3, upper]);
          if (showOutliers) {
            for (const outlier of entry.outliers) {
              outlierPts.push([displayCat(cat), outlier.value]);
            }
          }
          if (showFiveNum && !grouping) {
            const dx = displayCat(cat);
            labelMarks.push({ x: dx, y: entry.median, text: `${entry.median.toFixed(2)}` });
            labelMarks.push({ x: dx, y: entry.q1, text: `Q1 ${entry.q1.toFixed(2)}` });
            labelMarks.push({ x: dx, y: entry.q3, text: `Q3 ${entry.q3.toFixed(2)}` });
          }
        }

        series.push({
          type: "boxplot",
          name: seriesName,
          data: boxData,
          boxWidth: [10, maxBoxPx],
          clip: true,
          itemStyle: {
            color: withAlpha(effectiveBoxFillColor, boxGroupStyle.fill.opacity),
            borderColor: withAlpha(boxGroupStyle.line.color, boxGroupStyle.line.opacity),
            borderWidth: boxGroupStyle.line.width,
          },
          z: 1,
        });
        if (outlierPts.length > 0) {
          series.push({
            type: "scatter",
            name: seriesName,
            data: outlierPts,
            symbolSize: boxGroupStyle.outlier.size,
            itemStyle: { color: boxGroupStyle.outlier.color, opacity: boxGroupStyle.outlier.opacity },
            z: 3,
          });
        }
        if (labelMarks.length > 0) {
          series.push({
            type: "scatter",
            name: "5-Number",
            data: labelMarks.map((l) => [l.x, l.y]),
            symbolSize: 0.1,
            label: {
              show: true,
              position: "right",
              color: theme.fgSecondary,
              fontSize: 10,
              formatter: (params: any) => labelMarks[params.dataIndex]?.text ?? "",
            },
            silent: true,
            z: 4,
          });
        }
      });
    } else if (!frameBackedAggregateMode) {

    const xGroups = reorderMapByValueOrder(groupBy(data, xField), xField ? valueOrders?.[xField.name] : undefined);
    // Iterate the AXIS category list (xCats) rather than xGroups.keys()
    // so boxData indices line up with the axis slots. xCats already
    // drops categories with zero finite-Y rows (EV2), which would
    // otherwise push a `{value:'-'}` marker into the wrong slot and
    // displace every subsequent box (e.g. DV → EV2's empty slot).
    const boxCats = xCats;

    // JMP-style: boxes fill most of the category band by default. The pixel
    // cap below is generous (relative to a typical 80–150px bandwidth) so
    // ECharts can grow boxes wide; the user-controlled `widthProp` (0..1)
    // scales an extra padding allowance on top of the wide default.
    const maxBoxPx = 60 + widthProp * 80;

    // Outer iteration: one box series per overlay/color group when grouping
    // is active, otherwise a single "default" series. Each series shares
    // the same X categories so ECharts dodges them within each bucket.
    const boxIterGroups: string[] = grouping ? groupKeys : [DEFAULT_GROUP_KEY];

    boxIterGroups.forEach((gKey) => {
      // Skip groups hidden via the legend show/hide toggle.
      if (isHidden(gKey)) return;
      const groupColor = grouping
        ? theme.categorical[colorIndexOf(gKey) % theme.categorical.length]
        : theme.categorical[0];
      const groupRowSet = grouping ? new Set(groups.get(gKey) ?? []) : null;

      const boxData: Array<[number, number, number, number, number] | { value: string }> = [];
      const outlierPts: Array<[string, number]> = [];
      const labelMarks: Array<{ x: string; y: number; text: string }> = [];

      boxCats.forEach((cat) => {
        let idxs = xGroups.get(cat) ?? [];
        if (groupRowSet) idxs = idxs.filter((i) => groupRowSet.has(i));
        const ys = idxs.map((i) => toNum(data.rows[i][yIdx])).filter(Number.isFinite);
        if (ys.length === 0) {
          // Empty (X-category × overlay-group) cell: emit ECharts'
          // documented missing-data marker `{value: '-'}` so the slot
          // renders as a gap instead of `[0,0,0,0,0]` (which would draw
          // a phantom flat box pinned at y=0). NOTE: a plain `null`
          // crashes whiskerBoxCommon.js — it tries to read `.value` on
          // the data item — so we must keep the object wrapper.
          //
          // With the xCats-driven iteration above, this branch only
          // fires when an overlay/color group has no data in a
          // category that DOES have data globally (e.g. EV1 has DV
          // rows but EV2 doesn't); never for cats that have no data
          // anywhere — those are already gone from xCats.
          boxData.push({ value: "-" });
          return;
        }
        const stats = boxStats(ys)!;
        const [absMin, q1, med, q3, absMax] = stats;
        const iqr = q3 - q1;
        let lower = absMin;
        let upper = absMax;
        if (boxType === "outlier") {
          const lo = q1 - 1.5 * iqr;
          const hi = q3 + 1.5 * iqr;
          const inRange = ys.filter((v) => v >= lo && v <= hi);
          if (inRange.length > 0) {
            // Single-pass min/max; avoids Math.min/max(...inRange) overflow
            // when a category contains very many in-range points.
            let mn = Infinity;
            let mx = -Infinity;
            for (let i = 0; i < inRange.length; i++) {
              const v = inRange[i];
              if (v < mn) mn = v;
              if (v > mx) mx = v;
            }
            lower = mn;
            upper = mx;
          }
          if (showOutliers) {
            for (const v of ys) {
              if (v < lo || v > hi) outlierPts.push([displayCat(cat), v]);
            }
          }
        }
        boxData.push([lower, q1, med, q3, upper]);
        // Only label the 5-number summary when there's a single box per
        // category — with grouped boxes the labels would overlap.
        if (showFiveNum && !grouping) {
          const dx = displayCat(cat);
          labelMarks.push({ x: dx, y: med, text: `${med.toFixed(2)}` });
          labelMarks.push({ x: dx, y: q1, text: `Q1 ${q1.toFixed(2)}` });
          labelMarks.push({ x: dx, y: q3, text: `Q3 ${q3.toFixed(2)}` });
        }
      });

      // The box body uses the group's `fill` sub-mark; the box border /
      // median / whisker line use the `line` sub-mark. Outliers use the
      // group's `point` sub-mark.
      const styleKey = grouping ? gKey : DEFAULT_GROUP_KEY;
      const boxGroupStyle = resolvedStyleFor(styleKey);
      // Box plots are special: the fill IS the primary mark, not an
      // overlay on top of a stroke layer (as with points / lines / bars).
      // `resolveGroupStyle` defaults ungrouped fill to "transparent" to
      // preserve the JMP scatter/line look, which renders boxes invisible
      // in single-color box plots. Substitute a visible default when the
      // user hasn't explicitly set a fill — chosen so that the cleared /
      // post-Reset rendering is *identical* to applying the first preset
      // theme (theme[0]) in the panel:
      //   - Grouped: lighten each group's categorical color (per-group
      //     differentiation; matches how grouped legend swatches resolve).
      //   - Ungrouped: shade('#000000', 0.55) = FILL_PALETTE[0], i.e. the
      //     exact fill color that theme[0] would write. Using
      //     theme.fgPrimary here instead produced a slightly different
      //     grey (#9898a1 vs #8c8c8c) which made Reset look like it
      //     produced a *different* state than the swatch-highlighted theme.
      //  User overrides from the Fill picker (or an applied theme) still
      //  win because `hasUserFill` short-circuits both branches.
      const userFill = spec.styles?.[styleKey]?.fill;
      const hasUserFill = !!(userFill?.color ?? userFill?.fillColor);
      const neutralBoxFill = shade("#000000", SHADE_RATIO_FILL);
      const effectiveBoxFillColor = hasUserFill
        ? boxGroupStyle.fill.color
        : grouping
          ? shade(groupColor, SHADE_RATIO_FILL)
          : neutralBoxFill;
      const seriesName = grouping ? gKey : (yField?.name ?? "");

      series.push({
        type: "boxplot",
        name: seriesName,
        data: boxData,
        boxWidth: [10, maxBoxPx],
        // Boxplot defaults to `clip: false` (unlike scatter / line /
        // standard bar). Without this opt-in, the box body and
        // whiskers stay visible past the axis line during drag-zoom
        // / drag-pan and only clip after mouseup commits a full
        // rebuild. Scatter live-clips because its own default is
        // `clip: true`.
        clip: true,
        // ECharts' top-level `itemStyle.opacity` applies to *both* the
        // fill color and the border, so we bake the per-mark alphas into
        // the colors themselves via rgba() and leave `opacity` unset.
        // Result: Fill opacity affects only the box body; Line opacity
        // affects only the box border / median / whiskers.
        itemStyle: {
          color: withAlpha(effectiveBoxFillColor, boxGroupStyle.fill.opacity),
          borderColor: withAlpha(boxGroupStyle.line.color, boxGroupStyle.line.opacity),
          borderWidth: boxGroupStyle.line.width,
        },
        z: 1,
      });
      if (outlierPts.length > 0) {
        series.push({
          type: "scatter",
          // Attach outliers to the parent group's legend entry so toggling
          // the group in the legend hides its outliers too.
          name: seriesName,
          data: outlierPts,
          symbolSize: boxGroupStyle.outlier.size,
          // Outliers default to a small gray dot when ungrouped (JMP look);
          // when grouped, they inherit the group's point color so the
          // viewer can tell which group an extreme value belongs to.
          itemStyle: { color: boxGroupStyle.outlier.color, opacity: boxGroupStyle.outlier.opacity },
          z: 3,
        });
      }
      if (labelMarks.length > 0) {
        series.push({
          type: "scatter",
          name: "5-Number",
          data: labelMarks.map((l) => [l.x, l.y]),
          symbolSize: 0.1,
          label: {
            show: true,
            position: "right",
            color: theme.fgSecondary,
            fontSize: 10,
            formatter: (params: any) => labelMarks[params.dataIndex]?.text ?? "",
          },
          silent: true,
          z: 4,
        });
      }
    });
    }
  }

  // —— 通用 X-Y 元素：points / line / bar / smoother ——
  let panelJitterXBandwidth = 640;
  if (!frame) {
    const visibleXValues: Array<number | string> = [];
    for (const row of data.rows) {
      if (isRowHidden(row)) continue;
      const y = yIdx >= 0 ? toNum(row[yIdx]) : NaN;
      if (!Number.isFinite(y)) continue;
      if (useRowIdxX) {
        visibleXValues.push("");
        continue;
      }
      const rawX = row[xIdx];
      if (isMissing(rawX)) continue;
      if (xIsTime) {
        const timestamp = rawX instanceof Date ? rawX.getTime() : Date.parse(String(rawX));
        if (Number.isFinite(timestamp)) visibleXValues.push(timestamp);
      } else if (xIsCategory) {
        visibleXValues.push(String(rawX));
      } else {
        const x = toNum(rawX);
        if (Number.isFinite(x)) visibleXValues.push(x);
      }
    }
    const jitterAxisMin = Number.isFinite(spec.xAxis?.min)
      ? spec.xAxis!.min!
      : sharedRanges?.xMin;
    const jitterAxisMax = Number.isFinite(spec.xAxis?.max)
      ? spec.xAxis!.max!
      : sharedRanges?.xMax;
    const xExtent = Number.isFinite(jitterAxisMin)
      && Number.isFinite(jitterAxisMax)
      ? { min: jitterAxisMin!, max: jitterAxisMax! }
      : undefined;
    panelJitterXBandwidth = estimateJitterXBandwidth(
      visibleXValues,
      xIsCategory ? "nominal" : xIsTime ? "datetime" : "continuous",
      640,
      xIsCategory ? xCats.length : undefined,
      xExtent,
    );
  }

  const emittedPrecomputedSeriesIds = new Set<string>();
  groupKeys.forEach((gKey) => {
    // Skip groups hidden via the legend show/hide toggle.
    if (isHidden(gKey)) return;
    const color = theme.categorical[colorIndexOf(gKey) % theme.categorical.length];
    const rowIdxs = groups.get(gKey)!;
    const seriesName = grouping ? gKey : (yField?.name || "");

    // Resolve {line, fill, point, outlier} for this group exactly once.
    // The per-element renderers below pull from this resolved style so
    // changing it in the UI affects every active layer simultaneously.
    const styleKey = grouping ? gKey : DEFAULT_GROUP_KEY;
    const resolvedStyle = resolvedStyleFor(styleKey);

    enabledElements.forEach((el) => {
      const elementId = getOpt<string>(el.options, "elementId", "");
      if (frameBackedAggregateMode && elementId.length > 0) {
        if (el.kind === "points") {
          const pointPackets = findPrecomputedPointPackets(aggregatePackets, elementId);
          if (pointPackets.length > 0) {
            for (const pointPacket of pointPackets) {
              const emittedSeriesId = pointPacket.seriesId ?? pointPacket.elementId;
              if (emittedPrecomputedSeriesIds.has(emittedSeriesId)) continue;
              series.push(buildPrecomputedPointSeries(pointPacket, seriesName, resolvedStyle));
              emittedPrecomputedSeriesIds.add(emittedSeriesId);
            }
            return;
          }
        }
        if (el.kind === "line") {
          const curvePackets = findPrecomputedCurvePackets(aggregatePackets, elementId);
          if (curvePackets.length > 0) {
            for (const curvePacket of curvePackets) {
              const emittedSeriesId = curvePacket.seriesId ?? curvePacket.elementId;
              if (emittedPrecomputedSeriesIds.has(emittedSeriesId)) continue;
              series.push(buildPrecomputedCurveSeries(curvePacket, seriesName, resolvedStyle));
              emittedPrecomputedSeriesIds.add(emittedSeriesId);
            }
            return;
          }
        }
      }
      if (
        frame &&
        el.kind === "points" &&
        getOpt<string>(el.options, "summaryStat", "none") === "none"
      ) {
        return;
      }
      const built = buildElementSeries(el, rowIdxs, data, {
        xIdx,
        yIdx,
        sizeIdx,
        xIsCategory,
        xIsTime,
        seriesName,
        color,
        grouping: !!grouping,
        theme,
        style: resolvedStyle,
        summaryPacket,
        groupKey: grouping ? gKey : null,
        requireSummaryPacket: frameBackedAggregateMode,
        jitterXBandwidth: panelJitterXBandwidth,
      });
      if (built) series.push(...built);
    });
  });

  if (frame) {
    const frameScatter = buildFrameBackedScatterSeries(
      spec,
      frame,
      panelFacet,
      theme,
      valueOrders,
      sharedRanges,
      resolvedFrameScatterCoordinates,
    );
    series.push(...frameScatter.series);
    framePointExtents = frameScatter.extents;
  }

  // The X/Y slot chips outside the canvas already label the axes, so we
  // intentionally omit `name` on the ECharts axes to avoid duplication.
  // xCats was computed early (just after isRowHidden) so the boxplot
  // iteration above could use the same list — see the comment there
  // for why that alignment matters.
  //
  // Rotation / wrap / bottom-gap metrics MUST be computed off the
  // cross-panel category UNION when faceted (sharedRanges.xCats), not
  // off the per-panel xCats. Otherwise each panel makes its own
  // rotate/wrap decision against its own (often single-element) local
  // list — panels with longer labels rotate, the others don't, and
  // bottomGap diverges. The result is different plot-area heights
  // across faceted panels, which breaks side-by-side Y-axis
  // comparison (the same bug class as the per-panel auto Y range
  // we already guard against in computeSharedRanges).
  const xDecisionCats = (xIsCategory && sharedRanges?.xCats) ? sharedRanges.xCats : xCats;
  const xMaxLines = xIsCategory ? maxWrapLines(xDecisionCats, 16) : 1;
  // Rotate only when wrapping doesn't already break long labels onto
  // multiple lines — wrapped labels read better horizontally.
  const xRotated = xIsCategory && xMaxLines === 1 && needsRotation(xDecisionCats);
  const bottomGap = xIsCategory
    ? (xRotated ? 56 : 28) + Math.max(0, xMaxLines - 1) * 14
    : 28;

  // Resolve final X-axis bounds + tick interval for the VALUE-type X
  // branch (continuous numeric X — scatter / line / bar paths with a
  // quantitative X binding). Mirrors the yFinalBounds block below so
  // both axes get nice-snapped labels (e.g. 0.0 / 0.5 / 1.0 instead
  // of 0.2228965400000001 at the canvas edge) and a denser default
  // tick density (~8 ticks). Category and time axes keep their
  // existing behavior — categories use the data list, time uses
  // ECharts' built-in time picker plus any sharedRanges extent.
  //   - Faceted: pin to sharedRanges.x{Min,Max} only — see the
  //     yFinalBounds block below for why `sharedRanges.xInterval` is
  //     intentionally NOT spread here.
  //   - Single panel: nice-fit over visible (non-hidden) rows; falls
  //     back to `scale: true` when there's no finite X data so ECharts
  //     auto-fits without forcing the axis to include 0.
  let xFinalBounds: EChartsOption = {};
  if (!xIsCategory && !xIsTime && xField) {
    if (sharedRanges?.xMin != null || sharedRanges?.xMax != null) {
      // Pad axis bounds by HALF A MINOR interval (major / (AUTO_MINOR_SPLIT * 2))
      // so the axis ends BETWEEN the last labeled major tick and the
      // first minor tick beyond it. ECharts auto-extends minor ticks
      // past the last major tick to fill the visible axis, so a
      // bigger pad would leave one or two unlabeled minor stubs at
      // the very top/right of the plot frame — exactly the artifact
      // the user reported. This tiny pad is visually imperceptible
      // (~0.5 % of the axis span at default densities) but pushes the
      // boundary off every tick grid.
      //
      // Rationale for picking pad over `customValues`: pinning
      // customValues makes major tick MARKS land at our positions but
      // leaves splitLine + minorTick driven by ECharts'
      // scale.getTicks(), which uses an independently-computed
      // interval. The two sources disagree → "majors and minors
      // looked like two separate things". The pad approach lets
      // ECharts auto-tick the WHOLE axis from a single source so
      // every tick / gridline / minor is aligned by construction.
      const xPad = (sharedRanges.xInterval ?? 0) / (AUTO_MINOR_SPLIT * 2);
      if (sharedRanges.xMin != null) xFinalBounds.min = sharedRanges.xMin - xPad;
      if (sharedRanges.xMax != null) xFinalBounds.max = sharedRanges.xMax + xPad;
      // Deliberately NOT spreading sharedRanges.xInterval — see the
      // matching note in yFinalBounds. With identical min/max across
      // panels, ECharts' auto-tick picks an identical interval; pinning
      // would re-introduce the Phase-4 drag bug where setOption merges
      // keep the old step alive after a drag changes min/max, making
      // tick values drift off the nice grid.
    } else {
      let dataMin = Infinity;
      let dataMax = -Infinity;
      if (framePointsOnly && framePointExtents?.x) {
        dataMin = framePointExtents.x.min;
        dataMax = framePointExtents.x.max;
      } else if (xIdx >= 0) {
        for (const r of data.rows) {
          if (isRowHidden(r)) continue;
          const v = toNum(r[xIdx]);
          if (Number.isFinite(v)) {
            if (v < dataMin) dataMin = v;
            if (v > dataMax) dataMax = v;
          }
        }
      }
      const fit = computeNiceBounds(
        Number.isFinite(dataMin) ? dataMin : undefined,
        Number.isFinite(dataMax) ? dataMax : undefined,
        collectRefLineXs(spec),
        AUTO_TARGET_TICKS,
      );
      // Emit only the snapped min/max bounds — let ECharts auto-pick
      // the tick interval. Pinning `fit.interval` here baked a stale
      // step into the option that survived setOption merges when the
      // user dragged to a new range, producing the asymmetric and
      // mis-aligned tick labels seen in earlier rounds. With min/max
      // already on a clean grid via computeNiceBounds, ECharts'
      // auto-tick picks identical positions on initial render.
      //
      // Half-MINOR-interval pad — see sharedRanges branch above for
      // the rationale. Pushes the axis bounds OFF the tick grid so
      // ECharts doesn't stamp a tick (major OR minor) at the very
      // top/right of the plot frame.
      xFinalBounds = fit
        ? {
            min: fit.min - fit.interval / (AUTO_MINOR_SPLIT * 2),
            max: fit.max + fit.interval / (AUTO_MINOR_SPLIT * 2),
          }
        : { scale: true };
    }
  }
  const frameTimeExtent = framePointsOnly ? framePointExtents?.x : undefined;
  const xAxisBase = xIsCategory
    ? {
        type: "category",
        // 收集所有 X 类目（按出现顺序）
        data: xCats,
        ...axis,
        axisLabel: {
          ...(axis.axisLabel as object),
          // Force every category label to render — ECharts otherwise hides
          // overlapping ones, which can drop most ticks for long names.
          interval: 0,
          rotate: xRotated ? 30 : 0,
          hideOverlap: false,
          // Wrap long labels onto multiple lines instead of truncating with "…".
          formatter: (v: string) => wrapLabel(v, 16),
          lineHeight: 13,
          // The shared `axis.axisLabel` default hides min/max labels for
          // value-type axes (to suppress ugly float boundary values).
          // On a category axis those would silently drop the first AND
          // last category labels — restore them here.
          showMinLabel: true,
          showMaxLabel: true,
        },
        // Per-category histogram (MODE C) divider lines. ECharts'
        // built-in category-axis `splitLine` draws a hairline at every
        // category BOUNDARY (between adjacent slots) which is exactly
        // the JMP-style "thin separator between histogram cells" the
        // user wants. We render lighter than JMP's near-black guide
        // — `axisLine` (#c0c0c0) at half opacity gives a subtle
        // visual break without competing with the bars or scatter.
        // User overrides from `buildAxisOverrides` still win via the
        // merge spread below if the user explicitly turns splitLine
        // off, so this only ADDS the default styling.
        ...(perCategoryHistogramOn
          ? {
              splitLine: {
                show: true,
                interval: 0,
                lineStyle: {
                  color: theme.axisLine,
                  width: 1,
                  opacity: 0.5,
                },
              },
            }
          : {}),
      }
    : xIsTime
      ? {
          type: "time",
          ...axis,
          // Auto-enable minor ticks on the time axis so the chart
          // matches the value-axis density without forcing the user
          // to opt in. Explicit overrides from `buildAxisOverrides`
          // (including `minorTickCount = 0` for off) still win via
          // `mergeAxis` below. The `...axis.minorTick` spread
          // preserves theme.minorTick.lineStyle (color + 0.5px width)
          // so minor ticks match the major tick stroke instead of
          // rendering at ECharts' default 1px.
          minorTick: { ...(axis.minorTick as object | undefined), show: true, splitNumber: AUTO_MINOR_SPLIT },
          // Pin to shared bounds when faceted so every panel's time axis
          // covers the same span.
          ...(sharedRanges?.xMin != null
            ? { min: sharedRanges.xMin }
            : frameTimeExtent ? { min: frameTimeExtent.min } : {}),
          ...(sharedRanges?.xMax != null
            ? { max: sharedRanges.xMax }
            : frameTimeExtent ? { max: frameTimeExtent.max } : {}),
        }
      : {
          type: "value",
          ...axis,
          // Auto-enable minor ticks on continuous value axes so
          // unconfigured charts read with the same minor-tick density
          // the user can otherwise dial in manually. Categorical axes
          // skip this (above) because minor sub-ticks between adjacent
          // category slots have no meaningful interpretation. The
          // `...axis.minorTick` spread preserves theme lineStyle
          // (color + 0.5px width) — see X-time branch above.
          minorTick: { ...(axis.minorTick as object | undefined), show: true, splitNumber: AUTO_MINOR_SPLIT },
          // Pre-computed bounds (faceted shared OR local nice-snap fit).
          // `scale: true` is encoded INSIDE xFinalBounds when no fit
          // was produced; we don't emit it unconditionally because it
          // would expand explicit bounds outward.
          ...xFinalBounds,
        };
  // User overrides (range / ticks / decimals / inverse / grid …) come
  // through `mergeAxis` so deep-nested keys like `axisLine.lineStyle`
  // survive instead of being clobbered by the user's `axisLine.show`.
  // The deep merge order is base → user, so user-pinned scalars (min,
  // max, interval) win over the auto-fit values baked into the base.
  const xAxis = mergeAxis(xAxisBase, buildAxisOverrides(spec.xAxis, aggregateMode));

  // Append user-defined reference line carriers. Two separate carriers
  // (one per axis) so each can be silently skipped when its axis isn't
  // value-type:
  //   - Y carrier: always safe here — the horizontal-mode short-circuit
  //     above has already redirected the build when Y is categorical,
  //     so any code path that reaches this point has a value-type Y.
  //   - X carrier: only emit when the rendered X is value-type. Skipping
  //     for category / row-index / boxplot-forced category axes; ECharts
  //     would still try to render a markLine at xAxis: numeric on a
  //     category axis (silently aligning to the wrong band or to the
  //     leftmost slot) and the visual result is misleading rather than
  //     informative.
  {
    const refCarrierY = buildRefLinesCarrier(
      normalizeRefLinesY(spec.refLinesY),
      spec.autoSpecY,
      theme,
      "y",
    );
    if (refCarrierY) series.push(refCarrierY);
    const xIsValueType = !useRowIdxX && !hasBoxplot && !!xField &&
      (xField.type === "continuous" || xField.type === "datetime");
    if (xIsValueType) {
      const refCarrierX = buildRefLinesCarrier(
        normalizeRefLinesX(spec.refLinesX),
        spec.autoSpecX,
        theme,
        "x",
      );
      if (refCarrierX) series.push(refCarrierX);
    }
    // Band ref lines: per-category segments anchored to one band
    // each. Only meaningful when the opposite axis is categorical,
    // so we emit:
    //   - Y-anchored band lines (horizontal segments) only when X
    //     is a category axis (xIsCategory).
    //   - X-anchored band lines (vertical segments) only when Y is
    //     a category axis — but the horizontal-mode short-circuit
    //     above has already swapped categorical-Y cases through the
    //     vertical pipeline, so by the time execution reaches here Y
    //     is always value-type and there's no native category-Y
    //     branch to drive a vertical band carrier. The swap copies
    //     band lines with `valueAxis: "x"` → `"y"` so they re-enter
    //     this block as Y-anchored on the swapped spec and
    //     `transposeOption` flips them back on the way out.
    if (xIsCategory) {
      const bandCarrierY = buildBandRefLinesCarrier(
        spec.bandRefLines,
        xCats,
        "y",
        aggregateMode,
        theme,
      );
      if (bandCarrierY) series.push(bandCarrierY);
    }
  }

  // Resolve final Y-axis bounds + tick interval. Faceted callers force
  // shared bounds via `sharedRanges`; the single-panel path runs a
  // local nice-snap fit over data + ref-line Ys to produce clean tick
  // labels (4.20 / 4.25 / 4.30 …) instead of the float-edge labels
  // (4.2228965400000001 at canvas edges) that the old callback-based
  // extension produced. User-pinned min/max/interval still win via
  // `mergeAxis` → `buildAxisOverrides`'s spread further down.
  let yFinalBounds: EChartsOption;
  if (sharedRanges?.yMin != null || sharedRanges?.yMax != null) {
    yFinalBounds = {};
    // Half-MINOR-interval pad — see xFinalBounds above for rationale.
    const yPad = (sharedRanges.yInterval ?? 0) / (AUTO_MINOR_SPLIT * 2);
    if (sharedRanges.yMin != null) yFinalBounds.min = sharedRanges.yMin - yPad;
    if (sharedRanges.yMax != null) yFinalBounds.max = sharedRanges.yMax + yPad;
    // Deliberately NOT spreading sharedRanges.yInterval, even though
    // computeSharedRanges still emits it for potential future
    // consumers. Phase 4 (commit 54b0642) established that any
    // explicit `interval` baked into the base axis option survives
    // subsequent setOption merges — so the moment the user drags Y to
    // a new {min,max} the old step is reused from the new min as
    // start, producing tick values that drift off the nice grid
    // ("刻度数字一直在动"). With identical min/max across panels,
    // ECharts' auto-tick picks an identical interval per panel anyway,
    // so we get the same visual density without the drag regression.
  } else {
    let dataMin = Infinity;
    let dataMax = -Infinity;
    if (framePointsOnly && framePointExtents?.y) {
      dataMin = framePointExtents.y.min;
      dataMax = framePointExtents.y.max;
    } else if (normalSummaryPacketMode && summaryPacket) {
      for (const entry of summaryPacket.summaries) {
        if (Number.isFinite(entry.min) && entry.min < dataMin) dataMin = entry.min;
        if (Number.isFinite(entry.max) && entry.max > dataMax) dataMax = entry.max;
      }
    } else if (yIdx >= 0) {
      for (const r of data.rows) {
        if (isRowHidden(r)) continue;
        const v = toNum(r[yIdx]);
        if (Number.isFinite(v)) {
          if (v < dataMin) dataMin = v;
          if (v > dataMax) dataMax = v;
        }
      }
    }
    const fit = computeNiceBounds(
      Number.isFinite(dataMin) ? dataMin : undefined,
      Number.isFinite(dataMax) ? dataMax : undefined,
      collectRefLineYs(spec),
      AUTO_TARGET_TICKS,
    );
    // See xFinalBounds above: emit min/max only so ECharts auto-ticks.
    // Half-MINOR-interval pad pushes the axis bounds OFF the tick
    // grid so no tick (major or minor) lands at the very top or
    // bottom of the plot frame.
    yFinalBounds = fit
      ? {
          min: fit.min - fit.interval / (AUTO_MINOR_SPLIT * 2),
          max: fit.max + fit.interval / (AUTO_MINOR_SPLIT * 2),
        }
      : { scale: true };
  }

  if (
    frameBackedAggregateMode &&
    histogramPacket &&
    Number(histogramPacket.totalCount) === 0 &&
    enabledElements.some((e) => e.kind === "histogram")
  ) {
    const hasHistogramSeries = series.some((entry: any) => {
      const id = typeof entry?.id === "string" ? entry.id : "";
      return id.startsWith("__hist_") || id.startsWith("__hist_packet_fallback_");
    });
    if (!hasHistogramSeries) {
      if (xIsCategory) {
        const totalsByCategory = new Map<string, number>();
        for (const bin of histogramPacket.bins) {
          const category = String(bin.category ?? "");
          if (!category) continue;
          totalsByCategory.set(category, (totalsByCategory.get(category) ?? 0) + Math.max(0, Number(bin.count) || 0));
        }
        if (totalsByCategory.size > 0) {
          const fallbackCats = xCats.length > 0 ? xCats : Array.from(totalsByCategory.keys());
          series.push({
            id: "__hist_packet_fallback_final_cat",
            type: "bar",
            name: yField?.name || "histogram",
            data: fallbackCats.map((cat) => totalsByCategory.get(cat) ?? 0),
            z: 1,
          });
        }
      } else {
        const fallbackRows = histogramPacket.bins
          .map((bin) => [
            (bin.binStart + bin.binEnd) / 2,
            Math.max(0, Number(bin.count) || 0),
          ] as [number, number])
          .sort((a, b) => a[0] - b[0]);
        if (fallbackRows.length > 0) {
          series.push({
            id: "__hist_packet_fallback_final_val",
            type: "bar",
            name: i18next.t("graph.frequency"),
            data: fallbackRows,
            barGap: "0%",
            z: 1,
          });
        }
      }
    }
  }

  return {
    backgroundColor: "transparent",
    textStyle: { color: theme.fgPrimary },
    // The legend panel on the right already enumerates every group with
    // its color swatch — drawing a second legend strip on top of the
    // canvas is redundant and steals vertical space. Always reserve the
    // small 16-px top margin so titles / tooltips have headroom.
    //
    // `grid.show:true` closes the plot frame with a top + right edge.
    // The left + bottom edges are already drawn by each value-axis
    // `axisLine`; ECharts paints all four in the same `theme.axisLine`
    // color. `borderWidth: 0.5` keeps the new top/right edges visually
    // equal to the 1px axisLine — the grid border is rendered as a
    // stroked rect that straddles the rect boundary, so width 0.5
    // effectively reads ~1 device pixel.
    grid: {
      left: 52,
      right: 16,
      top: 16,
      bottom: bottomGap,
      show: true,
      borderColor: theme.axisLine,
      borderWidth: 0.5,
    },
    // See histogram path above — appendToBody avoids the bottom-edge
    // scrollbar flash; confine keeps the tooltip glued to the chart area.
    tooltip: { trigger: "item", confine: true, appendToBody: true },
    // No in-chart legend: the right-side STYLE panel owns group identity.
    // Series still carry `name` so tooltips and exports stay labeled.
    legend: undefined,
    xAxis,
    yAxis: mergeAxis(
      {
        type: "value",
        ...axis,
        // Auto-enable minor ticks on the Y value axis — same rationale
        // as `xAxis` above. User overrides (including explicit-off
        // via `minorTickCount = 0`) merge in below. The
        // `...axis.minorTick` spread preserves theme lineStyle so
        // minors render at the same 0.5px stroke as the majors.
        minorTick: { ...(axis.minorTick as object | undefined), show: true, splitNumber: AUTO_MINOR_SPLIT },
        // Pre-computed bounds (faceted shared OR local nice-snap fit).
        // User-pinned overrides from `buildAxisOverrides` still win
        // via the merge spread below.
        ...yFinalBounds,
      },
      buildAxisOverrides(spec.yAxis, aggregateMode),
    ),
    series,
    animationDuration: 250,
  } as EChartsOption;
}

function collectCategories(data: GraphData, xIdx: number, yIdx?: number): string[] {
  if (xIdx < 0) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  // When `yIdx` is supplied we drop rows whose Y value isn't finite
  // before counting categories. This mirrors the legend's hide-empty-
  // group behavior on the category axis: if EV2 has no plottable
  // boxes/points it should disappear from the X axis entirely rather
  // than reserve a blank slot between TC1.6 and DV.
  const filterByY = yIdx != null && yIdx >= 0;
  for (const r of data.rows) {
    // Skip rows whose X value itself is missing — otherwise
    // `toStr(null) === ""` (and `toStr("") === ""`) injects a phantom
    // blank category at the leftmost slot of the axis. The user
    // perceives this as "extra blank space on the left of the X
    // axis" because all real categories are pushed one band to the
    // right of where they belong.
    if (isMissing(r[xIdx])) continue;
    if (filterByY) {
      const v = toNum(r[yIdx as number]);
      if (!Number.isFinite(v)) continue;
    }
    const k = toStr(r[xIdx]);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(k);
    }
  }
  return out;
}

/** Map the internal placeholder used by groupBy when no field is provided
 *  to an empty display string so the user doesn't see it on the axis. */
function displayCat(cat: string): string {
  return cat === "__all__" ? "" : cat;
}

/** Decide if category labels should be rotated to avoid overlap.
 *  Heuristic: rotate when there are many categories or any label is long. */
function needsRotation(cats: string[]): boolean {
  if (cats.length > 8) return true;
  return cats.some((c) => c.length > 10);
}

/** Wrap a long category label across multiple lines using "\n".
 *  Prefers splitting at common separators (` `, `-`, `_`, `/`) to keep
 *  word boundaries; falls back to a hard chunk split for solid strings. */
function wrapLabel(s: string, maxChars: number): string {
  if (!s) return s;
  if (s.length <= maxChars) return s;
  const tokens = s.split(/(?<=[\s\-_/])/); // keep separators with prev token
  const lines: string[] = [];
  let line = "";
  for (const tok of tokens) {
    if ((line + tok).length > maxChars && line.length > 0) {
      lines.push(line);
      line = tok;
    } else {
      line += tok;
    }
    // If a single token is itself longer than maxChars, hard-break it.
    while (line.length > maxChars) {
      lines.push(line.slice(0, maxChars));
      line = line.slice(maxChars);
    }
  }
  if (line) lines.push(line);
  return lines.map((l) => l.trim()).join("\n");
}

/** Number of wrapped lines the longest label will produce. */
function maxWrapLines(cats: string[], maxChars: number): number {
  let m = 1;
  for (const c of cats) {
    const n = wrapLabel(c, maxChars).split("\n").length;
    if (n > m) m = n;
  }
  return m;
}

interface BuildCtx {
  xIdx: number;
  yIdx: number;
  sizeIdx: number;
  xIsCategory: boolean;
  xIsTime: boolean;
  seriesName: string;
  /** Categorical color of the current group (used as a fallback for any
   *  sub-mark that didn't get an explicit override). */
  color: string;
  /** True when a Color/Overlay split produces multiple series. */
  grouping: boolean;
  theme: GraphTheme;
  /** Resolved {line, fill, point, outlier} sub-marks for the current group.
   *  Every series rendered for this element should pull from these. */
  style: ResolvedGroupStyle;
  summaryPacket: SummaryPacket | null;
  groupKey: string | null;
  requireSummaryPacket: boolean;
  jitterXBandwidth: number;
}

function buildElementSeries(
  el: ChartElement,
  rowIdxs: number[],
  data: GraphData,
  ctx: BuildCtx,
): any[] | null {
  const {
    xIdx,
    yIdx,
    sizeIdx,
    xIsCategory,
    seriesName,
    style,
    summaryPacket,
    groupKey,
    requireSummaryPacket,
    jitterXBandwidth,
  } = ctx;
  if (yIdx < 0) return null;

  // When no X column is bound, collapse all points onto a single category
  // so the user sees the Y distribution as a strip / single column.
  // The mirror case (Y unbound or Y categorical with X numeric — i.e. a
  // horizontal-orientation chart) is handled one level up at the top of
  // `buildSingleOption`: the spec is built with X↔Y swapped (so the
  // existing vertical path produces correct marks), then the resulting
  // option's axes and per-series data tuples are transposed back. That
  // keeps this per-element builder a vertical-only code path.
  const useRowIdx = xIdx < 0;
  const SINGLE_X = "";

  // Pre-resolve the hidden columns we attach to scatter points so a
  // GraphBuilder click can map a dot back to the source DataTableView
  // cell. Both are optional — datasets without _row_id (synthetic
  // overlays, derived data) emit `rowId: -1`, and non-melt charts fall
  // back to the bound Y field name as the source column.
  const rowIdColIdx = data.columns.indexOf(ROW_ID_COL);
  const meltVarColIdx = data.columns.indexOf(MELT_VAR_COL);
  const yColName = yIdx >= 0 ? data.columns[yIdx] : "";

  // 取 (x, y[, size]) 数组
  const points: Array<{
    x: unknown;
    y: number;
    size?: number;
    rowId: number;
    jitterRowId: bigint;
    colName: string;
  }> = [];
  for (const i of rowIdxs) {
    const xv = useRowIdx ? SINGLE_X : data.rows[i][xIdx];
    // When a real X column is bound, drop rows whose X is missing so
    // they don't appear as a blank category (bar) or as NaN points
    // (which ECharts plots at the axis origin on a value scale).
    if (!useRowIdx && isMissing(xv)) continue;
    const yv = toNum(data.rows[i][yIdx]);
    if (!Number.isFinite(yv)) continue;
    const sv = sizeIdx >= 0 ? toNum(data.rows[i][sizeIdx]) : undefined;
    const rawRowId = rowIdColIdx >= 0 ? data.rows[i][rowIdColIdx] : undefined;
    const rid = Number(rawRowId);
    const jitterRowId = typeof rawRowId === "bigint"
      ? rawRowId
      : Number.isFinite(rid)
        ? BigInt(Math.trunc(rid))
        : BigInt(i);
    const col = meltVarColIdx >= 0 ? String(data.rows[i][meltVarColIdx] ?? "") : yColName;
    points.push({
      x: xv,
      y: yv,
      size: sv,
      rowId: Number.isSafeInteger(rid) && rid >= 0 ? rid : -1,
      jitterRowId,
      colName: col,
    });
  }
  const packetSummaryStat =
    el.kind === "points" || el.kind === "line"
      ? getOpt<string>(el.options, "summaryStat", el.kind === "line" ? "mean" : "none")
      : "none";
  const canUseSummaryPacket =
    !!summaryPacket && packetSummaryStat !== "none" && !useRowIdx && xIdx >= 0;
  if (points.length === 0 && !canUseSummaryPacket) return null;

  switch (el.kind) {
    case "points": {
      const opts = el.options;
      const summaryStat = getOpt<string>(opts, "summaryStat", "none");
      const errorInterval = getOpt<string>(opts, "errorInterval", "auto");
      const intervalStyle = getOpt<string>(opts, "intervalStyle", "errorBar");

      // Aggregated mode: collapse repeated X values to a single summary point
      // (mean/median/sum) plus optional error interval.
      if (summaryStat !== "none" && !useRowIdx && xIdx >= 0) {
        const agg = aggregatePoints(
          rowIdxs,
          data,
          xIdx,
          yIdx,
          xIsCategory,
          summaryStat,
          errorInterval,
          summaryPacket,
          groupKey,
          requireSummaryPacket,
        );
        if (agg.length === 0) return null;
        const sym = markerToSymbol(style.point.marker);
        const out: any[] = [
          {
            id: `${seriesName}__summary`,
            type: "scatter",
            name: seriesName,
            symbol: sym.symbol,
            // Summary dots are slightly larger than raw scatter dots so
            // they read as the “mean / median” marker on top of the points.
            symbolSize: style.point.size + 3,
            itemStyle: pointItemStyle(style.point, sym.hollow),
            data: agg.map((p) =>
              xIsCategory ? [toStr(p.x), p.y] : [toNum(p.x), p.y],
            ),
            // Disable transition so the dot doesn't lag behind the matching
            // error interval / band when the chart option is replaced.
            animation: false,
            z: 4,
          },
        ];
        // Error bars / band inherit the line sub-mark color so they match
        // any line layer rendered on top.
        out.push(...buildIntervalSeries(agg, xIsCategory, intervalStyle, style.line.color, seriesName));
        return out;
      }

      // Raw scatter (no aggregation). Optional size encoding.
      let sizes: number[] | null = null;
      if (sizeIdx >= 0) {
        const ss = points.map((p) => p.size ?? NaN).filter(Number.isFinite);
        if (ss.length > 0) {
          // Single-pass min/max; avoids Math.min/max(...ss) overflow on
          // scatter plots with very many points.
          let min = Infinity;
          let max = -Infinity;
          for (let i = 0; i < ss.length; i++) {
            const v = ss[i];
            if (v < min) min = v;
            if (v > max) max = v;
          }
          const range = max - min || 1;
          sizes = points.map((p) =>
            Number.isFinite(p.size!) ? 6 + ((p.size! - min) / range) * 22 : 6,
          );
        }
      }

      // Per-point horizontal jitter so overlapping observations are visible.
      // See computeJitterOffsets for full mode docs:
      //   - "stacked" (default) → JMP-style stack jitter, deterministic,
      //     binned by Y, spread side-by-side around the X position.
      //   - "auto"              → legacy alias for "stacked".
      //   - "uniform"/"normal"  → random horizontal noise.
      const jitterMode = getOpt<string>(opts, "jitter", "stacked");
      const jitterLimit = Math.max(0, Math.min(1, getOpt<number>(opts, "jitterLimit", 0.5)));
      let yMin = Infinity;
      let yMax = -Infinity;
      const jitterPoints: JitterPoint[] = points.map((point) => {
        if (point.y < yMin) yMin = point.y;
        if (point.y > yMax) yMax = point.y;
        return {
          x: typeof point.x === "string" || typeof point.x === "number" ? point.x : String(point.x),
          y: point.y,
          rowId: point.jitterRowId,
        };
      });
      const offsets = computeStableJitterOffsets(
        jitterPoints,
        {
          mode: jitterMode === "uniform" || jitterMode === "normal" || jitterMode === "auto"
            ? jitterMode
            : "stacked",
          limit: jitterLimit,
          seed: 0,
        },
        {
          plotWidth: 640,
          plotHeight: 400,
          xBandwidth: jitterXBandwidth,
          yMin: Number.isFinite(yMin) ? yMin : 0,
          yMax: Number.isFinite(yMax) && yMax !== yMin ? yMax : yMin + 1,
        },
      );

      const sym = markerToSymbol(style.point.marker);
      return [
        {
          type: "scatter",
          name: seriesName,
          symbol: sym.symbol,
          symbolSize: sizes ? (_val: any, params: any) => sizes![params.dataIndex] : style.point.size,
          itemStyle: pointItemStyle(style.point, sym.hollow),
          progressive: 0,
          data: points.map((p, i) => {
            const value = xIsCategory ? [toStr(p.x), p.y] : [toNum(p.x), p.y];
            const off = offsets[i];
            // Always emit object form when we have a real source row to
            // attach — the GraphBuilder's onPointClick reads `__pick`
            // from `params.data`. Falling back to the tuple-only form
            // when there's no rowId keeps the legacy hot path for
            // synthetic data identical to before.
            if (p.rowId >= 0) {
              const item: any = { value, __pick: { rowId: p.rowId, colName: p.colName } };
              item.symbolOffset = off;
              return item;
            }
            return { value, symbolOffset: off };
          }),
          z: 5,
        },
      ];
    }
    case "line": {
      const opts = el.options;
      const rowOrder = getOpt<boolean>(opts, "rowOrder", false);
      const connection = getOpt<string>(opts, "connection", "line"); // line | step | spline
      const summaryStat = getOpt<string>(opts, "summaryStat", "mean");
      const fill = getOpt<string>(opts, "fill", "none"); // none | toZero | between
      const errorInterval = getOpt<string>(opts, "errorInterval", "auto");
      const intervalStyle = getOpt<string>(opts, "intervalStyle", "errorBar");
      const missingValues = getOpt<string>(opts, "missingValues", "connect");

      const isStep = connection === "step" ? "middle" : false;
      const isSpline = connection === "spline";
      const connectNulls = missingValues === "connect";

      // If a non-"none" summary stat is selected, aggregate points per X
      // (this matches JMP-style "Mean line"). Otherwise just plot raw.
      const useAgg = summaryStat !== "none" && !useRowIdx && xIdx >= 0;
      let lineData: Array<[unknown, number]>;
      let intervalSeries: any[] = [];
      if (useAgg) {
        const agg = aggregatePoints(
          rowIdxs,
          data,
          xIdx,
          yIdx,
          xIsCategory,
          summaryStat,
          errorInterval,
          summaryPacket,
          groupKey,
          requireSummaryPacket,
        );
        if (agg.length === 0) return null;
        lineData = agg.map((p) => [
          xIsCategory ? toStr(p.x) : toNum(p.x),
          p.y,
        ]);
        intervalSeries = buildIntervalSeries(agg, xIsCategory, intervalStyle, style.line.color, seriesName);
      } else {
        const arr = rowOrder
          ? points
          : [...points].sort((a, b) => {
              const ax = xIsCategory ? toStr(a.x) : toNum(a.x);
              const bx = xIsCategory ? toStr(b.x) : toNum(b.x);
              return ax < bx ? -1 : ax > bx ? 1 : 0;
            });
        lineData = arr.map((p) => [
          xIsCategory ? toStr(p.x) : toNum(p.x),
          p.y,
        ]);
      }

      const lineSeries: any = {
        type: "line",
        name: seriesName,
        showSymbol: false,
        smooth: isSpline,
        step: isStep,
        connectNulls,
        lineStyle: { color: style.line.color, width: style.line.width, opacity: style.line.opacity },
        itemStyle: { color: style.line.color },
        data: lineData,
        z: 2,
      };
      if (fill === "toZero") {
        // Area fill follows the group's fill sub-mark.
        lineSeries.areaStyle = { color: style.fill.color, opacity: style.fill.opacity * 0.5 };
      }
      // "between" fill is meaningful only with an interval band; if user
      // selected "between" but interval is none, fall back to no fill.
      if (fill === "between" && intervalSeries.length === 0) {
        // no-op
      }
      return [lineSeries, ...intervalSeries];
    }
    case "bar": {
      // 按 X 分组求均值
      const bins = new Map<string, { sum: number; n: number; xv: unknown }>();
      for (const p of points) {
        const key = toStr(p.x);
        const b = bins.get(key);
        if (b) {
          b.sum += p.y;
          b.n++;
        } else {
          bins.set(key, { sum: p.y, n: 1, xv: p.x });
        }
      }
      const arr = Array.from(bins.entries()).map(([k, b]) =>
        xIsCategory ? [k, b.sum / b.n] : [toNum(b.xv), b.sum / b.n],
      );
      return [
        {
          type: "bar",
          name: seriesName,
          itemStyle: {
            color: style.fill.color,
            borderColor: style.line.color,
            borderWidth: style.line.width,
            opacity: style.fill.opacity,
          },
          data: arr,
        },
      ];
    }
    case "smoother": {
      // 仅在数值 X 上有效：分类 X 的 "曲线" 没有定义良好的距离/带宽
      if (xIsCategory) return null;
      const xy: [number, number][] = points
        .map((p) => [toNum(p.x), p.y] as [number, number])
        .filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
      if (xy.length < 2) return null;
      const opts = el.options ?? {};
      // Algorithm dispatcher. Default "movingAvg" preserves the
      // behaviour of pre-2024 projects that only ever had the
      // moving-average path (and stored its window in `lambda`).
      const algo = (opts.algo as string | undefined) ?? "movingAvg";
      let smoothed: [number, number][];
      switch (algo) {
        case "spline": {
          const sm = Math.max(
            0,
            Math.min(1, (opts.splineSmoothness as number | undefined) ?? 0.5),
          );
          smoothed = splineSmoother(xy, sm);
          break;
        }
        case "kernel": {
          const bw = Math.max(
            0.01,
            Math.min(0.5, (opts.kernelBandwidth as number | undefined) ?? 0.1),
          );
          smoothed = kernelSmoother(xy, bw);
          break;
        }
        case "savgol": {
          const wRaw = Math.max(
            5,
            Math.min(
              101,
              Math.floor((opts.savgolWindow as number | undefined) ?? 11),
            ),
          );
          const w = wRaw % 2 === 1 ? wRaw : wRaw + 1;
          const p = Math.max(
            2,
            Math.min(
              4,
              Math.floor((opts.savgolPolyOrder as number | undefined) ?? 2),
            ),
          );
          smoothed = savgolSmoother(xy, w, p);
          break;
        }
        case "movingBox": {
          // Same window semantics as the moving-average path; `lambda`
          // is the legacy fallback so projects saved before the
          // algorithm selector existed keep their window unchanged.
          const frac = Math.max(
            0.02,
            Math.min(
              0.9,
              (opts.windowFraction as number | undefined) ??
                (opts.lambda as number | undefined) ??
                0.4,
            ),
          );
          const win = Math.max(3, Math.floor(xy.length * frac));
          smoothed = movingMedian(xy, win);
          break;
        }
        case "movingAvg":
        default: {
          const frac = Math.max(
            0.02,
            Math.min(
              0.9,
              (opts.windowFraction as number | undefined) ??
                (opts.lambda as number | undefined) ??
                0.4,
            ),
          );
          const win = Math.max(3, Math.floor(xy.length * frac));
          smoothed = movingAverage(xy, win);
          break;
        }
      }
      return [
        {
          type: "line",
          name: `${seriesName} 平滑`,
          showSymbol: false,
          smooth: true,
          lineStyle: {
            color: style.line.color,
            width: style.line.width,
            type: "solid",
            opacity: style.line.opacity,
          },
          itemStyle: { color: style.line.color },
          z: 5,
          data: smoothed,
        },
      ];
    }
    case "fitline": {
      // Polynomial / robust regression. Requires numeric X — categorical
      // X has no metric so OLS is undefined.
      if (xIsCategory) return null;
      const xy: [number, number][] = points
        .map((p) => [toNum(p.x), p.y] as [number, number])
        .filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
      if (xy.length < 3) return null;
      const opts = el.options ?? {};
      const fitType =
        (opts.fitType as string | undefined) ?? "polynomial";
      const degree = Math.max(
        1,
        Math.min(6, Math.floor((opts.degree as number | undefined) ?? 1)),
      );
      const showFitCI = (opts.showFitCI as boolean | undefined) ?? false;
      const showPredCI = (opts.showPredCI as boolean | undefined) ?? false;
      const showStats = (opts.showStats as boolean | undefined) ?? false;
      const showEquation =
        (opts.showEquation as boolean | undefined) ?? false;
      const showRMSE = (opts.showRMSE as boolean | undefined) ?? false;
      const showR2 = (opts.showR2 as boolean | undefined) ?? false;
      const showFTest = (opts.showFTest as boolean | undefined) ?? false;
      // We need at least `degree + 2` rows to estimate residual variance
      // (n − p − 1 ≥ 1). Otherwise drop the layer silently.
      if (xy.length < degree + 2) return null;
      const xsRaw = xy.map((p) => p[0]);
      const ysRaw = xy.map((p) => p[1]);
      const fit =
        fitType === "robustCauchy"
          ? fitRobustCauchy(xsRaw, ysRaw, degree)
          : fitPolynomial(xsRaw, ysRaw, degree);
      if (!fit) return null;
      let xMin = Infinity;
      let xMax = -Infinity;
      let yDataMax = -Infinity;
      for (let i = 0; i < xsRaw.length; i++) {
        if (xsRaw[i] < xMin) xMin = xsRaw[i];
        if (xsRaw[i] > xMax) xMax = xsRaw[i];
        if (ysRaw[i] > yDataMax) yDataMax = ysRaw[i];
      }
      if (!(xMax > xMin)) return null;
      const SAMPLES = 200;
      const fitData: [number, number][] = [];
      const loFit: [number, number][] = [];
      const hiFit: [number, number][] = [];
      const loPred: [number, number][] = [];
      const hiPred: [number, number][] = [];
      const tCrit = tCritical95(fit.n - degree - 1);
      const m = degree + 1;
      const xvec = new Array<number>(m);
      const needBands = (showFitCI || showPredCI) && !!fit.invXTX;
      for (let i = 0; i < SAMPLES; i++) {
        const x = xMin + (i / (SAMPLES - 1)) * (xMax - xMin);
        const xn = (x - fit.xMean) / fit.xScale;
        let yhat = 0;
        let v = 1;
        for (let k = 0; k < m; k++) {
          xvec[k] = v;
          yhat += fit.coefs[k] * v;
          v *= xn;
        }
        fitData.push([x, yhat]);
        if (needBands) {
          // Quadratic form x*ᵀ · (XᵀX)⁻¹ · x* gives the leverage at x*.
          let q = 0;
          const inv = fit.invXTX!;
          for (let r = 0; r < m; r++) {
            const xr = xvec[r];
            for (let c = 0; c < m; c++) q += xr * inv[r][c] * xvec[c];
          }
          if (showFitCI) {
            const se = Math.sqrt(Math.max(0, fit.sigma2 * q));
            loFit.push([x, yhat - tCrit * se]);
            hiFit.push([x, yhat + tCrit * se]);
          }
          if (showPredCI) {
            const se = Math.sqrt(Math.max(0, fit.sigma2 * (1 + q)));
            loPred.push([x, yhat - tCrit * se]);
            hiPred.push([x, yhat + tCrit * se]);
          }
        }
      }
      const bandColor = style.line.color;
      const out: any[] = [];
      // Prediction band first (lighter, wider) so the Fit band paints
      // on top with the higher opacity.
      if (showPredCI && loPred.length > 0) {
        out.push(
          ...buildBandSeries(
            loPred,
            hiPred,
            bandColor,
            0.08,
            `${seriesName}_fitpred`,
          ),
        );
      }
      if (showFitCI && loFit.length > 0) {
        out.push(
          ...buildBandSeries(
            loFit,
            hiFit,
            bandColor,
            0.18,
            `${seriesName}_fitci`,
          ),
        );
      }
      out.push({
        type: "line",
        name: `${seriesName} 拟合`,
        showSymbol: false,
        smooth: false,
        lineStyle: {
          color: style.line.color,
          width: style.line.width,
          type: "solid",
          opacity: style.line.opacity,
        },
        itemStyle: { color: style.line.color },
        z: 6,
        data: fitData,
      });
      // Statistics overlay (top-left of the data extent). Rendered as
      // a single invisible scatter point whose label carries the
      // multi-line text — gives us pixel-precise placement plus a
      // legible background panel without adding a new option-level
      // `graphic` plumbing path.
      if (
        showStats &&
        (showEquation || showRMSE || showR2 || showFTest)
      ) {
        const lines: string[] = [];
        if (showEquation) {
          const orig = denormalizeCoefs(fit.coefs, fit.xMean, fit.xScale);
          lines.push(formatEquation(orig));
        }
        if (showRMSE) lines.push(`RMSE: ${fit.rmse.toPrecision(4)}`);
        if (showR2) lines.push(`R²: ${fit.r2.toFixed(4)}`);
        if (showFTest) lines.push(`F: ${fit.fStat.toPrecision(4)}`);
        out.push({
          id: `${seriesName}__fitstats`,
          type: "scatter",
          name: `${seriesName} _stats`,
          data: [[xMin, yDataMax]],
          symbolSize: 0,
          silent: true,
          animation: false,
          legendHoverLink: false,
          z: 7,
          label: {
            show: true,
            formatter: lines.join("\n"),
            align: "left",
            verticalAlign: "top",
            position: [4, 0],
            backgroundColor: "rgba(255,255,255,0.85)",
            borderColor: style.line.color,
            borderWidth: 1,
            borderRadius: 3,
            padding: [4, 6],
            fontSize: 11,
            lineHeight: 14,
            color: "#222",
          },
        });
      }
      return out;
    }
    default:
      return null;
  }
}

/**
 * 主入口：将 GraphSpec + GraphData 转换为 ECharts option（或多面板列表）。
 *
 * 当前实现：分面（groupX/groupY/wrap）以多个独立 option 返回，
 * 由 <Graph> 组件渲染为网格。
 *
 * Layout rules:
 *   - No facet         → 1 panel, 1×1.
 *   - groupX only      → 1 row × N cols (panels laid out left-to-right;
 *                        they visually "share" the Y axis).
 *   - groupY only      → N rows × 1 col (panels stacked top-to-bottom;
 *                        they visually "share" the X axis). Matches
 *                        JMP's Group Y semantics.
 *   - groupX × groupY  → Ny rows × Nx cols Trellis grid (row-major).
 *   - wrap only        → falls back to the legacy sqrt-grid auto wrap.
 *   - wrap is ignored when either groupX or groupY is bound (the
 *     explicit facet axes take precedence).
 */
export interface BuiltGraph {
  /** 子图列表（无分面时长度为 1，row-major: rows top→bottom × cols left→right） */
  panels: {
    title: string;
    option: EChartsOption;
    /** Per-panel facet labels (null when that axis isn't faceted). Used
     *  by the renderer to draw row / column header strips around the grid. */
    groupXValue: string | null;
    groupYValue: string | null;
  }[];
  /** 网格列数（用于布局） */
  cols: number;
  /** 网格行数（用于布局） */
  rows: number;
}

/** Collect facet category keys in their natural-occurrence order, honouring
 *  any user-defined Value Order on the column. */
function collectFacetKeys(
  data: GraphData,
  field: FieldRef,
  valueOrders?: Record<string, string[]>,
): string[] | null {
  const idx = colIndex(data, field.name);
  if (idx < 0) return null;
  const seen: string[] = [];
  const seenSet = new Set<string>();
  for (const r of data.rows) {
    const k = toStr(r[idx]);
    if (!seenSet.has(k)) {
      seenSet.add(k);
      seen.push(k);
    }
  }
  return applyValueOrder(seen, valueOrders?.[field.name]);
}

/** Does this row subset contain at least one row that would actually
 *  produce a mark on the chart? Used by `buildGraph` to drop entirely
 *  empty facet panels (Group X / Group Y / Wrap) so they don't reserve
 *  a grid cell and squeeze the visible panels.
 *
 *  Definition of "plottable" keys off the VALUE axis, not blindly on Y:
 *   - Y bound to a quantitative column (continuous / datetime): at
 *     least one row whose Y parses to a finite number (mirrors
 *     `collectCategories`'s yIdx filter and the legend's hide-empty
 *     policy).
 *   - Y bound to a CATEGORICAL column (nominal / ordinal / id): the
 *     chart renders horizontally — the value axis is X. Plottability
 *     therefore checks X for a finite number. Without this branch a
 *     Y-categorical chart treats every row as non-plottable
 *     (`toNum("EV2")` → `NaN`), every facet stripe gets filtered, and
 *     the degenerate guard in `buildGraph` falls back to the unfiltered
 *     key list — so empty stripes like `Build=EV2` re-appear.
 *   - No Y bound but X bound: check X for a finite number (covers
 *     the X-numeric-only strip and horizontal-mode no-Y case).
 *   - Neither bound: any non-empty subset counts. */
function hasPlottableRows(
  rows: GraphData["rows"],
  encoding: GraphSpec["encoding"],
  data: GraphData,
): boolean {
  if (rows.length === 0) return false;
  // NOTE: GraphData.columns is `string[]`, not `{name}[]` — use
  // `colIndex` (string match) rather than `findIndex(c => c.name…)`,
  // which silently returns -1 on a string array and would make this
  // helper always fall through to the `return true` fallback, defeating
  // the empty-panel filter entirely.
  const yField = encoding.y;
  const yIsQuantitative = yField && (yField.type === "continuous" || yField.type === "datetime");
  if (yIsQuantitative) {
    const yIdx = colIndex(data, yField.name);
    if (yIdx >= 0) return rows.some((r) => Number.isFinite(toNum(r[yIdx])));
  }
  const xField = encoding.x;
  if (xField) {
    const xIdx = colIndex(data, xField.name);
    if (xIdx >= 0) return rows.some((r) => Number.isFinite(toNum(r[xIdx])));
  }
  // Y bound but categorical and no X bound — degenerate: every row
  // "is" a category occurrence, so any non-empty subset is plottable.
  return true;
}

/** Compute shared X / Y axis ranges across the FULL faceted dataset.
 *
 *  Faceting splits the rows into per-panel subsets whose local min/max
 *  almost always differ. With per-panel auto-scale, the same Y value
 *  lands at a different pixel height in each panel — exactly the failure
 *  mode the user flagged ("严重的判断失误"). Pinning every panel's axes
 *  to the global bounds restores cross-panel comparability.
 *
 *  - Y is always a value axis (histograms aside) — emit numeric min/max.
 *  - X depends on the column type:
 *      * nominal/ordinal → union of categories (so missing categories
 *        still occupy the same slot on every panel)
 *      * datetime → numeric min/max in ms-since-epoch
 *      * quantitative / unknown → numeric min/max
 *  - A tiny relative pad (~2 %) is added to numeric bounds to keep
 *    points off the axis edge; ECharts' `scale: true` does this
 *    automatically when min/max are unset, so we replicate the feel. */
function computeSharedRanges(
  data: GraphData,
  encoding: GraphSpec["encoding"],
  valueOrders?: Record<string, string[]>,
  hiddenGroups?: string[],
  /** Extra finite Y values (e.g. spec-limit and user reference lines)
   *  that must stay inside every faceted panel's Y range. Folded into
   *  the data-derived bounds so panels keep their cross-comparable
   *  shared scale AND the ref lines never get clipped. */
  refYs?: number[],
  /** Extra finite X values (user reference lines on a value-type X
   *  axis). Mirrors `refYs` for the X branch — folded into the
   *  numeric X bounds so vertical reference lines drawn outside the
   *  data extent still render on every faceted panel. */
  refXs?: number[],
): SharedAxisRanges {
  const out: SharedAxisRanges = {};

  // Resolve the grouping field (color or overlay) and pre-compute the
  // column index + a Set of hidden values so we can cheaply skip rows
  // that belong to a hidden legend group. Hidden rows shouldn't drag the
  // shared axis bounds — otherwise hiding a noisy outlier group does
  // nothing visible because the axes still cover its range.
  const grouping = encoding.overlay ?? encoding.color;
  const groupingIdx = grouping ? colIndex(data, grouping.name) : -1;
  const hiddenSet = new Set(hiddenGroups ?? []);
  const useHiddenFilter = !!grouping && groupingIdx >= 0 && hiddenSet.size > 0;
  const isRowHidden = (r: unknown[]): boolean => {
    if (!useHiddenFilter) return false;
    const v = r[groupingIdx];
    const k = v == null ? "" : String(v);
    return hiddenSet.has(k);
  };

  const yField = encoding.y;
  // Snapshot the Y field's column index here so the X branch below
  // can reuse it for empty-category filtering without re-resolving.
  const yIdxForCats = yField ? colIndex(data, yField.name) : -1;
  const yIsCategorical =
    yField &&
    (yField.type === "nominal" ||
      yField.type === "ordinal" ||
      yField.type === "id");
  if (yField && yIdxForCats >= 0 && yIsCategorical) {
    // Horizontal-mode Y: collect the union of Y categories across all
    // panels so every faceted panel pins to the same Y category list
    // (mirrors the X-categorical branch below). `swapSharedRanges`
    // forwards this through as `xCats` of the recursive vertical
    // build, which the inner builder then renders on what becomes the
    // post-transpose Y axis.
    const seen = new Set<string>();
    const cats: string[] = [];
    // Resolve X's index up front so the X-finiteness filter doesn't
    // re-lookup per row. When X is bound to a quantitative column,
    // drop rows whose X doesn't parse to a finite number — otherwise
    // a Y-category that exists only in non-plottable rows reserves a
    // dead slot on every panel (matches the inner per-element loop's
    // `Number.isFinite(toNum(xv))` policy).
    const xFieldForFilter = encoding.x;
    const xIdxForFilter = xFieldForFilter ? colIndex(data, xFieldForFilter.name) : -1;
    const xIsQuantForFilter =
      xFieldForFilter?.type === "continuous" || xFieldForFilter?.type === "datetime";
    for (const r of data.rows) {
      if (isRowHidden(r)) continue;
      if (isMissing(r[yIdxForCats])) continue;
      if (xIsQuantForFilter && xIdxForFilter >= 0) {
        const xv = toNum(r[xIdxForFilter]);
        if (!Number.isFinite(xv)) continue;
      }
      const k = toStr(r[yIdxForCats]);
      if (!seen.has(k)) {
        seen.add(k);
        cats.push(k);
      }
    }
    out.yCats = applyValueOrder(cats, valueOrders?.[yField.name]);
  } else if (yField && yIdxForCats >= 0) {
    let dataMin = Infinity;
    let dataMax = -Infinity;
    for (const r of data.rows) {
      if (isRowHidden(r)) continue;
      const v = toNum(r[yIdxForCats]);
      if (Number.isFinite(v)) {
        if (v < dataMin) dataMin = v;
        if (v > dataMax) dataMax = v;
      }
    }
    // Run the same nice-snap helper the single-panel path uses so
    // every faceted panel inherits identical bounds AND identical
    // tick spacing. Folds ref-line Ys in so spec limits drawn off the
    // data extent (e.g. USL at 120 when data tops out at 95) still
    // render on every panel.
    const fit = computeNiceBounds(
      Number.isFinite(dataMin) ? dataMin : undefined,
      Number.isFinite(dataMax) ? dataMax : undefined,
      refYs ?? [],
      AUTO_TARGET_TICKS,
    );
    if (fit) {
      out.yMin = fit.min;
      out.yMax = fit.max;
      out.yInterval = fit.interval;
    }
  } else if (refYs && refYs.length > 0) {
    // No Y data column but ref lines are configured: fit the axis
    // around just the ref lines so they still render predictably.
    const fit = computeNiceBounds(undefined, undefined, refYs, AUTO_TARGET_TICKS);
    if (fit) {
      out.yMin = fit.min;
      out.yMax = fit.max;
      out.yInterval = fit.interval;
    }
  }

  const xField = encoding.x;
  if (xField) {
    const xIdx = colIndex(data, xField.name);
    if (xIdx >= 0) {
      const xIsCat = xField.type === "nominal" || xField.type === "ordinal";
      if (xIsCat) {
        const seen = new Set<string>();
        const cats: string[] = [];
        // Drop rows with non-finite Y so categories with zero plottable
        // data don't reserve a slot on the axis — matches the legend's
        // hide-empty-group behavior and the local collectCategories
        // filter further up.
        for (const r of data.rows) {
          if (isRowHidden(r)) continue;
          // Skip rows whose X value itself is missing — otherwise
          // `toStr(null) === ""` injects a phantom blank category at
          // the start of the axis, which the user perceives as "extra
          // blank space on the left of the X axis".
          if (isMissing(r[xIdx])) continue;
          if (yIdxForCats >= 0) {
            const y = toNum(r[yIdxForCats]);
            if (!Number.isFinite(y)) continue;
          }
          const k = toStr(r[xIdx]);
          if (!seen.has(k)) {
            seen.add(k);
            cats.push(k);
          }
        }
        out.xCats = applyValueOrder(cats, valueOrders?.[xField.name]);
      } else {
        // Value-type X (continuous numeric): run the same nice-snap
        // fit we apply to Y so every faceted panel inherits identical
        // X bounds AND identical tick spacing. Without `xInterval`
        // ECharts could pick a different per-panel density even with
        // identical bounds, breaking visual comparison across panels.
        // Fold X ref-lines in so vertical spec limits drawn outside
        // the data extent (e.g. USL at 120 when data tops out at 95)
        // still render on every panel.
        let xMin = Infinity;
        let xMax = -Infinity;
        for (const r of data.rows) {
          if (isRowHidden(r)) continue;
          const raw = r[xIdx];
          const v = xField.type === "datetime"
            ? (raw instanceof Date ? raw.getTime() : new Date(raw as string).getTime())
            : toNum(raw);
          if (Number.isFinite(v)) {
            if (v < xMin) xMin = v;
            if (v > xMax) xMax = v;
          }
        }
        if (Number.isFinite(xMin) && Number.isFinite(xMax)) {
          if (xField.type === "datetime") {
            // Time axis: keep the legacy padded extent — ECharts'
            // built-in time tick picker already produces clean labels
            // (hours/days/months) and the nice-number families above
            // wouldn't translate to time units cleanly without extra
            // date math.
            const pad = (xMax - xMin) * 0.02 || Math.abs(xMax) * 0.02 || 1;
            out.xMin = xMin - pad;
            out.xMax = xMax + pad;
          } else {
            const fit = computeNiceBounds(xMin, xMax, refXs ?? [], AUTO_TARGET_TICKS);
            if (fit) {
              out.xMin = fit.min;
              out.xMax = fit.max;
              out.xInterval = fit.interval;
            } else {
              const pad = (xMax - xMin) * 0.02 || Math.abs(xMax) * 0.02 || 1;
              out.xMin = xMin - pad;
              out.xMax = xMax + pad;
            }
          }
        } else if (refXs && refXs.length > 0) {
          // No finite X data but X ref lines configured: fit just
          // around the ref lines so they still render predictably.
          const fit = computeNiceBounds(undefined, undefined, refXs, AUTO_TARGET_TICKS);
          if (fit) {
            out.xMin = fit.min;
            out.xMax = fit.max;
            out.xInterval = fit.interval;
          }
        }
      }
    }
  }

  return out;
}

interface FrameScatterSeriesBuild {
  series: any[];
  extents?: {
    x?: { min: number; max: number };
    y?: { min: number; max: number };
  };
}

function buildFrameBackedScatterSeries(
  spec: GraphSpec,
  frame: GraphDataFrame,
  panelFacet: PanelFacetContext | undefined,
  theme: GraphTheme,
  valueOrders: Record<string, string[]> | undefined,
  sharedRanges: SharedAxisRanges | undefined,
  coordinates: FrameScatterCoordinates,
): FrameScatterSeriesBuild {
  if (frame.rawChunks.length === 0) return { series: [] };
  if (!coordinates.y) return { series: [] };
  const yCoordinate = coordinates.y;

  const pointsElement = spec.elements.find(
    (element) => element.kind === "points" && element.enabled !== false,
  );
  if (!pointsElement) return { series: [] };
  if (getOpt<string>(pointsElement.options, "summaryStat", "none") !== "none") {
    return { series: [] };
  }

  const jitterModeRaw = getOpt<string>(pointsElement.options, "jitter", "stacked");
  const jitterMode = jitterModeRaw === "uniform" || jitterModeRaw === "normal"
    ? jitterModeRaw
    : jitterModeRaw === "auto"
      ? "auto"
      : "stacked";
  const jitterLimit = Math.max(
    0,
    Math.min(1, getOpt<number>(pointsElement.options, "jitterLimit", 0.5)),
  );
  const grouping = spec.encoding.overlay ?? spec.encoding.color;
  const groupOrder = grouping
    ? applyValueOrder(
      [...(frame.dictionaries.group ?? [])],
      valueOrders?.[grouping.name],
    )
    : [];
  const hiddenGroups = grouping
    ? new Set(spec.hiddenGroups ?? [])
    : new Set<string>();
  const yExtent = frame.extents[yCoordinate.vector];
  const yMin = sharedRanges?.yMin ?? yExtent?.min ?? 0;
  const yMax = sharedRanges?.yMax ?? yExtent?.max ?? (yMin + 1);
  const frameGroups = buildFrameScatterItems({
    frame,
    xCoordinate: {
      vector: coordinates.x.vector,
      type: coordinates.x.type,
      categories: coordinates.x.categories,
      constant: coordinates.x.constant,
    },
    yCoordinate,
    groupOrder,
    hiddenGroups,
    facet: panelFacet
      ? {
        ...(panelFacet.groupXValue === null ? {} : { facetX: panelFacet.groupXValue }),
        ...(panelFacet.groupYValue === null ? {} : { facetY: panelFacet.groupYValue }),
        ...(panelFacet.wrapValue == null ? {} : { wrap: panelFacet.wrapValue }),
      }
      : undefined,
    jitter: {
      mode: jitterMode,
      limit: jitterLimit,
      seed: frame.sampling.mode === "sample" ? frame.sampling.seed : 0,
    },
    plotGeometry: {
      plotWidth: 640,
      plotHeight: 400,
      xMin: Number.isFinite(spec.xAxis?.min) ? spec.xAxis!.min : sharedRanges?.xMin,
      xMax: Number.isFinite(spec.xAxis?.max) ? spec.xAxis!.max : sharedRanges?.xMax,
      yMin,
      yMax: yMax === yMin ? yMin + 1 : yMax,
    },
  });
  const visibleFrameGroups = frameGroups.filter((group) => group.items.length > 0);

  let xMin = Infinity;
  let xMax = -Infinity;
  let pointYMin = Infinity;
  let pointYMax = -Infinity;
  for (const group of visibleFrameGroups) {
    for (const item of group.items) {
      const x = Number(item.value[0]);
      const y = item.value[1];
      if (coordinates.x.type !== "nominal" && Number.isFinite(x)) {
        if (x < xMin) xMin = x;
        if (x > xMax) xMax = x;
      }
      if (y < pointYMin) pointYMin = y;
      if (y > pointYMax) pointYMax = y;
    }
  }

  const scatterSeries = visibleFrameGroups.map((group) => {
    const orderedIndex = grouping ? Math.max(0, groupOrder.indexOf(group.name)) : 0;
    const color = theme.categorical[orderedIndex % theme.categorical.length];
    const styleKey = grouping ? group.name : DEFAULT_GROUP_KEY;
    const style = resolveGroupStyle(
      styleKey,
      color,
      !!grouping,
      theme,
      spec.styles,
    );
    const symbol = markerToSymbol(style.point.marker);
    let symbolSize: number | ((value: unknown, params: { dataIndex: number }) => number) = style.point.size;
    if (spec.encoding.size) {
      const finiteSizes = group.items
        .map((item) => item.sizeValue)
        .filter((value): value is number => Number.isFinite(value));
      if (finiteSizes.length > 0) {
        let min = Infinity;
        let max = -Infinity;
        for (const value of finiteSizes) {
          if (value < min) min = value;
          if (value > max) max = value;
        }
        const range = max - min || 1;
        symbolSize = (_value, params) => {
          const sizeValue = group.items[params.dataIndex]?.sizeValue;
          return Number.isFinite(sizeValue) ? 6 + ((sizeValue! - min) / range) * 22 : 6;
        };
      }
    }
    return {
      type: "scatter",
      name: grouping ? group.name : yCoordinate.column,
      symbol: symbol.symbol,
      symbolSize,
      itemStyle: pointItemStyle(style.point, symbol.hollow),
      progressive: 0,
      data: group.items as FrameScatterItem[],
      z: 5,
    };
  });
  return {
    series: scatterSeries,
    extents: {
      ...(Number.isFinite(xMin) ? { x: { min: xMin, max: xMax } } : {}),
      ...(Number.isFinite(pointYMin) ? { y: { min: pointYMin, max: pointYMax } } : {}),
    },
  };
}


function frameNeedsProjectedRows(spec: GraphSpec): boolean {
  return spec.elements.some((element) => {
    if (element.enabled === false) return false;
    if (element.kind === "bar" || element.kind === "smoother" || element.kind === "fitline") {
      return true;
    }
    if (element.kind === "line") {
      return getOpt<string>(element.options, "summaryStat", "mean") === "none";
    }
    return false;
  });
}

function materializeFrameRows(
  spec: GraphSpec,
  data: GraphData,
  frame: GraphDataFrame,
  panelFacet?: PanelFacetContext,
): GraphData {
  if (!frameNeedsProjectedRows(spec)) return { columns: data.columns, rows: [] };

  const rows: unknown[][] = [];
  const columnIndexes = new Map(data.columns.map((column, index) => [column, index]));
  const setValue = (row: unknown[], field: FieldRef | undefined, value: unknown): void => {
    if (!field) return;
    const index = columnIndexes.get(field.name);
    if (index !== undefined) row[index] = value;
  };
  const grouping = spec.encoding.overlay ?? spec.encoding.color;

  for (const chunk of frame.rawChunks) {
    const groupCodes = chunk.groupCodes
      ?? (chunk.roleVectors?.group instanceof Uint32Array ? chunk.roleVectors.group : undefined);
    const sizeValues = chunk.sizeValues
      ?? (chunk.roleVectors?.size instanceof Float64Array ? chunk.roleVectors.size : undefined);
    const facetXCodes = chunk.facetXCodes
      ?? (chunk.roleVectors?.groupX instanceof Uint32Array ? chunk.roleVectors.groupX : undefined);
    const facetYCodes = chunk.facetYCodes
      ?? (chunk.roleVectors?.groupY instanceof Uint32Array ? chunk.roleVectors.groupY : undefined);
    const wrapCodes = chunk.wrapCodes
      ?? (chunk.roleVectors?.wrap instanceof Uint32Array ? chunk.roleVectors.wrap : undefined);
    const rowCount = Math.min(chunk.rowCount, chunk.yValues.length, chunk.rowIds.length);
    for (let index = 0; index < rowCount; index += 1) {
      if (panelFacet && panelFacet.groupXValue !== null) {
        if (!facetXCodes || !bitIsSet(chunk.validity.facetX, index)) continue;
        if (frame.dictionaries.facetX?.[facetXCodes[index] >>> 0] !== panelFacet.groupXValue) continue;
      }
      if (panelFacet && panelFacet.groupYValue !== null) {
        if (!facetYCodes || !bitIsSet(chunk.validity.facetY, index)) continue;
        if (frame.dictionaries.facetY?.[facetYCodes[index] >>> 0] !== panelFacet.groupYValue) continue;
      }
      if (panelFacet?.wrapValue != null) {
        if (!wrapCodes || !bitIsSet(chunk.validity.wrap, index)) continue;
        if (frame.dictionaries.wrap?.[wrapCodes[index] >>> 0] !== panelFacet.wrapValue) continue;
      }
      const row = new Array<unknown>(data.columns.length).fill(null);
      if (spec.encoding.x && bitIsSet(chunk.validity.x, index)) {
        const rawX = chunk.xValues[index];
        const xValue = chunk.xValues instanceof Uint32Array
          ? frame.dictionaries.x?.[rawX >>> 0]
          : rawX;
        setValue(
          row,
          spec.encoding.x,
          spec.encoding.x.type === "datetime" && typeof xValue === "string"
            ? Date.parse(xValue)
            : xValue,
        );
      }
      if (bitIsSet(chunk.validity.y, index)) {
        setValue(row, spec.encoding.y, chunk.yValues[index]);
      }
      if (grouping && groupCodes && bitIsSet(chunk.validity.group, index)) {
        setValue(row, grouping, frame.dictionaries.group?.[groupCodes[index] >>> 0]);
      }
      if (spec.encoding.size && sizeValues && bitIsSet(chunk.validity.size, index)) {
        setValue(row, spec.encoding.size, sizeValues[index]);
      }
      const rowIdIndex = columnIndexes.get(ROW_ID_COL);
      if (rowIdIndex !== undefined) row[rowIdIndex] = Number(chunk.rowIds[index]);
      rows.push(row);
    }
  }
  return { columns: data.columns, rows };
}
function collectFacetKeysFromFrame(
  frame: GraphDataFrame | undefined,
  dictionaryKey: "facetX" | "facetY" | "wrap",
  order: string[] | undefined,
): string[] | null {
  if (!frame) return null;
  const dict = frame.dictionaries[dictionaryKey];
  if (dict && dict.length > 0) return applyValueOrder([...dict], order);
  const summary = frame.aggregates.find((packet) => packet.kind === "summary");
  if (!summary || summary.kind !== "summary") return null;
  const keys = Array.from(new Set(
    summary.summaries
      .map((entry) => entry[dictionaryKey])
      .filter((value): value is string => typeof value === "string"),
  ));
  return keys.length > 0 ? applyValueOrder(keys, order) : null;
}

function buildGraphBase(
  spec: GraphSpec,
  data: GraphData,
  theme: GraphTheme,
  valueOrders?: Record<string, string[]>,
  frame?: GraphDataFrame,
): BuiltGraph {
  const { encoding } = spec;
  const fx = encoding.groupX;
  const fy = encoding.groupY;
  const frameBacked = !!frame;

  const correlationElementEnabled = spec.elements.some(
    (element) => element.enabled !== false && element.kind === "correlationMatrix",
  );
  const correlationMatrixPacket = findCorrelationMatrixPacket(frame?.aggregates);

  if (correlationElementEnabled && correlationMatrixPacket) {
    const frameSafeData: GraphData = frameBacked ? { columns: data.columns, rows: [] } : data;
    return {
      panels: [{
        title: spec.title || "",
        option: buildSingleOption(spec, frameSafeData, theme, undefined, valueOrders, undefined, frame?.aggregates),
        groupXValue: null,
        groupYValue: null,
      }],
      cols: 1,
      rows: 1,
    };
  }
  const frameSafeData: GraphData = frame ? materializeFrameRows(spec, data, frame) : data;

  // Compute the global ordering of overlay/color groups across the FULL
  // dataset so each panel can map its local group(s) back to the same
  // color slot. Without this, every panel restarts its group index at 0
  // and the per-group themes set in the legend collapse to a single hue.
  const grouping = encoding.overlay ?? encoding.color;
  const globalGroupKeys = grouping
    ? applyValueOrder(
      frameBacked && frame?.dictionaries.group
        ? [...frame.dictionaries.group]
        : Array.from(groupBy(data, grouping).keys()),
      valueOrders?.[grouping.name],
    )
    : undefined;

  // No explicit groupX / groupY — fall through to the legacy single-axis
  // wrap path (handled below).
  if (!fx && !fy) {
    const fw = encoding.wrap;
    if (!fw) {
      return {
        panels: [{
          title: spec.title || "",
          option: buildSingleOption(spec, frameSafeData, theme, globalGroupKeys, valueOrders, undefined, frame?.aggregates, undefined, frame),
          groupXValue: null,
          groupYValue: null,
        }],
        cols: 1,
        rows: 1,
      };
    }
    const wrapKeys = collectFacetKeysFromFrame(frame, "wrap", valueOrders?.[fw.name])
      ?? collectFacetKeys(data, fw, valueOrders);
    if (!wrapKeys) {
      return {
        panels: [{
          title: spec.title || "",
          option: buildSingleOption(spec, frameSafeData, theme, globalGroupKeys, valueOrders, undefined, frame?.aggregates, undefined, frame),
          groupXValue: null,
          groupYValue: null,
        }],
        cols: 1,
        rows: 1,
      };
    }
    const wIdx = colIndex(data, fw.name);
    // Pin every wrap panel to the same axis bounds for fair comparison.
    const sharedRanges = frameBacked
      ? undefined
      : computeSharedRanges(data, encoding, valueOrders, spec.hiddenGroups, collectRefLineYs(spec), collectRefLineXs(spec));
    // Drop wrap keys whose subset has no plottable rows so we don't
    // render an empty panel taking up grid space (e.g. Build=EV2 with
    // every Y NaN). Bug fix: previously these blank panels still
    // claimed a cell, leaving the visible panels squeezed alongside
    // wasted whitespace. See `hasPlottableRows` for the "plottable"
    // definition (matches collectCategories' yIdx finiteness filter).
    const nonEmptyWrapKeys = frameBacked ? wrapKeys : wrapKeys.filter((key) => {
      const subRows = data.rows.filter((r) => toStr(r[wIdx]) === key);
      return hasPlottableRows(subRows, encoding, data);
    });
    // If every panel got filtered out (degenerate input), fall back to
    // the original key list so the user at least sees blank panels
    // rather than a silently empty graph.
    const effectiveWrapKeys = nonEmptyWrapKeys.length > 0 ? nonEmptyWrapKeys : wrapKeys;
    const cols = Math.max(1, Math.min(4, Math.ceil(Math.sqrt(effectiveWrapKeys.length))));
    const rows = Math.max(1, Math.ceil(effectiveWrapKeys.length / cols));
    const panels = effectiveWrapKeys.map((key) => {
      const subSpec: GraphSpec = {
        ...spec,
        encoding: { ...encoding, wrap: undefined },
      };
      const panelFacet: PanelFacetContext = {
        groupXValue: null,
        groupYValue: null,
        wrapValue: key,
      };
      const subRows = frameBacked ? [] : data.rows.filter((r) => toStr(r[wIdx]) === key);
      const subData: GraphData = frame
        ? materializeFrameRows(subSpec, data, frame, panelFacet)
        : { columns: data.columns, rows: subRows };
      return {
        title: `${fw.name}=${key}`,
        option: buildSingleOption(subSpec, subData, theme, globalGroupKeys, valueOrders, sharedRanges, frame?.aggregates, panelFacet, frame),
        groupXValue: null,
        groupYValue: null,
      };
    });
    return { panels, cols, rows };
  }

  // groupX and/or groupY active — build a 2D Trellis grid. Either axis
  // may be missing, in which case its key list collapses to a single
  // sentinel slot so the cross-product still produces panels.
  const xKeys = fx
    ? (collectFacetKeysFromFrame(frame, "facetX", valueOrders?.[fx.name])
      ?? collectFacetKeys(data, fx, valueOrders)
      ?? [""])
    : [null];
  const yKeys = fy
    ? (collectFacetKeysFromFrame(frame, "facetY", valueOrders?.[fy.name])
      ?? collectFacetKeys(data, fy, valueOrders)
      ?? [""])
    : [null];
  const fxIdx = fx ? colIndex(data, fx.name) : -1;
  const fyIdx = fy ? colIndex(data, fy.name) : -1;

  // Compute global axis bounds once so every Trellis cell pins to the
  // same X / Y range — this is what makes Group Y stacking and Group X
  // tiling actually comparable ("完全相同的 Y 轴坐标"). Hidden legend
  // groups are excluded from the range calc so visible data fills the
  // chart area instead of being squashed by data that never renders.
  const sharedRanges = frameBacked
    ? undefined
    : computeSharedRanges(data, encoding, valueOrders, spec.hiddenGroups, collectRefLineYs(spec), collectRefLineXs(spec));
  // Drop facet keys whose ENTIRE row / column has no plottable rows.
  // Works the same in 1D (only groupX or only groupY) and 2D Trellis:
  //   • If every row in the Y stripe `Build=EV2` is non-plottable,
  //     every (EV2, *) cell is too — dropping the whole Y key just
  //     removes one grid row, alignment between the surviving cells
  //     is preserved.
  //   • Likewise for an entirely empty X column.
  //   • An individual empty CELL whose Y row and X column both still
  //     have data elsewhere is intentionally kept (rendered as an
  //     empty panel) by the inner cell loop below — that empty cell
  //     is itself a useful signal that "this Y×X combo has no data".
  // Without this, the user's screenshot showed `Build=EV2` as a row
  // of four blank panels eating ¼ of the grid height.
  const nonEmptyXKeys = frameBacked ? xKeys : !fx ? xKeys : xKeys.filter((xKey) => {
    if (xKey === null) return true;
    const subRows = data.rows.filter((r) => toStr(r[fxIdx]) === xKey);
    return hasPlottableRows(subRows, encoding, data);
  });
  const nonEmptyYKeys = frameBacked ? yKeys : !fy ? yKeys : yKeys.filter((yKey) => {
    if (yKey === null) return true;
    const subRows = data.rows.filter((r) => toStr(r[fyIdx]) === yKey);
    return hasPlottableRows(subRows, encoding, data);
  });
  // Degenerate guard: if every panel got filtered out, fall back to
  // the original key list so the user sees blank panels rather than
  // a silently empty graph.
  const effectiveXKeys = nonEmptyXKeys.length > 0 ? nonEmptyXKeys : xKeys;
  const effectiveYKeys = nonEmptyYKeys.length > 0 ? nonEmptyYKeys : yKeys;
  const panels: BuiltGraph["panels"] = [];
  // row-major: outer loop = Y (top → bottom rows), inner loop = X
  // (left → right within each row). Matches the CSS grid in <Graph>.
  for (const yKey of effectiveYKeys) {
    for (const xKey of effectiveXKeys) {
      // Strip the facet encodings from the sub-spec so the inner builder
      // doesn't try to re-facet recursively, and drop `wrap` too — when
      // groupX / groupY are present, wrap is ignored (see header comment).
      const subSpec: GraphSpec = {
        ...spec,
        encoding: { ...encoding, groupX: undefined, groupY: undefined, wrap: undefined },
      };
      const panelFacet: PanelFacetContext = {
        groupXValue: xKey,
        groupYValue: yKey,
      };
      const subRows = frameBacked ? [] : data.rows.filter((r) => {
        if (fx && xKey !== null && toStr(r[fxIdx]) !== xKey) return false;
        if (fy && yKey !== null && toStr(r[fyIdx]) !== yKey) return false;
        return true;
      });
      const subData: GraphData = frame
        ? materializeFrameRows(subSpec, data, frame, panelFacet)
        : { columns: data.columns, rows: subRows };
      panels.push({
        title: facetTitle(xKey, yKey, encoding),
        option: buildSingleOption(subSpec, subData, theme, globalGroupKeys, valueOrders, sharedRanges, frame?.aggregates, panelFacet, frame),
        groupXValue: xKey,
        groupYValue: yKey,
      });
    }
  }

  return {
    panels,
    cols: Math.max(1, effectiveXKeys.length),
    rows: Math.max(1, effectiveYKeys.length),
  };
}

function transposeBuiltGraph(graph: BuiltGraph): BuiltGraph {
  const panels: BuiltGraph["panels"] = new Array(graph.panels.length);
  for (let row = 0; row < graph.rows; row += 1) {
    for (let col = 0; col < graph.cols; col += 1) {
      const sourceIndex = row * graph.cols + col;
      const targetIndex = col * graph.rows + row;
      const panel = graph.panels[sourceIndex];
      if (!panel) continue;
      panels[targetIndex] = {
        ...panel,
        option: transposeOption(panel.option),
        groupXValue: panel.groupYValue,
        groupYValue: panel.groupXValue,
      };
    }
  }
  return { panels, cols: graph.rows, rows: graph.cols };
}

export function buildGraph(
  spec: GraphSpec,
  data: GraphData,
  theme: GraphTheme,
  valueOrders?: Record<string, string[]>,
  frame?: GraphDataFrame,
): BuiltGraph {
  const graph = buildGraphBase({ ...spec, transpose: false }, data, theme, valueOrders, frame);
  return spec.transpose ? transposeBuiltGraph(graph) : graph;
}
