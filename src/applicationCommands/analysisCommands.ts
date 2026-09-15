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
import { selectWorkspaceDocument } from "@/components/analysis/analysisWorkspaceLifecycle";
import { createDefaultFitYByXGraphConfig, createFitYByXItem } from "@/components/fitYByX/fitYByXConfig";
import { createFitModelItem, toFitModelFieldInfo } from "@/components/fitModel";
import i18n from "@/i18n";
import { dataService } from "@/services/dataService";
import { buildDistributionFieldInfo } from "@/components/tablePropertyManagerRequest";
import { useAnalysisStore } from "@/stores/useAnalysisStore";
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
  return structuredClone(value);
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
  const patch: AnalysisDocumentPatch = {
    updatedAt: next.updatedAt,
  };
  if (current.name !== next.name) patch.name = next.name;
  if (JSON.stringify(current.source) !== JSON.stringify(next.source)) patch.source = clone(next.source);
  if (JSON.stringify(current.definition) !== JSON.stringify(next.definition)) patch.definition = clone(next.definition);
  if (JSON.stringify(current.presentation) !== JSON.stringify(next.presentation)) patch.presentation = clone(next.presentation);
  if (current.configRevision !== next.configRevision) patch.configRevision = next.configRevision;
  return patch;
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
  if (!(kind in analysisCreateAdapters)) {
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
      const definitionChanged = JSON.stringify(current.definition) !== JSON.stringify(nextDefinition);
      return {
        ...current,
        definition: nextDefinition,
        updatedAt,
        configRevision: current.configRevision + (definitionChanged ? 1 : 0),
      };
    },
  },
  fitYByX: {
    buildNext(current, input, updatedAt) {
      const nextDefinition = createFitYByXDefinition(input.draft);
      const nextGraph = clone(input.draft.graph ?? current.presentation.graph);
      const definitionChanged = JSON.stringify(current.definition) !== JSON.stringify(nextDefinition);
      const presentationChanged = JSON.stringify(current.presentation.graph) !== JSON.stringify(nextGraph);
      return {
        ...current,
        definition: nextDefinition,
        presentation: presentationChanged
          ? { ...current.presentation, graph: nextGraph }
          : current.presentation,
        updatedAt,
        configRevision: current.configRevision + (definitionChanged ? 1 : 0),
      };
    },
  },
  fitModel: {
    buildNext(current, input, updatedAt) {
      const nextDefinition = createFitModelDefinition(input.draft, current);
      const definitionChanged = JSON.stringify(current.definition) !== JSON.stringify(nextDefinition);
      return {
        ...current,
        definition: nextDefinition,
        updatedAt,
        configRevision: current.configRevision + (definitionChanged ? 1 : 0),
      };
    },
  },
  hypothesisTest: {
    buildNext(current, input, updatedAt) {
      const nextDefinition = clone(input.draft.definition);
      const nextPresentation: HypothesisTestAnalysisPresentation = clone(input.draft.presentation ?? current.presentation);
      const definitionChanged = JSON.stringify(current.definition) !== JSON.stringify(nextDefinition);
      const presentationChanged = JSON.stringify(current.presentation) !== JSON.stringify(nextPresentation);
      return {
        ...current,
        definition: nextDefinition,
        presentation: presentationChanged ? nextPresentation : current.presentation,
        updatedAt,
        configRevision: current.configRevision + (definitionChanged ? 1 : 0),
      };
    },
  },
} satisfies { [Kind in AnalysisKind]: AnalysisUpdateValidator<Kind> };

export const analysisCommandSchemas = {
  distribution: {
    analysisKind: "distribution",
    supportsGraphPresentation: true,
    supportsReportEmbedding: true,
  },
  fitYByX: {
    analysisKind: "fitYByX",
    supportsGraphPresentation: true,
    supportsReportEmbedding: true,
  },
  fitModel: {
    analysisKind: "fitModel",
    supportsGraphPresentation: false,
    supportsReportEmbedding: false,
  },
  hypothesisTest: {
    analysisKind: "hypothesisTest",
    supportsGraphPresentation: false,
    supportsReportEmbedding: true,
  },
} satisfies { [Kind in AnalysisKind]: AnalysisCommandSchema<Kind> };

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
    const current = resolveAnalysis(resolvedDependencies, input.analysisId);
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

    const next = analysisUpdateValidators[input.analysisKind].buildNext(current as never, input as never, resolvedDependencies.createNowIso()) as AnalysisDocument;
    if (JSON.stringify(current) === JSON.stringify(next)) {
      return { changed: false, data: { item: current } };
    }

    controls?.beginCommit?.();
    resolvedDependencies.updateAnalysis(current.id, createAnalysisPatch(current, next));
    resolvedDependencies.markDirty();
    resolvedDependencies.recordAction(updateHistoryMessage(next.name));

    return { changed: true, data: { item: next } };
  }

  async function run(input: AnalysisRunInput): Promise<AnalysisRunResult> {
    const item = resolveAnalysis(resolvedDependencies, input.analysisId);
    const dataset = resolveDataset(resolvedDependencies, item.source.datasetId);
    const state = (await executeAnalysisWithFence(item, dataset, {
      ...resolvedDependencies.executionRuntime,
      getCurrentAnalysis: () => resolvedDependencies.getCurrentAnalysis(item.id),
      getCurrentDataset: () => resolvedDependencies.getCurrentDataset(dataset.id),
    })).state;
    return { item, dataset, state };
  }

  return { create, update, run };
}