import type { ChartElement, FieldRef } from "@/graphCore";
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
  const responseRefLines = twoD.refLinesY ?? twoD.refLinesX?.map(({ x, ...line }) => ({ ...line, y: x }));
  return {
    ...overview,
    modeStates: {
      ...overview.modeStates,
      twoD: {
        ...twoD,
        encoding: { ...nonAxisEncoding },
        multiX: [],
        multiY: structuredClone(responses),
        xAxis: undefined,
        yAxis: twoD.yAxis ?? twoD.xAxis,
        refLinesX: undefined,
        refLinesY: responseRefLines,
        autoSpecLines: undefined,
        autoSpecLinesX: undefined,
        autoSpecLinesY: twoD.autoSpecLinesY ?? twoD.autoSpecLinesX ?? twoD.autoSpecLines,
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