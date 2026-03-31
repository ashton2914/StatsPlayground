import { useState, useRef, useEffect, useCallback, type MutableRefObject } from "react";
import { useHistoryStore } from "@/stores/useHistoryStore";
import { listen } from "@tauri-apps/api/event";

export interface SnapshotMenuData {
  id: string;
  x: number;
  y: number;
}

export function HistoryPanel({
  setBusyMessage,
  onSnapshotMenu,
  snapRenameRef,
}: {
  setBusyMessage: (msg: string | null) => void;
  onSnapshotMenu: (menu: SnapshotMenuData) => void;
  snapRenameRef: MutableRefObject<((id: string) => void) | null>;
}) {
  const {
    history,
    snapshots,
    currentIdx,
    createSnapshot,
    jumpTo,
  } = useHistoryStore();

  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameRef = useRef<HTMLInputElement>(null);

  // Draggable divider state (percentage of history section)
  const [historyPct, setHistoryPct] = useState(60);
  const panelRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

  useEffect(() => {
    if (renamingId && renameRef.current) {
      renameRef.current.focus();
      renameRef.current.select();
    }
  }, [renamingId]);

  // Expose rename trigger to parent via ref
  useEffect(() => {
    snapRenameRef.current = (id: string) => {
      const snap = snapshots.find(s => s.id === id);
      if (snap) {
        setRenamingId(snap.id);
        setRenameValue(snap.name);
      }
    };
    return () => { snapRenameRef.current = null; };
  }, [snapshots, snapRenameRef]);

  // Divider drag handler
  const handleDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    draggingRef.current = true;
    const startY = e.clientY;
    const startPct = historyPct;
    const panel = panelRef.current;
    if (!panel) return;
    const panelH = panel.clientHeight;

    const onMouseMove = (ev: MouseEvent) => {
      if (!draggingRef.current) return;
      const delta = ev.clientY - startY;
      const deltaPct = (delta / panelH) * 100;
      const newPct = Math.max(15, Math.min(85, startPct + deltaPct));
      setHistoryPct(newPct);
    };
    const onMouseUp = () => {
      draggingRef.current = false;
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }, [historyPct]);

  const handleRenameSubmit = (id: string) => {
    const trimmed = renameValue.trim();
    if (trimmed) {
      const { renameSnapshot } = useHistoryStore.getState();
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

  const handleSnapshotContextMenu = (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    onSnapshotMenu({ id, x: e.clientX, y: e.clientY });
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
    <div className="history-panel" ref={panelRef}>
      {/* History section */}
      <div className="history-section" style={{ flex: `0 0 ${historyPct}%` }}>
        <div className="history-section-header">
          <h3>历史记录</h3>
          <span className="history-count">{history.filter(e => e.description !== "__init__").length}</span>
        </div>
        <div className="history-list">
          {history.filter(e => e.description !== "__init__").length === 0 ? (
            <div className="empty-hint">暂无历史记录</div>
          ) : (
            history.filter(e => e.description !== "__init__").map((entry) => {
              const idx = history.indexOf(entry);
              return (
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
            );
            })
          )}
        </div>
      </div>

      {/* Draggable divider */}
      <div className="history-divider" onMouseDown={handleDividerMouseDown} />

      {/* Snapshot section */}
      <div className="snapshot-section" style={{ flex: `0 0 ${100 - historyPct}%` }}>
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
              <div
                key={snap.id}
                className="snapshot-item"
                onContextMenu={(e) => handleSnapshotContextMenu(e, snap.id)}
              >
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
                    <span className="snapshot-item-name">
                      {snap.name}
                    </span>
                  )}
                  <span className="snapshot-item-time">
                    {formatTime(snap.timestamp)}
                  </span>
                </div>
              </div>
            ))
          )}
        </div>
      </div>


    </div>
  );
}
