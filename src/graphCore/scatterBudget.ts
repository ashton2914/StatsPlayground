export const BUDGET_CANDIDATES = [5_000, 8_000, 10_000, 20_000, 50_000, 100_000] as const;
export const SCATTER_RENDER_BUDGET = 8_000;

export interface ScatterBudgetMeasurement {
  points: number;
  coherentFrameMs: number;
  longestTaskMs: number;
}

export function chooseScatterBudget(rows: readonly ScatterBudgetMeasurement[]): number {
  const passing = rows
    .filter((row) => row.coherentFrameMs <= 2_000 && row.longestTaskMs <= 200)
    .map((row) => row.points);
  if (passing.length === 0) {
    throw new Error("No measured scatter candidate passed the performance thresholds");
  }

  const largestPassing = Math.max(...passing);
  const safetyCap = Math.floor((largestPassing * 0.8) / 1_000) * 1_000;
  const measuredSafe = passing.filter((points) => points <= safetyCap);
  if (measuredSafe.length === 0) {
    throw new Error(`No measured passing scatter candidate validates the ${safetyCap}-point safety cap`);
  }
  return Math.max(...measuredSafe);
}