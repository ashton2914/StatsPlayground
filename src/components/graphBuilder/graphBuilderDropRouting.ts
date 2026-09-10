import type { FieldRef } from "@/graphCore";
import type { GraphBuilderMode, GraphSlotKey } from "@/types/graphBuilder";

export type GraphBuilderDropRoute = "multi" | "single" | "reject";

export function decideGraphBuilderDropRoute(
  slot: GraphSlotKey,
  fields: FieldRef[],
  inMulti: boolean,
  mode: GraphBuilderMode,
): GraphBuilderDropRoute {
  if (fields.length === 0) return "reject";
  if (mode === "3d") return "single";

  const isAxis = slot === "x" || slot === "y";
  const allContinuous = fields.every((field) => field.type === "continuous");
  if (isAxis && inMulti) {
    return allContinuous ? "multi" : "reject";
  }
  if (slot === "x" && allContinuous) {
    return "multi";
  }
  if (fields.length === 1 || !isAxis) {
    return "single";
  }
  return allContinuous ? "multi" : "reject";
}
