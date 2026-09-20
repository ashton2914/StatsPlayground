import { useEffect, useRef, useState } from "react";

import { DataTableView } from "../src/components/DataTableView";
import i18n from "../src/i18n";
import { dataService } from "../src/services/dataService";
import { useDataStore } from "../src/stores/useDataStore";
import { useDatasetFilterStore } from "../src/stores/useDatasetFilterStore";
import { useHistoryStore } from "../src/stores/useHistoryStore";
import { useProjectStore } from "../src/stores/useProjectStore";
import type { DatasetMeta, TableFilterValue, TableWindowResult } from "../src/types/data";
import type { FilterRuleItem } from "../src/types/filter";

type DataTableCountsHarnessVariant = "unfiltered" | "filtered" | "zero-match";

const DATASET: DatasetMeta = {
  id: "counts-dataset",
  name: "Counts dataset",
  sourcePath: null,
  sourceType: "manual",
  rowCount: 100,
  colCount: 2,
  generation: 1,
  createdAt: "2026-09-16T00:00:00.000Z",
  updatedAt: "2026-09-16T00:00:00.000Z",
};

const UPDATED_DATASET: DatasetMeta = {
  ...DATASET,
  rowCount: 80,
  colCount: 3,
  generation: 2,
  updatedAt: "2026-09-16T00:05:00.000Z",
};

const FILTER_RULE: FilterRuleItem = {
  id: "counts-filter-build",
  op: "AND",
  rule: {
    kind: "categorical",
    field: {
      name: "Build",
      type: "nominal",
    },
    selected: ["EV", "DV"],
    exclude: false,
  },
};

const UPDATED_FILTER_RULE: FilterRuleItem = {
  id: "counts-filter-build-updated",
  op: "AND",
  rule: {
    kind: "categorical",
    field: {
      name: "Build",
      type: "nominal",
    },
    selected: ["DV"],
    exclude: false,
  },
};

const FILTER_VALUES: TableFilterValue[] = [
  { value: "DV", rowCount: 24 },
  { value: "EV", rowCount: 76 },
];

const UPDATED_FILTER_VALUES: TableFilterValue[] = [
  { value: "DV", rowCount: 11 },
  { value: "EV", rowCount: 69 },
];

function createTable(totalRows: number, generation: number): TableWindowResult {
  return {
    columns: ["_row_id", "Build", "Value"],
    columnTypes: ["BIGINT", "VARCHAR", "DOUBLE"],
    rows: Array.from({ length: totalRows }, (_, index) => [
      index + 1,
      index % 2 === 0 ? "EV" : "DV",
      index + 0.5,
    ]),
    totalRows,
    start: 0,
    generation,
  };
}

interface HarnessState {
  activeDataset: DatasetMeta | undefined;
  filters: FilterRuleItem[];
  windowTotalRows: number;
}

function createInitialHarnessState(variant: DataTableCountsHarnessVariant): HarnessState {
  if (variant === "filtered") {
    return {
      activeDataset: DATASET,
      filters: [FILTER_RULE],
      windowTotalRows: 24,
    };
  }
  if (variant === "zero-match") {
    return {
      activeDataset: DATASET,
      filters: [FILTER_RULE],
      windowTotalRows: 0,
    };
  }
  return {
    activeDataset: DATASET,
    filters: [],
    windowTotalRows: 100,
  };
}

export function DataTableCountsHarness({
  variant,
}: {
  variant: DataTableCountsHarnessVariant;
}) {
  const [ready, setReady] = useState(false);
  const statusDimensions = useDataStore((state) => state.statusInfo?.dimensions ?? "");
  const [harnessState, setHarnessState] = useState<HarnessState>(() => createInitialHarnessState(variant));
  const [filterRequestGenerations, setFilterRequestGenerations] = useState<number[]>([]);
  const [tableWindowQuerySignatures, setTableWindowQuerySignatures] = useState<string[]>([]);
  const harnessStateRef = useRef(harnessState);
  harnessStateRef.current = harnessState;

  useEffect(() => {
    setHarnessState(createInitialHarnessState(variant));
  }, [variant]);

  useEffect(() => {
    if (!ready) return;
    useDataStore.setState((state) => ({
      ...state,
      activeDatasetId: DATASET.id,
      datasets: harnessState.activeDataset ? [harnessState.activeDataset] : [],
    }));
    useDatasetFilterStore.getState().replaceFilters(DATASET.id, harnessState.filters);
  }, [harnessState, ready]);

  useEffect(() => {
    const previousDataState = useDataStore.getState();
    const previousFilterState = useDatasetFilterStore.getState();
    const previousProjectState = useProjectStore.getState();
    const previousHistoryState = useHistoryStore.getState();
    const previousLanguage = i18n.resolvedLanguage ?? i18n.language;
    const previousGetDatasetGeneration = dataService.getDatasetGeneration;
    const previousQueryTableWindow = dataService.queryTableWindow;
    const previousGetColumnDisplayProps = dataService.getColumnDisplayProps;
    const previousQueryTableFilterValues = dataService.queryTableFilterValues;
    let active = true;

    useDataStore.setState({
      ...previousDataState,
      activeDatasetId: DATASET.id,
      datasets: harnessState.activeDataset ? [harnessState.activeDataset] : [],
      statusInfo: null,
    });
    useProjectStore.setState({ ...previousProjectState, readOnly: false, dirty: false, saving: false, saveError: null });
    useHistoryStore.setState({ ...previousHistoryState, historyRevision: 0, historyError: null, pendingRestore: null });
    useDatasetFilterStore.setState({
      ...previousFilterState,
      byDataset: harnessState.filters.length === 0
        ? {}
        : { [DATASET.id]: harnessState.filters },
    });

    dataService.getDatasetGeneration = async () => harnessStateRef.current.activeDataset?.generation ?? DATASET.generation;
    dataService.queryTableWindow = async (request) => {
      setTableWindowQuerySignatures((previous) => [
        ...previous,
        JSON.stringify({ filters: request.filters, sort: request.sort }),
      ]);
      return createTable(
        harnessStateRef.current.windowTotalRows,
        harnessStateRef.current.activeDataset?.generation ?? DATASET.generation,
      );
    };
    dataService.getColumnDisplayProps = async () => [];
    dataService.queryTableFilterValues = async (_datasetId, _field, _search, _limit, generation) => {
      setFilterRequestGenerations((previous) => [...previous, generation]);
      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, generation === DATASET.generation ? 400 : 5);
      });
      return generation === UPDATED_DATASET.generation ? UPDATED_FILTER_VALUES : FILTER_VALUES;
    };

    void i18n.changeLanguage("en").then(() => {
      if (active) setReady(true);
    });

    return () => {
      active = false;
      dataService.getDatasetGeneration = previousGetDatasetGeneration;
      dataService.queryTableWindow = previousQueryTableWindow;
      dataService.getColumnDisplayProps = previousGetColumnDisplayProps;
      dataService.queryTableFilterValues = previousQueryTableFilterValues;
      useDataStore.setState(previousDataState, true);
      useDatasetFilterStore.setState(previousFilterState, true);
      useProjectStore.setState(previousProjectState, true);
      useHistoryStore.setState(previousHistoryState, true);
      void i18n.changeLanguage(previousLanguage);
    };
  }, [variant]);

  const applyState = (nextState: HarnessState) => {
    setHarnessState(nextState);
    useDataStore.setState((state) => ({
      ...state,
      activeDatasetId: DATASET.id,
      datasets: nextState.activeDataset ? [nextState.activeDataset] : [],
    }));
    useDatasetFilterStore.getState().replaceFilters(DATASET.id, nextState.filters);
  };

  const clearActiveMetadata = () => {
    applyState({
      ...harnessState,
      activeDataset: undefined,
    });
  };

  const applyUpdatedMetadata = () => {
    applyState({
      ...harnessState,
      activeDataset: UPDATED_DATASET,
    });
  };

  const applyUpdatedFilterResult = () => {
    applyState({
      activeDataset: harnessState.activeDataset ?? UPDATED_DATASET,
      filters: [UPDATED_FILTER_RULE],
      windowTotalRows: 11,
    });
  };

  const clearFilters = () => {
    const activeDataset = harnessState.activeDataset ?? UPDATED_DATASET;
    applyState({
      activeDataset,
      filters: [],
      windowTotalRows: activeDataset.rowCount,
    });
  };

  if (!ready) return null;

  return (
    <div style={{ width: 1000, height: 680 }}>
      <output aria-label="Status dimensions">{statusDimensions}</output>
      <output aria-label="Harness metadata state">{harnessState.activeDataset ? `${harnessState.activeDataset.rowCount}x${harnessState.activeDataset.colCount}@${harnessState.activeDataset.generation}` : "missing"}</output>
      <output aria-label="Filter request generations">{filterRequestGenerations.join(",")}</output>
      <output aria-label="Table window query signatures">{tableWindowQuerySignatures.join("\n")}</output>
      <button type="button" onClick={clearActiveMetadata}>Clear active metadata</button>
      <button type="button" onClick={applyUpdatedMetadata}>Apply updated metadata</button>
      <button type="button" onClick={applyUpdatedFilterResult}>Apply updated filter result</button>
      <button type="button" onClick={clearFilters}>Clear filters</button>
      <DataTableView datasetId={DATASET.id} />
    </div>
  );
}