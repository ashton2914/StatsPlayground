import type { Graph2DState, EmbeddedGraphConfig } from "@/types/graphBuilder";

export type Graph2DUpdater =
  | Partial<Graph2DState>
  | ((current: Graph2DState) => Partial<Graph2DState>);

export function updateEmbeddedGraph2D(
  graph: EmbeddedGraphConfig,
  updater: Graph2DUpdater,
): EmbeddedGraphConfig {
  const current = graph.modeStates.twoD;
  const patch = typeof updater === "function" ? updater(current) : updater;
  return {
    ...graph,
    modeStates: {
      ...graph.modeStates,
      twoD: { ...current, ...patch },
    },
  };
}