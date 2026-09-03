/**
 * Graph Core - 统一图形规范类型
 *
 * 设计目标：
 * - 与具体渲染库（当前为 ECharts）解耦的抽象规范
 * - 描述「图形元素 + 编码通道 + 数据来源」三要素
 * - 可被未来其他模块（统计图、回归图、分布图等）复用
 */

/** 数据字段类型（来自数据表列） */
export type FieldType =
  | "continuous"   // 连续数值
  | "nominal"      // 分类离散
  | "ordinal"      // 有序分类
  | "datetime"     // 时间
  | "id";          // 标识

/** 数据字段引用 */
export interface FieldRef {
  /** Stable dataset-scoped identity. Missing only in legacy project files. */
  columnId?: string;
  /** 列名，必须存在于数据源中 */
  name: string;
  /** 字段类型，用于决定坐标轴/编码方式 */
  type: FieldType;
}

/** 图形元素类型（一张图可叠加多个元素） */
export type ElementKind =
  | "points"       // 散点
  | "line"         // 折线
  | "bar"          // 柱状（含分组均值）
  | "heatmap"      // 热力图
  | "correlationMatrix" // 相关矩阵热力图
  | "histogram"    // 直方图
  | "normalCurve"  // 正态分布拟合曲线
  | "boxplot"      // 箱线
  | "smoother"     // 平滑曲线
  | "fitline"      // 拟合线（多项式 / 稳健 Cauchy + 置信区间 + 统计量）
  | "surface"      // 3D 曲面（仅 3D 模式；由 X/Y/Z 三通道构建）
  | "contour3d"    // 3D 等高线（仅 3D 模式；由 X/Y/Z 三通道构建）
  | "scatter3d";   // 3D 散点（仅 3D 模式；由 X/Y/Z 三通道构建）

/** 平滑器配置 */
export interface SmootherOptions {
  /** 平滑窗口比例 0~1 */
  lambda?: number;
}

/** 点的符号形状 */
export type MarkerShape =
  | "circle"
  | "emptyCircle"
  | "square"
  | "emptySquare"
  | "diamond"
  | "emptyDiamond"
  | "triangle"
  | "emptyTriangle";

/** Style for a single visual mark category (line / fill / point).
 *  Not every field is meaningful for every category — e.g. `marker`
 *  only applies to point marks; `lineWidth` applies to lines and to
 *  the borders of fills/points. Unset fields fall back to defaults. */
export interface MarkStyle {
  /** Stroke color (line stroke / point border / fill border) */
  color?: string;
  /** Fill color (point body / shape body). Defaults to `color`. */
  fillColor?: string;
  /** Marker shape (points only) */
  marker?: MarkerShape;
  /** Marker size px (points only) */
  markerSize?: number;
  /** Line / border width px */
  lineWidth?: number;
  /** Opacity 0..1 */
  opacity?: number;
}

/** Per-group style: every chart element belonging to the group inherits
 *  these line / fill / point sub-styles, regardless of its kind. The
 *  `gradient` mark is used by 3D surfaces / scatter — each legend group
 *  gets its own gradient color (theme-assigned, user-overridable), just
 *  like line / fill / point. */
export interface GroupStyle {
  line?: MarkStyle;
  fill?: MarkStyle;
  point?: MarkStyle;
  gradient?: MarkStyle;
}

/** Map of group key (the category value from the Color/Overlay encoding,
 *  or the empty string for the un-grouped default) → GroupStyle. */
export type GroupStyleMap = Record<string, GroupStyle>;

/** Sentinel key used in `GroupStyleMap` when the chart has no
 *  Color/Overlay split (single-series rendering). */
export const DEFAULT_GROUP_KEY = "__default__";

/** Line style for user-added Y-axis reference lines.
 *  Matches ECharts' three core dash patterns; chosen as a closed enum
 *  (instead of an arbitrary string) so the dropdown UI and the renderer
 *  stay in sync. */
export type RefLineStyle = "solid" | "dashed" | "dotted";

/** User-defined horizontal reference line on the primary Y axis.
 *  Rendered via ECharts `markLine` on an invisible carrier series so it
 *  always appears regardless of which data series the user has enabled. */
export interface RefLineY {
  /** Stable id for React keys and updates. */
  id: string;
  /** Y-axis value the line is drawn at. */
  y: number;
  /** Free-form label text rendered at the right end of the line.
   *  Empty string suppresses the label entirely. */
  label: string;
  /** Visual dash pattern. */
  style: RefLineStyle;
  /** Stroke color (any CSS color string; the UI emits hex). */
  color: string;
  /** Stroke width in CSS px. */
  width: number;
}

/** User-defined vertical reference line on the primary X axis.
 *  Symmetric to `RefLineY` — the renderer only draws these when the X
 *  axis is value-type (continuous or datetime). When X is categorical
 *  the lines are silently skipped (drawing a vertical marker between
 *  unrelated category bands has no meaningful position), but they
 *  remain in the spec so toggling axis bindings is non-destructive.
 *
 *  Shape mirrors `RefLineY` exactly except the value field is named
 *  `x` instead of `y` so each interface stays self-describing. Swap
 *  X / Y in the UI converts `{y}` ↔ `{x}` while preserving every
 *  other field. */
export interface RefLineX {
  /** Stable id for React keys and updates. */
  id: string;
  /** X-axis value the line is drawn at. */
  x: number;
  /** Free-form label text rendered at the line. Empty string
   *  suppresses the label entirely. */
  label: string;
  /** Visual dash pattern. */
  style: RefLineStyle;
  /** Stroke color (any CSS color string; the UI emits hex). */
  color: string;
  /** Stroke width in CSS px. */
  width: number;
}

/** Per-category reference line whose horizontal (or vertical) extent
 *  is limited to a single category's band on the OPPOSITE axis. Used
 *  by the multi-column auto-spec overlay so each melted column's
 *  LSL / Target / USL renders ONLY across its own band — preventing
 *  the labels and lines of one column from visually colliding with
 *  another's when columns have different spec limits.
 *
 *  No `label` field: with N columns × up to 3 lines per column the
 *  labels would inevitably overlap, so we rely on the column's
 *  position on the categorical axis to convey which limit belongs
 *  to which column.
 *
 *  `valueAxis` tells the renderer which axis the numeric `value`
 *  lives on; the OTHER axis is the one carrying `category`. When
 *  `valueAxis === "y"` the segment is horizontal (constant Y, X span
 *  from `cat - 0.45` to `cat + 0.45`); when `"x"` the segment is
 *  vertical (constant X, Y span the band). The renderer silently
 *  skips lines whose category isn't on the rendered cat axis (e.g.
 *  after a Swap X & Y inverts which axis is categorical). */
export interface BandRefLine {
  /** Stable id for React keys / dedup. */
  id: string;
  /** Numeric position on the value axis (the axis named by
   *  `valueAxis`). */
  value: number;
  /** Category name on the OPPOSITE axis. The segment is restricted
   *  to this band's width. */
  category: string;
  /** Which axis carries the numeric `value`. The OTHER axis is the
   *  category axis where `category` is looked up. */
  valueAxis: "x" | "y";
  /** Stroke color (any CSS color string). */
  color: string;
  /** Dash pattern. */
  style: RefLineStyle;
  /** Stroke width in px. */
  width: number;
}

/** User overrides for the primary Y axis. Every field is optional and
 *  `undefined` means *auto* — i.e. let ECharts derive the value from the
 *  data range. The whole object being `undefined` (or empty) restores
 *  fully automatic behavior, which is what the "Reset to auto" button in
 *  the Y Axis Settings dialog produces. */
export interface YAxisConfig {
  /** Hard lower bound. `undefined` → auto (data-driven). */
  min?: number;
  /** Hard upper bound. `undefined` → auto (data-driven). */
  max?: number;
  /** Increment between adjacent major ticks (ECharts `interval`).
   *  e.g. `5` produces ticks at 0, 5, 10, ... `undefined` → ECharts
   *  picks the spacing automatically based on chart height. */
  tickInterval?: number;
  /** Number of decimal places to show on tick labels.
   *  `undefined` → use ECharts' default numeric formatting. */
  decimals?: number;
  /** Reverse the axis direction (largest at the bottom). */
  inverse?: boolean;
  /** Number of minor sub-ticks drawn between every pair of major
   *  ticks. `undefined` (or 0) → no minor ticks (the default). */
  minorTickCount?: number;
  /** Whether to show the axis boundary line itself. `undefined` → use
   *  theme default (currently visible). Set explicitly to `false` to
   *  hide the axis line, or `true` to lock it on. */
  showAxisLine?: boolean;
  /** Where tick marks point relative to the axis line: `"outside"`
   *  (toward the labels — the default) or `"inside"` (into the plot
   *  area). Only meaningful when the axis line is visible. */
  tickPosition?: "inside" | "outside";
  /** Show major split-lines (gridlines at major ticks). `undefined` →
   *  use theme default (currently visible, dashed). */
  showMajorGrid?: boolean;
  /** Show minor split-lines (gridlines at minor ticks). `undefined` →
   *  use theme default (currently hidden). */
  showMinorGrid?: boolean;
  /** Styling for the major gridlines (color / width / dash). Any
   *  unset sub-field falls back to the theme default. */
  majorGridStyle?: GridLineStyle;
  /** Styling for the minor gridlines (color / width / dash). Any
   *  unset sub-field falls back to the theme default. */
  minorGridStyle?: GridLineStyle;
}

/** Visual style for a major or minor gridline. Mirrors the small subset
 *  of ECharts `lineStyle` options the user actually picks from. Reuses
 *  `RefLineStyle` for the dash pattern so the UI dropdown stays in sync
 *  across editors. Any field left `undefined` keeps the theme default. */
export interface GridLineStyle {
  /** Stroke color (CSS color string, typically a hex from the picker). */
  color?: string;
  /** Stroke width in CSS px. */
  width?: number;
  /** Dash pattern. */
  style?: RefLineStyle;
}

/** Auto-derived spec-limit reference lines for a single value-axis
 *  column. Sourced from the column's `extras.spec = { lsl, target,
 *  usl }`. Distinct from the user-editable `refLinesY` / `refLinesX`
 *  lists so the auto lines never pollute the per-line editor —
 *  they're an ambient, data-driven overlay that follows the X / Y
 *  encoding.
 *
 *  Both axes carry the same shape (`autoSpecY` + `autoSpecX` on
 *  `GraphSpec`): whichever value-type column the user binds to an axis
 *  contributes its own spec extras to that axis. After a Swap X & Y
 *  the two snapshots flip with the encoding, so the limits always
 *  follow the column — not the axis label.
 *
 *  Future multi-column / facet support: when we eventually allow
 *  several columns to share a value axis (or facet on that axis),
 *  these single objects will be promoted to `Record<groupKey,
 *  AutoSpec>` so the renderer can emit a different set of spec lines
 *  per group. The current shape is the trivial single-group case of
 *  that future generalization. */
export interface AutoSpec {
  /** Lower spec limit (rendered red). `undefined` skips the line. */
  lsl?: number;
  /** Target value (rendered green). `undefined` skips the line. */
  target?: number;
  /** Upper spec limit (rendered red). `undefined` skips the line. */
  usl?: number;
  /** Source column name, used purely for tooltip / debugging. */
  colName?: string;
}

/** 单个图形元素的配置 */
export interface ChartElement {
  kind: ElementKind;
  /** 元素是否启用 */
  enabled?: boolean;
  /** 元素特有选项 */
  options?: SmootherOptions & Record<string, unknown>;
}

/** 编码通道：将数据字段映射到视觉属性 */
export interface Encoding {
  /** X 轴 */
  x?: FieldRef;
  /** Y 轴 */
  y?: FieldRef;
  /** Z 轴（仅 3D 模式使用） */
  z?: FieldRef;
  /** 颜色编码（分组着色 / 连续色阶） */
  color?: FieldRef;
  /** 尺寸编码 */
  size?: FieldRef;
  /** 叠加（同图叠绘多条系列） */
  overlay?: FieldRef;
  /** 横向分面 */
  groupX?: FieldRef;
  /** 纵向分面 */
  groupY?: FieldRef;
  /** 深度分面（仅 3D 模式使用） */
  groupZ?: FieldRef;
  /** 自动换行分面 */
  wrap?: FieldRef;
}

/** 完整的图形规范 */
export interface GraphSpec {
  /** 数据集标识（仅用于缓存/标题） */
  datasetId?: string;
  /** 数据集名称（标题用） */
  datasetName?: string;
  /** Transpose the completed chart visually without changing data roles. */
  transpose?: boolean;
  /** 编码 */
  encoding: Encoding;
  /** 图形元素列表（按层叠绘） */
  elements: ChartElement[];
  /** 标题（可选，未提供则按编码生成） */
  title?: string;
  /** Per-group line/fill/point style overrides. Keys are the category
   *  values from `encoding.color`/`encoding.overlay`, or `DEFAULT_GROUP_KEY`
   *  when there is no grouping. Missing entries fall back to JMP-style
   *  defaults (black lines, small black filled dots, gray outliers). */
  styles?: GroupStyleMap;
  /** Group values to hide from the chart (legend show/hide toggle).
   *  Hidden groups keep their color slot reserved so toggling back on
   *  restores the same color, but their series are skipped at render
   *  time and their rows are excluded from shared-axis range computation
   *  so visible data fills the chart area. */
  hiddenGroups?: string[];
  /** User-added horizontal reference lines on the Y axis (e.g. spec
   *  limits, target values, thresholds). Rendered as ECharts markLines
   *  on an invisible carrier series so they appear independently of
   *  which data series are toggled on. */
  /** User-added horizontal reference lines on the Y axis (e.g. spec
   *  limits, target values, thresholds). Rendered as ECharts markLines
   *  on an invisible carrier series so they appear independently of
   *  which data series are toggled on. Only drawn when the Y axis is
   *  value-type — lines on a categorical Y are silently skipped
   *  because a numeric marker between unrelated category bands has
   *  no meaningful position. */
  refLinesY?: RefLineY[];
  /** User-added vertical reference lines on the X axis. Mirror of
   *  `refLinesY` for the X axis. Only drawn when the X axis is
   *  value-type — lines on a categorical X are silently skipped. */
  refLinesX?: RefLineX[];
  /** Per-category spec-limit reference lines emitted by the
   *  multi-column auto-spec feature. Each entry restricts itself to
   *  one category's band on the OPPOSITE axis so spec limits from
   *  different melted columns don't visually compete on the value
   *  axis. Labels are intentionally omitted (column-position conveys
   *  identity); the renderer dedicates a separate carrier series so
   *  these lines remain segregated from the user-editable
   *  `refLinesY` / `refLinesX` lists. */
  bandRefLines?: BandRefLine[];
  /** Auto-derived spec-limit lines pulled from the Y column's extras.
   *  Rendered side-by-side with `refLinesY` on the same carrier series
   *  but with hardcoded red/green coloring (red = USL/LSL, green =
   *  Target). Kept off the user-editable list so the editor stays
   *  focused on manually-added annotations. `undefined` skips the
   *  overlay entirely. */
  autoSpecY?: AutoSpec;
  /** Auto-derived spec-limit lines pulled from the X column's extras.
   *  Mirror of `autoSpecY` for the X axis — lets the renderer emit
   *  vertical spec / target lines when a value-type X column has
   *  `extras.spec` metadata. `undefined` skips the overlay. */
  autoSpecX?: AutoSpec;
  /** Y axis overrides — fixed range, tick density, decimal precision,
   *  reversed direction. `undefined` / empty object means fully
   *  automatic behavior. Edited from the Y Axis Settings dialog
   *  (double-click the Y axis to open). */
  yAxis?: YAxisConfig;
  /** X axis overrides — same shape as `yAxis` (range / tick density /
   *  decimals / inverse / axis line / tick position / minor ticks /
   *  major+minor gridlines). `undefined` / empty object means fully
   *  automatic behavior. Edited from the X Axis Settings dialog
   *  (double-click the X axis to open). Numeric fields like `min` /
   *  `max` / `tickInterval` / `decimals` only take effect on value-type
   *  X axes; ECharts silently ignores them on category / time axes,
   *  but `inverse` / axis-line / tick-position / gridline settings
   *  apply to all three. */
  xAxis?: YAxisConfig;
  /** When true the chart is rendered in 3D (surface plot) from the
   *  `encoding.x` / `encoding.y` / `encoding.z` channels using the
   *  self-contained canvas renderer instead of the 2D ECharts path.
   *  `undefined` / false = normal 2D rendering. */
  threeD?: boolean;
}

/** 原始数据：列式 */
export interface GraphData {
  columns: string[];
  /** 行数据，与 columns 一一对应 */
  rows: unknown[][];
}

/** 字段类型推断：根据列的 SQL 类型字符串 */
export function inferFieldType(sqlType: string): FieldType {
  const t = (sqlType || "").toUpperCase();
  if (
    t.includes("INT") ||
    t.includes("DOUBLE") ||
    t.includes("FLOAT") ||
    t.includes("REAL") ||
    t.includes("DECIMAL") ||
    t.includes("NUMERIC") ||
    t.includes("HUGEINT") ||
    t.includes("BIGINT")
  ) {
    return "continuous";
  }
  if (t.includes("DATE") || t.includes("TIME") || t.includes("TIMESTAMP")) {
    return "datetime";
  }
  if (t.includes("BOOL")) {
    return "nominal";
  }
  return "nominal";
}
