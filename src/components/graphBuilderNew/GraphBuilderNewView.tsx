import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { PanelSplitter } from "@/components/layout";
import { useLayoutPreferencesStore, type LayoutPanelId } from "@/stores/useLayoutPreferencesStore";

import { inferFieldType } from "@/graphCore";
import { dataService } from "@/services/dataService";
import { graphNewService, type GraphNewOverlayGroup } from "@/services/graphNewService";
import { useGraphBuilderNewStore } from "@/stores/useGraphBuilderNewStore";
import { useProjectStore } from "@/stores/useProjectStore";
import type { ColumnDescriptor, DatasetMeta } from "@/types/data";
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
  const setXMode = useGraphBuilderNewStore((state) => state.setXMode);
  const setCamera = useGraphBuilderNewStore((state) => state.setCamera);
  const readOnly = useProjectStore((state) => state.readOnly);
  const [columnMetadata, setColumnMetadata] = useState<{
    dataset: DatasetMeta;
    sessionId: string;
    transportId: string;
    runtimeEpoch: number | undefined;
    descriptors: ColumnDescriptor[];
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
  const numericColumns = columns.filter(({ sqlType }) => inferFieldType(sqlType) === "continuous");
  const numericColumnIds = new Set(numericColumns.map(({ columnId }) => columnId));
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
    void dataService.getColumnDescriptors(datasetId)
      .then((descriptors) => {
        if (!cancelled) {
          setColumnMetadata({ dataset, sessionId, transportId, runtimeEpoch, descriptors });
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
              key={JSON.stringify([session.transportId, runtimeEpoch, datasetId, datasetGeneration, session.xColumnId, session.yColumnId, session.overlayColumnId, session.xMode ?? "auto"])}
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
              xMode={session.xMode ?? "auto"}
              rawMode="scatter"
              savedCamera={session.camera ?? null}
              readOnly={readOnly}
              onOverlayStateChange={setOverlayState}
              onCameraChange={(camera) => {
                const current = useGraphBuilderNewStore.getState().sessions.find(({ id }) => id === session.id);
                if (!useProjectStore.getState().readOnly && current?.datasetGeneration === session.datasetGeneration
                  && current.transportId === session.transportId
                  && current.runtimeEpoch === session.runtimeEpoch
                  && current.datasetId === session.datasetId && current.xColumnId === session.xColumnId
                  && current.yColumnId === session.yColumnId
                  && current.overlayColumnId === session.overlayColumnId
                  && current.xMode === session.xMode) setCamera(session.id, camera);
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
            settings={(
              <label className="graph-builder-new-axis-setting">
                <span>{t("graphNew.xInterpretation")}</span>
                <select
                  aria-label="X axis interpretation"
                  value={session.xMode ?? "auto"}
                  disabled={controlsDisabled}
                  onChange={(event) => setXMode(session.id, event.target.value as GraphNewXMode)}
                >
                  {(["auto", "numeric", "time", "duration", "category"] as const).map((mode) => (
                    <option key={mode} value={mode}>
                      {t(`graphNew.xMode.${mode}`, { defaultValue: mode })}
                    </option>
                  ))}
                </select>
              </label>
            )}
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
            <GraphPlaceholderButton label={t("graphNewUi.axisSettings")} unavailableTitle={t("graphNewUi.unavailable", { feature: t("graphNewUi.axisSettings") })} />
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
          <label>
            <span>{t("graphNew.xInterpretation", { defaultValue: "X interpretation" })}</span>
            <select data-testid="legacy-x-interpretation" tabIndex={-1} value={session.xMode ?? "auto"}
              disabled={controlsDisabled}
              onChange={(event) => setXMode(session.id, event.target.value as GraphNewXMode)}>
              {(["auto", "numeric", "time", "duration", "category"] as const).map((mode) =>
                <option key={mode} value={mode}>{t(`graphNew.xMode.${mode}`, { defaultValue: mode })}</option>)}
            </select>
          </label>

        </div>
      </div>

      <footer className="graph-builder-new-status">
        <span className={transportAvailable ? "available" : "unavailable"} aria-hidden="true" />
        {transportAvailable
          ? "Tauri host detected; native point renderer"
          : "Tauri host not detected; raw-frame transport unavailable"}
      </footer>
    </main>
  );
}
