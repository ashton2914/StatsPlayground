import type { DistributionGroupResult, DistributionGroupValueV1, DistributionReportResponse } from "@/types/distribution";
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

export interface DistributionResponseGraphIdentity {
  sourceColumn: string;
  seriesName: string;
}

function graphGroupValue(value: DistributionGroupValueV1): string {
  switch (value.kind) {
    case "missing":
      return "Missing";
    case "boolean":
    case "number":
      return String(value.value);
    case "text":
      return value.value;
    case "dateTime":
      return String(value.utcMillis);
  }
}

export function getDistributionGroupName(group: DistributionGroupResult): string {
  if (group.groupKey.length === 0) return "Overall";
  return group.groupKey
    .map((value, index) => {
      const formattedValue = graphGroupValue(value);
      const name = group.groupNames?.[index];
      return name ? `${name}=${formattedValue}` : formattedValue;
    })
    .join(", ");
}

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

function getDistributionSeriesName(responseName: string, groupName: string): string {
  return groupName === "Overall" ? responseName : `${responseName} | ${groupName}`;
}

function isLegacyOverallMatch(
  responseName: string,
  groupName: string,
  allowLegacyOverallFallback: boolean,
  sourceColumn?: string | null,
  category?: string | null,
  group?: string | null,
): boolean {
  return allowLegacyOverallFallback
    && groupName === "Overall"
    && responseName.length > 0
    && sourceColumn == null
    && category == null
    && group == null;
}

function selectDistributionHistogramPacket(
  packet: GraphAggregatePacket,
  responseIdentity: DistributionResponseGraphIdentity,
  groupName: string,
  seriesName: string,
  allowLegacyOverallFallback: boolean,
): GraphAggregatePacket | null {
  if (packet.kind !== "histogram") return null;

  const bins = packet.bins.filter((bin) =>
    (
      bin.sourceColumn === responseIdentity.sourceColumn
      && bin.category === groupName
      && bin.group === seriesName
    )
    || isLegacyOverallMatch(
      responseIdentity.seriesName,
      groupName,
      allowLegacyOverallFallback,
      bin.sourceColumn,
      bin.category,
      bin.group,
    ),
  );
  if (bins.length === 0) return null;

  const totalCount = bins.reduce((sum, bin) => sum + bin.count, 0);
  const minValue = Math.min(...bins.map((bin) => bin.binStart));
  const maxValue = Math.max(...bins.map((bin) => bin.binEnd));
  const binWidth = bins[0]!.binEnd - bins[0]!.binStart;

  return {
    ...packet,
    binCount: bins.length,
    totalCount,
    minValue,
    maxValue,
    binWidth,
    bins,
  };
}

function selectDistributionBoxPlotPacket(
  packet: GraphAggregatePacket,
  responseIdentity: DistributionResponseGraphIdentity,
  groupName: string,
  seriesName: string,
  allowLegacyOverallFallback: boolean,
): GraphAggregatePacket | null {
  if (packet.kind !== "boxPlot") return null;

  const entries = packet.entries.filter((entry) =>
    (
      entry.sourceColumn === responseIdentity.sourceColumn
      && entry.category === groupName
      && entry.group === seriesName
    )
    || isLegacyOverallMatch(
      responseIdentity.seriesName,
      groupName,
      allowLegacyOverallFallback,
      entry.sourceColumn,
      entry.category,
      entry.group,
    ),
  );
  if (entries.length === 0) return null;

  return {
    ...packet,
    entries,
  };
}

function selectDistributionCurvePacket(
  packet: GraphAggregatePacket,
  responseIdentity: DistributionResponseGraphIdentity,
  seriesName: string,
  allowLegacyOverallFallback: boolean,
): GraphAggregatePacket | null {
  if (packet.kind !== "precomputedCurve") return null;
  if (packet.sourceColumn === responseIdentity.sourceColumn && packet.group === seriesName) return packet;
  if (isLegacyOverallMatch(
    responseIdentity.seriesName,
    "Overall",
    allowLegacyOverallFallback,
    packet.sourceColumn,
    packet.category,
    packet.group,
  )) {
    const expectedLegacySeriesName = `${responseIdentity.seriesName} - Normal`;
    if (packet.seriesName === expectedLegacySeriesName) return packet;
  }
  return null;
}

function normalizeDistributionResponseGraphIdentity(
  response: string | DistributionResponseGraphIdentity,
): DistributionResponseGraphIdentity {
  return typeof response === "string"
    ? { sourceColumn: response, seriesName: response }
    : response;
}

export function getDistributionResponseCompositeGraphFrame(
  graphResponse: Pick<DistributionReportResponse, "graphFrames">,
  response: string | DistributionResponseGraphIdentity,
  group: DistributionGroupResult,
  options: {
    allowLegacyOverallFallback?: boolean;
  } = {},
): GraphDataFrame {
  const groupName = getDistributionGroupName(group);
  const responseIdentity = normalizeDistributionResponseGraphIdentity(response);
  const seriesName = getDistributionSeriesName(responseIdentity.seriesName, groupName);
  const allowLegacyOverallFallback = options.allowLegacyOverallFallback === true;
  const overview = graphResponse.graphFrames.overview;
  const boxPlot = graphResponse.graphFrames.boxPlot;

  const filteredOverviewAggregates = overview.aggregates.flatMap((packet) => {
    const histogram = selectDistributionHistogramPacket(
      packet,
      responseIdentity,
      groupName,
      seriesName,
      allowLegacyOverallFallback,
    );
    if (histogram) return [histogram];

    const curve = selectDistributionCurvePacket(packet, responseIdentity, seriesName, allowLegacyOverallFallback);
    if (curve) return [curve];

    return [];
  });
  const filteredBoxPlotAggregates = boxPlot.aggregates.flatMap((packet) => {
    const selectedBoxPlot = selectDistributionBoxPlotPacket(
      packet,
      responseIdentity,
      groupName,
      seriesName,
      allowLegacyOverallFallback,
    );
    return selectedBoxPlot ? [selectedBoxPlot] : [];
  });

  return getDistributionCompositeGraphFrame({
    graphFrames: {
      ...graphResponse.graphFrames,
      overview: { ...overview, aggregates: filteredOverviewAggregates },
      boxPlot: { ...boxPlot, aggregates: filteredBoxPlotAggregates },
    },
  });
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
