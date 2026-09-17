import { CommandExecutionError } from "@/applicationCommands/runtime";
import type {
  AnalysisCommandResult,
  AnalysisCreateInput,
  AnalysisCreateInputByKind,
  AnalysisRunInput,
  AnalysisRunResult,
  AnalysisUpdateInput,
  AnalysisUpdateInputByKind,
} from "@/applicationCommands/types";
import {
  createDistributionAnalysisDocument,
  createFitModelAnalysisDocument,
  createFitYByXAnalysisDocument,
  createHypothesisTestAnalysisDocument,
} from "@/components/analysis/adapters";
import {
  createDefaultDistributionAnalysisConfig,
  createDefaultDistributionGraphs,
  createDistributionItem,
} from "@/components/distribution/distributionConfig";
import {
  executeAnalysisWithFence,
  type UseAnalysisExecutionRuntime,
} from "@/components/analysis/useAnalysisExecution";
import { analysisExecutors } from "@/components/analysis/analysisExecutors";
import { selectWorkspaceDocument } from "@/components/analysis/analysisWorkspaceLifecycle";
import { createDefaultFitYByXGraphConfig, createFitYByXItem } from "@/components/fitYByX/fitYByXConfig";
import { createFitModelItem, toFitModelFieldInfo } from "@/components/fitModel";
import i18n from "@/i18n";
import { dataService } from "@/services/dataService";
import { buildDistributionFieldInfo } from "@/components/tablePropertyManagerRequest";
import { normalizePersistedAnalysisDocument, useAnalysisStore } from "@/stores/useAnalysisStore";
import { useDataStore } from "@/stores/useDataStore";
import { useHistoryStore } from "@/stores/useHistoryStore";
import { useProjectStore } from "@/stores/useProjectStore";
import { useWorkspaceSelectionStore } from "@/stores/useWorkspaceSelectionStore";
import type {
  AnalysisDocument,
  AnalysisDocumentByKind,
  AnalysisDocumentPatch,
  AnalysisKind,
  FitModelAnalysisDefinition,
  FitYByXAnalysisDefinition,
} from "@/types/analysis";
import type { ColumnDisplayProps, DatasetMeta } from "@/types/data";
import type { DistributionItem } from "@/types/distribution";
import type { HypothesisTestAnalysisPresentation } from "@/types/hypothesisTest";
import { cloneValue } from "@/utils/cloneValue";
import { resolveProjectBasenameForKind } from "@/utils/projectFileNaming";

interface AnalysisCreateAdapterContext {
  analysisId: string;
  name: string;
  sourceDatasetId: string;
  createdAt: string;
  getColumns: (datasetId: string) => Promise<Array<[string, string]>>;
  getColumnDisplayProps: (datasetId: string) => Promise<ColumnDisplayProps[]>;
}

interface AnalysisCreateAdapter<Kind extends AnalysisKind> {
  create: (
    input: AnalysisCreateInputByKind[Kind],
    context: AnalysisCreateAdapterContext,
  ) => Promise<AnalysisDocumentByKind[Kind]>;
}

interface AnalysisUpdateValidator<Kind extends AnalysisKind> {
  buildNext: (
    current: AnalysisDocumentByKind[Kind],
    input: AnalysisUpdateInputByKind[Kind],
    updatedAt: string,
  ) => AnalysisDocumentByKind[Kind];
}

export interface AnalysisCommandSchema<Kind extends AnalysisKind> {
  analysisKind: Kind;
  supportsGraphPresentation: boolean;
  supportsReportEmbedding: boolean;
  create: AnalysisCommandJsonSchema;
  update: AnalysisCommandJsonSchema;
  run: AnalysisCommandJsonSchema;
}

type AnalysisCommandJsonType = "object" | "array" | "string" | "number" | "boolean" | "null";

export interface AnalysisCommandJsonSchema {
  type: AnalysisCommandJsonType | AnalysisCommandJsonType[];
  const?: unknown;
  enum?: unknown[];
  oneOf?: AnalysisCommandJsonSchema[];
  minLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  required?: string[];
  properties?: Record<string, AnalysisCommandJsonSchema>;
  items?: AnalysisCommandJsonSchema;
  additionalProperties?: boolean | AnalysisCommandJsonSchema;
}

export interface AnalysisCommandFixture<Kind extends AnalysisKind> {
  analysisKind: Kind;
  create: AnalysisCreateInputByKind[Kind];
  update: (analysisId: string, expectedConfigRevision: number) => AnalysisUpdateInputByKind[Kind];
  run: (analysisId: string) => AnalysisRunInput;
}

export interface AnalysisCommandDependencies {
  listDatasets: () => DatasetMeta[];
  listAnalyses: () => AnalysisDocument[];
  createAnalysisId: () => string;
  createNowIso: () => string;
  getColumns: (datasetId: string) => Promise<Array<[string, string]>>;
  getColumnDisplayProps: (datasetId: string) => Promise<ColumnDisplayProps[]>;
  addAnalysis: (analysis: AnalysisDocument) => void;
  updateAnalysis: (id: string, patch: AnalysisDocumentPatch) => void;
  activateAnalysis: (analysisId: string) => void;
  markDirty: () => void;
  recordAction: (description: string) => void;
  getCurrentAnalysis: (analysisId: string) => AnalysisDocument | null;
  getCurrentDataset: (datasetId: string) => DatasetMeta | null;
  executionRuntime: UseAnalysisExecutionRuntime;
}

function nextDistributionAnalysisName(items: readonly AnalysisDocument[]): string {
  let maximum = 0;
  for (const item of items) {
    const match = /^Distribution (\d+)$/.exec(item.name);
    if (match) maximum = Math.max(maximum, Number(match[1]));
  }
  return `Distribution ${maximum + 1}`;
}

function nextFitYByXAnalysisName(items: readonly AnalysisDocument[]): string {
  let maximum = 0;
  for (const item of items) {
    const match = /^Fit Y by X (\d+)$/.exec(item.name);
    if (match) maximum = Math.max(maximum, Number(match[1]));
  }
  return `Fit Y by X ${maximum + 1}`;
}

function nextFitModelAnalysisName(items: readonly AnalysisDocument[]): string {
  let maximum = 0;
  for (const item of items) {
    if (item.analysisKind !== "fitModel") continue;
    const match = /^Fit Model (\d+)$/.exec(item.name);
    if (match) maximum = Math.max(maximum, Number.parseInt(match[1], 10));
  }
  return `Fit Model ${maximum + 1}`;
}

function nextHypothesisTestAnalysisName(items: readonly AnalysisDocument[]): string {
  let maximum = 0;
  for (const item of items) {
    if (item.analysisKind !== "hypothesisTest") continue;
    const match = /^Hypothesis Test (\d+)$/.exec(item.name);
    if (match) maximum = Math.max(maximum, Number.parseInt(match[1], 10));
  }
  return `Hypothesis Test ${maximum + 1}`;
}

function defaultAnalysisName(kind: AnalysisKind, items: readonly AnalysisDocument[]): string {
  if (kind === "distribution") return nextDistributionAnalysisName(items);
  if (kind === "fitYByX") return nextFitYByXAnalysisName(items);
  if (kind === "fitModel") return nextFitModelAnalysisName(items);
  return nextHypothesisTestAnalysisName(items);
}

function resolveAnalysisName(
  kind: AnalysisKind,
  requestedName: string | undefined,
  items: readonly AnalysisDocument[],
): string {
  const name = requestedName?.trim() || defaultAnalysisName(kind, items);
  const resolved = resolveProjectBasenameForKind(name, "analysis", items.map((item) => item.name));
  if (resolved.error) {
    throw new CommandExecutionError("invalid_input", `Invalid analysis name: ${resolved.error}`);
  }
  return resolved.basename;
}

function resolveDataset(dependencies: AnalysisCommandDependencies, datasetId: string): DatasetMeta {
  const dataset = dependencies.listDatasets().find((entry) => entry.id === datasetId);
  if (!dataset) {
    throw new CommandExecutionError("not_found", `Dataset ${datasetId} was not found`);
  }
  return dataset;
}

function resolveAnalysis(dependencies: AnalysisCommandDependencies, analysisId: string): AnalysisDocument {
  const analysis = dependencies.listAnalyses().find((entry) => entry.id === analysisId);
  if (!analysis) {
    throw new CommandExecutionError("not_found", `Analysis ${analysisId} was not found`);
  }
  return analysis;
}

function clone<T>(value: T): T {
  return cloneValue(value);
}

function analysisExecutionFingerprint(document: AnalysisDocument): string {
  if (document.analysisKind === "distribution") return analysisExecutors.distribution.fingerprint(document);
  if (document.analysisKind === "fitYByX") return analysisExecutors.fitYByX.fingerprint(document);
  if (document.analysisKind === "fitModel") return analysisExecutors.fitModel.fingerprint(document);
  return analysisExecutors.hypothesisTest.fingerprint(document);
}

function createNextConfigRevision(current: AnalysisDocument, next: AnalysisDocument): number {
  return current.configRevision + (
    analysisExecutionFingerprint(current) === analysisExecutionFingerprint(next)
      ? 0
      : 1
  );
}

function createFitYByXDefinition(
  input: AnalysisUpdateInputByKind["fitYByX"]["draft"],
): FitYByXAnalysisDefinition {
  const item = createFitYByXItem({
    id: "fit-y-by-x-definition",
    name: "Fit Y by X",
    sourceDatasetId: "dataset",
    response: input.response,
    factor: input.factor,
    createdAt: "1970-01-01T00:00:00.000Z",
  });
  return {
    kind: "fitYByX",
    response: clone(input.response),
    factor: clone(input.factor),
    personality: item.personality,
    confidenceLevel: input.confidenceLevel,
  };
}

function createFitModelDefinition(
  input: AnalysisUpdateInputByKind["fitModel"]["draft"],
  current: AnalysisDocumentByKind["fitModel"],
): FitModelAnalysisDefinition {
  return {
    kind: "fitModel",
    response: clone(input.response),
    construct: clone(input.construct),
    terms: clone(input.terms),
    centeringMethod: input.centeringMethod,
    confidenceLevel: input.confidenceLevel ?? current.definition.confidenceLevel,
  };
}

function createAnalysisPatch(current: AnalysisDocument, next: AnalysisDocument): AnalysisDocumentPatch {
  const patch: AnalysisDocumentPatch = {};
  let changed = false;
  if (current.name !== next.name) {
    patch.name = next.name;
    changed = true;
  }
  if (JSON.stringify(current.source) !== JSON.stringify(next.source)) {
    patch.source = clone(next.source);
    changed = true;
  }
  if (JSON.stringify(current.definition) !== JSON.stringify(next.definition)) {
    patch.definition = clone(next.definition);
    changed = true;
  }
  if (JSON.stringify(current.presentation) !== JSON.stringify(next.presentation)) {
    patch.presentation = clone(next.presentation);
    changed = true;
  }
  if (current.configRevision !== next.configRevision) {
    patch.configRevision = next.configRevision;
    changed = true;
  }
  if (!changed) {
    return {};
  }
  patch.updatedAt = next.updatedAt;
  return patch;
}

function hasAnalysisPatchChanges(patch: AnalysisDocumentPatch): boolean {
  return Object.keys(patch).some((key) => key !== "updatedAt");
}

function stringSchema(minLength = 1): AnalysisCommandJsonSchema {
  return { type: "string", minLength };
}

function booleanSchema(): AnalysisCommandJsonSchema {
  return { type: "boolean" };
}

function numberSchema(options: { minimum?: number; maximum?: number } = {}): AnalysisCommandJsonSchema {
  return {
    type: "number",
    ...(options.minimum !== undefined ? { minimum: options.minimum } : {}),
    ...(options.maximum !== undefined ? { maximum: options.maximum } : {}),
  };
}

function enumSchema(values: readonly string[]): AnalysisCommandJsonSchema {
  return { type: "string", enum: [...values] };
}

function arraySchema(
  items: AnalysisCommandJsonSchema,
  options: { minItems?: number; maxItems?: number } = {},
): AnalysisCommandJsonSchema {
  return {
    type: "array",
    items,
    ...(options.minItems !== undefined ? { minItems: options.minItems } : {}),
    ...(options.maxItems !== undefined ? { maxItems: options.maxItems } : {}),
  };
}

function objectSchema(input: {
  required?: string[];
  properties?: Record<string, AnalysisCommandJsonSchema>;
  additionalProperties?: boolean | AnalysisCommandJsonSchema;
}): AnalysisCommandJsonSchema {
  return {
    type: "object",
    ...(input.required ? { required: input.required } : {}),
    ...(input.properties ? { properties: input.properties } : {}),
    ...(input.additionalProperties !== undefined ? { additionalProperties: input.additionalProperties } : {}),
  };
}

function nullableSchema(schema: AnalysisCommandJsonSchema): AnalysisCommandJsonSchema {
  return {
    oneOf: [schema, { type: "null" }],
    type: Array.isArray(schema.type) ? [...schema.type, "null"] : [schema.type, "null"],
  };
}

function fieldRefSchema(): AnalysisCommandJsonSchema {
  return objectSchema({
    required: ["name", "type"],
    properties: {
      columnId: stringSchema(),
      name: stringSchema(),
      type: enumSchema(["continuous", "nominal", "ordinal", "datetime", "id"]),
    },
    additionalProperties: false,
  });
}

function graphSchema(): AnalysisCommandJsonSchema {
  const chartElementSchema = objectSchema({
    required: ["kind", "enabled"],
    properties: {
      kind: enumSchema([
        "points",
        "line",
        "bar",
        "heatmap",
        "correlationMatrix",
        "histogram",
        "normalCurve",
        "boxplot",
        "smoother",
        "fitline",
        "surface",
        "contour3d",
        "scatter3d",
      ]),
      enabled: booleanSchema(),
      options: objectSchema({ additionalProperties: true }),
      correlationMethod: enumSchema(["pearson", "spearman", "kendall"]),
    },
    additionalProperties: false,
  });
  const filterRuleSchema = {
    type: ["object"],
    oneOf: [
      objectSchema({
        required: ["kind", "field", "min", "max"],
        properties: {
          kind: { type: "string", const: "continuous" },
          field: fieldRefSchema(),
          min: nullableSchema(numberSchema()),
          max: nullableSchema(numberSchema()),
        },
        additionalProperties: false,
      }),
      objectSchema({
        required: ["kind", "field", "selected"],
        properties: {
          kind: { type: "string", const: "categorical" },
          field: fieldRefSchema(),
          selected: arraySchema(stringSchema()),
          exclude: booleanSchema(),
        },
        additionalProperties: false,
      }),
      objectSchema({
        required: ["kind", "field", "start", "end"],
        properties: {
          kind: { type: "string", const: "date" },
          field: fieldRefSchema(),
          start: nullableSchema(stringSchema()),
          end: nullableSchema(stringSchema()),
        },
        additionalProperties: false,
      }),
    ],
  } satisfies AnalysisCommandJsonSchema;
  const filterRuleItemSchema = objectSchema({
    required: ["id", "op", "rule"],
    properties: {
      id: stringSchema(),
      op: enumSchema(["AND", "OR"]),
      rule: filterRuleSchema,
      height: numberSchema({ minimum: 0 }),
    },
    additionalProperties: false,
  });
  const twoDEncodingSchema = objectSchema({
    properties: {
      x: fieldRefSchema(),
      y: fieldRefSchema(),
      color: fieldRefSchema(),
      size: fieldRefSchema(),
      overlay: fieldRefSchema(),
      groupX: fieldRefSchema(),
      groupY: fieldRefSchema(),
      wrap: fieldRefSchema(),
    },
    additionalProperties: false,
  });
  const threeDEncodingSchema = objectSchema({
    properties: {
      x: fieldRefSchema(),
      y: fieldRefSchema(),
      z: fieldRefSchema(),
      color: fieldRefSchema(),
      size: fieldRefSchema(),
      overlay: fieldRefSchema(),
      groupX: fieldRefSchema(),
      groupY: fieldRefSchema(),
      groupZ: fieldRefSchema(),
      wrap: fieldRefSchema(),
    },
    additionalProperties: false,
  });
  const axisConfigSchema = objectSchema({
    properties: {
      min: numberSchema(),
      max: numberSchema(),
      tickInterval: numberSchema(),
      decimals: numberSchema({ minimum: 0 }),
      inverse: booleanSchema(),
      minorTickCount: numberSchema({ minimum: 0 }),
      showAxisLine: booleanSchema(),
      tickPosition: enumSchema(["inside", "outside"]),
    },
    additionalProperties: true,
  });
  const refLineSchema = objectSchema({
    required: ["id", "label", "style", "color", "width"],
    properties: {
      id: stringSchema(),
      x: numberSchema(),
      y: numberSchema(),
      label: { type: "string" },
      style: enumSchema(["solid", "dashed", "dotted"]),
      color: stringSchema(),
      width: numberSchema({ minimum: 0 }),
    },
    additionalProperties: false,
  });
  const twoDStateSchema = objectSchema({
    required: ["encoding", "multiX", "multiY", "elements", "smootherLambda"],
    properties: {
      encoding: twoDEncodingSchema,
      transposed: booleanSchema(),
      multiX: arraySchema(fieldRefSchema()),
      multiY: arraySchema(fieldRefSchema()),
      elements: arraySchema(chartElementSchema, { minItems: 1 }),
      smootherLambda: numberSchema(),
      groupStyles: objectSchema({ additionalProperties: true }),
      hiddenGroups: arraySchema(stringSchema()),
      refLinesY: arraySchema(refLineSchema),
      refLinesX: arraySchema(refLineSchema),
      autoSpecLinesY: booleanSchema(),
      autoSpecLinesX: booleanSchema(),
      autoSpecLines: booleanSchema(),
      yAxis: axisConfigSchema,
      xAxis: axisConfigSchema,
    },
    additionalProperties: false,
  });
  const threeDStateSchema = objectSchema({
    required: ["encoding", "elements", "smootherLambda"],
    properties: {
      encoding: threeDEncodingSchema,
      elements: arraySchema(chartElementSchema, { minItems: 1 }),
      smootherLambda: numberSchema(),
      groupStyles: objectSchema({ additionalProperties: true }),
      hiddenGroups: arraySchema(stringSchema()),
    },
    additionalProperties: false,
  });
  const multivariateStateSchema = objectSchema({
    required: ["columns", "chartType", "correlationMethod"],
    properties: {
      columns: arraySchema(fieldRefSchema()),
      chartType: { type: "string", const: "correlationMatrix" },
      correlationMethod: enumSchema(["pearson", "spearman", "kendall"]),
    },
    additionalProperties: false,
  });
  const samplingSchema = {
    type: ["object"],
    oneOf: [
      objectSchema({
        required: ["mode"],
        properties: {
          mode: { type: "string", const: "full" },
        },
        additionalProperties: false,
      }),
      objectSchema({
        required: ["mode", "size", "seed"],
        properties: {
          mode: { type: "string", const: "sample" },
          size: numberSchema({ minimum: 1 }),
          seed: numberSchema({ minimum: 0 }),
        },
        additionalProperties: false,
      }),
    ],
  } satisfies AnalysisCommandJsonSchema;
  return objectSchema({
    required: ["mode", "modeStates"],
    properties: {
      mode: enumSchema(["2d", "3d", "multivariate"]),
      modeStates: objectSchema({
        required: ["twoD", "threeD", "multivariate"],
        properties: {
          twoD: twoDStateSchema,
          threeD: threeDStateSchema,
          multivariate: multivariateStateSchema,
        },
        additionalProperties: false,
      }),
      filters: arraySchema(filterRuleItemSchema),
      sampling: samplingSchema,
      groupThemeSlots: objectSchema({ additionalProperties: true }),
    },
    additionalProperties: false,
  });
}

function creationHistoryMessage(kind: AnalysisKind, name: string, source: string): string {
  if (kind === "fitYByX") {
    return i18n.t("history.newFitYByX", { name, source });
  }
  if (kind === "fitModel") {
    return i18n.t("history.newFitModel", { name, source });
  }
  return i18n.t("history.newAnalysis", { defaultValue: "Created {{name}}", name, source });
}

function updateHistoryMessage(name: string): string {
  return i18n.t("history.updateAnalysisInputs", { name });
}

export function assertRegisteredAnalysisKind(kind: string): asserts kind is AnalysisKind {
  if (!Object.prototype.hasOwnProperty.call(analysisCreateAdapters, kind)) {
    throw new Error(`Unknown analysis kind: ${kind}`);
  }
}

export const analysisCreateAdapters = {
  distribution: {
    async create(input, context) {
      const [columns, displayProps] = await Promise.all([
        context.getColumns(input.sourceDatasetId),
        context.getColumnDisplayProps(input.sourceDatasetId).catch(() => []),
      ]);
      const item: DistributionItem = createDistributionItem({
        id: context.analysisId,
        name: context.name,
        sourceDatasetId: input.sourceDatasetId,
        responses: clone(input.draft.responses),
        weight: clone(input.draft.weight),
        frequency: clone(input.draft.frequency),
        by: clone(input.draft.by),
        nestedSubgroup: clone(input.draft.nestedSubgroup),
        columns: buildDistributionFieldInfo(columns, displayProps),
        analysis: clone(input.draft.analysis ?? createDefaultDistributionAnalysisConfig()),
        createdAt: context.createdAt,
      });
      item.graphs = clone(input.draft.graphs ?? createDefaultDistributionGraphs(item.responses[0]!));
      return createDistributionAnalysisDocument(item, context.createdAt) as AnalysisDocumentByKind["distribution"];
    },
  },
  fitYByX: {
    async create(input, context) {
      const item = createFitYByXItem({
        id: context.analysisId,
        name: context.name,
        sourceDatasetId: input.sourceDatasetId,
        response: input.draft.response,
        factor: input.draft.factor,
        createdAt: context.createdAt,
      });
      if (input.draft.graph) {
        item.graph = clone(input.draft.graph);
      }
      return createFitYByXAnalysisDocument({
        item,
        confidenceLevel: input.draft.confidenceLevel,
        updatedAt: context.createdAt,
      });
    },
  },
  fitModel: {
    async create(input, context) {
      const [columns, displayProps] = await Promise.all([
        context.getColumns(input.sourceDatasetId),
        context.getColumnDisplayProps(input.sourceDatasetId).catch(() => []),
      ]);
      const displayPropsByIndex = new Map(displayProps.map((entry) => [entry.colIndex, entry]));
      const fields = columns.map(([name, sqlType], index) => (
        toFitModelFieldInfo(name, sqlType, displayPropsByIndex.get(index)).field
      ));
      const item = createFitModelItem({
        id: context.analysisId,
        name: context.name,
        sourceDatasetId: input.sourceDatasetId,
        response: input.draft.response,
        construct: clone(input.draft.construct),
        terms: clone(input.draft.terms),
        centeringMethod: input.draft.centeringMethod,
        createdAt: context.createdAt,
        fields,
      });
      return createFitModelAnalysisDocument({
        item,
        confidenceLevel: input.draft.confidenceLevel ?? 0.95,
        updatedAt: context.createdAt,
      });
    },
  },
  hypothesisTest: {
    async create(input, context) {
      return createHypothesisTestAnalysisDocument({
        id: context.analysisId,
        name: context.name,
        sourceDatasetId: input.sourceDatasetId,
        definition: clone(input.draft.definition),
        createdAt: context.createdAt,
      });
    },
  },
} satisfies { [Kind in AnalysisKind]: AnalysisCreateAdapter<Kind> };

export const analysisUpdateValidators = {
  distribution: {
    buildNext(current, input, updatedAt) {
      const nextDefinition = {
        kind: "distribution" as const,
        responses: clone(input.draft.responses),
        weight: clone(input.draft.weight),
        frequency: clone(input.draft.frequency),
        by: clone(input.draft.by),
        nestedSubgroup: clone(input.draft.nestedSubgroup),
        analysis: clone(input.draft.analysis),
        graphs: clone(input.draft.graphs),
      };
      const next = {
        ...current,
        definition: nextDefinition,
        updatedAt,
      } as AnalysisDocumentByKind["distribution"];
      return {
        ...next,
        configRevision: createNextConfigRevision(current, next),
      };
    },
  },
  fitYByX: {
    buildNext(current, input, updatedAt) {
      const nextDefinition = createFitYByXDefinition(input.draft);
      const nextGraph = clone(input.draft.graph ?? current.presentation.graph);
      const definitionChanged = JSON.stringify(current.definition) !== JSON.stringify(nextDefinition);
      const presentationChanged = JSON.stringify(current.presentation.graph) !== JSON.stringify(nextGraph);
      const next = {
        ...current,
        definition: nextDefinition,
        presentation: presentationChanged
          ? { ...current.presentation, graph: nextGraph }
          : current.presentation,
        updatedAt,
      } as AnalysisDocumentByKind["fitYByX"];
      return {
        ...next,
        configRevision: definitionChanged ? createNextConfigRevision(current, next) : current.configRevision,
      };
    },
  },
  fitModel: {
    buildNext(current, input, updatedAt) {
      const nextDefinition = createFitModelDefinition(input.draft, current);
      const next = {
        ...current,
        definition: nextDefinition,
        updatedAt,
      } as AnalysisDocumentByKind["fitModel"];
      return {
        ...next,
        configRevision: createNextConfigRevision(current, next),
      };
    },
  },
  hypothesisTest: {
    buildNext(current, input, updatedAt) {
      const nextDefinition = clone(input.draft.definition);
      const nextPresentation: HypothesisTestAnalysisPresentation = clone(input.draft.presentation ?? current.presentation);
      const definitionChanged = JSON.stringify(current.definition) !== JSON.stringify(nextDefinition);
      const presentationChanged = JSON.stringify(current.presentation) !== JSON.stringify(nextPresentation);
      const next = {
        ...current,
        definition: nextDefinition,
        presentation: presentationChanged ? nextPresentation : current.presentation,
        updatedAt,
      } as AnalysisDocumentByKind["hypothesisTest"];
      return {
        ...next,
        configRevision: definitionChanged ? createNextConfigRevision(current, next) : current.configRevision,
      };
    },
  },
} satisfies { [Kind in AnalysisKind]: AnalysisUpdateValidator<Kind> };

export const analysisCommandSchemas = (() => {
  const specLimitsOverrideSchema = objectSchema({
    required: ["lsl", "target", "usl"],
    properties: {
      lsl: nullableSchema(numberSchema()),
      target: nullableSchema(numberSchema()),
      usl: nullableSchema(numberSchema()),
    },
    additionalProperties: false,
  });
  const distributionConfigSchema = objectSchema({
    required: ["confidenceLevel", "specLimits", "fitAll", "fitDistributions"],
    properties: {
      confidenceLevel: numberSchema(),
      specLimits: objectSchema({ additionalProperties: specLimitsOverrideSchema }),
      fitAll: booleanSchema(),
      fitDistributions: arraySchema(enumSchema(["normal", "lognormal", "exponential", "gamma", "weibull", "cauchy"]), { minItems: 1 }),
    },
    additionalProperties: false,
  });
  const distributionGraphsSchema = objectSchema({
    required: ["overview", "boxPlot", "ecdf", "normalQuantile"],
    properties: {
      overview: graphSchema(),
      boxPlot: graphSchema(),
      ecdf: graphSchema(),
      normalQuantile: graphSchema(),
    },
    additionalProperties: false,
  });
  const distributionDraftCreateSchema = objectSchema({
    required: ["responses", "weight", "frequency", "by", "nestedSubgroup"],
    properties: {
      name: stringSchema(),
      responses: arraySchema(fieldRefSchema(), { minItems: 1 }),
      weight: nullableSchema(fieldRefSchema()),
      frequency: nullableSchema(fieldRefSchema()),
      by: arraySchema(fieldRefSchema()),
      nestedSubgroup: nullableSchema(fieldRefSchema()),
      analysis: distributionConfigSchema,
      graphs: distributionGraphsSchema,
    },
    additionalProperties: false,
  });
  const distributionDraftUpdateSchema = objectSchema({
    required: ["responses", "weight", "frequency", "by", "nestedSubgroup", "analysis", "graphs"],
    properties: {
      responses: arraySchema(fieldRefSchema(), { minItems: 1 }),
      weight: nullableSchema(fieldRefSchema()),
      frequency: nullableSchema(fieldRefSchema()),
      by: arraySchema(fieldRefSchema()),
      nestedSubgroup: nullableSchema(fieldRefSchema()),
      analysis: distributionConfigSchema,
      graphs: distributionGraphsSchema,
    },
    additionalProperties: false,
  });
  const fitYByXDraftCreateSchema = objectSchema({
    required: ["response", "factor", "confidenceLevel"],
    properties: {
      name: stringSchema(),
      response: fieldRefSchema(),
      factor: fieldRefSchema(),
      confidenceLevel: numberSchema(),
      graph: graphSchema(),
    },
    additionalProperties: false,
  });
  const fitYByXDraftUpdateSchema = objectSchema({
    required: ["response", "factor", "confidenceLevel"],
    properties: {
      response: fieldRefSchema(),
      factor: fieldRefSchema(),
      confidenceLevel: numberSchema(),
      graph: graphSchema(),
    },
    additionalProperties: false,
  });
  const fitModelConstructSchema = {
    type: ["object"],
    oneOf: [
      objectSchema({
        required: ["kind"],
        properties: {
          kind: { type: "string", const: "manual" },
        },
        additionalProperties: false,
      }),
      objectSchema({
        required: ["kind"],
        properties: {
          kind: { type: "string", const: "fullFactorial" },
        },
        additionalProperties: false,
      }),
      objectSchema({
        required: ["kind", "degree"],
        properties: {
          kind: { type: "string", const: "factorialToDegree" },
          degree: numberSchema({ minimum: 1 }),
        },
        additionalProperties: false,
      }),
      objectSchema({
        required: ["kind"],
        properties: {
          kind: { type: "string", const: "responseSurface" },
        },
        additionalProperties: false,
      }),
    ],
  } satisfies AnalysisCommandJsonSchema;
  const fitModelTermSchema = {
    type: ["object"],
    oneOf: [
      objectSchema({
        required: ["kind", "columnNames"],
        properties: {
          kind: { type: "string", const: "main" },
          columnNames: arraySchema(stringSchema(), { minItems: 1, maxItems: 1 }),
        },
        additionalProperties: false,
      }),
      objectSchema({
        required: ["kind", "columnNames"],
        properties: {
          kind: { type: "string", const: "interaction" },
          columnNames: arraySchema(stringSchema(), { minItems: 2 }),
        },
        additionalProperties: false,
      }),
      objectSchema({
        required: ["kind", "columnNames", "exponent"],
        properties: {
          kind: { type: "string", const: "power" },
          columnNames: arraySchema(stringSchema(), { minItems: 1, maxItems: 1 }),
          exponent: { type: "number", const: 2 },
        },
        additionalProperties: false,
      }),
    ],
  } satisfies AnalysisCommandJsonSchema;
  const fitModelDraftCreateSchema = objectSchema({
    required: ["response", "construct", "terms", "centeringMethod"],
    properties: {
      name: stringSchema(),
      response: fieldRefSchema(),
      construct: fitModelConstructSchema,
      terms: arraySchema(fitModelTermSchema, { minItems: 1 }),
      centeringMethod: enumSchema(["none", "mean"]),
      confidenceLevel: numberSchema(),
    },
    additionalProperties: false,
  });
  const fitModelDraftUpdateSchema = objectSchema({
    required: ["response", "construct", "terms", "centeringMethod"],
    properties: {
      response: fieldRefSchema(),
      construct: fitModelConstructSchema,
      terms: arraySchema(fitModelTermSchema, { minItems: 1 }),
      centeringMethod: enumSchema(["none", "mean"]),
      confidenceLevel: numberSchema(),
    },
    additionalProperties: false,
  });
  const hypothesisRolesSchema = {
    type: ["object"],
    oneOf: [
      objectSchema({
        required: ["layout", "response", "condition", "subject"],
        properties: {
          layout: { type: "string", const: "long" },
          response: fieldRefSchema(),
          condition: fieldRefSchema(),
          subject: nullableSchema(fieldRefSchema()),
        },
        additionalProperties: false,
      }),
      objectSchema({
        required: ["layout", "measurements", "subject"],
        properties: {
          layout: { type: "string", const: "wide" },
          measurements: arraySchema(fieldRefSchema(), { minItems: 1 }),
          subject: nullableSchema(fieldRefSchema()),
        },
        additionalProperties: false,
      }),
    ],
  } satisfies AnalysisCommandJsonSchema;
  const hypothesisManualSelectionSchema = nullableSchema(objectSchema({
    required: ["methodId", "reason"],
    properties: {
      methodId: enumSchema([
        "studentTwoSampleT",
        "welchTwoSampleT",
        "mannWhitneyU",
        "oneWayAnova",
        "welchAnova",
        "kruskalWallis",
        "pairedT",
        "wilcoxonSignedRank",
        "randomizedBlockAnova",
        "friedman",
      ]),
      reason: nullableSchema(stringSchema()),
    },
    additionalProperties: false,
  }));
  const hypothesisDefinitionSchema = objectSchema({
    required: [
      "kind",
      "roles",
      "studyDesign",
      "selectionMode",
      "manualSelection",
      "alternative",
      "alpha",
      "confidenceLevel",
      "levelOrder",
      "referenceLevel",
      "postHoc",
      "selectorVersion",
    ],
    properties: {
      kind: { type: "string", const: "hypothesisTest" },
      roles: hypothesisRolesSchema,
      studyDesign: enumSchema(["independent", "pairedOrBlocked"]),
      selectionMode: enumSchema(["automatic", "guided", "manual"]),
      manualSelection: hypothesisManualSelectionSchema,
      alternative: enumSchema(["twoSided", "less", "greater"]),
      alpha: numberSchema({ minimum: 0, maximum: 1 }),
      confidenceLevel: numberSchema({ minimum: 0, maximum: 1 }),
      levelOrder: arraySchema(stringSchema()),
      referenceLevel: nullableSchema(stringSchema()),
      postHoc: enumSchema(["automatic", "off"]),
      selectorVersion: { type: "string", const: "1" },
    },
    additionalProperties: false,
  });
  const hypothesisPresentationSchema = objectSchema({
    required: ["schemaVersion", "layout", "activeResultTab", "collapsedSections", "graphs", "tableSort"],
    properties: {
      schemaVersion: { type: "number", const: 1 },
      layout: { type: "string", const: "hypothesis-test-v1" },
      activeResultTab: enumSchema(["results", "diagnostics", "audit"]),
      collapsedSections: arraySchema(enumSchema(["methodEvidence", "sensitivity", "postHoc", "exclusions", "audit"])),
      graphs: objectSchema({
        required: ["showRawData", "showIntervals", "showDiagnostics"],
        properties: {
          showRawData: booleanSchema(),
          showIntervals: booleanSchema(),
          showDiagnostics: booleanSchema(),
        },
        additionalProperties: false,
      }),
      tableSort: nullableSchema(objectSchema({
        required: ["key", "direction"],
        properties: {
          key: stringSchema(),
          direction: enumSchema(["ascending", "descending"]),
        },
        additionalProperties: false,
      })),
    },
    additionalProperties: false,
  });
  return {
    distribution: {
      analysisKind: "distribution",
      supportsGraphPresentation: true,
      supportsReportEmbedding: true,
      create: objectSchema({
        required: ["analysisKind", "sourceDatasetId", "draft"],
        properties: {
          analysisKind: { type: "string", const: "distribution" },
          sourceDatasetId: stringSchema(),
          draft: distributionDraftCreateSchema,
        },
        additionalProperties: false,
      }),
      update: objectSchema({
        required: ["analysisId", "analysisKind", "expectedConfigRevision", "draft"],
        properties: {
          analysisId: stringSchema(),
          analysisKind: { type: "string", const: "distribution" },
          expectedConfigRevision: numberSchema(),
          draft: distributionDraftUpdateSchema,
        },
        additionalProperties: false,
      }),
      run: objectSchema({
        required: ["analysisId"],
        properties: {
          analysisId: stringSchema(),
        },
        additionalProperties: false,
      }),
    },
    fitYByX: {
      analysisKind: "fitYByX",
      supportsGraphPresentation: true,
      supportsReportEmbedding: true,
      create: objectSchema({
        required: ["analysisKind", "sourceDatasetId", "draft"],
        properties: {
          analysisKind: { type: "string", const: "fitYByX" },
          sourceDatasetId: stringSchema(),
          draft: fitYByXDraftCreateSchema,
        },
        additionalProperties: false,
      }),
      update: objectSchema({
        required: ["analysisId", "analysisKind", "expectedConfigRevision", "draft"],
        properties: {
          analysisId: stringSchema(),
          analysisKind: { type: "string", const: "fitYByX" },
          expectedConfigRevision: numberSchema(),
          draft: fitYByXDraftUpdateSchema,
        },
        additionalProperties: false,
      }),
      run: objectSchema({
        required: ["analysisId"],
        properties: {
          analysisId: stringSchema(),
        },
        additionalProperties: false,
      }),
    },
    fitModel: {
      analysisKind: "fitModel",
      supportsGraphPresentation: false,
      supportsReportEmbedding: false,
      create: objectSchema({
        required: ["analysisKind", "sourceDatasetId", "draft"],
        properties: {
          analysisKind: { type: "string", const: "fitModel" },
          sourceDatasetId: stringSchema(),
          draft: fitModelDraftCreateSchema,
        },
        additionalProperties: false,
      }),
      update: objectSchema({
        required: ["analysisId", "analysisKind", "expectedConfigRevision", "draft"],
        properties: {
          analysisId: stringSchema(),
          analysisKind: { type: "string", const: "fitModel" },
          expectedConfigRevision: numberSchema(),
          draft: fitModelDraftUpdateSchema,
        },
        additionalProperties: false,
      }),
      run: objectSchema({
        required: ["analysisId"],
        properties: {
          analysisId: stringSchema(),
        },
        additionalProperties: false,
      }),
    },
    hypothesisTest: {
      analysisKind: "hypothesisTest",
      supportsGraphPresentation: false,
      supportsReportEmbedding: true,
      create: objectSchema({
        required: ["analysisKind", "sourceDatasetId", "draft"],
        properties: {
          analysisKind: { type: "string", const: "hypothesisTest" },
          sourceDatasetId: stringSchema(),
          draft: objectSchema({
            required: ["definition"],
            properties: {
              name: stringSchema(),
              definition: hypothesisDefinitionSchema,
            },
            additionalProperties: false,
          }),
        },
        additionalProperties: false,
      }),
      update: objectSchema({
        required: ["analysisId", "analysisKind", "expectedConfigRevision", "draft"],
        properties: {
          analysisId: stringSchema(),
          analysisKind: { type: "string", const: "hypothesisTest" },
          expectedConfigRevision: numberSchema(),
          draft: objectSchema({
            required: ["definition"],
            properties: {
              definition: hypothesisDefinitionSchema,
              presentation: hypothesisPresentationSchema,
            },
            additionalProperties: false,
          }),
        },
        additionalProperties: false,
      }),
      run: objectSchema({
        required: ["analysisId"],
        properties: {
          analysisId: stringSchema(),
        },
        additionalProperties: false,
      }),
    },
  } satisfies { [Kind in AnalysisKind]: AnalysisCommandSchema<Kind> };
})();

export const analysisCommandFixtures = {
  distribution: {
    analysisKind: "distribution",
    create: {
      analysisKind: "distribution",
      sourceDatasetId: "dataset-1",
      draft: {
        responses: [{ name: "DIM1", type: "continuous" }],
        weight: null,
        frequency: null,
        by: [],
        nestedSubgroup: null,
        analysis: {
          confidenceLevel: 0.95,
          specLimits: {},
          fitAll: false,
          fitDistributions: ["normal"],
        },
        graphs: {
          overview: createDefaultFitYByXGraphConfig({
            response: { name: "DIM1", type: "continuous" },
            factor: { name: "DIM1", type: "continuous" },
          }),
          boxPlot: createDefaultFitYByXGraphConfig({
            response: { name: "DIM1", type: "continuous" },
            factor: { name: "DIM1", type: "continuous" },
          }),
          ecdf: createDefaultFitYByXGraphConfig({
            response: { name: "DIM1", type: "continuous" },
            factor: { name: "DIM1", type: "continuous" },
          }),
          normalQuantile: createDefaultFitYByXGraphConfig({
            response: { name: "DIM1", type: "continuous" },
            factor: { name: "DIM1", type: "continuous" },
          }),
        },
      },
    },
    update: (analysisId, expectedConfigRevision) => ({
      analysisId,
      analysisKind: "distribution",
      expectedConfigRevision,
      draft: {
        responses: [{ name: "DIM2", type: "continuous" }],
        weight: null,
        frequency: null,
        by: [],
        nestedSubgroup: null,
        analysis: {
          confidenceLevel: 0.9,
          specLimits: {},
          fitAll: false,
          fitDistributions: ["normal"],
        },
        graphs: {
          overview: createDefaultFitYByXGraphConfig({
            response: { name: "DIM2", type: "continuous" },
            factor: { name: "DIM2", type: "continuous" },
          }),
          boxPlot: createDefaultFitYByXGraphConfig({
            response: { name: "DIM2", type: "continuous" },
            factor: { name: "DIM2", type: "continuous" },
          }),
          ecdf: createDefaultFitYByXGraphConfig({
            response: { name: "DIM2", type: "continuous" },
            factor: { name: "DIM2", type: "continuous" },
          }),
          normalQuantile: createDefaultFitYByXGraphConfig({
            response: { name: "DIM2", type: "continuous" },
            factor: { name: "DIM2", type: "continuous" },
          }),
        },
      },
    }),
    run: (analysisId) => ({ analysisId }),
  },
  fitYByX: {
    analysisKind: "fitYByX",
    create: {
      analysisKind: "fitYByX",
      sourceDatasetId: "dataset-1",
      draft: {
        response: { name: "Strength", type: "continuous" },
        factor: { name: "Site", type: "nominal" },
        confidenceLevel: 0.95,
      },
    },
    update: (analysisId, expectedConfigRevision) => ({
      analysisId,
      analysisKind: "fitYByX",
      expectedConfigRevision,
      draft: {
        response: { name: "Strength", type: "continuous" },
        factor: { name: "Temperature", type: "continuous" },
        confidenceLevel: 0.9,
      },
    }),
    run: (analysisId) => ({ analysisId }),
  },
  fitModel: {
    analysisKind: "fitModel",
    create: {
      analysisKind: "fitModel",
      sourceDatasetId: "dataset-1",
      draft: {
        response: { name: "Strength", type: "continuous" },
        construct: { kind: "responseSurface" },
        terms: [
          { kind: "main", columnNames: ["Temperature"] },
          { kind: "power", columnNames: ["Temperature"], exponent: 2 },
        ],
        centeringMethod: "mean",
        confidenceLevel: 0.95,
      },
    },
    update: (analysisId, expectedConfigRevision) => ({
      analysisId,
      analysisKind: "fitModel",
      expectedConfigRevision,
      draft: {
        response: { name: "Strength", type: "continuous" },
        construct: { kind: "manual" },
        terms: [{ kind: "main", columnNames: ["Pressure"] }],
        centeringMethod: "none",
        confidenceLevel: 0.9,
      },
    }),
    run: (analysisId) => ({ analysisId }),
  },
  hypothesisTest: {
    analysisKind: "hypothesisTest",
    create: {
      analysisKind: "hypothesisTest",
      sourceDatasetId: "dataset-1",
      draft: {
        definition: {
          kind: "hypothesisTest",
          roles: {
            layout: "long",
            response: { name: "Strength", type: "continuous" },
            condition: { name: "Site", type: "nominal" },
            subject: null,
          },
          studyDesign: "independent",
          selectionMode: "automatic",
          manualSelection: null,
          alternative: "twoSided",
          alpha: 0.05,
          confidenceLevel: 0.95,
          levelOrder: [],
          referenceLevel: null,
          postHoc: "automatic",
          selectorVersion: "1",
        },
      },
    },
    update: (analysisId, expectedConfigRevision) => ({
      analysisId,
      analysisKind: "hypothesisTest",
      expectedConfigRevision,
      draft: {
        definition: {
          kind: "hypothesisTest",
          roles: {
            layout: "long",
            response: { name: "Strength", type: "continuous" },
            condition: { name: "Site", type: "nominal" },
            subject: null,
          },
          studyDesign: "independent",
          selectionMode: "manual",
          manualSelection: { methodId: "studentTwoSampleT", reason: null },
          alternative: "twoSided",
          alpha: 0.05,
          confidenceLevel: 0.9,
          levelOrder: ["A", "B"],
          referenceLevel: "A",
          postHoc: "off",
          selectorVersion: "1",
        },
      },
    }),
    run: (analysisId) => ({ analysisId }),
  },
} satisfies { [Kind in AnalysisKind]: AnalysisCommandFixture<Kind> };

export function createAnalysisCommandHandlers(
  dependencies: Partial<AnalysisCommandDependencies> = {},
) {
  const resolvedDependencies: AnalysisCommandDependencies = {
    listDatasets: () => useDataStore.getState().datasets,
    listAnalyses: () => useAnalysisStore.getState().items,
    createAnalysisId: () => (
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `analysis-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    ),
    createNowIso: () => new Date().toISOString(),
    getColumns: (datasetId) => dataService.getColumns(datasetId),
    getColumnDisplayProps: (datasetId) => dataService.getColumnDisplayProps(datasetId),
    addAnalysis: (analysis) => useAnalysisStore.getState().addAnalysis(analysis),
    updateAnalysis: (id, patch) => useAnalysisStore.getState().updateAnalysis(id, patch),
    activateAnalysis: (analysisId) => {
      useWorkspaceSelectionStore.getState().load(selectWorkspaceDocument("analysis", analysisId));
      useDataStore.getState().setActiveDataset(null);
    },
    markDirty: () => useProjectStore.getState().markDirty(),
    recordAction: (description) => useHistoryStore.getState().record(description),
    getCurrentAnalysis: (analysisId) => useAnalysisStore.getState().items.find((item) => item.id === analysisId) ?? null,
    getCurrentDataset: (datasetId) => useDataStore.getState().datasets.find((item) => item.id === datasetId) ?? null,
    executionRuntime: {
      getDatasetGeneration: (datasetId) => dataService.getDatasetGeneration(datasetId),
      getCurrentAnalysis: () => null,
      getCurrentDataset: () => null,
    },
    ...dependencies,
  };

  async function create(
    input: AnalysisCreateInput,
    controls?: { beginCommit?: () => void },
  ): Promise<AnalysisCommandResult> {
    assertRegisteredAnalysisKind(input.analysisKind);
    const dataset = resolveDataset(resolvedDependencies, input.sourceDatasetId);
    const name = resolveAnalysisName(
      input.analysisKind,
      input.draft.name,
      resolvedDependencies.listAnalyses(),
    );
    const createdAt = resolvedDependencies.createNowIso();
    const item = await analysisCreateAdapters[input.analysisKind].create(input as never, {
      analysisId: resolvedDependencies.createAnalysisId(),
      name,
      sourceDatasetId: dataset.id,
      createdAt,
      getColumns: resolvedDependencies.getColumns,
      getColumnDisplayProps: resolvedDependencies.getColumnDisplayProps,
    });
    const source = dataset.name;

    controls?.beginCommit?.();
    resolvedDependencies.addAnalysis(item);
    resolvedDependencies.activateAnalysis(item.id);
    resolvedDependencies.markDirty();
    resolvedDependencies.recordAction(creationHistoryMessage(item.analysisKind, item.name, source));

    return { item };
  }

  function update(
    input: AnalysisUpdateInput,
    controls?: { beginCommit?: () => void },
  ): { changed: boolean; data: AnalysisCommandResult } {
    const current = normalizePersistedAnalysisDocument(resolveAnalysis(resolvedDependencies, input.analysisId));
    assertRegisteredAnalysisKind(input.analysisKind);
    if (current.analysisKind !== input.analysisKind) {
      throw new CommandExecutionError("invalid_input", "analysisKind must match the persisted document");
    }
    if (current.configRevision !== input.expectedConfigRevision) {
      throw new CommandExecutionError("revision_conflict", "Analysis config revision does not match expected revision", false, {
        id: input.analysisId,
        expected: input.expectedConfigRevision,
        actual: current.configRevision,
      });
    }

    const next = normalizePersistedAnalysisDocument(
      analysisUpdateValidators[input.analysisKind].buildNext(
        current as never,
        input as never,
        resolvedDependencies.createNowIso(),
      ) as AnalysisDocument,
    );
    const patch = createAnalysisPatch(current, next);
    if (!hasAnalysisPatchChanges(patch)) {
      return { changed: false, data: { item: current } };
    }

    controls?.beginCommit?.();
    resolvedDependencies.updateAnalysis(current.id, patch);
    resolvedDependencies.markDirty();
    resolvedDependencies.recordAction(updateHistoryMessage(next.name));

    return { changed: true, data: { item: next } };
  }

  async function run(
    input: AnalysisRunInput,
    controls?: { signal?: AbortSignal },
  ): Promise<AnalysisRunResult> {
    const item = normalizePersistedAnalysisDocument(resolveAnalysis(resolvedDependencies, input.analysisId));
    const dataset = resolveDataset(resolvedDependencies, item.source.datasetId);
    const state = (await executeAnalysisWithFence(item, dataset, {
      ...resolvedDependencies.executionRuntime,
      signal: controls?.signal,
      getCurrentAnalysis: () => resolvedDependencies.getCurrentAnalysis(item.id),
      getCurrentDataset: () => resolvedDependencies.getCurrentDataset(dataset.id),
    })).state;
    return { item, definition: clone(item.definition), dataset, state };
  }

  return { create, update, run };
}