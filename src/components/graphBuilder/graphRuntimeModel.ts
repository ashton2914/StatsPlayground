import { isMissing } from "@/graphCore/transform";
import {
  DEFAULT_GROUP_KEY,
  type BandRefLine,
  type ChartElement,
  type FieldRef,
  type GraphData,
  type GraphSpec,
  type GroupStyleMap,
  type RefLineStyle,
} from "@/graphCore/types";
import type { CustomPalette } from "@/stores/useGraphPaletteStore";
import type { ColumnDisplayProps, ColumnMeta } from "@/types/data";
import type { GraphDataFrame } from "@/types/graphData";
import type { GraphBuilderItem, GraphSlotKey, GroupThemeSlots } from "@/types/graphBuilder";

import { buildEffectiveGroupStyles, reconcileGroupThemeSlots } from "./graphThemeIdentity";

export interface GraphRuntimeMeltInfo {
  slot: "x" | "y";
  cols: FieldRef[];
  mode: "axis" | "merge";
  varField: FieldRef;
  valField: FieldRef;
}

export interface GraphRuntimeMetadata {
  columns: ColumnMeta[];
  displayProps: ColumnDisplayProps[];
}

const MELT_VAR = "__sp_variable__";
const MELT_VAL = "__sp_value__";
const SKIP_SPEC_ENCODING_KEYS = new Set<GraphSlotKey>(["size", "wrap"]);

export const STYLE_COLORS = [
  "#4a6cf7", "#ef8a3a", "#2ca678", "#e74c3c",
  "#9168d6", "#c4ad36", "#d56cb1", "#3aa6b9",
  "#5d8aa8", "#8c6e3a", "#b87333", "#7f8c8d",
];

export const SHADE_RATIO_POINT = -0.2;
export const SHADE_RATIO_LINE = 0;
export const SHADE_RATIO_FILL = 0.55;

export function shade(hex: string, ratio: number): string {
  if (!hex || ratio === 0) return hex;
  const match = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!match) return hex;
  const color = match[1];
  const red = parseInt(color.slice(0, 2), 16);
  const green = parseInt(color.slice(2, 4), 16);
  const blue = parseInt(color.slice(4, 6), 16);
  const mix = (channel: number) => (
    ratio < 0
      ? Math.round(channel * (1 + ratio))
      : Math.round(channel + (255 - channel) * ratio)
  );
  const clamp = (value: number) => Math.max(0, Math.min(255, value));
  const toHex = (value: number) => clamp(value).toString(16).padStart(2, "0");
  return `#${toHex(mix(red))}${toHex(mix(green))}${toHex(mix(blue))}`;
}

export const POINT_PALETTE = STYLE_COLORS.map((color) => shade(color, SHADE_RATIO_POINT));
export const LINE_PALETTE = STYLE_COLORS.map((color) => shade(color, SHADE_RATIO_LINE));
export const FILL_PALETTE = STYLE_COLORS.map((color) => shade(color, SHADE_RATIO_FILL));

function deriveMeltInfo(item: GraphBuilderItem): GraphRuntimeMeltInfo | null {
  if (item.mode !== "2d") return null;
  const multiX = item.modeStates.twoD.multiX ?? [];
  const multiY = item.modeStates.twoD.multiY ?? [];
  const xActive = multiX.length >= 2;
  const yActive = multiY.length >= 2;
  if (!xActive && !yActive) return null;
  const slot: "x" | "y" = xActive ? "x" : "y";
  const cols = slot === "x" ? multiX : multiY;
  const otherBound = slot === "x"
    ? !!item.modeStates.twoD.encoding.y
    : !!item.modeStates.twoD.encoding.x;
  return {
    slot,
    cols,
    mode: otherBound ? "merge" : "axis",
    varField: { name: MELT_VAR, type: "nominal" },
    valField: { name: MELT_VAL, type: "continuous" },
  };
}

function buildFinalElements(elements: ChartElement[], smootherLambda: number): ChartElement[] {
  return elements.map((element) => {
    if (element.kind !== "smoother") return element;
    const options = element.options ?? {};
    if (
      options.algo !== undefined
      || options.lambda !== undefined
      || options.windowFraction !== undefined
    ) {
      return element;
    }
    return { ...element, options: { ...options, lambda: smootherLambda } };
  });
}

function deriveSpecByColumn(metadata: GraphRuntimeMetadata): Record<string, { lsl?: number; target?: number; usl?: number }> {
  const specByColumn: Record<string, { lsl?: number; target?: number; usl?: number }> = {};
  for (const displayProps of metadata.displayProps) {
    const columnName = metadata.columns[displayProps.colIndex]?.colName;
    if (!columnName) continue;
    const extras = displayProps.extras as Record<string, unknown> | undefined;
    const specExtra = extras?.spec as { lsl?: unknown; target?: unknown; usl?: unknown } | undefined;
    if (!specExtra) continue;
    const spec: { lsl?: number; target?: number; usl?: number } = {};
    const lsl = Number(specExtra.lsl);
    const target = Number(specExtra.target);
    const usl = Number(specExtra.usl);
    if (Number.isFinite(lsl)) spec.lsl = lsl;
    if (Number.isFinite(target)) spec.target = target;
    if (Number.isFinite(usl)) spec.usl = usl;
    if (spec.lsl !== undefined || spec.target !== undefined || spec.usl !== undefined) {
      specByColumn[columnName] = spec;
    }
  }
  return specByColumn;
}

export function deriveValueOrders(
  metadata: GraphRuntimeMetadata,
  meltInfo?: GraphRuntimeMeltInfo | null,
): Record<string, string[]> {
  const valueOrders: Record<string, string[]> = {};
  for (const displayProps of metadata.displayProps) {
    const columnName = metadata.columns[displayProps.colIndex]?.colName;
    if (!columnName) continue;
    const extras = displayProps.extras as Record<string, unknown> | undefined;
    const values = (extras?.valueOrder as { values?: unknown } | undefined)?.values;
    if (Array.isArray(values) && values.length > 0) {
      valueOrders[columnName] = values.map((value) => String(value));
    }
  }
  if (meltInfo) {
    valueOrders[MELT_VAR] = meltInfo.cols.map((column) => column.name);
  }
  return valueOrders;
}

export function createGraphRuntimeData(
  columns: ColumnMeta[],
  meltInfo: GraphRuntimeMeltInfo | null,
): GraphData {
  const names = columns.map((column) => column.colName);
  if (!meltInfo) {
    return { columns: names, rows: [] };
  }
  const out = [...names];
  if (!out.includes(MELT_VAR)) out.push(MELT_VAR);
  if (!out.includes(MELT_VAL)) out.push(MELT_VAL);
  return { columns: out, rows: [] };
}

export function deriveGraphGroupKeys(
  overlayField: FieldRef | undefined,
  frame: GraphDataFrame | null,
): string[] {
  if (!overlayField) return [DEFAULT_GROUP_KEY];
  if (!frame) return [DEFAULT_GROUP_KEY];

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
    for (let index = 0; index < chunk.groupCodes.length; index += 1) {
      const code = Number(chunk.groupCodes[index]);
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

  return out.length > 0 ? out : [DEFAULT_GROUP_KEY];
}

export function buildEffectiveStyles(
  groupKeys: string[],
  slots: GroupThemeSlots | undefined,
  fieldName: string | undefined,
  userStyles: GroupStyleMap,
  customPalettes: readonly CustomPalette[],
  hasBoxplot: boolean,
  slotCandidateKeys: readonly string[] = groupKeys,
): GroupStyleMap {
  const resolvedSlots = reconcileGroupThemeSlots(slots, fieldName, slotCandidateKeys);
  return buildEffectiveGroupStyles(
    groupKeys,
    resolvedSlots,
    fieldName,
    userStyles,
    customPalettes,
    hasBoxplot,
  );
}

export function buildGraphRuntimeModel(
  item: GraphBuilderItem,
  metadata: GraphRuntimeMetadata,
): {
  effectiveEncoding: GraphSpec["encoding"];
  spec: GraphSpec;
  meltInfo: GraphRuntimeMeltInfo | null;
} {
  const isThreeDMode = item.mode === "3d";
  const isMultivariateMode = item.mode === "multivariate";
  const twoD = item.modeStates.twoD;
  const cartesianState = isThreeDMode ? item.modeStates.threeD : twoD;
  const encoding = cartesianState.encoding as Partial<Record<GraphSlotKey, FieldRef>>;
  const elements = isMultivariateMode
    ? [{ kind: "correlationMatrix", enabled: true, options: { correlationMethod: item.modeStates.multivariate.correlationMethod } } as ChartElement]
    : cartesianState.elements;
  const smootherLambda = cartesianState.smootherLambda;
  const groupStyles = cartesianState.groupStyles ?? {};
  const hiddenGroups = cartesianState.hiddenGroups ?? [];
  const refLinesY = twoD.refLinesY ?? [];
  const refLinesX = twoD.refLinesX ?? [];
  const specByColumn = deriveSpecByColumn(metadata);
  const meltInfo = deriveMeltInfo(item);

  const effectiveEncoding: GraphSpec["encoding"] = { ...encoding };
  if (meltInfo) {
    if (meltInfo.slot === "x") {
      if (meltInfo.mode === "axis") {
        effectiveEncoding.x = meltInfo.varField;
        effectiveEncoding.y = meltInfo.valField;
      } else {
        effectiveEncoding.x = meltInfo.valField;
      }
    } else if (meltInfo.mode === "axis") {
      effectiveEncoding.y = meltInfo.varField;
      effectiveEncoding.x = meltInfo.valField;
    } else {
      effectiveEncoding.y = meltInfo.valField;
    }
  }

  const finalElements = buildFinalElements(elements, smootherLambda);
  const specEncoding: GraphSpec["encoding"] = {};
  for (const key of Object.keys(effectiveEncoding) as GraphSlotKey[]) {
    if (SKIP_SPEC_ENCODING_KEYS.has(key)) continue;
    const value = effectiveEncoding[key];
    if (value) {
      specEncoding[key] = value;
    }
  }

  const legacyAutoSpec = twoD.autoSpecLines;
  const autoSpecOnY = !meltInfo && (twoD.autoSpecLinesY ?? legacyAutoSpec ?? false);
  const autoSpecOnX = !meltInfo && (twoD.autoSpecLinesX ?? legacyAutoSpec ?? false);
  const yName = effectiveEncoding.y?.name;
  const xName = effectiveEncoding.x?.name;
  const yLimits = autoSpecOnY && yName ? specByColumn[yName] : undefined;
  const xLimits = autoSpecOnX && xName ? specByColumn[xName] : undefined;
  const autoSpecY = yLimits ? { ...yLimits, colName: yName } : undefined;
  const autoSpecX = xLimits ? { ...xLimits, colName: xName } : undefined;

  const extraRefLinesY: GraphSpec["refLinesY"] = [];
  const extraRefLinesX: GraphSpec["refLinesX"] = [];
  const extraBandRefLines: BandRefLine[] = [];
  if (meltInfo) {
    const valueAxis: "x" | "y" = meltInfo.mode === "axis"
      ? (meltInfo.slot === "y" ? "x" : "y")
      : meltInfo.slot;
    const autoOn = valueAxis === "y"
      ? (twoD.autoSpecLinesY ?? legacyAutoSpec ?? false)
      : (twoD.autoSpecLinesX ?? legacyAutoSpec ?? false);
    if (autoOn) {
      let sequence = 0;
      if (meltInfo.mode === "axis") {
        const pushBand = (column: string, kind: "LSL" | "Target" | "USL", value: number) => {
          const color = kind === "Target" ? "#00C853" : "#E60000";
          extraBandRefLines.push({
            id: `auto-spec-band-${column}-${kind}-${++sequence}`,
            value,
            category: column,
            valueAxis,
            color,
            style: "dashed",
            width: 1,
          });
        };
        for (const column of meltInfo.cols) {
          const spec = specByColumn[column.name];
          if (!spec) continue;
          if (spec.lsl !== undefined) pushBand(column.name, "LSL", spec.lsl);
          if (spec.target !== undefined) pushBand(column.name, "Target", spec.target);
          if (spec.usl !== undefined) pushBand(column.name, "USL", spec.usl);
        }
      } else {
        const pushLine = (column: string, kind: "LSL" | "Target" | "USL", value: number) => {
          const color = kind === "Target" ? "#00C853" : "#E60000";
          const base = {
            id: `auto-spec-multi-${column}-${kind}-${++sequence}`,
            label: `${kind}[${column}] = ${Number(value.toPrecision(10))}`,
            style: "dashed" as RefLineStyle,
            color,
            width: 1,
          };
          if (valueAxis === "y") {
            extraRefLinesY.push({ ...base, y: value });
          } else {
            extraRefLinesX.push({ ...base, x: value });
          }
        };
        for (const column of meltInfo.cols) {
          const spec = specByColumn[column.name];
          if (!spec) continue;
          if (spec.lsl !== undefined) pushLine(column.name, "LSL", spec.lsl);
          if (spec.target !== undefined) pushLine(column.name, "Target", spec.target);
          if (spec.usl !== undefined) pushLine(column.name, "USL", spec.usl);
        }
      }
    }
  }

  return {
    effectiveEncoding,
    meltInfo,
    spec: {
      datasetId: item.sourceDatasetId,
      transpose: item.mode === "2d" && twoD.transposed === true,
      encoding: specEncoding,
      elements: finalElements,
      styles: groupStyles,
      hiddenGroups: hiddenGroups.length > 0 ? hiddenGroups : undefined,
      refLinesY: extraRefLinesY.length > 0 ? [...refLinesY, ...extraRefLinesY] : (refLinesY.length > 0 ? refLinesY : undefined),
      refLinesX: extraRefLinesX.length > 0 ? [...refLinesX, ...extraRefLinesX] : (refLinesX.length > 0 ? refLinesX : undefined),
      bandRefLines: extraBandRefLines.length > 0 ? extraBandRefLines : undefined,
      autoSpecY,
      autoSpecX,
      yAxis: twoD.yAxis,
      xAxis: twoD.xAxis,
      threeD: isThreeDMode,
    },
  };
}