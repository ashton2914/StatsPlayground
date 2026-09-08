import assert from "node:assert/strict";

import { createTableTransformStore } from "../src/stores/useTableTransformStore.ts";
import type {
  TableTransformCommandResult,
  TableTransformDefinition,
  TableTransformDraft,
  TableTransformInputBinding,
  TableTransformProjectBinding,
  TableTransformRunState,
} from "../src/types/tableTransform.ts";
import type { ProjectLineageGraph } from "../src/types/workflow.ts";

const EMPTY_LINEAGE: ProjectLineageGraph = {
  id: "project-lineage",
  name: "Project lineage",
  nodes: [],
  edges: [],
};

function definition(): TableTransformDefinition {
  return {
    id: "transform-1",
    name: "Reusable sort",
    formatVersion: "1",
    revision: 1,
    operation: {
      kind: "sort",
      sortColumns: [{ column: "value", direction: "ascending" }],
    },
    inputSlots: [
      {
        role: "source",
        schemaContract: { schemaFingerprint: "schema", columns: [] },
      },
    ],
    output: { tableDocumentId: "output-1", name: "Sorted table" },
  };
}

function binding(
  inputs: TableTransformInputBinding[] = [{ role: "source", tableDocumentId: "source-a" }],
  outputGeneration = 1,
): TableTransformProjectBinding {
  return {
    definitionId: "transform-1",
    definitionRevision: 1,
    inputs,
    outputGeneration,
  };
}

function runState(status: TableTransformRunState["status"], outputGeneration?: number): TableTransformRunState {
  return {
    definitionRevision: 1,
    status,
    outputGeneration,
  };
}

function commandResult(
  status: TableTransformRunState["status"],
  nextBinding = binding(),
  lineageGraph = EMPTY_LINEAGE,
): TableTransformCommandResult {
  return {
    definition: definition(),
    execution: {
      definitionId: "transform-1",
      status,
      output: status === "succeeded"
        ? {
            id: "output-1",
            name: "Sorted table",
            sourcePath: null,
            sourceType: "query",
            rowCount: 2,
            colCount: 1,
            generation: nextBinding.outputGeneration,
            createdAt: "2026-09-08T00:00:00Z",
            updatedAt: "2026-09-08T00:00:00Z",
          }
        : undefined,
      schemaReports: [],
      binding: nextBinding,
      runState: runState(status, status === "succeeded" ? nextBinding.outputGeneration : undefined),
    },
    lineageGraph,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

async function main() {
  let lineage = structuredClone(EMPTY_LINEAGE);
  const calls: Array<{ kind: string; inputs?: TableTransformInputBinding[] }> = [];
  const service = {
    createAndRun: async (draft: TableTransformDraft) => {
      calls.push({ kind: "create", inputs: draft.inputBindings });
      return commandResult("succeeded");
    },
    run: async () => commandResult("blocked", binding(undefined, 1)),
    rebindAndRun: async (
      _definition: TableTransformDefinition,
      _binding: TableTransformProjectBinding,
      inputs: TableTransformInputBinding[],
    ) => {
      calls.push({ kind: "rebind", inputs });
      return commandResult("succeeded", binding(inputs, 2));
    },
  };
  const store = createTableTransformStore({
    service,
    getLineage: () => lineage,
    setLineage: (next) => { lineage = next; },
  });

  await store.getState().createAndRun({
    name: "Reusable sort",
    outputName: "Sorted table",
    operation: definition().operation,
    inputBindings: binding().inputs,
  });
  assert.equal(store.getState().definitions[0]?.id, "transform-1");
  assert.equal(store.getState().bindings[0]?.lastRun?.status, "succeeded");
  assert.equal(calls[0]?.kind, "create");

  await store.getState().rerun("transform-1");
  assert.equal(store.getState().bindings[0]?.outputGeneration, 1);
  assert.equal(store.getState().bindings[0]?.lastRun?.status, "blocked");

  await store.getState().rebindAndRun("transform-1", "source", "source-b");
  assert.deepEqual(calls.at(-1)?.inputs, [{ role: "source", tableDocumentId: "source-b" }]);
  assert.equal(store.getState().bindings[0]?.outputGeneration, 2);

  const older = deferred<TableTransformCommandResult>();
  const newer = deferred<TableTransformCommandResult>();
  let runCount = 0;
  const fencedStore = createTableTransformStore({
    service: {
      ...service,
      run: async () => (++runCount === 1 ? older.promise : newer.promise),
    },
    getLineage: () => lineage,
    setLineage: (next) => { lineage = next; },
  });
  fencedStore.getState().loadFromProject([definition()], [binding()]);
  const olderRun = fencedStore.getState().rerun("transform-1");
  const newerRun = fencedStore.getState().rerun("transform-1");
  newer.resolve(commandResult("succeeded", binding(undefined, 3)));
  await newerRun;
  older.resolve(commandResult("succeeded", binding(undefined, 2)));
  await olderRun;
  assert.equal(fencedStore.getState().bindings[0]?.outputGeneration, 3);

  fencedStore.getState().reset();
  assert.deepEqual(fencedStore.getState().definitions, []);
  assert.deepEqual(fencedStore.getState().bindings, []);
}

void main();
