export interface VisualGraphSlots {
  top: "groupX" | "groupY";
  left: "x" | "y";
  right: "groupX" | "groupY";
  bottom: "x" | "y";
}

export function resolveVisualGraphSlots(transposed: boolean): VisualGraphSlots {
  return transposed
    ? { top: "groupY", left: "x", right: "groupX", bottom: "y" }
    : { top: "groupX", left: "y", right: "groupY", bottom: "x" };
}

export function resolveVisibleSlotField<T>(
  field: T | undefined,
  fields: readonly T[] | undefined,
): T | undefined {
  return field ?? (fields?.length === 1 ? fields[0] : undefined);
}