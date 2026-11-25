import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { PanelSplitter } from "@/components/layout";
import { useLayoutPreferencesStore, type LayoutPanelId } from "@/stores/useLayoutPreferencesStore";

import { inferFieldType } from "@/graphCore";
import type { AutoSpec, RefLineX, RefLineY } from "@/graphCore/types";
import { AxisSettingsDialog } from "@/components/graphBuilder/AxisSettingsDialog";
import { dataService } from "@/services/dataService";
import { graphNewService, type GraphNewOverlayGroup } from "@/services/graphNewService";
import { useGraphBuilderNewStore } from "@/stores/useGraphBuilderNewStore";
import { useProjectStore } from "@/stores/useProjectStore";
import type { ColumnDescriptor, ColumnDisplayProps, DatasetMeta } from "@/types/data";
import type { GraphNewXMode } from "@/types/graphBuilderNew";
import {
  GraphBuilderRailSection,
  GraphBuilderToolbarSection,
  GraphDropSlot,
  GraphFieldPalette,
  GraphInspectorSection,
  GraphPlaceholderButton,
  type GraphDropSlotBinding,
} from "@/components/graphBuilder/shared/GraphBuilderChrome";
import { GraphBuilderNewLayers } from "./GraphBuilderNewLayers";
import { GraphNewCanvas } from "./GraphNewCanvas";
import { GraphNewOverlayLegend } from "./GraphNewOverlayLegend";

import "../graphBuilder/graphBuilder.css";
import "./GraphBuilderNewView.css";

const unsubscribeSessionClose = useGraphBuilderNewStore.subscribe((state, previous) => {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
  for (const session of previous.sessions) {
    if (!state.sessions.some(({ transportId }) => transportId === session.transportId)) {
      void graphNewService.close(session.transportId).catch(() => {});
    }
  }
});
if (import.meta.hot) import.meta.hot.dispose(unsubscribeSessionClose);

// Stack ratios are percentages; measure the available height once when dragging starts.
function stackPointerScale(separator: HTMLElement) {
  return 100 / Math.max(1, (separator.parentElement?.parentElement?.clientHeight ?? 0) - 6);
}

function useRailSize(id: LayoutPanelId, defaultValue: number, min: number, max: number) {
  const preferred = useLayoutPreferencesStore((state) => state.sizes[id]);
  const persist = useLayoutPreferencesStore((state) => state.setPanelSize);
  const reset = useLayoutPreferencesStore((state) => state.resetPanelSize);
  const clamp = (value: number) => Math.max(min, Math.min(max, value));
  const [value, setValue] = useState(() => clamp(preferred ?? defaultValue));
  useEffect(() => { setValue(clamp(preferred ?? defaultValue)); }, [preferred, defaultValue, min, max]);
  return {
    value, min, max, defaultValue,
    onChange: (next: number) => setValue(clamp(next)),
    onCommit: (next: number) => { setValue(clamp(next)); persist(id, clamp(next)); },
    onReset: () => { setValue(defaultValue); reset(id); },
  };
}

function parseFiniteSpecNumber(raw: unknown): number | undefined {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : undefined;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return undefined;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function resolveAutoSpecForColumn(
  columnId: string | null,
  descriptors: ColumnDescriptor[],
  displayProps: ColumnDisplayProps[],
): AutoSpec | undefined {
  if (!columnId) return undefined;
  const colIndex = descriptors.findIndex((column) => column.columnId === columnId);
  if (colIndex < 0) return undefined;
  const prop = displayProps.find((candidate) => candidate.colIndex === colIndex);
  const extras = prop?.extras as Record<string, unknown> | undefined;
  const specExtra = extras?.spec as { lsl?: unknown; target?: unknown; usl?: unknown } | undefined;
  if (!specExtra) return undefined;
  const spec: AutoSpec = { colName: descriptors[colIndex].name };
  const lsl = parseFiniteSpecNumber(specExtra.lsl);
  const target = parseFiniteSpecNumber(specExtra.target);
  const usl = parseFiniteSpecNumber(specExtra.usl);
  if (lsl !== undefined) spec.lsl = lsl;
  if (target !== undefined) spec.target = target;
  if (usl !== undefined) spec.usl = usl;
  return spec.lsl !== undefined || spec.target !== undefined || spec.usl !== undefined ? spec : undefined;
}

interface GraphBuilderNewViewProps {
  sessionId: string;
  dataset: DatasetMeta | undefined;
}

export function GraphBuilderNewView({
  sessionId,
  dataset,
}: GraphBuilderNewViewProps) {
  const { t } = useTranslation();
  const leftRail = useRailSize("graphBuilderNew.leftRail", 270, 270, 500);
  const rightRail = useRailSize("graphBuilderNew.rightRail", 180, 160, 500);
  const leftStack = useRailSize("graphBuilderNew.leftStack", 58, 15, 85);
  const rightStack = useRailSize("graphBuilderNew.rightStack", 35, 15, 85);
  const session = useGraphBuilderNewStore((state) => (
    state.sessions.find((candidate) => candidate.id === sessionId)
  ));
  const setColumns = useGraphBuilderNewStore((state) => state.setColumns);
  const setOverlay = useGraphBuilderNewStore((state) => state.setOverlay);
  const setHiddenOverlayGroups = useGraphBuilderNewStore((state) => state.setHiddenOverlayGroups);
  const setCamera = useGraphBuilderNewStore((state) => state.setCamera);
  const setXAxisConfig = useGraphBuilderNewStore((state) => state.setXAxisConfig);
  const setYAxisConfig = useGraphBuilderNewStore((state) => state.setYAxisConfig);
  const setRefLinesX = useGraphBuilderNewStore((state) => state.setRefLinesX);
  const setRefLinesY = useGraphBuilderNewStore((state) => state.setRefLinesY);
  const setAutoSpecLinesX = useGraphBuilderNewStore((state) => state.setAutoSpecLinesX);
  const setAutoSpecLinesY = useGraphBuilderNewStore((state) => state.setAutoSpecLinesY);
  const readOnly = useProjectStore((state) => state.readOnly);
  const [openAxisDialog, setOpenAxisDialog] = useState<"x" | "y" | null>(null);
  const [columnMetadata, setColumnMetadata] = useState<{
    dataset: DatasetMeta;
    sessionId: string;
    transportId: string;
    runtimeEpoch: number | undefined;
    descriptors: ColumnDescriptor[];
    displayProps: ColumnDisplayProps[];
  } | null>(null);
  const [pointRadius, setPointRadius] = useState(1);
  const [toolbarHost, setToolbarHost] = useState<HTMLDivElement | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [overlayState, setOverlayState] = useState<{
    active: boolean;
    groups: GraphNewOverlayGroup[];
  }>({ active: false, groups: [] });
  const datasetId = session?.datasetId;
  const datasetGeneration = session?.datasetGeneration;
  const runtimeEpoch = session?.runtimeEpoch;
  const transportId = session?.transportId;
  const missingDataset = Boolean(session && !dataset);
  const stale = Boolean(
    session
      && dataset
      && (dataset.id !== datasetId || dataset.generation !== datasetGeneration),
  );
  const columns = !missingDataset && !stale
    && columnMetadata?.dataset === dataset && columnMetadata?.sessionId === sessionId && columnMetadata?.transportId === transportId && columnMetadata?.runtimeEpoch === runtimeEpoch
    ? columnMetadata.descriptors : [];
  const displayProps = !missingDataset && !stale
    && columnMetadata?.dataset === dataset && columnMetadata?.sessionId === sessionId && columnMetadata?.transportId === transportId && columnMetadata?.runtimeEpoch === runtimeEpoch
    ? columnMetadata.displayProps : [];
  const resolvedAutoSpecX = resolveAutoSpecForColumn(session?.xColumnId ?? null, columns, displayProps);
  const resolvedAutoSpecY = resolveAutoSpecForColumn(session?.yColumnId ?? null, columns, displayProps);
  const numericColumns = columns.filter(({ sqlType }) => inferFieldType(sqlType) === "continuous");
  const numericColumnIds = new Set(numericColumns.map(({ columnId }) => columnId));
  const xColumn = columns.find(({ columnId }) => columnId === session?.xColumnId);
  const sqlType = xColumn?.sqlType.trim().toUpperCase();
  const xMode: GraphNewXMode = !sqlType ? "auto"
    : /^(?:DATE$|TIMESTAMP)/.test(sqlType) ? "time"
    : /^(?:U?(?:TINYINT|SMALLINT|INTEGER|BIGINT)|HUGEINT|DOUBLE|REAL|FLOAT|DECIMAL(?:\(.*\))?)$/.test(sqlType) ? "numeric"
    : "category";
  const legacyModeConflict = Boolean(xColumn && session?.xMode && session.xMode !== "auto" && session.xMode !== xMode);
  const xColumnIds = new Set(columns.map(({ columnId }) => columnId));
  const overlayColumnIds = new Set(columns.map(({ columnId }) => columnId));
  const missingX = Boolean(session?.xColumnId && !xColumnIds.has(session.xColumnId));
  const missingY = Boolean(session?.yColumnId && !xColumnIds.has(session.yColumnId));
  const unsupportedY = Boolean(session?.yColumnId && xColumnIds.has(session.yColumnId)
    && !numericColumnIds.has(session.yColumnId));
  const missingOverlay = Boolean(session?.overlayColumnId && !overlayColumnIds.has(session.overlayColumnId));

  useEffect(() => {
    setOverlayState({ active: false, groups: [] });
  }, [runtimeEpoch, session?.overlayColumnId, session?.xColumnId, session?.yColumnId, transportId]);

  useEffect(() => {
    if (transportId && (missingDataset || stale) && typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
      void graphNewService.close(transportId).catch(() => {});
    }
  }, [missingDataset, stale, transportId]);

  useEffect(() => {
    let cancelled = false;
    setColumnMetadata(null);
    setError(null);

    if (!datasetId || !dataset || !transportId || missingDataset || stale) {
      setLoading(false);
      return () => {
        cancelled = true;
      };
    }

    setLoading(true);
    void Promise.all([
      dataService.getColumnDescriptors(datasetId),
      dataService.getColumnDisplayProps(datasetId).catch(() => [] as ColumnDisplayProps[]),
    ])
      .then(([descriptors, nextDisplayProps]) => {
        if (!cancelled) {
          setColumnMetadata({ dataset, sessionId, transportId, runtimeEpoch, descriptors, displayProps: nextDisplayProps });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setError("Numeric fields could not be loaded.");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [dataset, datasetId, datasetGeneration, missingDataset, sessionId, transportId, runtimeEpoch, stale]);

  useEffect(() => {
    if (readOnly && openAxisDialog !== null) setOpenAxisDialog(null);
  }, [readOnly, openAxisDialog]);

  useEffect(() => {
    if (openAxisDialog === null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenAxisDialog(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [openAxisDialog]);

  if (!session) {
    return (
      <main className="graph-builder-new graph-builder-new-state">
        <p>This Graph Builder-new session is closed.</p>
      </main>
    );
  }

  const transportAvailable = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  const updateX = (xColumnId: string) => {
    if (useProjectStore.getState().readOnly) return;
    if (xColumnId && !xColumnIds.has(xColumnId)) return;
    setColumns(session.id, xColumnId || null, session.yColumnId);
  };
  const updateY = (yColumnId: string) => {
    if (useProjectStore.getState().readOnly || (yColumnId && !numericColumnIds.has(yColumnId))) return;
    setColumns(session.id, session.xColumnId, yColumnId || null);
  };
  const updateOverlay = (overlayColumnId: string) => {
    if (useProjectStore.getState().readOnly || (overlayColumnId && !overlayColumnIds.has(overlayColumnId))) return;
    setOverlay(session.id, overlayColumnId || null);
  };

  const controlsDisabled = readOnly || loading || stale || missingDataset || Boolean(error)
    || columns.length === 0;
  const paletteItems = columns.map((column) => ({
    columnId: column.columnId,
    name: column.name,
    sqlType: column.sqlType,
    typeLabel: t(`dataTable.type.${column.sqlType}`, { defaultValue: column.sqlType }),
  }));
  const bindingFor = (columnId: string | null): GraphDropSlotBinding | null => {
    if (!columnId) return null;
    const column = columns.find((candidate) => candidate.columnId === columnId);
    return {
      columnId,
      label: column?.name ?? columnId,
      unavailable: !column,
    };
  };
  const unavailableTitle = (feature: string) => t("graphNewUi.unavailable", { feature });
  const dropText = t("graphNewUi.dropColumn");
  const clearFieldLabel = (field: string) => t("graphNewUi.clearField", { field });

  return (
    <main className="graph-builder-new gb-root">
      <GraphBuilderToolbarSection className="gb-toolbar graph-builder-new-toolbar">
        <div className="gb-toolbar-left">
          <GraphPlaceholderButton label={t("graphNewUi.startOver")} unavailableTitle={t("graphNewUi.unavailable", { feature: t("graphNewUi.startOver") })} className="gb-tb-btn" />
          <GraphPlaceholderButton label={t("graphNewUi.swapXY")} unavailableTitle={t("graphNewUi.unavailable", { feature: t("graphNewUi.swapXY") })} className="gb-tb-btn" />
          <span className="graph-builder-new-tool-divider" />
          <GraphPlaceholderButton label={t("graphNewUi.pointer")} unavailableTitle={t("graphNewUi.unavailable", { feature: t("graphNewUi.pointer") })} className="gb-tb-btn" />
          <GraphPlaceholderButton label={t("graphNewUi.grabber")} unavailableTitle={t("graphNewUi.unavailable", { feature: t("graphNewUi.grabber") })} className="gb-tb-btn" />
          <GraphPlaceholderButton label={t("graphNewUi.filter")} unavailableTitle={t("graphNewUi.unavailable", { feature: t("graphNewUi.filter") })} className="gb-tb-btn" />
          <GraphPlaceholderButton label="3D" unavailableTitle={t("graphNewUi.unavailable", { feature: "3D" })} className="gb-tb-btn" />
          <GraphPlaceholderButton label={t("graphNewUi.multivariate")} unavailableTitle={t("graphNewUi.unavailable", { feature: t("graphNewUi.multivariate") })} className="gb-tb-btn" />
          <GraphPlaceholderButton label={t("graphNewUi.sample")} unavailableTitle={t("graphNewUi.unavailable", { feature: t("graphNewUi.sample") })} className="gb-tb-btn" />
        </div>
        <div className="gb-toolbar-spacer" />
        <div ref={setToolbarHost} className="graph-builder-new-toolbar-status" title={dataset?.name ?? t("graphNew.sourceUnavailable")} />
      </GraphBuilderToolbarSection>

      <div className="gb-body graph-builder-new-body" style={{ "--graph-new-left-width": `${leftRail.value}px`, gridTemplateColumns: `${leftRail.value}px 6px minmax(0, 1fr) 6px ${rightRail.value}px` } as React.CSSProperties}>
        <aside className="gb-left graph-builder-new-left" aria-label={t("graphNewUi.columns")} style={{ gridTemplateRows: `minmax(0, ${leftStack.value}fr) 6px minmax(0, ${100 - leftStack.value}fr)` }}>
          <GraphBuilderRailSection title={t("graphNewUi.columns")} className="graph-builder-new-columns">
            <GraphFieldPalette
              items={paletteItems}
              disabled={controlsDisabled}
              ariaLabel={t("graphNewUi.columns")}
              getItemAriaLabel={(item) => t("graphNewUi.dragField", { field: item.name })}
            />
          </GraphBuilderRailSection>
          <div className="graph-builder-new-splitter graph-builder-new-splitter-horizontal">
            <PanelSplitter {...leftStack} orientation="horizontal" unit="%" pointerScale={stackPointerScale} label="Resize new graph columns and layers" />
          </div>
          <GraphBuilderRailSection title={t("graphNewUi.layers")} className="graph-builder-new-layers">
            <GraphBuilderNewLayers pointRadius={pointRadius} onPointRadiusChange={setPointRadius} documentId={session.id} layers={session.layers} disabled={controlsDisabled} />
          </GraphBuilderRailSection>
        </aside>

        <div className="graph-builder-new-splitter graph-builder-new-splitter-vertical">
          <PanelSplitter {...leftRail} orientation="vertical" unit="px" label="Resize new graph left rail" />
        </div>
        <section className="graph-builder-new-workspace">
          <GraphDropSlot
            slot="y"
            label="Y"
            binding={bindingFor(session.yColumnId)}
            disabled={controlsDisabled}
            required
            orientation="vertical-left"
            dropText={dropText}
            clearAriaLabel={clearFieldLabel("Y")}
            onDropFields={(fields) => updateY(fields[0]?.columnId ?? "")}
            onClear={() => updateY("")}
          />
          <GraphDropSlot
            slot="group-x"
            label={t("graphNewUi.groupX")}
            disabled
            orientation="horizontal-top"
            unavailableTitle={unavailableTitle(t("graphNewUi.groupX"))}
            dropText={dropText}
          />
          <section className="graph-builder-new-stage" aria-label="Point plot">
          {missingDataset ? (
            <p role="status">{t("graphNew.sourceUnavailable")}</p>
          ) : stale ? (
            <p role="status">{t("graphNew.sourceChanged")}</p>
          ) : loading ? (
            <p role="status">Loading numeric fields...</p>
          ) : error ? (
            <p role="alert">{error}</p>
          ) : missingX || missingY || missingOverlay ? (
            <p role="status">{t("graphNew.fieldsUnavailable", {
              fields: [
                missingX ? session.xColumnId : null,
                missingY ? session.yColumnId : null,
                missingOverlay ? session.overlayColumnId : null,
              ].filter(Boolean).join(", "),
            })}
            </p>
          ) : unsupportedY ? (
            <p role="status">{t("graphNewUi.unsupportedCombination")}</p>
          ) : numericColumns.length === 0 ? (
            <p role="status">This table has no numeric columns.</p>
          ) : session.layers.length === 0 && session.xColumnId && session.yColumnId ? (
            <p role="status">{t("graphNewUi.addLayerHint")}</p>
          ) : transportAvailable && session.xColumnId && session.yColumnId
            && xColumnIds.has(session.xColumnId) && numericColumnIds.has(session.yColumnId) ? (
            <GraphNewCanvas
              key={JSON.stringify([session.transportId, runtimeEpoch, datasetId, datasetGeneration, session.xColumnId, session.yColumnId, session.overlayColumnId, xMode])}
              controlsHost={toolbarHost}
              transportId={session.transportId}
              datasetId={session.datasetId}
              datasetGeneration={session.datasetGeneration}
              xColumnId={session.xColumnId}
              yColumnId={session.yColumnId}
              overlayColumnId={session.overlayColumnId ?? null}
              hiddenOverlayGroupIds={session.hiddenOverlayGroupIds}
              layers={session.layers}
              showMean={false}
              pointRadius={pointRadius}
              xMode={xMode}
              rawMode="scatter"
              savedCamera={legacyModeConflict ? null : session.camera ?? null}
              readOnly={readOnly}
              xAxisConfig={session.xAxisConfig}
              yAxisConfig={session.yAxisConfig}
              refLinesX={session.refLinesX}
              refLinesY={session.refLinesY}
              autoSpecLinesX={session.autoSpecLinesX}
              autoSpecLinesY={session.autoSpecLinesY}
              resolvedAutoSpecX={resolvedAutoSpecX}
              resolvedAutoSpecY={resolvedAutoSpecY}
              onXAxisDblClick={readOnly ? undefined : () => setOpenAxisDialog("x")}
              onYAxisDblClick={readOnly ? undefined : () => setOpenAxisDialog("y")}
              onOverlayStateChange={setOverlayState}
              onCameraChange={(camera) => {
                const current = useGraphBuilderNewStore.getState().sessions.find(({ id }) => id === session.id);
                if (!useProjectStore.getState().readOnly && current?.datasetGeneration === session.datasetGeneration
                  && current.transportId === session.transportId
                  && current.runtimeEpoch === session.runtimeEpoch
                  && current.datasetId === session.datasetId && current.xColumnId === session.xColumnId
                  && current.yColumnId === session.yColumnId
                  && current.overlayColumnId === session.overlayColumnId) setCamera(session.id, camera);
              }}
            />
          ) : (
            <div className="gb-empty" role="status">{t("graph.dragHint")}</div>
          )}
          </section>
          <GraphDropSlot
            slot="x"
            label="X"
            binding={bindingFor(session.xColumnId)}
            disabled={controlsDisabled}
            required
            orientation="horizontal-bottom"
            dropText={dropText}
            clearAriaLabel={clearFieldLabel("X")}
            onDropFields={(fields) => updateX(fields[0]?.columnId ?? "")}
            onClear={() => updateX("")}
          />
          <GraphDropSlot
            slot="group-y"
            label={t("graphNewUi.groupY")}
            disabled
            orientation="vertical-right"
            unavailableTitle={unavailableTitle(t("graphNewUi.groupY"))}
            dropText={dropText}
          />
        </section>

        <div className="graph-builder-new-splitter graph-builder-new-splitter-vertical">
          <PanelSplitter {...rightRail} orientation="vertical" direction={-1} unit="px" label="Resize new graph right rail" />
        </div>
        <aside className="graph-builder-new-inspector" aria-label="Graph options" style={{ gridTemplateRows: `minmax(0, ${rightStack.value}fr) 6px minmax(0, ${100 - rightStack.value}fr)` }}>
          <GraphInspectorSection title={t("graphNewUi.legend")}>
            <div className="graph-builder-new-legend">
              <GraphDropSlot
                slot="overlay"
                label={t("graphNewUi.overlay")}
                binding={bindingFor(session.overlayColumnId ?? null)}
                disabled={controlsDisabled}
                orientation="shelf"
                dropText={dropText}
                clearAriaLabel={clearFieldLabel(t("graphNewUi.overlay"))}
                onDropFields={(fields) => updateOverlay(fields[0]?.columnId ?? "")}
                onClear={() => updateOverlay("")}
              />
              {overlayState.active && (
                <GraphNewOverlayLegend
                  groups={overlayState.groups}
                  hiddenIds={session.hiddenOverlayGroupIds}
                  readOnly={readOnly}
                  onHiddenIdsChange={(ids) => setHiddenOverlayGroups(session.id, ids)}
                />
              )}
            </div>
          </GraphInspectorSection>
          <div className="graph-builder-new-splitter graph-builder-new-splitter-horizontal">
            <PanelSplitter {...rightStack} orientation="horizontal" unit="%" pointerScale={stackPointerScale} label="Resize new graph legend and style" />
          </div>
          <GraphInspectorSection title={t("graphNewUi.style")}>
            <GraphPlaceholderButton label={t("graphNewUi.styleOptions")} unavailableTitle={t("graphNewUi.unavailable", { feature: t("graphNewUi.styleOptions") })} />
            <GraphPlaceholderButton label={t("graphNewUi.groupByX")} unavailableTitle={t("graphNewUi.unavailable", { feature: t("graphNewUi.groupByX") })} />
            <GraphPlaceholderButton label={t("graphNewUi.groupByY")} unavailableTitle={t("graphNewUi.unavailable", { feature: t("graphNewUi.groupByY") })} />
            <button
              type="button"
              className="graph-builder-new-axis-btn"
              data-testid="open-x-axis-settings"
              disabled={controlsDisabled || !session.xColumnId || !session.yColumnId}
              onClick={() => setOpenAxisDialog("x")}
            >
              {t("graph.xAxisSettings.title", { defaultValue: "X Axis Settings" })}
            </button>
            <button
              type="button"
              className="graph-builder-new-axis-btn"
              data-testid="open-y-axis-settings"
              disabled={controlsDisabled || !session.xColumnId || !session.yColumnId}
              onClick={() => setOpenAxisDialog("y")}
            >
              {t("graph.yAxisSettings.title", { defaultValue: "Y Axis Settings" })}
            </button>
          </GraphInspectorSection>
        </aside>

        <div className="graph-builder-new-compat-controls" aria-hidden="true" inert>
          <label>
            <span>X field</span>
            <select data-testid="legacy-x-field" tabIndex={-1} value={session.xColumnId ?? ""} disabled={controlsDisabled}
              onChange={(event) => updateX(event.target.value)}>
              <option value="">Select a field</option>
              {!loading && !stale && !missingDataset && missingX && <option value={session.xColumnId!} disabled>{t("graphNew.fieldUnavailable", { field: session.xColumnId })}</option>}
              {columns.map((column) => {
                const eligible = numericColumnIds.has(column.columnId);
                const type = /CHAR|TEXT|STRING/i.test(column.sqlType)
                  ? t("graphNew.textFieldType")
                  : /TIMESTAMP/i.test(column.sqlType) ? t("graphNew.timestampFieldType") : column.sqlType;
                return (
                  <option key={column.columnId} value={column.columnId}>
                    {eligible ? column.name : `${column.name} (${type})`}
                  </option>
                );
              })}
            </select>
          </label>
          <label>
            <span>Y field</span>
            <select aria-label="Y field" data-testid="legacy-y-field" tabIndex={-1} value={session.yColumnId ?? ""} disabled={controlsDisabled || numericColumns.length === 0}
              onChange={(event) => updateY(event.target.value)}>
              <option value="">Select a field</option>
              {!loading && !stale && !missingDataset && missingY && <option value={session.yColumnId!} disabled>{t("graphNew.fieldUnavailable", { field: session.yColumnId })}</option>}
              {numericColumns.map((column) => <option key={column.columnId} value={column.columnId}>{column.name}</option>)}
            </select>
          </label>
          <label>
            <span>{t("graphNew.overlayField")}</span>
            <select data-testid="legacy-overlay-field" tabIndex={-1} value={session.overlayColumnId ?? ""}
              disabled={controlsDisabled} onChange={(event) => updateOverlay(event.target.value)}>
              <option value="">{t("graphNew.noOverlay")}</option>
              {!loading && !stale && !missingDataset && missingOverlay && <option value={session.overlayColumnId!} disabled>{t("graphNew.fieldUnavailable", { field: session.overlayColumnId })}</option>}
              {columns.map((column) => <option key={column.columnId} value={column.columnId}>{column.name}</option>)}
            </select>
          </label>

        </div>
      </div>

      {legacyModeConflict && <p className="graph-builder-new-source-notice" role="status">
        {t("graphNew.legacyColumnType", { column: xColumn?.name, defaultValue: "X now uses the source column type for {{column}}. To change its interpretation, edit the column in the source table." })}
      </p>}
      <footer className="graph-builder-new-status">
        <span className={transportAvailable ? "available" : "unavailable"} aria-hidden="true" />
        {transportAvailable
          ? "Tauri host detected; native point renderer"
          : "Tauri host not detected; raw-frame transport unavailable"}
      </footer>
      {!readOnly && openAxisDialog === "y" && (
        <AxisSettingsDialog
          axis="y"
          refLines={session.refLinesY ?? []}
          setRefLines={(next: RefLineY[]) => setRefLinesY(session.id, next)}
          autoSpecLines={!!session.autoSpecLinesY}
          setAutoSpecLines={(next) => setAutoSpecLinesY(session.id, next)}
          resolvedAutoSpec={resolvedAutoSpecY}
          autoSpecColName={columns.find((c) => c.columnId === session.yColumnId)?.name}
          axisConfig={session.yAxisConfig}
          setAxisConfig={(next) => setYAxisConfig(session.id, next)}
          onClose={() => setOpenAxisDialog(null)}
        />
      )}
      {!readOnly && openAxisDialog === "x" && (
        <AxisSettingsDialog
          axis="x"
          refLines={session.refLinesX ?? []}
          setRefLines={(next: RefLineX[]) => setRefLinesX(session.id, next)}
          autoSpecLines={!!session.autoSpecLinesX}
          setAutoSpecLines={(next) => setAutoSpecLinesX(session.id, next)}
          resolvedAutoSpec={resolvedAutoSpecX}
          autoSpecColName={columns.find((c) => c.columnId === session.xColumnId)?.name}
          axisConfig={session.xAxisConfig}
          setAxisConfig={(next) => setXAxisConfig(session.id, next)}
          onClose={() => setOpenAxisDialog(null)}
        />
      )}
    </main>
  );
}
