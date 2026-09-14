import { useCallback, useEffect, useRef, useState } from "react";
import type { ColumnDisplayProps } from "@/types/data";
import type { DistributionFieldInfo } from "@/components/distribution";
import { inferFieldType } from "@/graphCore/types";
import type { ExtraKind } from "@/types/columnExtras";
import type { DatasetRevision } from "@/utils/tableViewport";

export interface TablePropertyManagerRequest {
  requestId: string;
  datasetId: string;
  colIndices: number[];
  extraKinds: ExtraKind[];
}

interface TablePropertyManagerReadiness {
  currentRenderedLoadToken: string;
  loadedDataLoadToken: string | null;
  loadedDisplayPropsLoadToken: string | null;
}

export function createTableRenderLoadToken(revision: DatasetRevision): string {
  return JSON.stringify([
    revision.datasetId,
    revision.generation,
    revision.rowCount,
    revision.updatedAt,
  ]);
}

export function buildDistributionFieldInfo(
  columns: Array<[string, string]>,
  displayProps: readonly ColumnDisplayProps[],
): DistributionFieldInfo[] {
  const displayPropsByIndex = new Map(displayProps.map((entry) => [entry.colIndex, entry]));
  return columns.map(([name, sqlType], colIndex) => ({
    name,
    sqlType,
    integerCompatible: /^(?:U?(?:TINY|SMALL|BIG|HUGE)?INT(?:EGER)?)$/i.test(sqlType),
    colIndex,
    extras: displayPropsByIndex.get(colIndex)?.extras,
    field: { name, type: inferFieldType(sqlType) },
  }));
}

export function shouldConsumeTablePropertyManagerRequest(
  request: TablePropertyManagerRequest | null | undefined,
  readiness: TablePropertyManagerReadiness,
  currentRenderedDatasetId: string,
  handledRequestId: string | null,
): boolean {
  return request != null
    && request.datasetId === currentRenderedDatasetId
    && readiness.currentRenderedLoadToken === readiness.loadedDataLoadToken
    && readiness.currentRenderedLoadToken === readiness.loadedDisplayPropsLoadToken
    && request.requestId !== handledRequestId;
}

export function shouldRetainTablePropertyManagerRequest(
  request: TablePropertyManagerRequest | null | undefined,
  availableDatasetIds: readonly string[],
): boolean {
  return request == null || availableDatasetIds.includes(request.datasetId);
}

interface UseTablePropertyManagerControllerParams {
  datasetId: string;
  currentRenderedLoadToken: string;
  loadedDataLoadToken: string | null;
  loadedDisplayPropsLoadToken: string | null;
  propertyManagerRequest?: TablePropertyManagerRequest | null;
  onPropertyManagerRequestHandled?: (requestId: string) => void;
}

interface TablePropertyManagerController {
  showManageExtras: boolean;
  manageExtrasInitialSelectedColIndices: readonly number[] | undefined;
  manageExtrasInitialExtraKinds: readonly ExtraKind[] | undefined;
  openManageExtras: () => void;
  closeManageExtras: () => void;
}

export function useTablePropertyManagerController({
  datasetId,
  currentRenderedLoadToken,
  loadedDataLoadToken,
  loadedDisplayPropsLoadToken,
  propertyManagerRequest,
  onPropertyManagerRequestHandled,
}: UseTablePropertyManagerControllerParams): TablePropertyManagerController {
  const [showManageExtras, setShowManageExtras] = useState(false);
  const [manageExtrasInitialSelectedColIndices, setManageExtrasInitialSelectedColIndices] = useState<readonly number[] | undefined>(undefined);
  const [manageExtrasInitialExtraKinds, setManageExtrasInitialExtraKinds] = useState<readonly ExtraKind[] | undefined>(undefined);
  const lastHandledPropertyManagerRequestIdRef = useRef<string | null>(null);
  const propertyManagerRequestRef = useRef<TablePropertyManagerRequest | null>(null);
  propertyManagerRequestRef.current = propertyManagerRequest ?? null;

  useEffect(() => {
    const currentPropertyManagerRequest = propertyManagerRequestRef.current;
    if (!shouldConsumeTablePropertyManagerRequest(
      currentPropertyManagerRequest,
      {
        currentRenderedLoadToken,
        loadedDataLoadToken,
        loadedDisplayPropsLoadToken,
      },
      datasetId,
      lastHandledPropertyManagerRequestIdRef.current,
    )) {
      return;
    }
    const propertyManagerRequestId = currentPropertyManagerRequest?.requestId ?? null;
    lastHandledPropertyManagerRequestIdRef.current = propertyManagerRequestId;
    setManageExtrasInitialSelectedColIndices(currentPropertyManagerRequest?.colIndices);
    setManageExtrasInitialExtraKinds(currentPropertyManagerRequest?.extraKinds);
    setShowManageExtras(true);
    if (propertyManagerRequestId) {
      onPropertyManagerRequestHandled?.(propertyManagerRequestId);
    }
  }, [currentRenderedLoadToken, datasetId, loadedDataLoadToken, loadedDisplayPropsLoadToken, onPropertyManagerRequestHandled, propertyManagerRequest?.datasetId, propertyManagerRequest?.requestId]);

  const openManageExtras = useCallback(() => {
    setManageExtrasInitialSelectedColIndices(undefined);
    setManageExtrasInitialExtraKinds(undefined);
    setShowManageExtras(true);
  }, []);

  const closeManageExtras = useCallback(() => {
    setShowManageExtras(false);
    setManageExtrasInitialSelectedColIndices(undefined);
    setManageExtrasInitialExtraKinds(undefined);
  }, []);

  return {
    showManageExtras,
    manageExtrasInitialSelectedColIndices,
    manageExtrasInitialExtraKinds,
    openManageExtras,
    closeManageExtras,
  };
}