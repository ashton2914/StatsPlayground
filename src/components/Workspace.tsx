import { useEffect, useState, useRef } from "react";
import { useProjectStore } from "@/stores/useProjectStore";
import { useDataStore } from "@/stores/useDataStore";
import { dataService } from "@/services/dataService";
import { DataTableView } from "./DataTableView";
import { NewTableDialog } from "./NewTableDialog";
import { open, save } from "@tauri-apps/plugin-dialog";

function MenuDropdown({ label, children }: { label: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  return (
    <div className="menu-dropdown" ref={ref}>
      <button className="menu-dropdown-trigger" onClick={() => setOpen(!open)}>{label}</button>
      {open && (
        <div className="menu-dropdown-panel" onClick={() => setOpen(false)}>
          {children}
        </div>
      )}
    </div>
  );
}

export function Workspace() {
  const { project, saveProject, closeProject } = useProjectStore();
  const { datasets, activeDatasetId, setActiveDataset, refreshDatasets, statusInfo } = useDataStore();
  const [showNewTable, setShowNewTable] = useState(false);
  const { openProject } = useProjectStore();

  useEffect(() => {
    refreshDatasets();
  }, []);

  const handleCreateTable = async (name: string, columns: { name: string; type: string }[]) => {
    await dataService.createTable(
      name,
      columns.map((c) => c.name),
      columns.map((c) => c.type)
    );
    await refreshDatasets();
  };

  const handleDeleteDataset = async (id: string) => {
    await dataService.deleteDataset(id);
    if (activeDatasetId === id) setActiveDataset(null);
    await refreshDatasets();
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
    }
  };

  const handleSave = async () => {
    await saveProject();
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
          <MenuDropdown label="文件">
            <div className="menu-item" onClick={handleSave}>保存</div>
            <div className="menu-sep" />
            <div className="menu-item" onClick={handleOpenAnother}>打开其他项目</div>
            <div className="menu-item" onClick={closeProject}>关闭项目</div>
          </MenuDropdown>
          <MenuDropdown label="表格">
            <div className="menu-item" onClick={() => setShowNewTable(true)}>新建数据表</div>
            <div className="menu-item" onClick={handleImportCsv}>导入 CSV</div>
          </MenuDropdown>
        </div>
        <div className="menu-spacer" />
      </div>

      {/* Workspace */}
      <div className="workspace">
        {/* Left: File List Panel */}
        <div className="side-panel">
          <div className="panel-header">
            <h3>数据表</h3>
            <div className="panel-actions">
              <button className="btn-sm" onClick={() => setShowNewTable(true)} title="新建数据表">+</button>
              <button className="btn-sm" onClick={handleImportCsv} title="导入 CSV">📄</button>
            </div>
          </div>
          <div className="dataset-list">
            {datasets.length === 0 ? (
              <div className="empty-hint">暂无数据表</div>
            ) : (
              datasets.map((ds) => (
                <div
                  key={ds.id}
                  className={`dataset-item ${activeDatasetId === ds.id ? "active" : ""}`}
                  onClick={() => setActiveDataset(ds.id)}
                >
                  <span className="ds-icon">📊</span>
                  <span className="ds-name">{ds.name}</span>
                  <span className="ds-info">{ds.rowCount}×{ds.colCount}</span>
                  <button
                    className="btn-icon-sm ds-delete"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDeleteDataset(ds.id);
                    }}
                    title="删除"
                  >
                    ✕
                  </button>
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
        {statusInfo?.cellLabel && <span>{statusInfo.cellLabel}</span>}
        {statusInfo?.dimensions && <span>{statusInfo.dimensions}</span>}
      </div>

      {/* Dialog */}
      <NewTableDialog
        open={showNewTable}
        onClose={() => setShowNewTable(false)}
        onCreate={handleCreateTable}
      />
    </div>
  );
}
