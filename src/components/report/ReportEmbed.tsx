import { Component, lazy, Suspense, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import type { FitYByXReportDependencies } from "@/components/fitYByX/useFitYByXReport";
import { useDataStore } from "@/stores/useDataStore";
import { useDistributionStore } from "@/stores/useDistributionStore";
import { useFitYByXStore } from "@/stores/useFitYByXStore";
import { useGraphBuilderStore } from "@/stores/useGraphBuilderStore";
import { useHistoryStore } from "@/stores/useHistoryStore";
import { useTabulateStore } from "@/stores/useTabulateStore";
import type { DatasetMeta } from "@/types/data";
import type { DistributionItem } from "@/types/distribution";
import type { FitYByXItem } from "@/types/fitYByX";
import type { GraphBuilderItem } from "@/types/graphBuilder";
import type { ReportDependency } from "@/types/report";
import type { TabulateItem } from "@/types/tabulate";

import type { DistributionReportEmbedRuntime } from "./DistributionReportEmbed";
import type { FitYByXReportEmbedRuntime } from "./FitYByXReportEmbed";
import type { GraphReportEmbedRuntime } from "./GraphReportEmbed";
import type { TableReportEmbedRuntime } from "./TableReportEmbed";
import type { TabulateReportEmbedRuntime } from "./TabulateReportEmbed";

const DistributionReportEmbed = lazy(async () => ({
  default: (await import("./DistributionReportEmbed")).DistributionReportEmbed,
}));
const FitYByXReportEmbed = lazy(async () => ({
  default: (await import("./FitYByXReportEmbed")).FitYByXReportEmbed,
}));
const GraphReportEmbed = lazy(async () => ({
  default: (await import("./GraphReportEmbed")).GraphReportEmbed,
}));
const TableReportEmbed = lazy(async () => ({
  default: (await import("./TableReportEmbed")).TableReportEmbed,
}));
const TabulateReportEmbed = lazy(async () => ({
  default: (await import("./TabulateReportEmbed")).TabulateReportEmbed,
}));

function renderLazyEmbed(children: ReactNode): ReactNode {
  return <Suspense fallback={<div className="sp-report-embed-loading">Loading...</div>}>{children}</Suspense>;
}

type ReportResolvedItemByKind = {
  table: DatasetMeta;
  graph: GraphBuilderItem;
  fitYByX: FitYByXItem;
  tabulate: TabulateItem;
  distribution: DistributionItem;
};

export type ReportResolvedSource = {
  [Kind in keyof ReportResolvedItemByKind]: {
    kind: Kind;
    name: string;
    item: ReportResolvedItemByKind[Kind];
    dataset: DatasetMeta;
  };
}[keyof ReportResolvedItemByKind];

export type ReportDependencyResolution =
  | {
      status: "resolved";
      source: ReportResolvedSource;
    }
  | {
      status: "missing";
      dependency: ReportDependency;
    };

export interface ReportEmbedProps {
  dependency: ReportDependency;
  runtime?: ReportEmbedRuntime;
}

export interface ReportEmbedRuntime {
  table?: TableReportEmbedRuntime;
  graph?: GraphReportEmbedRuntime;
  fitYByX?: FitYByXReportEmbedRuntime & Partial<FitYByXReportDependencies>;
  tabulate?: TabulateReportEmbedRuntime;
  distribution?: DistributionReportEmbedRuntime;
}

interface ReportDependencySnapshot {
  datasets: readonly DatasetMeta[];
  graphs: readonly GraphBuilderItem[];
  fitYByX: readonly FitYByXItem[];
  tabulates: readonly TabulateItem[];
  distributions: readonly DistributionItem[];
}

function findDataset(datasetId: string, datasets: readonly DatasetMeta[]): DatasetMeta | undefined {
  return datasets.find((dataset) => dataset.id === datasetId);
}

export function resolveReportDependency(
  dependency: ReportDependency,
  snapshot?: Partial<ReportDependencySnapshot>,
): ReportDependencyResolution {
  const datasets = snapshot?.datasets ?? useDataStore.getState().datasets;
  const graphs = snapshot?.graphs ?? useGraphBuilderStore.getState().items;
  const fitYByX = snapshot?.fitYByX ?? useFitYByXStore.getState().items;
  const tabulates = snapshot?.tabulates ?? useTabulateStore.getState().items;
  const distributions = snapshot?.distributions ?? useDistributionStore.getState().items;

  if (dependency.kind === "table") {
    const dataset = findDataset(dependency.documentId, datasets);
    return dataset
      ? {
          status: "resolved",
          source: {
            kind: "table",
            name: dataset.name,
            item: dataset,
            dataset,
          },
        }
      : { status: "missing", dependency };
  }

  if (dependency.kind === "graph") {
    const item = graphs.find((candidate) => candidate.id === dependency.documentId);
    const dataset = item ? findDataset(item.sourceDatasetId, datasets) : undefined;
    return item && dataset
      ? {
          status: "resolved",
          source: {
            kind: "graph",
            name: item.name,
            item,
            dataset,
          },
        }
      : { status: "missing", dependency };
  }

  if (dependency.kind === "fitYByX") {
    const item = fitYByX.find((candidate) => candidate.id === dependency.documentId);
    const dataset = item ? findDataset(item.sourceDatasetId, datasets) : undefined;
    return item && dataset
      ? {
          status: "resolved",
          source: {
            kind: "fitYByX",
            name: item.name,
            item,
            dataset,
          },
        }
      : { status: "missing", dependency };
  }

  if (dependency.kind === "distribution") {
    const item = distributions.find((candidate) => candidate.id === dependency.documentId);
    const dataset = item ? findDataset(item.sourceDatasetId, datasets) : undefined;
    return item && dataset
      ? {
          status: "resolved",
          source: {
            kind: "distribution",
            name: item.name,
            item,
            dataset,
          },
        }
      : { status: "missing", dependency };
  }

  const item = tabulates.find((candidate) => candidate.id === dependency.documentId);
  const dataset = item ? findDataset(item.sourceDatasetId, datasets) : undefined;
  return item && dataset
    ? {
        status: "resolved",
        source: {
          kind: "tabulate",
          name: item.name,
          item,
          dataset,
        },
      }
    : { status: "missing", dependency };
}

function useReportDependencyResolution(dependency: ReportDependency): ReportDependencyResolution {
  const datasets = useDataStore((state) => state.datasets);
  const graphs = useGraphBuilderStore((state) => state.items);
  const fitYByX = useFitYByXStore((state) => state.items);
  const tabulates = useTabulateStore((state) => state.items);
  const distributions = useDistributionStore((state) => state.items);

  return resolveReportDependency(dependency, {
    datasets,
    graphs,
    fitYByX,
    tabulates,
    distributions,
  });
}

function kindLabel(kind: ReportDependency["kind"], t: (key: string, values?: Record<string, string>) => string): string {
  return t(`report.group.${kind}`, {
    defaultValue:
      kind === "fitYByX"
        ? "Fit Y by X"
        : kind === "tabulate"
          ? "Tabulate"
          : kind === "graph"
            ? "Graphs"
            : "Tables",
  } as Record<string, string>);
}

function renderMissingMessage(
  t: (key: string, values?: Record<string, string>) => string,
  dependency: ReportDependency,
): ReactNode {
  return t("report.embedUnavailable", {
    defaultValue: "Unavailable: {{kind}} {{id}}",
    kind: kindLabel(dependency.kind, t),
    id: dependency.documentId,
  } as Record<string, string>);
}

function normalizeRenderError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }
  return "render failed";
}

class ReportEmbedBoundary extends Component<{
  fallback: (message: string) => ReactNode;
  children: ReactNode;
}, { message: string | null }> {
  state = { message: null as string | null };

  static getDerivedStateFromError(error: unknown) {
    return { message: normalizeRenderError(error) };
  }

  override render() {
    if (this.state.message) {
      return this.props.fallback(this.state.message);
    }
    return this.props.children;
  }
}

function renderResolvedEmbed(source: ReportResolvedSource, runtime: ReportEmbedRuntime | undefined): ReactNode {
  if (source.kind === "table") {
    return renderLazyEmbed(<TableReportEmbed source={source} runtime={runtime?.table} />);
  }
  if (source.kind === "graph") {
    return renderLazyEmbed(<GraphReportEmbed source={source} runtime={runtime?.graph} />);
  }
  if (source.kind === "fitYByX") {
    return renderLazyEmbed(<FitYByXReportEmbed source={source} runtime={runtime?.fitYByX} />);
  }
  if (source.kind === "distribution") {
    return renderLazyEmbed(<DistributionReportEmbed source={source} runtime={runtime?.distribution} />);
  }
  return renderLazyEmbed(<TabulateReportEmbed source={source} runtime={runtime?.tabulate} />);
}

export function ReportEmbed({ dependency, runtime }: ReportEmbedProps) {
  const { t } = useTranslation();
  const resolution = useReportDependencyResolution(dependency);
  const dataRevision = useHistoryStore((state) => state.dataRevision);

  if (resolution.status === "missing") {
    return <div className="sp-report-embed-unavailable">{renderMissingMessage(t as never, dependency)}</div>;
  }

  const embedRevision = [
    resolution.source.kind,
    dependency.documentId,
    dataRevision,
    JSON.stringify(resolution.source.dataset),
    JSON.stringify(resolution.source.item),
  ].join("\0");

  return (
    <ReportEmbedBoundary
      key={embedRevision}
      fallback={(message) => (
        <div className="sp-report-embed-error">
          {t("report.embedError", {
            defaultValue: "Failed to render {{kind}} {{name}}: {{message}}",
            kind: kindLabel(resolution.source.kind, t as never),
            name: resolution.source.name,
            message,
          })}
        </div>
      )}
    >
      {renderResolvedEmbed(resolution.source, runtime)}
    </ReportEmbedBoundary>
  );
}