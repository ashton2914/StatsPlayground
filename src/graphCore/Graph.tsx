/**
 * <Graph> 组件 — Graph Core 的 React 入口
 *
 * 接收 GraphSpec + GraphData，渲染为一个或多个 ECharts 实例（分面）。
 * 自动响应窗口尺寸变化与主题变化。
 */

import { useEffect, useMemo, useRef } from "react";
import * as echarts from "echarts";
import type { GraphSpec, GraphData } from "./types";
import { withoutGraphAnimation } from "./animation";
import { getGraphTheme } from "./theme";
import { buildGraph, type ScatterPointPick } from "./transform";
import { withInterleavedGraphLayers } from "./layers";
import { Chart3D } from "./Chart3D";
import { build3DPanels } from "./threeD";
import type { GraphDataFrame } from "@/types/graphData";
import { useThemeStore } from "@/stores/useThemeStore";

interface GraphProps {
  spec: GraphSpec;
  data: GraphData;
  frame?: GraphDataFrame | null;
  className?: string;
  /** 单个面板最小宽 */
  minPanelWidth?: number;
  /** 单个面板最小高 */
  minPanelHeight?: number;
  /**
   * Optional per-column user-defined value ordering. Keyed by column name;
   * each entry lists the categorical values in the order they should appear
   * on category axes (X / boxplot bins), in the legend, and in faceted
   * panels. Values missing from a list keep their natural data order at
   * the end (see transform.ts `applyValueOrder`).
   */
  valueOrders?: Record<string, string[]>;
  /**
   * Fired when the user double-clicks anywhere inside the Y axis region
   * (axis line, ticks, labels, or the title strip). The GraphBuilder
   * opens its Y Axis settings dialog from here so users have a discoverable,
   * direct-manipulation entry point next to the axis itself.
   */
  onYAxisDblClick?: () => void;
  /**
   * Fired when the user double-clicks anywhere inside the X axis region
   * (axis line, ticks, labels, or the title strip at the bottom of the
   * chart). Mirrors `onYAxisDblClick` — the GraphBuilder opens its
   * X Axis settings dialog from here.
   */
  onXAxisDblClick?: () => void;
  /**
   * Fired when the user finishes a drag gesture on either axis to pin
   * a new `[min, max]` range. Two gestures produce this callback:
   *   • click-and-drag the OUTER thirds of the axis strip ("min" or
   *     "max" handle) — stretches/shrinks that end of the range,
   *   • click-and-drag the MIDDLE third ("pan") — shifts both bounds
   *     by the same amount so the visible window scrolls.
   * The visual preview during the drag is applied directly via
   * `setOption` for snappy feedback; on mouseup we read the final
   * bounds back from the chart and commit them through this callback
   * so they persist to project state (and ride through future
   * re-renders). Skipped on category axes since min/max are
   * meaningless there.
   */
  onAxisRangeChange?: (axis: "x" | "y", min: number, max: number) => void;
  /**
   * Fired when the user right-clicks anywhere inside an axis strip (the
   * left Y-axis margin or the bottom X-axis margin). Reports which axis
   * was hit plus the viewport coordinates of the cursor so the consumer
   * can pin a context menu there (axis settings / reset zoom). The
   * default browser context menu is suppressed only when an axis strip
   * is hit; right-clicks in the plot body are left untouched.
   */
  onAxisContextMenu?: (axis: "x" | "y", clientX: number, clientY: number) => void;
  /**
   * Fired when the user clicks a scatter point that originated from a
   * real source row. The payload identifies the dataset row (via
   * `_row_id`) and the user-visible column the point came from
   * (original Y field, or the source column in multi-column melt mode).
   * Aggregated summary dots / boxplot outliers / synthetic overlays do
   * NOT carry pick metadata and therefore never invoke this callback.
   */
  onPointClick?: (pick: ScatterPointPick) => void;
  /**
   * When true, pointer gestures on the chart body enter rubber-band
   * selection mode instead of the default pan/zoom mode. A drag rectangle
   * is drawn as a transparent blue overlay; on release, all scatter points
   * whose pixel coordinates fall inside the rect are collected and reported
   * through `onBrushSelect`. Axis-strip pan/zoom is suppressed while this
   * mode is active.
   */
  brushMode?: boolean;
  /**
   * Fired on pointer-up with the set of (rowId, colName) cells that fell
   * inside the brush rectangle. Each scatter point corresponds to a
   * specific (row, column) cell; the consumer typically maps each pick
   * to the matching table cell. Always called with an array (possibly
   * empty — empty when the rect was too tiny or didn't cover any points,
   * treated as "clear"). Only fired when `brushMode` is true.
   */
  onBrushSelect?: (picks: ScatterPointPick[]) => void;
}

export function Graph({ spec, data, frame, className, minPanelWidth = 320, minPanelHeight = 240, valueOrders, onYAxisDblClick, onXAxisDblClick, onAxisRangeChange, onAxisContextMenu, onPointClick, brushMode, onBrushSelect }: GraphProps) {
  // 订阅主题变化以触发重渲染
  const themeMode = useThemeStore((s) => s.mode);

  // 使用 3D 场景的条件：处于 3D 模式即可。2D 与 3D 图层完全分开，
  // 3D 模式只显示 3D 图层（surface / scatter3d）；无 3D 图层时由
  // Chart3D 显示提示。
  const use3DScene = !!spec.threeD;

  const built = useMemo(() => {
    if (use3DScene) return { cols: 1, rows: 1, panels: [] as ReturnType<typeof buildGraph>["panels"] };
    const theme = getGraphTheme();
    return buildGraph(spec, data, theme, valueOrders, frame ?? undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec, data, themeMode, valueOrders, frame]);

  const built3D = useMemo(
    () => use3DScene
      ? build3DPanels(spec, data, getGraphTheme(), frame ?? undefined, valueOrders)
      : null,
    [spec, data, frame, themeMode, use3DScene, valueOrders],
  );

  // 3D 场景：hooks 之后再分支返回，保证 hooks 调用顺序稳定。
  if (use3DScene) {
    return (
      <div
        className={`gc-graph${className ? " " + className : ""}`}
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${built3D?.cols ?? 1}, minmax(${minPanelWidth}px, 1fr))`,
          gridTemplateRows: `repeat(${built3D?.rows ?? 1}, minmax(${minPanelHeight}px, 1fr))`,
          gap: 8,
          width: "100%",
          height: "100%",
          overflow: "auto",
          padding: 4,
        }}
      >
        {built3D?.panels.map((panel) => (
          <Chart3D
            key={JSON.stringify([panel.groupXValue, panel.groupYValue])}
            spec={spec}
            data={data}
            built={panel}
            title={panel.title}
            minHeight={minPanelHeight}
          />
        ))}
      </div>
    );
  }

  return (
    <div
      className={`gc-graph${className ? " " + className : ""}`}
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(${built.cols}, minmax(${minPanelWidth}px, 1fr))`,
        // Explicit row count is required so Group Y (vertical faceting)
        // actually stacks panels into N rows — without this, the grid
        // falls back to a single implicit row and panels reflow into the
        // X axis only. minmax() keeps each row from collapsing below the
        // per-panel minimum height while still letting the grid grow to
        // fill the available space.
        gridTemplateRows: `repeat(${built.rows}, minmax(${minPanelHeight}px, 1fr))`,
        gap: 8,
        width: "100%",
        height: "100%",
        overflow: "auto",
        padding: 4,
      }}
    >
      {built.panels.map((p, i) => (
        <GraphPanel
          key={i}
          title={p.title}
          option={p.option}
          minHeight={minPanelHeight}
          onYAxisDblClick={onYAxisDblClick}
          onXAxisDblClick={onXAxisDblClick}
          onAxisRangeChange={onAxisRangeChange}
          onAxisContextMenu={onAxisContextMenu}
          onPointClick={onPointClick}
          brushMode={brushMode}
          onBrushSelect={onBrushSelect}
        />
      ))}
    </div>
  );
}

interface GraphPanelProps {
  title: string;
  option: Record<string, unknown>;
  minHeight: number;
  onYAxisDblClick?: () => void;
  onXAxisDblClick?: () => void;
  onAxisRangeChange?: (axis: "x" | "y", min: number, max: number) => void;
  onAxisContextMenu?: (axis: "x" | "y", clientX: number, clientY: number) => void;
  onPointClick?: (pick: ScatterPointPick) => void;
  brushMode?: boolean;
  onBrushSelect?: (picks: ScatterPointPick[]) => void;
}

function GraphPanel({ title, option, minHeight, onYAxisDblClick, onXAxisDblClick, onAxisRangeChange, onAxisContextMenu, onPointClick, brushMode, onBrushSelect }: GraphPanelProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const chartHostRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);
  // Keep the latest callbacks in refs so the Zrender dblclick handler
  // (which we register exactly once on mount) always sees the freshest
  // closure without forcing a re-bind on every prop change.
  const onYAxisDblClickRef = useRef(onYAxisDblClick);
  const onXAxisDblClickRef = useRef(onXAxisDblClick);
  const onAxisRangeChangeRef = useRef(onAxisRangeChange);
  const onPointClickRef = useRef(onPointClick);
  useEffect(() => {
    onYAxisDblClickRef.current = onYAxisDblClick;
  }, [onYAxisDblClick]);
  useEffect(() => {
    onXAxisDblClickRef.current = onXAxisDblClick;
  }, [onXAxisDblClick]);
  useEffect(() => {
    onAxisRangeChangeRef.current = onAxisRangeChange;
  }, [onAxisRangeChange]);
  useEffect(() => {
    onPointClickRef.current = onPointClick;
  }, [onPointClick]);
  const brushModeRef = useRef(brushMode);
  const onBrushSelectRef = useRef(onBrushSelect);
  useEffect(() => { brushModeRef.current = brushMode; }, [brushMode]);
  useEffect(() => { onBrushSelectRef.current = onBrushSelect; }, [onBrushSelect]);

  // 初始化 / 销毁
  useEffect(() => {
    if (!panelRef.current || !chartHostRef.current) return;
    const inst = echarts.init(chartHostRef.current, undefined, { renderer: "canvas" });
    chartRef.current = inst;
    const ro = new ResizeObserver(() => inst.resize());
    ro.observe(panelRef.current);

    // ----- Rubber-band brush overlay ---------------------------------
    // A transparent abs-positioned div painted over the ECharts canvas
    // while the user draws a selection rectangle in brushMode. We create
    // it imperatively so the JSX of GraphPanel stays unchanged. ECharts
    // does NOT clear the container's children after init, so appending
    // here is safe. The overlay has pointer-events:none so input always
    // reaches the container element (which owns our pointer handlers).
    const el = panelRef.current;
    const brushOverlay = document.createElement("div");
    brushOverlay.style.cssText =
      "display:none;position:absolute;pointer-events:none;" +
      "border:1.5px solid #4e9cf5;background:rgba(78,156,245,0.10);z-index:10;box-sizing:border-box;";
    el.appendChild(brushOverlay);

    // Hit-test: given two pointer-pixel corners, return all scatter
    // (rowId, colName) picks whose pixel position falls inside the rect.
    // Dedup by `${rowId}|${colName}` since two scatter series sharing the
    // same source column (e.g. group-faceted) can both emit the same cell.
    const legacyHitTestBrush = (x1: number, y1: number, x2: number, y2: number): ScatterPointPick[] => {
      const minX = Math.min(x1, x2);
      const maxX = Math.max(x1, x2);
      const minY = Math.min(y1, y2);
      const maxY = Math.max(y1, y2);
      if (maxX - minX < 2 && maxY - minY < 2) return [];
      const picks: ScatterPointPick[] = [];
      const seen = new Set<string>();
      try {
        const opt = inst.getOption() as { series?: { type?: string; data?: unknown[] }[] };
        const series = opt.series ?? [];
        for (let si = 0; si < series.length; si++) {
          const s = series[si];
          if (s.type !== "scatter") continue;
          const items = s.data ?? [];
          for (let di = 0; di < items.length; di++) {
            const item = items[di] as { __pick?: ScatterPointPick; value?: unknown[] } | null;
            if (!item || typeof item !== "object") continue;
            const pick = item.__pick;
            if (!pick || typeof pick.rowId !== "number" || pick.rowId < 0) continue;
            if (!pick.colName) continue;
            const key = `${pick.rowId}|${pick.colName}`;
            if (seen.has(key)) continue;
            const val = item.value;
            if (!Array.isArray(val) || val.length < 2) continue;
            const px = inst.convertToPixel({ seriesIndex: si }, val as [number, number]);
            if (!px) continue;
            if (px[0] >= minX && px[0] <= maxX && px[1] >= minY && px[1] <= maxY) {
              seen.add(key);
              picks.push({ rowId: pick.rowId, colName: pick.colName });
            }
          }
        }
      } catch { /* ignore layout errors if chart not fully rendered */ }
      return picks;
    };


    // ECharts' component-targeted `inst.on('dblclick', { componentType:
    // 'yAxis' }, ...)` only fires when the user dblclicks an axis label
    // or the axis line itself — empty space inside the axis strip (tick
    // gaps, the title area) is missed. To make the gesture forgiving we
    // also listen at the Zrender level: a dblclick that lands inside the
    // Y-axis band (either reported by `containPixel({ yAxisIndex: 0 })`
    // or anywhere in the left margin to the left of the grid) opens the
    // Y settings dialog. The X axis uses the symmetrical bottom-margin
    // fallback. When a click sits in the bottom-left corner of the chart
    // (overlap between the two strips) we resolve it via `containPixel`
    // first; only fall back to the geometric strip if both axis hit
    // tests fail — then prefer Y (the historical default).
    const zr = inst.getZr();
    const zrHandler = (e: { offsetX: number; offsetY: number }) => {
      const yCb = onYAxisDblClickRef.current;
      const xCb = onXAxisDblClickRef.current;
      if (!yCb && !xCb) return;
      const pt: [number, number] = [e.offsetX, e.offsetY];
      let inYAxis = false;
      let inXAxis = false;
      try {
        inYAxis = inst.containPixel({ yAxisIndex: 0 }, pt);
      } catch {
        // containPixel can throw if the chart hasn't laid out yet —
        // ignore and fall through to the geometry-based fallback.
      }
      try {
        inXAxis = inst.containPixel({ xAxisIndex: 0 }, pt);
      } catch {
        // see above
      }
      const el = panelRef.current;
      if (!inYAxis && !inXAxis && el) {
        // Geometric fallback: treat the left margin as Y and the bottom
        // margin as X. Conservative caps (80px / 18%) keep the central
        // chart body from triggering either dialog.
        const w = el.clientWidth;
        const h = el.clientHeight;
        const inLeftMargin =
          e.offsetX >= 0 &&
          e.offsetX <= Math.min(80, w * 0.18) &&
          e.offsetY >= 0 &&
          e.offsetY <= h;
        const inBottomMargin =
          e.offsetY <= h &&
          e.offsetY >= h - Math.min(60, h * 0.18) &&
          e.offsetX >= 0 &&
          e.offsetX <= w;
        // Prefer Y when both strips overlap (bottom-left corner) so
        // the existing behavior near the Y title block stays unchanged.
        if (inLeftMargin) inYAxis = true;
        else if (inBottomMargin) inXAxis = true;
      }
      // ECharts' axis hit regions can overlap inside the plot area for
      // some chart types; if both report true, prefer the X axis here
      // (the user clicked near the X tick row) only when Y wouldn't
      // open a dialog — otherwise default to Y.
      if (inYAxis && yCb) yCb();
      else if (inXAxis && xCb) xCb();
    };
    zr.on("dblclick", zrHandler);

    // ----- Point click → bridge to DataTableView -----------------------
    // ECharts dispatches `click` events with `params.componentType =
    // "series"` for every series interaction. We narrow to scatter (the
    // only series carrying source-row metadata) and read the `__pick`
    // tag that transform.ts attached to raw scatter items. Aggregated
    // summary dots / boxplot outliers / synthetic overlays emit data
    // tuples without `__pick` and are silently ignored — they don't map
    // to a single source row, so a "jump to cell" gesture would be
    // ambiguous.
    const onSeriesClick = (params: any) => {
      const cb = onPointClickRef.current;
      if (!cb) return;
      if (params?.componentType !== "series") return;
      if (params?.seriesType !== "scatter") return;
      const item = params?.data as { __pick?: ScatterPointPick } | unknown;
      if (!item || typeof item !== "object") return;
      const pick = (item as { __pick?: ScatterPointPick }).__pick;
      if (!pick || typeof pick.rowId !== "number" || pick.rowId < 0) return;
      cb(pick);
    };
    inst.on("click", onSeriesClick);

    // ----- Drag-zoom / drag-pan via native pointer events ------------
    // Mental model the user asked for: the canvas is a *viewport* onto
    // an infinite graph. Grabbing the EDGE of the canvas (the axis
    // strip) lets you stretch / shrink the visible range — the data
    // point under your cursor follows your cursor outward. Grabbing
    // the MIDDLE of the canvas (the chart body) pans both axes — the
    // data slides under your cursor in the direction you drag. Within
    // an axis strip the outer thirds are single-end zoom (one bound
    // moves, the other is anchored) and the middle third pans that
    // axis only.
    //
    // We use NATIVE PointerEvents on the container with
    // `setPointerCapture` so the gesture survives the cursor leaving
    // the chart and so `pointerup` always fires (the previous
    // implementation used ZRender mousedown + window mouseup and would
    // occasionally drop the release — "鼠标点击后无法释放"). Capture is
    // only taken AFTER a 3-pixel movement threshold, so a click that
    // doesn't move (the first half of a double-click, a series click,
    // an ECharts tooltip hover) still propagates to ZRender normally.
    //
    // Sign convention follows the cursor: dragging an axis end OUTWARD
    // (away from the chart center) is "拉大" → the visible range
    // SHRINKS so each remaining unit takes more screen space (zoom in).
    // Dragging the chart middle drags the data — the value under your
    // cursor stays approximately under your cursor throughout.
    //
    // The pixel-to-data sensitivity uses the GRID rect's width / height,
    // so a one-pixel drag changes the bound(s) by exactly one pixel's
    // worth of data — the linearization of true "cursor-follow" math
    // (which would explode near the anchored edge). Skipped on category
    // axes (numeric min/max meaningless) and on inverted axes (sign
    // flip not handled).
    type GridLike = { x: number; y: number; width: number; height: number } | undefined;
    const getGridRect = (): GridLike => {
      try {
        const m = (inst as unknown as { getModel: () => { getComponent: (type: string, idx: number) => unknown } }).getModel?.();
        const grid = m?.getComponent?.("grid", 0) as
          | { coordinateSystem?: { getRect?: () => { x: number; y: number; width: number; height: number } } }
          | undefined;
        return grid?.coordinateSystem?.getRect?.();
      } catch {
        return undefined;
      }
    };
    const getAxisType = (which: "x" | "y"): string | undefined => {
      try {
        const m = (inst as unknown as { getModel: () => { getComponent: (type: string, idx: number) => unknown } }).getModel?.();
        const ax = m?.getComponent?.(which === "y" ? "yAxis" : "xAxis", 0) as
          | { get?: (key: string) => unknown }
          | undefined;
        return ax?.get?.("type") as string | undefined;
      } catch {
        return undefined;
      }
    };
    const isAxisInverse = (which: "x" | "y"): boolean => {
      try {
        const m = (inst as unknown as { getModel: () => { getComponent: (type: string, idx: number) => unknown } }).getModel?.();
        const ax = m?.getComponent?.(which === "y" ? "yAxis" : "xAxis", 0) as
          | { get?: (key: string) => unknown }
          | undefined;
        return !!ax?.get?.("inverse");
      } catch {
        return false;
      }
    };
    // Read current visible bounds for one axis by sampling the pixel
    // positions at the two grid corners via convertFromPixel.
    //
    // Works for BOTH value-type axes (returns data units) and category
    // axes (returns float indices, e.g. -0.5 … n-0.5). ECharts honors
    // float-index min/max on category axes when set via setOption, which
    // is how smooth pan/zoom on discrete axes is achieved without
    // data-level resampling.
    //
    // Inverse axes are excluded: their coordinate system is flipped, so
    // the drag-delta sign convention would be wrong for all callers.
    const readAxisBounds = (which: "x" | "y"): { min: number; max: number } | null => {
      if (isAxisInverse(which)) return null;
      const r = getGridRect();
      if (!r) return null;
      try {
        const finder = which === "y" ? { yAxisIndex: 0 } : { xAxisIndex: 0 };
        const aPx = which === "y" ? r.y : r.x;
        const bPx = which === "y" ? r.y + r.height : r.x + r.width;
        const a = Number(inst.convertFromPixel(finder, aPx));
        const b = Number(inst.convertFromPixel(finder, bPx));
        // y: top pixel = max, bottom pixel = min. x: left = min, right = max.
        const mx = which === "y" ? a : b;
        const mn = which === "y" ? b : a;
        if (!Number.isFinite(mn) || !Number.isFinite(mx) || mx <= mn) return null;
        return { min: mn, max: mx };
      } catch {
        return null;
      }
    };

    // Inline {1, 2, 2.5, 5, 10}×10^k tick-step picker — retained for
    // potential reuse but currently unused: we let ECharts auto-tick
    // for both pinned-bound and dragged ranges so tick labels stay
    // clean (e.g. 0.1, 0.2, 0.3 …) at any min/max without us having
    // to pin an explicit step or snap bounds to a grid.
    const niceInterval = (range: number, targetTicks = 8): number => {
      if (!Number.isFinite(range) || range <= 0) return 1;
      const rough = range / targetTicks;
      const exp = Math.pow(10, Math.floor(Math.log10(rough)));
      const norm = rough / exp;
      let nice: number;
      if (norm < 1.5) nice = 1;
      else if (norm < 2.25) nice = 2;
      else if (norm < 3.5) nice = 2.5;
      else if (norm < 7.5) nice = 5;
      else nice = 10;
      return nice * exp;
    };
    void niceInterval;

    type DragMode =
      | "y-min" | "y-max" | "y-pan"
      | "x-min" | "x-max" | "x-pan"
      | "xy-pan";
    type Grip = {
      mode: DragMode;
      startXMin?: number; startXMax?: number; xPxRange?: number;
      startYMin?: number; startYMax?: number; yPxRange?: number;
    };
    /** Classify a panel-local pixel into a drag mode. */
    const getAxisGrip = (px: number, py: number): Grip | null => {
      const r = getGridRect();
      if (!r) return null;
      const panelH = el?.clientHeight ?? 0;
      const panelW = el?.clientWidth ?? 0;
      const inYStrip = px >= 0 && px < r.x && py >= r.y && py <= r.y + r.height;
      const inXStrip = py > r.y + r.height && py <= panelH && px >= r.x && px <= r.x + r.width;
      const inBody = px >= r.x && px <= r.x + r.width && py >= r.y && py <= r.y + r.height && px <= panelW;
      if (inYStrip) {
        const yb = readAxisBounds("y");
        if (!yb) return null;
        const t = (py - r.y) / r.height;
        // y screen: top (t≈0) = max end, bottom (t≈1) = min end
        const mode: DragMode = t < 0.25 ? "y-max" : t > 0.75 ? "y-min" : "y-pan";
        return { mode, startYMin: yb.min, startYMax: yb.max, yPxRange: r.height };
      }
      if (inXStrip) {
        const xb = readAxisBounds("x");
        if (!xb) return null;
        const t = (px - r.x) / r.width;
        const mode: DragMode = t < 0.25 ? "x-min" : t > 0.75 ? "x-max" : "x-pan";
        return { mode, startXMin: xb.min, startXMax: xb.max, xPxRange: r.width };
      }
      if (inBody) {
        const xb = readAxisBounds("x");
        const yb = readAxisBounds("y");
        if (!xb && !yb) return null;
        if (xb && yb) {
          return {
            mode: "xy-pan",
            startXMin: xb.min, startXMax: xb.max, xPxRange: r.width,
            startYMin: yb.min, startYMax: yb.max, yPxRange: r.height,
          };
        }
        // Only one axis has a numeric range (the other is categorical or
        // unset). Fall back to single-axis pan for the valid axis.
        if (xb) {
          return { mode: "x-pan", startXMin: xb.min, startXMax: xb.max, xPxRange: r.width };
        }
        return { mode: "y-pan", startYMin: yb!.min, startYMax: yb!.max, yPxRange: r.height };
      }
      return null;
    };

    // True when a panel-local pixel lands in either axis strip (the left
    // Y-axis margin or the bottom X-axis margin) rather than the plotting
    // body. In brush (select) mode we use this to LET axis clicks flow
    // through to ECharts' zrender dblclick handler instead of starting a
    // rubber-band selection — so double-clicking an axis opens the axis
    // settings dialog in select mode too, matching pan mode. The
    // geometric fallback mirrors the zrHandler margins (80px / 18% left,
    // 60px / 18% bottom) so both agree on what counts as "on the axis"
    // when the grid rect isn't laid out yet. Returns WHICH axis strip was
    // hit ("y" for the left margin, "x" for the bottom margin) or null —
    // the right-click context-menu handler needs the identity, and Y is
    // preferred when both margins overlap (bottom-left corner) to match
    // the dblclick zrHandler's historical default.
    const axisStripAt = (px: number, py: number): "x" | "y" | null => {
      const panelH = el?.clientHeight ?? 0;
      const panelW = el?.clientWidth ?? 0;
      const r = getGridRect();
      if (r) {
        const inYStrip = px >= 0 && px < r.x && py >= r.y && py <= r.y + r.height;
        const inXStrip = py > r.y + r.height && py <= panelH && px >= r.x && px <= r.x + r.width;
        if (inYStrip) return "y";
        if (inXStrip) return "x";
        return null;
      }
      const inLeftMargin =
        px >= 0 && px <= Math.min(80, panelW * 0.18) && py >= 0 && py <= panelH;
      const inBottomMargin =
        py <= panelH && py >= panelH - Math.min(60, panelH * 0.18) && px >= 0 && px <= panelW;
      if (inLeftMargin) return "y";
      if (inBottomMargin) return "x";
      return null;
    };
    const isInAxisStrip = (px: number, py: number): boolean =>
      axisStripAt(px, py) !== null;

    const DRAG_THRESHOLD_PX = 3;
    type DragState = Grip & {
      startPx: number; startPy: number;
      pointerId: number;
      moved: boolean;
      captured: boolean;
      lastXMin?: number; lastXMax?: number;
      lastYMin?: number; lastYMax?: number;
    };
    let dragState: DragState | null = null;

    // ----- Brush (rubber-band) state ----------------------------------
    type BrushState = { startPx: number; startPy: number; curPx: number; curPy: number; pointerId: number };
    let brushState: BrushState | null = null;

    // requestAnimationFrame-coalesced setOption pump. Pointermove on
    // a high-end mouse fires at 120-240 Hz; ECharts can't keep up if
    // we call setOption that often, which is felt as "the picture
    // pauses while the mouse moves and only catches up when I stop".
    // Instead, every pointermove just updates `pendingPatch`, and a
    // single rAF flush calls setOption once per frame with the latest
    // bounds. `lazyUpdate` + `silent` skip the dispatch/render work
    // ECharts does for tooltip events we don't care about during a
    // drag.
    let pendingPatch: { xAxis?: Record<string, unknown>; yAxis?: Record<string, unknown> } | null = null;
    let scheduledFrame = 0;
    const flushPatch = () => {
      scheduledFrame = 0;
      const p = pendingPatch;
      pendingPatch = null;
      if (!p || (!p.xAxis && !p.yAxis)) return;
      // `animation: false` kills the per-shape update tween (default
      // animationDurationUpdate is ~300 ms). Without this, every
      // setOption restarts a 300 ms transition from each scatter
      // point / boxplot rect / bar's CURRENT mid-animation position
      // toward the new target — the visible effect is that all
      // non-path shapes trail the cursor by ~half a second. The line
      // path stays in sync because ECharts redraws line `d` directly
      // from the projected points, which the user noticed as "the
      // line follows in real-time but everything else lags".
      // Settings are restored to defaults on the post-mouseup full
      // setOption(option, true) in the option-prop useEffect.
      inst.setOption(
        { ...p, animation: false } as echarts.EChartsCoreOption,
        { lazyUpdate: true, silent: true },
      );
    };
    const schedulePatch = (p: { xAxis?: Record<string, unknown>; yAxis?: Record<string, unknown> }) => {
      pendingPatch = p;
      if (!scheduledFrame) scheduledFrame = requestAnimationFrame(flushPatch);
    };

    const cursorForMode = (mode: DragMode, active: boolean): string => {
      switch (mode) {
        case "y-min":
        case "y-max":
          return "row-resize";
        case "x-min":
        case "x-max":
          return "col-resize";
        case "y-pan":
        case "x-pan":
        case "xy-pan":
          return active ? "grabbing" : "grab";
      }
    };

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const rect = el.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;

      // Brush mode: capture the start point immediately and take pointer
      // ownership so we can draw the rect even if the cursor leaves the panel.
      if (brushModeRef.current) {
        // …but NOT when the click lands on an axis strip. There we let the
        // event flow through to ECharts so a double-click opens the axis
        // settings dialog in select mode too (matching pan mode).
        if (isInAxisStrip(px, py)) return;
        brushState = { startPx: px, startPy: py, curPx: px, curPy: py, pointerId: e.pointerId };
        try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
        e.preventDefault();
        return;
      }

      // Pan / zoom mode (requires onAxisRangeChange).
      if (!onAxisRangeChangeRef.current) return;
      const grip = getAxisGrip(px, py);
      if (!grip) return;
      dragState = {
        ...grip,
        startPx: px,
        startPy: py,
        pointerId: e.pointerId,
        moved: false,
        captured: false,
        lastXMin: grip.startXMin,
        lastXMax: grip.startXMax,
        lastYMin: grip.startYMin,
        lastYMax: grip.startYMax,
      };
      // Don't preventDefault or capture yet — wait until threshold is
      // crossed so a stationary click still flows through to ECharts
      // (tooltip dwell, series click, dblclick-to-open-dialog).
    };

    const onPointerMove = (e: PointerEvent) => {
      // Brush drag in progress: update the overlay rect.
      if (brushState) {
        if (e.pointerId !== brushState.pointerId) return;
        const rect = el.getBoundingClientRect();
        brushState.curPx = e.clientX - rect.left;
        brushState.curPy = e.clientY - rect.top;
        const x1 = Math.min(brushState.startPx, brushState.curPx);
        const y1 = Math.min(brushState.startPy, brushState.curPy);
        brushOverlay.style.display = "block";
        brushOverlay.style.left = x1 + "px";
        brushOverlay.style.top = y1 + "px";
        brushOverlay.style.width = Math.abs(brushState.curPx - brushState.startPx) + "px";
        brushOverlay.style.height = Math.abs(brushState.curPy - brushState.startPy) + "px";
        return;
      }

      // Hover cursor when not dragging — gives the user a hint about
      // what mode the next mousedown will start.
      if (!dragState) {
        const rect = el.getBoundingClientRect();
        const px = e.clientX - rect.left;
        const py = e.clientY - rect.top;
        if (brushModeRef.current) {
          // Axis strips aren't part of the rubber-band area — show the
          // default arrow there so the double-click-to-open-settings
          // affordance reads correctly; crosshair over the plot body.
          el.style.cursor = isInAxisStrip(px, py) ? "" : "crosshair";
          return;
        }
        const g = getAxisGrip(px, py);
        el.style.cursor = g ? cursorForMode(g.mode, false) : "";
        return;
      }
      const st = dragState;
      if (e.pointerId !== st.pointerId) return;
      const rect = el.getBoundingClientRect();
      const curPx = e.clientX - rect.left;
      const curPy = e.clientY - rect.top;
      const dx = curPx - st.startPx;
      const dy = curPy - st.startPy;
      if (!st.moved && Math.hypot(dx, dy) >= DRAG_THRESHOLD_PX) {
        st.moved = true;
        el.style.cursor = cursorForMode(st.mode, true);
        // Once we know it's a drag (not a click), claim the pointer so
        // pointerup fires on us even if the cursor leaves the panel.
        try { el.setPointerCapture(st.pointerId); st.captured = true; } catch { /* ignore */ }
        e.preventDefault();
      }
      if (!st.moved) return;
      // Sign convention: cursor-follow. Dragging right pulls the X
      // values left under the cursor (so xmin/xmax DECREASE on right
      // drag). Dragging down pulls the Y values up (so ymin/ymax
      // INCREASE on down drag because data-y increases upward).
      // For single-end handles, only the named bound moves; the
      // OPPOSITE end stays anchored. This is what makes outward drag
      // feel like "拉大 / stretch the graph outward" → fewer units
      // visible → zoom in.
      const patch: { xAxis?: Record<string, unknown>; yAxis?: Record<string, unknown> } = {};
      const isYMode = st.mode === "y-min" || st.mode === "y-max" || st.mode === "y-pan" || st.mode === "xy-pan";
      const isXMode = st.mode === "x-min" || st.mode === "x-max" || st.mode === "x-pan" || st.mode === "xy-pan";
      if (isYMode && st.startYMin !== undefined && st.startYMax !== undefined && st.yPxRange) {
        const ySpan = st.startYMax - st.startYMin;
        const ySf = ySpan / st.yPxRange;
        const yDelta = dy * ySf; // drag DOWN → both bounds increase
        let newYMin = st.startYMin;
        let newYMax = st.startYMax;
        if (st.mode === "y-min") newYMin = st.startYMin + yDelta;
        else if (st.mode === "y-max") newYMax = st.startYMax + yDelta;
        else { newYMin = st.startYMin + yDelta; newYMax = st.startYMax + yDelta; }
        // For category axes (index-space), ensure at least 1 category is visible;
        // for numeric axes keep the 0.1%-of-span precision floor.
        const yFloor = getAxisType("y") === "category" ? 1.0 : Math.abs(ySpan) * 0.001;
        if (newYMax - newYMin < yFloor) {
          if (st.mode === "y-min") newYMin = newYMax - yFloor;
          else if (st.mode === "y-max") newYMax = newYMin + yFloor;
        }
        st.lastYMin = newYMin;
        st.lastYMax = newYMax;
        // No explicit `interval` in the patch — ECharts auto-ticks for
        // the new range and picks clean positions (0.1, 0.2, 0.3 …)
        // within [min, max] regardless of whether min lands on a
        // round grid line. This removes the snap-to-grid stepped feel
        // and gives smooth cursor-following motion.
        patch.yAxis = {
          min: newYMin,
          max: newYMax,
          scale: false,
        };
      }
      if (isXMode && st.startXMin !== undefined && st.startXMax !== undefined && st.xPxRange) {
        const xSpan = st.startXMax - st.startXMin;
        const xSf = xSpan / st.xPxRange;
        const xDelta = -dx * xSf; // drag RIGHT → both bounds decrease
        let newXMin = st.startXMin;
        let newXMax = st.startXMax;
        if (st.mode === "x-min") newXMin = st.startXMin + xDelta;
        else if (st.mode === "x-max") newXMax = st.startXMax + xDelta;
        else { newXMin = st.startXMin + xDelta; newXMax = st.startXMax + xDelta; }
        const xFloor = getAxisType("x") === "category" ? 1.0 : Math.abs(xSpan) * 0.001;
        if (newXMax - newXMin < xFloor) {
          if (st.mode === "x-min") newXMin = newXMax - xFloor;
          else if (st.mode === "x-max") newXMax = newXMin + xFloor;
        }
        st.lastXMin = newXMin;
        st.lastXMax = newXMax;
        patch.xAxis = {
          min: newXMin,
          max: newXMax,
          scale: false,
        };
      }
      if (patch.xAxis || patch.yAxis) schedulePatch(patch);
    };

    const finishDrag = (commit: boolean) => {
      const st = dragState;
      if (!st) return;
      dragState = null;
      // Flush any pending rAF patch so the final position is rendered
      // before we hand the bounds off to the parent for persistence —
      // otherwise a fast release could leave the canvas one frame
      // behind the committed state.
      if (scheduledFrame) {
        cancelAnimationFrame(scheduledFrame);
        scheduledFrame = 0;
        flushPatch();
      }
      if (st.captured) {
        try { el.releasePointerCapture(st.pointerId); } catch { /* ignore */ }
      }
      el.style.cursor = "";
      if (!commit || !st.moved) return;
      const cb = onAxisRangeChangeRef.current;
      if (!cb) return;
      const emitsY = st.mode === "y-min" || st.mode === "y-max" || st.mode === "y-pan" || st.mode === "xy-pan";
      const emitsX = st.mode === "x-min" || st.mode === "x-max" || st.mode === "x-pan" || st.mode === "xy-pan";
      if (emitsX && st.lastXMin !== undefined && st.lastXMax !== undefined) {
        cb("x", st.lastXMin, st.lastXMax);
      }
      if (emitsY && st.lastYMin !== undefined && st.lastYMax !== undefined) {
        cb("y", st.lastYMin, st.lastYMax);
      }
    };

    const onPointerUp = (e: PointerEvent) => {
      // Brush: hide overlay, run hit-test, fire callback.
      if (brushState && e.pointerId === brushState.pointerId) {
        brushOverlay.style.display = "none";
        try { el.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
        const st = brushState;
        brushState = null;
        const minX = Math.min(st.startPx, st.curPx);
        const maxX = Math.max(st.startPx, st.curPx);
        const minY = Math.min(st.startPy, st.curPy);
        const maxY = Math.max(st.startPy, st.curPy);
        const picks = maxX - minX < 2 && maxY - minY < 2
          ? []
          : legacyHitTestBrush(st.startPx, st.startPy, st.curPx, st.curPy);
        onBrushSelectRef.current?.(picks);
        return;
      }
      if (!dragState || e.pointerId !== dragState.pointerId) return;
      finishDrag(true);
    };
    const onPointerCancel = (e: PointerEvent) => {
      if (brushState && e.pointerId === brushState.pointerId) {
        brushOverlay.style.display = "none";
        brushState = null;
        return;
      }
      if (!dragState || e.pointerId !== dragState.pointerId) return;
      finishDrag(false);
    };
    const onPointerLeave = () => {
      if (!dragState && !brushState) el.style.cursor = "";
    };
    // Global safety net: if for any reason we miss the pointerup
    // (window blur, devtools steal, etc.), end the drag on the next
    // global mouseup so the cursor never gets "stuck".
    const onWindowMouseUpSafety = () => {
      if (brushState) { brushOverlay.style.display = "none"; brushState = null; return; }
      if (dragState && !dragState.captured) finishDrag(true);
    };

    // ----- Wheel-zoom shortcuts (both modes) -------------------------
    //   Ctrl + wheel         → zoom Y axis around cursor
    //   Ctrl + Shift + wheel → zoom X axis around cursor
    // The Ctrl-modifier shortcut works in BOTH pan and select (brush)
    // modes — it's an explicit zoom gesture that never conflicts with a
    // rubber-band drag (which uses the plain left-button). Bare wheel is
    // always a pass-through so the outer page can still scroll.
    //
    // Zoom is multiplicative around the value under the cursor so the
    // point under the pointer stays fixed in screen space. The new
    // bounds are pushed live via `schedulePatch` (rAF-coalesced) for
    // smoothness, and a debounced `commit` fires `onAxisRangeChange`
    // once the wheel goes idle so the parent state finally syncs.
    let wheelCommitTimer: number | null = null;
    let wheelLastBounds: { x?: { min: number; max: number }; y?: { min: number; max: number } } = {};
    const flushWheelCommit = () => {
      wheelCommitTimer = null;
      const cb = onAxisRangeChangeRef.current;
      if (!cb) { wheelLastBounds = {}; return; }
      if (wheelLastBounds.x) cb("x", wheelLastBounds.x.min, wheelLastBounds.x.max);
      if (wheelLastBounds.y) cb("y", wheelLastBounds.y.min, wheelLastBounds.y.max);
      wheelLastBounds = {};
    };
    const onWheel = (e: WheelEvent) => {
      // Only the Ctrl-modifier shortcut applies; bare wheel is a
      // pass-through so the outer page can still scroll. Works in both
      // pan and select modes.
      if (!e.ctrlKey) return;
      if (!onAxisRangeChangeRef.current) return;
      const rect = el.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const r = getGridRect();
      if (!r) return;
      // Cursor must be inside the plotting area for the zoom to make
      // sense (zooming around a pixel that maps to nothing produces
      // weird ranges).
      if (px < r.x || px > r.x + r.width || py < r.y || py > r.y + r.height) return;
      const which: "x" | "y" = e.shiftKey ? "x" : "y";
      const bounds = readAxisBounds(which);
      if (!bounds) return;
      e.preventDefault();
      // Scroll up (deltaY < 0) zooms IN (range shrinks); scroll down
      // zooms OUT. Use an exponential factor so trackpads (small deltas)
      // and mouse wheels (large deltas) both feel proportional. 0.001
      // gives a comfortable ~10% per standard mouse notch (deltaY≈100).
      const factor = Math.exp(e.deltaY * 0.0015);
      // Pivot: the data value currently under the cursor pixel.
      const finder = which === "y" ? { yAxisIndex: 0 } : { xAxisIndex: 0 };
      let pivot: number;
      try {
        pivot = Number(inst.convertFromPixel(finder, which === "y" ? py : px));
      } catch { return; }
      if (!Number.isFinite(pivot)) return;
      let newMin = pivot - (pivot - bounds.min) * factor;
      let newMax = pivot + (bounds.max - pivot) * factor;
      // Guard against degenerate or inverted ranges.
      if (!Number.isFinite(newMin) || !Number.isFinite(newMax) || newMax <= newMin) return;
      // Sanity floor: for category axes keep at least 1 category visible;
      // for numeric axes guard against floating-point precision loss.
      const span = newMax - newMin;
      const minSpan = getAxisType(which) === "category" ? 1.0 : (bounds.max - bounds.min) * 1e-6;
      if (span < minSpan) return;
      // Apply live (rAF-coalesced), and remember the latest bounds so
      // the debounced commit can fire onAxisRangeChange once idle.
      if (which === "y") {
        schedulePatch({ yAxis: { min: newMin, max: newMax } });
        wheelLastBounds.y = { min: newMin, max: newMax };
      } else {
        schedulePatch({ xAxis: { min: newMin, max: newMax } });
        wheelLastBounds.x = { min: newMin, max: newMax };
      }
      if (wheelCommitTimer) window.clearTimeout(wheelCommitTimer);
      wheelCommitTimer = window.setTimeout(flushWheelCommit, 220);
    };

    // ----- Right-click on an axis strip → context menu ---------------
    // Handled in the React layer via `onContextMenu` on the chart div
    // (see the JSX below) — React's root-level event delegation is the
    // one contextmenu path that works reliably in the Tauri WebView
    // (both a native listener on `el` and zrender's own event bus proved
    // unreliable here, while the app's other right-click menus all use
    // React `onContextMenu`). The handler lives at component scope so it
    // can read the freshest `onAxisContextMenu` prop directly.

    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("pointermove", onPointerMove);
    el.addEventListener("pointerup", onPointerUp);
    el.addEventListener("pointercancel", onPointerCancel);
    el.addEventListener("pointerleave", onPointerLeave);
    // `passive: false` so the Ctrl/Ctrl+Shift+wheel handler can call
    // preventDefault() and stop the browser's page scroll / pinch-zoom.
    el.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("mouseup", onWindowMouseUpSafety);

    return () => {
      zr.off("dblclick", zrHandler);
      inst.off("click", onSeriesClick);
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("pointermove", onPointerMove);
      el.removeEventListener("pointerup", onPointerUp);
      el.removeEventListener("pointercancel", onPointerCancel);
      el.removeEventListener("pointerleave", onPointerLeave);
      el.removeEventListener("wheel", onWheel);
      window.removeEventListener("mouseup", onWindowMouseUpSafety);
      if (wheelCommitTimer) { window.clearTimeout(wheelCommitTimer); wheelCommitTimer = null; }
      if (scheduledFrame) {
        cancelAnimationFrame(scheduledFrame);
        scheduledFrame = 0;
      }
      brushOverlay.remove();
      ro.disconnect();
      inst.dispose();
      chartRef.current = null;
    };
  }, []);

  // 更新选项
  useEffect(() => {
    const inst = chartRef.current;
    if (!inst) return;
    inst.setOption(
      withoutGraphAnimation(
        withInterleavedGraphLayers(option) as echarts.EChartsCoreOption,
      ),
      true,
    );
  }, [option]);

  // Right-click on an axis strip → open the axis context menu. Handled
  // here in the React layer (root-level event delegation) because that
  // is the contextmenu path that fires reliably in the Tauri WebView —
  // the same mechanism every other right-click menu in the app uses.
  // Coordinates are resolved against the chart div and classified into
  // the left (Y) / bottom (X) axis strips using the live grid rect.
  const handleAxisContextMenu = (e: React.MouseEvent) => {
    const cb = onAxisContextMenu;
    const inst = chartRef.current;
    const el = panelRef.current;
    if (!cb || !inst || !el) return;
    const rect = el.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    // Grid rect (chart-relative CSS pixels); undefined before first layout.
    let r: { x: number; y: number; width: number; height: number } | undefined;
    try {
      const grid = (inst as unknown as { getModel?: () => { getComponent?: (t: string, i: number) => unknown } })
        .getModel?.()
        ?.getComponent?.("grid", 0) as
        | { coordinateSystem?: { getRect?: () => { x: number; y: number; width: number; height: number } } }
        | undefined;
      r = grid?.coordinateSystem?.getRect?.();
    } catch {
      /* fall through to the geometric fallback */
    }
    const panelW = el.clientWidth;
    const panelH = el.clientHeight;
    let axis: "x" | "y" | null = null;
    if (r) {
      if (px >= 0 && px < r.x && py >= r.y && py <= r.y + r.height) axis = "y";
      else if (py > r.y + r.height && py <= panelH && px >= r.x && px <= r.x + r.width) axis = "x";
    } else {
      if (px >= 0 && px <= Math.min(80, panelW * 0.18) && py >= 0 && py <= panelH) axis = "y";
      else if (py <= panelH && py >= panelH - Math.min(60, panelH * 0.18) && px >= 0 && px <= panelW) axis = "x";
    }
    if (!axis) return;
    // stopPropagation is essential: without it this same contextmenu
    // event keeps bubbling to the document-level close listener the
    // consumer registers while the menu is open, which would close the
    // menu on the very click that opened it (matches the slot menu).
    e.preventDefault();
    e.stopPropagation();
    cb(axis, e.clientX, e.clientY);
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        background: "var(--bg-card)",
        minHeight,
      }}
    >
      {title && (
        <div
          style={{
            padding: "4px 10px",
            fontSize: 12,
            color: "var(--fg-secondary)",
            background: "var(--bg-header)",
          }}
        >
          {title}
        </div>
      )}
      <div ref={panelRef} style={{ flex: 1, minHeight: 0, position: "relative" }} onContextMenu={handleAxisContextMenu}>
        <div ref={chartHostRef} style={{ position: "absolute", inset: 0 }} />
      </div>
    </div>
  );
}
