import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Graph, inferFieldType, type FieldRef, type ScatterPointPick } from "@/graphCore";
import { dataService } from "@/services/dataService";
import { useGraphPaletteStore } from "@/stores/useGraphPaletteStore";
import type { ColumnMeta, DatasetMeta } from "@/types/data";
import type { GraphDataFrame } from "@/types/graphData";
import type { GraphBuilderItem } from "@/types/graphBuilder";

import { reconcileGraphColumnIdentities, type GraphColumnDescriptor } from "./graphColumnIdentity";
import { getRawPointNotice } from "./graphSamplingPolicy";
import {
  buildEffectiveStyles,
  buildGraphRuntimeModel,
  createGraphRuntimeData,
  deriveGraphGroupKeys,
  deriveValueOrders,
  type GraphRuntimeMetadata,
} from "./graphRuntimeModel";
import { resolveStableGroupKeys } from "./graphGroupOrder";
import { resolveGroupThemeFieldName } from "./graphThemeIdentity";
import {
  selectGraphRuntimeDataState,
  useGraphDataPipeline,
  type ExternalGraphDataState,
  type GraphDataPipelineResult,
  type GraphLoadProgress,
} from "./useGraphDataPipeline";

export type { ExternalGraphDataState } from "./useGraphDataPipeline";

export interface GraphRuntimeProps {
  item: GraphBuilderItem;
  dataset: DatasetMeta;
  externalDataState?: ExternalGraphDataState;
  showPointBudgetAction?: boolean;
  onRequestSampleMode?: () => void;
  onPointPick?: (pick: ScatterPointPick) => void;
  brushMode?: boolean;
  onBrushSelect?: (picks: ScatterPointPick[]) => void;
  onYAxisDblClick?: () => void;
  onXAxisDblClick?: () => void;
  onAxisRangeChange?: (axis: "x" | "y", min: number, max: number) => void;
  onAxisContextMenu?: (axis: "x" | "y", x: number, y: number) => void;
  onItemReconciled?: (item: GraphBuilderItem) => void;
  onStateChange?: (state: GraphRuntimeState) => void;
}

export interface GraphRuntimeState {
  columns: FieldRef[];
  colSqlTypes: string[];
  graphData: ReturnType<typeof createGraphRuntimeData>;
  spec: ReturnType<typeof buildGraphRuntimeModel>["spec"];
  frame: GraphDataFrame | null;
  status: GraphDataPipelineResult["status"];
  error: string | null;
  progress: GraphLoadProgress | null;
  metaLoading: boolean;
  metaError: string | null;
  valueOrders: Record<string, string[]>;
  rawPointNotice: { validRows: number; budget: number } | null;
}

const EMPTY_METADATA: GraphRuntimeMetadata = {
  columns: [],
  displayProps: [],
};

function toColumnRole(sqlType: string): ColumnMeta["role"] {
  return inferFieldType(sqlType) === "continuous" ? "continuous" : "nominal";
}

function snapshotChanged(previous: GraphRuntimeState | null, next: GraphRuntimeState): boolean {
  if (!previous) return true;
  return previous.columns !== next.columns
    || previous.colSqlTypes !== next.colSqlTypes
    || previous.graphData !== next.graphData
    || previous.spec !== next.spec
    || previous.frame !== next.frame
    || previous.status !== next.status
    || previous.error !== next.error
    || previous.progress !== next.progress
    || previous.metaLoading !== next.metaLoading
    || previous.metaError !== next.metaError
    || previous.valueOrders !== next.valueOrders
    || previous.rawPointNotice !== next.rawPointNotice;
}

export function GraphRuntime({
  item,
  dataset,
  externalDataState,
  showPointBudgetAction = false,
  onRequestSampleMode,
  onPointPick,
  brushMode,
  onBrushSelect,
  onYAxisDblClick,
  onXAxisDblClick,
  onAxisRangeChange,
  onAxisContextMenu,
  onItemReconciled,
  onStateChange,
}: GraphRuntimeProps) {
  const { t } = useTranslation();
  const [metadata, setMetadata] = useState<GraphRuntimeMetadata>(EMPTY_METADATA);
  const [columnDescriptors, setColumnDescriptors] = useState<GraphColumnDescriptor[]>([]);
  const [descriptorGeneration, setDescriptorGeneration] = useState<number | null>(null);
  const [columns, setColumns] = useState<FieldRef[]>([]);
  const [colSqlTypes, setColSqlTypes] = useState<string[]>([]);
  const [metaLoading, setMetaLoading] = useState(true);
  const [metaError, setMetaError] = useState<string | null>(null);
  const [viewport, setViewport] = useState({ width: 1280, height: 720 });
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const snapshotRef = useRef<GraphRuntimeState | null>(null);
  const customPalettes = useGraphPaletteStore((state) => state.palettes);

  useEffect(() => {
    let cancelled = false;
    setMetaLoading(true);
    setMetaError(null);
    void (async () => {
      try {
        const descriptors = await dataService.getColumnDescriptors(dataset.id);
        let displayProps: GraphRuntimeMetadata["displayProps"] = [];
        try {
          displayProps = await dataService.getColumnDisplayProps(dataset.id);
        } catch {
          displayProps = [];
        }
        if (cancelled) return;
        setColumnDescriptors(descriptors);
        setDescriptorGeneration(dataset.generation);
        setColumns(descriptors.map(({ columnId, name, sqlType }) => ({ columnId, name, type: inferFieldType(sqlType) })));
        setColSqlTypes(descriptors.map(({ sqlType }) => sqlType));
        setMetadata({
          columns: descriptors.map(({ name: colName, sqlType: colType }, colIndex) => ({
            colIndex,
            colName,
            colType,
            role: toColumnRole(colType),
            missingCount: 0,
          })),
          displayProps,
        });
      } catch (error) {
        if (!cancelled) {
          setMetaError(String(error));
          setColumns([]);
          setColSqlTypes([]);
          setColumnDescriptors([]);
          setDescriptorGeneration(null);
          setMetadata(EMPTY_METADATA);
        }
      } finally {
        if (!cancelled) {
          setMetaLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [dataset.generation, dataset.id]);

  useLayoutEffect(() => {
    const host = canvasRef.current;
    if (!host) return;

    const commitSize = () => {
      const rect = host.getBoundingClientRect();
      const width = Math.max(1, Math.floor(rect.width));
      const height = Math.max(1, Math.floor(rect.height));
      setViewport((previous) => (
        previous.width === width && previous.height === height
          ? previous
          : { width, height }
      ));
    };

    commitSize();
    const observer = new ResizeObserver(commitSize);
    observer.observe(host);
    return () => {
      observer.disconnect();
    };
  }, []);

  const effectiveItem = useMemo(
    () => reconcileGraphColumnIdentities(item, columnDescriptors),
    [columnDescriptors, item],
  );

  useEffect(() => {
    if (effectiveItem !== item) onItemReconciled?.(effectiveItem);
  }, [effectiveItem, item, onItemReconciled]);

  const model = useMemo(
    () => buildGraphRuntimeModel(effectiveItem, metadata),
    [effectiveItem, metadata],
  );
  const graphData = useMemo(
    () => createGraphRuntimeData(metadata.columns, model.meltInfo),
    [metadata.columns, model.meltInfo],
  );
  const valueOrders = useMemo(
    () => deriveValueOrders(metadata, model.meltInfo),
    [metadata, model.meltInfo],
  );

  const internalDataState = useGraphDataPipeline(
    effectiveItem,
    dataset,
    viewport,
    !metaLoading
      && descriptorGeneration === dataset.generation
      && externalDataState === undefined,
  );
  const {
    frame,
    status,
    error,
    progress,
  } = selectGraphRuntimeDataState(internalDataState, externalDataState);
  const rawPointNotice = useMemo(
    () => getRawPointNotice(frame?.rawPointDisposition),
    [frame?.rawPointDisposition],
  );
  const groupingFieldName = resolveGroupThemeFieldName(model.effectiveEncoding);
  const groupKeys = useMemo(
    () => deriveGraphGroupKeys(
      model.effectiveEncoding.overlay ?? model.effectiveEncoding.color,
      frame,
    ),
    [frame, model.effectiveEncoding.color, model.effectiveEncoding.overlay],
  );
  const slotCandidateKeys = useMemo(
    () => resolveStableGroupKeys(
      groupKeys,
      frame?.dictionaries.group ?? [],
      undefined,
    ),
    [frame?.dictionaries.group, groupKeys],
  );
  const effectiveStyles = useMemo(
    () => buildEffectiveStyles(
      groupKeys,
      effectiveItem.groupThemeSlots,
      groupingFieldName,
      model.spec.styles ?? {},
      customPalettes,
      model.spec.elements.some((element) => element.kind === "boxplot" && element.enabled !== false),
      slotCandidateKeys,
    ),
    [customPalettes, effectiveItem.groupThemeSlots, groupKeys, groupingFieldName, model.spec.elements, model.spec.styles, slotCandidateKeys],
  );
  const runtimeSpec = useMemo(
    () => ({ ...model.spec, datasetName: dataset.name, styles: effectiveStyles }),
    [dataset.name, effectiveStyles, model.spec],
  );

  const correlationColumnCount = useMemo(() => {
    if (effectiveItem.mode === "multivariate") {
      return effectiveItem.modeStates.multivariate.columns.length;
    }
    const twoDMultiX = effectiveItem.modeStates.twoD.multiX ?? [];
    const twoDMultiY = effectiveItem.modeStates.twoD.multiY ?? [];
    if (twoDMultiX.length > 0) return twoDMultiX.length;
    if (twoDMultiY.length > 0) return twoDMultiY.length;
    if (effectiveItem.modeStates.twoD.encoding.x || effectiveItem.modeStates.twoD.encoding.y) return 1;
    return 0;
  }, [effectiveItem]);
  const correlationColumnsReady = correlationColumnCount >= 2 && correlationColumnCount <= 20;
  const activeKinds = useMemo(
    () => new Set(runtimeSpec.elements.filter((element) => element.enabled !== false).map((element) => element.kind)),
    [runtimeSpec.elements],
  );

  const runtimeState = useMemo<GraphRuntimeState>(() => ({
    columns,
    colSqlTypes,
    graphData,
    spec: runtimeSpec,
    frame,
    status,
    error,
    progress,
    metaLoading,
    metaError,
    valueOrders,
    rawPointNotice,
  }), [colSqlTypes, columns, error, frame, graphData, metaError, metaLoading, progress, rawPointNotice, runtimeSpec, status, valueOrders]);

  useEffect(() => {
    if (!onStateChange) return;
    if (!snapshotChanged(snapshotRef.current, runtimeState)) return;
    snapshotRef.current = runtimeState;
    onStateChange(runtimeState);
  }, [onStateChange, runtimeState]);

  const emptyAxes = effectiveItem.mode !== "multivariate"
    && !effectiveItem.modeStates.threeD.encoding.x
    && !effectiveItem.modeStates.threeD.encoding.y
    && !effectiveItem.modeStates.twoD.encoding.x
    && !effectiveItem.modeStates.twoD.encoding.y
    && (effectiveItem.modeStates.twoD.multiX?.length ?? 0) === 0
    && (effectiveItem.modeStates.twoD.multiY?.length ?? 0) === 0
    && !activeKinds.has("histogram");
  const axesTransposed = effectiveItem.mode === "2d" && effectiveItem.modeStates.twoD.transposed === true;
  const screenAxis = (axis: "x" | "y"): "x" | "y" => (
    axesTransposed ? (axis === "x" ? "y" : "x") : axis
  );

  return (
    <div ref={canvasRef} style={{ width: "100%", height: "100%", position: "relative" }}>
      {effectiveItem.mode === "multivariate" && !correlationColumnsReady ? (
        <div className="gb-empty">
          {t("graph.correlation.requiresColumns", {
            min: 2,
            max: 20,
            defaultValue: "Correlation matrix requires {{min}}-{{max}} columns.",
          })}
        </div>
      ) : emptyAxes ? (
        <div className="gb-empty">{t("graph.dragHint")}</div>
      ) : (
        <>
          <Graph
            spec={runtimeSpec}
            data={graphData}
            frame={frame}
            valueOrders={valueOrders}
            onYAxisDblClick={effectiveItem.mode === "multivariate" ? undefined : (axesTransposed ? onXAxisDblClick : onYAxisDblClick)}
            onXAxisDblClick={effectiveItem.mode === "multivariate" ? undefined : (axesTransposed ? onYAxisDblClick : onXAxisDblClick)}
            onAxisRangeChange={effectiveItem.mode === "multivariate" || !onAxisRangeChange
              ? undefined
              : (axis, min, max) => onAxisRangeChange(screenAxis(axis), min, max)}
            onAxisContextMenu={effectiveItem.mode === "multivariate" || !onAxisContextMenu
              ? undefined
              : (axis, x, y) => onAxisContextMenu(screenAxis(axis), x, y)}
            onPointClick={effectiveItem.mode === "multivariate" ? undefined : onPointPick}
            brushMode={effectiveItem.mode !== "multivariate" && !!brushMode}
            onBrushSelect={effectiveItem.mode === "multivariate" ? undefined : onBrushSelect}
          />
          {status === "error" && error && (
            <div className="gb-canvas-overlay gb-canvas-overlay-error">{error}</div>
          )}
          {effectiveItem.mode !== "multivariate" && status === "ready" && rawPointNotice && (
            <div className="gb-point-budget-notice" role="status">
              <i className="fa-solid fa-circle-info" aria-hidden="true" />
              <span className="gb-point-budget-copy">
                <strong>{t("graph.sampling.pointsOmitted", {
                  defaultValue: "Raw points were omitted",
                })}</strong>
                <span>{t("graph.sampling.pointBudgetCount", {
                  valid: rawPointNotice.validRows.toLocaleString(),
                  budget: rawPointNotice.budget.toLocaleString(),
                  defaultValue: "{{valid}} valid rows; point budget {{budget}}",
                })}</span>
              </span>
              {showPointBudgetAction && onRequestSampleMode && (
                <button
                  type="button"
                  className="gb-point-budget-action"
                  onClick={onRequestSampleMode}
                >
                  <i className="fa-solid fa-shuffle" aria-hidden="true" />
                  {t("graph.sampling.switchToSample", { defaultValue: "Switch to Sample" })}
                </button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}