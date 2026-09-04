import type { FieldRef } from "@/graphCore";

import {
  createDefaultGraph2DState,
  createDefaultGraph3DState,
  createDefaultMultivariateGraphState,
} from "@/components/graphBuilder/graphBuilderMode";
import type {
  CapabilityOverrideEnvelopeV1,
  DistributionAnalysisConfig,
  DistributionAnalysisConfigV1,
  DistributionColumnInfoV1,
  DistributionConfigErrorV1,
  DistributionContinuousFitConfigV1,
  DistributionFitCapabilityV1,
  DistributionItem,
  ContinuousDistributionIdV1,
  DistributionVisualDiagnosticsConfigV1,
} from "@/types/distribution";
import { DISTRIBUTION_GRAPH_ELEMENT_IDS } from "@/types/graphData";
import type { EmbeddedGraphConfig } from "@/types/graphBuilder";

export type DistributionRole = "response" | "weight" | "frequency" | "by";
export type DistributionRoleValidationError =
  | "missingResponse"
  | "invalidResponse"
  | "invalidWeight"
  | "invalidFrequency"
  | "invalidBy"
  | "duplicateRole";

export interface DistributionFieldInfo {
  name: string;
  sqlType: string;
  integerCompatible: boolean;
  field: FieldRef;
}

export interface DistributionRoleBindings {
  responses: FieldRef[];
  weight: FieldRef | null;
  frequency: FieldRef | null;
  by: FieldRef[];
}

export type DistributionRoleValidationResult =
  | { ok: true }
  | { ok: false; error: DistributionRoleValidationError };

export class DistributionRoleValidationErrorClass extends Error {
  readonly code: DistributionRoleValidationError;

  constructor(code: DistributionRoleValidationError) {
    super(`Invalid Distribution roles: ${code}`);
    this.name = "DistributionRoleValidationError";
    this.code = code;
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function sameField(left: FieldRef, right: FieldRef): boolean {
  return left.name === right.name;
}

function isNumericField(field: DistributionFieldInfo): boolean {
  return field.field.type === "continuous"
    || /(?:tiny|small|big)?int|decimal|numeric|real|double|float/i.test(field.sqlType);
}

function isCategoricalField(field: DistributionFieldInfo): boolean {
  return field.field.type === "nominal" || field.field.type === "ordinal";
}

export function canAssignDistributionRole(
  role: DistributionRole,
  field: DistributionFieldInfo,
  occupied: readonly FieldRef[],
): true | DistributionRoleValidationError {
  if (occupied.some((candidate) => sameField(candidate, field.field))) {
    return "duplicateRole";
  }
  if (role === "response" && field.field.type !== "continuous") return "invalidResponse";
  if (role === "weight" && !isNumericField(field)) return "invalidWeight";
  if (role === "frequency" && (!isNumericField(field) || !field.integerCompatible)) {
    return "invalidFrequency";
  }
  if (role === "by" && !isCategoricalField(field)) return "invalidBy";
  return true;
}

export function validateDistributionRoles(
  roles: DistributionRoleBindings,
  fields: readonly DistributionFieldInfo[],
): DistributionRoleValidationResult {
  if (roles.responses.length === 0) return { ok: false, error: "missingResponse" };
  const byName = new Map(fields.map((field) => [field.field.name, field]));
  const occupied: FieldRef[] = [];
  const assignments: Array<[DistributionRole, FieldRef]> = [
    ...roles.responses.map((field): [DistributionRole, FieldRef] => ["response", field]),
    ...(roles.weight ? [["weight", roles.weight] as [DistributionRole, FieldRef]] : []),
    ...(roles.frequency ? [["frequency", roles.frequency] as [DistributionRole, FieldRef]] : []),
    ...roles.by.map((field): [DistributionRole, FieldRef] => ["by", field]),
  ];
  for (const [role, field] of assignments) {
    const metadata = byName.get(field.name) ?? {
      name: field.name,
      sqlType: "",
      integerCompatible: false,
      field,
    };
    const result = canAssignDistributionRole(role, metadata, occupied);
    if (result !== true) return { ok: false, error: result };
    occupied.push(field);
  }
  return { ok: true };
}

export function createDefaultDistributionAnalysisConfig(): DistributionAnalysisConfig {
  return {
    confidenceLevel: 0.95,
    specLimits: {},
    fitDistributions: [],
  };
}

function createDistributionGraph(
  response: FieldRef,
  elements: EmbeddedGraphConfig["modeStates"]["twoD"]["elements"],
): EmbeddedGraphConfig {
  const twoD = createDefaultGraph2DState();
  return {
    mode: "2d",
    modeStates: {
      twoD: {
        ...twoD,
        encoding: { x: clone(response) },
        multiX: [],
        multiY: [],
        elements,
      },
      threeD: createDefaultGraph3DState(),
      multivariate: createDefaultMultivariateGraphState(),
    },
    filters: [],
    sampling: { mode: "full" },
  };
}

export function createDefaultDistributionGraphs(response: FieldRef): DistributionItem["graphs"] {
  return {
    overview: createDistributionGraph(response, [
      { kind: "histogram", enabled: true, options: { elementId: DISTRIBUTION_GRAPH_ELEMENT_IDS.overviewHistogram } },
      { kind: "line", enabled: true, options: { elementId: DISTRIBUTION_GRAPH_ELEMENT_IDS.overviewFittedCurves } },
    ]),
    boxPlot: createDistributionGraph(response, [
      { kind: "boxplot", enabled: true, options: { elementId: DISTRIBUTION_GRAPH_ELEMENT_IDS.boxPlot } },
    ]),
    ecdf: createDistributionGraph(response, [
      { kind: "line", enabled: true, options: { elementId: DISTRIBUTION_GRAPH_ELEMENT_IDS.ecdf } },
    ]),
    normalQuantile: createDistributionGraph(response, [
      { kind: "points", enabled: true, options: { elementId: DISTRIBUTION_GRAPH_ELEMENT_IDS.normalQuantilePoints } },
      { kind: "line", enabled: true, options: { elementId: DISTRIBUTION_GRAPH_ELEMENT_IDS.normalQuantileReference } },
      { kind: "line", enabled: true, options: { elementId: DISTRIBUTION_GRAPH_ELEMENT_IDS.normalQuantileLower } },
      { kind: "line", enabled: true, options: { elementId: DISTRIBUTION_GRAPH_ELEMENT_IDS.normalQuantileUpper } },
    ]),
  };
}

export function createDistributionItem(input: {
  id: string;
  name: string;
  sourceDatasetId: string;
  responses: FieldRef[];
  weight: FieldRef | null;
  frequency: FieldRef | null;
  by: FieldRef[];
  columns: readonly DistributionFieldInfo[];
  analysis?: DistributionAnalysisConfig;
  createdAt: string;
}): DistributionItem {
  const roles = {
    responses: input.responses,
    weight: input.weight,
    frequency: input.frequency,
    by: input.by,
  };
  const validation = validateDistributionRoles(roles, input.columns);
  if (!validation.ok) throw new DistributionRoleValidationErrorClass(validation.error);
  return {
    id: input.id,
    name: input.name,
    sourceDatasetId: input.sourceDatasetId,
    responses: clone(input.responses),
    weight: clone(input.weight),
    frequency: clone(input.frequency),
    by: clone(input.by),
    analysis: clone(input.analysis ?? createDefaultDistributionAnalysisConfig()),
    graphs: createDefaultDistributionGraphs(input.responses[0]!),
    createdAt: input.createdAt,
  };
}

export interface CapabilityOverrideValidatorV1 {
  capabilityId: string;
  payloadSchemaVersion: string;
  validate: (payload: Record<string, unknown>) => DistributionConfigErrorV1[];
}

export interface CapabilityOverrideRegistryV1 {
  hasCapability: (capabilityId: string) => boolean;
  hasCapabilityVersion: (capabilityId: string, payloadSchemaVersion: string) => boolean;
  validate: (envelope: CapabilityOverrideEnvelopeV1) => DistributionConfigErrorV1[];
}

export const DISTRIBUTION_FIT_CAPABILITY_REGISTRY: DistributionFitCapabilityV1[] = [
  {
    distributionId: "normal",
    methodId: "fit.normal.mle.v1",
    methodVersion: "1.0.0",
    parameterizationId: "normal.locationScale.v1",
    implemented: true,
    compatibilityStatus: "compatibilityPending",
  },
  {
    distributionId: "lognormal",
    methodId: "fit.lognormal.mle.v1",
    methodVersion: "1.0.0",
    parameterizationId: "lognormal.logLocationLogScale.v1",
    implemented: true,
    compatibilityStatus: "compatibilityPending",
  },
  {
    distributionId: "exponential",
    methodId: "fit.exponential.location0.mle.v1",
    methodVersion: "1.0.0",
    parameterizationId: "exponential.scaleLocation0.v1",
    implemented: true,
    compatibilityStatus: "compatibilityPending",
  },
  {
    distributionId: "gamma",
    methodId: "fit.gamma.shapeScale.mle.v1",
    methodVersion: "1.0.0",
    parameterizationId: "gamma.shapeScale.location0.v1",
    implemented: true,
    compatibilityStatus: "compatibilityPending",
  },
  {
    distributionId: "weibull",
    methodId: "fit.weibull.shapeScale.mle.v1",
    methodVersion: "1.0.0",
    parameterizationId: "weibull.shapeScale.location0.v1",
    implemented: true,
    compatibilityStatus: "compatibilityPending",
  },
] as const;

const error = (
  code: string,
  messageKey: string,
  fieldPath: string,
): DistributionConfigErrorV1 => ({ code, messageKey, fieldPath });

export function createDefaultDistributionVisualDiagnosticsConfig(): DistributionVisualDiagnosticsConfigV1 {
  return {
    histogram: {
      method: "jmpAuto",
      fixedCount: null,
      fixedWidth: null,
    },
    normalQuantileConfidenceLevel: 0.95,
  };
}

export function createDefaultDistributionContinuousFitConfig(): DistributionContinuousFitConfigV1 {
  return {
    enabledDistributionIds: [],
    fitAll: false,
    diagnostics: {
      goodnessOfFit: false,
      qqPlot: false,
      cdfPlot: false,
      ppPlot: false,
    },
  };
}

export function normalizeDistributionAnalysisConfig(
  config: DistributionAnalysisConfigV1,
): DistributionAnalysisConfigV1 {
  return {
    ...config,
    continuousFit: config.continuousFit ?? createDefaultDistributionContinuousFitConfig(),
    visualDiagnostics: config.visualDiagnostics ?? createDefaultDistributionVisualDiagnosticsConfig(),
  };
}

export function validateDistributionContinuousFitConfig(
  continuousFit: DistributionContinuousFitConfigV1,
): DistributionConfigErrorV1[] {
  const errors: DistributionConfigErrorV1[] = [];
  const implementedIds = new Set(
    DISTRIBUTION_FIT_CAPABILITY_REGISTRY
      .filter((capability) => capability.implemented)
      .map((capability) => capability.distributionId),
  );
  const seenDistributionIds = new Set<ContinuousDistributionIdV1>();
  continuousFit.enabledDistributionIds.forEach((distributionId, index) => {
    if (!implementedIds.has(distributionId)) {
      errors.push(error(
        "distribution.config.unknownContinuousFitCapability",
        "distribution.errors.unknownContinuousFitCapability",
        `continuousFit.enabledDistributionIds[${index}]`,
      ));
      return;
    }
    if (seenDistributionIds.has(distributionId)) {
      errors.push(error(
        "distribution.config.duplicateContinuousFitCapability",
        "distribution.errors.duplicateContinuousFitCapability",
        `continuousFit.enabledDistributionIds[${index}]`,
      ));
    }
    seenDistributionIds.add(distributionId);
  });
  return errors;
}

export function validateDistributionVisualDiagnosticsConfig(
  visualDiagnostics: DistributionVisualDiagnosticsConfigV1,
): DistributionConfigErrorV1[] {
  const errors: DistributionConfigErrorV1[] = [];
  const histogram = visualDiagnostics.histogram;

  if (histogram.method === "fixedCount") {
    if (
      histogram.fixedCount === null ||
      !Number.isFinite(histogram.fixedCount) ||
      !Number.isInteger(histogram.fixedCount) ||
      histogram.fixedCount < 1 ||
      histogram.fixedCount > 1000
    ) {
      errors.push(error(
        "distribution.config.histogramFixedCountOutOfRange",
        "distribution.errors.histogramFixedCountOutOfRange",
        "visualDiagnostics.histogram.fixedCount",
      ));
    }
  }

  if (histogram.method === "fixedWidth") {
    if (
      histogram.fixedWidth === null ||
      !Number.isFinite(histogram.fixedWidth) ||
      histogram.fixedWidth <= 0
    ) {
      errors.push(error(
        "distribution.config.histogramFixedWidthInvalid",
        "distribution.errors.histogramFixedWidthInvalid",
        "visualDiagnostics.histogram.fixedWidth",
      ));
    }
  }

  if (
    !Number.isFinite(visualDiagnostics.normalQuantileConfidenceLevel) ||
    visualDiagnostics.normalQuantileConfidenceLevel <= 0 ||
    visualDiagnostics.normalQuantileConfidenceLevel >= 1
  ) {
    errors.push(error(
      "distribution.config.normalQuantileConfidenceOutOfRange",
      "distribution.errors.normalQuantileConfidenceOutOfRange",
      "visualDiagnostics.normalQuantileConfidenceLevel",
    ));
  }

  return errors;
}

export function createCapabilityOverrideRegistry(
  validators: readonly CapabilityOverrideValidatorV1[],
): CapabilityOverrideRegistryV1 {
  const byKey = new Map<string, CapabilityOverrideValidatorV1>();
  const capabilityIds = new Set<string>();
  for (const validator of validators) {
    const key = `${validator.capabilityId}\u0000${validator.payloadSchemaVersion}`;
    if (byKey.has(key)) {
      throw new Error(`Duplicate capability validator: ${validator.capabilityId}`);
    }
    byKey.set(key, validator);
    capabilityIds.add(validator.capabilityId);
  }
  return {
    hasCapability: (capabilityId) => capabilityIds.has(capabilityId),
    hasCapabilityVersion: (capabilityId, payloadSchemaVersion) =>
      byKey.has(`${capabilityId}\u0000${payloadSchemaVersion}`),
    validate: (envelope) => {
      if (!capabilityIds.has(envelope.capabilityId)) {
        return [error(
          "distribution.config.unknownCapability",
          "distribution.errors.unknownCapability",
          "capabilityId",
        )];
      }
      const validator = byKey.get(
        `${envelope.capabilityId}\u0000${envelope.payloadSchemaVersion}`,
      );
      if (!validator) {
        return [error(
          "distribution.config.unknownCapabilityVersion",
          "distribution.errors.unknownCapabilityVersion",
          "payloadSchemaVersion",
        )];
      }
      return validator.validate(envelope.payload).map((payloadError) => ({
        ...payloadError,
        fieldPath: `payload${payloadError.fieldPath ? `.${payloadError.fieldPath}` : ""}`,
      }));
    },
  };
}

const EMPTY_REGISTRY = createCapabilityOverrideRegistry([]);
export const NORMAL_CAPABILITY_ID = "capability.normal.individuals";

const normalCapabilityValidator: CapabilityOverrideValidatorV1 = {
  capabilityId: NORMAL_CAPABILITY_ID,
  payloadSchemaVersion: "1",
  validate: (payload) => {
    const errors: DistributionConfigErrorV1[] = [];
    const allowed = new Set(["lsl", "target", "usl"]);
    if (Object.keys(payload).some((key) => !allowed.has(key))) {
      errors.push(error(
        "capability.invalidOverride.v1",
        "distribution.errors.invalidCapabilityOverride",
        "",
      ));
      return errors;
    }
    const read = (key: "lsl" | "target" | "usl") => {
      const value = payload[key];
      if (value === null || value === undefined) return null;
      if (typeof value !== "number" || !Number.isFinite(value)) {
        errors.push(error(
          "capability.invalidOverride.v1",
          "distribution.errors.invalidCapabilityOverride",
          key,
        ));
        return null;
      }
      return value;
    };
    const lsl = read("lsl");
    const target = read("target");
    const usl = read("usl");
    if (lsl !== null && usl !== null && lsl >= usl) {
      errors.push(error(
        "capability.invalidOverride.v1",
        "distribution.errors.invalidCapabilityOverride",
        "usl",
      ));
    }
    if ((lsl !== null && target !== null && target < lsl) ||
        (usl !== null && target !== null && target > usl)) {
      errors.push(error(
        "capability.invalidOverride.v1",
        "distribution.errors.invalidCapabilityOverride",
        "target",
      ));
    }
    return errors;
  },
};

export const DISTRIBUTION_CAPABILITY_OVERRIDE_REGISTRY =
  createCapabilityOverrideRegistry([normalCapabilityValidator]);

const isNumeric = (column: DistributionColumnInfoV1) =>
  column.modelingType === "continuous" || column.modelingType === "discreteNumeric";

export function isDistributionMenuEnabled(activeDatasetId: string | null): boolean {
  return activeDatasetId !== null;
}

export function validateDistributionConfig(
  config: DistributionAnalysisConfigV1,
  columns: readonly DistributionColumnInfoV1[],
  registry: CapabilityOverrideRegistryV1 = EMPTY_REGISTRY,
): DistributionConfigErrorV1[] {
  const errors: DistributionConfigErrorV1[] = [];
  const byId = new Map(columns.map((column) => [column.columnId, column]));
  const yIds = new Set<string>();

  if (config.yColumns.length === 0) {
    errors.push(error(
      "distribution.config.yRequired",
      "distribution.errors.yRequired",
      "yColumns",
    ));
  }
  config.yColumns.forEach((ref, index) => {
    const column = byId.get(ref.columnId);
    if (!column) {
      errors.push(error(
        "distribution.config.columnUnknown",
        "distribution.errors.columnUnknown",
        `yColumns[${index}]`,
      ));
      return;
    }
    if (yIds.has(ref.columnId)) {
      errors.push(error(
        "distribution.config.roleDuplicate",
        "distribution.errors.roleDuplicate",
        `yColumns[${index}]`,
      ));
    }
    yIds.add(ref.columnId);
    if (column.modelingType !== "continuous" || ref.modelingType !== "continuous") {
      errors.push(error(
        "distribution.config.yTypeIncompatible",
        "distribution.errors.yTypeIncompatible",
        `yColumns[${index}]`,
      ));
    }
  });

  if (!Number.isFinite(config.confidenceLevel) ||
      config.confidenceLevel <= 0 || config.confidenceLevel >= 1) {
    errors.push(error(
      "distribution.config.confidenceOutOfRange",
      "distribution.errors.confidenceOutOfRange",
      "confidenceLevel",
    ));
  }

  const visualDiagnostics =
    config.visualDiagnostics ?? createDefaultDistributionVisualDiagnosticsConfig();
  errors.push(...validateDistributionVisualDiagnosticsConfig(visualDiagnostics));

  const continuousFit = config.continuousFit ?? createDefaultDistributionContinuousFitConfig();
  errors.push(...validateDistributionContinuousFitConfig(continuousFit));

  const occupied = new Set(yIds);
  const validateSingleton = (
    columnId: string | null,
    fieldPath: "weightColumnId" | "frequencyColumnId",
  ) => {
    if (!columnId) return;
    if (occupied.has(columnId)) {
      errors.push(error(
        "distribution.config.roleConflict",
        "distribution.errors.roleConflict",
        fieldPath,
      ));
      return;
    }
    occupied.add(columnId);
    const column = byId.get(columnId);
    if (!column) {
      errors.push(error(
        "distribution.config.columnUnknown",
        "distribution.errors.columnUnknown",
        fieldPath,
      ));
      return;
    }
    if (fieldPath === "weightColumnId" && !isNumeric(column)) {
      errors.push(error(
        "distribution.config.weightTypeIncompatible",
        "distribution.errors.weightTypeIncompatible",
        fieldPath,
      ));
    }
    if (fieldPath === "frequencyColumnId" && !column.integerCompatible) {
      errors.push(error(
        "distribution.config.freqNotIntegerCompatible",
        "distribution.errors.freqNotIntegerCompatible",
        fieldPath,
      ));
    }
  };
  validateSingleton(config.weightColumnId, "weightColumnId");
  validateSingleton(config.frequencyColumnId, "frequencyColumnId");

  config.byColumnIds.forEach((columnId, index) => {
    if (occupied.has(columnId)) {
      errors.push(error(
        "distribution.config.roleConflict",
        "distribution.errors.roleConflict",
        `byColumnIds[${index}]`,
      ));
      return;
    }
    occupied.add(columnId);
    if (!byId.has(columnId)) {
      errors.push(error(
        "distribution.config.columnUnknown",
        "distribution.errors.columnUnknown",
        `byColumnIds[${index}]`,
      ));
    }
  });

  const seenEnabled = new Set<string>();
  config.enabledCapabilityIds.forEach((capabilityId, index) => {
    if (seenEnabled.has(capabilityId)) {
      errors.push(error(
        "distribution.config.duplicateCapability",
        "distribution.errors.duplicateCapability",
        `enabledCapabilityIds[${index}]`,
      ));
    }
    seenEnabled.add(capabilityId);
    if (!registry.hasCapability(capabilityId)) {
      errors.push(error(
        "distribution.config.unknownCapability",
        "distribution.errors.unknownCapability",
        `enabledCapabilityIds[${index}]`,
      ));
    }
  });

  const seenOverrides = new Set<string>();
  config.capabilityOverrides.forEach((envelope, index) => {
    if (seenOverrides.has(envelope.capabilityId)) {
      errors.push(error(
        "distribution.config.duplicateCapabilityOverride",
        "distribution.errors.duplicateCapabilityOverride",
        "capabilityOverrides",
      ));
      return;
    }
    seenOverrides.add(envelope.capabilityId);
    const payloadErrors = registry.validate(envelope);
    for (const payloadError of payloadErrors) {
      errors.push({
        ...payloadError,
        fieldPath: `capabilityOverrides[${index}].${payloadError.fieldPath}`,
      });
    }
  });

  return errors;
}