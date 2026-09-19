import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { inferFieldType } from "@/graphCore";
import { dataService } from "@/services/dataService";
import { graphNewService } from "@/services/graphNewService";
import { useGraphBuilderNewStore } from "@/stores/useGraphBuilderNewStore";
import { useProjectStore } from "@/stores/useProjectStore";
import type { ColumnDescriptor, DatasetMeta } from "@/types/data";
import type { GraphNewRawMode, GraphNewXMode } from "@/types/graphBuilderNew";
import { GraphNewCanvas } from "./GraphNewCanvas";

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
  const missingY = Boolean(session?.yColumnId && !numericColumnIds.has(session.yColumnId));
  const missingOverlay = Boolean(session?.overlayColumnId && !overlayColumnIds.has(session.overlayColumnId));

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

  return (
    <main className="graph-builder-new">
      <header className="graph-builder-new-header">
        <div>
          <h1>{session.name ?? "Graph Builder-new"}</h1>
          <span className="graph-builder-new-source">{dataset?.name ?? t("graphNew.sourceUnavailable")}</span>
        </div>
        <button
          className="graph-builder-new-close"
          type="button"
          aria-label="Close Graph Builder-new"
          title="Close"
          onClick={onClose}
        >
          &times;
        </button>
      </header>

      <div className="graph-builder-new-body">
        <aside className="graph-builder-new-fields" aria-label="Point fields">
          <label>
            <span>X field</span>
            <select
              aria-label="X field"
              value={session.xColumnId ?? ""}
              disabled={readOnly || loading || stale || missingDataset || Boolean(error) || columns.length === 0}
              onChange={(event) => updateX(event.target.value)}
            >
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
            <select
              aria-label="Y field"
              value={session.yColumnId ?? ""}
              disabled={readOnly || loading || stale || missingDataset || Boolean(error) || numericColumns.length === 0}
              onChange={(event) => updateY(event.target.value)}
            >
              <option value="">Select a field</option>
              {!loading && !stale && !missingDataset && missingY && <option value={session.yColumnId!} disabled>{t("graphNew.fieldUnavailable", { field: session.yColumnId })}</option>}
              {numericColumns.map((column) => (
                <option key={column.columnId} value={column.columnId}>{column.name}</option>
              ))}
            </select>
          </label>
          <label>
            <span>{t("graphNew.overlayField")}</span>
            <select
              aria-label={t("graphNew.overlayField")}
              value={session.overlayColumnId ?? ""}
              disabled={readOnly || loading || stale || missingDataset || Boolean(error)}
              onChange={(event) => updateOverlay(event.target.value)}
            >
              <option value="">{t("graphNew.noOverlay")}</option>
              {!loading && !stale && !missingDataset && missingOverlay && (
                <option value={session.overlayColumnId!} disabled>
                  {t("graphNew.fieldUnavailable", { field: session.overlayColumnId })}
                </option>
              )}
              {columns.map((column) => (
                <option key={column.columnId} value={column.columnId}>{column.name}</option>
              ))}
            </select>
          </label>
          <label>
            <span>{t("graphNew.xInterpretation", { defaultValue: "X interpretation" })}</span>
            <select aria-label={t("graphNew.xInterpretation", { defaultValue: "X interpretation" })} value={session.xMode ?? "auto"}
              disabled={readOnly}
              onChange={(event) => setModes(session.id, event.target.value as GraphNewXMode, session.rawMode ?? "scatter")}>
              {(["auto", "numeric", "time", "duration", "category"] as const).map((mode) =>
                <option key={mode} value={mode}>{t(`graphNew.xMode.${mode}`, { defaultValue: mode })}</option>)}
            </select>
          </label>
          <label>
            <span>{t("graphNew.rawSeries", { defaultValue: "Raw series" })}</span>
            <select aria-label={t("graphNew.rawSeries", { defaultValue: "Raw series" })} value={session.rawMode ?? "scatter"}
              disabled={readOnly}
              onChange={(event) => setModes(session.id, session.xMode ?? "auto", event.target.value as GraphNewRawMode)}>
              {(["scatter", "line", "pointsLine"] as const).map((mode) =>
                <option key={mode} value={mode}>{t(`graphNew.rawMode.${mode}`, { defaultValue: mode })}</option>)}
            </select>
          </label>
        </aside>

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
              onHiddenOverlayGroupIdsChange={(ids) => setHiddenOverlayGroups(session.id, ids)}
              showMean={session.showMean ?? true}
              xMode={session.xMode ?? "auto"}
              rawMode={session.rawMode ?? "scatter"}
              savedCamera={session.camera ?? null}
              readOnly={readOnly}
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
              onMeanChange={(enabled) => setMean(session.id, enabled)}
              xTitle={columns.find((column) => column.columnId === session.xColumnId)?.name ?? ""}
              yTitle={numericColumns.find((column) => column.columnId === session.yColumnId)?.name ?? ""}
            />
          ) : (
            <div className="graph-builder-new-plot-placeholder" aria-hidden="true" />
          )}
        </section>
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