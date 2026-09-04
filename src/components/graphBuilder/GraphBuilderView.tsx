/**
 * Graph Builder — 交互式图形构建器
 *
 * 布局：
 *   ┌──────────────────────────────────────────────────────────────────┐
 *   │ ChartTypeBar （顶部图形类型切换）                                  │
 *   ├──────────┬──────────────────────────────────────┬───────────────┤
 *   │ 列调色板  │ ┌──── 顶部分组 (Group X) ────────┐  │ 编码槽         │
 *   │ + 元素   │ │                                │  │ Overlay       │
 *   │   设置面板│ │      绘图画布 (Graph Core)      │  │ Color         │
 *   │          │ │                                │  │ Size          │
 *   │          │ └────────────────────────────────┘  │ Group X       │
 *   │          │ X 轴槽                              │ Group Y       │
 *   ├──────────┴──────────────────────────────────────┴───────────────┤
 *   │ 工具栏 (Undo / Start Over / Done) — 当前作占位                    │
 *   └──────────────────────────────────────────────────────────────────┘
 */

import { useEffect, useMemo, useState, useCallback, useRef, useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { dataService } from "@/services/dataService";
import { isMissing, DEFAULT_GROUP_KEY, type FieldRef, type ChartElement, type ElementKind, type MarkStyle, type GroupStyle, type GroupStyleMap, type MarkerShape, type RefLineY, type RefLineX, type YAxisConfig } from "@/graphCore";
import { SCATTER_RENDER_BUDGET } from "@/graphCore/scatterBudget";
import type { DatasetMeta } from "@/types/data";
import type { GraphBuilderItem, GraphBuilderMode, GraphSlotKey } from "@/types/graphBuilder";
import type { FilterRuleItem } from "@/types/filter";
import { useGraphBuilderStore } from "@/stores/useGraphBuilderStore";
import { useProjectStore } from "@/stores/useProjectStore";
import { useGraphPaletteStore, type CustomPalette } from "@/stores/useGraphPaletteStore";
import { useTableSelectionStore } from "@/stores/useTableSelectionStore";
import { ctxMenuRef } from "@/utils/ctxMenu";
import { AddPaletteDialog } from "./AddPaletteDialog";
import { AxisSettingsDialog, isAxisConfigEmpty } from "./AxisSettingsDialog";
import { prepareAxisBinding } from "./axisBinding";
import { updateGraphBuilder2D } from "./graphBuilderAxisInteractions";
import { resolveVisualGraphSlots } from "./graphBuilderSlotLayout";
import {
  clampSampleSize,
  DEFAULT_GRAPH_SAMPLE_SIZE,
} from "./graphSamplingPolicy";
import { FilterPanel } from "@/components/filter";
import { defaultLayerOptions, GRAPH_LAYER_DEFS, getLayerMode, type GraphLayerDef } from "./graphLayerConfig";
import {
  createDefaultGraph2DState,
  createDefaultGraph3DState,
  createDefaultMultivariateGraphState,
} from "./graphBuilderMode";
import {
  MAX_MULTIVARIATE_COLUMNS,
  updateMultivariateColumns,
} from "./updateMultivariateColumns";
import {
  deriveMultivariateSlotBinding,
  resolveCanvasDropSlot,
} from "./multivariateInteractions";
import { GraphRuntime, type GraphRuntimeState } from "./GraphRuntime";
import { buildGraphRuntimeModel, FILL_PALETTE, LINE_PALETTE, POINT_PALETTE, STYLE_COLORS } from "./graphRuntimeModel";
import { resolveThemeGroupKeySets } from "./graphGroupOrder";
import {
  buildEffectiveGroupStyles,
  reconcileGroupThemeSlots,
  resolveGroupThemeFieldName,
} from "./graphThemeIdentity";

interface GraphBuilderViewProps {
  item: GraphBuilderItem;
  dataset: DatasetMeta;
}

/** 所有可用的编码槽位 */
type SlotKey = GraphSlotKey;

// Color / Size / Wrap encoding channels were intentionally removed —
// the per-group Style editor (Line / Fill / Point) supersedes them.
// Overlay drives legend grouping and now lives inside the LegendStylePanel.
// Group X / Group Y are still exposed via the dedicated facet drop slots
// surrounding the canvas, not via a side shelf.

const GRAPH_LAYER_DEFS_WITH_CORRELATION: readonly GraphLayerDef[] = GRAPH_LAYER_DEFS.some((def) => def.kind === "correlationMatrix")
  ? GRAPH_LAYER_DEFS
  : [...GRAPH_LAYER_DEFS, { kind: "correlationMatrix" as ElementKind, icon: "▦" }];
const DRAG_MIME = "text/plain";
const CORRELATION_MAX_COLUMNS = MAX_MULTIVARIATE_COLUMNS;
type MultivariateDropNotice = "invalidFieldType" | "duplicateField" | "maxColumns";

export function GraphBuilderView({ item, dataset }: GraphBuilderViewProps) {
  const { t } = useTranslation();
  const isMultivariateMode = item.mode === "multivariate";
  const isThreeDMode = item.mode === "3d";
  const twoD = item.modeStates.twoD;
  const threeD = item.modeStates.threeD;
  const multivariate = item.modeStates.multivariate;
  const cartesianState = isThreeDMode ? threeD : twoD;
  const visualSlots = resolveVisualGraphSlots(item.mode === "2d" && twoD.transposed === true);
  const modeStates = item.modeStates;
  const updateItemRaw = useGraphBuilderStore((s) => s.updateItem);
  const markDirtyRaw = useProjectStore((s) => s.markDirty);
  const readOnly = useProjectStore((s) => s.readOnly);
  const markDirty = useCallback(() => {
    if (readOnly) return;
    markDirtyRaw();
  }, [readOnly, markDirtyRaw]);
  const updateItem = useCallback((id: string, patch: Partial<GraphBuilderItem>) => {
    if (readOnly) return;
    updateItemRaw(id, patch);
  }, [readOnly, updateItemRaw]);
  const setMode = useCallback((mode: GraphBuilderMode) => {
    if (item.mode === mode) return;
    updateItem(item.id, { mode });
    markDirty();
  }, [item.id, item.mode, updateItem, markDirty]);
  const setTwoDState = useCallback(
    (updater: typeof twoD | ((prev: typeof twoD) => typeof twoD)) => {
      const currentItem = useGraphBuilderStore.getState().items.find((candidate) => candidate.id === item.id) ?? item;
      const nextItem = updateGraphBuilder2D(currentItem, updater);
      updateItem(item.id, {
        modeStates: nextItem.modeStates,
      });
      markDirty();
    },
    [item, twoD, updateItem, markDirty],
  );
  const setThreeDState = useCallback(
    (updater: typeof threeD | ((prev: typeof threeD) => typeof threeD)) => {
      const next = typeof updater === "function" ? updater(threeD) : updater;
      updateItem(item.id, {
        modeStates: {
          ...modeStates,
          threeD: next,
        },
      });
      markDirty();
    },
    [item.id, threeD, modeStates, updateItem, markDirty],
  );
  const setMultivariateState = useCallback(
    (
      updater:
        | typeof multivariate
        | ((prev: typeof multivariate) => typeof multivariate),
    ) => {
      const next = typeof updater === "function" ? updater(multivariate) : updater;
      updateItem(item.id, {
        modeStates: {
          ...modeStates,
          multivariate: next,
        },
      });
      markDirty();
    },
    [item.id, multivariate, modeStates, updateItem, markDirty],
  );
  // Cross-view bridge: click a scatter point → highlight the matching
  // cell in the DataTableView for `dataset.id` next time it mounts.
  const pickCell = useTableSelectionStore((s) => s.pick);
  // Cross-view bridge: rubber-band brush → highlight the matching cells
  // (one cell per scatter point, identified by rowId + colName).
  const pickCells = useTableSelectionStore((s) => s.pickCells);

  // "pan" = default axis drag/zoom, "select" = rubber-band multi-row brush.
  // Default is "select" — most common gesture is inspecting points; pan is
  // a less-frequent mode used for navigating an already-zoomed view.
  const [cursorMode, setCursorMode] = useState<"pan" | "select">("select");

  const runtimeModel = useMemo(
    () => buildGraphRuntimeModel(item, { columns: [], displayProps: [] }),
    [item],
  );

  const [runtimeState, setRuntimeState] = useState<GraphRuntimeState | null>(null);
  const columns = runtimeState?.columns ?? [];
  const colSqlTypes = runtimeState?.colSqlTypes ?? [];
  const graphData = runtimeState?.graphData ?? { columns: [], rows: [] };
  const runtimeSpec = runtimeState?.spec ?? runtimeModel.spec;
  const metaLoading = runtimeState?.metaLoading ?? true;
  const metaError = runtimeState?.metaError ?? null;
  // Y-axis settings dialog open state. Opened by double-clicking the Y
  // axis (or its label/title area) in <Graph>; closed via the dialog's
  // Done button or overlay click.
  const [yAxisDialogOpen, setYAxisDialogOpen] = useState(false);
  // X-axis settings dialog open state. Mirrors `yAxisDialogOpen` —
  // opened by double-clicking the X axis (or its label / title strip).
  const [xAxisDialogOpen, setXAxisDialogOpen] = useState(false);

  // Multi-select state for the column list (left rail). Plain click =
  // single select; Ctrl/Cmd+click = toggle one; Shift+click = range
  // select between the click anchor and the current item. When the
  // user starts a drag on a selected item, the drag payload becomes
  // ALL selected fields (multi-drag). Drag on an unselected item
  // clears selection and drags only that one (single-drag, identical
  // to pre-multi-select behavior). The selection is purely transient
  // UI state — not persisted with the project. */
  const [selectedColNames, setSelectedColNames] = useState<Set<string>>(() => new Set());
  // Anchor for Shift+click range selection — last column the user
  // clicked WITHOUT shift. Reset to the clicked item on every plain /
  // ctrl click. Shift+click preserves the anchor.
  const colAnchorRef = useRef<string | null>(null);
  // Visual reject-flash state per slot. Set briefly to flash the slot
  // red when a multi-drop is rejected (mixed numeric / non-numeric,
  // or non-numeric appended in multi-mode). The Slot component reads
  // this and adds a CSS class for ~400 ms.
  const [rejectFlashSlot, setRejectFlashSlot] = useState<SlotKey | null>(null);
  const [correlationNotice, setCorrelationNotice] = useState<MultivariateDropNotice | null>(null);
  const rejectFlashTimerRef = useRef<number | null>(null);
  const flashRejectOnSlot = useCallback((slot: SlotKey) => {
    setRejectFlashSlot(slot);
    if (rejectFlashTimerRef.current !== null) {
      window.clearTimeout(rejectFlashTimerRef.current);
    }
    rejectFlashTimerRef.current = window.setTimeout(() => {
      setRejectFlashSlot(null);
      rejectFlashTimerRef.current = null;
    }, 400);
  }, []);
  useEffect(() => {
    return () => {
      if (rejectFlashTimerRef.current !== null) {
        window.clearTimeout(rejectFlashTimerRef.current);
      }
    };
  }, []);
  useEffect(() => {
    if (!isMultivariateMode && correlationNotice) {
      setCorrelationNotice(null);
    }
  }, [isMultivariateMode, correlationNotice]);
  // Which slot's multi-mode manager popover is currently open. null
  // means no manager is open. Only one manager can be open at a time
  // (they're mutually exclusive — opening one closes the other).
  const [managerOpenSlot, setManagerOpenSlot] = useState<SlotKey | null>(null);
  // Right-click context menu on a slot (X / Y / Group X / Group Y /
  // Overlay). Lifted up here (rather than per-Slot state) so opening
  // a menu on one slot implicitly closes any other slot's menu — a
  // single source of truth keeps the close-on-outside-click handler
  // simple. Position is in viewport coordinates (clientX / clientY).
  const [slotCtxMenu, setSlotCtxMenu] = useState<{ slot: SlotKey; x: number; y: number } | null>(null);
  // Close the slot context menu on any left click outside the menu
  // itself, and also on any other contextmenu (so right-clicking a
  // different slot replaces the menu cleanly). Mirrors the pattern in
  // DataTableView's column / cell context menus. Items inside the menu
  // call `stopPropagation` so the close handler doesn't fire before
  // their own onClick.
  useEffect(() => {
    if (!slotCtxMenu) return;
    const close = () => setSlotCtxMenu(null);
    document.addEventListener("click", close);
    document.addEventListener("contextmenu", close);
    return () => {
      document.removeEventListener("click", close);
      document.removeEventListener("contextmenu", close);
    };
  }, [slotCtxMenu]);
  // Right-click context menu on an axis strip (fired from <Graph>).
  // Offers "Axis settings" (opens the same dialog as the double-click
  // gesture) and "Reset zoom" (clears the pinned min/max on that axis).
  // Closed on any outside click / other contextmenu, mirroring the slot
  // menu above.
  const [axisCtxMenu, setAxisCtxMenu] = useState<{ axis: "x" | "y"; x: number; y: number } | null>(null);
  useEffect(() => {
    if (!axisCtxMenu) return;
    const close = () => setAxisCtxMenu(null);
    document.addEventListener("click", close);
    document.addEventListener("contextmenu", close);
    return () => {
      document.removeEventListener("click", close);
      document.removeEventListener("contextmenu", close);
    };
  }, [axisCtxMenu]);
  // Resizable side-rail widths. Mirror the Excel-grid splitter pattern
  // (DataTableView): clamp on drag and double-click to reset.
  const [leftWidth, setLeftWidth] = useState(220);
  const [rightWidth, setRightWidth] = useState(220);
  // Local Data Filter panel (toggled by the toolbar Filter button).
  const [showFilters, setShowFilters] = useState(false);
  const [filterWidth, setFilterWidth] = useState(240);
  // Vertical split inside the left rail: percentage of the rail's height
  // that goes to the column list, the rest to LAYERS. Mirrors the
  // history-divider pattern in HistoryPanel.
  const [leftTopPct, setLeftTopPct] = useState(50);
  const leftRailRef = useRef<HTMLDivElement>(null);
  const startSideResize = useCallback(
    (side: "left" | "right" | "filter") => (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW =
        side === "left" ? leftWidth : side === "right" ? rightWidth : filterWidth;
      // Splitter on the right edge of a panel grows when dragged right (+1).
      // The right rail splitter is to the LEFT of the right panel, so dragging
      // right shrinks it (-1).
      const dir = side === "right" ? -1 : 1;
      const onMove = (ev: MouseEvent) => {
        const next = Math.max(160, Math.min(500, startW + dir * (ev.clientX - startX)));
        if (side === "left") setLeftWidth(next);
        else if (side === "right") setRightWidth(next);
        else setFilterWidth(next);
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
    },
    [leftWidth, rightWidth, filterWidth],
  );

  // Vertical drag inside the left rail (between TABLE columns and LAYERS).
  const startLeftRowResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const rail = leftRailRef.current;
      if (!rail) return;
      const railH = rail.clientHeight;
      if (railH <= 0) return;
      const startY = e.clientY;
      const startPct = leftTopPct;
      const onMove = (ev: MouseEvent) => {
        const deltaPct = ((ev.clientY - startY) / railH) * 100;
        setLeftTopPct(Math.max(15, Math.min(85, startPct + deltaPct)));
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
      document.body.style.cursor = "row-resize";
      document.body.style.userSelect = "none";
    },
    [leftTopPct],
  );

  // 编码状态从 store 派生
  const encoding = cartesianState.encoding as Partial<Record<SlotKey, FieldRef>>;
  const elements = isMultivariateMode
    ? [{ kind: "correlationMatrix", enabled: true, options: { correlationMethod: multivariate.correlationMethod } } as ChartElement]
    : cartesianState.elements;
  const multiX = twoD.multiX ?? [];
  const multiY = isMultivariateMode ? multivariate.columns : (twoD.multiY ?? []);
  const multivariateSlotBinding = deriveMultivariateSlotBinding(multivariate.columns);
  const groupStyles = cartesianState.groupStyles ?? {};
  const hiddenGroups = cartesianState.hiddenGroups ?? [];
  const yAxisConfig = twoD.yAxis;
  const xAxisConfig = twoD.xAxis;
  const refLinesY = twoD.refLinesY ?? [];
  const refLinesX = twoD.refLinesX ?? [];
  // Filter rules (JMP-style Local Data Filter). Persist on the item so
  // they survive project save/load.
  const filters = useMemo(() => item.filters ?? [], [item.filters]);
  const getGraphCategoricalValues = useCallback(async (field: string, search: string) => {
    const generation = await dataService.getDatasetGeneration(dataset.id);
    return dataService.queryTableFilterValues(dataset.id, field, search, 500, generation);
  }, [dataset.id]);
  const meltInfo = runtimeModel.meltInfo;
  const frame = runtimeState?.frame ?? null;
  const valueOrders = runtimeState?.valueOrders;
  const pipelineStatus = runtimeState?.status ?? "idle";
  const progress = runtimeState?.progress ?? null;
  const rawPointNotice = runtimeState?.rawPointNotice ?? null;

  // Auto-close the manager when its slot is no longer manageable.
  // In 2D, management is meaningful only for 2+ columns (multi mode).
  // In multivariate Y, 0/1/2+ are valid editable states, so keep the
  // manager open for a single remaining variable and close only at 0.
  useEffect(() => {
    if (!managerOpenSlot) return;
    const cols = managerOpenSlot === "x"
      ? multiX
      : managerOpenSlot === "y"
        ? multiY
        : undefined;
    const minColumns = item.mode === "multivariate" && managerOpenSlot === "y"
      ? 1
      : 2;
    if ((cols?.length ?? 0) < minColumns) {
      setManagerOpenSlot(null);
    }
  }, [item.mode, managerOpenSlot, multiX, multiY]);

  // User-saved CustomPalettes feed into legend default-color assignment:
  // when a group doesn't have an explicit style override yet, the renderer
  // walks these palettes first before falling back to STYLE_COLORS.
  const customPalettes = useGraphPaletteStore((s) => s.palettes);

  const groupingFieldName = resolveGroupThemeFieldName(encoding);

  const { slotCandidateKeys, legendGroupKeys } = useMemo(() => {
    if (!groupingFieldName || !frame) {
      return { slotCandidateKeys: [], legendGroupKeys: [] };
    }

    const seen = new Set<string>();
    const out: string[] = [];
    const push = (value: unknown) => {
      if (isMissing(value)) return;
      const key = String(value);
      if (seen.has(key)) return;
      seen.add(key);
      out.push(key);
    };

    for (const chunk of frame.rawChunks) {
      if (!chunk.groupCodes) continue;
      const dict = frame.dictionaries.group;
      if (!dict || dict.length === 0) continue;
      for (let i = 0; i < chunk.groupCodes.length; i += 1) {
        const code = Number(chunk.groupCodes[i]);
        if (!Number.isInteger(code) || code < 0 || code >= dict.length) continue;
        push(dict[code]);
      }
    }

    for (const packet of frame.aggregates) {
      switch (packet.kind) {
        case "histogram":
          for (const bin of packet.bins) push(bin.group);
          break;
        case "heatmap":
          for (const cell of packet.cells) push(cell.group);
          break;
        case "boxPlot":
          for (const entry of packet.entries) push(entry.group);
          break;
        case "summary":
          for (const summary of packet.summaries) push(summary.group);
          break;
      }
    }

    return resolveThemeGroupKeySets(
      out,
      frame.dictionaries.group ?? [],
      valueOrders?.[groupingFieldName],
    );
  }, [groupingFieldName, frame, valueOrders]);

  const groupKeys = useMemo(
    () => (legendGroupKeys.length > 0 ? legendGroupKeys : [DEFAULT_GROUP_KEY]),
    [legendGroupKeys],
  );

  const resolvedThemeSlots = useMemo(
    () => reconcileGroupThemeSlots(item.groupThemeSlots, groupingFieldName, slotCandidateKeys),
    [item.groupThemeSlots, groupingFieldName, slotCandidateKeys],
  );

  const effectiveStyles = useMemo<GroupStyleMap>(
    () =>
      buildEffectiveGroupStyles(
        groupKeys,
        resolvedThemeSlots,
        groupingFieldName,
        groupStyles,
        customPalettes,
        elements.some((e) => e.kind === "boxplot" && e.enabled !== false),
      ),
    [groupKeys, resolvedThemeSlots, groupingFieldName, groupStyles, customPalettes, elements],
  );

  useEffect(() => {
    if (!groupingFieldName || !frame || slotCandidateKeys.length === 0 || readOnly || resolvedThemeSlots === item.groupThemeSlots) {
      return;
    }
    updateItem(item.id, { groupThemeSlots: resolvedThemeSlots });
    markDirty();
  }, [groupingFieldName, frame, slotCandidateKeys, item.id, item.groupThemeSlots, resolvedThemeSlots, readOnly, updateItem, markDirty]);

  const setEncoding = useCallback(
    (
      updater:
        | typeof encoding
        | ((prev: typeof encoding) => typeof encoding),
    ) => {
      if (isMultivariateMode) return;
      const next =
        typeof updater === "function"
          ? (updater as (p: typeof encoding) => typeof encoding)(encoding)
          : updater;
      if (isThreeDMode) {
        setThreeDState((prev) => ({ ...prev, encoding: next }));
      } else {
        setTwoDState((prev) => ({ ...prev, encoding: next }));
      }
    },
    [encoding, isMultivariateMode, isThreeDMode, setThreeDState, setTwoDState],
  );
  const setElements = useCallback(
    (
      updater: ChartElement[] | ((prev: ChartElement[]) => ChartElement[]),
    ) => {
      if (isMultivariateMode) return;
      const next =
        typeof updater === "function"
          ? (updater as (p: ChartElement[]) => ChartElement[])(elements)
          : updater;
      if (isThreeDMode) {
        setThreeDState((prev) => ({ ...prev, elements: next }));
      } else {
        setTwoDState((prev) => ({ ...prev, elements: next }));
      }
    },
    [elements, isMultivariateMode, isThreeDMode, setThreeDState, setTwoDState],
  );
  // NOTE: there is no longer a workspace-level "smoothness" slider —
  // that was replaced by the per-layer SmootherOptions panel which
  // edits `element.options.algo` and the per-algorithm parameters
  // directly. `item.smootherLambda` is still kept in the schema so old
  // projects load cleanly and seed back-compat for legacy smoother
  // elements (see `finalElements` above) but nothing in the UI ever
  // writes to it any more.
  const setFilters = useCallback(
    (next: FilterRuleItem[]) => {
      updateItem(item.id, { filters: next });
      markDirty();
    },
    [item.id, updateItem, markDirty],
  );

  /** Replace the entire group-style entry for one group (or remove it). */
  const setGroupStyle = useCallback(
    (groupKey: string, next: GroupStyle | undefined) => {
      const cur = groupStyles;
      const updated: GroupStyleMap = { ...cur };
      if (next === undefined) delete updated[groupKey];
      else updated[groupKey] = next;
      if (isThreeDMode) {
        setThreeDState((prev) => ({ ...prev, groupStyles: updated }));
      } else {
        setTwoDState((prev) => ({ ...prev, groupStyles: updated }));
      }
    },
    [groupStyles, isThreeDMode, setThreeDState, setTwoDState],
  );

  /** Toggle a group's visibility in the legend (eye-icon button). Hidden
   *  groups keep their color slot reserved — un-hiding restores the same
   *  color — but their series are skipped at render time and excluded
   *  from the shared-axis range calc so visible data fills the chart. */
  const toggleGroupHidden = useCallback(
    (groupKey: string) => {
      const cur = hiddenGroups;
      const next = cur.includes(groupKey)
        ? cur.filter((k) => k !== groupKey)
        : [...cur, groupKey];
      if (isThreeDMode) {
        setThreeDState((prev) => ({ ...prev, hiddenGroups: next }));
      } else {
        setTwoDState((prev) => ({ ...prev, hiddenGroups: next }));
      }
    },
    [hiddenGroups, isThreeDMode, setThreeDState, setTwoDState],
  );

  /** Clear every per-group override at once — used by the STYLE editor's
   *  Reset button. Lives at the parent level (not inside the panel) so a
   *  multi-group reset is a single atomic store write, instead of N writes
   *  that would each trigger a re-render. */
  const resetAllGroupStyles = useCallback(() => {
    if (Object.keys(groupStyles).length === 0) return;
    if (isThreeDMode) {
      setThreeDState((prev) => ({ ...prev, groupStyles: {} }));
    } else {
      setTwoDState((prev) => ({ ...prev, groupStyles: {} }));
    }
  }, [groupStyles, isThreeDMode, setThreeDState, setTwoDState]);

  /** Replace the Y-axis reference-line list on this graph item. The
   *  RefLinesEditor below builds the next array (immutable add / patch /
   *  remove) and hands it in; we persist it to the project via the same
   *  updateItem + markDirty pair used elsewhere. */
  const setRefLinesY = useCallback(
    (next: RefLineY[]) => {
      if (item.mode !== "2d") return;
      setTwoDState((prev) => ({ ...prev, refLinesY: next }));
    },
    [item.mode, setTwoDState],
  );

  /** Replace the X-axis reference-line list on this graph item. Mirror
   *  of `setRefLinesY` for the X axis — same store-write pattern. The
   *  renderer silently drops X ref lines when the X axis is categorical
   *  (they have no meaningful position there), so the editor stays
   *  available even on categorical-X charts and the lines come back
   *  the moment X is rebound to a value column or the axes are swapped. */
  const setRefLinesX = useCallback(
    (next: RefLineX[]) => {
      if (item.mode !== "2d") return;
      setTwoDState((prev) => ({ ...prev, refLinesX: next }));
    },
    [item.mode, setTwoDState],
  );

  /** Toggle the auto spec-limit overlay on the **Y axis** only.
   *  When enabled, the renderer pulls LSL / Target / USL out of the
   *  Y column's `spec` extras and draws them as red / green dashed
   *  reference lines. X is unaffected — it has its own
   *  `setAutoSpecLinesX` toggle. The flag is per-axis so a chart with
   *  spec extras on both columns can show / hide each overlay
   *  independently. The lines are NOT folded into `refLinesY` — the
   *  user controls the overlay globally via this flag, leaving the
   *  per-line editor below dedicated to manual annotations. */
  const setAutoSpecLinesY = useCallback(
    (next: boolean) => {
      if (item.mode !== "2d") return;
      setTwoDState((prev) => ({ ...prev, autoSpecLinesY: next }));
    },
    [item.mode, setTwoDState],
  );

  /** Toggle the auto spec-limit overlay on the **X axis** only.
   *  Mirror of `setAutoSpecLinesY` — reads the X column's `extras.spec`
   *  metadata. Independent of the Y flag. The renderer silently skips
   *  the overlay when X is bound to a category / row-index column. */
  const setAutoSpecLinesX = useCallback(
    (next: boolean) => {
      if (item.mode !== "2d") return;
      setTwoDState((prev) => ({ ...prev, autoSpecLinesX: next }));
    },
    [item.mode, setTwoDState],
  );

  /** Replace the Y-axis configuration (range / tick density / decimals /
   *  inverse). Passing `undefined` (or all-undefined fields via the
   *  AxisSettingsEditor's Reset button) restores fully automatic
   *  behavior — the renderer's `buildAxisOverrides` emits an empty
   *  fragment when every field is undefined. */
  const setYAxisConfig = useCallback(
    (next: YAxisConfig | undefined) => {
      if (item.mode !== "2d") return;
      setTwoDState((prev) => ({ ...prev, yAxis: next }));
    },
    [item.mode, setTwoDState],
  );

  /** Replace the X-axis configuration. Mirrors `setYAxisConfig` — the
   *  shape of the override config is identical for both axes. */
  const setXAxisConfig = useCallback(
    (next: YAxisConfig | undefined) => {
      if (item.mode !== "2d") return;
      setTwoDState((prev) => ({ ...prev, xAxis: next }));
    },
    [item.mode, setTwoDState],
  );

  // 拖放处理
  const onDragStart = (e: React.DragEvent, field: FieldRef) => {
    // Multi-drag: when the dragged item is part of the current
    // selection AND the selection has more than one entry, drag ALL
    // selected fields together as an array. Otherwise this is a
    // single-item drag — clear the visual selection so the user
    // doesn't see stale highlights, and serialize just this one
    // field (still as a 1-length array for receiver simplicity).
    const dragSet =
      selectedColNames.has(field.name) && selectedColNames.size > 1
        ? columns.filter((c) => selectedColNames.has(c.name))
        : [field];
    if (dragSet.length <= 1) {
      // Drag started on an unselected (or only-self-selected) item:
      // reset the multi-select to just this column so the highlight
      // matches the drag.
      setSelectedColNames(new Set([field.name]));
      colAnchorRef.current = field.name;
    }
    const payload = JSON.stringify(dragSet);
    e.dataTransfer.setData(DRAG_MIME, payload);
    // 同时写入 text/plain 作为傅底（部分 WebView 对自定义 MIME 不友好）
    try { e.dataTransfer.setData("text/plain", payload); } catch { /* ignore */ }
    e.dataTransfer.effectAllowed = "copy";
  };

  /** Handle a click on a column-list item. Implements the standard
   *  multi-select gesture set:
   *    - plain click         → select only this item (anchor = this)
   *    - Ctrl / Cmd + click  → toggle this item (anchor = this)
   *    - Shift + click       → range select from anchor to this item
   *  The selection persists across re-renders and only resets when
   *  the user makes a plain click on a different item or starts a
   *  drag on an unselected item. */
  const handleColClick = useCallback(
    (name: string, e: React.MouseEvent) => {
      const isCtrl = e.ctrlKey || e.metaKey;
      const isShift = e.shiftKey && !isCtrl;
      if (isShift && colAnchorRef.current && colAnchorRef.current !== name) {
        const names = columns.map((c) => c.name);
        const a = names.indexOf(colAnchorRef.current);
        const b = names.indexOf(name);
        if (a >= 0 && b >= 0) {
          const [lo, hi] = a <= b ? [a, b] : [b, a];
          const range = new Set(names.slice(lo, hi + 1));
          setSelectedColNames(range);
          return;
        }
      }
      if (isCtrl) {
        setSelectedColNames((prev) => {
          const next = new Set(prev);
          if (next.has(name)) next.delete(name);
          else next.add(name);
          return next;
        });
        colAnchorRef.current = name;
        return;
      }
      // Plain click: single select.
      setSelectedColNames(new Set([name]));
      colAnchorRef.current = name;
    },
    [columns],
  );

  /** Parse a drag payload that may be a single FieldRef (legacy) or
   *  an array of FieldRef (multi-drag). Always returns an array; empty
   *  array means "could not parse". */
  const parseDragFields = useCallback((raw: string): FieldRef[] => {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.filter((f): f is FieldRef =>
          !!f && typeof (f as FieldRef).name === "string",
        );
      }
      if (parsed && typeof (parsed as FieldRef).name === "string") {
        return [parsed as FieldRef];
      }
    } catch {
      // ignore
    }
    return [];
  }, []);

  /** Bind a field to an encoding slot, atomically clearing the
   *  axis's data-range overrides (min / max / tickInterval) when the
   *  X or Y slot's column actually changes to a different one. See
   *  the long comment in `handleDropOnSlot` for the rationale.
   *  Also clears any multi-mode list on the same slot — a single
   *  field bind always exits multi-mode for that slot. */
  const bindFieldToSlot = useCallback(
    (slot: SlotKey, field: FieldRef) => {
      if (item.mode === "multivariate") return;
      const prevField = encoding[slot];
      const multiKey: "multiX" | "multiY" | null =
        slot === "x" ? "multiX" : slot === "y" ? "multiY" : null;
      const hadMulti = multiKey ? ((slot === "x" ? multiX : multiY)?.length ?? 0) > 0 : false;
      const axisKey: "xAxis" | "yAxis" | null =
        slot === "x" ? "xAxis" : slot === "y" ? "yAxis" : null;
      const prevAxis = axisKey === "xAxis" ? xAxisConfig : axisKey === "yAxis" ? yAxisConfig : undefined;
      const prepared = prepareAxisBinding(
        prevField?.name,
        field.name,
        hadMulti,
        prevAxis,
      );
      const { bindingChanged, axisConfig } = prepared;
      if (axisKey && bindingChanged) {
        setTwoDState((prev) => ({
          ...prev,
          encoding: { ...prev.encoding, [slot]: field },
          ...(axisKey === "xAxis" ? { xAxis: axisConfig } : {}),
          ...(axisKey === "yAxis" ? { yAxis: axisConfig } : {}),
          ...(multiKey === "multiX" ? { multiX: [] } : {}),
          ...(multiKey === "multiY" ? { multiY: [] } : {}),
        }));
        return;
      }
      setEncoding((prev) => ({ ...prev, [slot]: field }));
    },
    [item.mode, encoding, multiX, multiY, xAxisConfig, yAxisConfig, setTwoDState, setEncoding],
  );

  /** Replace a slot's multi-mode list. Length 0 / undefined exits
   *  multi-mode (also clears `encoding[slot]`). Length 1 is
   *  auto-collapsed back to single-field encoding on `encoding[slot]`
   *  so multi-mode never holds exactly one column. Length 2+
   *  enters / stays in multi-mode and clears `encoding[slot]`.
   *  Atomic via a single `updateItem` so the rendered state stays
   *  consistent during transitions. At most one axis can be in
   *  multi-mode at a time — entering multi-mode on one axis also
   *  clears the other axis's multi list (the other-axis multi state
   *  would otherwise produce an ambiguous render). */
  const setMultiAtSlot = useCallback(
    (slot: "x" | "y", next: FieldRef[] | undefined) => {
      if (item.mode !== "2d") return;
      const multiKey: "multiX" | "multiY" = slot === "x" ? "multiX" : "multiY";
      const otherMultiKey: "multiX" | "multiY" = slot === "x" ? "multiY" : "multiX";
      const axisKey: "xAxis" | "yAxis" = slot === "x" ? "xAxis" : "yAxis";
      const list = (next ?? []).filter((f, i, arr) =>
        arr.findIndex((g) => g.name === f.name) === i,
      );
      const prevAxis = axisKey === "xAxis" ? xAxisConfig : yAxisConfig;
      const needsAxisReset =
        prevAxis !== undefined &&
        (prevAxis.min !== undefined ||
          prevAxis.max !== undefined ||
          prevAxis.tickInterval !== undefined);
      const axisPatch = needsAxisReset
        ? { ...prevAxis, min: undefined, max: undefined, tickInterval: undefined }
        : undefined;
      if (list.length === 0) {
        setTwoDState((prev) => ({
          ...prev,
          [multiKey]: [],
          ...(axisKey === "xAxis" && axisPatch ? { xAxis: axisPatch } : {}),
          ...(axisKey === "yAxis" && axisPatch ? { yAxis: axisPatch } : {}),
        }));
        return;
      }
      if (list.length === 1) {
        const only = list[0];
        setTwoDState((prev) => ({
          ...prev,
          [multiKey]: [],
          encoding: { ...prev.encoding, [slot]: only },
          ...(axisKey === "xAxis" && axisPatch ? { xAxis: axisPatch } : {}),
          ...(axisKey === "yAxis" && axisPatch ? { yAxis: axisPatch } : {}),
        }));
        return;
      }
      // ≥2 columns: stay in multi-mode. Clear `encoding[slot]` so the
      // single-field chip doesn't shadow the multi list. Also clear
      // any multi on the OTHER axis — only one axis can be in
      // multi-mode at a time.
      const nextEncoding = { ...twoD.encoding };
      delete nextEncoding[slot];
      setTwoDState((prev) => ({
        ...prev,
        [multiKey]: list,
        [otherMultiKey]: [],
        encoding: nextEncoding,
        ...(axisKey === "xAxis" && axisPatch ? { xAxis: axisPatch } : {}),
        ...(axisKey === "yAxis" && axisPatch ? { yAxis: axisPatch } : {}),
      }));
    },
    [item.mode, xAxisConfig, yAxisConfig, twoD.encoding, setTwoDState],
  );

  /** Are all the given fields numeric (continuous)? Multi-mode is
   *  restricted to numeric columns because the "names → axis, values
   *  → other axis" semantics only makes sense for comparable scales. */
  const allNumeric = useCallback((fields: FieldRef[]): boolean => {
    if (fields.length === 0) return false;
    return fields.every((f) => f.type === "continuous");
  }, []);

  const handleDropOnSlot = (slot: SlotKey, e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const raw =
      e.dataTransfer.getData(DRAG_MIME) ||
      e.dataTransfer.getData("text/plain");
    if (!raw) return;
    const fields = parseDragFields(raw);
    if (fields.length === 0) return;
    // When the user swaps the column on a value-axis slot (x or y)
    // to a DIFFERENT column, drop the data-range-dependent axis
    // overrides (min / max / tickInterval) on that axis. The new
    // column will almost always span a different numeric range —
    // e.g. swapping a column scaled in centigrade (4.3 - 4.6) for
    // one in Pa (1e4 - 1e6) — and keeping the old pinned bounds
    // would silently crop every point off-screen. Other axis
    // overrides (decimals, inverse, minor-tick count, gridlines,
    // axis-line visibility, tick position) are display preferences
    // independent of data scale and stay untouched, so the user's
    // axis-line / gridline preferences survive a column swap.
    routeDropToSlot(slot, fields);
  };

  /** Centralized drop-router for one slot. Single field → existing
   *  single-bind logic (replace). Multi-field on x/y → multi-mode
   *  (axis or merge, derived at render time). Multi-field on any
   *  other slot → first field only (multi-mode is X/Y-only).
   *  Drop while already in multi-mode on x/y → APPEND.
   *  Any drop that would mix numeric + non-numeric columns in multi
   *  is rejected with a brief visual flash; the existing multi list
   *  stays untouched. */
  const routeDropToSlot = useCallback(
    (slot: SlotKey, fields: FieldRef[]) => {
      if (fields.length === 0) return;

      if (item.mode === "multivariate") {
        if (slot !== "y") return;
        const next = updateMultivariateColumns(item.modeStates.multivariate.columns, {
          type: "append",
          fields,
        });
        if (next.error) {
          flashRejectOnSlot("y");
          setCorrelationNotice(next.error);
          return;
        }
        setCorrelationNotice(null);
        setMultivariateState((prev) => ({ ...prev, columns: next.columns }));
        return;
      }

      const isAxis = slot === "x" || slot === "y";
      const multiKey: "multiX" | "multiY" | null =
        slot === "x" ? "multiX" : slot === "y" ? "multiY" : null;
      const existingMulti = multiKey ? (slot === "x" ? multiX : multiY) : undefined;
      const inMulti = !!existingMulti && existingMulti.length >= 2;

      // Already in multi-mode → all drops APPEND (single or multi).
      if (isAxis && inMulti && multiKey) {
        if (!allNumeric(fields)) {
          flashRejectOnSlot(slot);
          return;
        }
        const merged = [...(existingMulti ?? []), ...fields];
        setMultiAtSlot(slot, merged);
        return;
      }

      // Single field drop, NOT in multi-mode → existing replace logic.
      if (fields.length === 1) {
        bindFieldToSlot(slot, fields[0]);
        return;
      }

      // Multi-field drop on a non-axis slot: take the first field
      // (Color / Overlay / Group X / Group Y / Wrap / Size are single-
      // value channels — multi-binding wouldn't make sense there).
      if (!isAxis) {
        bindFieldToSlot(slot, fields[0]);
        return;
      }

      // Multi-field drop on x/y, NOT in multi-mode yet.
      if (!allNumeric(fields)) {
        flashRejectOnSlot(slot);
        return;
      }
      // Enter multi-mode with the dropped fields.
      setMultiAtSlot(slot, fields);
    },
    [item.mode, item.modeStates.multivariate.columns, setMultivariateState, multiX, multiY, bindFieldToSlot, setMultiAtSlot, allNumeric, flashRejectOnSlot, setCorrelationNotice],
  );

  const clearSlot = (slot: SlotKey) => {
    if (item.mode === "multivariate") {
      if (slot !== "y") return;
      setCorrelationNotice(null);
      setMultivariateState((prev) => ({ ...prev, columns: [] }));
      return;
    }
    // Atomic: clear both single encoding AND any multi list on the
    // same slot so the slot returns to fully empty.
    const multiKey: "multiX" | "multiY" | null =
      slot === "x" ? "multiX" : slot === "y" ? "multiY" : null;
    const nextEncoding = { ...encoding };
    delete nextEncoding[slot];
    if (isThreeDMode) {
      setThreeDState((prev) => ({
        ...prev,
        encoding: nextEncoding,
      }));
      return;
    }
    setTwoDState((prev) => ({
      ...prev,
      encoding: nextEncoding,
      ...(multiKey === "multiX" ? { multiX: [] } : {}),
      ...(multiKey === "multiY" ? { multiY: [] } : {}),
    }));
  };

  /** Add a new layer (chart kind) — enables it if already present.
   *  New smoother layers default to the Spline algorithm; new fitline
   *  layers default to a linear (degree-1) Polynomial fit. Legacy
   *  smoother elements saved without an `algo` keep their previous
   *  Moving Average behaviour via the fallbacks in transform.ts. */
  const addElement = useCallback((kind: ElementKind) => {
    if (item.mode === "multivariate") return;
    setElements((prev) => {
      const idx = prev.findIndex((e) => e.kind === kind);
      if (idx >= 0) {
        return prev.map((e, i) => (i === idx ? { ...e, enabled: true } : e));
      }
      const next: ChartElement = { kind, enabled: true };
      next.options = defaultLayerOptions(kind, prev);
      return [...prev, next];
    });
  }, [item.mode, setElements]);

  /** Remove a layer entirely from the elements list. */
  const removeElement = useCallback((kind: ElementKind) => {
    setElements((prev) => prev.filter((e) => e.kind !== kind));
  }, [setElements]);

  /** Patch an element's `options` map (per-kind settings). */
  const updateElementOptions = useCallback(
    (kind: ElementKind, patch: Record<string, unknown>) => {
      setElements((prev) =>
        prev.map((e) =>
          e.kind === kind
            ? { ...e, options: { ...(e.options ?? {}), ...patch } }
            : e,
        ),
      );
    },
    [setElements],
  );

  /** Wipe everything that defines the *content* of the current chart
   *  back to its pristine drop-zone state — encoding (axes + facets +
   *  color / overlay / size), elements, X / Y axis overrides, every
   *  reference-line list (manual + auto-spec toggles), legend group
   *  visibility, and per-group style overrides. Done as a single
   *  atomic `updateItem` so the history snapshot stays clean and the
   *  next render sees a fully consistent blank slate (a partial reset
   *  could leave e.g. a Y-axis range pin tied to a column the user
   *  just cleared, which would trigger a guard the next time they
   *  drop a new column on Y). Filters and smoother lambda are
   *  intentionally preserved — those are session-level analysis
   *  controls, not part of the chart's visual content. */
  const startOver = useCallback(() => {
    if (item.mode === "3d") {
      setThreeDState(createDefaultGraph3DState());
      return;
    }
    if (item.mode === "multivariate") {
      setMultivariateState(createDefaultMultivariateGraphState());
      return;
    }
    setTwoDState(createDefaultGraph2DState());
  }, [item.mode, setThreeDState, setMultivariateState, setTwoDState]);

  const swapXY = useCallback(() => {
    if (item.mode !== "2d") return;
    setTwoDState((prev) => ({
      ...prev,
      transposed: !prev.transposed,
    }));
  }, [item.mode, setTwoDState]);

  const samplingMode = item.sampling?.mode === "sample" ? "sample" : "full";
  const sampleSize = useMemo(() => {
    if (item.sampling?.mode !== "sample") return DEFAULT_GRAPH_SAMPLE_SIZE;
    return clampSampleSize(item.sampling.size);
  }, [item.sampling]);
  const sampleSeed = useMemo(() => {
    if (item.sampling?.mode !== "sample") return 0;
    const value = Math.trunc(item.sampling.seed);
    return Number.isFinite(value) && value >= 0 ? value : 0;
  }, [item.sampling]);

  const setSamplingMode = useCallback((mode: "full" | "sample") => {
    if (mode === "full") {
      updateItem(item.id, { sampling: { mode: "full" } });
      markDirty();
      return;
    }
    updateItem(item.id, {
      sampling: {
        mode: "sample",
        size: sampleSize,
        seed: sampleSeed,
      },
    });
    markDirty();
  }, [item.id, updateItem, markDirty, sampleSize, sampleSeed]);

  const setSampleSize = useCallback((raw: number) => {
    const size = clampSampleSize(Number.isFinite(raw) ? raw : sampleSize);
    updateItem(item.id, {
      sampling: {
        mode: "sample",
        size,
        seed: sampleSeed,
      },
    });
    markDirty();
  }, [item.id, updateItem, markDirty, sampleSeed, sampleSize]);

  const setSampleSeed = useCallback((raw: number) => {
    const seed = Math.max(0, Math.trunc(raw) || 0);
    updateItem(item.id, {
      sampling: {
        mode: "sample",
        size: sampleSize,
        seed,
      },
    });
    markDirty();
  }, [item.id, updateItem, markDirty, sampleSize]);

  const rowStatus = useMemo(() => {
    if (!progress) {
      return t("graph.rowStatus.empty", { defaultValue: "No graph frame yet" });
    }
    if (pipelineStatus === "pending") {
      if (progress.sourceRows <= 0) {
        return t("graph.rowStatus.pending", {
          defaultValue: "Processing rows...",
        });
      }
      return t("graph.rowStatus.pendingRows", {
        processed: progress.processedRows,
        source: progress.sourceRows,
        defaultValue: "Processing: {{processed}} / {{source}} rows",
      });
    }
    if (frame?.sampling.mode === "sample") {
      return t("graph.rowStatus.sampled", {
        processed: progress.processedRows,
        source: progress.sourceRows,
        defaultValue: "Sampled: {{processed}} / {{source}} rows",
      });
    }
    if (!isMultivariateMode && rawPointNotice) {
      return t("graph.rowStatus.pointsOmitted", {
        valid: rawPointNotice.validRows.toLocaleString(),
        budget: rawPointNotice.budget.toLocaleString(),
        defaultValue: "Raw points omitted: {{valid}} valid rows exceed the {{budget}} point budget",
      });
    }
    return t("graph.rowStatus.full", {
      processed: progress.processedRows,
      defaultValue: "Full Data: {{processed}} rows",
    });
  }, [frame, isMultivariateMode, pipelineStatus, progress, rawPointNotice, t]);

  const correlationNoticeText = useMemo(() => {
    if (!isMultivariateMode || !correlationNotice) {
      return null;
    }
    if (correlationNotice === "duplicateField") {
      return t("graph.correlation.dropReason.duplicateField", {
        defaultValue: "Column already selected in multivariate variables.",
      });
    }
    if (correlationNotice === "invalidFieldType") {
      return t("graph.correlation.dropReason.invalidFieldType", {
        defaultValue: "Only numeric columns can be added to multivariate variables.",
      });
    }
    return t("graph.correlation.tooManyColumns", {
      max: CORRELATION_MAX_COLUMNS,
      defaultValue: "Correlation matrix supports up to {{max}} columns.",
    });
  }, [correlationNotice, isMultivariateMode, t]);

  const progressPercent = progress?.percent ?? null;
  const progressAriaProps = progressPercent === null
    ? {}
    : {
      "aria-valuemin": 0,
      "aria-valuemax": 100,
      "aria-valuenow": Math.round(progressPercent),
    };

  const pipelineStatusLabel = useMemo(() => {
    if (pipelineStatus === "pending") {
      return t("graph.pipeline.pending", { defaultValue: "Updating graph..." });
    }
    if (pipelineStatus === "error") {
      return t("graph.pipeline.error", { defaultValue: "Update failed" });
    }
    if (metaError) {
      return t("graph.pipeline.metaError", { defaultValue: "Column metadata unavailable" });
    }
    if (metaLoading) {
      return t("graph.pipeline.metaLoading", { defaultValue: "Loading columns..." });
    }
    return t("graph.pipeline.ready", { defaultValue: "Ready" });
  }, [pipelineStatus, metaError, metaLoading, t]);

  const activeKinds = new Set(
    elements.filter((e) => e.enabled !== false).map((e) => e.kind),
  );

  return (
    <div className="gb-root">
      {/* 顶部工具条 */}
      <div className="gb-toolbar">
        <div className="gb-toolbar-left">
          <button className="gb-tb-btn" onClick={startOver}>{t("graph.startOver")}</button>
          {!isMultivariateMode && (
            <button
              className="gb-tb-btn"
              onClick={swapXY}
              title={t("graph.swapXY.tooltip", {
                defaultValue: "Transpose the chart visually without changing its data bindings.",
              })}
            >
              {t("graph.swapXY.label", { defaultValue: "Swap X & Y" })}
            </button>
          )}
          <button
            className={`gb-tb-btn${showFilters ? " gb-tb-btn-active" : ""}`}
            onClick={() => setShowFilters((v) => !v)}
            title={t("graph.filter.toggleTitle", { defaultValue: "Show/Hide local data filter" })}
          >
            {t("graph.filter.toolbarBtn", { defaultValue: "Filter" })}
            {filters.length > 0 && (
              <span className="gb-tb-badge">{filters.length}</span>
            )}
          </button>
          {!isMultivariateMode && (
            <div
              className="gb-cursor-mode"
              role="radiogroup"
              aria-label={t("graph.cursorMode.label", { defaultValue: "Cursor mode" })}
            >
              <span
                className={`gb-cursor-mode-thumb gb-cursor-mode-thumb-${cursorMode}`}
                aria-hidden="true"
              />
              <button
                type="button"
                role="radio"
                aria-checked={cursorMode === "pan"}
                className={`gb-cursor-mode-opt${cursorMode === "pan" ? " is-active" : ""}`}
                onClick={() => setCursorMode("pan")}
                title={t("graph.cursorMode.panTitle", {
                  defaultValue: "Pan mode: drag axes to scroll/zoom the chart.",
                })}
              >
                <i className="fa-regular fa-hand" aria-hidden="true" />
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={cursorMode === "select"}
                className={`gb-cursor-mode-opt${cursorMode === "select" ? " is-active" : ""}`}
                onClick={() => setCursorMode("select")}
                title={t("graph.cursorMode.selectTitle", {
                  defaultValue: "Select mode: drag on the chart to rubber-band-select points (highlights matching cells in the linked table).",
                })}
              >
                <i className="fa-solid fa-arrow-pointer" aria-hidden="true" />
              </button>
            </div>
          )}
          <div
            className="gb-dim-mode"
            role="radiogroup"
            aria-label={t("graph.mode.label", { defaultValue: "Graph mode" })}
          >
            <span
              className={`gb-dim-mode-thumb gb-dim-mode-thumb-${item.mode}`}
              aria-hidden="true"
            />
            <button
              type="button"
              role="radio"
              aria-checked={item.mode === "2d"}
              className={`gb-dim-mode-opt${item.mode === "2d" ? " is-active" : ""}`}
              onClick={() => setMode("2d")}
              title={t("graph.mode.twoD", { defaultValue: "2D" })}
            >
              {t("graph.mode.twoD", { defaultValue: "2D" })}
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={item.mode === "3d"}
              className={`gb-dim-mode-opt${item.mode === "3d" ? " is-active" : ""}`}
              onClick={() => setMode("3d")}
              title={t("graph.mode.threeD", { defaultValue: "3D" })}
            >
              {t("graph.mode.threeD", { defaultValue: "3D" })}
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={item.mode === "multivariate"}
              className={`gb-dim-mode-opt${item.mode === "multivariate" ? " is-active" : ""}`}
              onClick={() => setMode("multivariate")}
              title={t("graph.mode.multivariate", { defaultValue: "Multivariate" })}
            >
              {t("graph.mode.multivariate", { defaultValue: "Multivariate" })}
            </button>
          </div>
        </div>
        <div className="gb-toolbar-spacer" />
        <div className="gb-toolbar-right">
          {!isMultivariateMode && (
            <div className="gb-sampling" role="radiogroup" aria-label={t("graph.sampling.label", { defaultValue: "Sampling mode" })}>
            <button
              type="button"
              className={`gb-sampling-btn${samplingMode === "full" ? " is-active" : ""}`}
              onClick={() => setSamplingMode("full")}
            >
              {t("graph.sampling.full", { defaultValue: "Full" })}
            </button>
            <button
              type="button"
              className={`gb-sampling-btn${samplingMode === "sample" ? " is-active" : ""}`}
              onClick={() => setSamplingMode("sample")}
            >
              {t("graph.sampling.sample", { defaultValue: "Sample" })}
            </button>
            {samplingMode === "sample" && (
              <>
                <input
                  className="gb-sampling-input"
                  type="number"
                  min={1}
                  max={SCATTER_RENDER_BUDGET}
                  step={1}
                  value={sampleSize}
                  onChange={(e) => setSampleSize(Number(e.target.value))}
                  title={t("graph.sampling.size", { defaultValue: "Sample size" })}
                />
                <input
                  className="gb-sampling-input"
                  type="number"
                  min={0}
                  step={1}
                  value={sampleSeed}
                  onChange={(e) => setSampleSeed(Number(e.target.value))}
                  title={t("graph.sampling.seed", { defaultValue: "Sample seed" })}
                />
              </>
            )}
            </div>
          )}
          <div className="gb-pipeline-status">
            <span className={`gb-pipeline-state gb-pipeline-state-${pipelineStatus}`}>{pipelineStatusLabel}</span>
            <div
              className="gb-pipeline-progress sp-progress-bar"
              role="progressbar"
              aria-label={t("graph.pipeline.progress", { defaultValue: "Graph data loading progress" })}
              {...progressAriaProps}
            >
              <div
                className={`sp-progress-fill${progressPercent === null ? " sp-progress-indeterminate" : ""}`}
                style={progressPercent === null ? undefined : { width: `${progressPercent}%` }}
              />
            </div>
            <span className="gb-row-status">{rowStatus}</span>
          </div>
        </div>
      </div>

      <div className={`gb-body${isMultivariateMode ? " gb-body-correlation" : ""}`}>
        {/* Local Data Filter panel + splitter (leftmost, when toggled on). */}
        {showFilters && (
          <>
            <FilterPanel
              data={graphData}
              columns={columns}
              filters={filters}
              onChange={setFilters}
              onClose={() => setShowFilters(false)}
              width={filterWidth}
              categoricalMode="exclude"
              getCategoricalValues={getGraphCategoricalValues}
            />
            <div
              className="gb-splitter"
              onMouseDown={startSideResize("filter")}
              onDoubleClick={() => setFilterWidth(240)}
              title={t("graph.resizePanel", { defaultValue: "Drag to resize" })}
            />
          </>
        )}

        {/* 左栏 */}
        <div className="gb-left" style={{ width: leftWidth }} ref={leftRailRef}>
          {/* Reuse the same column-panel styling as the data table view so the
              two left rails look and feel identical. Items remain draggable so
              they can be dropped into encoding slots. */}
          <div
            className="sp-cols-panel gb-cols-panel"
            style={{ flex: `0 0 ${leftTopPct}%` }}
          >
            <div className="sp-panel-header">
              <span className="sp-panel-header-title">
                {t("graph.datasetHeader", { name: dataset.name, n: columns.length })}
              </span>
            </div>
            <div className="sp-cols-panel-list">
              {columns.map((c, i) => {
                const sqlType = colSqlTypes[i] ?? "";
                const tLabel = t(`dataTable.type.${sqlType}`, { defaultValue: sqlType });
                const selected = selectedColNames.has(c.name);
                return (
                  <div
                    key={c.name}
                    className={`sp-cols-panel-item${selected ? " sp-cols-panel-item-selected" : ""}`}
                    draggable
                    onClick={(e) => handleColClick(c.name, e)}
                    onDragStart={(e) => onDragStart(e, c)}
                    title={`${c.name} (${tLabel})`}
                  >
                    <span className="sp-cols-panel-item-type">{tLabel}</span>
                    <span className="sp-cols-panel-item-name">{c.name}</span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Horizontal splitter between TABLE columns and LAYERS */}
          <div
            className="gb-splitter-h"
            onMouseDown={startLeftRowResize}
            onDoubleClick={() => setLeftTopPct(50)}
            title={t("graph.resizePanel", { defaultValue: "Drag to resize" })}
          />

          {/* Layer cards: one per active chart kind, plus an add-card popover.
              Replaces the old per-chart-type sections and the top-toolbar
              chart-type toggle buttons. */}
          {isMultivariateMode ? (
            <div
              className="gb-layers"
              style={{ flex: `0 0 ${100 - leftTopPct}%` }}
            >
              <div className="sp-panel-header">
                <span className="sp-panel-header-title">{t("graph.multivariate.chartType", { defaultValue: "Chart type" })}</span>
              </div>
              <div className="gb-layers-list-wrap">
                <div className="gb-multivariate-panel">
                  <div className="gb-multivariate-chip">
                    {t("graph.type.correlationMatrix", { defaultValue: "Correlation Matrix" })}
                  </div>
                  <CorrelationMatrixOptions
                    options={{ correlationMethod: multivariate.correlationMethod }}
                    onChange={(patch) => {
                      const method =
                        patch.correlationMethod === "spearman" || patch.correlationMethod === "kendall"
                          ? patch.correlationMethod
                          : "pearson";
                      setMultivariateState((prev) => ({ ...prev, correlationMethod: method }));
                    }}
                    t={t}
                  />
                </div>
              </div>
            </div>
          ) : (
            <div
              className="gb-layers"
              style={{ flex: `0 0 ${100 - leftTopPct}%` }}
            >
              <div className="sp-panel-header">
                <span className="sp-panel-header-title">{t("graph.layersSection")}</span>
              </div>
              <div className="gb-layers-list-wrap">
                <div className="gb-layer-list">
                  {elements
                    .filter((el) => el.enabled !== false)
                    .filter((el) => getLayerMode(el.kind) === (isThreeDMode ? "3d" : "2d"))
                    .map((el) => (
                      <LayerCard
                        key={el.kind}
                        kind={el.kind}
                        label={t(`graph.type.${el.kind}`)}
                        options={el.options ?? {}}
                        onChangeOptions={(patch) => updateElementOptions(el.kind, patch)}
                        onRemove={() => removeElement(el.kind)}
                        t={t}
                      />
                    ))}
                  <AddLayerCard
                    availableKinds={GRAPH_LAYER_DEFS_WITH_CORRELATION.map((c) => c.kind).filter(
                      (k) => !activeKinds.has(k) && getLayerMode(k) === (isThreeDMode ? "3d" : "2d"),
                    )}
                    onAdd={addElement}
                    t={t}
                  />
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Splitter: left | center */}
        <div
          className="gb-splitter"
          onMouseDown={startSideResize("left")}
          onDoubleClick={() => setLeftWidth(220)}
          title={t("graph.resizePanel", { defaultValue: "Drag to resize" })}
        />

        {/* 中栏：画布 + X 轴槽 */}
        <div className={`gb-center${isMultivariateMode ? " gb-center-correlation" : ""}`}>
          {/* 顶部分组槽 — 转置后显示原 Group Y。 */}
          {!isMultivariateMode && (
            <Slot
              slot={visualSlots.top}
              label={visualSlots.top === "groupX" ? "Group X" : "Group Y"}
              field={encoding[visualSlots.top]}
              onDrop={(e) => handleDropOnSlot(visualSlots.top, e)}
              onClear={() => clearSlot(visualSlots.top)}
              onContextMenu={(x, y) => setSlotCtxMenu({ slot: visualSlots.top, x, y })}
              orientation="horizontal-top"
            />
          )}

          {/* 画布 + 左侧 Y 轴槽 + 右侧 Group Y 槽 */}
          <div
            className={`gb-canvas-row${isMultivariateMode ? " gb-canvas-row-correlation" : ""}`}
            style={
              isThreeDMode && !isMultivariateMode
                ? // 3D: 追加 Z（最左）与 Group Z（最右）两条 28px 轨道，
                  // 保持 [Z][Y][canvas][GroupY][GroupZ] 五列布局。
                  { gridTemplateColumns: "28px 28px 1fr 28px 28px" }
                : undefined
            }
          >
            {/* Z 轴槽 — 仅 3D 模式，位于 Y 轴拖动区左侧 */}
            {isThreeDMode && !isMultivariateMode && (
              <Slot
                slot="z"
                label="Z"
                field={encoding.z}
                onDrop={(e) => handleDropOnSlot("z", e)}
                onClear={() => clearSlot("z")}
                onContextMenu={(x, y) => setSlotCtxMenu({ slot: "z", x, y })}
                orientation="vertical-left"
              />
            )}
            <Slot
              slot={visualSlots.left}
              label={isMultivariateMode
                ? t("graph.multivariate.variables", { defaultValue: "Y (Variables)" })
                : visualSlots.left.toUpperCase()}
              field={isMultivariateMode ? multivariateSlotBinding.field : encoding[visualSlots.left]}
              fields={isMultivariateMode
                ? multivariateSlotBinding.columns
                : (visualSlots.left === "x" ? multiX : multiY)}
              onDrop={(e) => handleDropOnSlot(visualSlots.left, e)}
              onClear={() => clearSlot(visualSlots.left)}
              onOpenManager={
                isMultivariateMode && !multivariateSlotBinding.showManager
                  ? undefined
                  : () => setManagerOpenSlot(visualSlots.left)
              }
              onContextMenu={(x, y) => setSlotCtxMenu({ slot: visualSlots.left, x, y })}
              orientation="vertical-left"
              required={!isMultivariateMode}
              rejectFlash={rejectFlashSlot === visualSlots.left}
            />
            <div
              className={`gb-canvas${isMultivariateMode ? " gb-canvas-correlation" : ""}`}
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = "copy";
              }}
              onDrop={(e) => {
                e.preventDefault();
                const raw =
                  e.dataTransfer.getData(DRAG_MIME) ||
                  e.dataTransfer.getData("text/plain");
                if (!raw) return;
                const fields = parseDragFields(raw);
                if (fields.length === 0) return;
                // Canvas-drop is the "didn't aim at a slot" fallback:
                // fill X first, then Y, otherwise replace Y. We treat
                // a multi-mode list on a slot the same as a bound
                // single field for "is this slot occupied?" purposes
                // — once X has any binding (single OR multi), the
                // next canvas-drop falls through to Y. Route through
                // `routeDropToSlot` so the single/multi/append cases
                // get the same handling as a direct slot drop.
                const xBound = !!encoding.x || multiX.length > 0;
                const yBound = isMultivariateMode
                  ? multivariateSlotBinding.columns.length > 0
                  : (!!encoding.y || multiY.length > 0);
                const slot = resolveCanvasDropSlot({
                  isMultivariateMode,
                  xBound,
                  yBound,
                });
                routeDropToSlot(slot, fields);
              }}
            >
              <GraphRuntime
                item={item}
                dataset={dataset}
                showPointBudgetAction={!isMultivariateMode}
                onRequestSampleMode={!isMultivariateMode ? () => setSamplingMode("sample") : undefined}
                onYAxisDblClick={isMultivariateMode || readOnly ? undefined : () => setYAxisDialogOpen(true)}
                onXAxisDblClick={isMultivariateMode || readOnly ? undefined : () => setXAxisDialogOpen(true)}
                onAxisRangeChange={isMultivariateMode || readOnly ? undefined : ((axis, min, max) => {
                  if (axis === "y") {
                    setYAxisConfig({ ...(yAxisConfig ?? {}), min, max });
                  } else {
                    setXAxisConfig({ ...(xAxisConfig ?? {}), min, max });
                  }
                })}
                onAxisContextMenu={isMultivariateMode || readOnly ? undefined : ((axis, x, y) => setAxisCtxMenu({ axis, x, y }))}
                onPointPick={isMultivariateMode ? undefined : ((pick) => {
                  pickCell(dataset.id, { rowId: pick.rowId, colName: pick.colName });
                })}
                brushMode={!isMultivariateMode && cursorMode === "select"}
                onBrushSelect={isMultivariateMode ? undefined : ((picks) => {
                  pickCells(dataset.id, picks);
                })}
                onItemReconciled={(nextItem) => {
                  updateItem(item.id, {
                    modeStates: nextItem.modeStates,
                    filters: nextItem.filters,
                    groupThemeSlots: nextItem.groupThemeSlots,
                  });
                  markDirty();
                }}
                onStateChange={setRuntimeState}
              />
              {correlationNoticeText && (
                <div className="gb-canvas-overlay gb-canvas-overlay-warn" role="status" aria-live="polite">
                  {correlationNoticeText}
                </div>
              )}
            </div>
            {!isMultivariateMode && (
              <Slot
                slot={visualSlots.right}
                label={visualSlots.right === "groupX" ? "Group X" : "Group Y"}
                field={encoding[visualSlots.right]}
                onDrop={(e) => handleDropOnSlot(visualSlots.right, e)}
                onClear={() => clearSlot(visualSlots.right)}
                onContextMenu={(x, y) => setSlotCtxMenu({ slot: visualSlots.right, x, y })}
                orientation="vertical-right"
              />
            )}
            {/* Group Z 槽 — 仅 3D 模式，位于 Group Y 右侧 */}
            {isThreeDMode && !isMultivariateMode && (
              <Slot
                slot="groupZ"
                label="Group Z"
                field={encoding.groupZ}
                onDrop={(e) => handleDropOnSlot("groupZ", e)}
                onClear={() => clearSlot("groupZ")}
                onContextMenu={(x, y) => setSlotCtxMenu({ slot: "groupZ", x, y })}
                orientation="vertical-right"
              />
            )}
          </div>

          {/* 底部轴槽 — 转置后显示原 Y。 */}
          {!isMultivariateMode && (
            <Slot
              slot={visualSlots.bottom}
              label={visualSlots.bottom.toUpperCase()}
              field={encoding[visualSlots.bottom]}
              fields={visualSlots.bottom === "x" ? multiX : multiY}
              onDrop={(e) => handleDropOnSlot(visualSlots.bottom, e)}
              onClear={() => clearSlot(visualSlots.bottom)}
              onOpenManager={() => setManagerOpenSlot(visualSlots.bottom)}
              onContextMenu={(x, y) => setSlotCtxMenu({ slot: visualSlots.bottom, x, y })}
              orientation="horizontal-bottom"
              required
              rejectFlash={rejectFlashSlot === visualSlots.bottom}
            />
          )}
        </div>

        {/* Splitter: center | right */}
        {!isMultivariateMode && (
          <div
            className="gb-splitter"
            onMouseDown={startSideResize("right")}
            onDoubleClick={() => setRightWidth(220)}
            title={t("graph.resizePanel", { defaultValue: "Drag to resize" })}
          />
        )}

        {/* Legend + Style editor:
            - 顶部 Overlay 槽：拖入分类列即按其值生成图例分组；
            - 中间图例列表：每行对应一个分组（无 Overlay 时显示 "All"）；
            - 底部样式编辑器：针对当前选中的图例条目，分别设置线/填充/点。
            无论上方激活的是散点还是箱线图，三类样式都会对应应用。 */}
        {!isMultivariateMode && (
          <LegendStylePanel
            encoding={encoding}
            groupStyles={groupStyles}
            groupKeys={groupKeys}
            effectiveStyles={effectiveStyles}
            hiddenGroups={hiddenGroups}
            toggleGroupHidden={toggleGroupHidden}
            setGroupStyle={setGroupStyle}
            resetAllGroupStyles={resetAllGroupStyles}
            onDropOverlay={(e) => handleDropOnSlot("overlay", e)}
            onClearOverlay={() => clearSlot("overlay")}
            onOverlayContextMenu={(x, y) => setSlotCtxMenu({ slot: "overlay", x, y })}
            width={rightWidth}
            threeD={isThreeDMode}
            readOnly={readOnly}
          />
        )}
      </div>

      {/* Y-axis settings dialog. Opened by double-clicking the Y axis;
          modeled after the system Preferences dialog (left categories
          column + right detail pane) so adding future per-axis settings
          (log scale, tick formatter, ...) is a one-line nav-item
          addition. Today it has three categories: Axis (range / ticks /
          decimals / inverse), Tick Grid (major + minor gridlines),
          and Reference Lines. */}
      {!isMultivariateMode && yAxisDialogOpen && (
        <AxisSettingsDialog
          axis="y"
          refLines={refLinesY}
          setRefLines={setRefLinesY}
          autoSpecLines={!!(twoD.autoSpecLinesY ?? twoD.autoSpecLines)}
          setAutoSpecLines={setAutoSpecLinesY}
          resolvedAutoSpec={runtimeSpec.autoSpecY}
          autoSpecColName={encoding.y?.name}
          multiValueColCount={
            meltInfo &&
            ((meltInfo.mode === "axis" && meltInfo.slot === "x") ||
              (meltInfo.mode === "merge" && meltInfo.slot === "y"))
              ? meltInfo.cols.length
              : 0
          }
          axisConfig={yAxisConfig}
          setAxisConfig={setYAxisConfig}
          onClose={() => setYAxisDialogOpen(false)}
        />
      )}
      {/* X-axis settings dialog. Opened by double-clicking the X axis.
          Mirrors the Y dialog — including the Reference Lines category
          AND its OWN independent auto spec-limit overlay sourced from
          the X column's `extras.spec` metadata. X and Y are fully
          symmetric: each axis has its own `autoSpecLinesX` /
          `autoSpecLinesY` flag, so a chart with spec extras on both
          columns can show / hide each overlay independently. The
          renderer silently skips X ref lines when the X axis is
          categorical (no meaningful position), so the editor stays
          available throughout. */}
      {!isMultivariateMode && xAxisDialogOpen && (
        <AxisSettingsDialog
          axis="x"
          refLines={refLinesX}
          setRefLines={setRefLinesX}
          autoSpecLines={!!(twoD.autoSpecLinesX ?? twoD.autoSpecLines)}
          setAutoSpecLines={setAutoSpecLinesX}
          resolvedAutoSpec={runtimeSpec.autoSpecX}
          autoSpecColName={encoding.x?.name}
          multiValueColCount={
            meltInfo &&
            ((meltInfo.mode === "axis" && meltInfo.slot === "y") ||
              (meltInfo.mode === "merge" && meltInfo.slot === "x"))
              ? meltInfo.cols.length
              : 0
          }
          axisConfig={xAxisConfig}
          setAxisConfig={setXAxisConfig}
          onClose={() => setXAxisDialogOpen(false)}
        />
      )}
      {/* Multi-column manager popover. Opened by clicking the slot
          body when an axis is in multi-mode (2+ columns). Lets the
          user reorder and delete columns. If the list drops to <=1
          via deletes, multi-mode is auto-exited by `setMultiAtSlot`
          (length-1 collapses to single-field encoding, length-0
          clears the slot entirely). */}
      {managerOpenSlot && (managerOpenSlot === "x" || managerOpenSlot === "y") &&
       ((item.mode === "multivariate" && managerOpenSlot === "y")
         ? (multiY.length >= 1)
         : ((managerOpenSlot === "x" ? multiX : multiY)?.length ?? 0) >= 2) && (
        <MultiColManager
          slot={managerOpenSlot}
          cols={(managerOpenSlot === "x" ? multiX : multiY) ?? []}
          datasetColumns={columns}
          onChange={(next) => {
            if (item.mode === "multivariate") {
              const result = updateMultivariateColumns(multivariate.columns, { type: "set", fields: next });
              if (result.error) {
                setCorrelationNotice(result.error);
                return;
              }
              setCorrelationNotice(null);
              setMultivariateState((prev) => ({ ...prev, columns: result.columns }));
              return;
            }
            setMultiAtSlot(managerOpenSlot, next);
          }}
          onClose={() => setManagerOpenSlot(null)}
        />
      )}

      {/* Right-click context menu on slots. Currently a single
          "Clear" action — kept as a menu (not just a click) so the
          gesture is consistent across slot types and leaves room for
          future per-slot actions without restructuring. `clearSlot`
          handles both single-field and multi-mode atomically. */}
      {slotCtxMenu && (
        <div
          ref={ctxMenuRef}
          className="sp-ctx-menu"
          style={{ left: slotCtxMenu.x, top: slotCtxMenu.y }}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          <div
            className="sp-ctx-item sp-ctx-danger"
            onClick={() => {
              clearSlot(slotCtxMenu.slot);
              setSlotCtxMenu(null);
            }}
          >
            {t("graph.slotCtx.clear", { defaultValue: "Clear slot" })}
          </div>
        </div>
      )}
      {/* Right-click context menu on an axis strip. Two actions:
          - Axis settings: opens the same dialog as double-clicking the
            axis (Y or X depending on which strip was right-clicked).
          - Reset zoom: clears the pinned min/max on that axis, restoring
            automatic bounds while preserving other axis overrides. The
            item is disabled when no manual range is currently pinned. */}
      {!isMultivariateMode && axisCtxMenu && (
        <div
          ref={ctxMenuRef}
          className="sp-ctx-menu"
          style={{ left: axisCtxMenu.x, top: axisCtxMenu.y }}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          <div
            className="sp-ctx-item"
            onClick={() => {
              if (axisCtxMenu.axis === "y") setYAxisDialogOpen(true);
              else setXAxisDialogOpen(true);
              setAxisCtxMenu(null);
            }}
          >
            {t("graph.axisCtx.settings", { defaultValue: "Axis settings" })}
          </div>
          {(() => {
            const cfg = axisCtxMenu.axis === "y" ? yAxisConfig : xAxisConfig;
            const zoomed = !!cfg && (cfg.min !== undefined || cfg.max !== undefined);
            return (
              <div
                className={`sp-ctx-item${zoomed ? "" : " sp-ctx-disabled"}`}
                aria-disabled={!zoomed}
                onClick={() => {
                  if (!zoomed) return;
                  const next = { ...(cfg ?? {}), min: undefined, max: undefined };
                  const setter =
                    axisCtxMenu.axis === "y" ? setYAxisConfig : setXAxisConfig;
                  setter(isAxisConfigEmpty(next) ? undefined : next);
                  setAxisCtxMenu(null);
                }}
              >
                {t("graph.axisCtx.resetZoom", { defaultValue: "Reset zoom" })}
              </div>
            );
          })()}
        </div>
      )}
    </div>
  );
}

interface SlotProps {
  slot: SlotKey;
  label: string;
  field?: FieldRef;
  /** Multi-mode columns. When present and length >= 2 the slot
   *  renders as a multi-chip slot whose body click opens the manager
   *  popover instead of showing a single-field chip. */
  fields?: FieldRef[];
  onDrop: (e: React.DragEvent) => void;
  onClear: () => void;
  /** Called when the slot body is clicked in multi-mode — opens the
   *  manager popover. Required when `fields` has length >= 2. */
  onOpenManager?: () => void;
  /** Right-click hook — fires only when the slot has content (single
   *  OR multi). Receives viewport coordinates so the parent can pin
   *  the context menu at the cursor. Empty slots silently ignore
   *  right-clicks (no menu to show), letting the native browser menu
   *  through would just confuse the user when there's nothing to
   *  act on. */
  onContextMenu?: (x: number, y: number) => void;
  orientation: "horizontal-top" | "horizontal-bottom" | "vertical-left" | "vertical-right" | "shelf";
  required?: boolean;
  /** When true, briefly flashes the slot red to signal a rejected
   *  multi-drop (e.g. non-numeric mixed in). Reset by the parent
   *  after ~400 ms. */
  rejectFlash?: boolean;
}

function Slot({ label, field, fields, onDrop, onClear, onOpenManager, onContextMenu, orientation, required, rejectFlash }: SlotProps) {
  const { t } = useTranslation();
  const [over, setOver] = useState(false);
  // Multi-mode triggers when the parent passes 2+ fields. Length-1
  // is auto-collapsed back to single mode on the write side, so we
  // never need to handle that case here. */
  const isMulti = !!fields && fields.length >= 2;
  const canManage = !!fields && fields.length >= 1 && !!onOpenManager;
  const filled = isMulti || !!field || !!(fields && fields.length > 0);
  return (
    <div
      className={`gb-slot gb-slot-${orientation}${over ? " gb-slot-over" : ""}${filled ? " gb-slot-filled" : ""}${isMulti ? " gb-slot-multi" : ""}${rejectFlash ? " gb-slot-reject" : ""}`}
      onDragEnter={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        if (!over) setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false);
        onDrop(e);
      }}
      onClick={canManage ? () => onOpenManager?.() : undefined}
      onContextMenu={(e) => {
        // Only intercept right-clicks on filled slots — empty slots
        // have nothing to act on so let the browser do its thing
        // (or let the parent's right-click handler bubble up). When
        // filled, suppress the native menu and hand the cursor
        // position to the parent so it can render a styled menu.
        if (!filled || !onContextMenu) return;
        e.preventDefault();
        e.stopPropagation();
        onContextMenu(e.clientX, e.clientY);
      }}
      title={canManage ? t("graph.multiSlot.openManager", { defaultValue: "Click to manage columns" }) : undefined}
    >
      {!filled && (
        <span className="gb-slot-label">{label}{required ? " *" : ""}</span>
      )}
      {isMulti && (
        // Compact summary chip — shows the count and a preview of
        // the first column name. Full management happens in the
        // popover opened via onOpenManager.
        <span className="gb-slot-chip gb-slot-chip-multi">
          <span className="gb-slot-chip-name">
            {t("graph.multiSlot.summary", {
              defaultValue: "{{n}} cols: {{first}}",
              n: fields!.length,
              first: fields![0].name,
            })}
          </span>
        </span>
      )}
      {!isMulti && field && (
        <span className="gb-slot-chip">
          <span className="gb-slot-chip-name">{field.name}</span>
          <button
            className="gb-slot-chip-x"
            onClick={(e) => {
              e.stopPropagation();
              onClear();
            }}
            title={t("graph.removeSlot")}
          >
            ×
          </button>
        </span>
      )}
    </div>
  );
}

// ---- Multi-column manager popover ---------------------------------------
//
// Modal-style overlay opened by clicking a slot that's in multi-mode
// (2+ columns). Supports:
//   - Per-row selection (plain click toggles; Ctrl+click toggles
//     individually; Shift+click range-selects from the last anchor).
//   - Bulk toolbar at the top: Move selection up / down (preserves
//     relative order, sails the selected block past unselected rows),
//     Delete selection, Reset to dataset order. All disabled when no
//     selection exists (except Reset which is always meaningful).
//   - All edits write through onChange → setMultiAtSlot on the parent,
//     which auto-collapses length-1 back to single-field encoding and
//     clears the slot entirely on length-0. The manager never has to
//     worry about those edge cases.
// Backdrop click and Esc both close.

interface MultiColManagerProps {
  slot: "x" | "y";
  cols: FieldRef[];
  /** Full ordered list of columns in the dataset — used as the
   *  authoritative "default order" for the Reset button. The manager
   *  ranks each multi-col by its index here and sorts ascending.
   *  Columns missing from this list (defensive — shouldn't happen)
   *  fall to the end in stable order. */
  datasetColumns: FieldRef[];
  onChange: (next: FieldRef[]) => void;
  onClose: () => void;
}

function MultiColManager({ slot, cols, datasetColumns, onChange, onClose }: MultiColManagerProps) {
  const { t } = useTranslation();
  // Selection by column NAME (stable across reorders). Stored as a Set
  // for O(1) membership checks during the move/delete operations and
  // the per-row className branch.
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  // Anchor for shift+click range selection — points at the column name
  // of the last *plain*-clicked row. Null until the first click.
  const anchorRef = useRef<string | null>(null);

  // Auto-prune selection when columns disappear from `cols` (e.g.
  // after a delete the parent re-renders us with the trimmed list).
  // Without this the selection would carry stale names forward and
  // confuse the toolbar (e.g. "Delete (3)" when only 2 are present).
  useEffect(() => {
    const live = new Set(cols.map((c) => c.name));
    setSelected((prev) => {
      let changed = false;
      const next = new Set<string>();
      prev.forEach((n) => {
        if (live.has(n)) next.add(n);
        else changed = true;
      });
      return changed ? next : prev;
    });
  }, [cols]);

  // Close on Esc — matches the AxisSettingsDialog interaction.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // ---- Row click: plain / Ctrl / Shift selection model -----------------
  const handleRowClick = (name: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const names = cols.map((c) => c.name);
    if (e.shiftKey && anchorRef.current && names.includes(anchorRef.current)) {
      // Range select from anchor to clicked, inclusive. Replaces the
      // current selection so the result is exactly the range — matches
      // the Windows file-explorer feel.
      const a = names.indexOf(anchorRef.current);
      const b = names.indexOf(name);
      const [lo, hi] = a < b ? [a, b] : [b, a];
      const range = new Set(names.slice(lo, hi + 1));
      setSelected(range);
      // anchor stays the same — sequential shift+clicks pivot around it.
    } else if (e.ctrlKey || e.metaKey) {
      // Toggle individual row in / out of the selection. New anchor =
      // this row so subsequent shift+clicks pivot here.
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(name)) next.delete(name);
        else next.add(name);
        return next;
      });
      anchorRef.current = name;
    } else {
      // Plain click: select only this row. Re-clicking the only
      // selected row keeps it selected (clearer than a toggle for
      // bulk-action UX).
      setSelected(new Set([name]));
      anchorRef.current = name;
    }
  };

  const selectAll = () => {
    setSelected(new Set(cols.map((c) => c.name)));
  };
  const clearSelection = () => {
    setSelected(new Set());
    anchorRef.current = null;
  };
  const selCount = selected.size;
  const allSelected = selCount > 0 && selCount === cols.length;

  // ---- Bulk move up / down --------------------------------------------
  // Strategy: pass once over the array; for move-up walk top-down and
  // swap any selected row with the unselected row above it. The block
  // semantics fall out naturally — a selected run "bubbles" upward past
  // unselected rows but stays internally ordered.
  const moveUp = () => {
    if (selCount === 0) return;
    const next = cols.slice();
    for (let i = 1; i < next.length; i++) {
      if (selected.has(next[i].name) && !selected.has(next[i - 1].name)) {
        [next[i - 1], next[i]] = [next[i], next[i - 1]];
      }
    }
    onChange(next);
  };
  const moveDown = () => {
    if (selCount === 0) return;
    const next = cols.slice();
    for (let i = next.length - 2; i >= 0; i--) {
      if (selected.has(next[i].name) && !selected.has(next[i + 1].name)) {
        [next[i], next[i + 1]] = [next[i + 1], next[i]];
      }
    }
    onChange(next);
  };

  // ---- Bulk delete -----------------------------------------------------
  // Drops every selected row in one go. The parent (setMultiAtSlot)
  // handles the length-1 collapse and length-0 clear, so dropping the
  // selection below 2 auto-exits multi-mode without any check here.
  const deleteSelected = () => {
    if (selCount === 0) return;
    const next = cols.filter((c) => !selected.has(c.name));
    onChange(next);
  };

  // ---- Reset to default order -----------------------------------------
  // "Default" = the column order in the dataset (matches the order the
  // user sees in the left-rail column list). Cols missing from the
  // dataset list (defensive) sort to the end while preserving their
  // current relative order.
  const resetOrder = () => {
    const orderByName = new Map<string, number>();
    datasetColumns.forEach((c, i) => orderByName.set(c.name, i));
    const fallback = datasetColumns.length;
    const next = cols
      .map((c, i) => ({ c, rank: orderByName.get(c.name) ?? fallback, i }))
      .sort((a, b) => (a.rank - b.rank) || (a.i - b.i))
      .map((x) => x.c);
    // Skip the update if it would be a no-op (avoids dirtying the
    // project when the order is already canonical).
    let same = true;
    for (let i = 0; i < next.length; i++) {
      if (next[i].name !== cols[i].name) { same = false; break; }
    }
    if (!same) onChange(next);
  };

  // Disable conditions for the move buttons: precisely when no move
  // would change the array. That is: every selected row's neighbor on
  // that side is also selected (the selected block is already pinned).
  // The contiguous-block-at-top case (e.g. selection = first 2 rows)
  // and the interleaved case (e.g. selection = rows 0 and 2) are both
  // handled — for interleaved selections moving up still re-arranges
  // the unpinned rows, so the button stays enabled.
  const upDisabled = selCount === 0 || !cols.some(
    (c, i) => i > 0 && selected.has(c.name) && !selected.has(cols[i - 1].name),
  );
  const downDisabled = selCount === 0 || !cols.some(
    (c, i) => i < cols.length - 1 && selected.has(c.name) && !selected.has(cols[i + 1].name),
  );

  return (
    <div
      className="gb-multi-mgr-backdrop"
      onClick={onClose}
      onMouseDown={(e) => {
        // Prevent backdrop mousedown from selecting underlying text.
        if (e.target === e.currentTarget) e.preventDefault();
      }}
    >
      <div className="gb-multi-mgr" onClick={(e) => e.stopPropagation()}>
        <div className="gb-multi-mgr-head">
          <span>
            {t("graph.multiSlot.title", {
              defaultValue: "{{axis}} axis columns ({{n}})",
              axis: slot.toUpperCase(),
              n: cols.length,
            })}
          </span>
          <button
            className="gb-slot-chip-x"
            onClick={onClose}
            title={t("graph.multiSlot.close", { defaultValue: "Close" })}
          >
            ×
          </button>
        </div>
        <div className="gb-multi-mgr-hint">
          {t("graph.multiSlot.hint", {
            defaultValue:
              "Click to select. Ctrl+click toggles; Shift+click range. Drop new columns onto the slot to add.",
          })}
        </div>
        {/* Bulk action toolbar. Selection-based: move ↑↓ shift the
            selected block past unselected rows preserving order; Delete
            removes everything in the selection; Reset sorts by dataset
            column order. The selection counter on the left doubles as
            a select-all toggle for fast bulk operations. */}
        <div className="gb-multi-mgr-toolbar">
          <button
            type="button"
            className="gb-multi-mgr-toolbar-sel"
            onClick={allSelected ? clearSelection : selectAll}
            title={allSelected
              ? t("graph.multiSlot.clearSel", { defaultValue: "Clear selection" })
              : t("graph.multiSlot.selectAll", { defaultValue: "Select all" })}
          >
            {selCount > 0
              ? t("graph.multiSlot.selCount", {
                  defaultValue: "{{n}} selected",
                  n: selCount,
                })
              : t("graph.multiSlot.selNone", { defaultValue: "None selected" })}
          </button>
          <span className="gb-multi-mgr-toolbar-spacer" />
          <button
            type="button"
            className="gb-multi-mgr-toolbar-btn"
            disabled={upDisabled}
            onClick={moveUp}
            title={t("graph.multiSlot.moveUp", { defaultValue: "Move up" })}
          >
            ↑
          </button>
          <button
            type="button"
            className="gb-multi-mgr-toolbar-btn"
            disabled={downDisabled}
            onClick={moveDown}
            title={t("graph.multiSlot.moveDown", { defaultValue: "Move down" })}
          >
            ↓
          </button>
          <button
            type="button"
            className="gb-multi-mgr-toolbar-btn gb-multi-mgr-toolbar-btn-del"
            disabled={selCount === 0}
            onClick={deleteSelected}
            title={t("graph.multiSlot.deleteSel", { defaultValue: "Delete selected" })}
          >
            ×
          </button>
          <button
            type="button"
            className="gb-multi-mgr-toolbar-btn"
            onClick={resetOrder}
            title={t("graph.multiSlot.resetOrder", {
              defaultValue: "Reset to dataset column order",
            })}
          >
            ⟲
          </button>
        </div>
        <div className="gb-multi-mgr-body">
          {cols.map((c) => {
            const sel = selected.has(c.name);
            return (
              <div
                key={c.name}
                className={`gb-multi-mgr-row${sel ? " gb-multi-mgr-row-sel" : ""}`}
                onClick={(e) => handleRowClick(c.name, e)}
              >
                <span className="gb-multi-mgr-row-name">{c.name}</span>
              </div>
            );
          })}
        </div>
        <div className="gb-multi-mgr-foot">
          <button
            className="gb-multi-mgr-foot-btn gb-multi-mgr-foot-btn-primary"
            onClick={onClose}
          >
            {t("graph.multiSlot.done", { defaultValue: "Done" })}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---- Layer cards ---------------------------------------------------------
// Each enabled chart kind in `elements` gets a card rendered in the left
// rail's "Layers" section. The card shows the kind label, a delete button,
// and any kind-specific inline settings (e.g. smoother lambda slider, scatter
// encoding hints). At the end of the list, an `AddLayerCard` shows a `+`
// tile that opens a small popover listing kinds not yet present.

interface LayerCardProps {
  kind: ElementKind;
  label: string;
  options: Record<string, unknown>;
  onChangeOptions: (patch: Record<string, unknown>) => void;
  onRemove: () => void;
  t: (k: string, opts?: Record<string, unknown>) => string;
}

/** Read an option with a default fallback. */
function getOpt<T>(opts: Record<string, unknown>, key: string, def: T): T {
  const v = opts[key];
  return v === undefined ? def : (v as T);
}

function LayerCard({
  kind,
  label,
  options,
  onChangeOptions,
  onRemove,
  t,
}: LayerCardProps) {
  const def = GRAPH_LAYER_DEFS_WITH_CORRELATION.find((c) => c.kind === kind);
  const layerMode = getLayerMode(kind);
  const layerModeLabel =
    layerMode === "3d"
      ? "3D"
      : layerMode === "multivariate"
        ? t("graph.mode.multivariate", { defaultValue: "Multivariate" })
        : "2D";
  return (
    <div className="gb-layer-card">
      <div className="gb-layer-head">
        <span className="gb-layer-icon">{def?.icon ?? "▦"}</span>
        <span className="gb-layer-title">{label}</span>
        <span className={`gb-layer-dim gb-layer-dim-${layerMode}`}>
          {layerModeLabel}
        </span>
        <button
          className="gb-layer-x"
          onClick={onRemove}
          title={t("graph.removeLayer")}
        >
          ×
        </button>
      </div>
      <div className="gb-layer-body">
        {kind === "points" && (
          <PointsOptions options={options} onChange={onChangeOptions} t={t} />
        )}
        {kind === "scatter3d" && (
          <Scatter3DOptions options={options} onChange={onChangeOptions} t={t} />
        )}
        {kind === "line" && (
          <LineOptions options={options} onChange={onChangeOptions} t={t} />
        )}
        {kind === "boxplot" && (
          <BoxplotOptions options={options} onChange={onChangeOptions} t={t} />
        )}
        {kind === "histogram" && (
          <HistogramOptions options={options} onChange={onChangeOptions} t={t} />
        )}
        {kind === "normalCurve" && (
          <NormalCurveOptions options={options} onChange={onChangeOptions} t={t} />
        )}
        {kind === "smoother" && (
          <SmootherOptions options={options} onChange={onChangeOptions} t={t} />
        )}
        {kind === "fitline" && (
          <FitLineOptions options={options} onChange={onChangeOptions} t={t} />
        )}
        {kind === "surface" && (
          <SurfaceOptions options={options} onChange={onChangeOptions} t={t} />
        )}
        {kind === "correlationMatrix" && (
          <CorrelationMatrixOptions options={options} onChange={onChangeOptions} t={t} />
        )}
        {kind === "contour3d" && (
          <Contour3DOptions options={options} onChange={onChangeOptions} t={t} />
        )}
      </div>
    </div>
  );
}

// ---- Per-kind option editors --------------------------------------------
// All settings are stored in `element.options` (a Record<string,unknown>).
// These editors are presentational only — value changes go straight back to
// the store via `onChange`. Defaults mirror the JMP-style screenshot.

interface OptionsEditorProps {
  options: Record<string, unknown>;
  onChange: (patch: Record<string, unknown>) => void;
  t: (k: string, opts?: Record<string, unknown>) => string;
}

function OptRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="gb-opt-row">
      <span className="gb-opt-label">{label}</span>
      <span className="gb-opt-ctrl">{children}</span>
    </div>
  );
}

function PointsOptions({ options, onChange, t }: OptionsEditorProps) {
  const summary = getOpt<string>(options, "summaryStat", "none");
  const errInterval = getOpt<string>(options, "errorInterval", "auto");
  const intStyle = getOpt<string>(options, "intervalStyle", "errorBar");
  // Default is "stacked" — "auto" remains a legacy value (older specs).
  // The renderer treats both the same; here we only need to make sure
  // the <select> shows a sensible selection for legacy values too, so
  // collapse "auto" → "stacked" for the dropdown's selected value.
  const jitterRaw = getOpt<string>(options, "jitter", "stacked");
  const jitter = jitterRaw === "auto" ? "stacked" : jitterRaw;
  const jitterLimit = getOpt<number>(options, "jitterLimit", 0.5);
  return (
    <>
      <OptRow label={t("graph.opt.summaryStat")}>
        <select
          className="gb-opt-select"
          value={summary}
          onChange={(e) => onChange({ summaryStat: e.target.value })}
        >
          <option value="none">{t("graph.opt.summary.none")}</option>
          <option value="mean">{t("graph.opt.summary.mean")}</option>
          <option value="median">{t("graph.opt.summary.median")}</option>
          <option value="sum">{t("graph.opt.summary.sum")}</option>
        </select>
      </OptRow>
      <OptRow label={t("graph.opt.errorInterval")}>
        <select
          className="gb-opt-select"
          value={errInterval}
          onChange={(e) => onChange({ errorInterval: e.target.value })}
        >
          <option value="auto">{t("graph.opt.auto")}</option>
          <option value="none">{t("graph.opt.summary.none")}</option>
          <option value="stdErr">{t("graph.opt.interval.stdErr")}</option>
          <option value="stdDev">{t("graph.opt.interval.stdDev")}</option>
          <option value="ci95">{t("graph.opt.interval.ci95")}</option>
        </select>
      </OptRow>
      <OptRow label={t("graph.opt.intervalStyle")}>
        <select
          className="gb-opt-select"
          value={intStyle}
          onChange={(e) => onChange({ intervalStyle: e.target.value })}
        >
          <option value="errorBar">{t("graph.opt.style.errorBar")}</option>
          <option value="band">{t("graph.opt.style.band")}</option>
        </select>
      </OptRow>
      <OptRow label={t("graph.opt.jitter")}>
        <select
          className="gb-opt-select"
          value={jitter}
          onChange={(e) => onChange({ jitter: e.target.value })}
        >
          <option value="stacked">{t("graph.opt.jitterMode.stacked")}</option>
          <option value="uniform">{t("graph.opt.jitterMode.uniform")}</option>
          <option value="normal">{t("graph.opt.jitterMode.normal")}</option>
        </select>
      </OptRow>
      <OptRow label={t("graph.opt.jitterLimit")}>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={jitterLimit}
          onChange={(e) => onChange({ jitterLimit: parseFloat(e.target.value) })}
          className="gb-slider"
        />
      </OptRow>
    </>
  );
}

function LineOptions({ options, onChange, t }: OptionsEditorProps) {
  const rowOrder = getOpt<boolean>(options, "rowOrder", false);
  const connection = getOpt<string>(options, "connection", "line");
  const summary = getOpt<string>(options, "summaryStat", "mean");
  const fill = getOpt<string>(options, "fill", "none");
  const errInterval = getOpt<string>(options, "errorInterval", "auto");
  const intStyle = getOpt<string>(options, "intervalStyle", "errorBar");
  const missingFactors = getOpt<string>(options, "missingFactors", "skip");
  const missingValues = getOpt<string>(options, "missingValues", "connect");
  return (
    <>
      <OptRow label={t("graph.opt.rowOrder")}>
        <input
          type="checkbox"
          checked={rowOrder}
          onChange={(e) => onChange({ rowOrder: e.target.checked })}
        />
      </OptRow>
      <OptRow label={t("graph.opt.connection")}>
        <select
          className="gb-opt-select"
          value={connection}
          onChange={(e) => onChange({ connection: e.target.value })}
        >
          <option value="line">{t("graph.opt.conn.line")}</option>
          <option value="step">{t("graph.opt.conn.step")}</option>
          <option value="spline">{t("graph.opt.conn.spline")}</option>
        </select>
      </OptRow>
      <OptRow label={t("graph.opt.summaryStat")}>
        <select
          className="gb-opt-select"
          value={summary}
          onChange={(e) => onChange({ summaryStat: e.target.value })}
        >
          <option value="mean">{t("graph.opt.summary.mean")}</option>
          <option value="median">{t("graph.opt.summary.median")}</option>
          <option value="sum">{t("graph.opt.summary.sum")}</option>
          <option value="none">{t("graph.opt.summary.none")}</option>
        </select>
      </OptRow>
      <OptRow label={t("graph.opt.fill")}>
        <select
          className="gb-opt-select"
          value={fill}
          onChange={(e) => onChange({ fill: e.target.value })}
        >
          <option value="none">{t("graph.opt.summary.none")}</option>
          <option value="toZero">{t("graph.opt.fillMode.toZero")}</option>
          <option value="between">{t("graph.opt.fillMode.between")}</option>
        </select>
      </OptRow>
      <OptRow label={t("graph.opt.errorInterval")}>
        <select
          className="gb-opt-select"
          value={errInterval}
          onChange={(e) => onChange({ errorInterval: e.target.value })}
        >
          <option value="auto">{t("graph.opt.auto")}</option>
          <option value="none">{t("graph.opt.summary.none")}</option>
          <option value="stdErr">{t("graph.opt.interval.stdErr")}</option>
          <option value="stdDev">{t("graph.opt.interval.stdDev")}</option>
          <option value="ci95">{t("graph.opt.interval.ci95")}</option>
        </select>
      </OptRow>
      <OptRow label={t("graph.opt.intervalStyle")}>
        <select
          className="gb-opt-select"
          value={intStyle}
          onChange={(e) => onChange({ intervalStyle: e.target.value })}
        >
          <option value="errorBar">{t("graph.opt.style.errorBar")}</option>
          <option value="band">{t("graph.opt.style.band")}</option>
        </select>
      </OptRow>
      <OptRow label={t("graph.opt.missingFactors")}>
        <select
          className="gb-opt-select"
          value={missingFactors}
          onChange={(e) => onChange({ missingFactors: e.target.value })}
        >
          <option value="skip">{t("graph.opt.missing.skip")}</option>
          <option value="include">{t("graph.opt.missing.include")}</option>
        </select>
      </OptRow>
      <OptRow label={t("graph.opt.missingValues")}>
        <select
          className="gb-opt-select"
          value={missingValues}
          onChange={(e) => onChange({ missingValues: e.target.value })}
        >
          <option value="connect">{t("graph.opt.missing.connect")}</option>
          <option value="break">{t("graph.opt.missing.break")}</option>
        </select>
      </OptRow>
    </>
  );
}

function BoxplotOptions({ options, onChange, t }: OptionsEditorProps) {
  // See PointsOptions for the "auto" → "stacked" legacy mapping rationale.
  const jitterRaw = getOpt<string>(options, "jitter", "stacked");
  const jitter = jitterRaw === "auto" ? "stacked" : jitterRaw;
  const outliers = getOpt<boolean>(options, "outliers", true);
  const boxType = getOpt<string>(options, "boxType", "outlier");
  const boxStyle = getOpt<string>(options, "boxStyle", "normal");
  const fiveNum = getOpt<boolean>(options, "fiveNumberSummary", false);
  const widthProp = getOpt<number>(options, "widthProportion", 0.5);
  return (
    <>
      <OptRow label={t("graph.opt.jitter")}>
        <select
          className="gb-opt-select"
          value={jitter}
          onChange={(e) => onChange({ jitter: e.target.value })}
        >
          <option value="stacked">{t("graph.opt.jitterMode.stacked")}</option>
          <option value="uniform">{t("graph.opt.jitterMode.uniform")}</option>
          <option value="normal">{t("graph.opt.jitterMode.normal")}</option>
        </select>
      </OptRow>
      <OptRow label={t("graph.opt.outliers")}>
        <input
          type="checkbox"
          checked={outliers}
          onChange={(e) => onChange({ outliers: e.target.checked })}
        />
      </OptRow>
      <OptRow label={t("graph.opt.boxType")}>
        <select
          className="gb-opt-select"
          value={boxType}
          onChange={(e) => onChange({ boxType: e.target.value })}
        >
          <option value="outlier">{t("graph.opt.box.outlier")}</option>
          <option value="quantile">{t("graph.opt.box.quantile")}</option>
        </select>
      </OptRow>
      <OptRow label={t("graph.opt.boxStyle")}>
        <select
          className="gb-opt-select"
          value={boxStyle}
          onChange={(e) => onChange({ boxStyle: e.target.value })}
        >
          <option value="normal">{t("graph.opt.box.normal")}</option>
          <option value="notched">{t("graph.opt.box.notched")}</option>
        </select>
      </OptRow>
      <OptRow label={t("graph.opt.fiveNumberSummary")}>
        <input
          type="checkbox"
          checked={fiveNum}
          onChange={(e) => onChange({ fiveNumberSummary: e.target.checked })}
        />
      </OptRow>
      <OptRow label={t("graph.opt.widthProportion")}>
        <input
          type="number"
          className="gb-opt-num"
          min={0}
          max={1}
          step={0.05}
          value={widthProp}
          onChange={(e) =>
            onChange({ widthProportion: parseFloat(e.target.value) || 0 })
          }
        />
      </OptRow>
    </>
  );
}

/** Histogram options panel — JMP-style style selector + per-bin labels.
 *  The Smoothness slider only matters for KDE so we hide it for the
 *  other styles to reduce visual noise. */
function HistogramOptions({ options, onChange, t }: OptionsEditorProps) {
  const histStyle = getOpt<string>(options, "histStyle", "bar");
  const smoothness = getOpt<number>(options, "smoothness", 0.5);
  const histHeight = getOpt<number>(options, "histHeight", 1);
  const showCounts = getOpt<boolean>(options, "showCounts", false);
  const showPercents = getOpt<boolean>(options, "showPercents", false);
  return (
    <>
      <OptRow label={t("graph.opt.histStyle")}>
        <select
          className="gb-opt-select"
          value={histStyle}
          onChange={(e) => onChange({ histStyle: e.target.value })}
        >
          <option value="bar">{t("graph.opt.histStyles.bar")}</option>
          <option value="polygon">{t("graph.opt.histStyles.polygon")}</option>
          <option value="kde">{t("graph.opt.histStyles.kde")}</option>
          <option value="shadowgram">{t("graph.opt.histStyles.shadowgram")}</option>
        </select>
      </OptRow>
      {histStyle === "kde" && (
        <OptRow label={t("graph.opt.smoothness")}>
          <input
            type="range"
            className="gb-slider"
            min={0}
            max={1}
            step={0.05}
            value={smoothness}
            onChange={(e) => onChange({ smoothness: parseFloat(e.target.value) })}
          />
        </OptRow>
      )}
      <OptRow label={t("graph.opt.histHeight")}>
        <input
          type="range"
          className="gb-slider"
          min={0.1}
          max={1}
          step={0.05}
          value={histHeight}
          onChange={(e) => onChange({ histHeight: parseFloat(e.target.value) })}
        />
      </OptRow>
      <OptRow label={t("graph.opt.showCounts")}>
        <input
          type="checkbox"
          checked={showCounts}
          onChange={(e) => onChange({ showCounts: e.target.checked })}
        />
      </OptRow>
      <OptRow label={t("graph.opt.showPercents")}>
        <input
          type="checkbox"
          checked={showPercents}
          onChange={(e) => onChange({ showPercents: e.target.checked })}
        />
      </OptRow>
    </>
  );
}

function NormalCurveOptions({ options, onChange, t }: OptionsEditorProps) {
  const showSigmaBands = getOpt<boolean>(options, "showSigmaBands", false);
  return (
    <OptRow label={t("graph.opt.showSigmaBands")}>
      <input
        type="checkbox"
        checked={showSigmaBands}
        onChange={(event) => onChange({ showSigmaBands: event.target.checked })}
      />
    </OptRow>
  );
}

/** 3D scatter options — mirrors the 2D scatter's Summary Stat / Error
 *  Interval, but drops Jitter (meaningless in 3D). The summary reduces
 *  each (X, Y) location to one point at its Z statistic; the error
 *  interval is drawn along Z as an Error Bar or a Band, same choices as
 *  2D. */
function Scatter3DOptions({ options, onChange, t }: OptionsEditorProps) {
  const summary = getOpt<string>(options, "summaryStat", "none");
  const errInterval = getOpt<string>(options, "errorInterval", "auto");
  const rawStyle = getOpt<string>(options, "intervalStyle", "errorBar");
  const intStyle = rawStyle === "band" ? "band" : "errorBar";
  return (
    <>
      <OptRow label={t("graph.opt.summaryStat")}>
        <select
          className="gb-opt-select"
          value={summary}
          onChange={(e) => onChange({ summaryStat: e.target.value })}
        >
          <option value="none">{t("graph.opt.summary.none")}</option>
          <option value="mean">{t("graph.opt.summary.mean")}</option>
          <option value="median">{t("graph.opt.summary.median")}</option>
          <option value="sum">{t("graph.opt.summary.sum")}</option>
        </select>
      </OptRow>
      <OptRow label={t("graph.opt.errorInterval")}>
        <select
          className="gb-opt-select"
          value={errInterval}
          onChange={(e) => onChange({ errorInterval: e.target.value })}
        >
          <option value="auto">{t("graph.opt.auto")}</option>
          <option value="none">{t("graph.opt.summary.none")}</option>
          <option value="stdErr">{t("graph.opt.interval.stdErr")}</option>
          <option value="stdDev">{t("graph.opt.interval.stdDev")}</option>
          <option value="ci95">{t("graph.opt.interval.ci95")}</option>
        </select>
      </OptRow>
      <OptRow label={t("graph.opt.intervalStyle")}>
        <select
          className="gb-opt-select"
          value={intStyle}
          onChange={(e) => onChange({ intervalStyle: e.target.value })}
        >
          <option value="errorBar">{t("graph.opt.style.errorBar")}</option>
          <option value="band">{t("graph.opt.style.band")}</option>
        </select>
      </OptRow>
    </>
  );
}

/** Surface (3D) options panel — aggregation statistic and visual smoothness.
 *  Smoothness controls lighting/facet softness for appearance only; a zero
 *  value preserves the observed faceted grid and any holes (no Z value
 *  smoothing or interpolation is performed). */
function SurfaceOptions({ options, onChange, t }: OptionsEditorProps) {
  const stat = getOpt<string>(options, "stat", "mean");
  const smoothness = getOpt<number>(options, "smoothness", 0);
  return (
    <>
      <OptRow label={t("graph.opt.surfaceStat", { defaultValue: "Statistic" })}>
        <select
          className="gb-opt-select"
          value={stat}
          onChange={(e) => onChange({ stat: e.target.value })}
        >
          <option value="mean">{t("graph.opt.summary.mean", { defaultValue: "Mean" })}</option>
          <option value="median">{t("graph.opt.summary.median", { defaultValue: "Median" })}</option>
        </select>
      </OptRow>
      <OptRow label={t("graph.opt.surfaceSmoothness", { defaultValue: "Smoothness" })}>
        <input
          type="range"
          className="gb-slider"
          min={0}
          max={1}
          step={0.05}
          value={smoothness}
          onChange={(e) => onChange({ smoothness: parseFloat(e.target.value) })}
        />
      </OptRow>
    </>
  );
}

function CorrelationMatrixOptions({ options, onChange, t }: OptionsEditorProps) {
  const method = getOpt<string>(options, "correlationMethod", "pearson");
  return (
    <OptRow label={t("graph.opt.correlationMethod", { defaultValue: "Correlation Method" })}>
      <select
        className="gb-opt-select"
        value={method}
        onChange={(e) => onChange({ correlationMethod: e.target.value })}
      >
        <option value="pearson">{t("graph.opt.correlation.pearson", { defaultValue: "Pearson" })}</option>
        <option value="spearman">{t("graph.opt.correlation.spearman", { defaultValue: "Spearman" })}</option>
        <option value="kendall">{t("graph.opt.correlation.kendall", { defaultValue: "Kendall" })}</option>
      </select>
    </OptRow>
  );
}

function Contour3DOptions({ options, onChange, t }: OptionsEditorProps) {
  const stat = getOpt<string>(options, "stat", "mean");
  const smoothness = getOpt<number>(options, "smoothness", 0);
  const levels = getOpt<number>(options, "levels", 10);
  return (
    <>
      <OptRow label={t("graph.opt.surfaceStat", { defaultValue: "Statistic" })}>
        <select
          className="gb-opt-select"
          value={stat}
          onChange={(e) => onChange({ stat: e.target.value })}
        >
          <option value="mean">{t("graph.opt.summary.mean", { defaultValue: "Mean" })}</option>
          <option value="median">{t("graph.opt.summary.median", { defaultValue: "Median" })}</option>
        </select>
      </OptRow>
      <OptRow label={t("graph.opt.surfaceSmoothness", { defaultValue: "Smoothness" })}>
        <input
          type="range"
          className="gb-slider"
          min={0}
          max={1}
          step={0.05}
          value={smoothness}
          onChange={(e) => onChange({ smoothness: parseFloat(e.target.value) })}
        />
      </OptRow>
      <OptRow label={t("graph.opt.contourLevels", { defaultValue: "Levels" })}>
        <input
          type="range"
          className="gb-slider"
          min={3}
          max={20}
          step={1}
          value={levels}
          onChange={(e) => onChange({ levels: Math.max(3, Math.min(20, parseInt(e.target.value, 10))) })}
        />
      </OptRow>
    </>
  );
}

/** Smoother options panel — algorithm selector + per-algorithm
 *  parameters. The visible controls below the algo dropdown vary with
 *  the selected algorithm so the panel only ever shows the inputs that
 *  actually affect the current curve. */
function SmootherOptions({ options, onChange, t }: OptionsEditorProps) {
  const algo = getOpt<string>(options, "algo", "movingAvg");
  // Per-algo parameter slots. Defaults match the values used in
  // transform.ts so an un-edited element renders identically to a
  // freshly added one.
  const splineSmoothness = getOpt<number>(options, "splineSmoothness", 0.5);
  const kernelBandwidth = getOpt<number>(options, "kernelBandwidth", 0.1);
  const savgolWindow = getOpt<number>(options, "savgolWindow", 11);
  const savgolPolyOrder = getOpt<number>(options, "savgolPolyOrder", 2);
  // `windowFraction` is the new key; fall back to legacy `lambda` for
  // pre-existing smoother elements so they show the right slider value
  // the first time their card is opened.
  const windowFraction = getOpt<number>(
    options,
    "windowFraction",
    getOpt<number>(options, "lambda", 0.4),
  );
  return (
    <>
      <OptRow label={t("graph.opt.smootherAlgo")}>
        <select
          className="gb-opt-select"
          value={algo}
          onChange={(e) => onChange({ algo: e.target.value })}
        >
          <option value="spline">{t("graph.opt.smootherAlgos.spline")}</option>
          <option value="kernel">{t("graph.opt.smootherAlgos.kernel")}</option>
          <option value="savgol">{t("graph.opt.smootherAlgos.savgol")}</option>
          <option value="movingAvg">
            {t("graph.opt.smootherAlgos.movingAvg")}
          </option>
          <option value="movingBox">
            {t("graph.opt.smootherAlgos.movingBox")}
          </option>
        </select>
      </OptRow>
      {algo === "spline" && (
        <OptRow label={t("graph.opt.smootherSplineSmoothness")}>
          <input
            type="range"
            className="gb-slider"
            min={0}
            max={1}
            step={0.05}
            value={splineSmoothness}
            onChange={(e) =>
              onChange({ splineSmoothness: parseFloat(e.target.value) })
            }
          />
        </OptRow>
      )}
      {algo === "kernel" && (
        <OptRow label={t("graph.opt.smootherKernelBandwidth")}>
          <input
            type="range"
            className="gb-slider"
            min={0.01}
            max={0.5}
            step={0.01}
            value={kernelBandwidth}
            onChange={(e) =>
              onChange({ kernelBandwidth: parseFloat(e.target.value) })
            }
          />
        </OptRow>
      )}
      {algo === "savgol" && (
        <>
          <OptRow label={t("graph.opt.smootherSavgolWindow")}>
            <input
              type="number"
              className="gb-opt-num"
              min={5}
              max={101}
              step={2}
              value={savgolWindow}
              onChange={(e) => {
                const raw = parseInt(e.target.value, 10);
                const v = Number.isFinite(raw)
                  ? Math.max(5, Math.min(101, raw))
                  : 11;
                // SG window must be odd — silently round up the even
                // values the spinner produces with step=2 ± clamping.
                onChange({ savgolWindow: v % 2 === 1 ? v : v + 1 });
              }}
            />
          </OptRow>
          <OptRow label={t("graph.opt.smootherSavgolPolyOrder")}>
            <select
              className="gb-opt-select"
              value={savgolPolyOrder}
              onChange={(e) =>
                onChange({ savgolPolyOrder: parseInt(e.target.value, 10) })
              }
            >
              <option value={2}>2</option>
              <option value={3}>3</option>
              <option value={4}>4</option>
            </select>
          </OptRow>
        </>
      )}
      {(algo === "movingAvg" || algo === "movingBox") && (
        <OptRow label={t("graph.opt.smootherWindow")}>
          <input
            type="range"
            className="gb-slider"
            min={0.02}
            max={0.9}
            step={0.02}
            value={windowFraction}
            onChange={(e) =>
              onChange({ windowFraction: parseFloat(e.target.value) })
            }
          />
        </OptRow>
      )}
    </>
  );
}

/** Fit-line options panel — fit type (Polynomial / Robust Cauchy) +
 *  degree (1–6) + Fit / Prediction confidence-band toggles + a master
 *  Statistics toggle that reveals the four per-stat checkboxes
 *  (Equation / RMSE / R² / F Test). Layout mirrors HistogramOptions
 *  and SmootherOptions so the panel feels like the rest of the
 *  Builder. */
function FitLineOptions({ options, onChange, t }: OptionsEditorProps) {
  const fitType = getOpt<string>(options, "fitType", "polynomial");
  const degree = getOpt<number>(options, "degree", 1);
  const showFitCI = getOpt<boolean>(options, "showFitCI", false);
  const showPredCI = getOpt<boolean>(options, "showPredCI", false);
  const showStats = getOpt<boolean>(options, "showStats", false);
  const showEquation = getOpt<boolean>(options, "showEquation", false);
  const showRMSE = getOpt<boolean>(options, "showRMSE", false);
  const showR2 = getOpt<boolean>(options, "showR2", false);
  const showFTest = getOpt<boolean>(options, "showFTest", false);
  return (
    <>
      <OptRow label={t("graph.opt.fitType")}>
        <select
          className="gb-opt-select"
          value={fitType}
          onChange={(e) => onChange({ fitType: e.target.value })}
        >
          <option value="polynomial">
            {t("graph.opt.fitTypes.polynomial")}
          </option>
          <option value="robustCauchy">
            {t("graph.opt.fitTypes.robustCauchy")}
          </option>
        </select>
      </OptRow>
      <OptRow label={t("graph.opt.fitDegree")}>
        <select
          className="gb-opt-select"
          value={degree}
          onChange={(e) => onChange({ degree: parseInt(e.target.value, 10) })}
        >
          <option value={1}>{t("graph.opt.fitDegrees.1")}</option>
          <option value={2}>{t("graph.opt.fitDegrees.2")}</option>
          <option value={3}>{t("graph.opt.fitDegrees.3")}</option>
          <option value={4}>{t("graph.opt.fitDegrees.4")}</option>
          <option value={5}>{t("graph.opt.fitDegrees.5")}</option>
          <option value={6}>{t("graph.opt.fitDegrees.6")}</option>
        </select>
      </OptRow>
      <OptRow label={t("graph.opt.fitConf.fit")}>
        <input
          type="checkbox"
          checked={showFitCI}
          onChange={(e) => onChange({ showFitCI: e.target.checked })}
        />
      </OptRow>
      <OptRow label={t("graph.opt.fitConf.prediction")}>
        <input
          type="checkbox"
          checked={showPredCI}
          onChange={(e) => onChange({ showPredCI: e.target.checked })}
        />
      </OptRow>
      <OptRow label={t("graph.opt.fitStats")}>
        <input
          type="checkbox"
          checked={showStats}
          onChange={(e) => onChange({ showStats: e.target.checked })}
        />
      </OptRow>
      {showStats && (
        <>
          <OptRow label={t("graph.opt.fitStat.equation")}>
            <input
              type="checkbox"
              checked={showEquation}
              onChange={(e) =>
                onChange({ showEquation: e.target.checked })
              }
            />
          </OptRow>
          <OptRow label={t("graph.opt.fitStat.rmse")}>
            <input
              type="checkbox"
              checked={showRMSE}
              onChange={(e) => onChange({ showRMSE: e.target.checked })}
            />
          </OptRow>
          <OptRow label={t("graph.opt.fitStat.r2")}>
            <input
              type="checkbox"
              checked={showR2}
              onChange={(e) => onChange({ showR2: e.target.checked })}
            />
          </OptRow>
          <OptRow label={t("graph.opt.fitStat.fTest")}>
            <input
              type="checkbox"
              checked={showFTest}
              onChange={(e) => onChange({ showFTest: e.target.checked })}
            />
          </OptRow>
        </>
      )}
    </>
  );
}

interface AddLayerCardProps {
  availableKinds: ElementKind[];
  onAdd: (kind: ElementKind) => void;
  t: (k: string, opts?: Record<string, unknown>) => string;
}

function AddLayerCard({ availableKinds, onAdd, t }: AddLayerCardProps) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  // Anchored position for the portaled menu. Recomputed when opened and on
  // window resize / ancestor scroll so the menu stays glued to the button
  // and never gets clipped by the surrounding scroll container.
  const [pos, setPos] = useState<{ left: number; top: number; width: number; flipUp: boolean } | null>(null);

  const recompute = useCallback(() => {
    const btn = btnRef.current;
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    // Estimate menu height from item count; clamp to a sane max.
    const estItemH = 28;
    const estMenuH = Math.min(availableKinds.length * estItemH + 8, 320);
    const spaceBelow = vh - r.bottom;
    const spaceAbove = r.top;
    const flipUp = spaceBelow < estMenuH + 8 && spaceAbove > spaceBelow;
    const top = flipUp ? Math.max(4, r.top - estMenuH - 4) : Math.min(vh - 4, r.bottom + 4);
    const left = Math.max(4, Math.min(r.left, vw - r.width - 4));
    setPos({ left, top, width: r.width, flipUp });
  }, [availableKinds.length]);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    recompute();
    const onWin = () => recompute();
    window.addEventListener("resize", onWin);
    window.addEventListener("scroll", onWin, true); // capture: catch all ancestor scrolls
    return () => {
      window.removeEventListener("resize", onWin);
      window.removeEventListener("scroll", onWin, true);
    };
  }, [open, recompute]);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const tgt = e.target as Node | null;
      if (!tgt) return;
      if (btnRef.current?.contains(tgt)) return;
      if (menuRef.current?.contains(tgt)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // After first paint, refine top if real height differs from estimate (esp.
  // when flipping above the button).
  useLayoutEffect(() => {
    if (!open || !pos || !menuRef.current) return;
    const real = menuRef.current.getBoundingClientRect();
    const btn = btnRef.current?.getBoundingClientRect();
    if (!btn) return;
    const vh = window.innerHeight;
    if (pos.flipUp) {
      const want = Math.max(4, btn.top - real.height - 4);
      if (Math.abs(want - pos.top) > 0.5) setPos({ ...pos, top: want });
    } else if (pos.top + real.height > vh - 4) {
      // Not enough room — flip up.
      const want = Math.max(4, btn.top - real.height - 4);
      setPos({ ...pos, top: want, flipUp: true });
    }
  }, [open, pos]);

  if (availableKinds.length === 0) return null;
  return (
    <div className="gb-layer-add-wrap">
      <button
        ref={btnRef}
        className="gb-layer-add"
        onClick={() => setOpen((o) => !o)}
        title={t("graph.addLayer")}
      >
        +
      </button>
      {open && pos && createPortal(
        <div
          ref={menuRef}
          className="gb-layer-add-menu gb-layer-add-menu-portal"
          style={{ left: pos.left, top: pos.top, minWidth: pos.width }}
        >
          {availableKinds.map((k) => {
            const def = GRAPH_LAYER_DEFS_WITH_CORRELATION.find((c) => c.kind === k);
            return (
              <button
                key={k}
                className="gb-layer-add-item"
                onClick={() => {
                  onAdd(k);
                  setOpen(false);
                }}
              >
                <span className="gb-layer-icon">{def?.icon ?? "▦"}</span>
                <span>{t(`graph.type.${k}`)}</span>
              </button>
            );
          })}
        </div>,
        document.body
      )}
    </div>
  );
}

// ---- Legend + per-group Style editor -----------------------------------
// Top half of the panel: a legend listing every group from the Color/
// Overlay encoding (or a single "All" entry when there is no grouping).
// Clicking a row selects it.
//
// Bottom half: a style editor for the selected group with three sections
// (Line, Fill, Point). Whatever active layer kinds (scatter, box plot,
// line, smoother, …) reuse this style — boxplot's body uses Fill, its
// border + median + whiskers use Line, its outliers use Point.

interface LegendStylePanelProps {
  encoding: Partial<Record<GraphSlotKey, FieldRef>>;
  groupStyles: GroupStyleMap;
  /** Group values driving the legend, computed at the parent level so
   *  the same list feeds both the renderer (via spec) and this panel. */
  groupKeys: string[];
  /** Fully-resolved per-group styles (user overrides + palette/categorical
   *  auto-defaults). Used by the swatches and as the "live" preview the
   *  MarkEditor falls back to when a particular mark hasn't been
   *  explicitly overridden yet. */
  effectiveStyles: GroupStyleMap;
  /** Group values currently hidden via the legend show/hide toggle. */
  hiddenGroups: string[];
  /** Flip one group's hidden state. */
  toggleGroupHidden: (groupKey: string) => void;
  setGroupStyle: (groupKey: string, next: GroupStyle | undefined) => void;
  /** Drop every per-group override and return the chart to factory
   *  defaults. Wired to the STYLE editor's Reset button. */
  resetAllGroupStyles: () => void;
  onDropOverlay: (e: React.DragEvent) => void;
  onClearOverlay: () => void;
  onOverlayContextMenu: (x: number, y: number) => void;
  width: number;
  /** Whether the chart is in 3D mode — the Gradient mark only applies to
   *  (and is only shown for) 3D surfaces / scatter. */
  threeD: boolean;
  /** Read-only while project save is in progress. */
  readOnly: boolean;
}

function LegendStylePanel({ encoding, groupStyles, groupKeys, effectiveStyles, hiddenGroups, toggleGroupHidden, setGroupStyle, resetAllGroupStyles, onDropOverlay, onClearOverlay, onOverlayContextMenu, width, threeD, readOnly }: LegendStylePanelProps) {
  const { t } = useTranslation();

  const [selected, setSelected] = useState<string>(groupKeys[0] ?? DEFAULT_GROUP_KEY);
  // Keep the selection valid when the legend list changes underneath us.
  useEffect(() => {
    if (!groupKeys.includes(selected)) {
      setSelected(groupKeys[0] ?? DEFAULT_GROUP_KEY);
    }
  }, [groupKeys, selected]);

  // Resolve "what color should the swatch / fallback show" for one group.
  // The expensive default-derivation logic lives at the parent in
  // `buildEffectiveStyles`; this thin wrapper just reads from the map and
  // returns a hard-fallback for the rare case where a group key isn't in
  // the map yet (e.g. during a render frame right after data changed).
  const effectiveStyleOf = (key: string): GroupStyle => {
    const eff = effectiveStyles[key];
    if (eff) return eff;
    return {
      line: { color: "#000", lineWidth: 1.5, opacity: 1 },
      fill: { color: "transparent", opacity: 1 },
      point: { color: "#000", fillColor: "#000", marker: "circle", markerSize: 4, opacity: 1 },
      gradient: { color: "#4a6cf7", opacity: 1 },
    };
  };

  const updateMark = (groupKey: string, mark: "line" | "fill" | "point" | "gradient", patch: Partial<MarkStyle>) => {
    const cur = groupStyles[groupKey] ?? {};
    const curMark = (cur[mark] ?? {}) as MarkStyle;
    setGroupStyle(groupKey, { ...cur, [mark]: { ...curMark, ...patch } });
  };

  /**
   * Apply a color *theme* to Line / Fill / Point at once. The theme picks
   * one base hue from the JMP palette and assigns a darker shade to the
   * Point, the base shade to the Line, and a lighter shade to the Fill
   * so the three sub-marks stay distinguishable when layered.
   * Other per-mark properties (line width, marker, opacity, …) are kept
   * as-is so the user can theme the color independently of size/shape.
   */
  const applyTheme = (groupKey: string, idx: number) => {
    const cur = groupStyles[groupKey] ?? {};
    setGroupStyle(groupKey, {
      ...cur,
      line: { ...(cur.line ?? {}), color: LINE_PALETTE[idx] },
      fill: { ...(cur.fill ?? {}), color: FILL_PALETTE[idx] },
      point: {
        ...(cur.point ?? {}),
        color: POINT_PALETTE[idx],
        fillColor: POINT_PALETTE[idx],
      },
      gradient: { ...(cur.gradient ?? {}), color: LINE_PALETTE[idx] },
    });
  };

  /**
   * Apply a user-defined custom palette (stored in useGraphPaletteStore).
   * Unlike the built-in `applyTheme`, custom palettes carry their three
   * final per-mark colors verbatim — no `shade()` re-derivation here, so
   * what the user saved is exactly what gets painted.
   */
  const applyCustomTheme = (groupKey: string, p: CustomPalette) => {
    const cur = groupStyles[groupKey] ?? {};
    setGroupStyle(groupKey, {
      ...cur,
      line: { ...(cur.line ?? {}), color: p.line },
      fill: { ...(cur.fill ?? {}), color: p.fill },
      point: {
        ...(cur.point ?? {}),
        color: p.point,
        fillColor: p.point,
      },
      gradient: { ...(cur.gradient ?? {}), color: p.line },
    });
  };

  // Custom user-defined palettes (persisted across sessions). The Theme
  // picker below renders these after the built-in swatches and ends with
  // a "+" button that opens AddPaletteDialog.
  const customPalettes = useGraphPaletteStore((s) => s.palettes);
  const addPalette = useGraphPaletteStore((s) => s.addPalette);
  const removePalette = useGraphPaletteStore((s) => s.removePalette);
  const [showAddDialog, setShowAddDialog] = useState(false);
  // Right-click on a custom swatch opens a tiny "Delete" context menu.
  const [paletteCtxMenu, setPaletteCtxMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  useEffect(() => {
    if (!paletteCtxMenu) return;
    const close = () => setPaletteCtxMenu(null);
    window.addEventListener("mousedown", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("blur", close);
    };
  }, [paletteCtxMenu]);

  // The Reset button in the STYLE editor header is a *chart-wide* reset,
  // not per-group. It lives in the editor's section header (not next to a
  // legend row), so users reasonably read it as "restore defaults for the
  // whole chart". A per-group-only reset also broke the enabled state
  // (button disabled while viewing an untouched group even though OTHER
  // groups were still customized) and made the only path to clean state a
  // tedious select-each-group / click-reset loop.
  const hasAnyCustomStyles = Object.keys(groupStyles).length > 0;

  const selectedStyle = effectiveStyleOf(selected);
  const storedSelected = groupStyles[selected] ?? {};

  return (
    <div className="gb-legend" style={{ width }}>
      {/* Unified panel header bar (matches Table column panel + LAYERS) */}
      <div className="sp-panel-header">
        <span className="sp-panel-header-title">{t("graph.legend.title")}</span>
      </div>

      <div className="gb-legend-body">
        {/* Overlay slot — placed under the LEGEND header and above the
            first legend entry so the visual hierarchy makes it clear: the
            legend rows below exist *because* this Overlay column is set. */}
        <Slot
          slot="overlay"
          label="Overlay"
          field={encoding.overlay}
          onDrop={onDropOverlay}
          onClear={onClearOverlay}
          onContextMenu={onOverlayContextMenu}
          orientation="shelf"
        />

        {/* Legend list */}
        {groupKeys.map((key) => {
          const st = effectiveStyleOf(key);
          const label = key === DEFAULT_GROUP_KEY ? t("graph.legend.allEntries") : (key || "—");
          // Show/hide toggle is per-group and only meaningful when the
          // legend has more than one entry — hiding the only entry would
          // erase the chart. Keep the button rendered (no layout jitter)
          // but disable it for the ungrouped single-row case.
          const isHidden = hiddenGroups.includes(key);
          const canToggle = !!encoding.overlay;
          const hideTitle = isHidden
            ? t("graph.legend.show", { defaultValue: "Show this group" })
            : t("graph.legend.hide", { defaultValue: "Hide this group" });
          return (
            <div
              key={key}
              className={`gb-legend-item${key === selected ? " gb-legend-item-selected" : ""}${isHidden ? " gb-legend-item-hidden" : ""}`}
              onClick={() => setSelected(key)}
            >
              <span className="gb-legend-swatch">
                <CompositeSwatch style={st} />
              </span>
              <span className="gb-legend-label" title={label}>{label}</span>
              <button
                className="gb-legend-toggle"
                onClick={(e) => {
                  // Don't let the click also flip the row's selected
                  // state — the eye button is a discrete action.
                  e.stopPropagation();
                  if (canToggle) toggleGroupHidden(key);
                }}
                disabled={!canToggle}
                title={hideTitle}
                aria-label={hideTitle}
                aria-pressed={isHidden}
              >
                {isHidden ? (
                  // Eye-off (hidden) — outline eye with a diagonal slash.
                  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M2 8s2.2-4 6-4c1.2 0 2.2.3 3.1.8M14 8s-2.2 4-6 4c-1.2 0-2.2-.3-3.1-.8" />
                    <path d="M6.5 6.5a2 2 0 0 0 2.9 2.9" />
                    <path d="M2.5 13.5l11-11" />
                  </svg>
                ) : (
                  // Eye (visible) — outline almond shape with pupil.
                  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M1.5 8S4 4 8 4s6.5 4 6.5 4-2.5 4-6.5 4S1.5 8 1.5 8z" />
                    <circle cx="8" cy="8" r="1.8" />
                  </svg>
                )}
              </button>
            </div>
          );
        })}

        {/* Style editor (bottom half) */}
        <div className="gb-style-editor">
          <div className="sp-panel-header">
            <span className="sp-panel-header-title">{t("graph.style.editorTitle")}</span>
            <button
              className="gb-style-reset"
              onClick={resetAllGroupStyles}
              title={t("graph.style.resetAllHint")}
              disabled={!hasAnyCustomStyles}
            >
              {t("graph.style.reset")}
            </button>
          </div>

          {/* Gradient (3D only): a per-group mark, exactly like Point /
              Line / Fill — theme-assigned a different color per legend
              group, user-switchable. Each group's 3D surface / scatter
              uses its gradient color (shaded by 3D lighting). */}
          {threeD && (
            <MarkEditor
              title={t("graph.mark.gradient", { defaultValue: "Gradient" })}
              mark="gradient"
              value={(storedSelected.gradient ?? {}) as MarkStyle}
              effective={{
                color: selectedStyle.gradient!.color!,
                opacity: selectedStyle.gradient!.opacity,
              }}
              onChange={(patch) => updateMark(selected, "gradient", patch)}
              fields={["color", "opacity"]}
            />
          )}

          {/* Color theme — one-click recolor of Line/Fill/Point. Each
              theme assigns a darker shade to Point, base shade to Line
              and a lighter shade to Fill so the three sub-marks stay
              visually distinguishable when stacked. Other per-mark
              properties (width, marker shape, opacity, …) are preserved. */}
          <div className="gb-style-section gb-style-theme-section">
            <div
              className="gb-style-section-title"
              title={t("graph.style.themeHint")}
            >
              {t("graph.style.theme")}
            </div>
            <div className="gb-style-row">
              <div className="gb-style-color-row gb-style-theme-row">
                {STYLE_COLORS.map((_, i) => {
                  const matches =
                    selectedStyle.line!.color === LINE_PALETTE[i] &&
                    selectedStyle.fill!.color === FILL_PALETTE[i] &&
                    selectedStyle.point!.color === POINT_PALETTE[i];
                  // Vertical 3-band gradient communicates the shade trio
                  // — Fill (top, light), Line (middle, mid), Point (bottom, dark).
                  const bg = `linear-gradient(180deg, ${FILL_PALETTE[i]} 0 33%, ${LINE_PALETTE[i]} 33% 67%, ${POINT_PALETTE[i]} 67% 100%)`;
                  return (
                    <button
                      key={i}
                      type="button"
                      className={`gb-style-color-swatch gb-style-theme-swatch${matches ? " gb-style-color-selected" : ""}`}
                      style={{ background: bg }}
                      title={`${FILL_PALETTE[i]} / ${LINE_PALETTE[i]} / ${POINT_PALETTE[i]}`}
                      onClick={() => applyTheme(selected, i)}
                    />
                  );
                })}
                {/* Custom user-saved palettes — same swatch styling so
                    they sit visually flush with the built-ins. Right-click
                    opens a delete affordance; left-click applies the theme
                    to the currently selected legend group. */}
                {customPalettes.map((p) => {
                  const matches =
                    selectedStyle.line!.color === p.line &&
                    selectedStyle.fill!.color === p.fill &&
                    selectedStyle.point!.color === p.point;
                  const bg = `linear-gradient(180deg, ${p.fill} 0 33%, ${p.line} 33% 67%, ${p.point} 67% 100%)`;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      className={`gb-style-color-swatch gb-style-theme-swatch${matches ? " gb-style-color-selected" : ""}`}
                      style={{ background: bg }}
                      title={`${p.fill} / ${p.line} / ${p.point}`}
                      onClick={() => applyCustomTheme(selected, p)}
                      disabled={readOnly}
                      onContextMenu={(e) => {
                        if (readOnly) return;
                        e.preventDefault();
                        e.stopPropagation();
                        setPaletteCtxMenu({ id: p.id, x: e.clientX, y: e.clientY });
                      }}
                    />
                  );
                })}
                <button
                  type="button"
                  className="gb-style-color-swatch gb-style-theme-swatch gb-style-theme-add"
                  title={t("graph.style.addTheme")}
                  onClick={() => {
                    if (readOnly) return;
                    setShowAddDialog(true);
                  }}
                  disabled={readOnly}
                  aria-label={t("graph.style.addTheme")}
                >
                  +
                </button>
              </div>
            </div>
          </div>

          <MarkEditor
            title={t("graph.mark.point")}
            mark="point"
            value={(storedSelected.point ?? {}) as MarkStyle}
            effective={{
              color: selectedStyle.point!.color!,
              marker: selectedStyle.point!.marker,
              markerSize: selectedStyle.point!.markerSize,
              opacity: selectedStyle.point!.opacity,
            }}
            onChange={(patch) => updateMark(selected, "point", patch)}
            fields={["color", "marker", "markerSize", "opacity"]}
          />
          <MarkEditor
            title={t("graph.mark.line")}
            mark="line"
            value={(storedSelected.line ?? {}) as MarkStyle}
            effective={{
              color: selectedStyle.line!.color!,
              lineWidth: selectedStyle.line!.lineWidth,
              opacity: selectedStyle.line!.opacity,
            }}
            onChange={(patch) => updateMark(selected, "line", patch)}
            fields={["color", "lineWidth", "opacity"]}
          />
          <MarkEditor
            title={t("graph.mark.fill")}
            mark="fill"
            value={(storedSelected.fill ?? {}) as MarkStyle}
            effective={{
              color: selectedStyle.fill!.color!,
              opacity: selectedStyle.fill!.opacity,
            }}
            onChange={(patch) => updateMark(selected, "fill", patch)}
            fields={["color", "opacity"]}
          />
        </div>
      </div>

      {/* Add-theme dialog — rendered inside the panel; the .sp-dialog-overlay
          is position:fixed so it covers the whole viewport regardless of
          this panel's local stacking context. */}
      {showAddDialog && (
        <AddPaletteDialog
          onSave={(p) => {
            if (readOnly) return;
            addPalette(p);
          }}
          onClose={() => setShowAddDialog(false)}
        />
      )}

      {/* Right-click context menu for deleting a custom palette. Built-in
          STYLE_COLORS swatches don't open this — only entries in
          customPalettes can be deleted (since they're the only ones the
          user created). */}
      {paletteCtxMenu && (
        <div
          ref={ctxMenuRef}
          className="sp-ctx-menu"
          style={{ left: paletteCtxMenu.x, top: paletteCtxMenu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div
            className={`sp-ctx-item sp-ctx-danger${readOnly ? " sp-ctx-item-disabled" : ""}`}
            onClick={readOnly ? undefined : (() => {
              removePalette(paletteCtxMenu.id);
              setPaletteCtxMenu(null);
            })}
          >
            {t("graph.style.removeTheme")}
          </div>
        </div>
      )}
    </div>
  );
}

/** Composite swatch: combines line + fill rect + point so the user sees
 *  exactly what the three sub-marks of this group will look like. */
function CompositeSwatch({ style }: { style: GroupStyle }) {
  const w = 36, h = 14;
  const cy = h / 2;
  const lineColor = style.line?.color ?? "#000";
  const lineWidth = style.line?.lineWidth ?? 1.5;
  const lineOpacity = style.line?.opacity ?? 1;
  const fillColor = style.fill?.color ?? "transparent";
  const fillOpacity = style.fill?.opacity ?? 1;
  const pointColor = style.point?.color ?? "#000";
  const pointFill = style.point?.fillColor ?? pointColor;
  const pointMarker: MarkerShape = style.point?.marker ?? "circle";
  const pointSize = style.point?.markerSize ?? 4;
  const pointOpacity = style.point?.opacity ?? 1;
  const r = Math.max(2, Math.min(5, pointSize / 2));
  const isHollow = pointMarker.startsWith("empty");
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
      {/* fill rect (left third) */}
      <rect x={2} y={3} width={8} height={8} fill={fillColor} fillOpacity={fillOpacity} stroke={lineColor} strokeWidth={lineWidth} strokeOpacity={lineOpacity} />
      {/* line (middle) */}
      <line x1={12} y1={cy} x2={24} y2={cy} stroke={lineColor} strokeWidth={lineWidth} opacity={lineOpacity} />
      {/* point (right) */}
      <circle cx={30} cy={cy} r={r} fill={isHollow ? "transparent" : pointFill} stroke={pointColor} strokeWidth={1} opacity={pointOpacity} />
    </svg>
  );
}

interface MarkEditorProps {
  title: string;
  mark: "line" | "fill" | "point" | "gradient";
  value: MarkStyle;
  effective: { color: string; lineWidth?: number; markerSize?: number; opacity?: number; marker?: MarkerShape };
  onChange: (patch: Partial<MarkStyle>) => void;
  fields: Array<"color" | "lineWidth" | "markerSize" | "marker" | "opacity">;
}

function MarkEditor({ title, mark, value, effective, onChange, fields }: MarkEditorProps) {
  const { t } = useTranslation();
  const palette = MARK_PALETTE[mark];
  return (
    <div className="gb-style-section">
      <div className="gb-style-section-title">{title}</div>
      {fields.includes("color") && (
        <div className="gb-style-row">
          <span className="gb-style-label">{t("graph.style.color")}</span>
          <div className="gb-style-color-row">
            {palette.map((c) => (
              <button
                key={c}
                className={`gb-style-color-swatch${(value.color ?? effective.color) === c ? " gb-style-color-selected" : ""}`}
                style={{ background: c }}
                title={c}
                onClick={() => onChange(mark === "fill" ? { color: c } : { color: c, fillColor: c })}
              />
            ))}
            <input
              type="color"
              className="gb-style-color-picker"
              value={value.color ?? effective.color}
              onChange={(e) => onChange(mark === "fill" ? { color: e.target.value } : { color: e.target.value, fillColor: e.target.value })}
              title={t("graph.style.color")}
            />
          </div>
        </div>
      )}
      {fields.includes("marker") && (
        <div className="gb-style-row">
          <span className="gb-style-label">{t("graph.style.marker")}</span>
          <select
            className="gb-style-select"
            value={value.marker ?? effective.marker ?? "circle"}
            onChange={(e) => onChange({ marker: e.target.value as MarkerShape })}
          >
            {MARKER_SHAPES.map((m) => (
              <option key={m} value={m}>{t(`graph.shape.${m}`)}</option>
            ))}
          </select>
        </div>
      )}
      {fields.includes("markerSize") && (
        <div className="gb-style-row">
          <span className="gb-style-label">{t("graph.style.markerSize")}</span>
          <input
            type="number"
            className="gb-style-number"
            min={1}
            max={32}
            step={1}
            value={value.markerSize ?? effective.markerSize ?? 4}
            onChange={(e) => onChange({ markerSize: Number(e.target.value) })}
          />
        </div>
      )}
      {fields.includes("lineWidth") && (
        <div className="gb-style-row">
          <span className="gb-style-label">{t("graph.style.lineWidth")}</span>
          <input
            type="number"
            className="gb-style-number"
            min={0}
            max={10}
            step={0.5}
            value={value.lineWidth ?? effective.lineWidth ?? 1.5}
            onChange={(e) => onChange({ lineWidth: Number(e.target.value) })}
          />
        </div>
      )}
      {fields.includes("opacity") && (
        <div className="gb-style-row">
          <span className="gb-style-label">{t("graph.style.opacity")}</span>
          <input
            type="range"
            className="gb-style-range"
            min={0}
            max={1}
            step={0.05}
            value={value.opacity ?? effective.opacity ?? 1}
            onChange={(e) => onChange({ opacity: Number(e.target.value) })}
          />
          <span className="gb-style-value">{Math.round((value.opacity ?? effective.opacity ?? 1) * 100)}%</span>
        </div>
      )}
    </div>
  );
}

const MARK_PALETTE: Record<"line" | "fill" | "point" | "gradient", string[]> = {
  line: LINE_PALETTE,
  fill: FILL_PALETTE,
  point: POINT_PALETTE,
  gradient: LINE_PALETTE,
};

const MARKER_SHAPES: MarkerShape[] = [
  "circle",
  "emptyCircle",
  "square",
  "emptySquare",
  "diamond",
  "emptyDiamond",
  "triangle",
  "emptyTriangle",
];
