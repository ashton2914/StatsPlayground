import { useEffect, useState, useRef, useCallback } from "react";
import { useProjectStore } from "@/stores/useProjectStore";
import { useDataStore } from "@/stores/useDataStore";
import { useHistoryStore } from "@/stores/useHistoryStore";
import { dataService } from "@/services/dataService";
import { ioService } from "@/services/ioService";
import { DataTableView } from "./DataTableView";
import { HistoryPanel, type SnapshotMenuData } from "./HistoryPanel";
import { PreferencesDialog } from "./PreferencesDialog";
import { open, save } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { modKey } from "@/utils/platform";
import { ctxMenuRef } from "@/utils/ctxMenu";
import type { HistoryEntry, NamedSnapshot } from "@/types/history";

function formatStat(n: number): string {
  if (Number.isInteger(n) && Math.abs(n) < 1e15) return n.toString();
  const s = n.toPrecision(10);
  return parseFloat(s).toString();
}

function MenuBar({ children }: { children: React.ReactNode }) {
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (barRef.current && !barRef.current.contains(e.target as Node)) setOpenMenu(null);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  return (
    <div className="menu-bar-menus" ref={barRef}>
      {typeof children === "object" && Array.isArray(children)
        ? children.map((child: any) =>
            child && child.type === MenuDropdown
              ? { ...child, props: { ...child.props, openMenu, setOpenMenu } }
              : child
          )
        : children}
    </div>
  );
}

function MenuDropdown({ label, children, openMenu, setOpenMenu }: {
  label: string;
  children: React.ReactNode;
  openMenu?: string | null;
  setOpenMenu?: (menu: string | null) => void;
}) {
  const isOpen = openMenu === label;

  const handleClick = () => {
    setOpenMenu?.(isOpen ? null : label);
  };

  const handleMouseEnter = () => {
    if (openMenu && openMenu !== label) {
      setOpenMenu?.(label);
    }
  };

  return (
    <div className="menu-dropdown">
      <button
        className="menu-dropdown-trigger"
        onClick={handleClick}
        onMouseEnter={handleMouseEnter}
      >
        {label}
      </button>
      {isOpen && (
        <div className="menu-dropdown-panel" onClick={() => setOpenMenu?.(null)}>
          {children}
        </div>
      )}
    </div>
  );
}

export function Workspace() {
  const { project, saveProject, closeProject, initProject, dirty, markDirty } = useProjectStore();
  const { datasets, activeDatasetId, setActiveDataset, refreshDatasets, statusInfo } = useDataStore();
  const { openProject } = useProjectStore();
  const { record: recordHistory, createSnapshot, restoreSnapshot, deleteSnapshot, reset: resetHistory } = useHistoryStore();
  const [activeTab, setActiveTab] = useState<"files" | "history">("files");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [showPrefs, setShowPrefs] = useState(false);
  const [saveToast, setSaveToast] = useState(false);
  const [dsMenu, setDsMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const [snapMenu, setSnapMenu] = useState<SnapshotMenuData | null>(null);
  const [confirmDeleteSnapId, setConfirmDeleteSnapId] = useState<string | null>(null);
  const snapRenameRef = useRef<((id: string) => void) | null>(null);
  const [importProgress, setImportProgress] = useState<{
    tableName: string;
    tableIndex: number;
    tableTotal: number;
    rowsDone: number;
    rowsTotal: number;
  } | null>(null);
  const [busyMessage, setBusyMessage] = useState<string | null>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const tableCounter = useRef(0);

  /** Record an action to history (synchronous — no IPC) */
  const recordAction = useCallback((desc: string) => {
    recordHistory(desc);
  }, [recordHistory]);

  /** Called when history/snapshot is restored — refresh all UI */
  const handleHistoryRestored = useCallback(async () => {
    await refreshDatasets();
    // If activeDataset no longer exists, deselect
    const updatedDatasets = await dataService.listDatasets();
    if (activeDatasetId && !updatedDatasets.find((d) => d.id === activeDatasetId)) {
      setActiveDataset(null);
    }
  }, [refreshDatasets, activeDatasetId, setActiveDataset]);

  useEffect(() => {
    refreshDatasets();
  }, []);

  // Dismiss dataset context menu on click
  useEffect(() => {
    if (!dsMenu) return;
    const handler = () => setDsMenu(null);
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [dsMenu]);

  // Dismiss snapshot context menu on click
  useEffect(() => {
    if (!snapMenu) return;
    const handler = () => { setSnapMenu(null); setConfirmDeleteSnapId(null); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [snapMenu]);

  // Cmd/Ctrl+S: save project (use ref to avoid stale closure)
  const handleSaveRef = useRef<(() => Promise<void>) | null>(null);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        handleSaveRef.current?.();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  // Cmd/Ctrl+,: open preferences
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === ",") {
        e.preventDefault();
        setShowPrefs(true);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  // Cmd/Ctrl+O: open project
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "o") {
        e.preventDefault();
        handleOpenAnother();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  // Sync counter with existing datasets on load
  useEffect(() => {
    const maxNum = datasets.reduce((max, ds) => {
      const match = ds.name.match(/^数据表(\d+)$/);
      return match ? Math.max(max, parseInt(match[1], 10)) : max;
    }, 0);
    if (maxNum > tableCounter.current) tableCounter.current = maxNum;
  }, [datasets]);

  const handleCreateTable = async () => {
    tableCounter.current += 1;
    const name = `数据表${tableCounter.current}`;
    const meta = await dataService.createTable(name, [], []);
    await refreshDatasets();
    markDirty();
    setActiveDataset(meta.id);
    recordAction(`新建数据表 "${name}"`);
    // Enter rename mode
    setRenamingId(meta.id);
    setRenameValue(name);
  };

  const handleRenameSubmit = async (id: string) => {
    const trimmed = renameValue.trim();
    const oldName = datasets.find((d) => d.id === id)?.name;
    if (trimmed && trimmed !== oldName) {
      await dataService.renameDataset(id, trimmed);
      await refreshDatasets();
      markDirty();
      recordAction(`重命名数据表 "${oldName}" → "${trimmed}"`);
    }
    setRenamingId(null);
  };

  const handleDeleteDataset = async (id: string) => {
    const name = datasets.find((d) => d.id === id)?.name ?? id;
    await dataService.deleteDataset(id);
    if (activeDatasetId === id) setActiveDataset(null);
    await refreshDatasets();
    markDirty();
    recordAction(`删除数据表 "${name}"`);
  };

  const handleImportCsv = async () => {
    const selected = await open({
      title: "导入 CSV 文件",
      filters: [{ name: "CSV", extensions: ["csv"] }],
      multiple: false,
    });
    if (selected) {
      await dataService.importFile(selected as string);
      await refreshDatasets();
      markDirty();
      const fileName = (selected as string).split(/[\\/]/).pop() ?? "CSV";
      recordAction(`导入 CSV "${fileName}"`);
    }
  };

  const handleImportSqlite = async () => {
    const selected = await open({
      title: "导入 SQLite 数据库",
      filters: [{ name: "SQLite", extensions: ["db", "sqlite", "sqlite3"] }],
      multiple: false,
    });
    if (selected) {
      // Listen for progress events
      const unlisten = await listen<{
        table_name: string;
        table_index: number;
        table_total: number;
        rows_done: number;
        rows_total: number;
      }>("import-progress", (event) => {
        setImportProgress({
          tableName: event.payload.table_name,
          tableIndex: event.payload.table_index,
          tableTotal: event.payload.table_total,
          rowsDone: event.payload.rows_done,
          rowsTotal: event.payload.rows_total,
        });
      });
      try {
        setImportProgress({ tableName: "准备中...", tableIndex: 0, tableTotal: 0, rowsDone: 0, rowsTotal: 0 });
        await ioService.importSqlite(selected as string);
        await refreshDatasets();
        markDirty();
        const fileName = (selected as string).split(/[\\\\/]/).pop() ?? "SQLite";
        recordAction(`导入 SQLite "${fileName}"`);
      } catch (e) {
        alert("导入 SQLite 失败: " + String(e));
      } finally {
        unlisten();
        setImportProgress(null);
      }
    }
  };

  const handleExportSqlite = async () => {
    const filePath = await save({
      title: "导出为 SQLite 数据库",
      defaultPath: `${project?.name ?? "export"}.db`,
      filters: [{ name: "SQLite", extensions: ["db", "sqlite", "sqlite3"] }],
    });
    if (filePath) {
      try {
        await ioService.exportSqlite(filePath);
      } catch (e) {
        alert("导出 SQLite 失败: " + String(e));
      }
    }
  };

  const handleExportCsvZip = async () => {
    const filePath = await save({
      title: "导出为 CSV (ZIP)",
      defaultPath: `${project?.name ?? "export"}.zip`,
      filters: [{ name: "ZIP Archive", extensions: ["zip"] }],
    });
    if (filePath) {
      try {
        await ioService.exportCsvZip(filePath);
      } catch (e) {
        alert("导出 CSV 失败: " + String(e));
      }
    }
  };

  const handleSave = async () => {
    const { history, snapshots } = useHistoryStore.getState();
    // If project has no file path yet, prompt for save location
    if (!project?.filePath) {
      const filePath = await save({
        title: "保存项目文件",
        defaultPath: "未命名项目.spprj",
        filters: [{ name: "StatsPlayground Project", extensions: ["spprj"] }],
      });
      if (!filePath) return; // User cancelled
      await saveProject(filePath, history, snapshots);
    } else {
      await saveProject(undefined, history, snapshots);
    }
    setSaveToast(true);
    setTimeout(() => setSaveToast(false), 1500);
  };
  handleSaveRef.current = handleSave;

  const handleCloseProject = async () => {
    setActiveDataset(null);
    resetHistory();
    await initProject();
    await refreshDatasets();
    tableCounter.current = 0;
  };

  const handleOpenAnother = async () => {
    const selected = await open({
      title: "打开项目",
      filters: [{ name: "StatsPlayground Project", extensions: ["spprj"] }],
      multiple: false,
    });
    if (selected) {
      setActiveDataset(null);
      resetHistory();
      setBusyMessage("正在打开项目…");
      const unlisten = await listen<{
        datasetIndex: number;
        datasetTotal: number;
        datasetName: string;
      }>("open-project-progress", (event) => {
        const { datasetIndex, datasetTotal, datasetName } = event.payload;
        if (datasetTotal > 0 && datasetIndex < datasetTotal) {
          setBusyMessage(`正在打开项目… 数据表 ${datasetIndex + 1}/${datasetTotal}: ${datasetName}`);
        }
      });
      try {
        const result = await openProject(selected as string);
        await refreshDatasets();
        tableCounter.current = 0;
        // Restore history/snapshots from project file
        if (result.history.length > 0 || result.snapshots.length > 0) {
          const { loadFromProject } = useHistoryStore.getState();
          loadFromProject(
            result.history as HistoryEntry[],
            result.snapshots as NamedSnapshot[],
          );
        }
      } finally {
        unlisten();
        setBusyMessage(null);
      }
    }
  };

  return (
    <div className="app">
      {/* Menu Bar */}
      <div className="menu-bar">
        <span className="menu-bar-title">StatsPlayground</span>
        <div className="menu-bar-menus">
          <MenuBar>
            <MenuDropdown label="文件">
              <div className="menu-item" onClick={handleSave}>保存<span className="menu-shortcut">{modKey}S</span></div>
              <div className="menu-sep" />
              <div className="menu-item" onClick={() => setShowPrefs(true)}>首选项<span className="menu-shortcut">{modKey},</span></div>
              <div className="menu-sep" />
              <div className="menu-item" onClick={handleOpenAnother}>打开项目<span className="menu-shortcut">{modKey}O</span></div>
              <div className="menu-item" onClick={handleCloseProject}>关闭项目</div>
            </MenuDropdown>
            <MenuDropdown label="表格">
              <div className="menu-item" onClick={handleCreateTable}>新建数据表</div>
              <div className="menu-sep" />
              <div className="menu-item" onClick={handleImportCsv}>导入 CSV</div>
              <div className="menu-item" onClick={handleImportSqlite}>导入 SQLite</div>
              <div className="menu-sep" />
              <div className="menu-item" onClick={handleExportSqlite}>导出为 SQLite</div>
              <div className="menu-item" onClick={handleExportCsvZip}>导出为 CSV (ZIP)</div>
            </MenuDropdown>
          </MenuBar>
        </div>
        <div className="menu-spacer" />
        <button
          className="menu-bar-snapshot"
          onClick={async () => {
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
          }}
          title="创建快照"
        >
          <svg width="18" height="18" viewBox="0 0 640 640" fill="currentColor">
            <path d="M257.1 96C238.4 96 220.9 105.4 210.5 120.9L184.5 160L128 160C92.7 160 64 188.7 64 224L64 480C64 515.3 92.7 544 128 544L512 544C547.3 544 576 515.3 576 480L576 224C576 188.7 547.3 160 512 160L455.5 160L429.5 120.9C419.1 105.4 401.6 96 382.9 96L257.1 96zM250.4 147.6C251.9 145.4 254.4 144 257.1 144L382.8 144C385.5 144 388 145.3 389.5 147.6L422.7 197.4C427.2 204.1 434.6 208.1 442.7 208.1L512 208.1C520.8 208.1 528 215.3 528 224.1L528 480.1C528 488.9 520.8 496.1 512 496.1L128 496C119.2 496 112 488.8 112 480L112 224C112 215.2 119.2 208 128 208L197.3 208C205.3 208 212.8 204 217.3 197.3L250.5 147.5zM320 448C381.9 448 432 397.9 432 336C432 274.1 381.9 224 320 224C258.1 224 208 274.1 208 336C208 397.9 258.1 448 320 448zM256 336C256 300.7 284.7 272 320 272C355.3 272 384 300.7 384 336C384 371.3 355.3 400 320 400C284.7 400 256 371.3 256 336z"/>
          </svg>
        </button>
        <button
          className={`menu-bar-save${dirty ? " menu-bar-save-dirty" : ""}`}
          onClick={handleSave}
          title={`保存 (${modKey}S)`}
        >
          <svg width="20" height="20" viewBox="0 0 640 640" fill="currentColor">
            <path d="M160 144C151.2 144 144 151.2 144 160L144 480C144 488.8 151.2 496 160 496L480 496C488.8 496 496 488.8 496 480L496 237.3C496 233.1 494.3 229 491.3 226L416 150.6L416 240C416 257.7 401.7 272 384 272L224 272C206.3 272 192 257.7 192 240L192 144L160 144zM240 144L240 224L368 224L368 144L240 144zM96 160C96 124.7 124.7 96 160 96L402.7 96C419.7 96 436 102.7 448 114.7L525.3 192C537.3 204 544 220.3 544 237.3L544 480C544 515.3 515.3 544 480 544L160 544C124.7 544 96 515.3 96 480L96 160zM256 384C256 348.7 284.7 320 320 320C355.3 320 384 348.7 384 384C384 419.3 355.3 448 320 448C284.7 448 256 419.3 256 384z"/>
          </svg>
        </button>
      </div>

      {/* Workspace */}
      <div className="workspace">
        {/* Activity Bar (VS Code-style) */}
        <div className="activity-bar">
          <button
            className={`activity-btn${activeTab === "files" ? " activity-btn-active" : ""}`}
            onClick={() => setActiveTab("files")}
            title="目录"
          >
            <svg width="22" height="22" viewBox="0 0 640 640" fill="currentColor">
              <path d="M104 112C90.7 112 80 122.7 80 136L80 184C80 197.3 90.7 208 104 208L152 208C165.3 208 176 197.3 176 184L176 136C176 122.7 165.3 112 152 112L104 112zM256 128C238.3 128 224 142.3 224 160C224 177.7 238.3 192 256 192L544 192C561.7 192 576 177.7 576 160C576 142.3 561.7 128 544 128L256 128zM256 288C238.3 288 224 302.3 224 320C224 337.7 238.3 352 256 352L544 352C561.7 352 576 337.7 576 320C576 302.3 561.7 288 544 288L256 288zM256 448C238.3 448 224 462.3 224 480C224 497.7 238.3 512 256 512L544 512C561.7 512 576 497.7 576 480C576 462.3 561.7 448 544 448L256 448zM80 296L80 344C80 357.3 90.7 368 104 368L152 368C165.3 368 176 357.3 176 344L176 296C176 282.7 165.3 272 152 272L104 272C90.7 272 80 282.7 80 296zM104 432C90.7 432 80 442.7 80 456L80 504C80 517.3 90.7 528 104 528L152 528C165.3 528 176 517.3 176 504L176 456C176 442.7 165.3 432 152 432L104 432z"/>
            </svg>
          </button>
          <button
            className={`activity-btn${activeTab === "history" ? " activity-btn-active" : ""}`}
            onClick={() => setActiveTab("history")}
            title="历史与快照"
          >
            <svg width="22" height="22" viewBox="0 0 640 640" fill="currentColor">
              <path d="M320 128C426 128 512 214 512 320C512 426 426 512 320 512C254.8 512 197.1 479.5 162.4 429.7C152.3 415.2 132.3 411.7 117.8 421.8C103.3 431.9 99.8 451.9 109.9 466.4C156.1 532.6 233 576 320 576C461.4 576 576 461.4 576 320C576 178.6 461.4 64 320 64C234.3 64 158.5 106.1 112 170.7L112 144C112 126.3 97.7 112 80 112C62.3 112 48 126.3 48 144L48 256C48 273.7 62.3 288 80 288L104.6 288C105.1 288 105.6 288 106.1 288L192.1 288C209.8 288 224.1 273.7 224.1 256C224.1 238.3 209.8 224 192.1 224L153.8 224C186.9 166.6 249 128 320 128zM344 216C344 202.7 333.3 192 320 192C306.7 192 296 202.7 296 216L296 320C296 326.4 298.5 332.5 303 337L375 409C384.4 418.4 399.6 418.4 408.9 409C418.2 399.6 418.3 384.4 408.9 375.1L343.9 310.1L343.9 216z"/>
            </svg>
          </button>
        </div>

        {/* Left: Side Panel */}
        <div className="side-panel">
          {activeTab === "files" ? (
            <>
              <div className="panel-header">
                <h3>目录</h3>
              </div>
              <div className="dataset-list">
                {datasets.length === 0 ? (
                  <div className="empty-hint">暂无内容</div>
                ) : (
                  datasets.map((ds) => (
                    <div
                  key={ds.id}
                  className={`dataset-item ${activeDatasetId === ds.id ? "active" : ""}`}
                  onClick={() => setActiveDataset(ds.id)}
                  onDoubleClick={() => {
                    setRenamingId(ds.id);
                    setRenameValue(ds.name);
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setDsMenu({ x: e.clientX, y: e.clientY, id: ds.id });
                  }}
                >
                  <svg className="ds-icon" width="14" height="14" viewBox="0 0 640 640" fill="currentColor">
                    <path d="M480 96C515.3 96 544 124.7 544 160L544 480C544 515.3 515.3 544 480 544L160 544L153.5 543.7C121.2 540.4 96 513.1 96 480L96 160C96 124.7 124.7 96 160 96L480 96zM160 384L160 480L288 480L288 384L160 384zM352 384L352 480L480 480L480 384L352 384zM160 320L288 320L288 224L160 224L160 320zM352 320L480 320L480 224L352 224L352 320z"/>
                  </svg>
                  {renamingId === ds.id ? (
                    <input
                      ref={renameInputRef}
                      className="ds-rename-input"
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onBlur={() => handleRenameSubmit(ds.id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleRenameSubmit(ds.id);
                        if (e.key === "Escape") setRenamingId(null);
                      }}
                      onClick={(e) => e.stopPropagation()}
                      autoFocus
                    />
                  ) : (
                    <span className="ds-name">{ds.name}</span>
                  )}
                  <span className="ds-info">{ds.rowCount}×{ds.colCount}</span>
                </div>
              ))
            )}
          </div>
            </>
          ) : (
            <HistoryPanel
              setBusyMessage={setBusyMessage}
              onSnapshotMenu={(menu) => { setSnapMenu(menu); setConfirmDeleteSnapId(null); }}
              snapRenameRef={snapRenameRef}
            />
          )}
        </div>

        {/* Right: Main Content */}
        <div className="main-area">
          {activeDatasetId ? (
            <DataTableView datasetId={activeDatasetId} />
          ) : (
            <div className="main-content">
              <div className="workspace-empty">
                <p>选择左侧数据表，或创建新表开始工作</p>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Status Bar */}
      <div className="status-bar">
        <span>{project?.name}</span>
        <span>{datasets.length} 个数据表</span>
        <span className="status-spacer" />
        {statusInfo?.selectionStats && (
          <span className="status-stats">
            {statusInfo.selectionStats.avg != null && (
              <>
                <span>平均值: {formatStat(statusInfo.selectionStats.avg)}</span>
                <span>最小值: {formatStat(statusInfo.selectionStats.min!)}</span>
                <span>最大值: {formatStat(statusInfo.selectionStats.max!)}</span>
                <span>求和: {formatStat(statusInfo.selectionStats.sum!)}</span>
              </>
            )}
            <span>计数: {statusInfo.selectionStats.count}</span>
          </span>
        )}
        {(statusInfo?.selectionLabel || statusInfo?.cellLabel) && (
          <span>{statusInfo.selectionLabel || statusInfo.cellLabel}</span>
        )}
        {statusInfo?.dimensions && <span>{statusInfo.dimensions}</span>}
      </div>

      {showPrefs && <PreferencesDialog onClose={() => setShowPrefs(false)} />}

      {importProgress && (
        <div className="sp-dialog-overlay">
          <div className="sp-dialog" style={{ minWidth: 360, padding: "20px 24px" }}>
            <div style={{ fontWeight: 600, marginBottom: 12 }}>正在导入 SQLite 数据库…</div>
            <div style={{ fontSize: 13, marginBottom: 8, color: "var(--fg-secondary, #888)" }}>
              {importProgress.tableTotal > 0
                ? `表 ${importProgress.tableIndex + 1}/${importProgress.tableTotal}: ${importProgress.tableName}`
                : importProgress.tableName}
            </div>
            {importProgress.rowsTotal > 0 && (
              <>
                <div className="sp-progress-bar">
                  <div
                    className="sp-progress-fill"
                    style={{ width: `${Math.round((importProgress.rowsDone / importProgress.rowsTotal) * 100)}%` }}
                  />
                </div>
                <div style={{ fontSize: 12, marginTop: 4, color: "var(--fg-secondary, #888)" }}>
                  {importProgress.rowsDone.toLocaleString()} / {importProgress.rowsTotal.toLocaleString()} 行
                </div>
              </>
            )}
            {importProgress.rowsTotal === 0 && (
              <div className="sp-progress-bar">
                <div className="sp-progress-fill sp-progress-indeterminate" />
              </div>
            )}
          </div>
        </div>
      )}

      {busyMessage && (
        <div className="sp-dialog-overlay">
          <div className="sp-dialog" style={{ minWidth: 320, padding: "20px 24px" }}>
            <div style={{ fontWeight: 600, marginBottom: 12 }}>{busyMessage}</div>
            <div className="sp-progress-bar">
              <div className="sp-progress-fill sp-progress-indeterminate" />
            </div>
          </div>
        </div>
      )}

      {dsMenu && (
        <div
          ref={ctxMenuRef}
          className="sp-ctx-menu"
          style={{ left: dsMenu.x, top: dsMenu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="sp-ctx-item" onClick={() => {
            const ds = datasets.find((d) => d.id === dsMenu.id);
            if (ds) {
              setRenamingId(ds.id);
              setRenameValue(ds.name);
              setActiveDataset(ds.id);
            }
            setDsMenu(null);
          }}>重命名</div>
          <div className="sp-ctx-sep" />
          <div className="sp-ctx-item sp-ctx-danger" onClick={() => {
            handleDeleteDataset(dsMenu.id);
            setDsMenu(null);
          }}>删除</div>
        </div>
      )}

      {snapMenu && (
        <div
          className="sp-ctx-menu"
          style={{ left: snapMenu.x, top: snapMenu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="sp-ctx-item" onClick={() => {
            snapRenameRef.current?.(snapMenu.id);
            setSnapMenu(null);
          }}>重命名</div>
          <div className="sp-ctx-item" onClick={async () => {
            const id = snapMenu.id;
            setSnapMenu(null);
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
              await handleHistoryRestored();
            } finally {
              unlisten();
              setBusyMessage(null);
            }
          }}>恢复</div>
          <div className="sp-ctx-sep" />
          {confirmDeleteSnapId === snapMenu.id ? (
            <div className="snapshot-ctx-confirm" onMouseDown={(e) => e.stopPropagation()}>
              <span className="snapshot-ctx-confirm-text">确认删除？</span>
              <div className="snapshot-ctx-confirm-btns">
                <button className="snapshot-ctx-confirm-yes" onClick={(e) => {
                  e.stopPropagation();
                  deleteSnapshot(confirmDeleteSnapId);
                  setConfirmDeleteSnapId(null);
                  setSnapMenu(null);
                }}>确认</button>
                <button className="snapshot-ctx-confirm-no" onClick={(e) => {
                  e.stopPropagation();
                  setConfirmDeleteSnapId(null);
                }}>取消</button>
              </div>
            </div>
          ) : (
            <div className="sp-ctx-item sp-ctx-danger" onClick={(e) => {
              e.stopPropagation();
              setConfirmDeleteSnapId(snapMenu.id);
            }}>删除</div>
          )}
        </div>
      )}

      {saveToast && (
        <div className="save-toast">✓ 已保存</div>
      )}

    </div>
  );
}
