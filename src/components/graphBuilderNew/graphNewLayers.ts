import { defaultLineOptions, defaultPointOptions, normalizeLineOptions, normalizePointOptions } from "../graphBuilder/shared/graphLayerOptionContracts";
import type { GraphNewLayer, GraphNewRawMode, PersistedGraphBuilderNewDocument } from "@/types/graphBuilderNew";

export function createGraphNewLayer(kind: GraphNewLayer["kind"], id: string = crypto.randomUUID()): GraphNewLayer {
  return kind === "points" ? { id, kind, options: defaultPointOptions() } : { id, kind, options: defaultLineOptions() };
}
export function normalizeGraphNewLayers(value: unknown): GraphNewLayer[] {
  if (!Array.isArray(value) || value.length > 64) throw new Error("graph_new_invalid_layers");
  const ids = new Set<string>();
  return value.map((layer) => {
    if (!layer || typeof layer.id !== "string" || !layer.id.trim() || layer.id !== layer.id.trim() || layer.id.length > 256
      || ids.has(layer.id) || !["points", "line", "timeSeries"].includes(layer.kind)
      || Object.keys(layer).some((key) => !["id", "kind", "options", "legacySourceRuns"].includes(key))) throw new Error("graph_new_invalid_layers");
    if (layer.legacySourceRuns !== undefined && (layer.kind === "points" || typeof layer.legacySourceRuns !== "boolean")) throw new Error("graph_new_invalid_layers");
    ids.add(layer.id);
    return layer.kind === "points" ? { id: layer.id, kind: "points", options: normalizePointOptions(layer.options) }
      : { id: layer.id, kind: layer.kind, ...(layer.legacySourceRuns !== undefined ? { legacySourceRuns: layer.legacySourceRuns } : {}), options: normalizeLineOptions(layer.options) };
  });
}
export function migratedGraphNewLayers(item: PersistedGraphBuilderNewDocument): GraphNewLayer[] {
  if (item.version === 3) return normalizeGraphNewLayers(item.layers);
  const layers: GraphNewLayer[] = [];
  if (item.rawMode !== "line") layers.push({ id: `${item.id}:points`, kind: "points", options: { ...defaultPointOptions(), jitterLimit: 0 } });
  if (item.rawMode !== "scatter") layers.push({ id: `${item.id}:raw-line`, legacySourceRuns: true, kind: item.xMode === "time" || item.xMode === "duration" ? "timeSeries" : "line", options: { ...defaultLineOptions(), summaryStat: "none", errorInterval: "none", missingFactors: "include", missingValues: "break" } });
  if (item.showMean) layers.push({ id: `${item.id}:mean-line`, kind: "line", options: { ...defaultLineOptions(), errorInterval: "none", missingFactors: "include" } });
  return normalizeGraphNewLayers(layers);
}
/** Compatibility hints for transport fixtures and callers migrating to layers. */
export function legacyRenderOptions(layers: readonly GraphNewLayer[]): { rawMode: GraphNewRawMode; showMean: boolean } {
  const points = layers.some((layer) => layer.kind === "points" && layer.options.summaryStat === "none");
  const line = layers.some((layer) => layer.kind !== "points" && layer.options.summaryStat === "none");
  return { rawMode: points && line ? "pointsLine" : line ? "line" : "scatter", showMean: layers.some((layer) => layer.kind !== "points" && layer.options.summaryStat === "mean") };
}
