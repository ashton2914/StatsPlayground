import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useProjectStore } from "@/stores/useProjectStore";
import { useDataStore } from "@/stores/useDataStore";
import { useHistoryStore } from "@/stores/useHistoryStore";
import { useTableZoomStore } from "@/stores/useTableZoomStore";
import {
  useFolderStore,
  folderBaseName,
  folderParent,
  validateFolderOrFileName,
} from "@/stores/useFolderStore";
import { dataService } from "@/services/dataService";
import { ioService } from "@/services/ioService";
import { projectService } from "@/services/projectService";
import { DataTableView } from "./DataTableView";
import { HistoryPanel, type SnapshotMenuData } from "./HistoryPanel";
import { PreferencesDialog } from "./PreferencesDialog";
import { SqlQueryDialog } from "./SqlQueryDialog";
import { HelpDialog } from "./HelpDialog";
import { TableOpsDialog, type TableOpType } from "./TableOpsDialog";
import { GraphBuilderView } from "./graphBuilder";
import { TabulateView } from "./tabulate";
import "./graphBuilder/graphBuilder.css";
import { useGraphBuilderStore } from "@/stores/useGraphBuilderStore";
import { useTabulateStore } from "@/stores/useTabulateStore";
import type { GraphBuilderItem } from "@/types/graphBuilder";
import type { TabulateItem } from "@/types/tabulate";
import { open, save } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { modKey } from "@/utils/platform";
import { ctxMenuRef } from "@/utils/ctxMenu";
import type { NamedSnapshot } from "@/types/history";

function formatStat(n: number): string {
  if (Number.isInteger(n) && Math.abs(n) < 1e15) return n.toString();
  const s = n.toPrecision(10);
  return parseFloat(s).toString();
}

/**
 * Compact zoom control rendered in the status bar when a dataset is open.
 * Three buttons: zoom-out (−), current percentage (click to reset), zoom-in (+).
 * Mirrors the Cmd/Ctrl + −/=/0 shortcuts handled inside DataTableView.
 */
function TableZoomControl() {
  const { t } = useTranslation();
  const zoom = useTableZoomStore((s) => s.zoom);
  const zoomIn = useTableZoomStore((s) => s.zoomIn);
  const zoomOut = useTableZoomStore((s) => s.zoomOut);
  const resetZoom = useTableZoomStore((s) => s.resetZoom);
  const pct = Math.round(zoom * 100);
  return (
    <span className="sp-zoom-control" title={t("workspace.zoomTooltip", { defaultValue: "Table zoom" })}>
      <button
        type="button"
        className="sp-zoom-btn"
        onClick={zoomOut}
        title={t("workspace.zoomOut", { defaultValue: "Zoom out" }) + ` (${modKey}−)`}
        aria-label={t("workspace.zoomOut", { defaultValue: "Zoom out" })}
      >−</button>
      <button
        type="button"
        className="sp-zoom-btn sp-zoom-value"
        onClick={resetZoom}
        title={t("workspace.zoomReset", { defaultValue: "Reset to 100%" }) + ` (${modKey}0)`}
        aria-label={t("workspace.zoomReset", { defaultValue: "Reset to 100%" })}
      >{pct}%</button>
      <button
        type="button"
        className="sp-zoom-btn"
        onClick={zoomIn}
        title={t("workspace.zoomIn", { defaultValue: "Zoom in" }) + ` (${modKey}=)`}
        aria-label={t("workspace.zoomIn", { defaultValue: "Zoom in" })}
      >+</button>
    </span>
  );
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
  const { t } = useTranslation();
  const {
    project,
    saveProject,
    initProject,
    dirty,
    markDirty,
    readOnly,
    saving,
    saveProgress,
    saveError,
  } = useProjectStore();
  const { datasets, activeDatasetId, setActiveDataset, refreshDatasets, statusInfo } = useDataStore();
  const { openProject } = useProjectStore();
  const { record: recordHistory, createSnapshot, restoreSnapshot, deleteSnapshot, reset: resetHistory } = useHistoryStore();
  const graphBuilders = useGraphBuilderStore((s) => s.items);
  const tabulates = useTabulateStore((s) => s.items);
  const addGraphBuilder = useGraphBuilderStore((s) => s.addItem);
  const renameGraphBuilder = useGraphBuilderStore((s) => s.renameItem);
  const deleteGraphBuilder = useGraphBuilderStore((s) => s.deleteItem);
  const deleteGraphBuildersByDataset = useGraphBuilderStore((s) => s.deleteByDataset);
  const resetGraphBuilders = useGraphBuilderStore((s) => s.reset);
  const loadGraphBuildersFromProject = useGraphBuilderStore((s) => s.loadFromProject);
  const gbCounter = useGraphBuilderStore((s) => s.counter);
  const bumpGbCounter = useGraphBuilderStore((s) => s.bumpCounter);
  const addTabulate = useTabulateStore((s) => s.addItem);
  const renameTabulate = useTabulateStore((s) => s.renameItem);
  const deleteTabulate = useTabulateStore((s) => s.deleteItem);
  const resetTabulates = useTabulateStore((s) => s.reset);
  const loadTabulatesFromProject = useTabulateStore((s) => s.loadFromProject);
  const [activeTab, setActiveTab] = useState<"files" | "history">("files");
  /** 当前选中项的类型与 ID。代替原有的 viewMode 机制。 */
  const [activeGraphBuilderId, setActiveGraphBuilderId] = useState<string | null>(null);
  const [activeTabulateId, setActiveTabulateId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [showPrefs, setShowPrefs] = useState(false);
  const [showSqlQuery, setShowSqlQuery] = useState(false);
  const [helpDialog, setHelpDialog] = useState<"about" | "license" | null>(null);
  const [tableOp, setTableOp] = useState<TableOpType | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const toastTimerRef = useRef<number | null>(null);

  // Folder tree state ------------------------------------------------------
  const folders = useFolderStore((s) => s.folders);
  const tableFolders = useFolderStore((s) => s.tableFolders);
  const graphFolders = useFolderStore((s) => s.graphFolders);
  const tabulateFolders = useFolderStore((s) => s.tabulateFolders);
  const collapsedFolders = useFolderStore((s) => s.collapsed);
  const fsCreateFolder = useFolderStore((s) => s.createFolder);
  const fsRenameFolder = useFolderStore((s) => s.renameFolder);
  const fsDeleteFolder = useFolderStore((s) => s.deleteFolder);
  const fsMoveFolder = useFolderStore((s) => s.moveFolder);
  const fsSetTableFolder = useFolderStore((s) => s.setTableFolder);
  const fsSetGraphFolder = useFolderStore((s) => s.setGraphFolder);
  const fsSetTabulateFolder = useFolderStore((s) => s.setTabulateFolder);
  const fsToggleCollapsed = useFolderStore((s) => s.toggleCollapsed);
  const fsCollapseAll = useFolderStore((s) => s.collapseAll);
  const fsLoadFromProject = useFolderStore((s) => s.loadFromProject);
  const fsPrune = useFolderStore((s) => s.pruneAssignments);
  const fsReset = useFolderStore((s) => s.reset);

  // Per-context renaming for folders is separate from the existing
  // `renamingId` (used for tables/graphs) so a folder rename in progress
  // doesn't clobber a table rename or vice versa.
  const [renamingFolder, setRenamingFolder] = useState<string | null>(null);
  const [folderRenameValue, setFolderRenameValue] = useState("");
  // Drag-and-drop target highlight; null = nothing being hovered as a target.
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  /** Unified context menu — handles tables, graphs, folders, and the empty
   *  whitespace below the tree (which lets the user create a root folder). */
  type CtxMenu =
    | { kind: "table"; id: string; x: number; y: number }
    | { kind: "graph"; id: string; x: number; y: number }
    | { kind: "tabulate"; id: string; x: number; y: number }
    | { kind: "folder"; path: string; x: number; y: number }
    | { kind: "empty"; x: number; y: number };
  const [ctxMenu, setCtxMenu] = useState<CtxMenu | null>(null);
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
  const [busyProgress, setBusyProgress] = useState<{ rowsDone: number; rowsTotal: number } | null>(null);
  const [tableKey, setTableKey] = useState(0);
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
    // Force DataTableView to remount and reload data
    setTableKey((k) => k + 1);
  }, [refreshDatasets, activeDatasetId, setActiveDataset]);

  useEffect(() => {
    refreshDatasets();
  }, []);

  useEffect(() => () => {
    if (toastTimerRef.current !== null) {
      window.clearTimeout(toastTimerRef.current);
    }
  }, []);

  // Dismiss the unified context menu on outside click.
  useEffect(() => {
    if (!ctxMenu) return;
    const handler = () => setCtxMenu(null);
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [ctxMenu]);

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

  // Whenever the set of live datasets or graph builders changes, drop any
  // folder→item assignments that point at items which no longer exist.
  // This keeps tableFolders / graphFolders from accumulating stale ids after
  // deletes or after restoring a snapshot that strips some tables.
  useEffect(() => {
    const dsIds = new Set(datasets.map((d) => d.id));
    const gbIds = new Set(graphBuilders.map((g) => g.id));
    const tabulateIds = new Set(tabulates.map((item) => item.id));
    fsPrune(dsIds, gbIds, tabulateIds);
  }, [datasets, graphBuilders, tabulates, fsPrune]);

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

  // Cmd/Ctrl+N: new data table
  const handleCreateTableRef = useRef<(() => Promise<void>) | null>(null);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "n") {
        e.preventDefault();
        handleCreateTableRef.current?.();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  // Sync counter with existing datasets on load. Detects names produced by
  // any locale's default tableName template by stripping the templated suffix.
  useEffect(() => {
    const maxNum = datasets.reduce((max, ds) => {
      const match = ds.name.match(/(\d+)$/);
      return match ? Math.max(max, parseInt(match[1], 10)) : max;
    }, 0);
    if (maxNum > tableCounter.current) tableCounter.current = maxNum;
  }, [datasets]);

  const handleCreateTable = async () => {
    if (readOnly) return;
    tableCounter.current += 1;
    const name = `Table${tableCounter.current}`;
    const meta = await dataService.createTable(name, [], []);
    await refreshDatasets();
    markDirty();
    setActiveGraphBuilderId(null);
    setActiveTabulateId(null);
    setActiveDataset(meta.id);
    recordAction(t("history.newTable", { name }));
    // Enter rename mode
    setRenamingId(meta.id);
    setRenameValue(name);
  };
  handleCreateTableRef.current = handleCreateTable;

  /** 新建一个图表构建器项，绑定到当前选中数据表 */
  const handleCreateGraphBuilder = () => {
    if (readOnly) return;
    if (!activeDatasetId) {
      alert(t("alert.selectDatasetFirst"));
      return;
    }
    const ds = datasets.find((d) => d.id === activeDatasetId);
    if (!ds) return;
    const nextNum = gbCounter + 1;
    bumpGbCounter(nextNum);
    const id =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `gb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    // Per-table sequential numbering: scan existing graph builders bound to
    // the same dataset, look at names matching `${ds.name} - Graph<N>`, and
    // pick the next N.
    const prefix = `${ds.name} - Graph`;
    const perTableMax = graphBuilders
      .filter((g) => g.sourceDatasetId === ds.id)
      .reduce((max, g) => {
        if (!g.name.startsWith(prefix)) return max;
        const n = parseInt(g.name.slice(prefix.length), 10);
        return Number.isFinite(n) && n > max ? n : max;
      }, 0);
    const name = `${ds.name} - Graph${perTableMax + 1}`;
    const item: GraphBuilderItem = {
      id,
      name,
      sourceDatasetId: ds.id,
      encoding: {},
      elements: [{ kind: "points", enabled: true }],
      smootherLambda: 0.4,
      createdAt: new Date().toISOString(),
    };
    addGraphBuilder(item);
    setActiveDataset(null);
    setActiveGraphBuilderId(id);
    setActiveTabulateId(null);
    markDirty();
    recordAction(t("history.newGraph", { name, source: ds.name }));
    setRenamingId(id);
    setRenameValue(name);
  };

  const handleCreateTabulate = () => {
    if (readOnly) return;
    if (!activeDatasetId) {
      return;
    }
    const ds = datasets.find((d) => d.id === activeDatasetId);
    if (!ds) return;
    const id = crypto.randomUUID();
    const item: TabulateItem = {
      id,
      name: useTabulateStore.getState().nextName(),
      sourceDatasetId: activeDatasetId,
      rowFields: [],
      columnFields: [],
      statistics: [],
      includeRowTotals: true,
      includeColumnTotals: true,
      createdAt: new Date().toISOString(),
    };
    addTabulate(item);
    setActiveDataset(null);
    setActiveGraphBuilderId(null);
    setActiveTabulateId(id);
    markDirty();
    recordAction(t("history.newTabulate", { name: item.name, source: ds.name }));
    setRenamingId(id);
    setRenameValue(item.name);
  };

  const handleRenameSubmit = async (id: string) => {
    if (readOnly) {
      setRenamingId(null);
      return;
    }
    const trimmed = renameValue.trim();
    if (!trimmed) {
      setRenamingId(null);
      return;
    }
    // 是图表项还是数据表？
    const gb = useGraphBuilderStore.getState().items.find((it) => it.id === id);
    if (gb) {
      if (trimmed !== gb.name) {
        renameGraphBuilder(id, trimmed);
        markDirty();
        recordAction(t("history.renameGraph", { old: gb.name, new: trimmed }));
      }
      setRenamingId(null);
      return;
    }
    const tabulate = useTabulateStore.getState().items.find((it) => it.id === id);
    if (tabulate) {
      if (trimmed !== tabulate.name) {
        renameTabulate(id, trimmed);
        markDirty();
        recordAction(t("history.renameTabulate", { old: tabulate.name, new: trimmed }));
      }
      setRenamingId(null);
      return;
    }
    const oldName = datasets.find((d) => d.id === id)?.name;
    if (trimmed !== oldName) {
      await dataService.renameDataset(id, trimmed);
      await refreshDatasets();
      markDirty();
      recordAction(t("history.renameTable", { old: oldName ?? "", new: trimmed }));
    }
    setRenamingId(null);
  };

  const handleDeleteGraphBuilder = (id: string) => {
    const it = useGraphBuilderStore.getState().items.find((x) => x.id === id);
    deleteGraphBuilder(id);
    if (activeGraphBuilderId === id) setActiveGraphBuilderId(null);
    markDirty();
    if (it) recordAction(t("history.deleteGraph", { name: it.name }));
  };

  const handleDeleteTabulate = (id: string) => {
    const item = useTabulateStore.getState().items.find((entry) => entry.id === id);
    deleteTabulate(id);
    if (activeTabulateId === id) setActiveTabulateId(null);
    markDirty();
    if (item) recordAction(t("history.deleteTabulate", { name: item.name }));
  };

  const handleDeleteDataset = async (id: string) => {
    const name = datasets.find((d) => d.id === id)?.name ?? id;
    await dataService.deleteDataset(id);
    if (activeDatasetId === id) setActiveDataset(null);
    // 联动删除引用此数据表的图表
    deleteGraphBuildersByDataset(id);
    if (activeGraphBuilderId) {
      const stillExists = useGraphBuilderStore
        .getState()
        .items.find((it) => it.id === activeGraphBuilderId);
      if (!stillExists) setActiveGraphBuilderId(null);
    }
    await refreshDatasets();
    markDirty();
    recordAction(t("history.deleteTable", { name }));
  };

  const handleImportCsv = async () => {
    const selected = await open({
      title: t("menu.importCsv"),
      filters: [{ name: "CSV", extensions: ["csv"] }],
      multiple: false,
    });
    if (selected) {
      await dataService.importFile(selected as string);
      await refreshDatasets();
      markDirty();
      const fileName = (selected as string).split(/[\\/]/).pop() ?? "CSV";
      recordAction(t("history.importCsv", { file: fileName }));
    }
  };

  const handleImportSqlite = async () => {
    const selected = await open({
      title: t("menu.importSqlite"),
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
        setImportProgress({ tableName: t("common.preparing"), tableIndex: 0, tableTotal: 0, rowsDone: 0, rowsTotal: 0 });
        await ioService.importSqlite(selected as string);
        await refreshDatasets();
        markDirty();
        const fileName = (selected as string).split(/[\\\\/]/).pop() ?? "SQLite";
        recordAction(t("history.importSqlite", { file: fileName }));
      } catch (e) {
        alert(t("alert.importSqliteFailed") + String(e));
      } finally {
        unlisten();
        setImportProgress(null);
      }
    }
  };

  const handleExportSqlite = async () => {
    const filePath = await save({
      title: t("menu.exportSqlite"),
      defaultPath: `${project?.name ?? "export"}.db`,
      filters: [{ name: "SQLite", extensions: ["db", "sqlite", "sqlite3"] }],
    });
    if (filePath) {
      try {
        // Menu-bar "Export → SQLite": dump every table into one .db, using
        // `folder-tablename` names so users can still tell which folder a
        // table came from after extraction (SQLite has no nested namespaces).
        const ids = datasets.map((d) => d.id);
        await ioService.exportSqliteSubset(filePath, ids, buildSqliteNames(ids, null));
      } catch (e) {
        alert(t("alert.exportSqliteFailed") + String(e));
      }
    }
  };

  const handleExportCsvZip = async () => {
    const filePath = await save({
      title: t("menu.exportCsv"),
      defaultPath: `${project?.name ?? "export"}.zip`,
      filters: [{ name: "ZIP Archive", extensions: ["zip"] }],
    });
    if (filePath) {
      try {
        // Menu-bar "Export → CSV": dump every table into one .zip preserving
        // the project's folder tree as nested directories inside the archive.
        const ids = datasets.map((d) => d.id);
        await ioService.exportCsvZipSubset(filePath, ids, buildArchivePaths(ids, null, "csv"));
      } catch (e) {
        alert(t("alert.exportCsvFailed") + String(e));
      }
    }
  };

  // ---- Single-table / single-graph share ----------------------------------
  // .sptb / .spgh let users break individual tables and graphs out of the
  // project so they can be shared or re-imported elsewhere.

  const handleExportTableSptb = async () => {
    const ds = datasets.find((d) => d.id === activeDatasetId);
    if (!ds) {
      alert(t("alert.selectTableFirst"));
      return;
    }
    const filePath = await save({
      title: t("menu.exportSptb"),
      defaultPath: `${ds.name}.sptb`,
      filters: [{ name: "StatsPlayground Table", extensions: ["sptb"] }],
    });
    if (!filePath) return;
    try {
      await projectService.exportTable(ds.id, filePath as string);
    } catch (e) {
      alert(t("alert.exportTableFailed") + String(e));
    }
  };

  const handleImportTableSptb = async () => {
    if (busyMessage) return;
    const selected = await open({
      title: t("menu.importSptb"),
      filters: [{ name: "StatsPlayground Table", extensions: ["sptb"] }],
      multiple: false,
    });
    if (!selected) return;
    try {
      setBusyMessage(t("menu.importSptb"));
      const result = await projectService.importTable(selected as string);
      await refreshDatasets();
      // Per issue #7 the .sptb file carries no folder info; the imported
      // table lands at the project root. The user can drag it into a
      // folder afterwards.
      setActiveGraphBuilderId(null);
      setActiveTabulateId(null);
      setActiveDataset(result.id);
      markDirty();
    } catch (e) {
      alert(t("alert.importTableFailed") + String(e));
    } finally {
      setBusyMessage(null);
    }
  };

  const handleExportGraphSpgh = async () => {
    const gb = graphBuilders.find((g) => g.id === activeGraphBuilderId);
    if (!gb) {
      alert(t("alert.selectGraphFirst"));
      return;
    }
    const filePath = await save({
      title: t("menu.exportSpgh"),
      defaultPath: `${gb.name}.spgh`,
      filters: [{ name: "StatsPlayground Graph", extensions: ["spgh"] }],
    });
    if (!filePath) return;
    try {
      await projectService.exportGraph(gb, filePath as string);
    } catch (e) {
      alert(t("alert.exportGraphFailed") + String(e));
    }
  };

  const handleImportGraphSpgh = async () => {
    if (readOnly) return;
    const selected = await open({
      title: t("menu.importSpgh"),
      filters: [{ name: "StatsPlayground Graph", extensions: ["spgh"] }],
      multiple: false,
    });
    if (!selected) return;
    try {
      const raw = await projectService.importGraph(selected as string);
      const item = raw as GraphBuilderItem;
      // Avoid id collision with anything already loaded.
      const existingIds = new Set(graphBuilders.map((g) => g.id));
      let id = item.id;
      if (!id || existingIds.has(id)) {
        id = `gb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      }
      addGraphBuilder({ ...item, id });
      setActiveDataset(null);
      setActiveTabulateId(null);
      setActiveGraphBuilderId(id);
      markDirty();
    } catch (e) {
      alert(t("alert.importGraphFailed") + String(e));
    }
  };

  const handleSave = async () => {
    if (saving) return;
    const { snapshots } = useHistoryStore.getState();
    const gbItems = useGraphBuilderStore.getState().items;
    // History is session-only (not persisted); only snapshots are saved.
    // Per issue #7 folder routing for both tables and graphs flows OUT-OF-BAND
    // via the folderPayload — the file bodies (.sptb / .spgh) themselves
    // never carry a `folder` field. The backend uses tableFolders and
    // graphFolders to derive each file's path inside the archive.
    const folderPayload = {
      folders,
      tableFolders,
      graphFolders,
      tabulateFolders,
    };
    try {
      if (!project?.filePath) {
        const filePath = await save({
          title: t("welcome.saveProjectDialog"),
          defaultPath: "Untitled Project.spprj",
          filters: [{ name: "StatsPlayground Project", extensions: ["spprj"] }],
        });
        if (!filePath) return; // User cancelled
        await saveProject({
          filePath: filePath as string,
          history: [],
          snapshots,
          graphBuilders: gbItems,
          tabulates,
          folders: folderPayload.folders,
          tableFolders: folderPayload.tableFolders,
          graphFolders: folderPayload.graphFolders,
          tabulateFolders: folderPayload.tabulateFolders,
        });
      } else {
        await saveProject({
          history: [],
          snapshots,
          graphBuilders: gbItems,
          tabulates,
          folders: folderPayload.folders,
          tableFolders: folderPayload.tableFolders,
          graphFolders: folderPayload.graphFolders,
          tabulateFolders: folderPayload.tabulateFolders,
        });
      }
      showToast(t("common.saved"), 1500);
    } catch (error) {
      alert(`${t("menu.save")}: ${String(error)}`);
    }
  };
  handleSaveRef.current = handleSave;

  const showToast = (message: string, durationMs: number) => {
    setToastMessage(message);
    if (toastTimerRef.current !== null) {
      window.clearTimeout(toastTimerRef.current);
    }
    toastTimerRef.current = window.setTimeout(() => {
      setToastMessage(null);
      toastTimerRef.current = null;
    }, durationMs);
  };

  const handleCloseProject = async () => {
    setActiveDataset(null);
    setActiveGraphBuilderId(null);
    setActiveTabulateId(null);
    resetHistory();
    resetGraphBuilders();
    resetTabulates();
    fsReset();
    await initProject();
    await refreshDatasets();
    tableCounter.current = 0;
  };

  const handleOpenAnother = async () => {
    const selected = await open({
      title: t("welcome.openProjectDialog"),
      filters: [{ name: "StatsPlayground Project", extensions: ["spprj"] }],
      multiple: false,
    });
    if (selected) {
      setActiveDataset(null);
      setActiveGraphBuilderId(null);
      setActiveTabulateId(null);
      resetHistory();
      resetGraphBuilders();
      resetTabulates();
      setBusyMessage(t("workspace.openingProject"));
      const unlisten = await listen<{
        datasetIndex: number;
        datasetTotal: number;
        datasetName: string;
        rowsDone: number;
        rowsTotal: number;
      }>("open-project-progress", (event) => {
        const { datasetIndex, datasetTotal, datasetName, rowsDone, rowsTotal } = event.payload;
        if (datasetTotal > 0 && datasetIndex < datasetTotal) {
          setBusyMessage(`${t("workspace.openingProject")} ${t("workspace.importProgressTable", { i: datasetIndex + 1, total: datasetTotal, name: datasetName })}`);
          setBusyProgress({ rowsDone, rowsTotal });
        }
      });
      try {
        const result = await openProject(selected as string);
        setActiveDataset(null);
        setActiveGraphBuilderId(null);
        setActiveTabulateId(null);
        resetHistory();
        resetGraphBuilders();
        resetTabulates();
        await refreshDatasets();
        tableCounter.current = 0;
        // Restore snapshots from project file (history is session-only)
        if (result.snapshots.length > 0) {
          const { loadFromProject } = useHistoryStore.getState();
          loadFromProject(
            [],
            result.snapshots as NamedSnapshot[],
          );
        }
        // Restore graph builders
        if (result.graphBuilders && result.graphBuilders.length > 0) {
          loadGraphBuildersFromProject(result.graphBuilders as GraphBuilderItem[]);
        }
        loadTabulatesFromProject((result.tabulates ?? []) as TabulateItem[]);
        // Restore folder tree + table/graph→folder assignments. We do this
        // after datasets/graphs are loaded so a subsequent prune pass keeps
        // assignments in sync with currently-existing items.
        fsLoadFromProject({
          folders: result.folders ?? [],
          tableFolders: result.tableFolders ?? {},
          graphFolders: result.graphFolders ?? {},
          tabulateFolders: result.tabulateFolders ?? {},
        });
        if (result.datasetNameMigrations.length > 0) {
          showToast(
            t("workspace.datasetNameMigrations", { count: result.datasetNameMigrations.length }),
            4000,
          );
        }
      } catch (e) {
        // Surface backend errors so the user isn't left staring at a screen
        // flash with no explanation when an .spprj fails to load.
        alert(t("alert.openProjectFailed", { defaultValue: "Failed to open project: {{msg}}", msg: String(e) }));
      } finally {
        unlisten();
        setBusyProgress(null);
        setBusyMessage(null);
      }
    }
  };

  // ---- Folder-aware export helpers ----------------------------------------
  // These functions all share the same naming convention so the user gets a
  // predictable suggested filename in the OS save dialog:
  //   `${projectName}-${folderName ?? ''}-${itemName}.ext`
  // The middle segment collapses when the item is at the project root.

  /** Build the `${project}-${folder}-${name}.ext` default filename. */
  const suggestFilename = (folder: string | null | undefined, name: string, ext: string) => {
    const proj = (project?.name ?? "project").trim() || "project";
    const folderLabel = folder ? folderBaseName(folder) : "";
    const parts = folderLabel ? [proj, folderLabel, name] : [proj, name];
    // Per-segment cleanup so the dialog suggestion is friendly cross-platform;
    // the user can still edit it before confirming the save.
    const safe = parts
      .map((p) => p.replace(/[\\/:*?"<>|]+/g, "_").trim())
      .filter((p) => p.length > 0)
      .join("-");
    return `${safe || "export"}.${ext}`;
  };

  /** Return ids of all datasets that live under `folder` or any descendant. */
  const datasetIdsUnderFolder = useCallback(
    (folder: string | null): string[] => {
      const allFolders = useFolderStore.getState().folders;
      const allTableFolders = useFolderStore.getState().tableFolders;
      const matchPrefix = folder === null
        ? (_f: string) => true
        : (f: string) => f === folder || f.startsWith(folder + "/");
      // Subset of folders whose ids count: the folder itself plus any
      // descendants. Null parent (root) matches everything.
      const okFolders = new Set<string>(
        folder === null ? allFolders : allFolders.filter(matchPrefix),
      );
      // A table is included if it is unassigned and we're exporting root, or
      // assigned to one of the matching folders.
      return datasets
        .filter((ds) => {
          const f = allTableFolders[ds.id];
          if (!f) return folder === null;
          return okFolders.has(f);
        })
        .map((ds) => ds.id);
    },
    [datasets],
  );

  /** Build a map of `datasetId → archive path` to mirror folder structure
   *  inside a zip. `basePrefix` (e.g. the clicked folder) is stripped so the
   *  paths inside the zip are relative to what the user selected. */
  const buildArchivePaths = (
    ids: string[],
    basePrefix: string | null,
    ext: "csv" | "sptb",
  ): Record<string, string> => {
    void ext; // Extension is appended by the backend; included here only to
              // make call sites self-documenting at the type level.
    const result: Record<string, string> = {};
    const base = basePrefix ?? "";
    for (const id of ids) {
      const ds = datasets.find((d) => d.id === id);
      if (!ds) continue;
      const folder = tableFolders[id] ?? "";
      // Make the folder path inside the zip relative to the user's chosen
      // root. So if the user right-clicked `A/B` and a table lives in
      // `A/B/C`, the zip path becomes `C/Table.csv`.
      let relative = folder;
      if (base && folder.startsWith(base + "/")) {
        relative = folder.slice(base.length + 1);
      } else if (base && folder === base) {
        relative = "";
      }
      result[id] = relative ? `${relative}/${ds.name}` : ds.name;
    }
    return result;
  };

  /** Build a map of `datasetId → SQLite table name` per the user's spec of
   *  `folder-tablename`, with `basePrefix` stripped. */
  const buildSqliteNames = (
    ids: string[],
    basePrefix: string | null,
  ): Record<string, string> => {
    const result: Record<string, string> = {};
    const base = basePrefix ?? "";
    for (const id of ids) {
      const ds = datasets.find((d) => d.id === id);
      if (!ds) continue;
      const folder = tableFolders[id] ?? "";
      let relative = folder;
      if (base && folder.startsWith(base + "/")) {
        relative = folder.slice(base.length + 1);
      } else if (base && folder === base) {
        relative = "";
      }
      // Slash → dash so the assembled name is one flat SQLite identifier.
      const flat = relative.replace(/\//g, "-");
      result[id] = flat ? `${flat}-${ds.name}` : ds.name;
    }
    return result;
  };

  /** Export an individual table to a single .sptb (right-click on table). */
  const handleExportTableSptbFromCtx = async (datasetId: string) => {
    const ds = datasets.find((d) => d.id === datasetId);
    if (!ds) return;
    const folder = tableFolders[datasetId] ?? null;
    const filePath = await save({
      title: t("menu.exportSptb"),
      defaultPath: suggestFilename(folder, ds.name, "sptb"),
      filters: [{ name: "StatsPlayground Table", extensions: ["sptb"] }],
    });
    if (!filePath) return;
    try {
      await projectService.exportTable(ds.id, filePath as string);
    } catch (e) {
      alert(t("alert.exportTableFailed") + String(e));
    }
  };

  /** Export an individual table to a single .csv (right-click on table). */
  const handleExportTableCsvFromCtx = async (datasetId: string) => {
    const ds = datasets.find((d) => d.id === datasetId);
    if (!ds) return;
    const folder = tableFolders[datasetId] ?? null;
    const filePath = await save({
      title: t("table.exportCsvSingle", { defaultValue: "Export as CSV" }),
      defaultPath: suggestFilename(folder, ds.name, "csv"),
      filters: [{ name: "CSV", extensions: ["csv"] }],
    });
    if (!filePath) return;
    try {
      await ioService.exportCsv(ds.id, filePath as string);
    } catch (e) {
      alert(t("alert.exportCsvFailed") + String(e));
    }
  };

  /** Export an individual table into its own single-table .sqlite db. */
  const handleExportTableSqliteFromCtx = async (datasetId: string) => {
    const ds = datasets.find((d) => d.id === datasetId);
    if (!ds) return;
    const folder = tableFolders[datasetId] ?? null;
    const filePath = await save({
      title: t("table.exportSqliteSingle", { defaultValue: "Export as SQLite" }),
      defaultPath: suggestFilename(folder, ds.name, "db"),
      filters: [{ name: "SQLite", extensions: ["db", "sqlite", "sqlite3"] }],
    });
    if (!filePath) return;
    try {
      // Single-table export: just pass the one id, no name override needed.
      await ioService.exportSqliteSubset(filePath as string, [ds.id], {});
    } catch (e) {
      alert(t("alert.exportSqliteFailed") + String(e));
    }
  };

  /** Export every table under a folder as a zip of .sptb files. */
  const handleExportFolderSptbZip = async (folderPath: string) => {
    const ids = datasetIdsUnderFolder(folderPath);
    if (ids.length === 0) return;
    const folderName = folderBaseName(folderPath);
    const filePath = await save({
      title: t("folder.exportSptbZip", { defaultValue: "Export folder as .sptb (zip)" }),
      defaultPath: suggestFilename(folderPath, folderName, "zip"),
      filters: [{ name: "ZIP Archive", extensions: ["zip"] }],
    });
    if (!filePath) return;
    try {
      await projectService.exportTablesSptbZip(
        ids,
        filePath as string,
        buildArchivePaths(ids, folderPath, "sptb"),
      );
    } catch (e) {
      alert(t("alert.exportTableFailed") + String(e));
    }
  };

  /** Export every table under a folder as a zip of CSVs. */
  const handleExportFolderCsvZip = async (folderPath: string) => {
    const ids = datasetIdsUnderFolder(folderPath);
    if (ids.length === 0) return;
    const folderName = folderBaseName(folderPath);
    const filePath = await save({
      title: t("folder.exportCsvZip", { defaultValue: "Export folder as CSV (zip)" }),
      defaultPath: suggestFilename(folderPath, folderName, "zip"),
      filters: [{ name: "ZIP Archive", extensions: ["zip"] }],
    });
    if (!filePath) return;
    try {
      await ioService.exportCsvZipSubset(
        filePath as string,
        ids,
        buildArchivePaths(ids, folderPath, "csv"),
      );
    } catch (e) {
      alert(t("alert.exportCsvFailed") + String(e));
    }
  };

  /** Export every table under a folder into a single multi-table SQLite. */
  const handleExportFolderSqlite = async (folderPath: string) => {
    const ids = datasetIdsUnderFolder(folderPath);
    if (ids.length === 0) return;
    const folderName = folderBaseName(folderPath);
    const filePath = await save({
      title: t("folder.exportSqlite", { defaultValue: "Export folder as SQLite" }),
      defaultPath: suggestFilename(folderPath, folderName, "db"),
      filters: [{ name: "SQLite", extensions: ["db", "sqlite", "sqlite3"] }],
    });
    if (!filePath) return;
    try {
      await ioService.exportSqliteSubset(
        filePath as string,
        ids,
        buildSqliteNames(ids, folderPath),
      );
    } catch (e) {
      alert(t("alert.exportSqliteFailed") + String(e));
    }
  };

  // ---- Folder mutation helpers wired to the side-panel UI ----------------

  /** Prompt-less "New folder" handler. Creates a folder under `parent` with a
   *  default localized name; the user can immediately rename it via F2 or by
   *  double-clicking. */
  const handleCreateFolder = (parent: string | null) => {
    if (readOnly) return;
    const baseName = t("folder.defaultName", { defaultValue: "New Folder" });
    const newPath = fsCreateFolder(parent, baseName);
    // Make sure the parent folder is expanded so the new child is visible.
    if (parent && collapsedFolders[parent]) fsToggleCollapsed(parent);
    // Drop straight into rename mode for the new folder so the user can name
    // it without an extra click.
    setRenamingFolder(newPath);
    setFolderRenameValue(folderBaseName(newPath));
    markDirty();
  };

  const handleFolderRenameSubmit = (oldPath: string) => {
    if (readOnly) {
      setRenamingFolder(null);
      return;
    }
    const newBase = folderRenameValue.trim();
    if (!newBase) {
      setRenamingFolder(null);
      return;
    }
    const err = validateFolderOrFileName(newBase);
    if (err) {
      alert(t(`alert.invalidName.${err}`, { defaultValue: "Invalid name." }));
      return;
    }
    const newPath = fsRenameFolder(oldPath, newBase);
    if (newPath) markDirty();
    setRenamingFolder(null);
  };

  const handleDeleteFolder = (folderPath: string) => {
    if (readOnly) return;
    // Per user decision: child items are NEVER lost when a folder is deleted —
    // they get promoted to the parent folder. No confirmation prompt is needed
    // because nothing is actually destroyed.
    fsDeleteFolder(folderPath);
    markDirty();
  };

  // ---- Drag-and-drop wiring -----------------------------------------------
  // We use the HTML5 DnD API with a tiny custom MIME-like JSON payload. The
  // payload kind ('table' | 'graph' | 'folder') controls how `onDrop`
  // dispatches into the folder store.
  type DragPayload =
    | { kind: "table"; id: string }
    | { kind: "graph"; id: string }
    | { kind: "tabulate"; id: string }
    | { kind: "folder"; path: string };

  const handleDragStart = (e: React.DragEvent, payload: DragPayload) => {
    e.dataTransfer.setData("application/x-sp-item", JSON.stringify(payload));
    e.dataTransfer.effectAllowed = "move";
  };

  /** True if dropping `payload` onto `target` is allowed.
   *  Disallow dropping a folder onto itself or any of its descendants. */
  const canDropOn = (payload: DragPayload, target: string | null): boolean => {
    if (payload.kind === "folder") {
      if (payload.path === target) return false;
      if (target && target.startsWith(payload.path + "/")) return false;
    }
    return true;
  };

  const handleDropOnFolder = (e: React.DragEvent, target: string | null) => {
    e.preventDefault();
    e.stopPropagation();
    if (readOnly) return;
    setDropTarget(null);
    const raw = e.dataTransfer.getData("application/x-sp-item");
    if (!raw) return;
    let payload: DragPayload;
    try {
      payload = JSON.parse(raw) as DragPayload;
    } catch {
      return;
    }
    if (!canDropOn(payload, target)) return;
    if (payload.kind === "table") fsSetTableFolder(payload.id, target);
    else if (payload.kind === "graph") fsSetGraphFolder(payload.id, target);
    else if (payload.kind === "tabulate") fsSetTabulateFolder(payload.id, target);
    else if (payload.kind === "folder") fsMoveFolder(payload.path, target);
    markDirty();
  };

  const handleDragOverFolder = (e: React.DragEvent, target: string | null) => {
    // Allow drop visually. Note: we don't have access to the payload here
    // (DataTransfer is restricted during dragover for security reasons), so
    // we accept all targets and validate inside `handleDropOnFolder`.
    if (e.dataTransfer.types.includes("application/x-sp-item")) {
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "move";
      // Use a string key for highlight; null becomes "__root__" so React's
      // equality check actually triggers a re-render.
      const key = target ?? "__root__";
      if (dropTarget !== key) setDropTarget(key);
    }
  };

  // ---- Tree structure: group folders + items by parent --------------------
  // Memoize on the (folders, tableFolders, graphFolders, tabulateFolders,
  // datasets, graphBuilders, tabulates) tuple so we only rebuild when something actually changed.
  const tree = useMemo(() => {
    // Children per parent path. Root parent is the magic key `__root__`.
    const ROOT = "__root__";
    const childFolders = new Map<string, string[]>();
    for (const f of folders) {
      const parent = folderParent(f) ?? ROOT;
      const arr = childFolders.get(parent) ?? [];
      arr.push(f);
      childFolders.set(parent, arr);
    }
    // Sort each level alphabetically by basename for stable presentation.
    for (const arr of childFolders.values()) {
      arr.sort((a, b) => folderBaseName(a).localeCompare(folderBaseName(b)));
    }
    // Datasets per parent path.
    const tablesByParent = new Map<string, typeof datasets>();
    for (const ds of datasets) {
      const p = tableFolders[ds.id] ?? ROOT;
      const arr = tablesByParent.get(p) ?? [];
      arr.push(ds);
      tablesByParent.set(p, arr);
    }
    // Graphs per parent path.
    const graphsByParent = new Map<string, GraphBuilderItem[]>();
    for (const gb of graphBuilders) {
      const p = graphFolders[gb.id] ?? ROOT;
      const arr = graphsByParent.get(p) ?? [];
      arr.push(gb);
      graphsByParent.set(p, arr);
    }
    const tabulatesByParent = new Map<string, TabulateItem[]>();
    for (const item of tabulates) {
      const p = tabulateFolders[item.id] ?? ROOT;
      const arr = tabulatesByParent.get(p) ?? [];
      arr.push(item);
      tabulatesByParent.set(p, arr);
    }
    return { ROOT, childFolders, tablesByParent, graphsByParent, tabulatesByParent };
  }, [folders, tableFolders, graphFolders, tabulateFolders, datasets, graphBuilders, tabulates]);

  /** Recursively render one folder level. */
  const renderFolderLevel = (parent: string | null, depth: number): React.ReactNode[] => {
    const ROOT = tree.ROOT;
    const key = parent ?? ROOT;
    const out: React.ReactNode[] = [];
    const folderChildren = tree.childFolders.get(key) ?? [];
    const tableChildren = tree.tablesByParent.get(key) ?? [];
    const graphChildren = tree.graphsByParent.get(key) ?? [];
    const tabulateChildren = tree.tabulatesByParent.get(key) ?? [];
    // Folders first, then tables, then graphs, matching the prior visual order
    // (tables-then-graphs at the root level).
    for (const fp of folderChildren) {
      const isCollapsed = !!collapsedFolders[fp];
      const dropKey = fp;
      const isDropTarget = dropTarget === dropKey;
      out.push(
        <div key={`folder:${fp}`} className={`sp-folder${isDropTarget ? " sp-folder-droptarget" : ""}`}>
          <div
            className="sp-folder-row"
            style={{ paddingLeft: 8 + depth * 12 }}
            draggable={!readOnly}
            onDragStart={(e) => handleDragStart(e, { kind: "folder", path: fp })}
            onDragOver={(e) => handleDragOverFolder(e, fp)}
            onDragLeave={() => setDropTarget((cur) => (cur === fp ? null : cur))}
            onDrop={(e) => handleDropOnFolder(e, fp)}
            onClick={() => fsToggleCollapsed(fp)}
            onDoubleClick={(e) => {
              if (readOnly) return;
              e.stopPropagation();
              setRenamingFolder(fp);
              setFolderRenameValue(folderBaseName(fp));
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setCtxMenu({ kind: "folder", path: fp, x: e.clientX, y: e.clientY });
            }}
          >
            <svg
              className={`sp-folder-chevron${isCollapsed ? "" : " sp-folder-chevron-open"}`}
              width="10"
              height="10"
              viewBox="0 0 24 24"
              fill="currentColor"
            >
              <path d="M8 5l8 7-8 7V5z" />
            </svg>
            <i className="ds-icon fa-solid fa-folder" aria-hidden="true" />
            {renamingFolder === fp ? (
              <input
                className="ds-rename-input"
                value={folderRenameValue}
                onChange={(e) => setFolderRenameValue(e.target.value)}
                onBlur={() => handleFolderRenameSubmit(fp)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleFolderRenameSubmit(fp);
                  if (e.key === "Escape") setRenamingFolder(null);
                }}
                onClick={(e) => e.stopPropagation()}
                autoFocus
              />
            ) : (
              <span className="ds-name">{folderBaseName(fp)}</span>
            )}
          </div>
          {!isCollapsed && (
            <div className="sp-folder-children">{renderFolderLevel(fp, depth + 1)}</div>
          )}
        </div>,
      );
    }
    for (const ds of tableChildren) {
      out.push(
        <div
          key={`table:${ds.id}`}
          className={`dataset-item ${activeDatasetId === ds.id ? "active" : ""}`}
          style={{ paddingLeft: 8 + depth * 12 + 12 }}
          draggable={!readOnly}
          onDragStart={(e) => handleDragStart(e, { kind: "table", id: ds.id })}
          onClick={() => {
            setActiveGraphBuilderId(null);
            setActiveTabulateId(null);
            setActiveDataset(ds.id);
          }}
          onDoubleClick={() => {
            if (readOnly) return;
            setRenamingId(ds.id);
            setRenameValue(ds.name);
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setCtxMenu({ kind: "table", id: ds.id, x: e.clientX, y: e.clientY });
          }}
        >
          <i className="ds-icon fa-solid fa-table" aria-hidden="true" />
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
        </div>,
      );
    }
    for (const gb of graphChildren) {
      const sourceDs = datasets.find((d) => d.id === gb.sourceDatasetId);
      out.push(
        <div
          key={`graph:${gb.id}`}
          className={`dataset-item ${activeGraphBuilderId === gb.id ? "active" : ""}`}
          style={{ paddingLeft: 8 + depth * 12 + 12 }}
          draggable={!readOnly}
          onDragStart={(e) => handleDragStart(e, { kind: "graph", id: gb.id })}
          onClick={() => {
            setActiveDataset(null);
            setActiveTabulateId(null);
            setActiveGraphBuilderId(gb.id);
          }}
          onDoubleClick={() => {
            if (readOnly) return;
            setRenamingId(gb.id);
            setRenameValue(gb.name);
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setCtxMenu({ kind: "graph", id: gb.id, x: e.clientX, y: e.clientY });
          }}
          title={sourceDs ? t("workspace.datasourceLabel", { name: sourceDs.name }) : t("workspace.datasourceDeleted")}
        >
          <i className="ds-icon fa-solid fa-chart-pie" aria-hidden="true" />
          {renamingId === gb.id ? (
            <input
              ref={renameInputRef}
              className="ds-rename-input"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onBlur={() => handleRenameSubmit(gb.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleRenameSubmit(gb.id);
                if (e.key === "Escape") setRenamingId(null);
              }}
              onClick={(e) => e.stopPropagation()}
              autoFocus
            />
          ) : (
            <span className="ds-name">{gb.name}</span>
          )}
          <span className="ds-info gb-source-tag">
            {sourceDs ? sourceDs.name : t("workspace.datasourceMissing")}
          </span>
        </div>,
      );
    }
    for (const item of tabulateChildren) {
      const sourceDs = datasets.find((d) => d.id === item.sourceDatasetId);
      out.push(
        <div
          key={`tabulate:${item.id}`}
          className={`dataset-item ${activeTabulateId === item.id ? "active" : ""}`}
          style={{ paddingLeft: 8 + depth * 12 + 12 }}
          draggable={!readOnly}
          onDragStart={(e) => handleDragStart(e, { kind: "tabulate", id: item.id })}
          onClick={() => {
            setActiveDataset(null);
            setActiveGraphBuilderId(null);
            setActiveTabulateId(item.id);
          }}
          onDoubleClick={() => {
            if (readOnly) return;
            setRenamingId(item.id);
            setRenameValue(item.name);
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setCtxMenu({ kind: "tabulate", id: item.id, x: e.clientX, y: e.clientY });
          }}
          title={sourceDs ? t("workspace.datasourceLabel", { name: sourceDs.name }) : t("workspace.tabulateSourceMissing")}
        >
          <i className="ds-icon fa-solid fa-table-cells-large" aria-hidden="true" />
          {renamingId === item.id ? (
            <input
              ref={renameInputRef}
              className="ds-rename-input"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onBlur={() => handleRenameSubmit(item.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleRenameSubmit(item.id);
                if (e.key === "Escape") setRenamingId(null);
              }}
              onClick={(e) => e.stopPropagation()}
              autoFocus
            />
          ) : (
            <span className="ds-name">{item.name}</span>
          )}
          <span className="ds-info gb-source-tag">
            {sourceDs ? sourceDs.name : t("workspace.tabulateSourceMissing")}
          </span>
        </div>,
      );
    }
    return out;
  };

  return (
    <div className="app">
      {/* Menu Bar */}
      <div className="menu-bar">
        <span className="menu-bar-title">StatsPlayground</span>
        <div className="menu-bar-menus">
          <MenuBar>
            <MenuDropdown label={t("menu.file")}>
              <div className={`menu-item${saving ? " menu-item-disabled" : ""}`} onClick={saving ? undefined : handleSave}>{t("menu.save")}<span className="menu-shortcut">{modKey}S</span></div>
              <div className="menu-sep" />
              <div className="menu-item" onClick={() => setShowPrefs(true)}>{t("menu.preferences")}<span className="menu-shortcut">{modKey},</span></div>
              <div className="menu-sep" />
              <div className="menu-item" onClick={handleOpenAnother}>{t("menu.openProject")}<span className="menu-shortcut">{modKey}O</span></div>
              <div className="menu-item" onClick={handleCloseProject}>{t("menu.closeProject")}</div>
            </MenuDropdown>
            <MenuDropdown label={t("menu.table")}>
              <div className={`menu-item${readOnly ? " menu-item-disabled" : ""}`} onClick={readOnly ? undefined : handleCreateTable}>{t("menu.newTable")}<span className="menu-shortcut">{modKey}N</span></div>
              <div className="menu-sep" />
              <div className={`menu-item${readOnly ? " menu-item-disabled" : ""}`} onClick={readOnly ? undefined : handleImportCsv}>{t("menu.importCsv")}</div>
              <div className={`menu-item${readOnly ? " menu-item-disabled" : ""}`} onClick={readOnly ? undefined : handleImportSqlite}>{t("menu.importSqlite")}</div>
              <div className="menu-sep" />
              <div className="menu-item" onClick={handleExportSqlite}>{t("menu.exportSqlite")}</div>
              <div className="menu-item" onClick={handleExportCsvZip}>{t("menu.exportCsv")}</div>
              <div className="menu-sep" />
              <div className="menu-item" onClick={handleExportTableSptb}>{t("menu.exportSptb")}</div>
              <div className={`menu-item${readOnly ? " menu-item-disabled" : ""}`} onClick={readOnly ? undefined : handleImportTableSptb}>{t("menu.importSptb")}</div>
            </MenuDropdown>
            <MenuDropdown label={t("menu.data")}>
              <div className="menu-item" onClick={() => setShowSqlQuery(true)}>{t("menu.sqlQuery")}</div>
            </MenuDropdown>
            <MenuDropdown label={t("menu.graph")}>
              <div className={`menu-item${readOnly ? " menu-item-disabled" : ""}`} onClick={readOnly ? undefined : handleCreateGraphBuilder}>{t("menu.newGraph")}</div>
              <div className="menu-sep" />
              <div className="menu-item" onClick={handleExportGraphSpgh}>{t("menu.exportSpgh")}</div>
              <div className={`menu-item${readOnly ? " menu-item-disabled" : ""}`} onClick={readOnly ? undefined : handleImportGraphSpgh}>{t("menu.importSpgh")}</div>
            </MenuDropdown>
            <MenuDropdown label={t("menu.analyze")}>
              <div
                className={`menu-item${activeDatasetId && !readOnly ? "" : " menu-item-disabled"}`}
                onClick={activeDatasetId && !readOnly ? handleCreateTabulate : undefined}
              >
                {t("menu.tabulate")}
              </div>
            </MenuDropdown>
            <MenuDropdown label={t("menu.help")}>
              <div className="menu-item" onClick={() => setHelpDialog("about")}>{t("menu.about")}</div>
              <div className="menu-item" onClick={() => setHelpDialog("license")}>{t("menu.license")}</div>
            </MenuDropdown>
          </MenuBar>
        </div>
        <div className="menu-spacer" />
        <button
          className={`menu-bar-snapshot${dirty ? " menu-bar-snapshot-dirty" : ""}`}
          disabled={readOnly}
          onClick={async () => {
            if (readOnly) return;
            setBusyMessage(t("workspace.creatingSnapshot"));
            const unlisten = await listen<{
              datasetIndex: number;
              datasetTotal: number;
              datasetName: string;
            }>("snapshot-progress", (event) => {
              const { datasetIndex, datasetTotal, datasetName } = event.payload;
              if (datasetTotal > 0 && datasetIndex < datasetTotal) {
                setBusyMessage(`${t("workspace.creatingSnapshot")} ${t("workspace.importProgressTable", { i: datasetIndex + 1, total: datasetTotal, name: datasetName })}`);
              }
            });
            try {
              await createSnapshot();
            } finally {
              unlisten();
              setBusyMessage(null);
            }
          }}
          title={t("workspace.createSnapshotTitle")}
        >
          <i className="fa-solid fa-camera" aria-hidden="true" />
        </button>
        <button
          className={`menu-bar-save${dirty ? " menu-bar-save-dirty" : ""}`}
          disabled={saving}
          onClick={handleSave}
          title={t("common.saveWith", { key: modKey })}
        >
          <i className="fa-solid fa-floppy-disk" aria-hidden="true" />
        </button>
      </div>

      {/* Workspace */}
      <div className="workspace">
        {/* Activity Bar (VS Code-style) */}
        <div className="activity-bar">
          <button
            className={`activity-btn${activeTab === "files" ? " activity-btn-active" : ""}`}
            onClick={() => setActiveTab("files")}
            title={t("workspace.directory")}
          >
            <svg width="22" height="22" viewBox="0 0 640 640" fill="currentColor">
              <path d="M104 112C90.7 112 80 122.7 80 136L80 184C80 197.3 90.7 208 104 208L152 208C165.3 208 176 197.3 176 184L176 136C176 122.7 165.3 112 152 112L104 112zM256 128C238.3 128 224 142.3 224 160C224 177.7 238.3 192 256 192L544 192C561.7 192 576 177.7 576 160C576 142.3 561.7 128 544 128L256 128zM256 288C238.3 288 224 302.3 224 320C224 337.7 238.3 352 256 352L544 352C561.7 352 576 337.7 576 320C576 302.3 561.7 288 544 288L256 288zM256 448C238.3 448 224 462.3 224 480C224 497.7 238.3 512 256 512L544 512C561.7 512 576 497.7 576 480C576 462.3 561.7 448 544 448L256 448zM80 296L80 344C80 357.3 90.7 368 104 368L152 368C165.3 368 176 357.3 176 344L176 296C176 282.7 165.3 272 152 272L104 272C90.7 272 80 282.7 80 296zM104 432C90.7 432 80 442.7 80 456L80 504C80 517.3 90.7 528 104 528L152 528C165.3 528 176 517.3 176 504L176 456C176 442.7 165.3 432 152 432L104 432z"/>
            </svg>
          </button>
          <button
            className={`activity-btn${activeTab === "history" ? " activity-btn-active" : ""}`}
            onClick={() => setActiveTab("history")}
            title={`${t("history.title")} & ${t("history.snapshot")}`}
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
                <h3>{t("workspace.directory")}</h3>
                <div className="panel-actions">
                  <button
                    className="panel-action-btn"
                    title={t("menu.newFolder", { defaultValue: "New Folder" })}
                    onClick={readOnly ? undefined : (() => handleCreateFolder(null))}
                    disabled={readOnly}
                  >
                    <i className="fa-solid fa-folder-plus" aria-hidden="true" />
                  </button>
                  <button
                    className="panel-action-btn"
                    title={t("menu.collapseAll", { defaultValue: "Collapse All" })}
                    onClick={() => fsCollapseAll()}
                  >
                    <i className="fa-solid fa-down-left-and-up-right-to-center" aria-hidden="true" />
                  </button>
                </div>
              </div>
              <div
                className={`dataset-list${dropTarget === "__root__" ? " sp-droptarget-root" : ""}`}
                onDragOver={(e) => handleDragOverFolder(e, null)}
                onDragLeave={() => setDropTarget((cur) => (cur === "__root__" ? null : cur))}
                onDrop={(e) => handleDropOnFolder(e, null)}
                onContextMenu={(e) => {
                  // Right-click on empty whitespace → create a root folder.
                  // Only fire when the click target is the container itself
                  // so it doesn't shadow per-item menus.
                  if (e.target === e.currentTarget) {
                    e.preventDefault();
                    setCtxMenu({ kind: "empty", x: e.clientX, y: e.clientY });
                  }
                }}
              >
                {datasets.length === 0 && graphBuilders.length === 0 && tabulates.length === 0 && folders.length === 0 ? (
                  <div className="empty-hint">{t("common.noContent")}</div>
                ) : (
                  renderFolderLevel(null, 0)
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
          {activeTabulateId ? (
            (() => {
              const item = tabulates.find((entry) => entry.id === activeTabulateId);
              if (!item) {
                return <div className="main-content"><div className="workspace-empty"><p>{t("workspace.tabulateMissing", { defaultValue: "Tabulate no longer exists" })}</p></div></div>;
              }
              const ds = datasets.find((d) => d.id === item.sourceDatasetId);
              return (
                <TabulateView
                  item={item}
                  dataset={ds}
                  onTableCreated={async (dataset) => {
                    await refreshDatasets();
                    markDirty();
                    setActiveGraphBuilderId(null);
                    setActiveTabulateId(null);
                    setActiveDataset(dataset.id);
                    recordAction(t("history.tabulateTableCreated", { name: dataset.name }));
                  }}
                />
              );
            })()
          ) : activeGraphBuilderId ? (
            (() => {
              const item = graphBuilders.find((g) => g.id === activeGraphBuilderId);
              if (!item) return <div className="main-content"><div className="workspace-empty"><p>{t("workspace.graphMissing")}</p></div></div>;
              const ds = datasets.find((d) => d.id === item.sourceDatasetId);
              if (!ds) return <div className="main-content"><div className="workspace-empty"><p>{t("workspace.datasourceDeleted")}</p></div></div>;
              return <GraphBuilderView item={item} dataset={ds} />;
            })()
          ) : activeDatasetId ? (
            <DataTableView key={tableKey} datasetId={activeDatasetId} onTableOp={setTableOp} />
          ) : (
            <div className="main-content">
              <div className="workspace-empty">
                <p>{t("workspace.selectOrCreate")}</p>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Status Bar */}
      <div className="status-bar">
        <span>{project?.name}</span>
        <span>{t("workspace.datasetCount", { n: datasets.length })}</span>
        {readOnly && <span>{t("workspace.readOnlyWhileSaving", { defaultValue: "Read-only while saving" })}</span>}
        <span className="status-spacer" />
        {statusInfo?.selectionStats && (
          <span className="status-stats">
            {statusInfo.selectionStats.avg != null && (
              <>
                <span>{t("workspace.statMean")}{formatStat(statusInfo.selectionStats.avg)}</span>
                <span>{t("workspace.statMin")}{formatStat(statusInfo.selectionStats.min!)}</span>
                <span>{t("workspace.statMax")}{formatStat(statusInfo.selectionStats.max!)}</span>
                <span>{t("workspace.statSum")}{formatStat(statusInfo.selectionStats.sum!)}</span>
              </>
            )}
            <span>{t("workspace.statCount")}{statusInfo.selectionStats.count}</span>
          </span>
        )}
        {(statusInfo?.selectionLabel || statusInfo?.cellLabel) && (
          <span>{statusInfo.selectionLabel || statusInfo.cellLabel}</span>
        )}
        {statusInfo?.dimensions && <span>{statusInfo.dimensions}</span>}
        {activeDatasetId && <TableZoomControl />}
        {saving && (
          <span>
            {t("workspace.savingProject", { defaultValue: "Saving project…" })}
            {saveProgress?.phase
              ? ` · ${t(`workspace.savePhase.${saveProgress.phase}`, { defaultValue: saveProgress.phase })}`
              : ""}
            {saveProgress?.tableTotal
              ? ` · ${t("workspace.importProgressTable", {
                  i: Math.min(saveProgress.tableIndex + 1, saveProgress.tableTotal),
                  total: saveProgress.tableTotal,
                  name: saveProgress.tableName ?? "",
                })}`
              : ""}
            {saveProgress?.rowsTotal
              ? ` · ${saveProgress.rowsDone.toLocaleString()}/${saveProgress.rowsTotal.toLocaleString()} ${t("workspace.importProgressRows")}`
              : ""}
            {typeof saveProgress?.overallProgress === "number"
              ? ` · ${Math.round(saveProgress.overallProgress * 100)}%`
              : ""}
          </span>
        )}
        {!saving && saveError && <span>{saveError}</span>}
      </div>

      {showPrefs && <PreferencesDialog onClose={() => setShowPrefs(false)} />}

      {helpDialog && <HelpDialog mode={helpDialog} onClose={() => setHelpDialog(null)} />}

      {tableOp && (
        <TableOpsDialog
          op={tableOp}
          datasets={datasets}
          activeDatasetId={activeDatasetId}
          onClose={() => setTableOp(null)}
          onCreated={async (ds) => {
            await refreshDatasets();
            setActiveDataset(ds.id);
            markDirty();
          }}
          onUpdated={async () => {
            await refreshDatasets();
            setTableKey(k => k + 1);
            markDirty();
          }}
        />
      )}

      {showSqlQuery && (
        <SqlQueryDialog
          datasets={datasets}
          tableFolders={tableFolders}
          onClose={() => setShowSqlQuery(false)}
          onCreated={async (dataset) => {
            await refreshDatasets();
            setActiveGraphBuilderId(null);
            setActiveDataset(dataset.id);
            markDirty();
            recordAction(t("history.sqlQueryTableCreated", { name: dataset.name }));
            setShowSqlQuery(false);
          }}
        />
      )}

      {importProgress && (
        <div className="sp-dialog-overlay">
          <div className="sp-dialog" style={{ minWidth: 360, padding: "20px 24px" }}>
            <div style={{ fontWeight: 600, marginBottom: 12 }}>{t("workspace.importingSqlite")}</div>
            <div style={{ fontSize: 13, marginBottom: 8, color: "var(--fg-secondary, #888)" }}>
              {importProgress.tableTotal > 0
                ? t("workspace.importProgressTable", { i: importProgress.tableIndex + 1, total: importProgress.tableTotal, name: importProgress.tableName })
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
                  {importProgress.rowsDone.toLocaleString()} / {importProgress.rowsTotal.toLocaleString()} {t("workspace.importProgressRows")}
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
              <div
                className={`sp-progress-fill${busyProgress?.rowsTotal ? "" : " sp-progress-indeterminate"}`}
                style={busyProgress?.rowsTotal
                  ? { width: `${Math.round((busyProgress.rowsDone / busyProgress.rowsTotal) * 100)}%` }
                  : undefined}
              />
            </div>
            {busyProgress && busyProgress.rowsTotal > 0 && (
              <div style={{ fontSize: 12, marginTop: 4, color: "var(--fg-secondary, #888)" }}>
                {busyProgress.rowsDone.toLocaleString()} / {busyProgress.rowsTotal.toLocaleString()} {t("workspace.importProgressRows")}
              </div>
            )}
          </div>
        </div>
      )}

      {ctxMenu && (
        <div
          ref={ctxMenuRef}
          className="sp-ctx-menu"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {ctxMenu.kind === "table" && (() => {
            const id = ctxMenu.id;
            const ds = datasets.find((d) => d.id === id);
            if (!ds) return null;
            return (
              <>
                <div className={`sp-ctx-item${readOnly ? " sp-ctx-item-disabled" : ""}`} onClick={readOnly ? undefined : (() => {
                  setRenamingId(id);
                  setRenameValue(ds.name);
                  setActiveGraphBuilderId(null);
                  setActiveTabulateId(null);
                  setActiveDataset(id);
                  setCtxMenu(null);
                })}>{t("common.rename")}</div>
                <div className="sp-ctx-sep" />
                <div className="sp-ctx-item" onClick={() => { handleExportTableSptbFromCtx(id); setCtxMenu(null); }}>{t("menu.exportSptb")}</div>
                <div className="sp-ctx-item" onClick={() => { handleExportTableCsvFromCtx(id); setCtxMenu(null); }}>{t("table.exportCsvSingle", { defaultValue: "Export as CSV" })}</div>
                <div className="sp-ctx-item" onClick={() => { handleExportTableSqliteFromCtx(id); setCtxMenu(null); }}>{t("table.exportSqliteSingle", { defaultValue: "Export as SQLite" })}</div>
                <div className="sp-ctx-sep" />
                <div className={`sp-ctx-item sp-ctx-danger${readOnly ? " sp-ctx-item-disabled" : ""}`} onClick={readOnly ? undefined : (() => { handleDeleteDataset(id); setCtxMenu(null); })}>{t("common.delete")}</div>
              </>
            );
          })()}
          {ctxMenu.kind === "graph" && (() => {
            const id = ctxMenu.id;
            const gb = graphBuilders.find((g) => g.id === id);
            if (!gb) return null;
            return (
              <>
                <div className={`sp-ctx-item${readOnly ? " sp-ctx-item-disabled" : ""}`} onClick={readOnly ? undefined : (() => {
                  setRenamingId(id);
                  setRenameValue(gb.name);
                  setActiveDataset(null);
                  setActiveTabulateId(null);
                  setActiveGraphBuilderId(id);
                  setCtxMenu(null);
                })}>{t("common.rename")}</div>
                <div className="sp-ctx-sep" />
                <div className={`sp-ctx-item sp-ctx-danger${readOnly ? " sp-ctx-item-disabled" : ""}`} onClick={readOnly ? undefined : (() => { handleDeleteGraphBuilder(id); setCtxMenu(null); })}>{t("common.delete")}</div>
              </>
            );
          })()}
          {ctxMenu.kind === "tabulate" && (() => {
            const id = ctxMenu.id;
            const item = tabulates.find((entry) => entry.id === id);
            if (!item) return null;
            return (
              <>
                <div className={`sp-ctx-item${readOnly ? " sp-ctx-item-disabled" : ""}`} onClick={readOnly ? undefined : (() => {
                  setRenamingId(id);
                  setRenameValue(item.name);
                  setActiveDataset(null);
                  setActiveGraphBuilderId(null);
                  setActiveTabulateId(id);
                  setCtxMenu(null);
                })}>{t("common.rename")}</div>
                <div className="sp-ctx-sep" />
                <div className={`sp-ctx-item sp-ctx-danger${readOnly ? " sp-ctx-item-disabled" : ""}`} onClick={readOnly ? undefined : (() => { handleDeleteTabulate(id); setCtxMenu(null); })}>{t("common.delete")}</div>
              </>
            );
          })()}
          {ctxMenu.kind === "folder" && (() => {
            const fp = ctxMenu.path;
            return (
              <>
                <div className={`sp-ctx-item${readOnly ? " sp-ctx-item-disabled" : ""}`} onClick={readOnly ? undefined : (() => { handleCreateFolder(fp); setCtxMenu(null); })}>{t("folder.newSubfolder", { defaultValue: "New Subfolder" })}</div>
                <div className={`sp-ctx-item${readOnly ? " sp-ctx-item-disabled" : ""}`} onClick={readOnly ? undefined : (() => {
                  setRenamingFolder(fp);
                  setFolderRenameValue(folderBaseName(fp));
                  setCtxMenu(null);
                })}>{t("common.rename")}</div>
                <div className="sp-ctx-sep" />
                <div className="sp-ctx-item" onClick={() => { handleExportFolderSptbZip(fp); setCtxMenu(null); }}>{t("folder.exportSptbZip", { defaultValue: "Export as .sptb (zip)" })}</div>
                <div className="sp-ctx-item" onClick={() => { handleExportFolderCsvZip(fp); setCtxMenu(null); }}>{t("folder.exportCsvZip", { defaultValue: "Export as CSV (zip)" })}</div>
                <div className="sp-ctx-item" onClick={() => { handleExportFolderSqlite(fp); setCtxMenu(null); }}>{t("folder.exportSqlite", { defaultValue: "Export as SQLite" })}</div>
                <div className="sp-ctx-sep" />
                <div className={`sp-ctx-item sp-ctx-danger${readOnly ? " sp-ctx-item-disabled" : ""}`} onClick={readOnly ? undefined : (() => { handleDeleteFolder(fp); setCtxMenu(null); })}>{t("common.delete")}</div>
              </>
            );
          })()}
          {ctxMenu.kind === "empty" && (
            <div className={`sp-ctx-item${readOnly ? " sp-ctx-item-disabled" : ""}`} onClick={readOnly ? undefined : (() => { handleCreateFolder(null); setCtxMenu(null); })}>{t("menu.newFolder", { defaultValue: "New Folder" })}</div>
          )}
        </div>
      )}

      {snapMenu && (
        <div
          className="sp-ctx-menu"
          style={{ left: snapMenu.x, top: snapMenu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className={`sp-ctx-item${readOnly ? " sp-ctx-item-disabled" : ""}`} onClick={readOnly ? undefined : (() => {
            snapRenameRef.current?.(snapMenu.id);
            setSnapMenu(null);
          })}>{t("common.rename")}</div>
          <div className={`sp-ctx-item${readOnly ? " sp-ctx-item-disabled" : ""}`} onClick={readOnly ? undefined : (async () => {
            const id = snapMenu.id;
            setSnapMenu(null);
            setBusyMessage(t("workspace.restoringSnapshot"));
            const unlisten = await listen<{
              datasetIndex: number;
              datasetTotal: number;
              datasetName: string;
            }>("restore-progress", (event) => {
              const { datasetIndex, datasetTotal, datasetName } = event.payload;
              if (datasetTotal > 0 && datasetIndex < datasetTotal) {
                setBusyMessage(`${t("workspace.restoringSnapshot")} ${t("workspace.importProgressTable", { i: datasetIndex + 1, total: datasetTotal, name: datasetName })}`);
              }
            });
            try {
              await restoreSnapshot(id);
              await handleHistoryRestored();
            } finally {
              unlisten();
              setBusyMessage(null);
            }
          })}>{t("common.restore")}</div>
          <div className="sp-ctx-sep" />
          {confirmDeleteSnapId === snapMenu.id ? (
            <div className="snapshot-ctx-confirm" onMouseDown={(e) => e.stopPropagation()}>
              <span className="snapshot-ctx-confirm-text">{t("common.confirmDelete")}</span>
              <div className="snapshot-ctx-confirm-btns">
                <button className="snapshot-ctx-confirm-yes" disabled={readOnly} onClick={(e) => {
                  e.stopPropagation();
                  deleteSnapshot(confirmDeleteSnapId);
                  setConfirmDeleteSnapId(null);
                  setSnapMenu(null);
                }}>{t("common.confirm")}</button>
                <button className="snapshot-ctx-confirm-no" onClick={(e) => {
                  e.stopPropagation();
                  setConfirmDeleteSnapId(null);
                }}>{t("common.cancel")}</button>
              </div>
            </div>
          ) : (
            <div className={`sp-ctx-item sp-ctx-danger${readOnly ? " sp-ctx-item-disabled" : ""}`} onClick={readOnly ? undefined : ((e) => {
              e.stopPropagation();
              setConfirmDeleteSnapId(snapMenu.id);
            })}>{t("common.delete")}</div>
          )}
        </div>
      )}

      {toastMessage && (
        <div className="save-toast">{toastMessage}</div>
      )}

    </div>
  );
}
