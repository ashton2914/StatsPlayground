import type { GraphDataFrame } from "../types/graphData.ts";

export interface FrameTimeSeriesFacetSelector {
  facetX?: string;
  facetY?: string;
  wrap?: string;
}

export interface FrameTimeSeriesInput {
  frame: GraphDataFrame;
  yColumn: string;
  groupOrder: readonly string[];
  hiddenGroups: ReadonlySet<string>;
  missingValues: "break" | "connect";
  facet?: FrameTimeSeriesFacetSelector;
}

export interface FrameTimeSeriesSeries {
  stableId: string;
  name: string;
  groupCode: number | null;
  sourceCode: number | null;
  sourceColumn: string;
  data: Array<[number, number | null]>;
  rowIds: bigint[];
}

export interface FrameTimeSeriesResult {
  series: FrameTimeSeriesSeries[];
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

function matchesFacet(
  input: FrameTimeSeriesInput,
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

function seriesKey(groupCode: number | null, sourceCode: number | null, sourceColumn: string): string {
  return `g:${groupCode ?? "none"}|s:${sourceCode ?? "none"}|${sourceColumn}`;
}

export function buildFrameTimeSeries(input: FrameTimeSeriesInput): FrameTimeSeriesResult {
  const groupDictionary = input.frame.dictionaries.group ?? [];
  const sourceDictionary = input.frame.dictionaries.source ?? [];
  const grouped = input.groupOrder.length > 0;
  const allowedGroups = new Set(input.groupOrder);
  const seriesByKey = new Map<string, FrameTimeSeriesSeries>();
  const orderedSeries: FrameTimeSeriesSeries[] = [];

  for (const chunk of input.frame.rawChunks) {
    const groupCodes = uintRole(chunk, chunk.groupCodes, "group");
    const sourceCodes = uintRole(chunk, chunk.sourceCodes, "source");
    const rowCount = Math.min(
      chunk.rowCount,
      chunk.xValues.length,
      chunk.yValues.length,
      chunk.rowIds.length,
    );

    for (let row = 0; row < rowCount; row += 1) {
      if (!matchesFacet(input, chunk, row)) continue;
      if (!bitIsSet(chunk.validity.x, row)) continue;
      const x = Number(chunk.xValues[row]);
      if (!Number.isFinite(x)) continue;

      let groupCode: number | null = null;
      let groupName = "";
      if (grouped) {
        if (!groupCodes || !bitIsSet(chunk.validity.group, row)) continue;
        groupCode = groupCodes[row] >>> 0;
        groupName = groupDictionary[groupCode] ?? "";
        if (!allowedGroups.has(groupName)) continue;
        if (input.hiddenGroups.has(groupName)) continue;
      }

      let sourceCode: number | null = null;
      let sourceColumn = input.yColumn;
      if (sourceCodes && bitIsSet(chunk.validity.source, row)) {
        sourceCode = sourceCodes[row] >>> 0;
        sourceColumn = sourceDictionary[sourceCode] ?? input.yColumn;
      }

      const key = seriesKey(groupCode, sourceCode, sourceColumn);
      let series = seriesByKey.get(key);
      if (!series) {
        series = {
          stableId: key,
          name: grouped ? groupName : sourceColumn,
          groupCode,
          sourceCode,
          sourceColumn,
          data: [],
          rowIds: [],
        };
        seriesByKey.set(key, series);
        orderedSeries.push(series);
      }

      const yValid = bitIsSet(chunk.validity.y, row);
      const y = yValid ? Number(chunk.yValues[row]) : NaN;
      if (!Number.isFinite(y)) {
        if (input.missingValues === "break") {
          series.data.push([x, null]);
          series.rowIds.push(chunk.rowIds[row]);
        }
        continue;
      }

      series.data.push([x, y]);
      series.rowIds.push(chunk.rowIds[row]);
    }
  }

  return { series: orderedSeries };
}