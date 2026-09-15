import assert from "node:assert/strict";

import { createApplicationRuntime, type ApplicationRuntimeDependencies } from "@/applicationCommands/applicationRuntime";
import { CommandExecutionError, type CommandActor } from "@/applicationCommands/runtime";
import {
  createDefaultGraph2DState,
  createDefaultGraph3DState,
  createDefaultMultivariateGraphState,
  normalizeGraphBuilderItem,
} from "@/components/graphBuilder/graphBuilderMode";
import { normalizeStoredGraphBuilderItem } from "@/stores/useGraphBuilderStore";
import type { DatasetMeta } from "@/types/data";
import type { GraphBuilderItem } from "@/types/graphBuilder";

const NOW = "2026-09-15T12:00:00.000Z";

function dataset(id: string, name: string): DatasetMeta {
  return {
    id,
    name,
    sourcePath: null,
    sourceType: "manual",
    rowCount: 10,
    colCount: 3,
    generation: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function baseGraph(id: string, name: string, sourceDatasetId: string): GraphBuilderItem {
  return {
    id,
    name,
    sourceDatasetId,
    mode: "2d",
    modeStates: {
      twoD: createDefaultGraph2DState(),
      threeD: createDefaultGraph3DState(),
      multivariate: createDefaultMultivariateGraphState(),
    },
    createdAt: NOW,
  };
}

async function createGraphForActor(actor: CommandActor) {
  const datasets = [dataset("ds-1", "Sales")];
  const graphs: GraphBuilderItem[] = [];
  const graphDocumentRevisions = new Map<string, number>();
  const historyEntries: string[] = [];
  const activated: string[] = [];
  let dirty = false;
  let dirtyTransitions = 0;

  const runtimeDependencies = {
    initialRevision: 4,
    project: {
      getProjectState: () => ({
        project: {
          name: "Task6",
          filePath: "/Users/ashton/projects/task6.spprj",
          createdAt: NOW,
        },
        dirty,
        readOnly: false,
        projectRevision: 4,
      }),
      listDatasets: () => datasets,
      listTableTransforms: () => [],
      listGraphs: () => graphs,
      listReports: () => [],
      listAnalyses: () => [],
      listTabulates: () => [],
      getColumns: async () => [],
      getColumnDisplayProps: async () => [],
      getDatasetGeneration: async () => 1,
    },
    graph: {
      listDatasets: () => datasets,
      listGraphs: () => graphs,
      listGraphNamesForAllocation: () => graphs.map((item) => item.name),
      createGraphId: () => "graph-1",
      createNowIso: () => NOW,
      addGraph: (item: GraphBuilderItem) => {
        graphs.push(item);
      },
      getDocumentRevision: (graphId: string) => graphDocumentRevisions.get(graphId) ?? 0,
      setDocumentRevision: (graphId: string, revision: number) => {
        graphDocumentRevisions.set(graphId, revision);
      },
      activateGraph: (graphId: string) => {
        activated.push(graphId);
      },
      markDirty: () => {
        if (!dirty) {
          dirtyTransitions += 1;
        }
        dirty = true;
      },
      recordAction: (description: string) => {
        historyEntries.push(description);
      },
      historyCreateMessage: (name: string, sourceName: string) => `Created graph ${name} from ${sourceName}`,
      normalizeGraph: normalizeStoredGraphBuilderItem,
    },
  } satisfies ApplicationRuntimeDependencies;

  const runtime = createApplicationRuntime(runtimeDependencies);

  const result = await runtime.execute(
    {
      type: "graph.create",
      input: { sourceDatasetId: "ds-1" },
      control: { expectedProjectRevision: 4 },
    },
    actor,
  );

  return {
    result,
    graphs,
    graphDocumentRevisions,
    historyEntries,
    activated,
    dirtyTransitions,
  };
}

{
  const ui = await createGraphForActor({ kind: "ui" });
  const mcp = await createGraphForActor({ kind: "mcp", sessionId: "session-graph-create" });
  const expected = normalizeGraphBuilderItem(baseGraph("graph-1", "Sales - Graph1", "ds-1"));

  assert.deepEqual(ui.result.data.item, expected);
  assert.deepEqual(mcp.result.data.item, expected);
  assert.equal(ui.result.data.documentRevision, 1);
  assert.equal(mcp.result.data.documentRevision, 1);
  assert.equal(ui.result.projectRevision, 5);
  assert.equal(mcp.result.projectRevision, 5);
  assert.equal(ui.graphs.length, 1);
  assert.equal(mcp.graphs.length, 1);
  assert.equal(ui.graphDocumentRevisions.get("graph-1"), 1);
  assert.equal(mcp.graphDocumentRevisions.get("graph-1"), 1);
  assert.equal(ui.historyEntries.length, 1);
  assert.equal(mcp.historyEntries.length, 1);
  assert.equal(ui.activated[0], "graph-1");
  assert.equal(mcp.activated[0], "graph-1");
  assert.equal(ui.dirtyTransitions, 1);
  assert.equal(mcp.dirtyTransitions, 1);
}

{
  const datasets = [dataset("ds-1", "Sales")];
  const initial = baseGraph("graph-1", "Sales - Graph1", "ds-1");
  const graphs: GraphBuilderItem[] = [initial];
  const graphDocumentRevisions = new Map<string, number>([["graph-1", 1]]);
  const historyEntries: string[] = [];
  let dirty = false;
  let dirtyTransitions = 0;

  const runtimeDependencies = {
    initialRevision: 9,
    project: {
      getProjectState: () => ({
        project: {
          name: "Task6",
          filePath: "/Users/ashton/projects/task6.spprj",
          createdAt: NOW,
        },
        dirty,
        readOnly: false,
        projectRevision: 9,
      }),
      listDatasets: () => datasets,
      listTableTransforms: () => [],
      listGraphs: () => graphs,
      listReports: () => [],
      listAnalyses: () => [],
      listTabulates: () => [],
      getColumns: async () => [],
      getColumnDisplayProps: async () => [],
      getDatasetGeneration: async () => 1,
    },
    graph: {
      listDatasets: () => datasets,
      listGraphs: () => graphs,
      getDocumentRevision: (graphId: string) => graphDocumentRevisions.get(graphId) ?? 0,
      setDocumentRevision: (graphId: string, revision: number) => {
        graphDocumentRevisions.set(graphId, revision);
      },
      replaceGraph: (next: GraphBuilderItem) => {
        const index = graphs.findIndex((item) => item.id === next.id);
        graphs[index] = next;
      },
      markDirty: () => {
        if (!dirty) {
          dirtyTransitions += 1;
        }
        dirty = true;
      },
      recordAction: (description: string) => {
        historyEntries.push(description);
      },
      historyUpdateMessage: (name: string) => `Updated graph ${name}`,
      normalizeGraph: normalizeStoredGraphBuilderItem,
    },
  } satisfies ApplicationRuntimeDependencies;

  const runtime = createApplicationRuntime(runtimeDependencies);

  const result = await runtime.execute(
    {
      type: "graph.update",
      input: {
        graphId: "graph-1",
        expectedDocumentRevision: 1,
        definition: {
          ...initial,
          mode: "multivariate",
          modeStates: {
            ...initial.modeStates,
            multivariate: {
              columns: [
                { name: "height", type: "continuous" },
                { name: "ignored", type: "nominal" },
                { name: "height", type: "continuous" },
                { name: "width", type: "continuous" },
              ],
              chartType: "correlationMatrix",
              correlationMethod: "distance",
            },
          },
          sampling: { mode: "sample", size: -5, seed: -1 },
        },
      },
      control: { expectedProjectRevision: 9 },
    },
    { kind: "ui" },
  );

  const expected = normalizeGraphBuilderItem({
    ...initial,
    mode: "multivariate",
    modeStates: {
      ...initial.modeStates,
      multivariate: {
        columns: [
          { name: "height", type: "continuous" },
          { name: "ignored", type: "nominal" },
          { name: "height", type: "continuous" },
          { name: "width", type: "continuous" },
        ],
        chartType: "correlationMatrix",
        correlationMethod: "distance",
      },
    },
    sampling: { mode: "sample", size: -5, seed: -1 },
  });

  assert.deepEqual(result.data.item, expected);
  assert.equal(result.data.documentRevision, 2);
  assert.equal(result.projectRevision, 10);
  assert.equal(graphDocumentRevisions.get("graph-1"), 2);
  assert.equal(historyEntries.length, 1);
  assert.equal(dirtyTransitions, 1);
}

{
  const datasets = [dataset("ds-1", "Sales")];
  const initial: GraphBuilderItem = normalizeStoredGraphBuilderItem({
    ...baseGraph("graph-1", "Sales - Graph1", "ds-1"),
    sampling: { mode: "full" },
  });
  const graphs: GraphBuilderItem[] = [initial];
  const graphDocumentRevisions = new Map<string, number>([["graph-1", 4]]);
  const historyEntries: string[] = [];
  let dirty = false;
  let replaceCalls = 0;

  const runtime = createApplicationRuntime({
    initialRevision: 12,
    project: {
      getProjectState: () => ({
        project: {
          name: "Task6",
          filePath: "/Users/ashton/projects/task6.spprj",
          createdAt: NOW,
        },
        dirty,
        readOnly: false,
        projectRevision: 12,
      }),
      listDatasets: () => datasets,
      listTableTransforms: () => [],
      listGraphs: () => graphs,
      listReports: () => [],
      listAnalyses: () => [],
      listTabulates: () => [],
      getColumns: async () => [],
      getColumnDisplayProps: async () => [],
      getDatasetGeneration: async () => 1,
    },
    graph: {
      listDatasets: () => datasets,
      listGraphs: () => graphs,
      getDocumentRevision: (graphId: string) => graphDocumentRevisions.get(graphId) ?? 0,
      setDocumentRevision: (graphId: string, revision: number) => {
        graphDocumentRevisions.set(graphId, revision);
      },
      replaceGraph: (next: GraphBuilderItem) => {
        replaceCalls += 1;
        const index = graphs.findIndex((item) => item.id === next.id);
        graphs[index] = next;
      },
      markDirty: () => {
        dirty = true;
      },
      recordAction: (description: string) => {
        historyEntries.push(description);
      },
      historyUpdateMessage: (name: string) => `Updated graph ${name}`,
      normalizeGraph: normalizeStoredGraphBuilderItem,
    },
  } as any);

  const result = await (runtime as any).execute(
    {
      type: "graph.update",
      input: {
        graphId: "graph-1",
        expectedDocumentRevision: 4,
        definition: {
          ...initial,
          groupThemeSlots: {},
        },
      },
      control: { expectedProjectRevision: 12 },
    },
    { kind: "ui" },
  );

  assert.equal(result.changed, false);
  assert.equal(result.projectRevision, 12);
  assert.equal(result.data.documentRevision, 4);
  assert.deepEqual(result.data.item, initial);
  assert.equal(replaceCalls, 0);
  assert.equal(graphDocumentRevisions.get("graph-1"), 4);
  assert.equal(historyEntries.length, 0);
  assert.equal(dirty, false);
}

{
  const datasets = [dataset("ds-1", "Sales")];
  const initial = baseGraph("graph-1", "Sales - Graph1", "ds-1");
  const graphs: GraphBuilderItem[] = [initial];
  const graphDocumentRevisions = new Map<string, number>([["graph-1", 2]]);
  const historyEntries: string[] = [];
  let dirty = false;

  const runtime = createApplicationRuntime({
    initialRevision: 12,
    project: {
      getProjectState: () => ({
        project: {
          name: "Task6",
          filePath: "/Users/ashton/projects/task6.spprj",
          createdAt: NOW,
        },
        dirty,
        readOnly: false,
        projectRevision: 12,
      }),
      listDatasets: () => datasets,
      listTableTransforms: () => [],
      listGraphs: () => graphs,
      listReports: () => [],
      listAnalyses: () => [],
      listTabulates: () => [],
      getColumns: async () => [],
      getColumnDisplayProps: async () => [],
      getDatasetGeneration: async () => 1,
    },
    graph: {
      listDatasets: () => datasets,
      listGraphs: () => graphs,
      getDocumentRevision: (graphId: string) => graphDocumentRevisions.get(graphId) ?? 0,
      setDocumentRevision: (graphId: string, revision: number) => {
        graphDocumentRevisions.set(graphId, revision);
      },
      replaceGraph: (next: GraphBuilderItem) => {
        const index = graphs.findIndex((item) => item.id === next.id);
        graphs[index] = next;
      },
      markDirty: () => {
        dirty = true;
      },
      recordAction: (description: string) => {
        historyEntries.push(description);
      },
      historyUpdateMessage: (name: string) => `Updated graph ${name}`,
      normalizeGraph: normalizeGraphBuilderItem,
    },
  } as any);

  await assert.rejects(
    (runtime as any).execute(
      {
        type: "graph.update",
        input: {
          graphId: "graph-1",
          expectedDocumentRevision: 1,
          definition: {
            ...initial,
            mode: "3d",
          },
        },
        control: { expectedProjectRevision: 12 },
      },
      { kind: "ui" },
    ),
    (error: unknown) => error instanceof CommandExecutionError && error.code === "revision_conflict",
  );

  assert.deepEqual(graphs[0], initial);
  assert.equal(graphDocumentRevisions.get("graph-1"), 2);
  assert.equal(historyEntries.length, 0);
  assert.equal(dirty, false);
}

console.log("application command graph lifecycle OK");