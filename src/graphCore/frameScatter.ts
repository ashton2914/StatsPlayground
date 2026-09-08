import type { GraphDataFrame } from "../types/graphData.ts";
import {
  computeJitterOffsets,
  estimateJitterXBandwidth,
  type JitterGeometry,
  type JitterOptions,
  type JitterPoint,
} from "./jitter.ts";

export interface FrameFacetSelector {
  facetX?: string;
  facetY?: string;
  wrap?: string;
}

export interface FrameScatterInput {
  frame: GraphDataFrame;
  xCoordinate: {
    vector: "x" | "y" | "constant";
    type: "continuous" | "nominal" | "datetime";
    categories?: readonly string[];
    constant?: number | string;
  };
  yCoordinate: {
    vector: "x" | "y";
    column: string;
  };
  groupOrder: readonly string[];
  hiddenGroups: ReadonlySet<string>;
  facet?: FrameFacetSelector;
  jitter: JitterOptions;
  plotGeometry: Omit<JitterGeometry, "xBandwidth"> & {
    xMin?: number;
    xMax?: number;
  };
}

export interface FrameScatterItem {
  value: [number | string, number];
  symbolOffset: readonly [number, number];
  __pick?: { rowId: number; colName: string };
  sizeValue?: number;
}

export interface FrameScatterGroup {
  name: string;
  groupCode: number | null;
  items: FrameScatterItem[];
}

interface PendingItem {
  value: [number | string, number];
  rowId: bigint;
  colName: string;
  sizeValue?: number;
}

interface GeometryPoint {
  x: number | string;
  y: number;
}

function bitIsSet(bitmap: Uint8Array | undefined, rowIndex: number): boolean {
  if (!bitmap) return true;
  const byteIndex = rowIndex >> 3;
  if (byteIndex >= bitmap.length) return false;
  return (bitmap[byteIndex] & (1 << (rowIndex & 7))) !== 0;
}

function uintRole(
  chunk: GraphDataFrame["rawChunks"][number],
  direct: Uint32Array | undefined,
  role: string,
): Uint32Array | undefined {
  const fallback = chunk.roleVectors?.[role];
  return direct ?? (fallback instanceof Uint32Array ? fallback : undefined);
}

function floatRole(
  chunk: GraphDataFrame["rawChunks"][number],
  direct: Float64Array | undefined,
  role: string,
): Float64Array | undefined {
  const fallback = chunk.roleVectors?.[role];
  return direct ?? (fallback instanceof Float64Array ? fallback : undefined);
}

function matchesFacet(
  input: FrameScatterInput,
  chunk: GraphDataFrame["rawChunks"][number],
  row: number,
): boolean {
  const facet = input.facet;
  if (!facet) return true;

  const checks: Array<{
    expected: string | undefined;
    codes: Uint32Array | undefined;
    validity: Uint8Array | undefined;
    dictionary: readonly string[] | undefined;
  }> = [
    {
      expected: facet.facetX,
      codes: uintRole(chunk, chunk.facetXCodes, "groupX"),
      validity: chunk.validity.facetX,
      dictionary: input.frame.dictionaries.facetX,
    },
    {
      expected: facet.facetY,
      codes: uintRole(chunk, chunk.facetYCodes, "groupY"),
      validity: chunk.validity.facetY,
      dictionary: input.frame.dictionaries.facetY,
    },
    {
      expected: facet.wrap,
      codes: uintRole(chunk, chunk.wrapCodes, "wrap"),
      validity: chunk.validity.wrap,
      dictionary: input.frame.dictionaries.wrap,
    },
  ];

  for (const check of checks) {
    if (check.expected === undefined) continue;
    if (!check.codes || !bitIsSet(check.validity, row)) return false;
    if (check.dictionary?.[check.codes[row] >>> 0] !== check.expected) return false;
  }
  return true;
}

function decodeX(
  input: FrameScatterInput,
  chunk: GraphDataFrame["rawChunks"][number],
  row: number,
): number | string | null {
  if (input.xCoordinate.vector === "constant") {
    return input.xCoordinate.constant ?? "";
  }
  if (!bitIsSet(chunk.validity[input.xCoordinate.vector], row)) return null;
  const values = input.xCoordinate.vector === "x" ? chunk.xValues : chunk.yValues;
  const raw = Number(values[row]);
  if (!Number.isFinite(raw)) return null;
  if (input.xCoordinate.type === "continuous") return raw;

  const label = input.xCoordinate.categories?.[raw >>> 0];
  if (label === undefined) return null;
  if (input.xCoordinate.type === "nominal") return label;
  const timestamp = Date.parse(label);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function decodeY(
  input: FrameScatterInput,
  chunk: GraphDataFrame["rawChunks"][number],
  row: number,
): number | null {
  if (!bitIsSet(chunk.validity[input.yCoordinate.vector], row)) return null;
  const values = input.yCoordinate.vector === "x" ? chunk.xValues : chunk.yValues;
  const value = Number(values[row]);
  return Number.isFinite(value) ? value : null;
}

function safeRowId(rowId: bigint): number | null {
  const numeric = Number(rowId);
  return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : null;
}

function panelXBandwidth(
  input: FrameScatterInput,
  geometryPoints: readonly GeometryPoint[],
): number {
  const xValues = geometryPoints.map((point) => point.x);
  const axisExtent = Number.isFinite(input.plotGeometry.xMin)
    && Number.isFinite(input.plotGeometry.xMax)
    ? { min: input.plotGeometry.xMin!, max: input.plotGeometry.xMax! }
    : undefined;
  return estimateJitterXBandwidth(
    xValues,
    input.xCoordinate.type,
    input.plotGeometry.plotWidth,
    input.xCoordinate.categories?.length,
    axisExtent,
  );
}

export function buildFrameScatterItems(input: FrameScatterInput): FrameScatterGroup[] {
  const groupDictionary = input.frame.dictionaries.group ?? [];
  const grouped = input.groupOrder.length > 0;
  const orderedNames = grouped ? input.groupOrder : [""];
  const orderedNameSet = new Set(orderedNames);
  const groupCodeByName = new Map(groupDictionary.map((name, code) => [name, code]));
  const pendingByName = new Map<string, PendingItem[]>();
  const geometryPoints: GeometryPoint[] = [];

  for (const name of orderedNames) {
    if (!input.hiddenGroups.has(name)) pendingByName.set(name, []);
  }

  for (const chunk of input.frame.rawChunks) {
    const groupCodes = uintRole(chunk, chunk.groupCodes, "group");
    const sourceCodes = uintRole(chunk, chunk.sourceCodes, "source");
    const sizeValues = floatRole(chunk, chunk.sizeValues, "size");
    const rowCount = Math.min(
      chunk.rowCount,
      input.xCoordinate.vector === "y" ? chunk.yValues.length : chunk.xValues.length,
      input.yCoordinate.vector === "x" ? chunk.xValues.length : chunk.yValues.length,
      chunk.rowIds.length,
    );

    for (let row = 0; row < rowCount; row += 1) {
      if (!matchesFacet(input, chunk, row)) continue;
      const x = decodeX(input, chunk, row);
      const y = decodeY(input, chunk, row);
      if (x === null || y === null) continue;

      let groupName = "";
      if (grouped) {
        if (!groupCodes || !bitIsSet(chunk.validity.group, row)) continue;
        groupName = groupDictionary[groupCodes[row] >>> 0] ?? "";
        if (!groupName) continue;
      }
      if (!orderedNameSet.has(groupName)) continue;
      geometryPoints.push({ x, y });
      const pending = pendingByName.get(groupName);
      if (!pending) continue;

      let colName = input.yCoordinate.column;
      if (sourceCodes && bitIsSet(chunk.validity.source, row)) {
        colName = input.frame.dictionaries.source?.[sourceCodes[row] >>> 0] || colName;
      }

      const sizeValue = sizeValues && bitIsSet(chunk.validity.size, row)
        && Number.isFinite(sizeValues[row])
        ? sizeValues[row]
        : undefined;
      pending.push({
        value: [x, y],
        rowId: chunk.rowIds[row],
        colName,
        sizeValue,
      });
    }
  }

  const geometryYMin = geometryPoints.reduce(
    (minimum, point) => Math.min(minimum, point.y),
    Infinity,
  );
  const geometryYMax = geometryPoints.reduce(
    (maximum, point) => Math.max(maximum, point.y),
    -Infinity,
  );
  const jitterGeometry: JitterGeometry = {
    ...input.plotGeometry,
    xBandwidth: panelXBandwidth(input, geometryPoints),
    yMin: Number.isFinite(geometryYMin) ? geometryYMin : input.plotGeometry.yMin,
    yMax: Number.isFinite(geometryYMax) && geometryYMax !== geometryYMin
      ? geometryYMax
      : (Number.isFinite(geometryYMin) ? geometryYMin + 1 : input.plotGeometry.yMax),
  };
  const groups: FrameScatterGroup[] = [];
  for (const name of orderedNames) {
    const pending = pendingByName.get(name);
    if (!pending) continue;
    const jitterPoints: JitterPoint[] = pending.map((item) => ({
      x: item.value[0],
      y: item.value[1],
      rowId: item.rowId,
    }));
    const offsets = computeJitterOffsets(jitterPoints, input.jitter, jitterGeometry);
    groups.push({
      name,
      groupCode: grouped ? (groupCodeByName.get(name) ?? null) : null,
      items: pending.map((item, index) => {
        const rowId = safeRowId(item.rowId);
        return {
          value: item.value,
          symbolOffset: offsets[index],
          ...(rowId === null ? {} : { __pick: { rowId, colName: item.colName } }),
          ...(item.sizeValue === undefined ? {} : { sizeValue: item.sizeValue }),
        };
      }),
    });
  }
  return groups;
}