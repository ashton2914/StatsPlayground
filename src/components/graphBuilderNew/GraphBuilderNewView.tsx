import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { inferFieldType } from "@/graphCore";
import { dataService } from "@/services/dataService";
import { graphNewService, type GraphNewOverlayGroup } from "@/services/graphNewService";
import { useGraphBuilderNewStore } from "@/stores/useGraphBuilderNewStore";
import { useProjectStore } from "@/stores/useProjectStore";
import type { ColumnDescriptor, DatasetMeta } from "@/types/data";
import type { GraphNewRawMode, GraphNewXMode } from "@/types/graphBuilderNew";
import {
  GraphBuilderRailSection,
  GraphBuilderToolbarSection,
  GraphDropSlot,
  GraphFieldPalette,
  GraphInspectorSection,
  GraphLayerCard,
  GraphPlaceholderButton,
  type GraphDropSlotBinding,
} from "@/components/graphBuilder/shared/GraphBuilderChrome";
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

interface GraphBuilderNewViewProps {
  sessionId: string;
  dataset: DatasetMeta | undefined;
  onClose: () => void;
}

export function GraphBuilderNewView({
  sessionId,
  dataset,
  onClose,
}: GraphBuilderNewViewProps) {
  const { t } = useTranslation();
  const session = useGraphBuilderNewStore((state) => (
    state.sessions.find((candidate) => candidate.id === sessionId)
  ));
  const setColumns = useGraphBuilderNewStore((state) => state.setColumns);
  const setOverlay = useGraphBuilderNewStore((state) => state.setOverlay);
  const setHiddenOverlayGroups = useGraphBuilderNewStore((state) => state.setHiddenOverlayGroups);
  const setMean = useGraphBuilderNewStore((state) => state.setMean);
  const setModes = useGraphBuilderNewStore((state) => state.setModes);
  const setCamera = useGraphBuilderNewStore((state) => state.setCamera);
  const readOnly = useProjectStore((state) => state.readOnly);
  const [columnMetadata, setColumnMetadata] = useState<{
    dataset: DatasetMeta;
    sessionId: string;
    transportId: string;
    runtimeEpoch: number | undefined;
    descriptors: ColumnDescriptor[];
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [meanAvailable, setMeanAvailable] = useState<boolean | null>(null);
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
    setMeanAvailable(null);
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
    if (useProjectStore.getState().readOnly || (yColumnId && !xColumnIds.has(yColumnId))) return;
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
    typeLabel: inferFieldType(column.sqlType) === "continuous" ? "#" : "A",
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
  const rawMode = session.rawMode ?? "scatter";
  const hasPoints = rawMode !== "line";
  const hasLine = rawMode !== "scatter";
  const temporalX = session.xMode === "time" || session.xMode === "duration";
  const activeLayers = [
    ...(hasPoints ? [{ kind: "points" as const, label: t("graphNewUi.points") }] : []),
    ...(hasLine ? [{
      kind: "line" as const,
      label: temporalX ? t("graphNewUi.timeSeries") : t("graphNewUi.line"),
    }] : []),
  ];
  const setRawMode = (nextRawMode: GraphNewRawMode, nextXMode?: GraphNewXMode) => {
    if (controlsDisabled) return;
    const current = useGraphBuilderNewStore.getState().sessions.find(({ id }) => id === session.id);
    setModes(session.id, nextXMode ?? current?.xMode ?? "auto", nextRawMode);
  };
  const dropText = t("graphNewUi.dropColumn");
  const clearFieldLabel = (field: string) => t("graphNewUi.clearField", { field });
  const unavailableTitle = (feature: string) => t("graphNewUi.unavailable", { feature });

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
        <span className="graph-builder-new-source">{dataset?.name ?? t("graphNew.sourceUnavailable")}</span>
        <button
          className="graph-builder-new-close"
          type="button"
          aria-label="Close Graph Builder-new"
          title="Close"
          onClick={onClose}
        >
          &times;
        </button>
      </GraphBuilderToolbarSection>

      <div className="gb-body graph-builder-new-body">
        <aside className="gb-left graph-builder-new-left" aria-label={t("graphNewUi.columns")}>
          <GraphBuilderRailSection title={t("graphNewUi.columns")} className="graph-builder-new-columns">
            <GraphFieldPalette
              items={paletteItems}
              disabled={controlsDisabled}
              ariaLabel={t("graphNewUi.columns")}
              getItemAriaLabel={(item) => t("graphNewUi.dragField", { field: item.name })}
            />
          </GraphBuilderRailSection>
          <GraphBuilderRailSection title={t("graphNewUi.layers")} className="graph-builder-new-layers">
            <div className="graph-builder-new-layer-list">
              {activeLayers.map((layer, index) => (
                <GraphLayerCard
                  key={layer.kind}
                  label={layer.label}
                  testId={`graph-layer-${layer.kind}`}
                  onRemove={() => setRawMode(
                    layer.kind === "points" ? "line" : "scatter",
                  )}
                  removeDisabled={controlsDisabled || activeLayers.length === 1}
                  removeAriaLabel={t("graphNewUi.removeLayer", { layer: layer.label })}
                >
                  {index === 0 && (
                    <label className="graph-builder-new-mean-control">
                      <input
                        type="checkbox"
                        checked={session.showMean ?? true}
                        disabled={controlsDisabled || meanAvailable === false}
                        onChange={(event) => setMean(session.id, event.target.checked)}
                      />
                      {t("graphNew.mean")}
                    </label>
                  )}
                  <div className="graph-builder-new-layer-placeholders">
                    <GraphPlaceholderButton
                      label={layer.kind === "points" ? t("graphNewUi.pointSettings") : t("graphNewUi.lineSettings")}
                      unavailableTitle={unavailableTitle(
                        layer.kind === "points" ? t("graphNewUi.pointSettings") : t("graphNewUi.lineSettings"),
                      )}
                    />
                  </div>
                </GraphLayerCard>
              ))}
              <GraphLayerCard label={t("graphNewUi.addGraphElement")} testId="graph-layer-add">
                <div className="graph-builder-new-add-options">
                  <button type="button" disabled={controlsDisabled || hasPoints}
                    onClick={() => setRawMode(hasLine ? "pointsLine" : "scatter")}>
                    {t("graphNewUi.points")}
                  </button>
                  <button type="button" disabled={controlsDisabled || (hasLine && !temporalX)}
                    onClick={() => {
                      const current = useGraphBuilderNewStore.getState().sessions.find(({ id }) => id === session.id);
                      const currentXMode = current?.xMode ?? "auto";
                      const currentTemporal = currentXMode === "time" || currentXMode === "duration";
                      setRawMode(
                        hasPoints ? "pointsLine" : "line",
                        hasLine && currentTemporal ? "auto" : currentXMode,
                      );
                    }}>
                    {t("graphNewUi.line")}
                  </button>
                  <button type="button" disabled={controlsDisabled || (hasLine && temporalX)}
                    onClick={() => {
                      const currentXMode = useGraphBuilderNewStore.getState().sessions
                        .find(({ id }) => id === session.id)?.xMode ?? "auto";
                      setRawMode(
                        "line",
                        currentXMode === "time" || currentXMode === "duration" ? currentXMode : "time",
                      );
                    }}>
                    {t("graphNewUi.timeSeries")}
                  </button>
                  {(["bar", "smoother", "fitLine", "boxPlot", "histogram", "normalCurve", "surface", "contour"] as const).map((kind) => {
                    const label = t(`graphNewUi.${kind}`);
                    return <GraphPlaceholderButton key={kind} label={label} unavailableTitle={unavailableTitle(label)} />;
                  })}
                </div>
              </GraphLayerCard>
            </div>
          </GraphBuilderRailSection>
        </aside>

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
          ) : transportAvailable && session.xColumnId && session.yColumnId
            && xColumnIds.has(session.xColumnId) && numericColumnIds.has(session.yColumnId) ? (
            <GraphNewCanvas
              key={JSON.stringify([session.transportId, runtimeEpoch, datasetId, datasetGeneration, session.xColumnId, session.yColumnId, session.overlayColumnId, session.xMode ?? "auto"])}
              transportId={session.transportId}
              datasetId={session.datasetId}
              datasetGeneration={session.datasetGeneration}
              xColumnId={session.xColumnId}
              yColumnId={session.yColumnId}
              overlayColumnId={session.overlayColumnId ?? null}
              hiddenOverlayGroupIds={session.hiddenOverlayGroupIds}
              showMean={session.showMean ?? true}
              xMode={session.xMode ?? "auto"}
              rawMode={session.rawMode ?? "scatter"}
              savedCamera={session.camera ?? null}
              readOnly={readOnly}
              onMeanAvailabilityChange={setMeanAvailable}
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
              xTitle={columns.find((column) => column.columnId === session.xColumnId)?.name ?? ""}
              yTitle={columns.find((column) => column.columnId === session.yColumnId)?.name ?? ""}
            />
          ) : (
            <div className="graph-builder-new-plot-placeholder" aria-hidden="true" />
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
                  onChange={(event) => setModes(
                    session.id,
                    event.target.value as GraphNewXMode,
                    session.rawMode ?? "scatter",
                  )}
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

        <aside className="graph-builder-new-inspector" aria-label="Graph options">
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
            <select data-testid="legacy-y-field" tabIndex={-1} value={session.yColumnId ?? ""} disabled={controlsDisabled || numericColumns.length === 0}
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
              onChange={(event) => setModes(session.id, event.target.value as GraphNewXMode, session.rawMode ?? "scatter")}>
              {(["auto", "numeric", "time", "duration", "category"] as const).map((mode) =>
                <option key={mode} value={mode}>{t(`graphNew.xMode.${mode}`, { defaultValue: mode })}</option>)}
            </select>
          </label>
          <label>
            <span>{t("graphNew.rawSeries", { defaultValue: "Raw series" })}</span>
            <select data-testid="legacy-raw-series" tabIndex={-1} value={session.rawMode ?? "scatter"}
              disabled={controlsDisabled}
              onChange={(event) => setModes(session.id, session.xMode ?? "auto", event.target.value as GraphNewRawMode)}>
              {(["scatter", "line", "pointsLine"] as const).map((mode) =>
                <option key={mode} value={mode}>{t(`graphNew.rawMode.${mode}`, { defaultValue: mode })}</option>)}
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