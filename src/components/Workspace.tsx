import { useEffect, useState, useRef } from "react";
import { useProjectStore } from "@/stores/useProjectStore";
import { useDataStore } from "@/stores/useDataStore";
import { dataService } from "@/services/dataService";
import { DataTableView } from "./DataTableView";
import { PreferencesDialog } from "./PreferencesDialog";
import { open, save } from "@tauri-apps/plugin-dialog";

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
  const { project, saveProject, closeProject, dirty, markDirty } = useProjectStore();
  const { datasets, activeDatasetId, setActiveDataset, refreshDatasets, statusInfo } = useDataStore();
  const { openProject } = useProjectStore();
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [showPrefs, setShowPrefs] = useState(false);
  const [saveToast, setSaveToast] = useState(false);
  const [dsMenu, setDsMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const tableCounter = useRef(0);

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

  // Cmd/Ctrl+S: save project
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        handleSave();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [saveProject]);

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
    // Enter rename mode
    setRenamingId(meta.id);
    setRenameValue(name);
  };

  const handleRenameSubmit = async (id: string) => {
    const trimmed = renameValue.trim();
    if (trimmed && trimmed !== datasets.find((d) => d.id === id)?.name) {
      await dataService.renameDataset(id, trimmed);
      await refreshDatasets();
      markDirty();
    }
    setRenamingId(null);
  };

  const handleDeleteDataset = async (id: string) => {
    await dataService.deleteDataset(id);
    if (activeDatasetId === id) setActiveDataset(null);
    await refreshDatasets();
    markDirty();
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
    }
  };

  const handleSave = async () => {
    await saveProject();
    setSaveToast(true);
    setTimeout(() => setSaveToast(false), 1500);
  };

  const handleOpenAnother = async () => {
    const selected = await open({
      title: "打开项目",
      filters: [{ name: "StatsPlayground Project", extensions: ["spprj"] }],
      multiple: false,
    });
    if (selected) {
      setActiveDataset(null);
      await openProject(selected as string);
      await refreshDatasets();
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
              <div className="menu-item" onClick={handleSave}>保存<span className="menu-shortcut">⌘S</span></div>
              <div className="menu-sep" />
              <div className="menu-item" onClick={() => setShowPrefs(true)}>首选项<span className="menu-shortcut">⌘,</span></div>
              <div className="menu-sep" />
              <div className="menu-item" onClick={handleOpenAnother}>打开项目<span className="menu-shortcut">⌘O</span></div>
              <div className="menu-item" onClick={closeProject}>关闭项目</div>
            </MenuDropdown>
            <MenuDropdown label="表格">
              <div className="menu-item" onClick={handleCreateTable}>新建数据表</div>
              <div className="menu-item" onClick={handleImportCsv}>导入 CSV</div>
            </MenuDropdown>
          </MenuBar>
        </div>
        <div className="menu-spacer" />
        <button
          className={`menu-bar-save${dirty ? " menu-bar-save-dirty" : ""}`}
          onClick={handleSave}
          title="保存 (⌘S)"
        >
          <svg width="20" height="20" viewBox="0 0 640 640" fill="currentColor">
            <path d="M160 144C151.2 144 144 151.2 144 160L144 480C144 488.8 151.2 496 160 496L480 496C488.8 496 496 488.8 496 480L496 237.3C496 233.1 494.3 229 491.3 226L416 150.6L416 240C416 257.7 401.7 272 384 272L224 272C206.3 272 192 257.7 192 240L192 144L160 144zM240 144L240 224L368 224L368 144L240 144zM96 160C96 124.7 124.7 96 160 96L402.7 96C419.7 96 436 102.7 448 114.7L525.3 192C537.3 204 544 220.3 544 237.3L544 480C544 515.3 515.3 544 480 544L160 544C124.7 544 96 515.3 96 480L96 160zM256 384C256 348.7 284.7 320 320 320C355.3 320 384 348.7 384 384C384 419.3 355.3 448 320 448C284.7 448 256 419.3 256 384z"/>
          </svg>
        </button>
      </div>

      {/* Workspace */}
      <div className="workspace">
        {/* Left: File List Panel */}
        <div className="side-panel">
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
        {(statusInfo?.selectionLabel || statusInfo?.cellLabel) && (
          <span>{statusInfo.selectionLabel || statusInfo.cellLabel}</span>
        )}
        {statusInfo?.dimensions && <span>{statusInfo.dimensions}</span>}
      </div>

      {showPrefs && <PreferencesDialog onClose={() => setShowPrefs(false)} />}

      {dsMenu && (
        <div
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

      {saveToast && (
        <div className="save-toast">✓ 已保存</div>
      )}

    </div>
  );
}
