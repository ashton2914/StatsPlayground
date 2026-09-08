import { SCATTER_RENDER_BUDGET } from "../../graphCore/scatterBudget.ts";
import type { GraphRawPointDisposition } from "../../types/graphData.ts";
import type { GraphElementRequest, GraphSampling } from "../../types/graphData.ts";

export const DEFAULT_GRAPH_SAMPLE_SIZE = Math.min(20_000, SCATTER_RENDER_BUDGET);

export function clampSampleSize(raw: number): number {
  const size = Number.isFinite(raw) ? Math.trunc(raw) : DEFAULT_GRAPH_SAMPLE_SIZE;
  return Math.min(SCATTER_RENDER_BUDGET, Math.max(1, size));
}

export interface RawPointBudgetNotice {
  kind: "pointBudgetExceeded";
  validRows: number;
  budget: number;
}

export function getRawPointNotice(
  disposition: GraphRawPointDisposition | undefined,
): RawPointBudgetNotice | null {
  if (disposition?.status !== "omitted") return null;
  return {
    kind: "pointBudgetExceeded",
    validRows: disposition.validRows,
    budget: disposition.budget,
  };
}

export function requiresRawGraphFrame(
  elements: readonly GraphElementRequest[],
): boolean {
  return elements.some((element) => {
    const kind = String(element.kind || "").toLowerCase();
    const summary = String(element.summaryStat || "").toLowerCase();
    if (kind === "points" || kind === "line") {
      return summary === "none";
    }
    return kind === "bar" || kind === "smoother" || kind === "fitline";
  });
}

export function resolveEffectiveGraphSampling(
  configured: GraphSampling | undefined,
  elements: readonly GraphElementRequest[],
): GraphSampling {
  if (configured?.mode === "sample") {
    return {
      mode: "sample",
      size: clampSampleSize((configured as { size: number }).size),
      seed: Math.max(0, Math.trunc((configured as { seed: number }).seed) || 0),
    };
  }
  if (requiresRawGraphFrame(elements)) {
    return { mode: "sample", size: SCATTER_RENDER_BUDGET, seed: 0 };
  }
  return { mode: "full" };
}
