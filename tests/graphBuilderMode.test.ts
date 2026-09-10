import assert from "node:assert/strict";

import {
  createDefaultGraph2DState,
  createDefaultGraph3DState,
  createDefaultMultivariateGraphState,
  normalizeGraphBuilderItem,
} from "../src/components/graphBuilder/graphBuilderMode.ts";
import { getLayerMode } from "../src/components/graphBuilder/graphLayerConfig.ts";

import type { GraphBuilderItem } from "../src/types/graphBuilder.ts";

const continuous = (name: string) => ({ name, type: "continuous" as const });
const nominal = (name: string) => ({ name, type: "nominal" as const });

const legacyBase = {
  id: "legacy-1",
  name: "Legacy",
  sourceDatasetId: "dataset-1",
  encoding: {
    x: continuous("x"),
    y: continuous("y"),
    z: continuous("z"),
    color: nominal("color"),
    groupX: nominal("gx"),
    groupY: nominal("gy"),
    groupZ: nominal("gz"),
    overlay: nominal("ov"),
    wrap: nominal("wrap"),
  },
  multiX: [continuous("mx0")],
  multiY: [continuous("my0")],
  elements: [
    { kind: "points", enabled: true },
    { kind: "surface", enabled: true },
    { kind: "line", enabled: true },
  ],
  smootherLambda: 0.42,
  groupStyles: { alpha: { line: { color: "#123" } } },
  hiddenGroups: ["alpha"],
  refLinesY: [{ y: 1, label: "Y1" }],
  refLinesX: [{ x: 2, label: "X2" }],
  autoSpecLines: true,
  autoSpecLinesY: false,
  autoSpecLinesX: true,
  yAxis: { min: 0, max: 10 },
  xAxis: { min: -1, max: 5 },
  createdAt: "2026-01-01T00:00:00.000Z",
} as const;

assert.deepEqual(createDefaultMultivariateGraphState(), {
  columns: [],
  chartType: "correlationMatrix",
  correlationMethod: "pearson",
});

assert.equal(createDefaultGraph2DState().elements.length > 0, true);
assert.equal(createDefaultGraph2DState().elements[0]?.kind, "points");
assert.equal(createDefaultGraph3DState().elements.length > 0, true);
assert.equal(createDefaultGraph3DState().elements[0]?.kind, "scatter3d");

assert.equal(getLayerMode("points"), "2d");
assert.equal(getLayerMode("surface"), "3d");
assert.equal(getLayerMode("correlationMatrix"), "multivariate");

const embeddedDistribution = normalizeGraphBuilderItem({
  id: "distribution-graph:distribution-1:overview",
  name: "Distribution 1 overview",
  sourceDatasetId: "dataset-1",
  mode: "2d",
  modeStates: {
    twoD: {
      ...createDefaultGraph2DState(),
      encoding: { x: continuous("height") },
      multiX: [],
      elements: [{ kind: "histogram", enabled: true }],
    },
    threeD: createDefaultGraph3DState(),
    multivariate: createDefaultMultivariateGraphState(),
  },
  filters: [],
  sampling: { mode: "full" },
  createdAt: "2026-09-10T00:00:00.000Z",
});
assert.deepEqual(embeddedDistribution.modeStates.twoD.encoding.x, continuous("height"));
assert.deepEqual(embeddedDistribution.modeStates.twoD.multiX, []);

const legacy2d = normalizeGraphBuilderItem({
  ...legacyBase,
  threeD: false,
});
assert.equal(legacy2d.mode, "2d");
assert.equal(legacy2d.modeStates.twoD.encoding.x, undefined);
assert.deepEqual(legacy2d.modeStates.twoD.encoding.y, continuous("my0"));
assert.deepEqual(legacy2d.modeStates.twoD.multiX, [continuous("mx0")]);
assert.deepEqual(legacy2d.modeStates.twoD.multiY, []);
assert.deepEqual(legacy2d.modeStates.threeD.encoding.x, legacyBase.encoding.x);
assert.deepEqual(legacy2d.modeStates.threeD.encoding.y, legacyBase.encoding.y);
assert.deepEqual(legacy2d.modeStates.threeD.encoding.z, legacyBase.encoding.z);
assert.deepEqual(legacy2d.modeStates.twoD.elements.map((element) => element.kind), ["points", "line"]);
assert.deepEqual(legacy2d.modeStates.threeD.elements.map((element) => element.kind), ["surface"]);

const legacySingleMultiWinsOverStaleEncoding = normalizeGraphBuilderItem({
  ...legacyBase,
  encoding: {
    ...legacyBase.encoding,
    x: continuous("stale-x"),
    y: continuous("stale-y"),
  },
  multiX: [continuous("active-x")],
  multiY: [continuous("active-y")],
  threeD: false,
});
assert.equal(legacySingleMultiWinsOverStaleEncoding.modeStates.twoD.encoding.x, undefined);
assert.deepEqual(legacySingleMultiWinsOverStaleEncoding.modeStates.twoD.encoding.y, continuous("active-y"));
assert.deepEqual(legacySingleMultiWinsOverStaleEncoding.modeStates.twoD.multiX, [continuous("active-x")]);
assert.deepEqual(legacySingleMultiWinsOverStaleEncoding.modeStates.twoD.multiY, []);

const legacySingleMultiIdempotent = normalizeGraphBuilderItem(legacySingleMultiWinsOverStaleEncoding);
assert.deepEqual(legacySingleMultiIdempotent, legacySingleMultiWinsOverStaleEncoding);

const legacy3d = normalizeGraphBuilderItem({
  ...legacyBase,
  threeD: true,
});
assert.equal(legacy3d.mode, "3d");

const legacyCorrelation = normalizeGraphBuilderItem({
  ...legacyBase,
  multiX: [continuous("a"), continuous("b")],
  multiY: [continuous("ignored"), continuous("alsoIgnored")],
  elements: [{ kind: "correlationMatrix", correlationMethod: "spearman" }],
});
assert.equal(legacyCorrelation.mode, "multivariate");
assert.deepEqual(
  legacyCorrelation.modeStates.multivariate.columns.map((field) => field.name),
  ["a", "b"],
);
assert.equal(legacyCorrelation.modeStates.multivariate.correlationMethod, "spearman");

const legacyCorrelationInvalidMethod = normalizeGraphBuilderItem({
  ...legacyBase,
  multiX: [continuous("a"), continuous("b")],
  elements: [{ kind: "correlationMatrix", correlationMethod: "distance" }],
});
assert.equal(legacyCorrelationInvalidMethod.modeStates.multivariate.correlationMethod, "pearson");

const legacyCorrelationCanonicalColumns = normalizeGraphBuilderItem({
  ...legacyBase,
  multiX: [
    continuous("dup"),
    nominal("cat-ignored"),
    continuous("keep-1"),
    continuous("dup"),
    continuous("keep-2"),
    nominal("cat-ignored-2"),
    continuous("keep-1"),
  ],
  elements: [{ kind: "correlationMatrix", correlationMethod: "pearson" }],
});
assert.deepEqual(
  legacyCorrelationCanonicalColumns.modeStates.multivariate.columns.map((field) => field.name),
  ["dup", "keep-1", "keep-2"],
);
assert.deepEqual(
  legacyCorrelationCanonicalColumns.modeStates.multivariate.columns.map((field) => field.type),
  ["continuous", "continuous", "continuous"],
);

const overTwentyContinuous = Array.from({ length: 25 }, (_, index) => continuous(`c${index + 1}`));
const legacyCorrelationTruncatesTo20 = normalizeGraphBuilderItem({
  ...legacyBase,
  multiX: overTwentyContinuous,
  elements: [{ kind: "correlationMatrix", correlationMethod: "kendall" }],
});
assert.equal(legacyCorrelationTruncatesTo20.modeStates.multivariate.columns.length, 20);
assert.deepEqual(
  legacyCorrelationTruncatesTo20.modeStates.multivariate.columns.map((field) => field.name),
  overTwentyContinuous.slice(0, 20).map((field) => field.name),
);

const currentZeroColumns = normalizeGraphBuilderItem({
  ...legacyCorrelation,
  modeStates: {
    ...legacyCorrelation.modeStates,
    multivariate: {
      ...legacyCorrelation.modeStates.multivariate,
      columns: [],
    },
  },
});
assert.deepEqual(currentZeroColumns.modeStates.multivariate.columns, []);

const currentSingleColumn = normalizeGraphBuilderItem({
  ...legacyCorrelation,
  modeStates: {
    ...legacyCorrelation.modeStates,
    multivariate: {
      ...legacyCorrelation.modeStates.multivariate,
      columns: [continuous("only")],
    },
  },
});
assert.deepEqual(currentSingleColumn.modeStates.multivariate.columns, [continuous("only")]);

const currentCanonicalColumns = normalizeGraphBuilderItem({
  ...legacyCorrelation,
  modeStates: {
    ...legacyCorrelation.modeStates,
    multivariate: {
      ...legacyCorrelation.modeStates.multivariate,
      columns: [
        continuous("a"),
        nominal("cat-ignored"),
        continuous("b"),
        continuous("a"),
        continuous("c"),
      ],
    },
  },
});
assert.deepEqual(
  currentCanonicalColumns.modeStates.multivariate.columns.map((field) => field.name),
  ["a", "b", "c"],
);

const currentTwoDSingleMultiX = normalizeGraphBuilderItem({
  ...legacy2d,
  mode: "2d",
  modeStates: {
    ...legacy2d.modeStates,
    twoD: {
      ...legacy2d.modeStates.twoD,
      encoding: {
        ...legacy2d.modeStates.twoD.encoding,
        x: continuous("stale-current-x"),
      },
      multiX: [continuous("current-active-x")],
      multiY: [],
    },
  },
});
assert.equal(currentTwoDSingleMultiX.modeStates.twoD.encoding.x, undefined);
assert.deepEqual(currentTwoDSingleMultiX.modeStates.twoD.multiX, [continuous("current-active-x")]);

const currentTwoDSingleMultiIdempotent = normalizeGraphBuilderItem(currentTwoDSingleMultiX);
assert.deepEqual(currentTwoDSingleMultiIdempotent, currentTwoDSingleMultiX);

const distributionElements = [
  { kind: "histogram" as const, enabled: true },
  { kind: "normalCurve" as const, enabled: true },
  { kind: "boxplot" as const, enabled: true },
];
const legacyInteractiveDistribution = normalizeGraphBuilderItem({
  ...legacy2d,
  id: "graph-builder-1",
  modeStates: {
    ...legacy2d.modeStates,
    twoD: {
      ...legacy2d.modeStates.twoD,
      encoding: { x: continuous("measurement") },
      multiX: [],
      multiY: [],
      elements: distributionElements,
    },
  },
});
assert.deepEqual(legacyInteractiveDistribution.modeStates.twoD.encoding, {});
assert.deepEqual(legacyInteractiveDistribution.modeStates.twoD.multiX, [continuous("measurement")]);
assert.deepEqual(normalizeGraphBuilderItem(legacyInteractiveDistribution), legacyInteractiveDistribution);

const analysisContinuousX = normalizeGraphBuilderItem({
  ...legacy2d,
  id: "analysis-graph:analysis-1:distributionPreview",
  modeStates: {
    ...legacy2d.modeStates,
    twoD: {
      ...legacy2d.modeStates.twoD,
      encoding: { x: continuous("measurement") },
      multiX: [],
      multiY: [],
      elements: distributionElements,
    },
  },
});
assert.deepEqual(analysisContinuousX.modeStates.twoD.encoding.x, continuous("measurement"));
assert.deepEqual(analysisContinuousX.modeStates.twoD.multiX, []);

const categoricalXWithVariableY = normalizeGraphBuilderItem({
  ...legacy2d,
  id: "graph-builder-categorical",
  modeStates: {
    ...legacy2d.modeStates,
    twoD: {
      ...legacy2d.modeStates.twoD,
      encoding: { x: nominal("site"), y: continuous("measurement") },
      multiX: [],
      multiY: [],
      elements: [{ kind: "boxplot", enabled: true }],
    },
  },
});
assert.deepEqual(categoricalXWithVariableY.modeStates.twoD.encoding, {
  x: nominal("site"),
  y: continuous("measurement"),
});
assert.deepEqual(categoricalXWithVariableY.modeStates.twoD.multiX, []);

const analysisDistributionComposite = normalizeGraphBuilderItem({
  ...legacy2d,
  id: "analysis-graph:analysis-1:distributionComposite",
  modeStates: {
    ...legacy2d.modeStates,
    twoD: {
      ...legacy2d.modeStates.twoD,
      encoding: {},
      multiY: [continuous("measurement")],
      elements: distributionElements,
    },
  },
});
assert.deepEqual(analysisDistributionComposite.modeStates.twoD.encoding, {});
assert.deepEqual(analysisDistributionComposite.modeStates.twoD.multiY, [continuous("measurement")]);

const currentTransposed = normalizeGraphBuilderItem({
  ...legacy2d,
  modeStates: {
    ...legacy2d.modeStates,
    twoD: {
      ...legacy2d.modeStates.twoD,
      transposed: true,
    },
  },
});
assert.equal(currentTransposed.modeStates.twoD.transposed, true);
assert.deepEqual(normalizeGraphBuilderItem(currentTransposed), currentTransposed);

const idempotenceCases: GraphBuilderItem[] = [
  legacy2d,
  legacy3d,
  legacyCorrelation,
  legacySingleMultiWinsOverStaleEncoding,
  currentTwoDSingleMultiX,
];
for (const item of idempotenceCases) {
  assert.deepEqual(normalizeGraphBuilderItem(item), item);
}

console.log("graphBuilderMode migration tests passed");