import { DEFAULT_GROUP_KEY } from "../../graphCore/types.ts";

import type { GroupStyleMap, MarkStyle } from "../../graphCore/types.ts";
import type { CustomPalette } from "../../stores/useGraphPaletteStore.ts";

import type { GroupThemeSlots } from "../../types/graphBuilder";

const GROUP_COLORS = [
  "#4a6cf7", "#ef8a3a", "#2ca678", "#e74c3c",
  "#9168d6", "#c4ad36", "#d56cb1", "#3aa6b9",
  "#5d8aa8", "#8c6e3a", "#b87333", "#7f8c8d",
];

const SHADE_RATIO_POINT = -0.2;
const SHADE_RATIO_LINE = 0;
const SHADE_RATIO_FILL = 0.55;

function isValidFieldName(fieldName: string | undefined): fieldName is string {
  return typeof fieldName === "string" && fieldName.trim().length > 0 && fieldName !== DEFAULT_GROUP_KEY;
}

type ThemeGroupingEncoding = {
  color?: { name?: string } | null;
  overlay?: { name?: string } | null;
};

export function resolveGroupThemeFieldName(
  encoding: ThemeGroupingEncoding | undefined,
): string | undefined {
  const fieldName = encoding?.overlay?.name ?? encoding?.color?.name;
  return isValidFieldName(fieldName) ? fieldName : undefined;
}

function normalizeGroupKey(groupKey: string): string | undefined {
  if (groupKey.trim().length === 0 || groupKey === DEFAULT_GROUP_KEY) {
    return undefined;
  }
  return groupKey;
}

function isValidThemeSlot(slot: unknown): slot is number {
  return typeof slot === "number" && Number.isInteger(slot) && slot >= 0 && Number.isFinite(slot);
}

function shade(hex: string, ratio: number): string {
  if (!hex || ratio === 0) return hex;
  const match = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!match) return hex;
  const hh = match[1];
  const red = parseInt(hh.slice(0, 2), 16);
  const green = parseInt(hh.slice(2, 4), 16);
  const blue = parseInt(hh.slice(4, 6), 16);
  const mix = (component: number) => (
    ratio < 0
      ? Math.round(component * (1 + ratio))
      : Math.round(component + (255 - component) * ratio)
  );
  const clamp = (value: number) => Math.max(0, Math.min(255, value));
  const toHex = (value: number) => clamp(value).toString(16).padStart(2, "0");
  return `#${toHex(mix(red))}${toHex(mix(green))}${toHex(mix(blue))}`;
}

function resolveAutomaticMarkStyles(
  slot: number,
  customPalettes: readonly CustomPalette[],
): {
  line: MarkStyle;
  fill: MarkStyle;
  point: MarkStyle;
  gradient: MarkStyle;
} {
  if (slot < customPalettes.length) {
    const palette = customPalettes[slot];
    return {
      line: { color: palette.line, lineWidth: 1.5, opacity: 1 },
      fill: { color: palette.fill, opacity: 1 },
      point: { color: palette.point, fillColor: palette.point, marker: "circle", markerSize: 4, opacity: 1 },
      gradient: { color: palette.line, opacity: 1 },
    };
  }

  const fallbackIndex = (slot - customPalettes.length) % GROUP_COLORS.length;
  const base = GROUP_COLORS[fallbackIndex];
  return {
    line: { color: shade(base, SHADE_RATIO_LINE), lineWidth: 1.5, opacity: 1 },
    fill: { color: shade(base, SHADE_RATIO_FILL), opacity: 1 },
    point: {
      color: shade(base, SHADE_RATIO_POINT),
      fillColor: shade(base, SHADE_RATIO_POINT),
      marker: "circle",
      markerSize: 4,
      opacity: 1,
    },
    gradient: { color: base, opacity: 1 },
  };
}

function lowestUnusedSlot(usedSlots: ReadonlySet<number>): number {
  let slot = 0;
  while (usedSlots.has(slot)) {
    slot += 1;
  }
  return slot;
}

function normalizeFieldSlots(fieldSlots: Record<string, number> | undefined): Record<string, number> {
  if (!fieldSlots) {
    return {};
  }

  const normalizedField: Record<string, number> = {};
  const usedSlots = new Set<number>();
  for (const [groupKey, slot] of Object.entries(fieldSlots)) {
    const normalizedGroupKey = normalizeGroupKey(groupKey);
    if (!normalizedGroupKey || !isValidThemeSlot(slot) || usedSlots.has(slot)) {
      continue;
    }
    normalizedField[normalizedGroupKey] = slot;
    usedSlots.add(slot);
  }

  return normalizedField;
}

function fieldSlotsAreEqual(
  left: Record<string, number> | undefined,
  right: Record<string, number> | undefined,
): boolean {
  const leftEntries = Object.entries(left ?? {});
  const rightEntries = Object.entries(right ?? {});
  if (leftEntries.length !== rightEntries.length) {
    return false;
  }

  for (let index = 0; index < leftEntries.length; index += 1) {
    const [leftKey, leftSlot] = leftEntries[index];
    const [rightKey, rightSlot] = rightEntries[index];
    if (leftKey !== rightKey || leftSlot !== rightSlot) {
      return false;
    }
  }

  return true;
}

export function normalizeGroupThemeSlots(value: unknown): GroupThemeSlots {
  if (!value || typeof value !== "object") {
    return {};
  }

  const normalized: GroupThemeSlots = {};
  for (const [fieldName, rawFieldSlots] of Object.entries(value as Record<string, unknown>)) {
    if (!isValidFieldName(fieldName) || !rawFieldSlots || typeof rawFieldSlots !== "object") {
      continue;
    }

    const fieldSlots: Record<string, number> = {};
    const usedSlots = new Set<number>();
    for (const [groupKey, rawSlot] of Object.entries(rawFieldSlots as Record<string, unknown>)) {
      const normalizedGroupKey = normalizeGroupKey(groupKey);
      if (!normalizedGroupKey || !isValidThemeSlot(rawSlot) || usedSlots.has(rawSlot)) {
        continue;
      }
      fieldSlots[normalizedGroupKey] = rawSlot;
      usedSlots.add(rawSlot);
    }

    if (Object.keys(fieldSlots).length > 0) {
      normalized[fieldName] = fieldSlots;
    }
  }

  return normalized;
}

export function reconcileGroupThemeSlots(
  current: GroupThemeSlots | undefined,
  fieldName: string | undefined,
  activeKeys: readonly unknown[],
): GroupThemeSlots {
  if (!isValidFieldName(fieldName)) {
    return current ?? {};
  }

  const fieldSlots = current?.[fieldName];
  const normalizedFieldSlots = normalizeFieldSlots(fieldSlots);
  const usedSlots = new Set<number>();
  for (const slot of Object.values(normalizedFieldSlots)) {
    usedSlots.add(slot);
  }

  const additions: Array<[string, number]> = [];
  const seenKeys = new Set<string>();
  for (const value of activeKeys) {
    if (value == null) {
      continue;
    }
    const groupKey = normalizeGroupKey(String(value));
    if (!groupKey || seenKeys.has(groupKey) || groupKey in normalizedFieldSlots) {
      continue;
    }
    const slot = lowestUnusedSlot(usedSlots);
    usedSlots.add(slot);
    additions.push([groupKey, slot]);
    seenKeys.add(groupKey);
  }

  if (additions.length === 0) {
    if (fieldSlotsAreEqual(fieldSlots, normalizedFieldSlots)) {
      return current ?? {};
    }

    if (!current) {
      return Object.keys(normalizedFieldSlots).length > 0 ? { [fieldName]: normalizedFieldSlots } : {};
    }

    const next = { ...current };
    if (Object.keys(normalizedFieldSlots).length > 0) {
      next[fieldName] = normalizedFieldSlots;
    } else {
      delete next[fieldName];
    }

    return Object.keys(next).length > 0 ? next : {};
  }

  return {
    ...(current ?? {}),
    [fieldName]: {
      ...normalizedFieldSlots,
      ...Object.fromEntries(additions),
    },
  };
}

export function groupThemeSlot(
  slots: GroupThemeSlots | undefined,
  fieldName: string | undefined,
  groupKey: string,
  fallbackIndex: number,
): number {
  if (!isValidFieldName(fieldName)) {
    return fallbackIndex;
  }

  const fieldSlots = slots?.[fieldName];
  if (!fieldSlots) {
    return fallbackIndex;
  }

  const slot = fieldSlots[groupKey];
  return isValidThemeSlot(slot) ? slot : fallbackIndex;
}

export function buildEffectiveGroupStyles(
  activeKeys: readonly string[],
  slots: GroupThemeSlots | undefined,
  fieldName: string | undefined,
  userStyles: GroupStyleMap,
  customPalettes: readonly CustomPalette[],
  hasBoxplot: boolean,
): GroupStyleMap {
  const out: GroupStyleMap = { ...userStyles };
  const groupedKeys = activeKeys.filter((key) => normalizeGroupKey(key) !== undefined);
  const isGrouped = isValidFieldName(fieldName) && groupedKeys.length > 0;

  for (let index = 0; index < activeKeys.length; index += 1) {
    const groupKey = activeKeys[index];
    const automatic: {
      line: MarkStyle;
      fill: MarkStyle;
      point: MarkStyle;
      gradient: MarkStyle;
    } = !isGrouped
      ? {
          line: { color: "#000000", lineWidth: 1.5, opacity: 1 },
          fill: {
            color: hasBoxplot ? shade("#000000", SHADE_RATIO_FILL) : "transparent",
            opacity: 1,
          },
          point: { color: "#000000", fillColor: "#000000", marker: "circle", markerSize: 4, opacity: 1 },
          gradient: { color: GROUP_COLORS[0], opacity: 1 },
        }
      : resolveAutomaticMarkStyles(groupThemeSlot(slots, fieldName, groupKey, index), customPalettes);

    const user = userStyles[groupKey];
    out[groupKey] = {
      line: { ...automatic.line, ...user?.line },
      fill: { ...automatic.fill, ...user?.fill },
      point: { ...automatic.point, ...user?.point },
      gradient: { ...automatic.gradient, ...user?.gradient },
    };
  }

  return out;
}