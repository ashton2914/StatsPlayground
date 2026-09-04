import type { DistributionReportResponse } from "@/types/distribution";
import type { GraphDataFrame } from "@/types/graphData";

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
