import { type ReactNode, useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";

import { createEmbeddedGraphItem } from "@/components/graphBuilder/graphBuilderMode";
import type { GraphRuntimeProps } from "@/components/graphBuilder/GraphRuntime";
import {
  AnalysisFrame,
  AnalysisGraph,
  AnalysisStack,
  AnalysisTable,
  AnalysisText,
} from "@/components/analysis/presentation";
import { ProcessCapabilityReport } from "@/components/distribution/ProcessCapabilityReport";
import { mapDistributionExternalDataState, type DistributionGraphRole } from "@/graphCore/distributionAdapter";
import type { AnalysisDocument } from "@/types/analysis";
import type { DatasetMeta } from "@/types/data";
import type { DistributionReportResponse } from "@/types/distribution";

import {
  useAnalysisExecution,
  type UseAnalysisExecutionRuntime,
} from "./useAnalysisExecution";

import "./analysis.css";

function isSupportedAnalysisDocument(item: AnalysisDocument): boolean {
  return item.schemaVersion === 1
    && item.analysisKind === "distribution"
    && item.definition.kind === "distribution"
    && item.presentation.schemaVersion === 1
    && item.presentation.layout === "distribution-v1";
}

interface AnalysisViewProps {
  item: AnalysisDocument;
  dataset?: DatasetMeta | null;
  runtime?: AnalysisViewRuntime;
}

export interface AnalysisViewRuntime extends UseAnalysisExecutionRuntime {
  renderGraph?: (props: GraphRuntimeProps & { role: DistributionGraphRole }) => ReactNode;
}

export function AnalysisView({ item, dataset, runtime }: AnalysisViewProps) {
  const { t } = useTranslation();
  const documentScrollRef = useRef<HTMLElement | null>(null);
  const supportedItem = isSupportedAnalysisDocument(item) ? item : null;
  const executionState = useAnalysisExecution(
    supportedItem,
    supportedItem == null ? null : (dataset ?? null),
    runtime,
  );
  const graphItems = useMemo(() => ({
    overview: createEmbeddedGraphItem({
      id: `analysis-graph:${item.id}:overview`,
      name: item.name,
      sourceDatasetId: item.source.datasetId,
      config: item.definition.graphs.overview,
      createdAt: item.createdAt,
    }),
    boxPlot: createEmbeddedGraphItem({
      id: `analysis-graph:${item.id}:boxPlot`,
      name: item.name,
      sourceDatasetId: item.source.datasetId,
      config: item.definition.graphs.boxPlot,
      createdAt: item.createdAt,
    }),
  }), [item]);

  useEffect(() => {
    let secondFrame = 0;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => documentScrollRef.current?.scrollTo({ top: 0, left: 0 }));
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(secondFrame);
    };
  }, [executionState.status, item.id]);

  if (item.schemaVersion !== 1) {
    return <UnsupportedAnalysis item={item} message={t("workspace.analysisUnsupported", { defaultValue: "Unsupported analysis schema." })} />;
  }
  if (item.analysisKind !== "distribution" || item.definition.kind !== "distribution") {
    return <UnsupportedAnalysis item={item} message={t("workspace.analysisUnsupported", { defaultValue: "Unsupported analysis kind." })} />;
  }
  if (item.presentation.schemaVersion !== 1 || item.presentation.layout !== "distribution-v1") {
    return <UnsupportedAnalysis item={item} message={t("workspace.analysisUnsupportedPresentation", { defaultValue: "Unsupported analysis presentation." })} />;
  }

  const responseName = item.definition.responses.map((response) => response.name).join(", ");
  const fitName = item.definition.analysis.fitDistributions.join(", ") || "-";

  return (
    <div className="analysis-workspace">
      <aside className="analysis-info-panel">
        <div className="analysis-panel-title">{t("workspace.analysis", { defaultValue: "Analysis" })}</div>
        <div className="analysis-info-body">
          <h2>{item.name}</h2>
          <span className="analysis-source" title={dataset?.name ?? t("workspace.analysisSourceMissing")}>
            {dataset
              ? t("workspace.datasourceLabel", { defaultValue: "Source: {{name}}", name: dataset.name })
              : t("workspace.analysisSourceMissing")}
          </span>
          <dl className="analysis-metadata">
            <Metadata label={t("workspace.analysis", { defaultValue: "Analysis" })} value={t("distribution.title", { defaultValue: "Distribution" })} />
            <Metadata label={t("distribution.response", { defaultValue: "Response" })} value={responseName} />
            <Metadata label="Fit" value={fitName} />
            <Metadata label={t("distribution.statistics.n", { defaultValue: "Rows" })} value={dataset?.rowCount.toLocaleString() ?? "-"} />
          </dl>
        </div>
      </aside>

      <main className="analysis-document-scroll" ref={documentScrollRef}>
        <AnalysisFrame
          title={responseName || item.name}
          contentPadding="compact"
          data-analysis-document
        >
          <AnalysisStack>
            {dataset == null ? (
              <AnalysisFrame title={t("fitYByX.graph", { defaultValue: "Graph" })} data-analysis-block="graph">
                <AnalysisUnavailable message={t("workspace.analysisSourceMissing")} />
              </AnalysisFrame>
            ) : (
              <AnalysisGraph
                title={t("fitYByX.graph", { defaultValue: "Graph" })}
                data-analysis-block="graph"
                contentClassName="analysis-graph-composite"
                runtimeSlots={(["overview", "boxPlot"] as const).map((role) => ({
                  key: role,
                  runtimeProps: {
                      item: graphItems[role],
                      dataset,
                      minPanelHeight: role === "boxPlot" ? 96 : 240,
                      externalDataState: mapDistributionExternalDataState(executionState, role),
                  },
                }))}
                renderGraph={runtime?.renderGraph
                  ? (props, role) => runtime.renderGraph?.({ ...props, role: role as DistributionGraphRole })
                  : undefined}
              />
            )}

            <AnalysisTextBlock state={executionState} />

            <AnalysisFrame title="Summary Statistical" data-analysis-block="tables">
              <AnalysisTables state={executionState} datasetMissing={dataset == null} />
            </AnalysisFrame>

            <AnalysisFrame title="Process Capabilities" data-analysis-block="process-capabilities">
              <AnalysisProcessCapabilities state={executionState} datasetMissing={dataset == null} />
            </AnalysisFrame>
          </AnalysisStack>
        </AnalysisFrame>
      </main>
    </div>
  );
}

function UnsupportedAnalysis({ item, message }: { item: AnalysisDocument; message: string }) {
  return (
    <div className="main-content">
      <div className="workspace-empty">
        <h2>{item.name}</h2>
        <p role="alert">{message}</p>
      </div>
    </div>
  );
}

function Metadata({ label, value }: { label: string; value: string }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}

function AnalysisTextBlock({ state }: { state: ReturnType<typeof useAnalysisExecution> }) {
  const result = state.status === "success" ? firstResult(state.result) : null;
  const summary = result?.blocks.find((block) => block.summaryData)?.summaryData;
  if (!result || !summary) return null;

  return (
    <AnalysisText data-analysis-block="text">
      {result.yName}: n = {formatNumber(summary.n)}, mean = {formatNumber(summary.mean)}, standard deviation = {formatNumber(summary.stdDev)}.
    </AnalysisText>
  );
}

function AnalysisTables({ state, datasetMissing }: {
  state: ReturnType<typeof useAnalysisExecution>;
  datasetMissing: boolean;
}) {
  const { t } = useTranslation();
  if (datasetMissing) return <AnalysisUnavailable message={t("workspace.analysisSourceMissing")} />;
  if (state.status === "idle" || state.status === "loading") {
    return <AnalysisUnavailable message={t("distribution.report.loading", { defaultValue: "Loading report..." })} />;
  }
  if (state.status === "error") return <AnalysisUnavailable message={state.error} alert />;

  const result = firstResult(state.result);
  const summary = result?.blocks.find((block) => block.summaryData)?.summaryData;
  if (!result) return <AnalysisUnavailable message={t("distribution.report.unavailable", { defaultValue: "No results available." })} />;

  return (
    <AnalysisStack>
      <AnalysisTable
        title={t("distribution.report.quantiles", { defaultValue: "Quantiles" })}
        width="standard"
        columns={[
          { key: "probability", label: t("distribution.report.probability") },
          { key: "label", label: t("distribution.report.label") },
          { key: "value", label: t("distribution.report.value"), numeric: true },
        ]}
        rows={result.quantiles.map((quantile) => ({
          key: String(quantile.probability),
          cells: [
            formatProbability(quantile.probability),
            quantileLabel(quantile.probability, t),
            formatNumber(quantile.value),
          ],
        }))}
      />
      {summary && (
        <>
          <SummaryTableFrame title={t("distribution.report.location")} rows={[
            ["n", summary.n], ["mean", summary.mean], ["median", summary.median],
            ["minimum", summary.minimum], ["maximum", summary.maximum],
          ]} />
          <SummaryTableFrame title={t("distribution.report.variation")} rows={[
            ["stdDev", summary.stdDev], ["stdError", summary.stdError],
            ["range", summary.range], ["iqr", summary.iqr], ["mad", summary.mad],
          ]} />
        </>
      )}
    </AnalysisStack>
  );
}

function SummaryTableFrame({ title, rows }: { title: string; rows: Array<[string, number]> }) {
  const { t } = useTranslation();
  return (
    <AnalysisTable
      title={title}
      width="compact"
      columns={[
        { key: "metric", label: t("distribution.report.metric", { defaultValue: "Metric" }) },
        { key: "value", label: t("distribution.report.value"), numeric: true },
      ]}
      rows={rows.map(([label, value]) => ({
        key: label,
        cells: [t(`distribution.statistics.${label}`), formatNumber(value)],
      }))}
    />
  );
}

function AnalysisUnavailable({ message, alert = false }: { message: string; alert?: boolean }) {
  return <p className="analysis-unavailable" role={alert ? "alert" : undefined}>{message}</p>;
}

function firstResult(response: DistributionReportResponse) {
  return response.groups.flatMap((group) => group.yResults)[0] ?? null;
}

function quantileLabel(probability: number, t: (key: string) => string): string {
  if (probability === 0) return t("distribution.statistics.minimum");
  if (probability === 0.25) return "Q1";
  if (probability === 0.5) return t("distribution.statistics.median");
  if (probability === 0.75) return "Q3";
  if (probability === 1) return t("distribution.statistics.maximum");
  return "";
}

function formatProbability(probability: number): string {
  return `${Number.parseFloat((probability * 100).toFixed(3))}%`;
}

function formatNumber(value: number): string {
  return value.toLocaleString(undefined, { maximumSignificantDigits: 10 });
}

function AnalysisProcessCapabilities({ state, datasetMissing }: {
  state: ReturnType<typeof useAnalysisExecution>;
  datasetMissing: boolean;
}) {
  const { t } = useTranslation();
  if (datasetMissing) return <AnalysisUnavailable message={t("workspace.analysisSourceMissing")} />;
  if (state.status === "idle" || state.status === "loading") return null;
  if (state.status === "error") return <AnalysisUnavailable message={state.error} alert />;

  const capabilityData = state.result.groups
    .flatMap((group) => group.yResults)
    .flatMap((result) => result.blocks)
    .find((block) => block.capabilityData)?.capabilityData;

  return capabilityData
    ? <ProcessCapabilityReport data={capabilityData} />
    : <AnalysisUnavailable message={t("distribution.report.unavailable", { defaultValue: "Process capability requires specification limits." })} />;
}