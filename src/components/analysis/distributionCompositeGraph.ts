import type { ChartElement, FieldRef } from "@/graphCore";
import { getDistributionResponseAxis } from "@/components/distribution/distributionAxisInteractions";
import { DISTRIBUTION_GRAPH_ELEMENT_IDS } from "@/types/graphData";
import type { EmbeddedGraphConfig } from "@/types/graphBuilder";

function layerOptions(
  sources: EmbeddedGraphConfig[],
  kind: ChartElement["kind"],
  defaults: Record<string, unknown> = {},
): Record<string, unknown> {
  const element = sources
    .flatMap((source) => source.modeStates.twoD.elements)
    .find((candidate) => candidate.kind === kind);
  const { elementId: _elementId, ...options } = element?.options ?? {};
  return { ...defaults, ...options };
}

export function createDistributionGraphBuilderConfig(
  overview: EmbeddedGraphConfig,
  boxPlot: EmbeddedGraphConfig,
  responses: FieldRef[],
): EmbeddedGraphConfig {
  const twoD = overview.modeStates.twoD;
  const { x: _x, y: _y, ...nonAxisEncoding } = twoD.encoding;
  const responseAxis = responses[0] ? getDistributionResponseAxis(overview, responses[0]) : null;
  const responseAxisConfig = responseAxis === "x" ? twoD.xAxis : twoD.yAxis;
  const responseRefLines = responseAxis === "x"
    ? twoD.refLinesX?.map(({ x, ...line }) => ({ ...line, y: x }))
    : twoD.refLinesY;
  const responseAutoSpecLines = responseAxis === "x"
    ? twoD.autoSpecLinesX ?? twoD.autoSpecLines
    : twoD.autoSpecLinesY ?? twoD.autoSpecLines;
  return {
    ...overview,
    modeStates: {
      ...overview.modeStates,
      twoD: {
        ...twoD,
        encoding: { ...nonAxisEncoding },
        multiX: structuredClone(responses),
        multiY: [],
        xAxis: undefined,
        yAxis: responseAxisConfig,
        refLinesX: undefined,
        refLinesY: responseRefLines,
        autoSpecLines: undefined,
        autoSpecLinesX: undefined,
        autoSpecLinesY: responseAutoSpecLines,
        elements: [
          { kind: "histogram", enabled: true, options: layerOptions([overview], "histogram") },
          {
            kind: "normalCurve",
            enabled: true,
            options: {
              ...layerOptions([overview], "normalCurve", { showSigmaBands: false }),
              elementId: DISTRIBUTION_GRAPH_ELEMENT_IDS.overviewFittedCurves,
            },
          },
          { kind: "boxplot", enabled: true, options: layerOptions([overview, boxPlot], "boxplot") },
        ],
      },
    },
  };
}