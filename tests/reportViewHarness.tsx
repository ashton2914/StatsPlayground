import { useEffect, useState } from "react";
import { TabulateReportEmbed } from "../src/components/report/TabulateReportEmbed";
import type { TabulateReportEmbedRuntime } from "../src/components/report/TabulateReportEmbed";
import type { TabulateSessionStatus } from "../src/types/tabulate";
import "../src/components/tabulate/tabulate.css";

import { createDistributionItem } from "../src/components/distribution/distributionConfig.ts";
import {
  createDistributionAnalysisDocument,
  createFitYByXAnalysisDocument,
} from "../src/components/analysis/adapters/index.ts";
import { ReportView, type ReportLinkOption } from "../src/components/report/ReportView";
import type { ReportEmbedRuntime } from "../src/components/report/ReportEmbed.tsx";
import { useDataStore } from "../src/stores/useDataStore.ts";
import { useAnalysisStore } from "../src/stores/useAnalysisStore.ts";
import { useDistributionStore } from "../src/stores/useDistributionStore.ts";
import { useGraphBuilderStore } from "../src/stores/useGraphBuilderStore.ts";
import { useProjectStore } from "../src/stores/useProjectStore.ts";
import { useTabulateStore } from "../src/stores/useTabulateStore.ts";
import type { DatasetMeta } from "../src/types/data.ts";
import type { DistributionItem } from "../src/types/distribution.ts";
import type { AnalysisDocument } from "../src/types/analysis.ts";
import type { FitYByXItem } from "../src/types/fitYByX.ts";
import type { FitYByXRequest } from "../src/types/fitYByX.ts";
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
const hypothesisTestOptions: ReportLinkOption[] = [{ id: "hypothesis-1", name: "Supplier Comparison" }];
const tabulateOptions: ReportLinkOption[] = [{ id: "tab-1", name: "Grouped Summary" }];
const distributionOptions: ReportLinkOption[] = [{ id: "distribution-1", name: "Strength Distribution" }];

const defaultDataset: DatasetMeta = {
  id: "table-1",
  name: "Incoming Data",
  sourcePath: null,
  sourceType: "manual",
  rowCount: 24,
  colCount: 4,
  generation: 11,
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

const defaultFitYByXAnalysis = createFitYByXAnalysisDocument({
  item: defaultFitYByX,
  confidenceLevel: 0.95,
  updatedAt: defaultFitYByX.createdAt,
});

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

export function TabulateReportLifecycleHarness({ late = false }: { late?: boolean }) {
  const [visible, setVisible] = useState(true);
  const [generation, setGeneration] = useState(11);
  const [, refresh] = useState(0);
  const [evidence] = useState(() => ({ prepared: [] as string[], released: [] as string[], windows: [] as number[][], legacy: 0 }));
  const [pending] = useState(() => [] as Array<() => void>);
  const [runtime] = useState(() => {
    const statuses = new Map<string, TabulateSessionStatus>();
    const changed = () => refresh((value) => value + 1);
    return {
      getColumns: async () => [["supplier", "VARCHAR"], ["phase", "VARCHAR"], ["strength", "DOUBLE"]],
      getColumnDisplayProps: async () => [],
      session: {
        prepare: async (request) => {
          const status: TabulateSessionStatus = { sessionId: `report-${evidence.prepared.length}`, fingerprint: `fp-${request.sourceGeneration}`,
            sourceGeneration: request.sourceGeneration, state: "ready", rowMemberCount: 1000000,
            columnMemberCount: 100000, logicalCellCount: 100000000000, measuredMemberIndexBytes: 1024 };
          statuses.set(status.sessionId, status);
          evidence.prepared.push(status.sessionId); changed();
          if (late) await new Promise<void>((resolve) => pending.push(resolve));
          return status;
        },
        getStatus: async (id) => statuses.get(id)!,
        queryWindow: async (request) => {
          evidence.windows.push([request.rowStart, request.columnStart, request.rowCount, request.columnCount]); changed();
          return { ...request, fingerprint: statuses.get(request.sessionId)!.fingerprint,
            rowMembers: Array.from({ length: request.rowCount }, (_, index) => [`Row ${request.rowStart + index}`]),
            columnMembers: Array.from({ length: request.columnCount }, (_, index) => [`Column ${request.columnStart + index}`]),
            rowMemberBefore: request.rowStart ? [`Row ${request.rowStart - 1}`] : null,
            rowMemberAfter: request.rowStart + request.rowCount < 1000000 ? [`Row ${request.rowStart + request.rowCount}`] : null,
            columnMemberBefore: request.columnStart ? [`Column ${request.columnStart - 1}`] : null,
            columnMemberAfter: request.columnStart + request.columnCount < 100000 ? [`Column ${request.columnStart + request.columnCount}`] : null,
            statistics: defaultTabulate.statistics, cells: [{ rowIndex: 0, columnIndex: 0, statisticIndex: 0, value: request.rowStart + request.columnStart + 4 }],
            rowTotalsReady: false, columnTotalsReady: false, rowMemberCount: 1000000, columnMemberCount: 100000 };
        },
        queryTotals: async (request) => ({ ...request, fingerprint: statuses.get(request.sessionId)!.fingerprint, rowTotals: [], columnTotals: [], grandTotals: [] }),
        cancelRequest: async () => {},
        release: async (id) => { evidence.released.push(id); changed(); },
      },
    } satisfies TabulateReportEmbedRuntime;
  });
  useEffect(() => {
    const readOnly = useProjectStore.getState().readOnly;
    useProjectStore.setState({ readOnly: true });
    return () => { useProjectStore.setState({ readOnly }); };
  }, []);
  return <div style={{ width: "100%" }}>
    <button onClick={() => setVisible(false)}>Unmount Tabulate</button>
    <button onClick={() => setGeneration((value) => value + 1)}>Change generation</button>
    <button onClick={() => pending.splice(0).forEach((resolve) => resolve())}>Finish prepare</button>
    <output data-testid="tabulate-report-evidence" hidden>{JSON.stringify(evidence)}</output>
    {visible ? <TabulateReportEmbed runtime={runtime} source={{ kind: "tabulate", name: defaultTabulate.name,
      item: { ...defaultTabulate, includeRowTotals: false, includeColumnTotals: false }, dataset: { ...defaultDataset, generation } }} /> : null}
  </div>;
}

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
const defaultDistributionAnalysis = createDistributionAnalysisDocument(
  defaultDistribution,
  defaultDistribution.createdAt,
);

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
    computeFitYByX: async (request: FitYByXRequest) => ({
      datasetId: request.datasetId,
      generation: request.generation,
      result: {
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
      },
    }),
  },
  tabulate: {
    getColumns: async () => [["supplier", "VARCHAR"], ["phase", "VARCHAR"], ["strength", "DOUBLE"]],
    getColumnDisplayProps: async () => [],
    session: {
      prepare: async (request) => ({ sessionId: "live-report", fingerprint: "live-report-fp", sourceGeneration: request.sourceGeneration,
        state: "ready", rowMemberCount: 1, columnMemberCount: 1, logicalCellCount: 1, measuredMemberIndexBytes: 128 }),
      getStatus: async () => { throw new Error("ready session must not poll"); },
      queryWindow: async (request) => ({ ...request, fingerprint: "live-report-fp", rowMembers: [["A"]], columnMembers: [["EV"]],
        rowMemberBefore: null, rowMemberAfter: null, columnMemberBefore: null, columnMemberAfter: null,
        statistics: defaultTabulate.statistics, cells: [{ rowIndex: 0, columnIndex: 0, statisticIndex: 0, value: 4 }],
        rowMemberCount: 1, columnMemberCount: 1, rowTotalsReady: false, columnTotalsReady: false }),
      queryTotals: async (request) => ({ ...request, fingerprint: "live-report-fp",
        rowTotals: request.totals.kind === "rows" ? [{ memberIndex: 0, statisticIndex: 0, value: 4 }] : [],
        columnTotals: request.totals.kind === "columns" ? [{ memberIndex: 0, statisticIndex: 0, value: 4 }] : [],
        grandTotals: request.totals.kind === "grand" ? [4] : [] }),
      cancelRequest: async () => {},
      release: async () => {},
    },
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
    computeFitYByX: async (request: FitYByXRequest) => ({
      datasetId: request.datasetId,
      generation: request.generation,
      result: {
        kind: "notComputable",
        personality: "bivariate",
        reason: "insufficientValidRows",
        usedRows: 1,
        excludedRows: 2,
        confidenceLevel: 0.95,
      },
    }),
  },
};

interface ReportViewHarnessProps {
  initialMarkdown?: string;
  embedRuntime?: ReportEmbedRuntime;
  datasets?: DatasetMeta[];
  graphs?: GraphBuilderItem[];
  analyses?: AnalysisDocument[];
  tabulates?: TabulateItem[];
  distributions?: DistributionItem[];
  graphMode?: "runtime" | "stub" | "error";
  distributionGraphMode?: "runtime" | "stub";
  embedMode?: "default" | "live" | "notComputable";
  readOnly?: boolean;
}

export function ReportViewHarness({
  initialMarkdown = "",
  embedRuntime,
  datasets = [defaultDataset],
  graphs = [defaultGraph],
  analyses = [defaultFitYByXAnalysis, defaultDistributionAnalysis],
  tabulates = [defaultTabulate],
  distributions = [defaultDistribution],
  graphMode = "runtime",
  distributionGraphMode = "runtime",
  embedMode = "default",
  readOnly = false,
}: ReportViewHarnessProps) {
  const [markdown, setMarkdown] = useState(initialMarkdown);

  useEffect(() => {
    useProjectStore.setState({ readOnly: false });
    useDataStore.setState({ activeDatasetId: null, datasets, statusInfo: null });
    useGraphBuilderStore.getState().loadFromProject(graphs);
    useAnalysisStore.getState().loadAnalyses(analyses);
    useTabulateStore.getState().loadFromProject(tabulates);
    useDistributionStore.getState().loadFromProject(distributions);
  }, [analyses, datasets, distributions, graphs, tabulates]);

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
    <>
      <ReportView
        item={{ ...baseItem, markdown, updatedAt: "2026-09-02T10:05:00.000Z" }}
        tableOptions={tableOptions}
        graphOptions={graphOptions}
        fitYByXOptions={fitYByXOptions}
        hypothesisTestOptions={hypothesisTestOptions}
        tabulateOptions={tabulateOptions}
        distributionOptions={distributionOptions}
        embedRuntime={{ ...selectedRuntime, graph: graphRuntime, distribution: distributionRuntime }}
        onMarkdownChange={setMarkdown}
        readOnly={readOnly}
      />
      <output data-testid="report-markdown" hidden>{markdown}</output>
    </>
  );
}

export function ReportExternalUpdateHarness() {
  const [markdown, setMarkdown] = useState("Initial");
  const [changeCount, setChangeCount] = useState(0);

  return (
    <>
      <button type="button" onClick={() => setMarkdown("## External")}>Load external Markdown</button>
      <ReportView
        item={{ ...baseItem, markdown, updatedAt: "2026-09-02T10:05:00.000Z" }}
        tableOptions={tableOptions}
        graphOptions={graphOptions}
        fitYByXOptions={fitYByXOptions}
        hypothesisTestOptions={hypothesisTestOptions}
        tabulateOptions={tabulateOptions}
        distributionOptions={distributionOptions}
        onMarkdownChange={(nextMarkdown) => {
          setChangeCount((count) => count + 1);
          setMarkdown(nextMarkdown);
        }}
      />
      <output data-testid="change-count">{changeCount}</output>
    </>
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
