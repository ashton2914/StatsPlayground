import { useState, useRef, useEffect } from "react";
import { useHistoryStore } from "@/stores/useHistoryStore";
import { listen } from "@tauri-apps/api/event";

export function HistoryPanel({
  onRestored,
  setBusyMessage,
}: {
  onRestored: () => Promise<void>;
  setBusyMessage: (msg: string | null) => void;
}) {
  const {
    history,
    snapshots,
    currentIdx,
    createSnapshot,
    restoreSnapshot,
    deleteSnapshot,
    renameSnapshot,
    jumpTo,
  } = useHistoryStore();

  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renamingId && renameRef.current) {
      renameRef.current.focus();
      renameRef.current.select();
    }
  }, [renamingId]);

  const handleRestoreSnapshot = async (id: string) => {
    setBusyMessage("正在恢复快照…");
    const unlisten = await listen<{
      datasetIndex: number;
      datasetTotal: number;
      datasetName: string;
    }>("restore-progress", (event) => {
      const { datasetIndex, datasetTotal, datasetName } = event.payload;
      if (datasetTotal > 0 && datasetIndex < datasetTotal) {
        setBusyMessage(`正在恢复快照… 数据表 ${datasetIndex + 1}/${datasetTotal}: ${datasetName}`);
      }
    });
    try {
      await restoreSnapshot(id);
      await onRestored();
    } finally {
      unlisten();
      setBusyMessage(null);
    }
  };

  const handleRenameSubmit = (id: string) => {
    const trimmed = renameValue.trim();
    if (trimmed) {
      renameSnapshot(id, trimmed);
    }
    setRenamingId(null);
  };

  const handleCreateSnapshot = async () => {
    setBusyMessage("正在创建快照…");
    const unlisten = await listen<{
      datasetIndex: number;
      datasetTotal: number;
      datasetName: string;
    }>("snapshot-progress", (event) => {
      const { datasetIndex, datasetTotal, datasetName } = event.payload;
      if (datasetTotal > 0 && datasetIndex < datasetTotal) {
        setBusyMessage(`正在创建快照… 数据表 ${datasetIndex + 1}/${datasetTotal}: ${datasetName}`);
      }
    });
    try {
      await createSnapshot();
    } finally {
      unlisten();
      setBusyMessage(null);
    }
  };

  const formatTime = (iso: string): string => {
    try {
      const d = new Date(iso);
      return d.toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
    } catch {
      return iso;
    }
  };

  return (
    <div className="history-panel">
      {/* History section */}
      <div className="history-section">
        <div className="history-section-header">
          <h3>历史记录</h3>
          <span className="history-count">{history.length}</span>
        </div>
        <div className="history-list">
          {history.length === 0 ? (
            <div className="empty-hint">暂无历史记录</div>
          ) : (
            history.map((entry, idx) => (
              <div
                key={entry.id}
                className={`history-item${idx === currentIdx ? " history-current" : ""}${entry.afterState ? " history-clickable" : ""}`}
                title={`${entry.description}\n${formatTime(entry.timestamp)}`}
                onClick={() => entry.afterState && jumpTo(entry.id)}
                style={entry.afterState ? { cursor: "pointer" } : undefined}
              >
                <div className="history-item-icon">
                  {idx === currentIdx ? (
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                      <circle cx="8" cy="8" r="4" />
                    </svg>
                  ) : (
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                      <circle cx="8" cy="8" r="4" opacity="0.3" />
                    </svg>
                  )}
                </div>
                <div className="history-item-body">
                  <span className="history-item-desc">{entry.description}</span>
                  <span className="history-item-time">{formatTime(entry.timestamp)}</span>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Snapshot section */}
      <div className="snapshot-section">
        <div className="history-section-header">
          <h3>快照</h3>
          <button
            className="snapshot-add-btn"
            onClick={handleCreateSnapshot}
            title="创建快照"
          >
            +
          </button>
        </div>
        <div className="snapshot-list">
          {snapshots.length === 0 ? (
            <div className="empty-hint">暂无快照</div>
          ) : (
            snapshots.map((snap) => (
              <div key={snap.id} className="snapshot-item">
                <div className="snapshot-item-icon">
                  <svg width="14" height="14" viewBox="0 0 640 640" fill="currentColor">
                    <path d="M320 96C196.3 96 96 196.3 96 320S196.3 544 320 544S544 443.7 544 320S443.7 96 320 96zM320 480C231.6 480 160 408.4 160 320S231.6 160 320 160S480 231.6 480 320S408.4 480 320 480z" />
                    <circle cx="320" cy="320" r="80" />
                  </svg>
                </div>
                <div className="snapshot-item-body">
                  {renamingId === snap.id ? (
                    <input
                      ref={renameRef}
                      className="snapshot-rename-input"
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onBlur={() => handleRenameSubmit(snap.id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleRenameSubmit(snap.id);
                        if (e.key === "Escape") setRenamingId(null);
                      }}
                      onClick={(e) => e.stopPropagation()}
                    />
                  ) : (
                    <span
                      className="snapshot-item-name"
                      onDoubleClick={() => {
                        setRenamingId(snap.id);
                        setRenameValue(snap.name);
                      }}
                    >
                      {snap.name}
                    </span>
                  )}
                  <span className="snapshot-item-time">
                    {formatTime(snap.timestamp)}
                  </span>
                </div>
                <div className="snapshot-actions">
                  <button
                    className="snapshot-action-btn"
                    title="恢复"
                    onClick={() => handleRestoreSnapshot(snap.id)}
                  >
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                      <path d="M4 2v4H0l5 5 5-5H6V2H4zm-4 9v2h14v-2H0z" />
                    </svg>
                  </button>
                  <button
                    className="snapshot-action-btn snapshot-action-danger"
                    title="删除"
                    onClick={() => deleteSnapshot(snap.id)}
                  >
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                      <path d="M8 0a8 8 0 100 16A8 8 0 008 0zm3.5 10.1l-1.4 1.4L8 9.4l-2.1 2.1-1.4-1.4L6.6 8 4.5 5.9l1.4-1.4L8 6.6l2.1-2.1 1.4 1.4L9.4 8l2.1 2.1z" />
                    </svg>
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
