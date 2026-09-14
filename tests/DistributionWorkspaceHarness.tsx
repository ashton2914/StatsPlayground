import { useLayoutEffect, useMemo, useState } from "react";

import { ManageExtrasDialog } from "../src/components/ManageExtrasDialog";
import {
  createTableRenderLoadToken,
  useTablePropertyManagerController,
  type TablePropertyManagerRequest,
} from "../src/components/tablePropertyManagerRequest";
import i18n from "../src/i18n";
import { useDataStore } from "../src/stores/useDataStore";
import { useProjectStore } from "../src/stores/useProjectStore";
import type { DatasetMeta } from "../src/types/data";

const workspaceDatasetA: DatasetMeta = {
  id: "dataset-1",
  name: "Measurements",
  sourcePath: null,
  sourceType: "manual",
  rowCount: 2,
  colCount: 3,
  generation: 1,
  createdAt: "2026-09-14T00:00:00.000Z",
  updatedAt: "2026-09-14T00:00:00.000Z",
};

const workspaceDatasetB: DatasetMeta = {
  id: "dataset-2",
  name: "Measurements B",
  sourcePath: null,
  sourceType: "manual",
  rowCount: 2,
  colCount: 3,
  generation: 1,
  createdAt: "2026-09-14T00:00:00.000Z",
  updatedAt: "2026-09-14T00:00:00.000Z",
};

export function DistributionWorkspaceHarness() {
  const matchingRequestASeed = useMemo<TablePropertyManagerRequest>(() => ({
    requestId: "request-spec-1",
    datasetId: "dataset-1",
    colIndices: [2],
    extraKinds: ["spec"],
  }), []);
  const matchingRequestBSeed = useMemo<TablePropertyManagerRequest>(() => ({
    requestId: "request-spec-2",
    datasetId: "dataset-2",
    colIndices: [1],
    extraKinds: ["spec"],
  }), []);
  const mismatchedRequestSeed = useMemo<TablePropertyManagerRequest>(() => ({
    requestId: "request-spec-mismatch-2",
    datasetId: "dataset-3",
    colIndices: [1],
    extraKinds: ["spec"],
  }), []);
  const [ready, setReady] = useState(false);
  const [activeDatasetId, setActiveDatasetId] = useState(workspaceDatasetA.id);
  const [request, setRequest] = useState<TablePropertyManagerRequest | null>(null);
  const [loadedDataLoadToken, setLoadedDataLoadToken] = useState<string | null>(null);
  const [loadedDisplayPropsLoadToken, setLoadedDisplayPropsLoadToken] = useState<string | null>(null);
  const [loadedDataDatasetId, setLoadedDataDatasetId] = useState<string | null>(null);
  const [loadedDisplayPropsDatasetId, setLoadedDisplayPropsDatasetId] = useState<string | null>(null);
  const [shellTick, setShellTick] = useState(0);
  const [handledIds, setHandledIds] = useState<string[]>([]);

  useLayoutEffect(() => {
    const previousDataState = useDataStore.getState();
    const previousProjectState = useProjectStore.getState();
    const previousLanguage = i18n.resolvedLanguage ?? i18n.language;
    let active = true;

    useDataStore.setState({
      activeDatasetId: workspaceDatasetA.id,
      datasets: [workspaceDatasetA, workspaceDatasetB],
      statusInfo: null,
    });
    useProjectStore.setState({ ...previousProjectState, readOnly: false, dirty: false, saving: false, saveError: null });

    void i18n.changeLanguage("en").then(() => {
      if (active) setReady(true);
    });

    return () => {
      active = false;
      useDataStore.setState(previousDataState, true);
      useProjectStore.setState(previousProjectState, true);
      void i18n.changeLanguage(previousLanguage);
    };
  }, []);

  const activeDataset = activeDatasetId === workspaceDatasetB.id
    ? workspaceDatasetB
    : workspaceDatasetA;
  const currentRenderedLoadToken = createTableRenderLoadToken({
    datasetId: activeDataset.id,
    generation: activeDataset.generation,
    rowCount: activeDataset.rowCount,
    updatedAt: activeDataset.updatedAt,
  });

  useLayoutEffect(() => {
    useDataStore.setState((state) => ({
      ...state,
      activeDatasetId,
    }));
  }, [activeDatasetId]);

  const requestForRender = request == null
    ? null
    : {
        ...request,
        colIndices: [...request.colIndices],
        extraKinds: [...request.extraKinds],
      };

  const {
    showManageExtras,
    manageExtrasInitialSelectedColIndices,
    manageExtrasInitialExtraKinds,
    openManageExtras,
    closeManageExtras,
  } = useTablePropertyManagerController({
    datasetId: activeDatasetId,
    currentRenderedLoadToken,
    loadedDataLoadToken,
    loadedDisplayPropsLoadToken,
    propertyManagerRequest: requestForRender,
    onPropertyManagerRequestHandled: (requestId) => {
      setHandledIds((current) => [...current, requestId]);
      setRequest((current) => (current?.requestId === requestId ? null : current));
    },
  });

  if (!ready) return null;

  return (
    <div style={{ width: 1100, height: 720 }}>
      <div style={{ display: "flex", gap: 8, marginBottom: 8, position: "fixed", top: 8, left: 8, zIndex: 10000 }}>
        <button className="sp-dialog-btn" onClick={() => setRequest(matchingRequestASeed)}>
          Send dataset A request
        </button>
        <button className="sp-dialog-btn" onClick={() => setRequest(matchingRequestBSeed)}>
          Send dataset B request
        </button>
        <button className="sp-dialog-btn" onClick={() => setRequest(mismatchedRequestSeed)}>
          Send mismatched request
        </button>
        <button className="sp-dialog-btn" onClick={() => setActiveDatasetId(workspaceDatasetA.id)}>
          Switch to dataset A
        </button>
        <button className="sp-dialog-btn" onClick={() => setActiveDatasetId(workspaceDatasetB.id)}>
          Switch to dataset B
        </button>
        <button className="sp-dialog-btn" onClick={() => {
          setLoadedDataLoadToken(currentRenderedLoadToken);
          setLoadedDataDatasetId(activeDatasetId);
        }}>
          Resolve table data
        </button>
        <button className="sp-dialog-btn" onClick={() => {
          setLoadedDisplayPropsLoadToken(currentRenderedLoadToken);
          setLoadedDisplayPropsDatasetId(activeDatasetId);
        }}>
          Resolve display props
        </button>
        <button className="sp-dialog-btn" onClick={openManageExtras}>
          Manage Column Properties
        </button>
        <button className="sp-dialog-btn" onClick={() => setShellTick((value) => value + 1)}>
          Rerender shell
        </button>
        <div data-testid="active-dataset-id">{activeDatasetId}</div>
        <div data-testid="loaded-data-dataset-id">{loadedDataDatasetId ?? ""}</div>
        <div data-testid="loaded-display-props-dataset-id">{loadedDisplayPropsDatasetId ?? ""}</div>
        <div data-testid="handled-request-ids">{handledIds.join(",")}</div>
        <span data-shell-tick={shellTick} />
      </div>
      <div style={{ paddingTop: 56 }}>
      {showManageExtras && (
        <ManageExtrasDialog
          cols={["Column A", "Column B", "Column C"]}
          colExtras={[
            { unit: { value: "mm" } },
            null,
            { spec: { usl: 5 } },
          ]}
          sourceDatasetName={activeDataset.name}
          initialSelectedColIndices={manageExtrasInitialSelectedColIndices}
          initialExtraKinds={manageExtrasInitialExtraKinds}
          onApply={() => {}}
          onClose={closeManageExtras}
        />
      )}
      </div>
    </div>
  );
}