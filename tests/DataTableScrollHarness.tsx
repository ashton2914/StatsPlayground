import { useEffect, useState } from "react";

import { DataTableView } from "../src/components/DataTableView";
import i18n from "../src/i18n";
import { dataService } from "../src/services/dataService";
import { useDataStore } from "../src/stores/useDataStore";
import { useHistoryStore } from "../src/stores/useHistoryStore";
import { useProjectStore } from "../src/stores/useProjectStore";
import { useTableZoomStore } from "../src/stores/useTableZoomStore";
import type { DatasetMeta, TableWindowResult } from "../src/types/data";

const DATASET: DatasetMeta = {
  id: "scroll-dataset",
  name: "Scroll measurements",
  sourcePath: null,
  sourceType: "manual",
  rowCount: 238,
  colCount: 1,
  generation: 1,
  createdAt: "2026-09-15T00:00:00.000Z",
  updatedAt: "2026-09-15T00:00:00.000Z",
};

const TABLE: TableWindowResult = {
  columns: ["_row_id", "Value"],
  columnTypes: ["BIGINT", "VARCHAR"],
  rows: Array.from({ length: DATASET.rowCount }, (_, index) => [index + 1, `row-${index + 1}`]),
  totalRows: DATASET.rowCount,
  start: 0,
  generation: DATASET.generation,
};

export function DataTableScrollHarness({ zoom = 1 }: { zoom?: number }) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const previousDataState = useDataStore.getState();
    const previousProjectState = useProjectStore.getState();
    const previousHistoryState = useHistoryStore.getState();
    const previousZoom = useTableZoomStore.getState().zoom;
    const previousLanguage = i18n.resolvedLanguage ?? i18n.language;
    const previousGetDatasetGeneration = dataService.getDatasetGeneration;
    const previousQueryTableWindow = dataService.queryTableWindow;
    const previousGetColumnDisplayProps = dataService.getColumnDisplayProps;
    let active = true;

    useDataStore.setState({
      ...previousDataState,
      activeDatasetId: DATASET.id,
      datasets: [DATASET],
      statusInfo: null,
    });
    useProjectStore.setState({ ...previousProjectState, readOnly: false, dirty: false, saving: false, saveError: null });
    useHistoryStore.setState({ ...previousHistoryState, historyRevision: 0, historyError: null, pendingRestore: null });
    useTableZoomStore.setState({ zoom });

    dataService.getDatasetGeneration = async () => DATASET.generation;
    dataService.queryTableWindow = async () => TABLE;
    dataService.getColumnDisplayProps = async () => [];

    void i18n.changeLanguage("en").then(() => {
      if (active) setReady(true);
    });

    return () => {
      active = false;
      dataService.getDatasetGeneration = previousGetDatasetGeneration;
      dataService.queryTableWindow = previousQueryTableWindow;
      dataService.getColumnDisplayProps = previousGetColumnDisplayProps;
      useDataStore.setState(previousDataState, true);
      useProjectStore.setState(previousProjectState, true);
      useHistoryStore.setState(previousHistoryState, true);
      useTableZoomStore.setState({ zoom: previousZoom });
      void i18n.changeLanguage(previousLanguage);
    };
  }, [zoom]);

  if (!ready) return null;

  return (
    <div style={{ width: 900, height: 620 }}>
      <DataTableView datasetId={DATASET.id} />
    </div>
  );
}