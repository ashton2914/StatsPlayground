import type { Graph2DState, GraphBuilderItem } from "@/types/graphBuilder";

export type GraphBuilder2DUpdater =
  | Graph2DState
  | ((current: Graph2DState) => Graph2DState);

export function updateGraphBuilder2D(
  item: GraphBuilderItem,
  updater: GraphBuilder2DUpdater,
): GraphBuilderItem {
  const current = item.modeStates.twoD;
  const next = typeof updater === "function" ? updater(current) : updater;
  return {
    ...item,
    modeStates: {
      ...item.modeStates,
      twoD: next,
    },
  };
}