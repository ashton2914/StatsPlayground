import { useEffect, useState } from "react";

import { inferFieldType } from "@/graphCore";
import { dataService } from "@/services/dataService";
import { graphNewService } from "@/services/graphNewService";
import { useGraphBuilderNewStore } from "@/stores/useGraphBuilderNewStore";
import type { ColumnDescriptor, DatasetMeta } from "@/types/data";
import { GraphNewCanvas } from "./GraphNewCanvas";

import "./GraphBuilderNewView.css";

const unsubscribeSessionClose = useGraphBuilderNewStore.subscribe((state, previous) => {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
  for (const session of previous.sessions) {
    if (!state.sessions.some(({ id }) => id === session.id)) {
      void graphNewService.close(session.id).catch(() => {});
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
  const session = useGraphBuilderNewStore((state) => (
    state.sessions.find((candidate) => candidate.id === sessionId)
  ));
  const setColumns = useGraphBuilderNewStore((state) => state.setColumns);
  const [numericColumns, setNumericColumns] = useState<ColumnDescriptor[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const datasetId = session?.datasetId;
  const datasetGeneration = session?.datasetGeneration;
  const missingDataset = Boolean(session && !dataset);
  const stale = Boolean(
    session
      && dataset
      && (dataset.id !== datasetId || dataset.generation !== datasetGeneration),
  );

  useEffect(() => {
    if ((missingDataset || stale) && typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
      void graphNewService.close(sessionId).catch(() => {});
    }
  }, [missingDataset, stale, sessionId]);

  useEffect(() => {
    let cancelled = false;
    setNumericColumns([]);
    setError(null);

    if (!datasetId || missingDataset || stale) {
      setLoading(false);
      return () => {
        cancelled = true;
      };
    }

    setLoading(true);
    void dataService.getColumnDescriptors(datasetId)
      .then((descriptors) => {
        if (!cancelled) {
          const nextNumericColumns = descriptors.filter(({ sqlType }) => (
            inferFieldType(sqlType) === "continuous"
          ));
          setNumericColumns(nextNumericColumns);
          const validColumnIds = new Set(nextNumericColumns.map(({ columnId }) => columnId));
          const currentSession = useGraphBuilderNewStore.getState().sessions.find(({ id }) => id === sessionId);
          if (currentSession
            && (!validColumnIds.has(currentSession.xColumnId ?? "")
              || !validColumnIds.has(currentSession.yColumnId ?? ""))) {
            setColumns(
              sessionId,
              validColumnIds.has(currentSession.xColumnId ?? "") ? currentSession.xColumnId : null,
              validColumnIds.has(currentSession.yColumnId ?? "") ? currentSession.yColumnId : null,
            );
          }
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
  }, [dataset, datasetId, datasetGeneration, missingDataset, sessionId, setColumns, stale]);

  if (!session) {
    return (
      <main className="graph-builder-new graph-builder-new-state">
        <p>This Graph Builder-new session is closed.</p>
      </main>
    );
  }

  const transportAvailable = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  const updateX = (xColumnId: string) => {
    setColumns(session.id, xColumnId || null, session.yColumnId);
  };
  const updateY = (yColumnId: string) => {
    setColumns(session.id, session.xColumnId, yColumnId || null);
  };

  return (
    <main className="graph-builder-new">
      <header className="graph-builder-new-header">
        <div>
          <h1>Graph Builder-new</h1>
          <span className="graph-builder-new-source">{dataset?.name ?? "Source table unavailable"}</span>
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
              disabled={loading || stale || Boolean(error) || numericColumns.length === 0}
              onChange={(event) => updateX(event.target.value)}
            >
              <option value="">Select a field</option>
              {numericColumns.map((column) => (
                <option key={column.columnId} value={column.columnId}>{column.name}</option>
              ))}
            </select>
          </label>
          <label>
            <span>Y field</span>
            <select
              aria-label="Y field"
              value={session.yColumnId ?? ""}
              disabled={loading || stale || Boolean(error) || numericColumns.length === 0}
              onChange={(event) => updateY(event.target.value)}
            >
              <option value="">Select a field</option>
              {numericColumns.map((column) => (
                <option key={column.columnId} value={column.columnId}>{column.name}</option>
              ))}
            </select>
          </label>
        </aside>

        <section className="graph-builder-new-stage" aria-label="Point plot">
          {missingDataset ? (
            <p role="status">The source table is no longer available.</p>
          ) : stale ? (
            <p role="status">The source table changed. Close this session and open a new one.</p>
          ) : loading ? (
            <p role="status">Loading numeric fields...</p>
          ) : error ? (
            <p role="alert">{error}</p>
          ) : numericColumns.length === 0 ? (
            <p role="status">This table has no numeric columns.</p>
          ) : transportAvailable && session.xColumnId && session.yColumnId ? (
            <GraphNewCanvas
              key={JSON.stringify([session.id, datasetId, datasetGeneration, session.xColumnId, session.yColumnId])}
              sessionId={session.id}
              datasetId={session.datasetId}
              datasetGeneration={session.datasetGeneration}
              xColumnId={session.xColumnId}
              yColumnId={session.yColumnId}
              xTitle={numericColumns.find((column) => column.columnId === session.xColumnId)?.name ?? ""}
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