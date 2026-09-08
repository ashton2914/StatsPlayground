import type { Encoding, FieldRef } from "@/graphCore";
import type { GraphSlotKey } from "@/types/graphBuilder";

type GraphBuilderEncoding = Partial<Record<GraphSlotKey, FieldRef>>;

export function deriveGraphSpecEncoding(effectiveEncoding: GraphBuilderEncoding): Encoding {
  const enc: Encoding = {};
  const hasOverlay = !!effectiveEncoding.overlay;

  (Object.keys(effectiveEncoding) as GraphSlotKey[]).forEach((key) => {
    if (key === "size" || key === "wrap") return;
    if (key === "color" && hasOverlay) return;
    const value = effectiveEncoding[key];
    if (value) (enc as Record<GraphSlotKey, FieldRef>)[key] = value;
  });

  return enc;
}