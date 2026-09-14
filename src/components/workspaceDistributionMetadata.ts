export interface WorkspaceDistributionAnalysisIdentity {
  id: string;
  sourceDatasetId: string;
}

interface DistributionCreateMetadataLoadDecision {
  requestedDatasetId: string;
  requestEpoch: number;
  currentRequestEpoch: number;
  activeDatasetId: string | null;
  availableDatasetIds: readonly string[];
}

interface DistributionEditMetadataLoadDecision {
  requestedAnalysisId: string;
  requestedDatasetId: string;
  requestEpoch: number;
  currentRequestEpoch: number;
  availableDatasetIds: readonly string[];
  analyses: readonly WorkspaceDistributionAnalysisIdentity[];
}

export function shouldApplyDistributionCreateMetadataLoad({
  requestedDatasetId,
  requestEpoch,
  currentRequestEpoch,
  activeDatasetId,
  availableDatasetIds,
}: DistributionCreateMetadataLoadDecision): boolean {
  return requestEpoch === currentRequestEpoch
    && activeDatasetId === requestedDatasetId
    && availableDatasetIds.includes(requestedDatasetId);
}

export function shouldApplyDistributionEditMetadataLoad({
  requestedAnalysisId,
  requestedDatasetId,
  requestEpoch,
  currentRequestEpoch,
  availableDatasetIds,
  analyses,
}: DistributionEditMetadataLoadDecision): boolean {
  if (requestEpoch !== currentRequestEpoch) return false;
  if (!availableDatasetIds.includes(requestedDatasetId)) return false;
  const analysis = analyses.find((item) => item.id === requestedAnalysisId);
  return analysis?.sourceDatasetId === requestedDatasetId;
}