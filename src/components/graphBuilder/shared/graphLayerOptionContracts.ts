export type GraphSummaryStat = "none" | "mean" | "median" | "sum";
export type GraphErrorInterval = "auto" | "none" | "stdErr" | "stdDev" | "ci95";
export type GraphIntervalStyle = "errorBar" | "band";
export interface GraphPointOptions {
  summaryStat: GraphSummaryStat;
  errorInterval: GraphErrorInterval;
  intervalStyle: GraphIntervalStyle;
  jitter: "stacked" | "uniform" | "normal";
  jitterLimit: number;
}
export interface GraphLineOptions {
  rowOrder: boolean;
  connection: "line" | "step" | "spline";
  summaryStat: GraphSummaryStat;
  fill: "none" | "toZero" | "between";
  errorInterval: GraphErrorInterval;
  intervalStyle: GraphIntervalStyle;
  missingFactors: "skip" | "include";
  missingValues: "connect" | "break";
}
export const defaultPointOptions = (): GraphPointOptions => ({ summaryStat: "none", errorInterval: "auto", intervalStyle: "errorBar", jitter: "stacked", jitterLimit: 0.5 });
export const defaultLineOptions = (): GraphLineOptions => ({ rowOrder: false, connection: "line", summaryStat: "mean", fill: "none", errorInterval: "auto", intervalStyle: "errorBar", missingFactors: "skip", missingValues: "connect" });

function normalize<T extends object>(value: unknown, defaults: T, enums: Record<string, readonly string[]>): T {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("graph_new_invalid_layer_options");
  const options = { ...defaults, ...value } as T & Record<string, unknown>;
  if (Object.keys(value).some((key) => !(key in defaults))) throw new Error("graph_new_invalid_layer_options");
  for (const [key, values] of Object.entries(enums)) if (!values.includes(options[key] as string)) throw new Error("graph_new_invalid_layer_options");
  return options;
}
const summary = ["none", "mean", "median", "sum"];
const intervals = ["auto", "none", "stdErr", "stdDev", "ci95"];
const styles = ["errorBar", "band"];
export function normalizePointOptions(value: unknown): GraphPointOptions {
  if (value && typeof value === "object" && "jitter" in value && value.jitter === "auto") value = { ...value, jitter: "stacked" };
  const options = normalize(value, defaultPointOptions(), { summaryStat: summary, errorInterval: intervals, intervalStyle: styles, jitter: ["stacked", "uniform", "normal"] });
  if (!Number.isFinite(options.jitterLimit) || options.jitterLimit < 0 || options.jitterLimit > 1) throw new Error("graph_new_invalid_layer_options");
  return options;
}
export function normalizeLineOptions(value: unknown): GraphLineOptions {
  const options = normalize(value, defaultLineOptions(), { summaryStat: summary, errorInterval: intervals, intervalStyle: styles, connection: ["line", "step", "spline"], fill: ["none", "toZero", "between"], missingFactors: ["skip", "include"], missingValues: ["connect", "break"] });
  if (typeof options.rowOrder !== "boolean") throw new Error("graph_new_invalid_layer_options");
  return options;
}
