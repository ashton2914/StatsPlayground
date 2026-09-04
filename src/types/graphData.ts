import type { TableWindowFilter } from "./data";

export const DISTRIBUTION_GRAPH_ELEMENT_IDS = {
  overviewHistogram: "distribution.overview.histogram",
  overviewFittedCurves: "distribution.overview.fittedCurves",
  boxPlot: "distribution.boxPlot",
  ecdf: "distribution.ecdf",
  normalQuantilePoints: "distribution.normalQuantile.points",
  normalQuantileReference: "distribution.normalQuantile.reference",
  normalQuantileLower: "distribution.normalQuantile.lower",
  normalQuantileUpper: "distribution.normalQuantile.upper",
} as const;

export interface GraphFieldBinding {
  role: string;
  column: string;
}

export interface GraphElementRequest {
  kind: string;
  summaryStat: string;
  correlationMethod?: CorrelationMethod;
}

export type GraphSampling =
  | { mode: "full" }
  | { mode: "sample"; size: number; seed: number };

export interface GraphViewport {
  width: number;
  height: number;
}

export interface GraphDataRequest {
  requestId: string;
  datasetId: string;
  generation: number;
  fields: GraphFieldBinding[];
  filters: TableWindowFilter[];
  elements: GraphElementRequest[];
  sampling: GraphSampling;
  rawPointBudget: number;
  viewport: GraphViewport;
}

export type GraphPayloadType = "f64" | "u32" | "i64" | "u8";

export interface GraphTypedSliceDescriptor {
  type: GraphPayloadType;
  offset: number;
  byteLength: number;
}

export type GraphAxisEncoding = "numeric" | "categorical";

export interface GraphChunkHeader {
  requestId: string;
  generation: number;
  chunkIndex: number;
  rowOffset: number;
  rowCount: number;
  sourceRows: number;
  processedRows: number;
  dictionaries: Record<string, readonly string[]>;
  validityRanges: Record<string, GraphTypedSliceDescriptor>;
  xValues: GraphTypedSliceDescriptor;
  yValues: GraphTypedSliceDescriptor;
  rowIds: GraphTypedSliceDescriptor;
  zValues?: GraphTypedSliceDescriptor;
  groupCodes?: GraphTypedSliceDescriptor;
  sizeValues?: GraphTypedSliceDescriptor;
  sourceCodes?: GraphTypedSliceDescriptor;
  facetXCodes?: GraphTypedSliceDescriptor;
  facetYCodes?: GraphTypedSliceDescriptor;
  facetZCodes?: GraphTypedSliceDescriptor;
  wrapCodes?: GraphTypedSliceDescriptor;
  roleVectors?: Record<string, GraphTypedSliceDescriptor>;
  xEncoding: GraphAxisEncoding;
  finalChunk: boolean;
}

export interface GraphDataCompletion {
  requestId: string;
  datasetId: string;
  generation: number;
  sourceRows: number;
  processedRows: number;
  chunksSent: number;
  cancelled: boolean;
  rawPointDisposition: GraphRawPointDisposition;
}

export type GraphRawPointDisposition =
  | { status: "included"; validRows: number; budget: number }
  | { status: "empty"; validRows: 0; budget: number }
  | {
      status: "omitted";
      reason: "pointBudgetExceeded";
      validRows: number;
      budget: number;
    };

export interface GraphChunkMessage {
  header: GraphChunkHeader;
  payload: ArrayBuffer;
}

export interface HistogramBin {
  group?: string;
  category?: string;
  sourceColumn?: string;
  facetX?: string;
  facetY?: string;
  facetZ?: string;
  wrap?: string;
  binStart: number;
  binEnd: number;
  count: number;
}

export interface HistogramPacket {
  kind: "histogram";
  xColumn?: string;
  yColumn: string;
  groupColumn?: string;
  sourceColumn?: string;
  binCount: number;
  minValue?: number;
  maxValue?: number;
  missingCount: number;
  binWidth: number;
  totalCount: number;
  bins: HistogramBin[];
}

export interface HeatmapCell {
  group?: string;
  category?: string;
  sourceColumn?: string;
  facetX?: string;
  facetY?: string;
  facetZ?: string;
  wrap?: string;
  xBinIndex: number;
  yBinIndex: number;
  xBinStart: number;
  xBinEnd: number;
  yBinStart: number;
  yBinEnd: number;
  count: number;
}

export interface HeatmapPacket {
  kind: "heatmap";
  xColumn: string;
  yColumn: string;
  groupColumn?: string;
  sourceColumn?: string;
  xBinCount: number;
  yBinCount: number;
  xMin?: number;
  xMax?: number;
  yMin?: number;
  yMax?: number;
  missingCount: number;
  xBinWidth: number;
  yBinWidth: number;
  totalCount: number;
  cells: HeatmapCell[];
}

export interface BoxPlotOutlier {
  value: number;
  rowId?: number;
  sourceColumn?: string;
}

export interface BoxPlotEntry {
  group?: string;
  category?: string;
  sourceColumn?: string;
  facetX?: string;
  facetY?: string;
  facetZ?: string;
  wrap?: string;
  count: number;
  min: number;
  q1: number;
  median: number;
  q3: number;
  max: number;
  whiskerLow: number;
  whiskerHigh: number;
  outliers: BoxPlotOutlier[];
}

export interface BoxPlotPacket {
  kind: "boxPlot";
  xColumn?: string;
  yColumn: string;
  groupColumn?: string;
  sourceColumn?: string;
  entries: BoxPlotEntry[];
}

export interface PrecomputedPoint {
  x: number;
  y: number;
  label?: string;
  group?: string;
}

export interface PrecomputedPointPacket {
  kind: "precomputedPoints";
  elementId: string;
  seriesId?: string;
  seriesName?: string;
  points: PrecomputedPoint[];
}

export type PrecomputedCurveInterpolation = "linear" | "stepEnd";

export interface PrecomputedCurvePoint {
  x: number;
  y: number;
}

export interface PrecomputedCurvePacket {
  kind: "precomputedCurve";
  elementId: string;
  seriesId?: string;
  seriesName?: string;
  interpolation: PrecomputedCurveInterpolation;
  points: PrecomputedCurvePoint[];
}

export interface SummaryEntry {
  group?: string;
  category?: string;
  sourceColumn?: string;
  facetX?: string;
  facetY?: string;
  facetZ?: string;
  wrap?: string;
  count: number;
  mean: number;
  median: number;
  stddev: number;
  min: number;
  max: number;
  intervalLow?: number;
  intervalHigh?: number;
}

export interface SummaryPacket {
  kind: "summary";
  xColumn?: string;
  yColumn: string;
  groupColumn?: string;
  sourceColumn?: string;
  summaries: SummaryEntry[];
}

export type CorrelationMethod = "pearson" | "spearman" | "kendall";

export type CorrelationUnavailableReason = "insufficientData" | "zeroVariance";

export interface CorrelationMatrixCell {
  xIndex: number;
  yIndex: number;
  coefficient?: number | null;
  sampleCount: number;
  unavailableReason?: CorrelationUnavailableReason;
}

export interface CorrelationMatrixPacket {
  kind: "correlationMatrix";
  method: CorrelationMethod;
  columns: string[];
  cells: CorrelationMatrixCell[];
}

export type GraphAggregatePacket =
  | HistogramPacket
  | HeatmapPacket
  | BoxPlotPacket
  | SummaryPacket
  | CorrelationMatrixPacket
  | PrecomputedPointPacket
  | PrecomputedCurvePacket;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function isCorrelationMethod(value: unknown): value is CorrelationMethod {
  return value === "pearson" || value === "spearman" || value === "kendall";
}

function isCorrelationUnavailableReason(value: unknown): value is CorrelationUnavailableReason {
  return value === "insufficientData" || value === "zeroVariance";
}

function isPrecomputedCurveInterpolation(value: unknown): value is PrecomputedCurveInterpolation {
  return value === "linear" || value === "stepEnd";
}

function isPrecomputedPoint(value: unknown): value is PrecomputedPoint {
  if (!isRecord(value)) return false;
  return isFiniteNumber(value.x)
    && isFiniteNumber(value.y)
    && isOptionalString(value.label)
    && isOptionalString(value.group);
}

function isPrecomputedCurvePoint(value: unknown): value is PrecomputedCurvePoint {
  if (!isRecord(value)) return false;
  return isFiniteNumber(value.x) && isFiniteNumber(value.y);
}

function isHistogramBin(value: unknown): value is HistogramBin {
  if (!isRecord(value)) return false;
  return isOptionalString(value.group)
    && isOptionalString(value.category)
    && isOptionalString(value.sourceColumn)
    && isOptionalString(value.facetX)
    && isOptionalString(value.facetY)
    && isOptionalString(value.facetZ)
    && isOptionalString(value.wrap)
    && isFiniteNumber(value.binStart)
    && isFiniteNumber(value.binEnd)
    && isNonNegativeInteger(value.count);
}

function isHeatmapCell(value: unknown): value is HeatmapCell {
  if (!isRecord(value)) return false;
  return isOptionalString(value.group)
    && isOptionalString(value.category)
    && isOptionalString(value.sourceColumn)
    && isOptionalString(value.facetX)
    && isOptionalString(value.facetY)
    && isOptionalString(value.facetZ)
    && isOptionalString(value.wrap)
    && Number.isInteger(value.xBinIndex)
    && Number.isInteger(value.yBinIndex)
    && isFiniteNumber(value.xBinStart)
    && isFiniteNumber(value.xBinEnd)
    && isFiniteNumber(value.yBinStart)
    && isFiniteNumber(value.yBinEnd)
    && isNonNegativeInteger(value.count);
}

function isBoxPlotOutlier(value: unknown): value is BoxPlotOutlier {
  if (!isRecord(value)) return false;
  return isFiniteNumber(value.value)
    && (value.rowId === undefined || Number.isInteger(value.rowId))
    && isOptionalString(value.sourceColumn);
}

function isBoxPlotEntry(value: unknown): value is BoxPlotEntry {
  if (!isRecord(value)) return false;
  return isOptionalString(value.group)
    && isOptionalString(value.category)
    && isOptionalString(value.sourceColumn)
    && isOptionalString(value.facetX)
    && isOptionalString(value.facetY)
    && isOptionalString(value.facetZ)
    && isOptionalString(value.wrap)
    && isNonNegativeInteger(value.count)
    && isFiniteNumber(value.min)
    && isFiniteNumber(value.q1)
    && isFiniteNumber(value.median)
    && isFiniteNumber(value.q3)
    && isFiniteNumber(value.max)
    && isFiniteNumber(value.whiskerLow)
    && isFiniteNumber(value.whiskerHigh)
    && Array.isArray(value.outliers)
    && value.outliers.every(isBoxPlotOutlier);
}

function isSummaryEntry(value: unknown): value is SummaryEntry {
  if (!isRecord(value)) return false;
  return isOptionalString(value.group)
    && isOptionalString(value.category)
    && isOptionalString(value.sourceColumn)
    && isOptionalString(value.facetX)
    && isOptionalString(value.facetY)
    && isOptionalString(value.facetZ)
    && isOptionalString(value.wrap)
    && isNonNegativeInteger(value.count)
    && isFiniteNumber(value.mean)
    && isFiniteNumber(value.median)
    && isFiniteNumber(value.stddev)
    && isFiniteNumber(value.min)
    && isFiniteNumber(value.max)
    && (value.intervalLow === undefined || isFiniteNumber(value.intervalLow))
    && (value.intervalHigh === undefined || isFiniteNumber(value.intervalHigh));
}

function isCorrelationMatrixPacket(value: unknown): value is CorrelationMatrixPacket {
  if (!isRecord(value)) {
    return false;
  }
  if (!isCorrelationMethod(value.method)) {
    return false;
  }
  if (!Array.isArray(value.columns) || value.columns.length < 2 || value.columns.length > 20) {
    return false;
  }

  const seenColumns = new Set<string>();
  for (const column of value.columns) {
    if (!isString(column) || column.trim().length === 0 || seenColumns.has(column)) {
      return false;
    }
    seenColumns.add(column);
  }

  if (!Array.isArray(value.cells)) {
    return false;
  }

  const columnCount = value.columns.length;
  if (value.cells.length !== columnCount ** 2) {
    return false;
  }

  for (let index = 0; index < value.cells.length; index += 1) {
    const cell = value.cells[index];
    if (!isRecord(cell)) {
      return false;
    }

    const expectedXIndex = index % columnCount;
    const expectedYIndex = Math.floor(index / columnCount);
    if (cell.xIndex !== expectedXIndex || cell.yIndex !== expectedYIndex) {
      return false;
    }
    if (!isNonNegativeInteger(cell.xIndex) || !isNonNegativeInteger(cell.yIndex)) {
      return false;
    }
    if (!isNonNegativeInteger(cell.sampleCount)) {
      return false;
    }

    const coefficientIsMissing = cell.coefficient === undefined || cell.coefficient === null;
    if (coefficientIsMissing) {
      if (!isCorrelationUnavailableReason(cell.unavailableReason)) {
        return false;
      }
      continue;
    }

    if (!isFiniteNumber(cell.coefficient) || cell.coefficient < -1 || cell.coefficient > 1) {
      return false;
    }
    if (cell.unavailableReason !== undefined) {
      return false;
    }
  }

  return true;
}

export function isGraphAggregatePacket(value: unknown): value is GraphAggregatePacket {
  if (!isRecord(value) || !isString(value.kind)) {
    return false;
  }
  if (value.kind === "precomputedPoints") {
    return isNonEmptyString(value.elementId)
      && (value.seriesId === undefined || isNonEmptyString(value.seriesId))
      && (value.seriesName === undefined || isNonEmptyString(value.seriesName))
      && Array.isArray(value.points)
      && value.points.every(isPrecomputedPoint);
  }
  if (value.kind === "precomputedCurve") {
    return isNonEmptyString(value.elementId)
      && (value.seriesId === undefined || isNonEmptyString(value.seriesId))
      && (value.seriesName === undefined || isNonEmptyString(value.seriesName))
      && isPrecomputedCurveInterpolation(value.interpolation)
      && Array.isArray(value.points)
      && value.points.every(isPrecomputedCurvePoint);
  }
  if (value.kind === "histogram") {
    return isOptionalString(value.xColumn)
      && isString(value.yColumn)
      && isOptionalString(value.groupColumn)
      && isOptionalString(value.sourceColumn)
      && isNonNegativeInteger(value.binCount)
      && (value.minValue === undefined || isFiniteNumber(value.minValue))
      && (value.maxValue === undefined || isFiniteNumber(value.maxValue))
      && isNonNegativeInteger(value.missingCount)
      && isFiniteNumber(value.binWidth)
      && isNonNegativeInteger(value.totalCount)
      && Array.isArray(value.bins)
      && value.bins.every(isHistogramBin);
  }
  if (value.kind === "heatmap") {
    return isString(value.xColumn)
      && isString(value.yColumn)
      && isOptionalString(value.groupColumn)
      && isOptionalString(value.sourceColumn)
      && isNonNegativeInteger(value.xBinCount)
      && isNonNegativeInteger(value.yBinCount)
      && (value.xMin === undefined || isFiniteNumber(value.xMin))
      && (value.xMax === undefined || isFiniteNumber(value.xMax))
      && (value.yMin === undefined || isFiniteNumber(value.yMin))
      && (value.yMax === undefined || isFiniteNumber(value.yMax))
      && isNonNegativeInteger(value.missingCount)
      && isFiniteNumber(value.xBinWidth)
      && isFiniteNumber(value.yBinWidth)
      && isNonNegativeInteger(value.totalCount)
      && Array.isArray(value.cells)
      && value.cells.every(isHeatmapCell);
  }
  if (value.kind === "boxPlot") {
    return isOptionalString(value.xColumn)
      && isString(value.yColumn)
      && isOptionalString(value.groupColumn)
      && isOptionalString(value.sourceColumn)
      && Array.isArray(value.entries)
      && value.entries.every(isBoxPlotEntry);
  }
  if (value.kind === "summary") {
    return isOptionalString(value.xColumn)
      && isString(value.yColumn)
      && isOptionalString(value.groupColumn)
      && isOptionalString(value.sourceColumn)
      && Array.isArray(value.summaries)
      && value.summaries.every(isSummaryEntry);
  }
  if (value.kind === "correlationMatrix") {
    return isCorrelationMatrixPacket(value);
  }
  return false;
}

export interface DecodedRawPointChunk {
  chunkIndex: number;
  rowOffset: number;
  rowCount: number;
  xValues: Float64Array | Uint32Array;
  yValues: Float64Array;
  rowIds: BigInt64Array;
  zValues?: Float64Array;
  groupCodes?: Uint32Array;
  sizeValues?: Float64Array;
  sourceCodes?: Uint32Array;
  facetXCodes?: Uint32Array;
  facetYCodes?: Uint32Array;
  facetZCodes?: Uint32Array;
  wrapCodes?: Uint32Array;
  roleVectors?: Record<string, Float64Array | Uint32Array | BigInt64Array | Uint8Array>;
  validity: Record<string, Uint8Array>;
}

export interface GraphDataFrame {
  requestId: string;
  datasetId: string;
  generation: number;
  sourceRows: number;
  processedRows: number;
  sampling: GraphSampling;
  dictionaries: Record<string, readonly string[]>;
  extents: Record<string, { min: number; max: number }>;
  rawChunks: readonly DecodedRawPointChunk[];
  aggregates: readonly GraphAggregatePacket[];
  rawPointDisposition: GraphRawPointDisposition;
}

export interface DecodedGraphChunk extends DecodedRawPointChunk {
  requestId: string;
  generation: number;
  sourceRows: number;
  processedRows: number;
  dictionaries: Record<string, readonly string[]>;
  xEncoding: GraphAxisEncoding;
  finalChunk: boolean;
}

export class GraphPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraphPayloadError";
  }
}

const TYPE_WIDTH: Record<GraphPayloadType, number> = {
  f64: 8,
  u32: 4,
  i64: 8,
  u8: 1,
};

function validateDescriptor(
  descriptor: GraphTypedSliceDescriptor,
  label: string,
  payloadLength: number,
): [start: number, end: number] {
  if (!Number.isInteger(descriptor.offset) || descriptor.offset < 0) {
    throw new GraphPayloadError(`${label} offset must be a non-negative integer`);
  }
  if (!Number.isInteger(descriptor.byteLength) || descriptor.byteLength < 0) {
    throw new GraphPayloadError(`${label} byteLength must be a non-negative integer`);
  }
  if (descriptor.offset % 8 !== 0) {
    throw new GraphPayloadError(`${label} offset ${descriptor.offset} is not 8-byte aligned`);
  }

  const width = TYPE_WIDTH[descriptor.type];
  if (descriptor.offset % width !== 0) {
    throw new GraphPayloadError(`${label} offset ${descriptor.offset} is misaligned for ${descriptor.type}`);
  }
  if (descriptor.byteLength % width !== 0) {
    throw new GraphPayloadError(`${label} byteLength ${descriptor.byteLength} is invalid for ${descriptor.type}`);
  }

  const end = descriptor.offset + descriptor.byteLength;
  if (!Number.isSafeInteger(end) || end > payloadLength) {
    throw new GraphPayloadError(`${label} range exceeds payload length`);
  }

  return [descriptor.offset, end];
}

function assertType(
  descriptor: GraphTypedSliceDescriptor,
  expected: GraphPayloadType | readonly GraphPayloadType[],
  label: string,
): void {
  const allowed = Array.isArray(expected) ? expected : [expected];
  if (!allowed.includes(descriptor.type)) {
    throw new GraphPayloadError(`${label} expected ${allowed.join("|")} but got ${descriptor.type}`);
  }
}

function descriptorElementCount(descriptor: GraphTypedSliceDescriptor): number {
  return descriptor.byteLength / TYPE_WIDTH[descriptor.type];
}

function assertRowVectorCardinality(
  descriptor: GraphTypedSliceDescriptor,
  rowCount: number,
  label: string,
): void {
  const elementCount = descriptorElementCount(descriptor);
  if (elementCount !== rowCount) {
    throw new GraphPayloadError(
      `${label} element count ${elementCount} must equal rowCount ${rowCount}`,
    );
  }
}

export function decodeGraphPayload(
  header: GraphChunkHeader,
  payload: ArrayBuffer,
): DecodedGraphChunk {
  if (!Number.isInteger(header.rowCount) || header.rowCount < 0) {
    throw new GraphPayloadError("rowCount must be a non-negative integer");
  }

  assertType(header.xValues, ["f64", "u32"], "xValues");
  assertType(header.yValues, "f64", "yValues");
  assertType(header.rowIds, "i64", "rowIds");

  if (header.groupCodes) {
    assertType(header.groupCodes, "u32", "groupCodes");
  }
  if (header.zValues) {
    assertType(header.zValues, "f64", "zValues");
  }
  if (header.sizeValues) {
    assertType(header.sizeValues, "f64", "sizeValues");
  }
  if (header.sourceCodes) {
    assertType(header.sourceCodes, "u32", "sourceCodes");
  }
  if (header.facetXCodes) {
    assertType(header.facetXCodes, "u32", "facetXCodes");
  }
  if (header.facetYCodes) {
    assertType(header.facetYCodes, "u32", "facetYCodes");
  }
  if (header.facetZCodes) {
    assertType(header.facetZCodes, "u32", "facetZCodes");
  }
  if (header.wrapCodes) {
    assertType(header.wrapCodes, "u32", "wrapCodes");
  }
  if (header.roleVectors) {
    for (const [roleKey, descriptor] of Object.entries(header.roleVectors)) {
      assertType(descriptor, ["f64", "u32", "i64", "u8"], `roleVectors.${roleKey}`);
    }
  }

  const resolveRoleDescriptor = (
    roleKey: string,
    legacy: GraphTypedSliceDescriptor | undefined,
  ): GraphTypedSliceDescriptor | undefined => {
    const descriptor = header.roleVectors?.[roleKey] ?? legacy;
    return descriptor;
  };

  const zDescriptor = resolveRoleDescriptor("z", header.zValues);
  const groupDescriptor = resolveRoleDescriptor("group", header.groupCodes);
  const sizeDescriptor = resolveRoleDescriptor("size", header.sizeValues);
  const sourceDescriptor = resolveRoleDescriptor("source", header.sourceCodes);
  const facetXDescriptor = resolveRoleDescriptor("groupX", header.facetXCodes);
  const facetYDescriptor = resolveRoleDescriptor("groupY", header.facetYCodes);
  const facetZDescriptor = resolveRoleDescriptor("groupZ", header.facetZCodes);
  const wrapDescriptor = resolveRoleDescriptor("wrap", header.wrapCodes);

  if (zDescriptor) {
    assertType(zDescriptor, "f64", "zValues");
  }
  if (groupDescriptor) {
    assertType(groupDescriptor, "u32", "groupCodes");
  }
  if (sizeDescriptor) {
    assertType(sizeDescriptor, "f64", "sizeValues");
  }
  if (sourceDescriptor) {
    assertType(sourceDescriptor, "u32", "sourceCodes");
  }
  if (facetXDescriptor) {
    assertType(facetXDescriptor, "u32", "facetXCodes");
  }
  if (facetYDescriptor) {
    assertType(facetYDescriptor, "u32", "facetYCodes");
  }
  if (facetZDescriptor) {
    assertType(facetZDescriptor, "u32", "facetZCodes");
  }
  if (wrapDescriptor) {
    assertType(wrapDescriptor, "u32", "wrapCodes");
  }

  const ranges: Array<{ start: number; end: number; label: string }> = [];
  const payloadLength = payload.byteLength;

  const register = (descriptor: GraphTypedSliceDescriptor, label: string): void => {
    const [start, end] = validateDescriptor(descriptor, label, payloadLength);
    ranges.push({ start, end, label });
  };

  register(header.xValues, "xValues");
  register(header.yValues, "yValues");
  register(header.rowIds, "rowIds");
  if (zDescriptor) {
    register(zDescriptor, "zValues");
  }
  if (groupDescriptor) {
    register(groupDescriptor, "groupCodes");
  }
  if (sizeDescriptor) {
    register(sizeDescriptor, "sizeValues");
  }
  if (sourceDescriptor) {
    register(sourceDescriptor, "sourceCodes");
  }
  if (facetXDescriptor) {
    register(facetXDescriptor, "facetXCodes");
  }
  if (facetYDescriptor) {
    register(facetYDescriptor, "facetYCodes");
  }
  if (facetZDescriptor) {
    register(facetZDescriptor, "facetZCodes");
  }
  if (wrapDescriptor) {
    register(wrapDescriptor, "wrapCodes");
  }

  for (const [key, descriptor] of Object.entries(header.validityRanges)) {
    assertType(descriptor, "u8", `validityRanges.${key}`);
    register(descriptor, `validityRanges.${key}`);
  }

  ranges.sort((a, b) => a.start - b.start);
  for (let index = 1; index < ranges.length; index += 1) {
    const previous = ranges[index - 1];
    const current = ranges[index];
    if (previous.end > current.start) {
      throw new GraphPayloadError(
        `slice overlap between ${previous.label} and ${current.label}`,
      );
    }
  }

  assertRowVectorCardinality(header.xValues, header.rowCount, "xValues");
  assertRowVectorCardinality(header.yValues, header.rowCount, "yValues");
  assertRowVectorCardinality(header.rowIds, header.rowCount, "rowIds");
  if (groupDescriptor) {
    assertRowVectorCardinality(groupDescriptor, header.rowCount, "groupCodes");
  }
  if (zDescriptor) {
    assertRowVectorCardinality(zDescriptor, header.rowCount, "zValues");
  }
  if (sizeDescriptor) {
    assertRowVectorCardinality(sizeDescriptor, header.rowCount, "sizeValues");
  }
  if (sourceDescriptor) {
    assertRowVectorCardinality(sourceDescriptor, header.rowCount, "sourceCodes");
  }
  if (facetXDescriptor) {
    assertRowVectorCardinality(facetXDescriptor, header.rowCount, "facetXCodes");
  }
  if (facetYDescriptor) {
    assertRowVectorCardinality(facetYDescriptor, header.rowCount, "facetYCodes");
  }
  if (facetZDescriptor) {
    assertRowVectorCardinality(facetZDescriptor, header.rowCount, "facetZCodes");
  }
  if (wrapDescriptor) {
    assertRowVectorCardinality(wrapDescriptor, header.rowCount, "wrapCodes");
  }

  const expectedValidityBytes = Math.ceil(header.rowCount / 8);
  for (const [key, descriptor] of Object.entries(header.validityRanges)) {
    if (descriptor.byteLength !== expectedValidityBytes) {
      throw new GraphPayloadError(
        `validityRanges.${key} byteLength ${descriptor.byteLength} must equal ${expectedValidityBytes} for rowCount ${header.rowCount}`,
      );
    }
  }

  const xValues =
    header.xValues.type === "f64"
      ? new Float64Array(payload, header.xValues.offset, header.xValues.byteLength / 8)
      : new Uint32Array(payload, header.xValues.offset, header.xValues.byteLength / 4);
  const yValues = new Float64Array(payload, header.yValues.offset, header.yValues.byteLength / 8);
  const rowIds = new BigInt64Array(payload, header.rowIds.offset, header.rowIds.byteLength / 8);
  const zValues = zDescriptor
    ? new Float64Array(payload, zDescriptor.offset, zDescriptor.byteLength / 8)
    : undefined;
  const groupCodes = groupDescriptor
    ? new Uint32Array(payload, groupDescriptor.offset, groupDescriptor.byteLength / 4)
    : undefined;
  const sizeValues = sizeDescriptor
    ? new Float64Array(payload, sizeDescriptor.offset, sizeDescriptor.byteLength / 8)
    : undefined;
  const sourceCodes = sourceDescriptor
    ? new Uint32Array(payload, sourceDescriptor.offset, sourceDescriptor.byteLength / 4)
    : undefined;
  const facetXCodes = facetXDescriptor
    ? new Uint32Array(payload, facetXDescriptor.offset, facetXDescriptor.byteLength / 4)
    : undefined;
  const facetYCodes = facetYDescriptor
    ? new Uint32Array(payload, facetYDescriptor.offset, facetYDescriptor.byteLength / 4)
    : undefined;
  const facetZCodes = facetZDescriptor
    ? new Uint32Array(payload, facetZDescriptor.offset, facetZDescriptor.byteLength / 4)
    : undefined;
  const wrapCodes = wrapDescriptor
    ? new Uint32Array(payload, wrapDescriptor.offset, wrapDescriptor.byteLength / 4)
    : undefined;

  const roleVectors: Record<string, Float64Array | Uint32Array | BigInt64Array | Uint8Array> = {};
  if (header.roleVectors) {
    for (const [roleKey, descriptor] of Object.entries(header.roleVectors)) {
      if (descriptor.type === "f64") {
        roleVectors[roleKey] = new Float64Array(payload, descriptor.offset, descriptor.byteLength / 8);
      } else if (descriptor.type === "u32") {
        roleVectors[roleKey] = new Uint32Array(payload, descriptor.offset, descriptor.byteLength / 4);
      } else if (descriptor.type === "i64") {
        roleVectors[roleKey] = new BigInt64Array(payload, descriptor.offset, descriptor.byteLength / 8);
      } else {
        roleVectors[roleKey] = new Uint8Array(payload, descriptor.offset, descriptor.byteLength);
      }
    }
  }

  const validity: Record<string, Uint8Array> = {};
  for (const [key, descriptor] of Object.entries(header.validityRanges)) {
    validity[key] = new Uint8Array(payload, descriptor.offset, descriptor.byteLength);
  }

  return {
    requestId: header.requestId,
    generation: header.generation,
    chunkIndex: header.chunkIndex,
    rowOffset: header.rowOffset,
    rowCount: header.rowCount,
    sourceRows: header.sourceRows,
    processedRows: header.processedRows,
    dictionaries: header.dictionaries,
    xEncoding: header.xEncoding,
    finalChunk: header.finalChunk,
    xValues,
    yValues,
    rowIds,
    zValues,
    groupCodes,
    sizeValues,
    sourceCodes,
    facetXCodes,
    facetYCodes,
    facetZCodes,
    wrapCodes,
    roleVectors: Object.keys(roleVectors).length > 0 ? roleVectors : undefined,
    validity,
  };
}