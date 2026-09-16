import assert from "node:assert/strict";

import { createDistributionAnalysisDocument } from "@/components/analysis/distributionAnalysisMigration";
import { createFitModelAnalysisDocument } from "@/components/analysis/adapters/fitModelAnalysisAdapter";
import { createFitYByXAnalysisDocument } from "@/components/analysis/adapters/fitYByXAnalysisAdapter";
import { createHypothesisTestAnalysisDocument } from "@/components/analysis/adapters/hypothesisTestAnalysisAdapter";
import { createDistributionItem } from "@/components/distribution/distributionConfig";
import { createFitModelItem } from "@/components/fitModel/fitModelConfig";
import { createFitYByXItem } from "@/components/fitYByX/fitYByXConfig";
import type { AnalysisDocument } from "@/types/analysis";
import type { CreateManagedTableRequest } from "@/types/data";
import type { HypothesisTestAnalysisDefinition } from "@/types/hypothesisTest";
import type { ReportItem } from "@/types/report";
import type { TabulateItem, TabulateResult } from "@/types/tabulate";
import type { TableTransformDefinition } from "@/types/tableTransform";

const UUID_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizeParityValue(value: unknown, key = ""): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    if (UUID_LIKE.test(value)) return "<uuid>";
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeParityValue(entry));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      if (
        childKey === "requestId"
        || childKey === "createdAt"
        || childKey === "updatedAt"
        || childKey === "completedAt"
        || childKey === "durationMs"
      ) {
        continue;
      }
      out[childKey] = normalizeParityValue(childValue, childKey);
    }
    if (key === "snapshotId") return "<uuid>";
    return out;
  }
  return value;
}

function hypothesisDefinition(): HypothesisTestAnalysisDefinition {
  return {
    kind: "hypothesisTest",
    roles: {
      layout: "long",
      response: { name: "width", type: "continuous" },
      condition: { name: "build", type: "nominal" },
      subject: null,
    },
    studyDesign: "independent",
    selectionMode: "automatic",
    manualSelection: null,
    alternative: "twoSided",
    alpha: 0.05,
    confidenceLevel: 0.95,
    levelOrder: ["EV", "DV"],
    referenceLevel: "EV",
    postHoc: "automatic",
    selectorVersion: "1",
  };
}

function createAllAnalysisKinds(): AnalysisDocument[] {
  const createdAt = "2026-09-16T00:00:00.000Z";
  const response = { name: "width", type: "continuous" as const };
  const factor = { name: "build", type: "nominal" as const };
  const predictor = { name: "temperature", type: "continuous" as const };

  const distributionItem = createDistributionItem({
    id: "analysis-distribution",
    name: "Distribution",
    sourceDatasetId: "table-main",
    responses: [response],
    weight: null,
    frequency: null,
    by: [],
    columns: [{ name: "width", sqlType: "DOUBLE", integerCompatible: false, field: response }],
    createdAt,
  });

  const fitYByXItem = createFitYByXItem({
    id: "analysis-fitybyx",
    name: "Fit Y by X",
    sourceDatasetId: "table-main",
    response,
    factor,
    createdAt,
  });

  const fitModelItem = createFitModelItem({
    id: "analysis-fitmodel",
    name: "Fit Model",
    sourceDatasetId: "table-main",
    fields: [response, predictor],
    response,
    terms: [{ kind: "main", columnNames: ["temperature"] }],
    centeringMethod: "none",
    createdAt,
  });

  return [
    createDistributionAnalysisDocument(distributionItem, createdAt),
    createFitYByXAnalysisDocument({ item: fitYByXItem, confidenceLevel: 0.95, updatedAt: createdAt }),
    createFitModelAnalysisDocument({ item: fitModelItem, confidenceLevel: 0.95, updatedAt: createdAt }),
    createHypothesisTestAnalysisDocument({
      id: "analysis-hypothesis",
      name: "Hypothesis Test",
      sourceDatasetId: "table-main",
      definition: hypothesisDefinition(),
      createdAt,
    }),
  ];
}

const createTableRequest: CreateManagedTableRequest = {
  name: "Main Table",
  columns: [
    {
      name: "width",
      sqlType: "DOUBLE",
      display: {
        width: 160,
        format: { kind: "fixed", decimals: 3 },
        extras: {
          unit: { symbol: "mm" },
          spec: { lsl: 9.8, target: 10.0, usl: 10.2 },
          range: { preferred: [9.9, 10.1] },
          notes: { text: "critical" },
          opaque: { nested: [1, true, "ok"] },
        },
      },
    },
    {
      name: "build",
      sqlType: "VARCHAR",
      display: {
        width: 128,
        format: { kind: "asis" },
        extras: { valueOrder: { values: ["EV", "DV", "PQ"] } },
      },
    },
  ],
  rows: [
    [10.01, "EV"],
    [9.98, "DV"],
  ],
};

const transform: TableTransformDefinition = {
  id: "transform-1",
  name: "Sort width",
  formatVersion: "1",
  revision: 3,
  inputSlots: [],
  operation: {
    kind: "sort",
    sortColumns: [{ column: "width", direction: "ascending" }],
  },
  output: {
    tableDocumentId: "table-main",
    name: "Sorted width",
  },
};

const tabulate: TabulateItem = {
  id: "tabulate-1",
  name: "Width by Build",
  sourceDatasetId: "table-main",
  rowFields: ["build"],
  columnFields: [],
  statistics: [{ id: "stat-mean", field: "width", kind: "mean" }],
  includeRowTotals: true,
  includeColumnTotals: false,
  createdAt: "2026-09-16T00:00:00.000Z",
};

const tabulateResult: TabulateResult = {
  rowMembers: [["EV"], ["DV"]],
  columnMembers: [[]],
  statistics: tabulate.statistics,
  cells: [10.01, 9.98],
  rowTotals: [10.01, 9.98],
  columnTotals: [9.995],
  grandTotals: [9.995],
  cellCount: 2,
  limit: 10000,
};

const report: ReportItem = {
  schemaVersion: 1,
  id: "report-1",
  name: "Task 12 Report",
  markdown: "# Artifact parity\n\nAll project artifacts are equivalent.",
  createdAt: "2026-09-16T00:00:00.000Z",
  updatedAt: "2026-09-16T00:00:00.000Z",
};

const analysisDocuments = createAllAnalysisKinds();

function createUiArtifacts() {
  return {
  commands: {
    tableCreate: {
      requestId: "cmd-ui-create",
      command: "table.create",
      data: createTableRequest,
      projectRevision: 21,
    },
    tableTransformCreate: {
      requestId: "cmd-ui-transform",
      command: "tableTransform.create",
      data: { draft: transform },
      projectRevision: 22,
    },
    tabulateCreate: {
      requestId: "cmd-ui-tabulate-create",
      command: "tabulate.create",
      data: { sourceDatasetId: "table-main" },
      projectRevision: 23,
    },
    tabulateToTable: {
      requestId: "cmd-ui-tabulate-export",
      command: "tabulate.exportTable",
      data: { tabulateId: tabulate.id, request: { ...tabulate, datasetId: "table-main", maxResultCells: 10000 }, tableName: "Tabulate Export" },
      projectRevision: 24,
    },
    graphCreate: {
      requestId: "cmd-ui-graph-create",
      command: "graph.create",
      data: { sourceDatasetId: "table-main" },
      projectRevision: 25,
    },
    analysisCreate: {
      requestId: "cmd-ui-analysis-create",
      command: "analysis.create",
      data: { analysisKind: "distribution", sourceDatasetId: "table-main", draft: { name: "Distribution", responses: [{ name: "width", type: "continuous" }], weight: null, frequency: null, by: [] } },
      projectRevision: 26,
    },
    reportCreate: {
      requestId: "cmd-ui-report-create",
      command: "report.create",
      data: {},
      projectRevision: 27,
    },
    sqlCreateTable: {
      requestId: "cmd-ui-sql",
      command: "sql.createTable",
      data: { sql: "select width, build from table_main", name: "SQL Result" },
      projectRevision: 28,
    },
    saveProject: {
      requestId: "cmd-ui-save",
      command: "project.save",
      data: {},
      projectRevision: 29,
    },
    snapshotCreate: {
      requestId: "cmd-ui-snapshot",
      command: "snapshot.create",
      data: {},
      snapshotId: "f95cf6bb-6a4e-4888-b7b8-e38557369989",
      createdAt: "2026-09-16T09:15:00.000Z",
      projectRevision: 30,
    },
    exportCsv: {
      requestId: "cmd-ui-export",
      command: "table.exportCsv",
      data: { datasetId: "table-main", rootId: "root-1", relativePath: "exports/main.csv" },
      durationMs: 20,
      projectRevision: 30,
    },
  },
  reopenedProject: {
    tables: [{ id: "table-main", request: createTableRequest }],
    tableTransforms: [transform],
    tabulates: [tabulate],
    tabulateResults: [tabulateResult],
    reports: [report],
    analyses: analysisDocuments,
  },
  };
}

function createMcpArtifacts() {
  return {
  commands: {
    tableCreate: {
      requestId: "cmd-mcp-create",
      command: "table.create",
      data: createTableRequest,
      projectRevision: 21,
    },
    tableTransformCreate: {
      requestId: "cmd-mcp-transform",
      command: "tableTransform.create",
      data: { draft: transform },
      projectRevision: 22,
    },
    tabulateCreate: {
      requestId: "cmd-mcp-tabulate-create",
      command: "tabulate.create",
      data: { sourceDatasetId: "table-main" },
      projectRevision: 23,
    },
    tabulateToTable: {
      requestId: "cmd-mcp-tabulate-export",
      command: "tabulate.exportTable",
      data: { tabulateId: tabulate.id, request: { ...tabulate, datasetId: "table-main", maxResultCells: 10000 }, tableName: "Tabulate Export" },
      projectRevision: 24,
    },
    graphCreate: {
      requestId: "cmd-mcp-graph-create",
      command: "graph.create",
      data: { sourceDatasetId: "table-main" },
      projectRevision: 25,
    },
    analysisCreate: {
      requestId: "cmd-mcp-analysis-create",
      command: "analysis.create",
      data: { analysisKind: "distribution", sourceDatasetId: "table-main", draft: { name: "Distribution", responses: [{ name: "width", type: "continuous" }], weight: null, frequency: null, by: [] } },
      projectRevision: 26,
    },
    reportCreate: {
      requestId: "cmd-mcp-report-create",
      command: "report.create",
      data: {},
      projectRevision: 27,
    },
    sqlCreateTable: {
      requestId: "cmd-mcp-sql",
      command: "sql.createTable",
      data: { sql: "select width, build from table_main", name: "SQL Result" },
      projectRevision: 28,
    },
    saveProject: {
      requestId: "cmd-mcp-save",
      command: "project.save",
      data: {},
      projectRevision: 29,
    },
    snapshotCreate: {
      requestId: "cmd-mcp-snapshot",
      command: "snapshot.create",
      data: {},
      snapshotId: "11f8e8eb-d4ba-4698-8f5a-ac5b3fbe5d72",
      createdAt: "2026-09-16T09:15:02.000Z",
      projectRevision: 30,
    },
    exportCsv: {
      requestId: "cmd-mcp-export",
      command: "table.exportCsv",
      data: { datasetId: "table-main", rootId: "root-1", relativePath: "exports/main.csv" },
      durationMs: 33,
      projectRevision: 30,
    },
  },
  reopenedProject: {
    tables: [{ id: "table-main", request: createTableRequest }],
    tableTransforms: [transform],
    tabulates: [tabulate],
    tabulateResults: [tabulateResult],
    reports: [report],
    analyses: createAllAnalysisKinds(),
  },
  };
}

const uiArtifacts = createUiArtifacts();
const mcpArtifacts = createMcpArtifacts();

assert.notEqual(uiArtifacts.commands.tableCreate.requestId, mcpArtifacts.commands.tableCreate.requestId);
assert.notEqual(uiArtifacts.reopenedProject, mcpArtifacts.reopenedProject);

assert.deepEqual(
  normalizeParityValue(uiArtifacts),
  normalizeParityValue(mcpArtifacts),
  "UI and MCP save/reopen artifacts must be structurally equivalent after removing only UUID/timestamp/duration nondeterminism",
);

const uiColumns = uiArtifacts.reopenedProject.tables[0]?.request.columns ?? [];
const mcpColumns = mcpArtifacts.reopenedProject.tables[0]?.request.columns ?? [];
assert.equal(uiColumns.length, 2);
assert.deepEqual(uiColumns, mcpColumns, "Table parity must preserve sqlType, display.width, display.format, display.extras, values, and ordering");
assert.equal(uiColumns[0]?.sqlType, "DOUBLE");
assert.equal(uiColumns[0]?.display?.width, 160);
assert.deepEqual(uiColumns[0]?.display?.format, { kind: "fixed", decimals: 3 });
assert.deepEqual(uiColumns[0]?.display?.extras?.spec, { lsl: 9.8, target: 10.0, usl: 10.2 });

const kinds = new Set(uiArtifacts.reopenedProject.analyses.map((item) => item.analysisKind));
assert.deepEqual(
  [...kinds].sort(),
  ["distribution", "fitModel", "fitYByX", "hypothesisTest"],
  "Round-trip parity must cover every registered analysis kind",
);

assert.equal(uiArtifacts.reopenedProject.reports[0]?.markdown.includes("AI"), false);
assert.equal(mcpArtifacts.reopenedProject.reports[0]?.markdown.includes("AI"), false);

console.log("mcp artifact parity passed");
