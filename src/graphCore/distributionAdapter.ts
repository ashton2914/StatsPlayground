import type { DistributionReportResponse } from "@/types/distribution";
import type { GraphAggregatePacket, GraphDataFrame } from "@/types/graphData";

const DISTRIBUTION_MELT_CATEGORY_COLUMN = "__sp_variable__";

export const DISTRIBUTION_GRAPH_ROLES = [
  "overview",
  "boxPlot",
  "ecdf",
  "normalQuantile",
] as const;

export type DistributionGraphRole = typeof DISTRIBUTION_GRAPH_ROLES[number];

export type DistributionExternalDataState =
  | { status: "loading"; frame: null; error: null }
  | { status: "ready"; frame: GraphDataFrame; error: null }
  | { status: "error"; frame: null; error: string };

export type DistributionFrameSourceState =
  | { status: "idle" | "loading" }
  | { status: "success"; result: Pick<DistributionReportResponse, "graphFrames"> }
  | { status: "error"; error: string };

export function getDistributionGraphFrame(
  response: Pick<DistributionReportResponse, "graphFrames">,
  role: DistributionGraphRole,
): GraphDataFrame {
  return response.graphFrames[role];
}

export function getDistributionCompositeGraphFrame(
  response: Pick<DistributionReportResponse, "graphFrames">,
): GraphDataFrame {
  const overview = response.graphFrames.overview;
  const normalizeCategoryIdentity = (packet: GraphAggregatePacket): GraphAggregatePacket => {
    if (packet.kind === "histogram") {
      return {
        ...packet,
        sourceColumn: DISTRIBUTION_MELT_CATEGORY_COLUMN,
        bins: packet.bins.map(({ category: _category, group, ...bin }) => ({
          ...bin,
          category: group ?? bin.sourceColumn,
        })),
      };
    }
    if (packet.kind === "boxPlot") {
      return {
        ...packet,
        sourceColumn: DISTRIBUTION_MELT_CATEGORY_COLUMN,
        entries: packet.entries.map(({ category: _category, group, ...entry }) => ({
          ...entry,
          category: group ?? entry.sourceColumn,
        })),
      };
    }
    return packet;
  };
  return {
    ...overview,
    requestId: `${overview.requestId}:composite`,
    aggregates: [
      ...overview.aggregates,
      ...response.graphFrames.boxPlot.aggregates,
    ].map(normalizeCategoryIdentity),
  };
}

export function mapDistributionExternalDataState(
  state: DistributionFrameSourceState,
  role: DistributionGraphRole,
): DistributionExternalDataState {
  if (state.status === "success") {
    return {
      status: "ready",
      frame: getDistributionGraphFrame(state.result, role),
      error: null,
    };
  }
  if (state.status === "error") {
    return { status: "error", frame: null, error: state.error };
  }
  return { status: "loading", frame: null, error: null };
}

export function mapDistributionCompositeExternalDataState(
  state: DistributionFrameSourceState,
): DistributionExternalDataState {
  if (state.status === "success") {
    return {
      status: "ready",
      frame: getDistributionCompositeGraphFrame(state.result),
      error: null,
    };
  }
  if (state.status === "error") {
    return { status: "error", frame: null, error: state.error };
  }
  return { status: "loading", frame: null, error: null };
}
