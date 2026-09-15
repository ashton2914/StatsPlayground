import { selectWorkspaceDocument } from "@/components/analysis/analysisWorkspaceLifecycle";
import {
  createDefaultGraph2DState,
  createDefaultGraph3DState,
  createDefaultMultivariateGraphState,
} from "@/components/graphBuilder/graphBuilderMode";
import { CommandExecutionError } from "@/applicationCommands/runtime";
import type {
  GraphCommandResult,
  GraphCreateInput,
  GraphUpdateInput,
} from "@/applicationCommands/types";
import i18n from "@/i18n";
import { useDataStore } from "@/stores/useDataStore";
import { normalizeStoredGraphBuilderItem, useGraphBuilderStore } from "@/stores/useGraphBuilderStore";
import { useHistoryStore } from "@/stores/useHistoryStore";
import { useProjectStore } from "@/stores/useProjectStore";
import { useWorkspaceSelectionStore } from "@/stores/useWorkspaceSelectionStore";
import type { DatasetMeta } from "@/types/data";
import type { GraphBuilderItem } from "@/types/graphBuilder";
import { allocateProjectBasename } from "@/utils/projectFileNaming";

const GRAPH_EXTENSION = ".spgh";

export interface GraphCommandDependencies {
  listDatasets: () => DatasetMeta[];
  listGraphs: () => GraphBuilderItem[];
  listGraphNamesForAllocation: () => string[];
  createGraphId: () => string;
  createNowIso: () => string;
  addGraph: (item: GraphBuilderItem) => void;
  replaceGraph: (item: GraphBuilderItem) => void;
  getDocumentRevision: (graphId: string) => number;
  setDocumentRevision: (graphId: string, revision: number) => void;
  activateGraph: (graphId: string) => void;
  markDirty: () => void;
  recordAction: (description: string) => void;
  historyCreateMessage: (name: string, sourceName: string) => string;
  historyUpdateMessage: (name: string) => string;
  normalizeGraph: (item: GraphBuilderItem) => GraphBuilderItem;
}

function resolveDataset(dependencies: GraphCommandDependencies, datasetId: string): DatasetMeta {
  const dataset = dependencies.listDatasets().find((entry) => entry.id === datasetId);
  if (!dataset) {
    throw new CommandExecutionError("not_found", `Dataset ${datasetId} was not found`);
  }
  return dataset;
}

function resolveGraph(dependencies: GraphCommandDependencies, graphId: string): GraphBuilderItem {
  const graph = dependencies.listGraphs().find((entry) => entry.id === graphId);
  if (!graph) {
    throw new CommandExecutionError("not_found", `Graph ${graphId} was not found`);
  }
  return graph;
}

function allocateGraphName(dependencies: GraphCommandDependencies, dataset: DatasetMeta): string {
  const prefix = `${dataset.name} - Graph`;
  const perDatasetMax = dependencies.listGraphs()
    .filter((entry) => entry.sourceDatasetId === dataset.id)
    .reduce((maximum, entry) => {
      if (!entry.name.startsWith(prefix)) {
        return maximum;
      }
      const suffix = Number.parseInt(entry.name.slice(prefix.length), 10);
      return Number.isFinite(suffix) && suffix > maximum ? suffix : maximum;
    }, 0);
  return allocateProjectBasename(
    `${dataset.name} - Graph${perDatasetMax + 1}`,
    GRAPH_EXTENSION,
    dependencies.listGraphNamesForAllocation(),
  );
}

function assertDocumentRevision(
  currentRevision: number,
  expectedRevision: number,
  id: string,
): void {
  if (expectedRevision !== currentRevision) {
    throw new CommandExecutionError("revision_conflict", "Graph revision does not match expected revision", false, {
      id,
      expected: expectedRevision,
      actual: currentRevision,
    });
  }
}

export function createGraphCommandHandlers(
  dependencies: Partial<GraphCommandDependencies> = {},
) {
  const resolvedDependencies: GraphCommandDependencies = {
    listDatasets: () => useDataStore.getState().datasets,
    listGraphs: () => useGraphBuilderStore.getState().items,
    listGraphNamesForAllocation: () => useGraphBuilderStore.getState().items.map((item) => item.name),
    createGraphId: () => (
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `gb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    ),
    createNowIso: () => new Date().toISOString(),
    addGraph: (item) => useGraphBuilderStore.getState().addItem(item),
    replaceGraph: (item) => useGraphBuilderStore.getState().replaceItem(item),
    getDocumentRevision: (graphId) => useGraphBuilderStore.getState().getDocumentRevision(graphId),
    setDocumentRevision: (graphId, revision) => useGraphBuilderStore.getState().setDocumentRevision(graphId, revision),
    activateGraph: (graphId) => {
      useWorkspaceSelectionStore.getState().load(selectWorkspaceDocument("graph", graphId));
      useDataStore.getState().setActiveDataset(null);
    },
    markDirty: () => useProjectStore.getState().markDirty(),
    recordAction: (description) => useHistoryStore.getState().record(description),
    historyCreateMessage: (name, sourceName) => i18n.t("history.newGraph", { name, source: sourceName }),
    historyUpdateMessage: (name) => i18n.t("history.editGraph", {
      defaultValue: 'Edit graph "{{name}}"',
      name,
    }),
    normalizeGraph: normalizeStoredGraphBuilderItem,
    ...dependencies,
  };

  function create(
    input: GraphCreateInput,
    controls?: { beginCommit?: () => void },
  ): GraphCommandResult {
    if (!input.sourceDatasetId) {
      throw new CommandExecutionError("invalid_input", "sourceDatasetId is required");
    }

    const dataset = resolveDataset(resolvedDependencies, input.sourceDatasetId);
    const item = resolvedDependencies.normalizeGraph({
      id: resolvedDependencies.createGraphId(),
      name: allocateGraphName(resolvedDependencies, dataset),
      sourceDatasetId: dataset.id,
      mode: "2d",
      modeStates: {
        twoD: createDefaultGraph2DState(),
        threeD: createDefaultGraph3DState(),
        multivariate: createDefaultMultivariateGraphState(),
      },
      createdAt: resolvedDependencies.createNowIso(),
    });

    controls?.beginCommit?.();
    resolvedDependencies.addGraph(item);
    resolvedDependencies.setDocumentRevision(item.id, 1);
    resolvedDependencies.activateGraph(item.id);
    resolvedDependencies.markDirty();
    resolvedDependencies.recordAction(resolvedDependencies.historyCreateMessage(item.name, dataset.name));

    return { item, documentRevision: 1 };
  }

  function update(
    input: GraphUpdateInput,
    controls?: { beginCommit?: () => void },
  ): { changed: boolean; data: GraphCommandResult } {
    if (!input.graphId) {
      throw new CommandExecutionError("invalid_input", "graphId is required");
    }
    if (input.definition.id !== input.graphId) {
      throw new CommandExecutionError("invalid_input", "graphId must match definition.id");
    }

    const current = resolveGraph(resolvedDependencies, input.graphId);
    const currentRevision = resolvedDependencies.getDocumentRevision(input.graphId);
    assertDocumentRevision(currentRevision, input.expectedDocumentRevision, input.graphId);
    resolveDataset(resolvedDependencies, input.definition.sourceDatasetId);

    const next = resolvedDependencies.normalizeGraph(input.definition);
    if (JSON.stringify(current) === JSON.stringify(next)) {
      return {
        changed: false,
        data: {
          item: current,
          documentRevision: currentRevision,
        },
      };
    }

    controls?.beginCommit?.();
    resolvedDependencies.replaceGraph(next);
    resolvedDependencies.setDocumentRevision(input.graphId, currentRevision + 1);
    resolvedDependencies.markDirty();
    resolvedDependencies.recordAction(resolvedDependencies.historyUpdateMessage(next.name));

    return {
      changed: true,
      data: {
        item: next,
        documentRevision: currentRevision + 1,
      },
    };
  }

  return { create, update };
}