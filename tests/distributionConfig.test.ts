import assert from "node:assert/strict";

import {
  canAssignDistributionRole,
  createDefaultDistributionAnalysisConfig,
  createDistributionItem,
  createDefaultDistributionVisualDiagnosticsConfig,
  createCapabilityOverrideRegistry,
  isDistributionMenuEnabled,
  validateDistributionRoles,
  validateDistributionVisualDiagnosticsConfig,
  validateDistributionConfig,
} from "../src/components/distribution/distributionConfig.ts";
import { DISTRIBUTION_GRAPH_ELEMENT_IDS } from "../src/types/graphData.ts";
import type {
  CapabilityOverrideEnvelopeV1,
  DistributionAnalysisConfigV1,
  DistributionColumnInfoV1,
} from "../src/types/distribution.ts";

const columns: DistributionColumnInfoV1[] = [
  {
    columnId: "col-y",
    sqlType: "DOUBLE",
    modelingType: "continuous",
    integerCompatible: false,
  },
  {
    columnId: "col-weight",
    sqlType: "DOUBLE",
    modelingType: "continuous",
    integerCompatible: false,
  },
  {
    columnId: "col-freq",
    sqlType: "INTEGER",
    modelingType: "discreteNumeric",
    integerCompatible: true,
  },
  {
    columnId: "col-group",
    sqlType: "VARCHAR",
    modelingType: "nominal",
    integerCompatible: false,
  },
  {
    columnId: "col-date",
    sqlType: "TIMESTAMP",
    modelingType: "datetime",
    integerCompatible: false,
  },
];

const config: DistributionAnalysisConfigV1 = {
  schemaVersion: "1",
  sourceDatasetId: "dataset-1",
  yColumns: [{ columnId: "col-y", modelingType: "continuous" }],
  weightColumnId: "col-weight",
  frequencyColumnId: "col-freq",
  byColumnIds: ["col-group", "col-date"],
  filterExpr: { kind: "isNull", fieldId: "col-group", negate: true },
  confidenceLevel: 0.95,
  histogramsOnly: false,
  visualDiagnostics: {
    histogram: {
      method: "jmpAuto",
      fixedCount: null,
      fixedWidth: null,
    },
    normalQuantileConfidenceLevel: 0.95,
  },
  enabledCapabilityIds: [],
  capabilityOverrides: [],
  reportPreferences: {
    "col-y": {
      overview: true,
      histogram: true,
      outlierBoxPlot: true,
      specificationLines: true,
      quantiles: true,
      summary: true,
      horizontalTables: true,
      normalQuantilePlot: false,
      ecdf: false,
      processCapability: true,
      histogramScale: "count",
    },
  },
};

const defaultVisualDiagnostics = createDefaultDistributionVisualDiagnosticsConfig();
assert.equal(defaultVisualDiagnostics.histogram.method, "jmpAuto");
assert.equal(config.reportPreferences?.["col-y"]?.normalQuantilePlot, false);
assert.equal(
  validateDistributionVisualDiagnosticsConfig({
    histogram: {
      method: "fixedCount",
      fixedCount: 0,
      fixedWidth: null,
    },
    normalQuantileConfidenceLevel: 0.95,
  })[0]?.fieldPath,
  "visualDiagnostics.histogram.fixedCount",
);

assert.equal(isDistributionMenuEnabled(null), false);
assert.equal(isDistributionMenuEnabled("dataset-1"), true);

assert.deepEqual(validateDistributionConfig(config, columns), []);
assert.deepEqual(
  validateDistributionConfig({ ...config, yColumns: [] }, columns)[0],
  {
    code: "distribution.config.yRequired",
    messageKey: "distribution.errors.yRequired",
    fieldPath: "yColumns",
  },
);
assert.equal(
  validateDistributionConfig({ ...config, confidenceLevel: 1 }, columns)[0]?.code,
  "distribution.config.confidenceOutOfRange",
);
assert.equal(
  validateDistributionConfig(
    { ...config, yColumns: [{ columnId: "col-group", modelingType: "nominal" }] },
    columns,
  )[0]?.code,
  "distribution.config.yTypeIncompatible",
);
assert.equal(
  validateDistributionConfig({ ...config, weightColumnId: "col-y" }, columns)[0]?.code,
  "distribution.config.roleConflict",
);
assert.equal(
  validateDistributionConfig(
    { ...config, weightColumnId: null, frequencyColumnId: "col-weight" },
    columns,
  )[0]?.code,
  "distribution.config.freqNotIntegerCompatible",
);

const unknownOverride: CapabilityOverrideEnvelopeV1 = {
  schemaVersion: "1",
  capabilityId: "capability.unknown",
  payloadSchemaVersion: "1",
  payload: {},
};
assert.equal(
  validateDistributionConfig(
    { ...config, capabilityOverrides: [unknownOverride] },
    columns,
  )[0]?.code,
  "distribution.config.unknownCapability",
);

const registry = createCapabilityOverrideRegistry([
  {
    capabilityId: "capability.synthetic",
    payloadSchemaVersion: "1",
    validate: (payload) =>
      typeof payload === "object" && payload !== null && "enabled" in payload
        ? []
        : [{
            code: "distribution.config.payloadValidationFailed",
            messageKey: "distribution.errors.payloadValidationFailed",
            fieldPath: "enabled",
          }],
  },
]);
const validOverride: CapabilityOverrideEnvelopeV1 = {
  schemaVersion: "1",
  capabilityId: "capability.synthetic",
  payloadSchemaVersion: "1",
  payload: { enabled: true },
};
assert.equal(
  validateDistributionConfig(
    {
      ...config,
      enabledCapabilityIds: ["capability.synthetic"],
      capabilityOverrides: [{ ...validOverride, payloadSchemaVersion: "99" }],
    },
    columns,
    registry,
  )[0]?.code,
  "distribution.config.unknownCapabilityVersion",
);
assert.deepEqual(
  validateDistributionConfig(
    {
      ...config,
      enabledCapabilityIds: ["capability.synthetic"],
      capabilityOverrides: [validOverride],
    },
    columns,
    registry,
  ),
  [],
);
assert.equal(
  validateDistributionConfig(
    {
      ...config,
      enabledCapabilityIds: ["capability.synthetic"],
      capabilityOverrides: [{ ...validOverride, payload: {} }],
    },
    columns,
    registry,
  )[0]?.fieldPath,
  "capabilityOverrides[0].payload.enabled",
);
assert.equal(
  validateDistributionConfig(
    {
      ...config,
      enabledCapabilityIds: ["capability.synthetic"],
      capabilityOverrides: [validOverride, validOverride],
    },
    columns,
    registry,
  )[0]?.code,
  "distribution.config.duplicateCapabilityOverride",
);

const responseField = {
  name: "height",
  sqlType: "DOUBLE",
  integerCompatible: false,
  field: { name: "height", type: "continuous" as const },
};
const secondResponseField = {
  name: "width",
  sqlType: "DOUBLE",
  integerCompatible: false,
  field: { name: "width", type: "continuous" as const },
};
const weightField = {
  name: "weight",
  sqlType: "DECIMAL(10, 2)",
  integerCompatible: false,
  field: { name: "weight", type: "continuous" as const },
};
const frequencyField = {
  name: "count",
  sqlType: "BIGINT",
  integerCompatible: true,
  field: { name: "count", type: "continuous" as const },
};
const nonIntegerFrequencyField = {
  name: "ratio",
  sqlType: "DOUBLE",
  integerCompatible: false,
  field: { name: "ratio", type: "continuous" as const },
};
const groupField = {
  name: "site",
  sqlType: "VARCHAR",
  integerCompatible: false,
  field: { name: "site", type: "nominal" as const },
};
const ordinalGroupField = {
  name: "batch",
  sqlType: "VARCHAR",
  integerCompatible: false,
  field: { name: "batch", type: "ordinal" as const },
};

assert.equal(canAssignDistributionRole("response", responseField, []), true);
assert.equal(canAssignDistributionRole("response", groupField, []), "invalidResponse");
assert.equal(canAssignDistributionRole("weight", weightField, []), true);
assert.equal(canAssignDistributionRole("weight", groupField, []), "invalidWeight");
assert.equal(canAssignDistributionRole("frequency", frequencyField, []), true);
assert.equal(canAssignDistributionRole("frequency", nonIntegerFrequencyField, []), "invalidFrequency");
assert.equal(canAssignDistributionRole("by", groupField, []), true);
assert.equal(canAssignDistributionRole("by", ordinalGroupField, []), true);
assert.equal(canAssignDistributionRole("by", responseField, []), "invalidBy");
assert.equal(canAssignDistributionRole("by", groupField, [groupField.field]), "duplicateRole");

assert.deepEqual(validateDistributionRoles({
  responses: [responseField.field, secondResponseField.field],
  weight: weightField.field,
  frequency: frequencyField.field,
  by: [groupField.field, ordinalGroupField.field],
}, [responseField, secondResponseField, weightField, frequencyField, groupField, ordinalGroupField]), { ok: true });
assert.deepEqual(validateDistributionRoles({ responses: [], weight: null, frequency: null, by: [] }, []), {
  ok: false,
  error: "missingResponse",
});
assert.deepEqual(validateDistributionRoles({
  responses: [responseField.field, responseField.field],
  weight: null,
  frequency: null,
  by: [],
}, [responseField]), { ok: false, error: "duplicateRole" });
assert.deepEqual(validateDistributionRoles({
  responses: [responseField.field],
  weight: responseField.field,
  frequency: null,
  by: [],
}, [responseField]), { ok: false, error: "duplicateRole" });
assert.deepEqual(validateDistributionRoles({
  responses: [responseField.field],
  weight: null,
  frequency: nonIntegerFrequencyField.field,
  by: [],
}, [responseField, nonIntegerFrequencyField]), { ok: false, error: "invalidFrequency" });

const defaultAnalysis = createDefaultDistributionAnalysisConfig();
assert.deepEqual(defaultAnalysis, { confidenceLevel: 0.95, specLimits: {}, fitDistributions: [] });

const distributionItem = createDistributionItem({
  id: "distribution-1",
  name: "Distribution 1",
  sourceDatasetId: "dataset-1",
  responses: [responseField.field, secondResponseField.field],
  weight: weightField.field,
  frequency: frequencyField.field,
  by: [groupField.field],
  columns: [responseField, secondResponseField, weightField, frequencyField, groupField],
  createdAt: "2026-09-02T00:00:00.000Z",
});
assert.deepEqual(distributionItem.analysis, defaultAnalysis);
assert.deepEqual(distributionItem.responses, [responseField.field, secondResponseField.field]);

const expectedElements = {
  overview: [
    ["histogram", DISTRIBUTION_GRAPH_ELEMENT_IDS.overviewHistogram],
    ["line", DISTRIBUTION_GRAPH_ELEMENT_IDS.overviewFittedCurves],
  ],
  boxPlot: [["boxplot", DISTRIBUTION_GRAPH_ELEMENT_IDS.boxPlot]],
  ecdf: [["line", DISTRIBUTION_GRAPH_ELEMENT_IDS.ecdf]],
  normalQuantile: [
    ["points", DISTRIBUTION_GRAPH_ELEMENT_IDS.normalQuantilePoints],
    ["line", DISTRIBUTION_GRAPH_ELEMENT_IDS.normalQuantileReference],
    ["line", DISTRIBUTION_GRAPH_ELEMENT_IDS.normalQuantileLower],
    ["line", DISTRIBUTION_GRAPH_ELEMENT_IDS.normalQuantileUpper],
  ],
} as const;

for (const graphName of Object.keys(expectedElements) as Array<keyof typeof expectedElements>) {
  const graph = distributionItem.graphs[graphName];
  assert.equal(graph.mode, "2d");
  assert.deepEqual(graph.filters, []);
  assert.deepEqual(graph.sampling, { mode: "full" });
  assert.equal(graph.modeStates.twoD.encoding.x?.name, "height");
  assert.deepEqual(
    graph.modeStates.twoD.elements.map((element) => [element.kind, element.options?.elementId]),
    expectedElements[graphName],
  );
}

assert.throws(() => createDistributionItem({
  id: "invalid",
  name: "Invalid",
  sourceDatasetId: "dataset-1",
  responses: [groupField.field],
  weight: null,
  frequency: null,
  by: [],
  columns: [groupField],
  createdAt: "2026-09-02T00:00:00.000Z",
}), /invalidResponse/);

console.log("distribution configuration contracts OK");