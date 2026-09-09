import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createDistributionItem } from "../src/components/distribution/distributionConfig.ts";
import {
  createDistributionAnalysisDocument,
  createFitYByXAnalysisDocument,
} from "../src/components/analysis/adapters/index.ts";
import { resolveReportDependency } from "../src/components/report/ReportEmbed.tsx";
import { useAnalysisStore } from "../src/stores/useAnalysisStore.ts";
import { useDataStore } from "../src/stores/useDataStore.ts";
import { useDistributionStore } from "../src/stores/useDistributionStore.ts";
import { useGraphBuilderStore } from "../src/stores/useGraphBuilderStore.ts";
import { useHistoryStore } from "../src/stores/useHistoryStore.ts";
import { useProjectStore } from "../src/stores/useProjectStore.ts";
import { useTabulateStore } from "../src/stores/useTabulateStore.ts";
import type { DatasetMeta } from "../src/types/data.ts";
import type { FitYByXItem } from "../src/types/fitYByX.ts";
import type { GraphBuilderItem } from "../src/types/graphBuilder.ts";
import type { ReportDependency } from "../src/types/report.ts";
import type { TabulateItem } from "../src/types/tabulate.ts";

function createDataset(overrides: Partial<DatasetMeta> & Pick<DatasetMeta, "id" | "name">): DatasetMeta {
  return {
    sourcePath: null,
    sourceType: "manual",
    rowCount: 24,
    colCount: 4,
    generation: 1,
    createdAt: "2026-09-02T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:00.000Z",
    ...overrides,
  };
}

function createGraph(overrides: Partial<GraphBuilderItem> & Pick<GraphBuilderItem, "id" | "name" | "sourceDatasetId">): GraphBuilderItem {
  return {
    mode: "2d",
    modeStates: {
      twoD: {
        encoding: {},
        multiX: [],
        multiY: [],
        elements: [],
        smootherLambda: 0,
      },
      threeD: {
        encoding: {},
        elements: [],
        smootherLambda: 0,
      },
      multivariate: {
        columns: [],
        chartType: "correlationMatrix",
        correlationMethod: "pearson",
      },
    },
    filters: [],
    sampling: { mode: "full" },
    createdAt: "2026-09-02T00:00:00.000Z",
    ...overrides,
  };
}

function createFitYByX(overrides: Partial<FitYByXItem> & Pick<FitYByXItem, "id" | "name" | "sourceDatasetId">): FitYByXItem {
  return {
    response: { name: "strength", type: "continuous" },
    factor: { name: "time", type: "continuous" },
    personality: "bivariate",
    graph: {
      mode: "2d",
      modeStates: {
        twoD: {
          encoding: {},
          multiX: [],
          multiY: [],
          elements: [],
          smootherLambda: 0,
        },
        threeD: {
          encoding: {},
          elements: [],
          smootherLambda: 0,
        },
        multivariate: {
          columns: [],
          chartType: "correlationMatrix",
          correlationMethod: "pearson",
        },
      },
      filters: [],
      sampling: { mode: "full" },
    },
    createdAt: "2026-09-02T00:00:00.000Z",
    ...overrides,
  };
}

function createTabulate(overrides: Partial<TabulateItem> & Pick<TabulateItem, "id" | "name" | "sourceDatasetId">): TabulateItem {
  return {
    rowFields: ["supplier"],
    columnFields: ["phase"],
    statistics: [{ id: "count", field: "strength", kind: "count" }],
    includeRowTotals: true,
    includeColumnTotals: true,
    createdAt: "2026-09-02T00:00:00.000Z",
    ...overrides,
  };
}

function createDistribution(id: string, name: string, sourceDatasetId: string) {
  const response = { name: "strength", type: "continuous" as const };
  return createDistributionItem({
    id,
    name,
    sourceDatasetId,
    responses: [response],
    weight: null,
    frequency: null,
    by: [],
    columns: [{ name: response.name, sqlType: "DOUBLE", integerCompatible: false, field: response }],
    createdAt: "2026-09-02T00:00:00.000Z",
  });
}

function resetStores(): void {
  useProjectStore.setState({ readOnly: false });
  useDataStore.setState({ activeDatasetId: null, datasets: [], statusInfo: null });
  useGraphBuilderStore.getState().reset();
  useAnalysisStore.getState().reset();
  useTabulateStore.getState().reset();
  useDistributionStore.getState().reset();
}

function assertResolved(
  dependency: ReportDependency,
  expectedName: string,
  expectedDatasetName: string,
  expectedDistributionOrigin?: "analysis" | "legacy",
): void {
  const resolved = resolveReportDependency(dependency);
  assert.equal(resolved.status, "resolved", `${dependency.kind}:${dependency.documentId} should resolve`);
  assert.equal(resolved.source.name, expectedName);
  assert.equal(resolved.source.dataset.name, expectedDatasetName);
  if (expectedDistributionOrigin) {
    assert.equal(resolved.source.kind, "distribution");
    if (resolved.source.kind === "distribution") {
      assert.equal(resolved.source.origin, expectedDistributionOrigin);
    }
  }
}

resetStores();

const dataset = createDataset({ id: "table-1", name: "Incoming Data" });
useDataStore.setState({ activeDatasetId: null, datasets: [dataset], statusInfo: null });
useGraphBuilderStore.getState().loadFromProject([
  createGraph({ id: "graph-1", name: "Scatter Plot", sourceDatasetId: dataset.id }),
]);
const fitYByXAnalysis = createFitYByXAnalysisDocument({
  item: createFitYByX({ id: "fit-1", name: "Strength vs Time", sourceDatasetId: dataset.id }),
  confidenceLevel: 0.95,
  updatedAt: "2026-09-02T00:00:00.000Z",
});
const distributionAnalysis = createDistributionAnalysisDocument(
  createDistribution("distribution-analysis-1", "Analysis Distribution", dataset.id),
  "2026-09-02T00:00:00.000Z",
);
useAnalysisStore.getState().loadAnalyses([fitYByXAnalysis, distributionAnalysis]);
useTabulateStore.getState().loadFromProject([
  createTabulate({ id: "tab-1", name: "Grouped Summary", sourceDatasetId: dataset.id }),
]);
useDistributionStore.getState().loadFromProject([
  createDistribution("distribution-1", "Strength Distribution", dataset.id),
]);

assertResolved({ kind: "table", documentId: "table-1" }, "Incoming Data", "Incoming Data");
assertResolved({ kind: "graph", documentId: "graph-1" }, "Scatter Plot", "Incoming Data");
assertResolved({ kind: "fitYByX", documentId: "fit-1" }, "Strength vs Time", "Incoming Data");
assertResolved({ kind: "tabulate", documentId: "tab-1" }, "Grouped Summary", "Incoming Data");
assertResolved(
  { kind: "distribution", documentId: "distribution-1" },
  "Strength Distribution",
  "Incoming Data",
  "legacy",
);

useDistributionStore.getState().reset();
assertResolved(
  { kind: "distribution", documentId: "distribution-analysis-1" },
  "Analysis Distribution",
  "Incoming Data",
  "analysis",
);
useDistributionStore.getState().loadFromProject([
  createDistribution("distribution-1", "Strength Distribution", dataset.id),
]);

useDataStore.setState({
  activeDatasetId: null,
  datasets: [createDataset({ ...dataset, name: "Incoming Data Renamed" })],
  statusInfo: null,
});
useGraphBuilderStore.getState().renameItem("graph-1", "Scatter Plot Renamed");
useAnalysisStore.getState().updateAnalysis("fit-1", { name: "Strength vs Time Renamed" });
useTabulateStore.getState().renameItem("tab-1", "Grouped Summary Renamed");

assertResolved({ kind: "table", documentId: "table-1" }, "Incoming Data Renamed", "Incoming Data Renamed");
assertResolved({ kind: "graph", documentId: "graph-1" }, "Scatter Plot Renamed", "Incoming Data Renamed");
assertResolved({ kind: "fitYByX", documentId: "fit-1" }, "Strength vs Time Renamed", "Incoming Data Renamed");
assertResolved({ kind: "tabulate", documentId: "tab-1" }, "Grouped Summary Renamed", "Incoming Data Renamed");
assertResolved({ kind: "distribution", documentId: "distribution-1" }, "Strength Distribution", "Incoming Data Renamed");

useAnalysisStore.getState().loadAnalyses([
  createDistributionAnalysisDocument(
    createDistribution("fit-1", "Wrong Kind", dataset.id),
    "2026-09-02T00:00:00.000Z",
  ),
]);
assert.deepEqual(resolveReportDependency({ kind: "fitYByX", documentId: "fit-1" }), {
  status: "missing",
  dependency: { kind: "fitYByX", documentId: "fit-1" },
});

useAnalysisStore.getState().loadAnalyses([fitYByXAnalysis]);
useDataStore.setState({ activeDatasetId: null, datasets: [], statusInfo: null });
assert.deepEqual(resolveReportDependency({ kind: "fitYByX", documentId: "fit-1" }), {
  status: "missing",
  dependency: { kind: "fitYByX", documentId: "fit-1" },
});

assert.deepEqual(resolveReportDependency({ kind: "graph", documentId: "missing-graph" }), {
  status: "missing",
  dependency: { kind: "graph", documentId: "missing-graph" },
});
assert.deepEqual(resolveReportDependency({ kind: "table", documentId: "missing-table" }), {
  status: "missing",
  dependency: { kind: "table", documentId: "missing-table" },
});

const graphEmbedSource = readFileSync(resolve(process.cwd(), "src/components/report/GraphReportEmbed.tsx"), "utf8");
const reportEmbedSource = readFileSync(resolve(process.cwd(), "src/components/report/ReportEmbed.tsx"), "utf8");
const fitYByXAnalysisEmbedSource = readFileSync(resolve(process.cwd(), "src/components/report/FitYByXAnalysisReportEmbed.tsx"), "utf8");
const dataTableSource = readFileSync(resolve(process.cwd(), "src/components/DataTableView.tsx"), "utf8");
const workspaceSource = readFileSync(resolve(process.cwd(), "src/components/Workspace.tsx"), "utf8");

assert.doesNotMatch(graphEmbedSource, /TestRenderOverride|testGraphRenderOverride/, "Production graph embeds must not expose test-only global overrides");
assert.match(reportEmbedSource, /key=\{embedRevision\}/, "Render errors must reset when the embedded source revision changes");
assert.match(reportEmbedSource, /dataRevision/, "Embeds must react to successful table mutations");
assert.doesNotMatch(reportEmbedSource, /useFitYByXStore|FitYByXReportEmbed/, "Report resolution must not use legacy Fit Y by X ownership");
assert.match(fitYByXAnalysisEmbedSource, /useAnalysisExecution/, "Fit Y by X embeds must use shared Analysis execution");
assert.match(fitYByXAnalysisEmbedSource, /FitYByXAnalysisReport/, "Fit Y by X embeds must use shared report composition");
assert.doesNotMatch(fitYByXAnalysisEmbedSource, /useFitYByXReport|AnalysisShell/, "Fit Y by X embeds must not restore legacy execution or the Analysis shell");
assert.match(dataTableSource, /setColumnDisplayProps[\s\S]*invalidateData\(\)/, "Display-property writes must invalidate embeds");
assert.match(workspaceSource, /handleHistoryRestored[\s\S]*invalidateData\(\)/, "Snapshot restores must invalidate embeds");
assert.match(workspaceSource, /onSubmit=\{async \(draft\) => \{[\s\S]*invalidateData\(\)/, "Table Transform submissions must invalidate embeds");

const initialDataRevision = useHistoryStore.getState().dataRevision;
useHistoryStore.getState().recordTable("Edit cell", {
  kind: "cells",
  datasetId: dataset.id,
  generation: 1,
  cells: [{ rowId: 1, columnName: "strength", before: 1, after: 2 }],
});
assert.equal(useHistoryStore.getState().dataRevision, initialDataRevision + 1);

console.log("report embed resolver contract passed");