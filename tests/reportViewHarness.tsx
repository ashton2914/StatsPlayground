import { useEffect, useState } from "react";

import { createDistributionItem } from "../src/components/distribution/distributionConfig.ts";
import { ReportView, type ReportLinkOption } from "../src/components/report/ReportView";
import type { ReportEmbedRuntime } from "../src/components/report/ReportEmbed.tsx";
import { useDataStore } from "../src/stores/useDataStore.ts";
import { useDistributionStore } from "../src/stores/useDistributionStore.ts";
import { useFitYByXStore } from "../src/stores/useFitYByXStore.ts";
import { useGraphBuilderStore } from "../src/stores/useGraphBuilderStore.ts";
import { useProjectStore } from "../src/stores/useProjectStore.ts";
import { useTabulateStore } from "../src/stores/useTabulateStore.ts";
import type { DatasetMeta } from "../src/types/data.ts";
import type { DistributionItem } from "../src/types/distribution.ts";
import type { FitYByXItem } from "../src/types/fitYByX.ts";
import type { GraphBuilderItem } from "../src/types/graphBuilder.ts";
import type { ReportItem } from "../src/types/report";
import type { TabulateItem } from "../src/types/tabulate.ts";

const baseItem: ReportItem = {
  schemaVersion: 1,
  id: "report-1",
  name: "Weekly Summary",
  markdown: "",
  createdAt: "2026-09-02T10:00:00.000Z",
  updatedAt: "2026-09-02T10:00:00.000Z",
};

const tableOptions: ReportLinkOption[] = [{ id: "table-1", name: "Incoming Data" }];
const graphOptions: ReportLinkOption[] = [{ id: "graph-1", name: "Scatter Plot" }];
const fitYByXOptions: ReportLinkOption[] = [{ id: "fit-1", name: "Strength vs Time" }];
const tabulateOptions: ReportLinkOption[] = [{ id: "tab-1", name: "Grouped Summary" }];
const distributionOptions: ReportLinkOption[] = [{ id: "distribution-1", name: "Strength Distribution" }];

const defaultDataset: DatasetMeta = {
  id: "table-1",
  name: "Incoming Data",
  sourcePath: null,
  sourceType: "manual",
  rowCount: 24,
  colCount: 4,
  createdAt: "2026-09-02T10:00:00.000Z",
  updatedAt: "2026-09-02T10:00:00.000Z",
};

const defaultGraph: GraphBuilderItem = {
  id: "graph-1",
  name: "Scatter Plot",
  sourceDatasetId: defaultDataset.id,
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
  createdAt: "2026-09-02T10:00:00.000Z",
};

const defaultFitYByX: FitYByXItem = {
  id: "fit-1",
  name: "Strength vs Time",
  sourceDatasetId: defaultDataset.id,
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
  createdAt: "2026-09-02T10:00:00.000Z",
};

const defaultTabulate: TabulateItem = {
  id: "tab-1",
  name: "Grouped Summary",
  sourceDatasetId: defaultDataset.id,
  rowFields: ["supplier"],
  columnFields: ["phase"],
  statistics: [{ id: "count", field: "strength", kind: "count" }],
  includeRowTotals: true,
  includeColumnTotals: true,
  createdAt: "2026-09-02T10:00:00.000Z",
};

const distributionResponse = { name: "strength", type: "continuous" as const };
const defaultDistribution: DistributionItem = createDistributionItem({
  id: "distribution-1",
  name: "Strength Distribution",
  sourceDatasetId: defaultDataset.id,
  responses: [distributionResponse],
  weight: null,
  frequency: null,
  by: [],
  columns: [{
    name: distributionResponse.name,
    sqlType: "DOUBLE",
    integerCompatible: false,
    field: distributionResponse,
  }],
  createdAt: "2026-09-02T10:00:00.000Z",
});

const LIVE_EMBED_RUNTIME: ReportEmbedRuntime = {
  table: {
    getDatasetGeneration: async () => 7,
    queryTableWindow: async () => ({
      columns: ["supplier", "strength"],
      columnTypes: ["VARCHAR", "DOUBLE"],
      rows: [["A", 12.3], ["B", 14.8]],
      totalRows: 2,
      start: 0,
      generation: 7,
    }),
  },
  fitYByX: {
    getDatasetGeneration: async () => 11,
    run: async () => ({
      kind: "bivariate",
      usedRows: 12,
      excludedRows: 0,
      confidenceLevel: 0.95,
      intercept: 1.2,
      slope: 0.7,
      summaryOfFit: {
        rSquared: 0.8,
        adjustedRSquared: 0.78,
        rootMeanSquareError: 1.1,
        meanOfResponse: 10,
        observationCount: 12,
      },
      lackOfFit: { state: "notIdentifiable" },
      anova: [],
      parameterEstimates: [],
    }),
  },
  tabulate: {
    getColumns: async () => [["supplier", "VARCHAR"], ["phase", "VARCHAR"], ["strength", "DOUBLE"]],
    getColumnDisplayProps: async () => [],
    run: async () => ({
      rowMembers: [["A"]],
      columnMembers: [["EV"]],
      statistics: [{ id: "count", field: "strength", kind: "count" }],
      cells: [4],
      rowTotals: [4],
      columnTotals: [4],
      grandTotals: [4],
      cellCount: 1,
      limit: 10000,
    }),
  },
  distribution: {
    getDatasetGeneration: async () => 13,
    compute: async () => {
      const frame = { columns: [], rows: [], aggregatePackets: [], totalRows: 0 } as never;
      return {
        datasetId: "table-1",
        generation: 13,
        groups: [],
        reportBlocks: [],
        graphFrames: { overview: frame, boxPlot: frame, ecdf: frame, normalQuantile: frame },
      };
    },
  },
};

const NOT_COMPUTABLE_RUNTIME: ReportEmbedRuntime = {
  fitYByX: {
    getDatasetGeneration: async () => 11,
    run: async () => ({
      kind: "notComputable",
      personality: "bivariate",
      reason: "insufficientValidRows",
      usedRows: 1,
      excludedRows: 2,
      confidenceLevel: 0.95,
    }),
  },
};

interface ReportViewHarnessProps {
  initialMarkdown?: string;
  embedRuntime?: ReportEmbedRuntime;
  datasets?: DatasetMeta[];
  graphs?: GraphBuilderItem[];
  fitYByX?: FitYByXItem[];
  tabulates?: TabulateItem[];
  distributions?: DistributionItem[];
  graphMode?: "runtime" | "stub" | "error";
  distributionGraphMode?: "runtime" | "stub";
  embedMode?: "default" | "live" | "notComputable";
}

export function ReportViewHarness({
  initialMarkdown = "",
  embedRuntime,
  datasets = [defaultDataset],
  graphs = [defaultGraph],
  fitYByX = [defaultFitYByX],
  tabulates = [defaultTabulate],
  distributions = [defaultDistribution],
  graphMode = "runtime",
  distributionGraphMode = "runtime",
  embedMode = "default",
}: ReportViewHarnessProps) {
  const [markdown, setMarkdown] = useState(initialMarkdown);

  useEffect(() => {
    useProjectStore.setState({ readOnly: false });
    useDataStore.setState({ activeDatasetId: null, datasets, statusInfo: null });
    useGraphBuilderStore.getState().loadFromProject(graphs);
    useFitYByXStore.getState().loadFromProject(fitYByX);
    useTabulateStore.getState().loadFromProject(tabulates);
    useDistributionStore.getState().loadFromProject(distributions);
  }, [datasets, distributions, fitYByX, graphs, tabulates]);

  const selectedRuntime = embedMode === "live"
    ? LIVE_EMBED_RUNTIME
    : embedMode === "notComputable"
      ? NOT_COMPUTABLE_RUNTIME
      : embedRuntime;
  const graphRuntime = graphMode === "stub"
    ? { render: ({ item, dataset }: Parameters<NonNullable<NonNullable<ReportEmbedRuntime["graph"]>["render"]>>[0]) => <div>{`Graph:${item.name}:${dataset.name}`}</div> }
    : graphMode === "error"
      ? { render: () => { throw new Error("graph exploded"); } }
      : selectedRuntime?.graph;
  const distributionRuntime = distributionGraphMode === "stub"
    ? {
        ...selectedRuntime?.distribution,
        renderGraph: ({ role }: Parameters<NonNullable<NonNullable<ReportEmbedRuntime["distribution"]>["renderGraph"]>>[0]) => (
          <div>{`Distribution graph:${role}`}</div>
        ),
      }
    : selectedRuntime?.distribution;

  return (
    <ReportView
      item={{ ...baseItem, markdown, updatedAt: "2026-09-02T10:05:00.000Z" }}
      tableOptions={tableOptions}
      graphOptions={graphOptions}
      fitYByXOptions={fitYByXOptions}
      tabulateOptions={tabulateOptions}
      distributionOptions={distributionOptions}
      embedRuntime={{ ...selectedRuntime, graph: graphRuntime, distribution: distributionRuntime }}
      onMarkdownChange={setMarkdown}
    />
  );
}

export function ReportEmbedRecoveryHarness() {
  const [recovered, setRecovered] = useState(false);
  const graph = recovered ? { ...defaultGraph, name: "Recovered Graph" } : defaultGraph;

  return (
    <>
      <button type="button" onClick={() => setRecovered(true)}>Recover graph</button>
      <ReportViewHarness
        initialMarkdown={'{{sp-embed kind="graph" id="graph-1"}}'}
        graphs={[graph]}
        graphMode={recovered ? "stub" : "error"}
      />
    </>
  );
}
