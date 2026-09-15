import assert from "node:assert/strict";

import { createApplicationRuntime } from "@/applicationCommands/applicationRuntime";
import { CommandExecutionError } from "@/applicationCommands/runtime";
import type { DatasetMeta } from "@/types/data";
import type {
  TableTransformBindingState,
  TableTransformDefinition,
  TableTransformDraft,
  TableTransformExecutionResult,
} from "@/types/tableTransform";

function makeDataset(id: string, name: string, generation: number): DatasetMeta {
  return {
    id,
    name,
    sourcePath: null,
    sourceType: "manual",
    rowCount: 3,
    colCount: 2,
    generation,
    createdAt: "2026-09-15T00:00:00.000Z",
    updatedAt: "2026-09-15T00:00:00.000Z",
  };
}

function makeDefinition(): TableTransformDefinition {
  return {
    id: "tt-1",
    name: "Sort Reusable",
    formatVersion: "1",
    revision: 2,
    operation: {
      kind: "sort",
      sortColumns: [{ column: "value", direction: "ascending" }],
    },
    inputSlots: [{ role: "source", schemaContract: { columns: [] } }],
    output: {
      tableDocumentId: "tbl-out",
      name: "Sorted Output",
    },
  };
}

function makeBinding(outputGeneration: number): TableTransformBindingState {
  return {
    definitionId: "tt-1",
    definitionRevision: 2,
    inputs: [{ role: "source", tableDocumentId: "tbl-source" }],
    outputGeneration,
    lastRun: {
      definitionRevision: 2,
      status: "succeeded",
      outputGeneration,
    },
    schemaReports: [],
  };
}

function makeExecution(outputGeneration: number): TableTransformExecutionResult {
  return {
    definitionId: "tt-1",
    status: "succeeded",
    output: makeDataset("tbl-out", "Sorted Output", outputGeneration),
    schemaReports: [],
    binding: {
      definitionId: "tt-1",
      definitionRevision: 2,
      inputs: [{ role: "source", tableDocumentId: "tbl-source" }],
      outputGeneration,
    },
    runState: {
      definitionRevision: 2,
      status: "succeeded",
      outputGeneration,
    },
  };
}

const draft: TableTransformDraft = {
  name: "Sort Reusable",
  outputName: "Sorted Output",
  operation: {
    kind: "sort",
    sortColumns: [{ column: "value", direction: "ascending" }],
  },
  inputBindings: [{ role: "source", tableDocumentId: "tbl-source" }],
};

{
  const datasets: DatasetMeta[] = [makeDataset("tbl-source", "Source", 1)];
  const definitions: TableTransformDefinition[] = [];
  const bindings: TableTransformBindingState[] = [];

  let refreshCalls = 0;
  let dirtyTransitions = 0;
  let dirty = false;
  const historyEntries: string[] = [];
  const activations: string[] = [];
  let createAndRunCalls = 0;

  const runtime = createApplicationRuntime({
    initialRevision: 9,
    project: {
      getProjectState: () => ({
        project: {
          name: "Task4",
          filePath: "/Users/ashton/projects/task4.spprj",
          createdAt: "2026-09-15T00:00:00.000Z",
        },
        dirty,
        readOnly: false,
        projectRevision: 9,
      }),
      listDatasets: () => datasets,
      listTableTransforms: () => definitions,
      listGraphs: () => [],
      listReports: () => [],
      listAnalyses: () => [],
      listTabulates: () => [],
      getColumns: async (datasetId) => datasetId === "tbl-out"
        ? [["value", "DOUBLE"], ["group", "VARCHAR"]]
        : [["value", "DOUBLE"]],
      getColumnDisplayProps: async () => [{
        colIndex: 0,
        width: 132,
        format: { kind: "numeric", decimals: 3 },
        extras: { unit: { symbol: "mm" } },
      }],
      getDatasetGeneration: async (datasetId) => datasetId === "tbl-out" ? 4 : 1,
    },
    tableTransform: {
      createAndRun: async () => {
        createAndRunCalls += 1;
        const definition = makeDefinition();
        const binding = makeBinding(4);
        definitions.splice(0, definitions.length, definition);
        bindings.splice(0, bindings.length, binding);
        datasets.splice(0, datasets.length, makeDataset("tbl-source", "Source", 1), makeDataset("tbl-out", "Sorted Output", 4));
        return makeExecution(4);
      },
      rerun: async () => makeExecution(5),
      listDefinitions: () => definitions,
      listBindings: () => bindings,
      refreshDatasets: async () => {
        refreshCalls += 1;
      },
      markDirty: () => {
        if (!dirty) dirtyTransitions += 1;
        dirty = true;
      },
      recordAction: (message) => {
        historyEntries.push(message);
      },
      activateDataset: (datasetId) => {
        activations.push(datasetId);
      },
      historyMessage: (name) => `Transform output \"${name}\" updated`,
    },
  });

  const result = await runtime.execute(
    {
      type: "tableTransform.create",
      input: { draft },
      control: { expectedProjectRevision: 9 },
    },
    { kind: "ui" },
  );

  assert.equal(createAndRunCalls, 1);
  assert.equal(refreshCalls, 1);
  assert.equal(dirtyTransitions, 1);
  assert.equal(historyEntries.length, 1);
  assert.equal(activations.length, 1);
  assert.equal(activations[0], "tbl-out");
  assert.equal(result.projectRevision, 10);
  assert.equal(result.data.execution.definitionId, "tt-1");
  assert.equal(result.data.definition.id, "tt-1");
  assert.equal(result.data.binding.definitionId, "tt-1");
  assert.equal(result.data.outputTable?.dataset.id, "tbl-out");
  assert.equal(result.data.outputTable?.generation, 4);
}

{
  let called = 0;
  const runtime = createApplicationRuntime({
    initialRevision: 3,
    project: {
      getProjectState: () => ({
        project: {
          name: "Task4",
          filePath: "/Users/ashton/projects/task4.spprj",
          createdAt: "2026-09-15T00:00:00.000Z",
        },
        dirty: false,
        readOnly: false,
        projectRevision: 3,
      }),
      listDatasets: () => [],
      listTableTransforms: () => [],
      listGraphs: () => [],
      listReports: () => [],
      listAnalyses: () => [],
      listTabulates: () => [],
      getColumns: async () => [],
      getColumnDisplayProps: async () => [],
      getDatasetGeneration: async () => 1,
    },
    tableTransform: {
      createAndRun: async () => {
        called += 1;
        return makeExecution(1);
      },
      rerun: async () => makeExecution(1),
      listDefinitions: () => [makeDefinition()],
      listBindings: () => [makeBinding(1)],
      refreshDatasets: async () => {},
      markDirty: () => {},
      recordAction: () => {},
      activateDataset: () => {},
      historyMessage: () => "history",
    },
  });

  await assert.rejects(
    runtime.execute(
      {
        type: "tableTransform.create",
        input: { draft },
        control: { expectedProjectRevision: 2 },
      },
      { kind: "ui" },
    ),
    (error) => error instanceof CommandExecutionError && error.code === "revision_conflict",
  );

  assert.equal(called, 0);
}

{
  const datasets: DatasetMeta[] = [makeDataset("tbl-source", "Source", 1), makeDataset("tbl-out", "Sorted Output", 6)];
  let rerunCalls = 0;

  const runtime = createApplicationRuntime({
    initialRevision: 12,
    project: {
      getProjectState: () => ({
        project: {
          name: "Task4",
          filePath: "/Users/ashton/projects/task4.spprj",
          createdAt: "2026-09-15T00:00:00.000Z",
        },
        dirty: true,
        readOnly: false,
        projectRevision: 12,
      }),
      listDatasets: () => datasets,
      listTableTransforms: () => [makeDefinition()],
      listGraphs: () => [],
      listReports: () => [],
      listAnalyses: () => [],
      listTabulates: () => [],
      getColumns: async () => [["value", "DOUBLE"]],
      getColumnDisplayProps: async () => [],
      getDatasetGeneration: async () => 7,
    },
    tableTransform: {
      createAndRun: async () => makeExecution(6),
      rerun: async (transformId) => {
        rerunCalls += 1;
        assert.equal(transformId, "tt-1");
        return makeExecution(7);
      },
      listDefinitions: () => [makeDefinition()],
      listBindings: () => [makeBinding(7)],
      refreshDatasets: async () => {},
      markDirty: () => {},
      recordAction: () => {},
      activateDataset: () => {},
      historyMessage: () => "history",
    },
  });

  const result = await runtime.execute(
    {
      type: "tableTransform.run",
      input: { transformId: "tt-1" },
      control: { expectedProjectRevision: 12 },
    },
    { kind: "ui" },
  );

  assert.equal(rerunCalls, 1);
  assert.equal(result.projectRevision, 13);
  assert.equal(result.data.execution.runState.outputGeneration, 7);
  assert.equal(result.data.targetDatasetGeneration, 7);
}

console.log("application command table transform tests passed");
