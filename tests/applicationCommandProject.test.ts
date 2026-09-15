import assert from "node:assert/strict";

import type { AnalysisDocument } from "@/types/analysis";
import type { DatasetMeta } from "@/types/data";
import type { GraphBuilderItem } from "@/types/graphBuilder";
import type { ProjectInfo } from "@/types/project";
import type { ReportItem } from "@/types/report";
import type { TabulateItem } from "@/types/tabulate";
import type { TableTransformDefinition } from "@/types/tableTransform";
import {
  createProjectCommandHandlers,
  type ProjectCommandDependencies,
} from "@/applicationCommands/projectCommands";
import { CommandExecutionError } from "@/applicationCommands/runtime";

function createDataset(input: Partial<DatasetMeta> & Pick<DatasetMeta, "id" | "name">): DatasetMeta {
  return {
    id: input.id,
    name: input.name,
    sourcePath: input.sourcePath ?? "/Users/ashton/data/source.csv",
    sourceType: input.sourceType ?? "csv",
    rowCount: input.rowCount ?? 0,
    colCount: input.colCount ?? 0,
    generation: input.generation ?? 1,
    createdAt: input.createdAt ?? "2026-09-15T00:00:00.000Z",
    updatedAt: input.updatedAt ?? "2026-09-15T00:00:00.000Z",
  };
}

function createDeps(overrides: Partial<ProjectCommandDependencies> = {}): ProjectCommandDependencies {
  const project: ProjectInfo = {
    name: "Task2",
    filePath: "/Users/ashton/projects/task2.spprj",
    createdAt: "2026-09-14T00:00:00.000Z",
  };

  const datasets: DatasetMeta[] = [
    createDataset({ id: "tbl-c", name: "C", rowCount: 30, colCount: 3 }),
    createDataset({ id: "tbl-a", name: "A", rowCount: 10, colCount: 2 }),
    createDataset({ id: "tbl-b", name: "B", rowCount: 20, colCount: 4 }),
  ];

  const tableTransforms: TableTransformDefinition[] = [{
    id: "tt-1",
    name: "Transform 1",
    formatVersion: "1",
    revision: 1,
    inputSlots: [],
    operation: { kind: "transpose" },
    output: { tableDocumentId: "tbl-a", name: "Out" },
  }];

  const graphs: GraphBuilderItem[] = [{
    id: "gr-1",
    name: "Graph 1",
    sourceDatasetId: "tbl-a",
    mode: "2d",
    modeStates: {
      twoD: {
        encoding: {},
        multiX: [],
        multiY: [],
        elements: [{ kind: "points", enabled: true }],
        smootherLambda: 0.4,
      },
      threeD: {
        encoding: {},
        elements: [{ kind: "scatter3d", enabled: true }],
        smootherLambda: 0.4,
      },
      multivariate: {
        columns: [],
        chartType: "correlationMatrix",
        correlationMethod: "pearson",
      },
    },
    createdAt: "2026-09-15T00:00:00.000Z",
  }];

  const reports: ReportItem[] = [{
    schemaVersion: 1,
    id: "rp-1",
    name: "Report 1",
    markdown: "Absolute path /Users/ashton/secret should be redacted.",
    createdAt: "2026-09-15T00:00:00.000Z",
    updatedAt: "2026-09-15T00:00:00.000Z",
  }];

  const analyses: AnalysisDocument[] = [{
    schemaVersion: 1,
    documentType: "analysis",
    id: "an-1",
    name: "Distribution 1",
    analysisKind: "distribution",
    configRevision: 1,
    source: { datasetId: "tbl-a" },
    definition: {
      kind: "distribution",
      responses: [],
      weight: null,
      frequency: null,
      by: [],
      nestedSubgroup: null,
      analysis: {
        quantiles: [0.25, 0.5, 0.75],
        showBoxplotOutliers: true,
        includeNormalityTests: true,
      },
      graphs: {
        histogram: true,
        quantile: false,
        boxPlot: true,
      },
    },
    presentation: {
      schemaVersion: 1,
      layout: "distribution-v1",
    },
    createdAt: "2026-09-15T00:00:00.000Z",
    updatedAt: "2026-09-15T00:00:00.000Z",
  }];

  const tabulates: TabulateItem[] = [{
    id: "tb-1",
    name: "Tabulate 1",
    sourceDatasetId: "tbl-a",
    rowFields: ["Build"],
    columnFields: [],
    statistics: [{ id: "s1", field: "Width", kind: "mean" }],
    includeRowTotals: true,
    includeColumnTotals: true,
    createdAt: "2026-09-15T00:00:00.000Z",
  }];

  return {
    getProjectState: () => ({
      project,
      dirty: true,
      readOnly: false,
      projectRevision: 7,
    }),
    listDatasets: () => datasets,
    listTableTransforms: () => tableTransforms,
    listGraphs: () => graphs,
    listReports: () => reports,
    listAnalyses: () => analyses,
    listTabulates: () => tabulates,
    getColumns: async () => [["Length", "DOUBLE"], ["Build", "VARCHAR"]],
    getColumnDisplayProps: async () => [{
      colIndex: 0,
      width: 144,
      format: { kind: "numeric", decimals: 3, currency: "USD" },
      extras: { unit: { symbol: "mm" }, spec: { lower: 1, upper: 2 } },
    }, {
      colIndex: 1,
      width: 120,
      extras: { valueOrder: ["EV", "DV"] },
    }],
    getDatasetGeneration: async () => 13,
    queryTableWindow: async (request) => ({
      columns: ["Length", "Build"],
      columnTypes: ["DOUBLE", "VARCHAR"],
      rows: [
        [1.1, "EV"],
        [1.2, "DV"],
        [1.3, "PQ"],
      ],
      totalRows: 300,
      start: request.start,
      generation: request.generation,
    }),
    ...overrides,
  };
}

{
  const handlers = createProjectCommandHandlers(createDeps());
  const result = await handlers.inspectProject({ includeCapabilities: true });

  assert.equal(result.dirty, true);
  assert.equal(result.projectRevision, 7);
  assert.equal(result.counts.tables, 3);
  assert.equal(result.counts.tableTransforms, 1);
  assert.equal(result.project.filePath, undefined);
  assert.equal(JSON.stringify(result).includes("/Users/"), false);
  assert.equal(result.capabilities?.table?.describePreview, true);
}

{
  const handlers = createProjectCommandHandlers(createDeps());
  const page1 = await handlers.listProjectTables({ limit: 2 });
  assert.deepEqual(page1.items.map((item) => item.id), ["tbl-a", "tbl-b"]);
  assert.equal(page1.items[0]?.sourcePath, undefined);
  assert.equal(page1.nextCursor, "tbl-b");

  const page2 = await handlers.listProjectTables({ limit: 2, cursor: page1.nextCursor ?? undefined });
  assert.deepEqual(page2.items.map((item) => item.id), ["tbl-c"]);
  assert.equal(page2.nextCursor, null);
}

{
  const handlers = createProjectCommandHandlers(createDeps());
  const describe = await handlers.describeProjectTable({
    datasetId: "tbl-a",
    preview: { offset: 10, limit: 2 },
  });

  assert.equal(describe.dataset.id, "tbl-a");
  assert.equal(describe.generation, 13);
  assert.equal(describe.columns.length, 2);
  assert.deepEqual(describe.columns[0], {
    colIndex: 0,
    colName: "Length",
    colType: "DOUBLE",
    width: 144,
    format: { kind: "numeric", decimals: 3, currency: "USD" },
    extras: { unit: { symbol: "mm" }, spec: { lower: 1, upper: 2 } },
  });
  assert.deepEqual(describe.preview, {
    offset: 10,
    limit: 2,
    totalRows: 300,
    rows: [
      { rowIndex: 10, cells: [{ colIndex: 0, value: 1.1 }, { colIndex: 1, value: "EV" }] },
      { rowIndex: 11, cells: [{ colIndex: 0, value: 1.2 }, { colIndex: 1, value: "DV" }] },
    ],
  });

  await assert.rejects(
    handlers.describeProjectTable({ datasetId: "tbl-a", preview: { limit: 0 } }),
    /limit/i,
  );
  await assert.rejects(
    handlers.describeProjectTable({ datasetId: "tbl-a", preview: { limit: 201 } }),
    /limit/i,
  );
}

{
  const handlers = createProjectCommandHandlers(createDeps());
  const kinds = ["tableTransform", "graph", "analysis", "tabulate", "report"] as const;

  for (const kind of kinds) {
    const listed = await handlers.listProjectDocuments({ kind, limit: 10 });
    assert.equal(listed.items.length, 1);
    const fetched = await handlers.getProjectDocument({ kind, id: listed.items[0]!.id });
    assert.equal(fetched.kind, kind);
    assert.equal(JSON.stringify(fetched).includes("/Users/"), false);
  }
}

{
  const handlers = createProjectCommandHandlers(createDeps({
    listReports: () => [{
      schemaVersion: 1,
      id: "rp-redact",
      name: "Report redact",
      markdown: [
        "Keep URL https://example.com/foo/bar and relative/data.csv unchanged.",
        "Keep ordinary relative token folder/item unchanged.",
        "POSIX roots: /etc/hosts and /opt/local/bin/tool",
        "Arbitrary POSIX roots: /srv/build/output.csv and /data/Team Share/input.csv",
        "Mounted volume with spaces: /Volumes/Work Disk/A Folder/input.csv",
        "Windows with spaces: C:\\Program Files\\Stats Playground\\input.csv",
        "UNC path: \\\\server\\share\\Folder Name\\input.csv",
        "UNC with spaced share: \\\\server\\share name\\Folder Name\\input.csv",
      ].join("\n"),
      createdAt: "2026-09-15T00:00:00.000Z",
      updatedAt: "2026-09-15T00:00:00.000Z",
    }],
  }));

  const fetched = await handlers.getProjectDocument({ kind: "report", id: "rp-redact" });
  const serialized = JSON.stringify(fetched);
  assert.equal(serialized.includes("/etc/hosts"), false);
  assert.equal(serialized.includes("/opt/local/bin/tool"), false);
  assert.equal(serialized.includes("/srv/build/output.csv"), false);
  assert.equal(serialized.includes("/data/Team Share/input.csv"), false);
  assert.equal(serialized.includes("/Volumes/Work Disk/A Folder/input.csv"), false);
  assert.equal(serialized.includes("C:\\Program Files\\Stats Playground\\input.csv"), false);
  assert.equal(serialized.includes("\\\\server\\share\\Folder Name\\input.csv"), false);
  assert.equal(serialized.includes("\\\\server\\share name\\Folder Name\\input.csv"), false);
  assert.equal(serialized.includes("https://example.com/foo/bar"), true);
  assert.equal(serialized.includes("relative/data.csv"), true);
  assert.equal(serialized.includes("folder/item"), true);
}

{
  const handlers = createProjectCommandHandlers(createDeps());
  await assert.rejects(
    handlers.listProjectTables({ cursor: "does-not-exist", limit: 5 }),
    (error) => error instanceof CommandExecutionError && error.code === "invalid_input",
  );
}

{
  const handlers = createProjectCommandHandlers(createDeps());
  await assert.rejects(
    handlers.listProjectDocuments({ cursor: "missing-cursor", limit: 5 }),
    (error) => error instanceof CommandExecutionError && error.code === "invalid_input",
  );
}

console.log("application command project tests passed");