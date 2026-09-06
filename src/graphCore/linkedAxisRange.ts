type Axis = "x" | "y";
type AxisOption = Record<string, unknown>;

export type LinkedAxisRangePatch = AxisOption | AxisOption[];

export function buildLinkedAxisRangePatch(
  option: Readonly<Record<string, unknown>>,
  axis: Axis,
  min: number,
  max: number,
  extra: AxisOption = {},
): LinkedAxisRangePatch {
  const range = { min, max, ...extra };
  const axes = option[`${axis}Axis`];
  if (!Array.isArray(axes)) return range;

  const primaryType = axes[0] != null && typeof axes[0] === "object"
    ? (axes[0] as AxisOption).type
    : undefined;
  return axes.map((candidate, index) => {
    if (index === 0) return range;
    if (candidate == null || typeof candidate !== "object") return {};
    return (candidate as AxisOption).type === primaryType ? range : {};
  });
}