import { lazy, Suspense, type ComponentType, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import type { GraphRuntimeProps } from "@/components/graphBuilder/GraphRuntime";

import type { ReportResolvedSource } from "./ReportEmbed";

const DefaultGraphRuntime = lazy(async () => ({
  default: (await import("@/components/graphBuilder/GraphRuntime")).GraphRuntime,
}));

export interface GraphReportEmbedRuntime {
  RuntimeComponent?: ComponentType<GraphRuntimeProps>;
  render?: (props: GraphRuntimeProps) => ReactNode;
}

export function GraphReportEmbed({
  source,
  runtime,
}: {
  source: Extract<ReportResolvedSource, { kind: "graph" }>;
  runtime?: GraphReportEmbedRuntime;
}) {
  const { t } = useTranslation();
  const RuntimeComponent = runtime?.RuntimeComponent;
  const render = runtime?.render;

  return (
    <section className="sp-report-embed-card" data-kind="graph">
      <div className="sp-report-embed-header">
        <span className="sp-report-embed-title">{source.name}</span>
        <span className="sp-report-embed-meta">{t("workspace.datasourceLabel", { name: source.dataset.name })}</span>
      </div>
      <div className="sp-report-embed-graph-shell">
        {render ? (
          render({ item: source.item, dataset: source.dataset })
        ) : RuntimeComponent ? (
          <RuntimeComponent item={source.item} dataset={source.dataset} />
        ) : (
          <Suspense fallback={<div className="sp-report-embed-loading">{t("common.loading")}</div>}>
            <DefaultGraphRuntime item={source.item} dataset={source.dataset} />
          </Suspense>
        )}
      </div>
    </section>
  );
}