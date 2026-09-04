import type { ChartElement, ElementKind } from "@/graphCore";

export interface GraphLayerDef {
  kind: ElementKind;
  icon: string;
}

export type LayerDim = "2d" | "3d" | "multivariate";

export const GRAPH_LAYER_DEFS: GraphLayerDef[] = [
  { kind: "points", icon: "●" },
  { kind: "line", icon: "╱" },
  { kind: "smoother", icon: "∿" },
  { kind: "fitline", icon: "ƒ" },
  { kind: "boxplot", icon: "⊟" },
  { kind: "histogram", icon: "▥" },
  { kind: "normalCurve", icon: "∩" },
  { kind: "scatter3d", icon: "●" },
  { kind: "surface", icon: "◪" },
  { kind: "contour3d", icon: "≋" },
];

export const LAYER_DIM: Record<ElementKind, LayerDim> = {
  points: "2d",
  line: "2d",
  bar: "2d",
  heatmap: "2d",
  correlationMatrix: "multivariate",
  histogram: "2d",
  normalCurve: "2d",
  boxplot: "2d",
  smoother: "2d",
  fitline: "2d",
  scatter3d: "3d",
  surface: "3d",
  contour3d: "3d",
};

export function getLayerMode(kind: ElementKind): LayerDim {
  return LAYER_DIM[kind];
}

export function defaultLayerOptions(
  kind: ElementKind,
  existingElements: readonly ChartElement[],
): Record<string, unknown> | undefined {
  if (kind === "smoother") return { algo: "spline" };
  if (kind === "fitline") return { fitType: "polynomial", degree: 1 };
  if (kind === "surface") return { stat: "mean", smoothness: 0 };
  if (kind === "contour3d") return { stat: "mean", smoothness: 0, levels: 10 };
  if (kind === "normalCurve") return { showSigmaBands: false };
  if (kind === "scatter3d") {
    const points = existingElements.find((element) => element.kind === "points");
    return { ...(points?.options ?? {}) };
  }
  return undefined;
}