import { useEffect, useState } from "react";

import { GraphBuilderView } from "../src/components/graphBuilder/GraphBuilderView";
import { normalizeGraphBuilderItem } from "../src/components/graphBuilder/graphBuilderMode";
import i18n from "../src/i18n";
import { dataService } from "../src/services/dataService";
import { graphDataService } from "../src/services/graphDataService";
import { useDataStore } from "../src/stores/useDataStore";
import { useDatasetFilterStore } from "../src/stores/useDatasetFilterStore";
import { useGraphBuilderStore } from "../src/stores/useGraphBuilderStore";
import { useProjectStore } from "../src/stores/useProjectStore";
import type { ChartElement, FieldRef } from "../src/graphCore";
import type { DatasetMeta } from "../src/types/data";
import type { GraphDataRequest } from "../src/types/graphData";

const DATASET: DatasetMeta = {
  id: "time-series-dataset",
  name: "Time Series Table",
  sourcePath: null,
  sourceType: "manual",
  rowCount: 9,
  colCount: 5,
  generation: 4,
  createdAt: "2026-09-16T00:00:00.000Z",
  updatedAt: "2026-09-16T00:00:00.000Z",
};

const dateField: FieldRef = { columnId: "col-date", name: "Captured Date", type: "datetime" };
const textField: FieldRef = { columnId: "col-text", name: "Screenshot Date", type: "nominal" };
const numberField: FieldRef = { columnId: "col-index", name: "Elapsed", type: "continuous" };
const timeField: FieldRef = { columnId: "col-time", name: "Clock Time", type: "datetime" };
const timeTzField: FieldRef = { columnId: "col-timetz", name: "Clock Time TZ", type: "datetime" };
const valueField: FieldRef = { columnId: "col-value", name: "Reading", type: "continuous" };

const descriptors = [
  { columnId: dateField.columnId!, name: dateField.name, sqlType: "DATE" },
  { columnId: textField.columnId!, name: textField.name, sqlType: "VARCHAR" },
  { columnId: numberField.columnId!, name: numberField.name, sqlType: "DOUBLE" },
  { columnId: timeField.columnId!, name: timeField.name, sqlType: "TIME" },
  { columnId: timeTzField.columnId!, name: timeTzField.name, sqlType: "TIMETZ" },
  { columnId: valueField.columnId!, name: valueField.name, sqlType: "DOUBLE" },
];

function baseElements(): ChartElement[] {
  return [
    { kind: "points", enabled: true },
    { kind: "line", enabled: true },
  ];
}

function makeItem(elements = baseElements()) {
  return normalizeGraphBuilderItem({
    id: "time-series-graph",
    name: "Time Series Graph",
    sourceDatasetId: DATASET.id,
    createdAt: "2026-09-16T00:00:00.000Z",
    mode: "2d",
    modeStates: {
      twoD: {
        encoding: { x: dateField, y: valueField },
        multiX: [],
        multiY: [],
        elements,
        smootherLambda: 0.4,
      },
      threeD: {
        encoding: {},
        elements: [{ kind: "scatter3d", enabled: true }],
        smootherLambda: 0.4,
      },
      multivariate: {
        columns: [],
        chartType: "correlationMatrix",
        correlationMethod: "pearson",
      },
    },
    sampling: { mode: "sample", size: 5, seed: 17 },
  });
}

function setX(field: FieldRef) {
  const current = useGraphBuilderStore.getState().items[0];
  if (!current) return;
  useGraphBuilderStore.getState().updateItem(current.id, {
    modeStates: {
      ...current.modeStates,
      twoD: {
        ...current.modeStates.twoD,
        encoding: { ...current.modeStates.twoD.encoding, x: field },
      },
    },
  });
}

function updateTimeSeriesOptions(patch: Record<string, unknown>) {
  const current = useGraphBuilderStore.getState().items[0];
  if (!current) return;
  useGraphBuilderStore.getState().updateItem(current.id, {
    modeStates: {
      ...current.modeStates,
      twoD: {
        ...current.modeStates.twoD,
        elements: current.modeStates.twoD.elements.map((element) => element.kind === "timeSeries"
          ? { ...element, options: { ...(element.options ?? {}), ...patch } }
          : element),
      },
    },
  });
}

export function TimeSeriesGraphHarness({ invalidXRows = 0 }: { invalidXRows?: number }) {
  const [ready, setReady] = useState(false);
  const [requests, setRequests] = useState<GraphDataRequest[]>([]);
  const item = useGraphBuilderStore((state) => state.items[0]);

  useEffect(() => {
    const previousLanguage = i18n.resolvedLanguage ?? i18n.language;
    const previousDataState = useDataStore.getState();
    const previousGraphState = useGraphBuilderStore.getState();
    const previousFilterState = useDatasetFilterStore.getState();
    const previousProjectState = useProjectStore.getState();
    const previousGetDescriptors = dataService.getColumnDescriptors;
    const previousGetDisplayProps = dataService.getColumnDisplayProps;
    const previousGetGeneration = dataService.getDatasetGeneration;
    const previousStream = graphDataService.stream;
    let active = true;

    useDataStore.setState({
      ...previousDataState,
      datasets: [DATASET],
      activeDatasetId: DATASET.id,
    });
    useGraphBuilderStore.setState({ ...previousGraphState, items: [makeItem()], counter: 0 });
    useDatasetFilterStore.setState({ ...previousFilterState, byDataset: {} });
    useProjectStore.setState({ ...previousProjectState, readOnly: false, dirty: false, saving: false, saveError: null });

    dataService.getColumnDescriptors = async () => descriptors;
    dataService.getColumnDisplayProps = async () => [];
    dataService.getDatasetGeneration = async () => DATASET.generation;
    graphDataService.stream = (request, handlers) => {
      setRequests((previous) => [...previous, request]);
      queueMicrotask(() => {
        handlers.onComplete({
          requestId: request.requestId,
          datasetId: request.datasetId,
          generation: request.generation,
          sourceRows: DATASET.rowCount,
          processedRows: DATASET.rowCount - invalidXRows,
          chunksSent: 0,
          cancelled: false,
          rawPointDisposition: { status: "omitted", reason: "pointBudgetExceeded", validRows: DATASET.rowCount - invalidXRows, budget: 0 },
          timeSeriesDisposition: invalidXRows > 0
            ? { status: "invalidTimeSeriesX", includedRows: DATASET.rowCount - invalidXRows, invalidXRows }
            : { status: "included", includedRows: DATASET.rowCount, invalidXRows: 0 },
        });
      });
      return { cancel: async () => {} };
    };

    void i18n.changeLanguage("en").then(() => {
      if (active) setReady(true);
    });

    return () => {
      active = false;
      dataService.getColumnDescriptors = previousGetDescriptors;
      dataService.getColumnDisplayProps = previousGetDisplayProps;
      dataService.getDatasetGeneration = previousGetGeneration;
      graphDataService.stream = previousStream;
      useDataStore.setState(previousDataState, true);
      useGraphBuilderStore.setState(previousGraphState, true);
      useDatasetFilterStore.setState(previousFilterState, true);
      useProjectStore.setState(previousProjectState, true);
      void i18n.changeLanguage(previousLanguage);
    };
  }, [invalidXRows]);

  if (!ready || !item) return null;

  return (
    <div style={{ width: 1180, height: 760 }}>
      <div aria-label="time-series-test-controls">
        <button type="button" onClick={() => setX(dateField)}>Use DATE X</button>
        <button type="button" onClick={() => setX(textField)}>Use VARCHAR X</button>
        <button type="button" onClick={() => setX(numberField)}>Use numeric X</button>
        <button type="button" onClick={() => setX(timeField)}>Use TIME X</button>
        <button type="button" onClick={() => setX(timeTzField)}>Use TIMETZ X</button>
        <button type="button" onClick={() => updateTimeSeriesOptions({ xInterpretation: { kind: "textDate", format: "usDate" } })}>US date format</button>
        <button type="button" onClick={() => updateTimeSeriesOptions({ xInterpretation: { kind: "sequence" } })}>Sequence interpretation</button>
        <button type="button" onClick={() => updateTimeSeriesOptions({ order: "sourceRow" })}>Source row order</button>
        <button type="button" onClick={() => updateTimeSeriesOptions({ missingValues: "connect" })}>Connect missing</button>
        <button type="button" onClick={() => updateTimeSeriesOptions({ connection: "step" })}>Step connection</button>
        <button type="button" onClick={() => updateTimeSeriesOptions({ markerMode: "show" })}>Show markers</button>
      </div>
      <GraphBuilderView item={item} dataset={DATASET} />
      <output data-testid="time-series-item-json">{JSON.stringify(item)}</output>
      <output data-testid="time-series-request-json">{JSON.stringify(requests.at(-1) ?? null)}</output>
      <output data-testid="time-series-request-count">{requests.length}</output>
    </div>
  );
}