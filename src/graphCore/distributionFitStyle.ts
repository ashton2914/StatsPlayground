import type { ContinuousDistributionIdV1 } from "@/types/distribution";

export const DISTRIBUTION_FIT_ORDER = [
  "normal",
  "cauchy",
  "lognormal",
  "weibull",
  "exponential",
  "gamma",
] as const satisfies readonly ContinuousDistributionIdV1[];

const DISTRIBUTION_FIT_IDS = new Set<string>(DISTRIBUTION_FIT_ORDER);

export function distributionFitColor(
  distributionId: ContinuousDistributionIdV1,
  categorical: readonly string[],
): string {
  if (categorical.length === 0) return "#4a6cf7";
  const index = DISTRIBUTION_FIT_ORDER.indexOf(distributionId);
  return categorical[Math.max(0, index) % categorical.length] ?? "#4a6cf7";
}

export function distributionIdFromFitSeriesId(
  seriesId: string | undefined,
): ContinuousDistributionIdV1 | null {
  const match = seriesId?.match(/:fit:([^:]+)$/);
  const distributionId = match?.[1];
  return distributionId && DISTRIBUTION_FIT_IDS.has(distributionId)
    ? distributionId as ContinuousDistributionIdV1
    : null;
}