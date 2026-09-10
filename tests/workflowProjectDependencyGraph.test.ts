import assert from "node:assert/strict";

import { buildProjectDependencyGraph } from "../src/workflow/projectDependencyGraph.ts";
import type { AnalysisDocument } from "../src/types/analysis.ts";
import type { DatasetMeta } from "../src/types/data.ts";
import type { GraphBuilderItem } from "../src/types/graphBuilder.ts";
import type { ReportItem } from "../src/types/report.ts";
import type { TabulateItem } from "../src/types/tabulate.ts";
import type {
  TableTransformDefinition,
  TableTransformProjectBinding,
} from "../src/types/tableTransform.ts";

const dataset: DatasetMeta = {
  id: "table-1",
  name: "Measurements",
  sourcePath: null,
  sourceType: "manual",
  rowCount: 10,
  colCount: 4,
  generation: 1,
  createdAt: "2026-09-08T00:00:00.000Z",
  updatedAt: "2026-09-08T00:00:00.000Z",
};

const graph = {
  id: "graph-1",
  name: "Yield by batch",
  sourceDatasetId: dataset.id,
  mode: "2d",
  modeStates: {
    twoD: {
      encoding: {
        x: { name: "batch", type: "nominal" },
        y: { name: "yield", type: "continuous" },
      },
      multiX: [],
      multiY: [],
      elements: [],
      smootherLambda: 0.5,
    },
    threeD: {
      encoding: { z: { name: "inactive-z", type: "continuous" } },
      elements: [],
      smootherLambda: 0.5,
    },
    multivariate: {
      columns: [{ name: "inactive-column", type: "continuous" }],
      chartType: "correlationMatrix",
      correlationMethod: "pearson",
    },
  },
  filters: [{
    id: "filter-1",
    op: "AND",
    rule: {
      kind: "categorical",
      field: { name: "site", type: "nominal" },
      selected: ["A"],
    },
  }],
  createdAt: "2026-09-08T00:00:00.000Z",
} satisfies GraphBuilderItem;

const analysis = {
  schemaVersion: 1,
  documentType: "analysis",
  id: "analysis-1",
  name: "Yield fit",
  analysisKind: "fitYByX",
  configRevision: 1,
  source: { datasetId: dataset.id },
  definition: {
    kind: "fitYByX",
    response: { name: "yield", type: "continuous" },
    factor: { name: "batch", type: "nominal" },
    personality: "oneway",
    confidenceLevel: 0.95,
  },
  presentation: {
    schemaVersion: 1,
    layout: "fit-y-by-x-v1",
    graph: {
      mode: "2d",
      modeStates: graph.modeStates,
      filters: [],
    },
  },
  createdAt: "2026-09-08T00:00:00.000Z",
  updatedAt: "2026-09-08T00:00:00.000Z",
} satisfies AnalysisDocument;

const tabulate: TabulateItem = {
  id: "tabulate-1",
  name: "Site summary",
  sourceDatasetId: dataset.id,
  rowFields: ["site"],
  columnFields: ["batch"],
  statistics: [{ id: "mean-yield", field: "yield", kind: "mean" }],
  includeRowTotals: true,
  includeColumnTotals: true,
  createdAt: "2026-09-08T00:00:00.000Z",
};

const report: ReportItem = {
  schemaVersion: 1,
  id: "report-1",
  name: "Process report",
  markdown: [
    "# Process report",
    '{{sp-embed kind="graph" id="graph-1"}}',
    '{{sp-embed kind="fitYByX" id="analysis-1"}}',
    '{{sp-embed kind="tabulate" id="tabulate-1"}}',
  ].join("\n"),
  createdAt: "2026-09-08T00:00:00.000Z",
  updatedAt: "2026-09-08T00:00:00.000Z",
};

const transform: TableTransformDefinition = {
  id: "transform-1",
  name: "Sort measurements",
  formatVersion: "1",
  revision: 1,
  operation: { kind: "sort", sortColumns: [{ column: "yield", direction: "ascending" }] },
  inputSlots: [{
    role: "source",
    schemaContract: {
      schemaFingerprint: "source-schema",
      columns: [{
        name: "yield",
        canonicalDuckdbType: "DOUBLE",
        required: true,
        requiredByOperationIds: ["table-transform"],
      }],
    },
  }],
  output: { tableDocumentId: "table-sorted", name: "Sorted measurements" },
};

const transformBinding: TableTransformProjectBinding = {
  definitionId: transform.id,
  definitionRevision: transform.revision,
  inputs: [{ role: "source", tableDocumentId: dataset.id }],
  outputGeneration: 1,
};

const first = buildProjectDependencyGraph({
  datasets: [dataset],
  graphs: [graph],
  analyses: [analysis],
  tabulates: [tabulate],
  reports: [report],
});

assert.deepEqual(
  first.edges.map((edge) => [edge.kind, edge.source.nodeId, edge.target.nodeId]),
  [
    ["consumes", "artifact:analysis:analysis-1", "operation:report:report-1"],
    ["consumes", "artifact:graph:graph-1", "operation:report:report-1"],
    ["consumes", "artifact:table:table-1", "operation:analysis:analysis-1"],
    ["consumes", "artifact:table:table-1", "operation:graph:graph-1"],
    ["consumes", "artifact:table:table-1", "operation:tabulate:tabulate-1"],
    ["consumes", "artifact:tabulate:tabulate-1", "operation:report:report-1"],
    ["produces", "operation:analysis:analysis-1", "artifact:analysis:analysis-1"],
    ["produces", "operation:graph:graph-1", "artifact:graph:graph-1"],
    ["produces", "operation:report:report-1", "artifact:report:report-1"],
    ["produces", "operation:tabulate:tabulate-1", "artifact:tabulate:tabulate-1"],
  ],
);

function tableRequirement(graphId: string, operationId: string) {
  const operation = first.nodes.find((node) => node.id === operationId);
  assert.equal(operation?.nodeType, "operation");
  const port = operation.inputPorts.find((candidate) => candidate.payloadKind === "table");
  assert.ok(port, `${graphId} must have a Table input port`);
  return port.tableRequirement;
}

assert.deepEqual(tableRequirement("Graph", "operation:graph:graph-1"), {
  columns: [
    { name: "batch", requiredExtraKinds: [] },
    { name: "site", requiredExtraKinds: [] },
    { name: "yield", requiredExtraKinds: [] },
  ],
  completeSchema: false,
});
assert.deepEqual(tableRequirement("Analysis", "operation:analysis:analysis-1"), {
  columns: [
    { name: "batch", requiredExtraKinds: [] },
    { name: "yield", requiredExtraKinds: [] },
  ],
  completeSchema: false,
});
assert.deepEqual(tableRequirement("Tabulate", "operation:tabulate:tabulate-1"), {
  columns: [
    { name: "batch", requiredExtraKinds: [] },
    { name: "site", requiredExtraKinds: [] },
    { name: "yield", requiredExtraKinds: [] },
  ],
  completeSchema: false,
});

const updatedGraph: GraphBuilderItem = {
  ...graph,
  modeStates: {
    ...graph.modeStates,
    twoD: {
      ...graph.modeStates.twoD,
      encoding: {
        ...graph.modeStates.twoD.encoding,
        y: { name: "temperature", type: "continuous" },
      },
    },
  },
};
const second = buildProjectDependencyGraph({
  datasets: [dataset],
  graphs: [updatedGraph],
  analyses: [analysis],
  tabulates: [tabulate],
  reports: [report],
});
const secondGraphOperation = second.nodes.find((node) => node.id === "operation:graph:graph-1");
assert.equal(secondGraphOperation?.nodeType, "operation");
assert.deepEqual(
  secondGraphOperation.inputPorts[0]?.tableRequirement?.columns.map((column) => column.name),
  ["batch", "site", "temperature"],
);
assert.deepEqual(tableRequirement("Original Graph", "operation:graph:graph-1")?.columns.map((column) => column.name), [
  "batch",
  "site",
  "yield",
]);

assert.deepEqual(
  first.nodes.map((node) => node.id),
  first.nodes.map((node) => node.id).sort(),
);
assert.deepEqual(
  first.edges.map((edge) => edge.id),
  first.edges.map((edge) => edge.id).sort((left, right) => {
    const leftKind = left.slice(0, left.indexOf(":"));
    const rightKind = right.slice(0, right.indexOf(":"));
    return leftKind.localeCompare(rightKind) || left.localeCompare(right);
  }),
);

assert.throws(
  () => buildProjectDependencyGraph({
    datasets: [dataset],
    graphs: [graph],
    analyses: [analysis],
    tabulates: [tabulate],
    reports: [{
      ...report,
      markdown: '{{sp-embed kind="graph" id="missing-graph"}}',
    }],
  }),
  /Unresolved project dependency source: artifact:graph:missing-graph/,
);

assert.throws(
  () => buildProjectDependencyGraph({
    datasets: [dataset],
    graphs: [graph, { ...graph }],
    analyses: [analysis],
    tabulates: [tabulate],
    reports: [report],
  }),
  /Duplicate project dependency node: artifact:graph:graph-1/,
);

const transformed = buildProjectDependencyGraph({
  datasets: [
    dataset,
    { ...dataset, id: "table-sorted", name: "Sorted measurements" },
  ],
  tableTransforms: [transform],
  tableTransformBindings: [transformBinding],
  graphs: [],
  analyses: [],
  tabulates: [],
  reports: [],
});
assert.deepEqual(
  transformed.edges.map((edge) => [edge.kind, edge.source.nodeId, edge.target.nodeId]),
  [
    ["consumes", "artifact:table:table-1", "operation:tableTransform:transform-1"],
    ["produces", "operation:tableTransform:transform-1", "artifact:table:table-sorted"],
  ],
);
const transformOperation = transformed.nodes.find(
  (node) => node.id === "operation:tableTransform:transform-1",
);
assert.equal(transformOperation?.nodeType, "operation");
assert.deepEqual(transformOperation.inputPorts[0]?.tableRequirement, {
  columns: [{ name: "yield", requiredExtraKinds: [] }],
  completeSchema: false,
});
assert.deepEqual(transformOperation.configuration, transform);

const detachedOutput = buildProjectDependencyGraph({
  datasets: [
    dataset,
    { ...dataset, id: "table-sorted", name: "Sorted measurements" },
  ],
  tableTransforms: [],
  tableTransformBindings: [],
  graphs: [{ ...graph, sourceDatasetId: "table-sorted" }],
  analyses: [],
  tabulates: [],
  reports: [],
});
assert.equal(
  detachedOutput.nodes.some((node) => node.id === "operation:tableTransform:transform-1"),
  false,
);
assert.deepEqual(
  detachedOutput.edges.map((edge) => [edge.kind, edge.source.nodeId, edge.target.nodeId]),
  [
    ["consumes", "artifact:table:table-sorted", "operation:graph:graph-1"],
    ["produces", "operation:graph:graph-1", "artifact:graph:graph-1"],
  ],
);
assert.equal(
  detachedOutput.nodes.some((node) => node.id === "artifact:table:table-1"),
  true,
);
assert.equal(
  detachedOutput.nodes.some((node) => node.id === "artifact:table:table-sorted"),
  true,
);

console.log("Workflow project dependency graph contract passed");