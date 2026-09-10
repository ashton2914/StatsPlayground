import { create } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";

import {
  tableTransformService,
  type TableTransformServiceClient,
} from "@/services/tableTransformService";
import { useWorkflowStore } from "@/stores/useWorkflowStore";
import type {
  TableTransformBindingState,
  TableTransformCommandResult,
  TableTransformDefinition,
  TableTransformDraft,
  TableTransformExecutionResult,
  TableTransformProjectBinding,
} from "@/types/tableTransform";
import type { ProjectLineageGraph } from "@/types/workflow";

export interface TableTransformStore {
  definitions: TableTransformDefinition[];
  bindings: TableTransformBindingState[];
  pendingById: Record<string, number>;
  loadFromProject: (
    definitions: TableTransformDefinition[],
    bindings: TableTransformProjectBinding[],
  ) => void;
  createAndRun: (
    draft: TableTransformDraft,
  ) => Promise<TableTransformExecutionResult>;
  rebindAndRun: (
    transformId: string,
    role: string,
    tableDocumentId: string,
  ) => Promise<TableTransformExecutionResult>;
  rerun: (transformId: string) => Promise<TableTransformExecutionResult>;
  remove: (transformId: string) => void;
  reset: () => void;
}

interface TableTransformStoreDependencies {
  service: TableTransformServiceClient;
  getLineage: () => ProjectLineageGraph;
  setLineage: (lineage: ProjectLineageGraph) => void;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function findDefinition(state: TableTransformStore, transformId: string): TableTransformDefinition {
  const definition = state.definitions.find((item) => item.id === transformId);
  if (!definition) throw new Error(`Unknown table transform: ${transformId}`);
  return definition;
}

function findBinding(state: TableTransformStore, transformId: string): TableTransformBindingState {
  const binding = state.bindings.find((item) => item.definitionId === transformId);
  if (!binding) throw new Error(`Missing table transform binding: ${transformId}`);
  return binding;
}

function stateCreator(
  dependencies: TableTransformStoreDependencies,
): (set: StoreApi<TableTransformStore>["setState"], get: StoreApi<TableTransformStore>["getState"]) => TableTransformStore {
  return (set, get) => {
    const beginRequest = (transformId: string): number => {
      const token = (get().pendingById[transformId] ?? 0) + 1;
      set((state) => ({ pendingById: { ...state.pendingById, [transformId]: token } }));
      return token;
    };

    const applyResult = (
      result: TableTransformCommandResult,
      token: number,
      requestKey: string,
    ): TableTransformExecutionResult => {
      if (get().pendingById[requestKey] !== token) return result.execution;
      const definition = result.definition;
      dependencies.setLineage(clone(result.lineageGraph));
      set((state) => ({
        definitions: state.definitions.some((item) => item.id === definition.id)
          ? state.definitions.map((item) => item.id === definition.id ? clone(definition) : item)
          : [...state.definitions, clone(definition)],
        bindings: [
          ...state.bindings.filter((item) => item.definitionId !== definition.id),
          {
            ...clone(result.execution.binding),
            lastRun: clone(result.execution.runState),
            schemaReports: clone(result.execution.schemaReports),
          },
        ],
      }));
      return result.execution;
    };

    return {
      definitions: [],
      bindings: [],
      pendingById: {},
      loadFromProject: (definitions, bindings) => set({
        definitions: clone(definitions),
        bindings: clone(bindings),
        pendingById: {},
      }),
      createAndRun: async (draft) => {
        const requestKey = `create:${draft.name}`;
        const token = beginRequest(requestKey);
        const result = await dependencies.service.createAndRun(
          clone(draft),
          clone(dependencies.getLineage()),
        );
        return applyResult(result, token, requestKey);
      },
      rebindAndRun: async (transformId, role, tableDocumentId) => {
        const definition = findDefinition(get(), transformId);
        const binding = findBinding(get(), transformId);
        const inputs = binding.inputs.map((input) => input.role === role
          ? { ...input, tableDocumentId }
          : input);
        if (!inputs.some((input) => input.role === role)) {
          throw new Error(`Unknown table transform input role: ${role}`);
        }
        const token = beginRequest(transformId);
        const result = await dependencies.service.rebindAndRun(
          clone(definition),
          clone(binding),
          clone(inputs),
          clone(dependencies.getLineage()),
        );
        return applyResult(result, token, transformId);
      },
      rerun: async (transformId) => {
        const definition = findDefinition(get(), transformId);
        const binding = findBinding(get(), transformId);
        const token = beginRequest(transformId);
        const result = await dependencies.service.run(
          clone(definition),
          clone(binding),
          clone(dependencies.getLineage()),
        );
        return applyResult(result, token, transformId);
      },
      remove: (transformId) => {
        const lineage = dependencies.getLineage();
        const operationIds = new Set(lineage.nodes
          .filter((node) => node.nodeType === "operation"
            && node.documentRef?.kind === "tableTransform"
            && node.documentRef.id === transformId)
          .map((node) => node.id));
        dependencies.setLineage({
          ...lineage,
          graphHash: "",
          nodes: lineage.nodes.filter((node) => !operationIds.has(node.id)),
          edges: lineage.edges.filter((edge) => !operationIds.has(edge.source.nodeId)
            && !operationIds.has(edge.target.nodeId)),
        });
        set((state) => {
          const { [transformId]: _removed, ...pendingById } = state.pendingById;
          return {
            definitions: state.definitions.filter((item) => item.id !== transformId),
            bindings: state.bindings.filter((item) => item.definitionId !== transformId),
            pendingById,
          };
        });
      },
      reset: () => set({ definitions: [], bindings: [], pendingById: {} }),
    };
  };
}

export function createTableTransformStore(
  dependencies: TableTransformStoreDependencies,
): StoreApi<TableTransformStore> {
  return createStore<TableTransformStore>(stateCreator(dependencies));
}

export const useTableTransformStore = create<TableTransformStore>(stateCreator({
  service: tableTransformService,
  getLineage: () => useWorkflowStore.getState().lineageGraph,
  setLineage: (lineageGraph) => useWorkflowStore.setState({ lineageGraph }),
}));