import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import {
  DistributionGraphGrid,
  DistributionReportPanel,
} from "@/components/distribution/distributionPresentation";
import type { GraphRuntimeProps } from "@/components/graphBuilder/GraphRuntime";
import type { AnalysisDocument } from "@/types/analysis";
import type { DatasetMeta } from "@/types/data";

import {
  useAnalysisExecution,
  type UseAnalysisExecutionRuntime,
} from "./useAnalysisExecution";

interface AnalysisViewProps {
  item: AnalysisDocument;
  dataset?: DatasetMeta | null;
  runtime?: AnalysisViewRuntime;
}

export interface AnalysisViewRuntime extends UseAnalysisExecutionRuntime {
  renderGraph?: (props: GraphRuntimeProps & { role: "overview" | "boxPlot" | "ecdf" | "normalQuantile" }) => ReactNode;
}

export function AnalysisView({ item, dataset, runtime }: AnalysisViewProps) {
  const { t } = useTranslation();
  const executionState = useAnalysisExecution(
    item.analysisKind === "distribution" && item.definition.kind === "distribution" && item.schemaVersion === 1
      ? item
      : null,
    dataset ?? null,
    runtime,
  );

  if (item.schemaVersion !== 1 || item.presentation.schemaVersion !== 1) {
    return (
      <div className="main-content">
        <div className="workspace-empty">
          <h2>{item.name}</h2>
          <p role="alert">{t("workspace.analysisUnsupported", { defaultValue: "Unsupported analysis schema." })}</p>
        </div>
      </div>
    );
  }

  if (item.analysisKind !== "distribution" || item.definition.kind !== "distribution") {
    return (
      <div className="main-content">
        <div className="workspace-empty">
          <h2>{item.name}</h2>
          <p role="alert">{t("workspace.analysisUnsupported", { defaultValue: "Unsupported analysis kind." })}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="distribution-view main-content">
      <header className="distribution-view-header">
        <div>
          <h2>{item.name}</h2>
          <span title={dataset?.name ?? t("workspace.analysisSourceMissing")}>
            {dataset
              ? t("workspace.datasourceLabel", { name: dataset.name })
              : t("workspace.analysisSourceMissing")}
          </span>
        </div>
      </header>

      <section className="distribution-graph-section">
        {dataset == null ? (
          <div className="workspace-empty"><p>{t("workspace.analysisSourceMissing")}</p></div>
        ) : (
          <DistributionGraphGrid
            item={{
              id: item.id,
              name: item.name,
              sourceDatasetId: item.source.datasetId,
              graphs: item.definition.graphs,
              createdAt: item.createdAt,
            }}
            dataset={dataset}
            reportState={executionState}
            renderGraph={runtime?.renderGraph}
          />
        )}
      </section>

      {dataset == null
        ? (
          <section className="distribution-report-section">
            <h2>{t("distribution.report.title", { defaultValue: "Statistical Report" })}</h2>
            <p className="distribution-report-unavailable">{t("workspace.analysisSourceMissing")}</p>
          </section>
        )
        : <DistributionReportPanel reportState={executionState} />}
    </div>
  );
}