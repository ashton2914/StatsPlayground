interface DataTableLoadIdentityDecision {
  requestedDatasetId: string;
  currentDatasetId: string | null;
}

export function shouldIssueDataTableLoadForCurrentDataset({
  requestedDatasetId,
  currentDatasetId,
}: DataTableLoadIdentityDecision): boolean {
  return currentDatasetId === requestedDatasetId;
}