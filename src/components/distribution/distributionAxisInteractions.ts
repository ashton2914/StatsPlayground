import type { FieldRef } from "@/graphCore";
import type { DistributionGraphRole } from "@/graphCore/distributionAdapter";
import type { DistributionItem } from "@/types/distribution";
import type { EmbeddedGraphConfig } from "@/types/graphBuilder";

type Axis = "x" | "y";
type SynchronizedRole = Extract<DistributionGraphRole, "overview" | "boxPlot">;

export interface DistributionAxisRangeControllerOptions {
  getItem: () => DistributionItem;
  isReadOnly: () => boolean;
  commitGraphs: (graphs: DistributionItem["graphs"]) => void;
}

export interface DistributionAxisRangeController {
  handleAxisRangeChange: (
    role: SynchronizedRole,
    axis: Axis,
    min: number,
    max: number,
  ) => boolean;
}

function sameField(left: FieldRef | undefined, right: FieldRef): boolean {
  return left?.name === right.name && left.type === right.type;
}

export function getDistributionResponseAxis(
  graph: EmbeddedGraphConfig,
  response: FieldRef,
): Axis | null {
  const encoding = graph.modeStates.twoD.encoding;
  if (sameField(encoding.x, response)) return "x";
  if (sameField(encoding.y, response)) return "y";
  return null;
}

function withAxisRange(
  graph: EmbeddedGraphConfig,
  axis: Axis,
  min: number,
  max: number,
): EmbeddedGraphConfig {
  const twoD = graph.modeStates.twoD;
  const key = axis === "x" ? "xAxis" : "yAxis";
  const current = twoD[key];
  if (current?.min === min && current.max === max) return graph;
  return {
    ...graph,
    modeStates: {
      ...graph.modeStates,
      twoD: {
        ...twoD,
        [key]: { ...(current ?? {}), min, max },
      },
    },
  };
}

export function createDistributionAxisRangeController(
  options: DistributionAxisRangeControllerOptions,
): DistributionAxisRangeController {
  return {
    handleAxisRangeChange: (role, axis, min, max) => {
      if (options.isReadOnly() || !Number.isFinite(min) || !Number.isFinite(max) || min >= max) {
        return false;
      }

      const item = options.getItem();
      const response = item.responses[0];
      if (!response || getDistributionResponseAxis(item.graphs[role], response) !== axis) {
        return false;
      }

      const overviewAxis = getDistributionResponseAxis(item.graphs.overview, response);
      const boxPlotAxis = getDistributionResponseAxis(item.graphs.boxPlot, response);
      if (!overviewAxis || !boxPlotAxis) return false;

      const overview = withAxisRange(item.graphs.overview, overviewAxis, min, max);
      const boxPlot = withAxisRange(item.graphs.boxPlot, boxPlotAxis, min, max);
      if (overview === item.graphs.overview && boxPlot === item.graphs.boxPlot) {
        return false;
      }

      options.commitGraphs({ ...item.graphs, overview, boxPlot });
      return true;
    },
  };
}