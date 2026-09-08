import { DEFAULT_GROUP_KEY } from "../../graphCore/types.ts";

function normalizeGroupValues(values: readonly unknown[]): string[] {
  const unique = new Set<string>();
  for (const value of values) {
    if (value == null) continue;
    const key = String(value);
    if (key.trim().length === 0 || key === DEFAULT_GROUP_KEY) continue;
    unique.add(key);
  }
  return [...unique];
}

function compareGroupKeys(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export function resolveStableGroupKeys(
  discoveredValues: readonly unknown[],
  dictionaryValues: readonly unknown[],
  valueOrder: readonly string[] | undefined,
): string[] {
  const candidates = normalizeGroupValues([
    ...discoveredValues,
    ...dictionaryValues,
  ]);
  const candidateSet = new Set(candidates);
  const ordered: string[] = [];
  const used = new Set<string>();

  for (const key of valueOrder ?? []) {
    if (!candidateSet.has(key) || used.has(key)) continue;
    ordered.push(key);
    used.add(key);
  }

  const remaining = candidates
    .filter((key) => !used.has(key))
    .sort(compareGroupKeys);
  return [...ordered, ...remaining];
}

export function resolveThemeGroupKeySets(
  discoveredValues: readonly unknown[],
  dictionaryValues: readonly unknown[],
  valueOrder: readonly string[] | undefined,
): {
  slotCandidateKeys: string[];
  legendGroupKeys: string[];
} {
  return {
    slotCandidateKeys: resolveStableGroupKeys(discoveredValues, dictionaryValues, undefined),
    legendGroupKeys: resolveStableGroupKeys(discoveredValues, [], valueOrder),
  };
}
