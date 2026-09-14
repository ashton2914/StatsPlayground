import { useEffect, useMemo, useRef, useState } from "react";

import i18n from "../src/i18n";
import { DataTableView } from "../src/components/DataTableView";
import { dataService } from "../src/services/dataService";
import { useDataStore } from "../src/stores/useDataStore";
import { useHistoryStore } from "../src/stores/useHistoryStore";
import { useProjectStore } from "../src/stores/useProjectStore";
import type {
  ColumnDisplayProps,
  DatasetMeta,
  TableWindowResult,
} from "../src/types/data";
import type { TablePropertyManagerRequest } from "../src/components/tablePropertyManagerRequest";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

const DATASET_V1: DatasetMeta = {
  id: "dataset-1",
  name: "Measurements",
  sourcePath: null,
  sourceType: "manual",
  rowCount: 1,
  colCount: 1,
  generation: 1,
  createdAt: "2026-09-14T00:00:00.000Z",
  updatedAt: "2026-09-14T00:00:00.000Z",
};

const DATASET_V2: DatasetMeta = {
  ...DATASET_V1,
  rowCount: 2,
  colCount: 2,
  generation: 2,
  updatedAt: "2026-09-14T00:01:00.000Z",
};

const TABLE_V1: TableWindowResult = {
  columns: ["_row_id", "Old"],
  columnTypes: ["INTEGER", "DOUBLE"],
  rows: [[1, 10]],
  totalRows: 1,
  start: 0,
  generation: 1,
};

const TABLE_V2: TableWindowResult = {
  columns: ["_row_id", "Old", "New"],
  columnTypes: ["INTEGER", "DOUBLE", "DOUBLE"],
  rows: [[1, 10, 20], [2, 11, 21]],
  totalRows: 2,
  start: 0,
  generation: 2,
};

const DISPLAY_PROPS_V1: ColumnDisplayProps[] = [];
const DISPLAY_PROPS_V2: ColumnDisplayProps[] = [];

export function DataTableViewPropertyManagerHarness() {
  const requestSeed = useMemo<TablePropertyManagerRequest>(() => ({
    requestId: "request-refresh-1",
    datasetId: "dataset-1",
    colIndices: [1],
    extraKinds: ["spec"],
  }), []);
  const [ready, setReady] = useState(false);
  const [handledRequestIds, setHandledRequestIds] = useState<string[]>([]);
  const [request, setRequest] = useState<TablePropertyManagerRequest | null>(null);
  const [initialLoadComplete, setInitialLoadComplete] = useState(false);
  const [refreshLoadIssued, setRefreshLoadIssued] = useState(false);
  const [refreshDisplayPropsIssued, setRefreshDisplayPropsIssued] = useState(false);
  const refreshTableResolveRef = useRef<((value: TableWindowResult) => void) | null>(null);
  const refreshDisplayPropsResolveRef = useRef<((value: ColumnDisplayProps[]) => void) | null>(null);

  useEffect(() => {
    const previousDataState = useDataStore.getState();
    const previousProjectState = useProjectStore.getState();
    const previousHistoryState = useHistoryStore.getState();
    const previousLanguage = i18n.resolvedLanguage ?? i18n.language;
    const previousGetDatasetGeneration = dataService.getDatasetGeneration;
    const previousQueryTableWindow = dataService.queryTableWindow;
    const previousGetColumnDisplayProps = dataService.getColumnDisplayProps;
    let active = true;

    useDataStore.setState({
      ...previousDataState,
      activeDatasetId: DATASET_V1.id,
      datasets: [DATASET_V1],
      statusInfo: null,
    });
    useProjectStore.setState({ ...previousProjectState, readOnly: false, dirty: false, saving: false, saveError: null });
    useHistoryStore.setState({ ...previousHistoryState, historyRevision: 0, historyError: null, pendingRestore: null });

    dataService.getDatasetGeneration = async () => useDataStore.getState().datasets[0]?.generation ?? 0;
    dataService.queryTableWindow = async ({ generation }) => {
      if (generation === 1) {
        return TABLE_V1;
      }
      if (active) setRefreshLoadIssued(true);
      const next = deferred<TableWindowResult>();
      refreshTableResolveRef.current = next.resolve;
      return next.promise;
    };
    dataService.getColumnDisplayProps = async () => {
      const generation = useDataStore.getState().datasets[0]?.generation ?? 0;
      if (generation === 1) {
        if (active) setInitialLoadComplete(true);
        return DISPLAY_PROPS_V1;
      }
      if (active) setRefreshDisplayPropsIssued(true);
      const next = deferred<ColumnDisplayProps[]>();
      refreshDisplayPropsResolveRef.current = next.resolve;
      return next.promise;
    };

    void i18n.changeLanguage("en").then(() => {
      if (active) setReady(true);
    });

    return () => {
      active = false;
      dataService.getDatasetGeneration = previousGetDatasetGeneration;
      dataService.queryTableWindow = previousQueryTableWindow;
      dataService.getColumnDisplayProps = previousGetColumnDisplayProps;
      refreshTableResolveRef.current = null;
      refreshDisplayPropsResolveRef.current = null;
      useDataStore.setState(previousDataState, true);
      useProjectStore.setState(previousProjectState, true);
      useHistoryStore.setState(previousHistoryState, true);
      void i18n.changeLanguage(previousLanguage);
    };
  }, []);

  if (!ready) return null;

  return (
    <div style={{ width: 1200, height: 760 }}>
      <div style={{ display: "flex", gap: 8, marginBottom: 8, position: "fixed", top: 8, left: 8, zIndex: 10000 }}>
        <button
          className="sp-dialog-btn"
          onClick={() => {
            useDataStore.setState((state) => ({
              ...state,
              datasets: [DATASET_V2],
              activeDatasetId: DATASET_V2.id,
            }));
            setRequest({ ...requestSeed, colIndices: [...requestSeed.colIndices], extraKinds: [...requestSeed.extraKinds] });
          }}
        >
          Publish same-dataset refresh request
        </button>
        <button
          className="sp-dialog-btn"
          onClick={() => {
            refreshTableResolveRef.current?.(TABLE_V2);
          }}
        >
          Resolve refreshed table data
        </button>
        <button
          className="sp-dialog-btn"
          onClick={() => {
            refreshDisplayPropsResolveRef.current?.(DISPLAY_PROPS_V2);
          }}
        >
          Resolve refreshed display props
        </button>
        <div data-testid="initial-load-complete">{initialLoadComplete ? "yes" : "no"}</div>
        <div data-testid="refresh-load-issued">{refreshLoadIssued ? "yes" : "no"}</div>
        <div data-testid="refresh-display-props-issued">{refreshDisplayPropsIssued ? "yes" : "no"}</div>
        <div data-testid="handled-request-ids">{handledRequestIds.join(",")}</div>
        <div data-testid="handled-request-count">{String(handledRequestIds.length)}</div>
      </div>
      <div style={{ paddingTop: 56, height: "100%" }}>
        <DataTableView
          datasetId={DATASET_V1.id}
          propertyManagerRequest={request}
          onPropertyManagerRequestHandled={(requestId) => {
            setHandledRequestIds((current) => [...current, requestId]);
            setRequest((current) => (current?.requestId === requestId ? null : current));
          }}
        />
      </div>
    </div>
  );
}