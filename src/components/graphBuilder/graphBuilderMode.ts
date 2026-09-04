import type { ChartElement, FieldRef } from "@/graphCore";
import { getLayerMode } from "@/components/graphBuilder/graphLayerConfig";
import type {
  EmbeddedGraphConfig,
  Graph2DSlotKey,
  Graph2DState,
  Graph3DSlotKey,
  Graph3DState,
  GraphBuilderItem,
  GraphBuilderMode,
  GraphSlotKey,
  MultivariateGraphState,
} from "@/types/graphBuilder";
import type { GraphSampling } from "@/types/graphData";

const FULL_SAMPLING: GraphSampling = { mode: "full" };
const VALID_CORRELATION_METHODS = new Set(["pearson", "spearman", "kendall"]);
const MAX_MULTIVARIATE_COLUMNS = 20;

const SHARED_CARTESIAN_KEYS: GraphSlotKey[] = [
  "x",
  "y",
  "color",
  "size",
  "overlay",
  "groupX",
  "groupY",
  "wrap",
];

const THREE_D_ONLY_KEYS: GraphSlotKey[] = ["z", "groupZ"];

const TWO_D_KEYS: Graph2DSlotKey[] = [
  "x",
  "y",
  "color",
  "size",
  "overlay",
  "groupX",
  "groupY",
  "wrap",
];

const THREE_D_KEYS: Graph3DSlotKey[] = [
  "x",
  "y",
  "z",
  "color",
  "size",
  "overlay",
  "groupX",
  "groupY",
  "groupZ",
  "wrap",
];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function clone<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => clone(entry)) as T;
  }
  if (isObject(value)) {
    const next: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      next[key] = clone(entry);
    }
    return next as T;
  }
  return value;
}

export function createEmbeddedGraphItem(input: {
  id: string;
  name: string;
  sourceDatasetId: string;
  config: EmbeddedGraphConfig;
  createdAt: string;
}): GraphBuilderItem {
  return normalizeGraphBuilderItem({
    ...clone(input.config),
    id: input.id,
    name: input.name,
    sourceDatasetId: input.sourceDatasetId,
    createdAt: input.createdAt,
  });
}

function withOptional<T extends object, K extends string, V>(
  target: T,
  key: K,
  value: V | undefined,
): T & Partial<Record<K, V>> {
  if (value === undefined) return target;
  return { ...target, [key]: value };
}

function toStringOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function toFieldRefArray(value: unknown): FieldRef[] {
  if (!Array.isArray(value)) return [];
  const out: FieldRef[] = [];
  for (const entry of value) {
    if (!isObject(entry)) continue;
    if (typeof entry.name !== "string" || typeof entry.type !== "string") continue;
    out.push({
      ...(typeof entry.columnId === "string" ? { columnId: entry.columnId } : {}),
      name: entry.name,
      type: entry.type as FieldRef["type"],
    });
  }
  return out;
}

function canonicalizeMultivariateColumns(value: unknown): FieldRef[] {
  const fields = toFieldRefArray(value);
  const out: FieldRef[] = [];
  const seen = new Set<string>();
  for (const field of fields) {
    if (field.type !== "continuous") continue;
    if (seen.has(field.name)) continue;
    seen.add(field.name);
    out.push({ ...field, type: "continuous" });
    if (out.length >= MAX_MULTIVARIATE_COLUMNS) {
      break;
    }
  }
  return out;
}

function collapseSingleContinuousAxisField(
  baseEncoding: Partial<Graph2DState["encoding"]>,
  multiFields: FieldRef[],
  axis: "x" | "y",
): {
  encoding: Partial<Graph2DState["encoding"]>;
  multiFields: FieldRef[];
} {
  const continuousFields = multiFields.filter((field) => field.type === "continuous");
  if (continuousFields.length !== 1) {
    return { encoding: baseEncoding, multiFields };
  }
  return {
    encoding: {
      ...baseEncoding,
      [axis]: { ...continuousFields[0], type: "continuous" },
    },
    multiFields: [],
  };
}

function normalizeTwoDEncodingAndMultiAxes(
  encoding: Partial<Graph2DState["encoding"]>,
  multiXInput: unknown,
  multiYInput: unknown,
): Pick<Graph2DState, "encoding" | "multiX" | "multiY"> {
  const multiX = toFieldRefArray(multiXInput);
  const multiY = toFieldRefArray(multiYInput);

  const xCollapsed = collapseSingleContinuousAxisField(encoding, multiX, "x");
  const yCollapsed = collapseSingleContinuousAxisField(xCollapsed.encoding, multiY, "y");

  return {
    encoding: yCollapsed.encoding,
    multiX: xCollapsed.multiFields,
    multiY: yCollapsed.multiFields,
  };
}

function toElements(value: unknown): ChartElement[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry) => isObject(entry) && typeof entry.kind === "string").map((entry) => clone(entry as ChartElement));
}

function normalizeSampling(sampling: GraphSampling | undefined): GraphSampling {
  if (!sampling || sampling.mode === "full") {
    return FULL_SAMPLING;
  }
  const size = Math.trunc(sampling.size);
  const seed = Math.trunc(sampling.seed);
  if (!Number.isFinite(size) || size <= 0 || !Number.isFinite(seed) || seed < 0) {
    return FULL_SAMPLING;
  }
  return { mode: "sample", size, seed };
}

function pickEncoding<Slot extends string>(
  source: unknown,
  keys: readonly Slot[],
): Partial<Record<Slot, FieldRef>> {
  const out: Partial<Record<Slot, FieldRef>> = {};
  if (!isObject(source)) return out;
  for (const key of keys) {
    const value = source[key];
    if (!isObject(value)) continue;
    if (typeof value.name !== "string" || typeof value.type !== "string") continue;
    out[key] = {
      ...(typeof value.columnId === "string" ? { columnId: value.columnId } : {}),
      name: value.name,
      type: value.type as FieldRef["type"],
    };
  }
  return out;
}

function normalizeCorrelationMethod(value: unknown): MultivariateGraphState["correlationMethod"] {
  if (typeof value === "string" && VALID_CORRELATION_METHODS.has(value)) {
    return value as MultivariateGraphState["correlationMethod"];
  }
  return "pearson";
}

function hasCurrentModeShape(value: unknown): value is GraphBuilderItem {
  if (!isObject(value)) return false;
  if (value.mode !== "2d" && value.mode !== "3d" && value.mode !== "multivariate") return false;
  if (!isObject(value.modeStates)) return false;
  return isObject(value.modeStates.twoD)
    && isObject(value.modeStates.threeD)
    && isObject(value.modeStates.multivariate);
}

export function createDefaultGraph2DState(): Graph2DState {
  return {
    encoding: {},
    multiX: [],
    multiY: [],
    elements: [{ kind: "points", enabled: true }],
    smootherLambda: 0.4,
  };
}

export function createDefaultGraph3DState(): Graph3DState {
  return {
    encoding: {},
    elements: [{ kind: "scatter3d", enabled: true }],
    smootherLambda: 0.4,
  };
}

export function createDefaultMultivariateGraphState(): MultivariateGraphState {
  return {
    columns: [],
    chartType: "correlationMatrix",
    correlationMethod: "pearson",
  };
}

function normalizeCurrentModeItem(item: GraphBuilderItem): GraphBuilderItem {
  const twoDDefault = createDefaultGraph2DState();
  const threeDDefault = createDefaultGraph3DState();

  const twoDInput = item.modeStates.twoD as unknown as Record<string, unknown>;
  const threeDInput = item.modeStates.threeD as unknown as Record<string, unknown>;
  const multivariateInput = item.modeStates.multivariate as unknown as Record<string, unknown>;
  const normalizedTwoDAxes = normalizeTwoDEncodingAndMultiAxes(
    pickEncoding(twoDInput.encoding, TWO_D_KEYS),
    twoDInput.multiX,
    twoDInput.multiY,
  );

  const twoDCore: Graph2DState = {
    ...twoDDefault,
    encoding: normalizedTwoDAxes.encoding,
    ...(twoDInput.transposed === true ? { transposed: true } : {}),
    multiX: normalizedTwoDAxes.multiX,
    multiY: normalizedTwoDAxes.multiY,
    elements: toElements(twoDInput.elements).filter((element) => getLayerMode(element.kind) === "2d"),
    smootherLambda: typeof twoDInput.smootherLambda === "number" ? twoDInput.smootherLambda : twoDDefault.smootherLambda,
  };
  const twoDWithOpts = withOptional(
    withOptional(
      withOptional(
        withOptional(
          withOptional(
            withOptional(
              withOptional(
                withOptional(
                  withOptional(
                    withOptional(twoDCore, "groupStyles", isObject(twoDInput.groupStyles) ? clone(twoDInput.groupStyles) : undefined),
                    "hiddenGroups",
                    Array.isArray(twoDInput.hiddenGroups) ? twoDInput.hiddenGroups.filter((entry): entry is string => typeof entry === "string") : undefined,
                  ),
                  "refLinesY",
                  Array.isArray(twoDInput.refLinesY) ? clone(twoDInput.refLinesY) : undefined,
                ),
                "refLinesX",
                Array.isArray(twoDInput.refLinesX) ? clone(twoDInput.refLinesX) : undefined,
              ),
              "autoSpecLinesY",
              typeof twoDInput.autoSpecLinesY === "boolean" ? twoDInput.autoSpecLinesY : undefined,
            ),
            "autoSpecLinesX",
            typeof twoDInput.autoSpecLinesX === "boolean" ? twoDInput.autoSpecLinesX : undefined,
          ),
          "autoSpecLines",
          typeof twoDInput.autoSpecLines === "boolean" ? twoDInput.autoSpecLines : undefined,
        ),
        "yAxis",
        isObject(twoDInput.yAxis) ? clone(twoDInput.yAxis) : undefined,
      ),
      "xAxis",
      isObject(twoDInput.xAxis) ? clone(twoDInput.xAxis) : undefined,
    ),
    "elements",
    toElements(twoDInput.elements).filter((element) => getLayerMode(element.kind) === "2d"),
  );

  const threeDCore: Graph3DState = {
    ...threeDDefault,
    encoding: pickEncoding(threeDInput.encoding, THREE_D_KEYS),
    elements: toElements(threeDInput.elements).filter((element) => getLayerMode(element.kind) === "3d"),
    smootherLambda: typeof threeDInput.smootherLambda === "number" ? threeDInput.smootherLambda : threeDDefault.smootherLambda,
  };
  const threeDWithOpts = withOptional(
    withOptional(
      threeDCore,
      "groupStyles",
      isObject(threeDInput.groupStyles) ? clone(threeDInput.groupStyles) : undefined,
    ),
    "hiddenGroups",
    Array.isArray(threeDInput.hiddenGroups)
      ? threeDInput.hiddenGroups.filter((entry): entry is string => typeof entry === "string")
      : undefined,
  );

  return {
    id: item.id,
    name: item.name,
    sourceDatasetId: item.sourceDatasetId,
    mode: item.mode,
    modeStates: {
      twoD: twoDWithOpts,
      threeD: threeDWithOpts,
      multivariate: {
        columns: canonicalizeMultivariateColumns(multivariateInput.columns),
        chartType: "correlationMatrix",
        correlationMethod: normalizeCorrelationMethod(multivariateInput.correlationMethod),
      },
    },
    filters: Array.isArray(item.filters) ? clone(item.filters) : undefined,
    sampling: normalizeSampling(item.sampling),
    groupThemeSlots: isObject(item.groupThemeSlots) ? clone(item.groupThemeSlots) : undefined,
    createdAt: item.createdAt,
  };
}

export function normalizeGraphBuilderItem(item: unknown): GraphBuilderItem {
  if (hasCurrentModeShape(item)) {
    return normalizeCurrentModeItem(item);
  }

  const source = isObject(item) ? item : {};
  const twoD = createDefaultGraph2DState();
  const threeD = createDefaultGraph3DState();
  const multivariate = createDefaultMultivariateGraphState();

  const encoding = pickEncoding(source.encoding, [...SHARED_CARTESIAN_KEYS, ...THREE_D_ONLY_KEYS]);
  const elements = toElements(source.elements);
  const correlationElement = elements.find((element) => element.enabled !== false && element.kind === "correlationMatrix") as
    | (ChartElement & { correlationMethod?: unknown; options?: { correlationMethod?: unknown } })
    | undefined;

  if (correlationElement) {
    const multiX = canonicalizeMultivariateColumns(source.multiX);
    const multiY = canonicalizeMultivariateColumns(source.multiY);
    const methodFromOptions = isObject(correlationElement.options)
      ? correlationElement.options.correlationMethod
      : undefined;
    multivariate.columns = multiX.length > 0 ? multiX : multiY;
    multivariate.correlationMethod = normalizeCorrelationMethod(
      correlationElement.correlationMethod ?? methodFromOptions,
    );

    return {
      id: toStringOr(source.id, "graph-unknown"),
      name: toStringOr(source.name, "Graph"),
      sourceDatasetId: toStringOr(source.sourceDatasetId, ""),
      mode: "multivariate",
      modeStates: {
        twoD,
        threeD,
        multivariate,
      },
      filters: Array.isArray(source.filters) ? clone(source.filters) : undefined,
      sampling: normalizeSampling(source.sampling as GraphSampling | undefined),
      groupThemeSlots: isObject(source.groupThemeSlots)
        ? clone(source.groupThemeSlots) as GraphBuilderItem["groupThemeSlots"]
        : undefined,
      createdAt: toStringOr(source.createdAt, new Date(0).toISOString()),
    };
  }

  const shared2D = pickEncoding(encoding, SHARED_CARTESIAN_KEYS as unknown as Graph2DSlotKey[]);
  const shared3D = pickEncoding(encoding, SHARED_CARTESIAN_KEYS as unknown as Graph3DSlotKey[]);
  const only3D = pickEncoding(encoding, THREE_D_ONLY_KEYS as unknown as Graph3DSlotKey[]);
  const normalizedLegacyTwoDAxes = normalizeTwoDEncodingAndMultiAxes(
    { ...shared2D },
    source.multiX,
    source.multiY,
  );

  twoD.encoding = normalizedLegacyTwoDAxes.encoding;
  twoD.multiX = normalizedLegacyTwoDAxes.multiX;
  twoD.multiY = normalizedLegacyTwoDAxes.multiY;
  twoD.elements = elements.filter((element) => getLayerMode(element.kind) === "2d");
  twoD.smootherLambda = typeof source.smootherLambda === "number" ? source.smootherLambda : twoD.smootherLambda;
  const maybeGroupStyles = isObject(source.groupStyles) ? clone(source.groupStyles) : undefined;
  const maybeHiddenGroups = Array.isArray(source.hiddenGroups)
    ? source.hiddenGroups.filter((entry): entry is string => typeof entry === "string")
    : undefined;
  const maybeRefLinesY = Array.isArray(source.refLinesY) ? clone(source.refLinesY) : undefined;
  const maybeRefLinesX = Array.isArray(source.refLinesX) ? clone(source.refLinesX) : undefined;
  const maybeAutoSpecLinesY = typeof source.autoSpecLinesY === "boolean" ? source.autoSpecLinesY : undefined;
  const maybeAutoSpecLinesX = typeof source.autoSpecLinesX === "boolean" ? source.autoSpecLinesX : undefined;
  const maybeAutoSpecLines = typeof source.autoSpecLines === "boolean" ? source.autoSpecLines : undefined;
  const maybeYAxis = isObject(source.yAxis) ? clone(source.yAxis) : undefined;
  const maybeXAxis = isObject(source.xAxis) ? clone(source.xAxis) : undefined;
  Object.assign(twoD, withOptional({}, "groupStyles", maybeGroupStyles));
  Object.assign(twoD, withOptional({}, "hiddenGroups", maybeHiddenGroups));
  Object.assign(twoD, withOptional({}, "refLinesY", maybeRefLinesY));
  Object.assign(twoD, withOptional({}, "refLinesX", maybeRefLinesX));
  Object.assign(twoD, withOptional({}, "autoSpecLinesY", maybeAutoSpecLinesY));
  Object.assign(twoD, withOptional({}, "autoSpecLinesX", maybeAutoSpecLinesX));
  Object.assign(twoD, withOptional({}, "autoSpecLines", maybeAutoSpecLines));
  Object.assign(twoD, withOptional({}, "yAxis", maybeYAxis));
  Object.assign(twoD, withOptional({}, "xAxis", maybeXAxis));

  threeD.encoding = { ...shared3D, ...only3D };
  threeD.elements = elements.filter((element) => getLayerMode(element.kind) === "3d");
  threeD.smootherLambda = typeof source.smootherLambda === "number" ? source.smootherLambda : threeD.smootherLambda;
  Object.assign(threeD, withOptional({}, "groupStyles", maybeGroupStyles));
  Object.assign(threeD, withOptional({}, "hiddenGroups", maybeHiddenGroups));

  const mode: GraphBuilderMode = source.threeD === true ? "3d" : "2d";

  return {
    id: toStringOr(source.id, "graph-unknown"),
    name: toStringOr(source.name, "Graph"),
    sourceDatasetId: toStringOr(source.sourceDatasetId, ""),
    mode,
    modeStates: {
      twoD,
      threeD,
      multivariate,
    },
    filters: Array.isArray(source.filters) ? clone(source.filters) : undefined,
    sampling: normalizeSampling(source.sampling as GraphSampling | undefined),
    groupThemeSlots: isObject(source.groupThemeSlots)
      ? clone(source.groupThemeSlots) as GraphBuilderItem["groupThemeSlots"]
      : undefined,
    createdAt: toStringOr(source.createdAt, new Date(0).toISOString()),
  };
}
