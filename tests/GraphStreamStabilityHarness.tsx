import { useCallback, useEffect, useState } from "react";

import { normalizeGraphBuilderItem } from "../src/components/graphBuilder/graphBuilderMode";
import {
  deriveGraphRequestIdentity,
  useGraphDataPipeline,
} from "../src/components/graphBuilder/useGraphDataPipeline";
import { dataService } from "../src/services/dataService";
import { graphDataService } from "../src/services/graphDataService";
import type { FieldRef, GroupStyleMap } from "../src/graphCore";
import type { DatasetMeta } from "../src/types/data";
import type { GraphBuilderItem, GraphRuntimeItem } from "../src/types/graphBuilder";
import type { GraphDataRequest } from "../src/types/graphData";

const DATASET: DatasetMeta = {
  id: "generic-stream-dataset",
  name: "Generic Stream Table",
  sourcePath: null,
  sourceType: "manual",
  rowCount: 8,
  colCount: 3,
  generation: 2,
  createdAt: "2026-09-16T00:00:00.000Z",
  updatedAt: "2026-09-16T00:00:00.000Z",
};

const xField: FieldRef = { columnId: "col-x", name: "Build", type: "nominal" };
const yField: FieldRef = { columnId: "col-y", name: "Reading", type: "continuous" };
const groupField: FieldRef = { columnId: "col-group", name: "Station", type: "nominal" };

const descriptors = [
  { columnId: xField.columnId!, name: xField.name, sqlType: "VARCHAR" },
  { columnId: yField.columnId!, name: yField.name, sqlType: "DOUBLE" },
  { columnId: groupField.columnId!, name: groupField.name, sqlType: "VARCHAR" },
];

function makeItem(): GraphBuilderItem {
  return normalizeGraphBuilderItem({
    id: "generic-stream-graph",
    name: "Generic Stream Graph",
    sourceDatasetId: DATASET.id,
    createdAt: "2026-09-16T00:00:00.000Z",
    mode: "2d",
    modeStates: {
      twoD: {
        encoding: { x: xField, y: yField, overlay: groupField },
        multiX: [],
        multiY: [],
        elements: [{ kind: "points", enabled: true }],
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
    sampling: { mode: "full" },
  });
}

export function GraphStreamStabilityHarness() {
  const [ready, setReady] = useState(false);
  const [requests, setRequests] = useState<GraphDataRequest[]>([]);

  useEffect(() => {
    const previousGetDescriptors = dataService.getColumnDescriptors;
    const previousGetDisplayProps = dataService.getColumnDisplayProps;
    const previousGetGeneration = dataService.getDatasetGeneration;
    const previousStream = graphDataService.stream;

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
          processedRows: DATASET.rowCount,
          chunksSent: 0,
          cancelled: false,
          rawPointDisposition: { status: "omitted", reason: "pointBudgetExceeded", validRows: DATASET.rowCount, budget: 0 },
        });
      });
      return { cancel: async () => {} };
    };

    setReady(true);

    return () => {
      dataService.getColumnDescriptors = previousGetDescriptors;
      dataService.getColumnDisplayProps = previousGetDisplayProps;
      dataService.getDatasetGeneration = previousGetGeneration;
      graphDataService.stream = previousStream;
    };
  }, []);

  if (!ready) return null;

  return <PipelineHarness requests={requests} />;
}

function PipelineHarness({ requests }: { requests: GraphDataRequest[] }) {
  const [item, setItem] = useState<GraphRuntimeItem>(() => ({ ...makeItem(), filters: [] }));
  const resolveLatestItem = useCallback(() => item, [item]);
  const requestIdentity = deriveGraphRequestIdentity(item, descriptors);

  useGraphDataPipeline(
    item,
    DATASET,
    { width: 1280, height: 720 },
    true,
    descriptors,
    resolveLatestItem,
  );

  const hideStationA = () => {
    setItem((current) => ({
      ...current,
      modeStates: {
        ...current.modeStates,
        twoD: {
          ...current.modeStates.twoD,
          hiddenGroups: ["Station A"],
        },
      },
    }));
  };

  const colorStationA = () => {
    const groupStyles: GroupStyleMap = {
      "Station A": { point: { color: "#00C853" } },
    };
    setItem((current) => ({
      ...current,
      modeStates: {
        ...current.modeStates,
        twoD: {
          ...current.modeStates.twoD,
          groupStyles,
        },
      },
    }));
  };

  return (
    <div style={{ width: 1180, height: 760 }}>
      <div aria-label="generic-stream-test-controls">
        <button type="button" onClick={hideStationA}>Hide Station A</button>
        <button type="button" onClick={colorStationA}>Color Station A</button>
      </div>
      <output data-testid="generic-stream-request-count">{requests.length}</output>
      <output data-testid="generic-stream-request-identity">{requestIdentity}</output>
      <output data-testid="generic-stream-last-request-json">{JSON.stringify(requests.at(-1) ?? null)}</output>
    </div>
  );
}