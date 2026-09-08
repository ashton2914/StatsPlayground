import type { FieldRef } from "@/graphCore";
import type { GraphSlotKey } from "@/types/graphBuilder";

export interface CanvasDropRoutingInput {
  isMultivariateMode: boolean;
  xBound: boolean;
  yBound: boolean;
}

export function resolveCanvasDropSlot(input: CanvasDropRoutingInput): GraphSlotKey {
  if (input.isMultivariateMode) {
    return "y";
  }
  if (!input.xBound) {
    return "x";
  }
  return "y";
}

export interface MultivariateSlotBinding {
  field: FieldRef | undefined;
  columns: FieldRef[];
  showManager: boolean;
}

export function deriveMultivariateSlotBinding(columns: FieldRef[]): MultivariateSlotBinding {
  const safeColumns = Array.isArray(columns) ? columns : [];
  if (safeColumns.length <= 0) {
    return {
      field: undefined,
      columns: [],
      showManager: false,
    };
  }

  if (safeColumns.length === 1) {
    return {
      field: safeColumns[0],
      columns: safeColumns,
      showManager: true,
    };
  }

  return {
    field: undefined,
    columns: safeColumns,
    showManager: true,
  };
}
