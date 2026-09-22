import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { APP_VERSION } from "@/appVersion";
import { useProjectStore } from "@/stores/useProjectStore";
import { useDataStore } from "@/stores/useDataStore";
import { useDatasetFilterStore } from "@/stores/useDatasetFilterStore";
import { useHistoryStore } from "@/stores/useHistoryStore";
import { useTableZoomStore } from "@/stores/useTableZoomStore";
import {
  useFolderStore,
  folderBaseName,
  folderParent,
  validateFolderOrFileName,
} from "@/stores/useFolderStore";
import { useDataLinkStore } from "@/stores/useDataLinkStore";
import { useUpdateStore } from "@/stores/useUpdateStore";
import { dataService } from "@/services/dataService";
import { ioService } from "@/services/ioService";
import { mcpManagementService } from "@/services/mcpManagementService";
import { projectService } from "@/services/projectService";
import { openUpdateUrl } from "@/services/updateDownload";
import { DataTableView } from "./DataTableView";
import { HistoryPanel, type SnapshotMenuData } from "./HistoryPanel";
import { PreferencesDialog } from "./PreferencesDialog";
import { SqlQueryDialog } from "./SqlQueryDialog";
import { UpdateDialogs } from "./UpdateDialogs";
import { WorkspaceFrame } from "./layout";
import { PostgresDataLinkDialog } from "./dataLink/PostgresDataLinkDialog";
import { SqliteDataLinkDialog } from "./dataLink/SqliteDataLinkDialog";
import { TableOpsDialog } from "./TableOpsDialog";
import { TableExportDialog, type TableExportPlan } from "./tableExport";
import { TableTransformView } from "./tableTransform/TableTransformView";
import { GraphBuilderView } from "./graphBuilder";
import { GraphBuilderNewView } from "./graphBuilderNew/GraphBuilderNewView";
import { FitYByXRoleDialog } from "./fitYByX";
import { HypothesisTestDialog } from "./hypothesisTest";
import {
  FitModelRoleDialog,
  type FitModelCreateDefinition,
} from "./fitModel";
import { ReportView } from "./report";
import { AnalysisView } from "./analysis/AnalysisView";
import { AiActivityView } from "./ai/AiActivityView";
import {
  type FitYByXAnalysisEditorItem,
  type HypothesisTestAnalysisEditorItem,
} from "./analysis/adapters";
import { toAnalysisEditorItem } from "./analysis/analysisEditorRegistry";
import {
  DistributionDialog,
  type DistributionFieldInfo,
  type DistributionManagePropertiesRequest,
} from "./distribution";
import {
  createDefaultDistributionAnalysisConfig,
  createDefaultDistributionGraphs,
} from "./distribution/distributionConfig";
import { TabulateView } from "./tabulate";
import { WorkflowPanel, WorkflowView } from "./workflow";
import { applyWorkflowRunCommit } from "./workflow/workflowRunCommit";
import {
  ANALYSIS_SAMPLE_COLUMN,
  createAnalysisSample,
} from "./analysis/analysisSample";
import {
  createEmptyWorkspaceDocumentSelection,
  getRetainedActiveAnalysisIdAfterDatasetDeletion,
  hydrateAnalysisProjectPayload,
  selectWorkspaceDocument,
  shouldMarkAnalysisMigrationDirty,
  type WorkspaceDocumentKind,
  type WorkspaceDocumentSelection,
} from "./analysis/analysisWorkspaceLifecycle";
import "./graphBuilder/graphBuilder.css";
import "./fitYByX/fitYByX.css";
import "./fitModel/fitModel.css";
import { useGraphBuilderStore } from "@/stores/useGraphBuilderStore";
import { useGraphBuilderNewStore } from "@/stores/useGraphBuilderNewStore";
import { useReportStore } from "@/stores/useReportStore";
import { useAnalysisStore } from "@/stores/useAnalysisStore";
import { useTabulateStore } from "@/stores/useTabulateStore";
import { useWorkflowStore } from "@/stores/useWorkflowStore";
import { useTableTransformStore } from "@/stores/useTableTransformStore";
import { useTableViewportStore } from "@/stores/useTableViewportStore";
import {
  resolveSelectionAfterDatasetDeletion,
  useWorkspaceSelectionStore,
} from "@/stores/useWorkspaceSelectionStore";
import type { GraphBuilderItem } from "@/types/graphBuilder";
import type { AnalysisDocument, FitModelAnalysisDocument, FitYByXAnalysisDocument, HypothesisTestAnalysisDocument } from "@/types/analysis";
import type { FitYByXItem } from "@/types/fitYByX";
import type { FitModelPrefill } from "@/types/fitModel";
import type { ReportItem } from "@/types/report";
import type { DistributionItem } from "@/types/distribution";
import type { TabulateItem } from "@/types/tabulate";
import { open, save } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { join } from "@tauri-apps/api/path";
import { modKey } from "@/utils/platform";
import { ctxMenuRef } from "@/utils/ctxMenu";
import {
  deriveWorkflowOperationColumnRequirements,
  mergeWorkflowTableColumns,
} from "@/utils/workflowSchema";
import { buildProjectDependencyGraph } from "@/workflow/projectDependencyGraph";
import {
  allocateProjectBasename,
  ProjectNameValidationError,
  projectFileExtension,
  resolveProjectBasenameForKind,
  type ProjectBasenameValidationError,
  type ProjectDocumentKind,
} from "@/utils/projectFileNaming";
import type { HistoryEntry, NamedSnapshot } from "@/types/history";
import type { ImportSummary, SqliteImportSelection } from "@/types/dataLink";
import {
  buildDistributionFieldInfo,
  shouldRetainTablePropertyManagerRequest,
  type TablePropertyManagerRequest,
} from "./tablePropertyManagerRequest";
import {
  shouldApplyDistributionCreateMetadataLoad,
  shouldApplyDistributionEditMetadataLoad,
} from "./workspaceDistributionMetadata";
import { applicationRuntime } from "@/applicationCommands/applicationRuntime";
import {
  createWorkspaceCommandHandlers,
  waitForWorkspaceCommandConfirmation,
} from "./workspaceCommandHandlers";
import { mountApplicationCommandBridge } from "./workspaceApplicationCommandBridge";
import {
  applyWorkspaceAiNavigation,
  openWorkspaceAiServer,
  openWorkspaceAiSkills,
} from "./workspaceAiNavigation";

function formatStat(n: number): string {
  if (Number.isInteger(n) && Math.abs(n) < 1e15) return n.toString();
  const s = n.toPrecision(10);
  return parseFloat(s).toString();
}

function nextDistributionAnalysisName(items: readonly AnalysisDocument[]): string {
  let maximum = 0;
  for (const item of items) {
    const match = /^Distribution (\d+)$/.exec(item.name);
    if (match) maximum = Math.max(maximum, Number(match[1]));
  }
  return `Distribution ${maximum + 1}`;
}

function nextFitYByXAnalysisName(items: readonly AnalysisDocument[]): string {
  let maximum = 0;
  for (const item of items) {
    const match = /^Fit Y by X (\d+)$/.exec(item.name);
    if (match) maximum = Math.max(maximum, Number(match[1]));
  }
  return `Fit Y by X ${maximum + 1}`;
}

function nextHypothesisTestAnalysisName(items: readonly AnalysisDocument[]): string {
  let maximum = 0;
  for (const item of items) {
    if (item.analysisKind !== "hypothesisTest") continue;
    const match = /^Hypothesis Test (\d+)$/.exec(item.name);
    if (match) maximum = Math.max(maximum, Number(match[1]));
  }
  return `Hypothesis Test ${maximum + 1}`;
}

function isFitYByXAnalysisDocument(item: AnalysisDocument): item is FitYByXAnalysisDocument {
  return item.analysisKind === "fitYByX";
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

function formatStatusBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  return `${bytes} B`;
}

export function Workspace() {
  const { t } = useTranslation();
  const {
    project,
    initProject,
    dirty,
    markDirty,
    setDirty,
    resetRevision,
    readOnly,
    saving,
    saveProgress,
    saveError,
  } = useProjectStore();
  const { datasets, setActiveDataset, refreshDatasets, statusInfo } = useDataStore();
  const { openProject } = useProjectStore();
  const { record: recordHistory, restoreSnapshot, deleteSnapshot, reset: resetHistory, invalidateData } = useHistoryStore();
  const graphBuilders = useGraphBuilderStore((s) => s.items);
  const removeDatasetFilters = useDatasetFilterStore((s) => s.removeDataset);
  const renameDatasetFilterColumn = useDatasetFilterStore((s) => s.renameColumn);
  const loadDatasetFiltersFromProject = useDatasetFilterStore((s) => s.loadFromProject);
  const resetDatasetFilters = useDatasetFilterStore((s) => s.reset);
  const removeDatasetViewport = useTableViewportStore((s) => s.removeDataset);
  const retainDatasetViewports = useTableViewportStore((s) => s.retainDatasets);
  const resetTableViewports = useTableViewportStore((s) => s.reset);
  const tabulates = useTabulateStore((s) => s.items);
  const workflows = useWorkflowStore((s) => s.workflows);
  const workflowRuns = useWorkflowStore((s) => s.workflowRuns);
  const tableTransforms = useTableTransformStore((s) => s.definitions);
  const tableTransformBindings = useTableTransformStore((s) => s.bindings);
  const rebindTableTransform = useTableTransformStore((s) => s.rebindAndRun);
  const deleteTableTransform = useTableTransformStore((s) => s.remove);
  const loadTableTransforms = useTableTransformStore((s) => s.loadFromProject);
  const resetTableTransforms = useTableTransformStore((s) => s.reset);
  const loadWorkflowsFromProject = useWorkflowStore((s) => s.loadFromProject);
  const addWorkflow = useWorkflowStore((s) => s.addWorkflow);
  const resetWorkflows = useWorkflowStore((s) => s.reset);
  const graphBuilderNewSessions = useGraphBuilderNewStore((s) => s.sessions);
  const graphBuildersNew = useGraphBuilderNewStore((s) => s.items);
  const openGraphBuilderNew = useGraphBuilderNewStore((s) => s.open);
  const closeGraphBuilderNew = useGraphBuilderNewStore((s) => s.close);
  const reopenGraphBuilderNew = useGraphBuilderNewStore((s) => s.reopen);
  const resetGraphBuildersNew = useGraphBuilderNewStore((s) => s.reset);
  const loadGraphBuildersNewFromProject = useGraphBuilderNewStore((s) => s.loadFromProject);
  const addGraphBuilder = useGraphBuilderStore((s) => s.addItem);
  const renameGraphBuilder = useGraphBuilderStore((s) => s.renameItem);
  const migrateLegacyGraphColumnName = useGraphBuilderStore((s) => s.migrateLegacyColumnName);
  const deleteGraphBuilder = useGraphBuilderStore((s) => s.deleteItem);
  const deleteGraphBuildersByDataset = useGraphBuilderStore((s) => s.deleteByDataset);
  const resetGraphBuilders = useGraphBuilderStore((s) => s.reset);
  const loadGraphBuildersFromProject = useGraphBuilderStore((s) => s.loadFromProject);
  const reportItems = useReportStore((s) => s.items);
  const renameReport = useReportStore((s) => s.renameItem);
  const deleteReport = useReportStore((s) => s.deleteItem);
  const resetReports = useReportStore((s) => s.reset);
  const loadReportsFromProject = useReportStore((s) => s.loadFromProject);
  const analysisItems = useAnalysisStore((s) => s.items);
  const fitYByXAnalysisItems = analysisItems.filter(isFitYByXAnalysisDocument);
  const hypothesisTestAnalysisItems = analysisItems.filter((analysis) => analysis.analysisKind === "hypothesisTest");
  const distributionAnalysisItems = analysisItems.filter((analysis) => analysis.analysisKind === "distribution");
  const updateAnalysis = useAnalysisStore((s) => s.updateAnalysis);
  const deleteAnalysis = useAnalysisStore((s) => s.removeAnalysis);
  const loadAnalyses = useAnalysisStore((s) => s.loadAnalyses);
  const resetAnalyses = useAnalysisStore((s) => s.reset);
  const renameTabulate = useTabulateStore((s) => s.renameItem);
  const deleteTabulate = useTabulateStore((s) => s.deleteItem);
  const resetTabulates = useTabulateStore((s) => s.reset);
  const loadTabulatesFromProject = useTabulateStore((s) => s.loadFromProject);
  const projectLineageGraph = useMemo(() => buildProjectDependencyGraph({
    datasets,
    tableTransforms,
    tableTransformBindings,
    graphs: graphBuilders,
    analyses: analysisItems,
    tabulates,
    reports: reportItems,
  }), [analysisItems, datasets, graphBuilders, reportItems, tableTransformBindings, tableTransforms, tabulates]);
  const [activeTab, setActiveTab] = useState<"files" | "history" | "workflow" | "ai">("files");
  const [activeAiSubview, setActiveAiSubview] = useState<"server" | "skills">("server");
  const [activeWorkflowViewId, setActiveWorkflowViewId] = useState("lineage");
  const [activeGraphBuilderNewId, setActiveGraphBuilderNewId] = useState<string | null>(null);
  const workspaceSelection = useWorkspaceSelectionStore((state) => state.selection);
  const loadWorkspaceSelection = useWorkspaceSelectionStore((state) => state.load);
  const activeDatasetId = workspaceSelection.activeDatasetId;
  const activeTableTransformId = workspaceSelection.activeTableTransformId;
  const activeGraphBuilderId = workspaceSelection.activeGraphBuilderId;
  const activeReportId = workspaceSelection.activeReportId;
  const activeAnalysisId = workspaceSelection.activeAnalysisId;
  const activeTabulateId = workspaceSelection.activeTabulateId;
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [showPrefs, setShowPrefs] = useState(false);
  const [showSqlQuery, setShowSqlQuery] = useState(false);
  const [showPostgresDataLink, setShowPostgresDataLink] = useState(false);
  const sqliteDataLinkPath = useDataLinkStore((state) => state.filePath);
  const openDataLink = useDataLinkStore((state) => state.open);
  const closeDataLink = useDataLinkStore((state) => state.close);
  const importDataLinkSelection = useDataLinkStore((state) => state.importSelected);
  const importProgress = useDataLinkStore((state) => state.progress);
  const activeImportRequestId = useDataLinkStore((state) => state.requestId);
  const cancellingImport = useDataLinkStore((state) => state.cancelling);
  const cancelActiveImport = useDataLinkStore((state) => state.cancelImport);
  const [helpDialog, setHelpDialog] = useState<boolean>(false);
  const updateStatus = useUpdateStore((state) => state.status);
  const availableUpdate = useUpdateStore((state) => state.update);
  const checkForUpdate = useUpdateStore((state) => state.check);
  const dismissUpdate = useUpdateStore((state) => state.dismiss);
  const [showTableTransformDialog, setShowTableTransformDialog] = useState(false);
  const [showTableExport, setShowTableExport] = useState(false);
  const [showFitYByXDialog, setShowFitYByXDialog] = useState(false);
  const [showFitModelDialog, setShowFitModelDialog] = useState(false);
  const [showHypothesisTestDialog, setShowHypothesisTestDialog] = useState(false);
  const [fitModelPrefill, setFitModelPrefill] = useState<FitModelPrefill | null>(null);
  const [showDistributionDialog, setShowDistributionDialog] = useState(false);
  const [distributionColumns, setDistributionColumns] = useState<DistributionFieldInfo[]>([]);
  const [editingAnalysisId, setEditingAnalysisId] = useState<string | null>(null);
  const [analysisEditorColumns, setAnalysisEditorColumns] = useState<DistributionFieldInfo[]>([]);
  const [propertyManagerRequest, setPropertyManagerRequest] = useState<TablePropertyManagerRequest | null>(null);
  const distributionCreateRequestEpochRef = useRef(0);
  const distributionEditRequestEpochRef = useRef(0);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const toastTimerRef = useRef<number | null>(null);

  // Folder tree state ------------------------------------------------------
  const folders = useFolderStore((s) => s.folders);
  const tableFolders = useFolderStore((s) => s.tableFolders);
  const graphFolders = useFolderStore((s) => s.graphFolders);
  const graphNewFolders = useFolderStore((s) => s.graphNewFolders);
  const reportFolders = useFolderStore((s) => s.reportFolders);
  const analysisFolders = useFolderStore((s) => s.analysisFolders);
  const tabulateFolders = useFolderStore((s) => s.tabulateFolders);
  const collapsedFolders = useFolderStore((s) => s.collapsed);
  const fsCreateFolder = useFolderStore((s) => s.createFolder);
  const fsRenameFolder = useFolderStore((s) => s.renameFolder);
  const fsDeleteFolder = useFolderStore((s) => s.deleteFolder);
  const fsMoveFolder = useFolderStore((s) => s.moveFolder);
  const fsSetTableFolder = useFolderStore((s) => s.setTableFolder);
  const fsSetGraphFolder = useFolderStore((s) => s.setGraphFolder);
  const fsSetGraphNewFolder = useFolderStore((s) => s.setGraphNewFolder);
  const fsSetReportFolder = useFolderStore((s) => s.setReportFolder);
  const fsSetAnalysisFolder = useFolderStore((s) => s.setAnalysisFolder);
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
    | { kind: "tableTransform"; id: string; x: number; y: number }
    | { kind: "graph"; id: string; x: number; y: number }
    | { kind: "graphNew"; id: string; x: number; y: number }
    | { kind: "report"; id: string; x: number; y: number }
    | { kind: "analysis"; id: string; x: number; y: number }
    | { kind: "tabulate"; id: string; x: number; y: number }
    | { kind: "folder"; path: string; x: number; y: number }
    | { kind: "empty"; x: number; y: number };
  const [ctxMenu, setCtxMenu] = useState<CtxMenu | null>(null);
  const [snapMenu, setSnapMenu] = useState<SnapshotMenuData | null>(null);
  const [confirmDeleteSnapId, setConfirmDeleteSnapId] = useState<string | null>(null);
  const snapRenameRef = useRef<((id: string) => void) | null>(null);
  const [busyMessage, setBusyMessage] = useState<string | null>(null);
  const [busyProgress, setBusyProgress] = useState<{ rowsDone: number; rowsTotal: number } | null>(null);
  const [tableKey, setTableKey] = useState(0);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const tableCounter = useRef(0);
  const reportUpdateQueueRef = useRef(Promise.resolve());

  /** Record an action to history (synchronous — no IPC) */
  const recordAction = useCallback((desc: string) => {
    recordHistory(desc);
  }, [recordHistory]);

  const applyWorkspaceDocumentSelection = useCallback(async (selection: WorkspaceDocumentSelection) => {
    const currentActiveReportId = useWorkspaceSelectionStore.getState().selection.activeReportId;
    if (currentActiveReportId && currentActiveReportId !== selection.activeReportId) {
      await applicationRuntime.flushPendingEffects();
    }
    if (activeGraphBuilderNewId) {
      closeGraphBuilderNew(activeGraphBuilderNewId);
      setActiveGraphBuilderNewId(null);
    }
    loadWorkspaceSelection(selection);
    setActiveDataset(selection.activeDatasetId);
  }, [activeGraphBuilderNewId, closeGraphBuilderNew, loadWorkspaceSelection, setActiveDataset]);

  const activateWorkspaceDocument = useCallback(async (kind: WorkspaceDocumentKind, id: string) => {
    await applyWorkspaceDocumentSelection(selectWorkspaceDocument(kind, id));
  }, [applyWorkspaceDocumentSelection]);

  const clearWorkspaceDocumentSelection = useCallback(async () => {
    await applyWorkspaceDocumentSelection(createEmptyWorkspaceDocumentSelection());
  }, [applyWorkspaceDocumentSelection]);

  const handleOpenGraphBuilderNew = async (id: string) => {
    const item = useGraphBuilderNewStore.getState().items.find((candidate) => candidate.id === id);
    if (!item) return;
    const dataset = useDataStore.getState().datasets.find((candidate) => candidate.id === item.datasetId);
    if (activeGraphBuilderNewId !== id) await clearWorkspaceDocumentSelection();
    setActiveGraphBuilderNewId(reopenGraphBuilderNew(id, dataset?.generation ?? 0));
  };

  const flushPendingReportHistory = useCallback(async () => {
    await applicationRuntime.flushPendingEffects();
  }, []);

  useEffect(() => applicationRuntime.registerPendingEffectsDrain(async () => {
    await reportUpdateQueueRef.current.catch(() => undefined);
  }), []);

  useEffect(() => {
    const bridge = mountApplicationCommandBridge();
    return () => {
      void bridge.dispose();
    };
  }, []);

  const handleReportMarkdownChange = useCallback((id: string, markdown: string) => {
    if (readOnly) {
      return;
    }
    reportUpdateQueueRef.current = reportUpdateQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        const current = useReportStore.getState().items.find((item) => item.id === id);
        if (!current || current.markdown === markdown) {
          return;
        }
        const expectedDocumentRevision = useReportStore.getState().getDocumentRevision(id);
        await applicationRuntime.execute(
          {
            type: "report.update",
            input: {
              reportId: id,
              expectedDocumentRevision,
              markdown,
            },
          },
          { kind: "ui" },
        );
      })
      .catch(() => undefined);
  }, [readOnly]);

  useEffect(() => () => {
    // Fallback only: controlled save/open/close/selection paths await this boundary explicitly.
    void applicationRuntime.shutdown();
  }, []);

  useEffect(() => {
    if (!editingAnalysisId) return;
    const editing = analysisItems.find((item) => item.id === editingAnalysisId);
    if (!editing || !datasets.some((dataset) => dataset.id === editing.source.datasetId)) {
      setEditingAnalysisId(null);
    }
  }, [analysisItems, datasets, editingAnalysisId]);

  const analysisDocumentNames = useMemo(
    () => [
      ...analysisItems.map((item) => item.name),
      ...tabulates.map((item) => item.name),
    ],
    [analysisItems, tabulates],
  );

  const withProjectExtension = useCallback((basename: string, kind: ProjectDocumentKind): string => {
    return `${basename}${projectFileExtension(kind)}`;
  }, []);

  const invalidProjectNameMessage = useCallback((code: ProjectBasenameValidationError): string => {
    if (code === "controlChars") {
      return t("alert.invalidName.controlChars", {
        defaultValue: "Name contains control characters.",
      });
    }
    if (code === "reserved") {
      return t("alert.invalidName.reserved", {
        defaultValue: "Name is reserved by Windows and cannot be used.",
      });
    }
    return t(`alert.invalidName.${code}`, { defaultValue: "Invalid name." });
  }, [t]);

  const resolveProjectBasename = useCallback((
    requestedName: string,
    kind: ProjectDocumentKind,
    currentName?: string,
  ): { basename: string; error: null } | { basename: null; error: string } => {
    let existingNames: string[];
    if (kind === "table") {
      existingNames = datasets.map((d) => d.name);
    } else if (kind === "graph") {
      existingNames = graphBuilders.map((item) => item.name);
    } else if (kind === "graphNew") {
      existingNames = graphBuildersNew.map((item) => item.name);
    } else if (kind === "analysis") {
      existingNames = analysisItems.map((item) => item.name);
    } else if (kind === "fitYByX" || kind === "tabulate") {
      existingNames = analysisDocumentNames;
    } else if (kind === "report") {
      existingNames = reportItems.map((item) => item.name);
    } else {
      existingNames = [];
    }
    const resolved = resolveProjectBasenameForKind(requestedName, kind, existingNames, currentName);
    if (resolved.error === "wrongExtension") {
      return {
        basename: null,
        error: t("alert.invalidName.wrongExtension", {
          defaultValue: "Use the {{expected}} extension for this item (not {{actual}}).",
          expected: resolved.expectedExtension,
          actual: resolved.actualExtension,
        }),
      };
    }
    if (resolved.error) {
      return { basename: null, error: invalidProjectNameMessage(resolved.error) };
    }
    return { basename: resolved.basename, error: null };
  }, [analysisDocumentNames, analysisItems, datasets, graphBuilders, graphBuildersNew, invalidProjectNameMessage, reportItems, t]);

  /** Called when history/snapshot is restored — refresh all UI */
  const handleHistoryRestored = useCallback(async () => {
    await refreshDatasets();
    // If activeDataset no longer exists, deselect
    const updatedDatasets = await dataService.listDatasets();
    retainDatasetViewports(updatedDatasets.map((dataset) => dataset.id));
    if (activeDatasetId && !updatedDatasets.find((d) => d.id === activeDatasetId)) {
      setActiveDataset(null);
    }
    // Force DataTableView to remount and reload data
    setTableKey((k) => k + 1);
    invalidateData();
  }, [refreshDatasets, activeDatasetId, setActiveDataset, invalidateData, retainDatasetViewports]);

  useEffect(() => {
    refreshDatasets();
  }, []);

  useEffect(() => {
    const availableDatasetIds = datasets.map((dataset) => dataset.id);
    setPropertyManagerRequest((current) => (
      shouldRetainTablePropertyManagerRequest(current, availableDatasetIds)
        ? current
        : null
    ));
  }, [datasets]);

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
    const fitYByXIds = new Set<string>();
    const fitModelIds = new Set<string>();
    const reportIds = new Set(reportItems.map((item) => item.id));
    const distributionIds = new Set<string>();
    const analysisIds = new Set(analysisItems.map((item) => item.id));
    fsPrune(dsIds, gbIds, tabulateIds, fitYByXIds, distributionIds, reportIds, fitModelIds, analysisIds, new Set(graphBuildersNew.map((item) => item.id)));
  }, [analysisItems, datasets, graphBuilders, graphBuildersNew, tabulates, reportItems, fsPrune]);

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
    const resolved = resolveProjectBasenameForKind(
      `Table${tableCounter.current}`,
      "table",
      datasets.map((dataset) => dataset.name),
    );
    if (resolved.error) {
      const message = resolved.error === "wrongExtension"
        ? t("alert.invalidName.wrongExtension", {
            defaultValue: "Use the {{expected}} extension for this item (not {{actual}}).",
            expected: resolved.expectedExtension,
            actual: resolved.actualExtension,
          })
        : invalidProjectNameMessage(resolved.error);
      alert(message);
      return;
    }
    const name = resolved.basename;
    const result = await applicationRuntime.execute(
      {
        type: "table.create",
        input: {
          request: {
            name,
            columns: [],
            rows: [],
          },
        },
      },
      { kind: "ui" },
    );
    const created = result.data;
    // Enter rename mode
    setRenamingId(created.dataset.id);
    setRenameValue(created.dataset.name);
  };
  handleCreateTableRef.current = handleCreateTable;

  /** 新建一个图表构建器项，绑定到当前选中数据表 */
  const handleCreateGraphBuilder = async () => {
    if (readOnly) return;
    if (!activeDatasetId) {
      alert(t("alert.selectDatasetFirst"));
      return;
    }
    try {
      const result = await applicationRuntime.execute(
        {
          type: "graph.create",
          input: { sourceDatasetId: activeDatasetId },
        },
        { kind: "ui" },
      );
      setRenamingId(result.data.item.id);
      setRenameValue(result.data.item.name);
    } catch {
      alert(t("alert.importGraphFailed") + t("common.error", { defaultValue: "Error" }));
    }
  };

  const handleCreateGraphBuilderNew = async () => {
    if (readOnly) return;
    if (!activeDatasetId) {
      alert(t("alert.selectDatasetFirst"));
      return;
    }
    const dataset = datasets.find((candidate) => candidate.id === activeDatasetId);
    if (!dataset) return;
    await clearWorkspaceDocumentSelection();
    setActiveGraphBuilderNewId(openGraphBuilderNew(dataset.id, dataset.generation));
  };

  const handleCreateTabulate = () => {
    if (readOnly) return;
    if (!activeDatasetId) {
      return;
    }
    applicationRuntime.execute(
      {
        type: "tabulate.create",
        input: { sourceDatasetId: activeDatasetId },
      },
      { kind: "ui" },
    ).then((result) => {
      setRenamingId(result.data.item.id);
      setRenameValue(result.data.item.name);
    }).catch(() => {
      alert(t("alert.failedToCreateTabulate", { defaultValue: "Failed to create tabulate." }));
    });
  };

  const handleCreateFitYByX = () => {
    if (readOnly) return;
    if (!activeDatasetId) {
      alert(t("alert.selectDatasetFirst"));
      return;
    }
    setShowFitYByXDialog(true);
  };

  const handleCreateHypothesisTest = () => {
    if (readOnly) return;
    if (!activeDatasetId) {
      alert(t("alert.selectDatasetFirst"));
      return;
    }
    setShowHypothesisTestDialog(true);
  };

  const handleCreateHypothesisTestItem = (name: string, submitted: HypothesisTestAnalysisEditorItem) => {
    if (!activeDatasetId) return;
    applicationRuntime.execute(
      {
        type: "analysis.create",
        input: {
          analysisKind: "hypothesisTest",
          sourceDatasetId: activeDatasetId,
          draft: {
            name: name.trim() || undefined,
            definition: submitted.definition,
          },
        },
      },
      { kind: "ui" },
    ).then((result) => {
      setShowHypothesisTestDialog(false);
      setRenamingId(result.data.item.id);
      setRenameValue(result.data.item.name);
    }).catch((error) => {
      alert(String(error));
    });
  };

  const openFitModel = (prefill?: FitModelPrefill) => {
    if (readOnly) return;
    const sourceDatasetId = prefill?.sourceDatasetId ?? activeDatasetId;
    if (!sourceDatasetId || !datasets.some((dataset) => dataset.id === sourceDatasetId)) {
      alert(t("alert.selectDatasetFirst"));
      return;
    }
    setActiveDataset(sourceDatasetId);
    setFitModelPrefill(prefill ?? null);
    setShowFitModelDialog(true);
  };

  const handleCreateFitModel = () => openFitModel();

  const handleCreateFitModelItem = async (definition: FitModelCreateDefinition) => {
    if (!activeDatasetId) return;
    try {
      const result = await applicationRuntime.execute(
        {
          type: "analysis.create",
          input: {
            analysisKind: "fitModel",
            sourceDatasetId: activeDatasetId,
            draft: {
              response: definition.response,
              construct: definition.construct,
              terms: definition.terms,
              centeringMethod: definition.centeringMethod,
              confidenceLevel: 0.95,
            },
          },
        },
        { kind: "ui" },
      );
      setShowFitModelDialog(false);
      setFitModelPrefill(null);
      setRenamingId(result.data.item.id);
      setRenameValue(result.data.item.name);
    } catch (error) {
      alert(String(error));
    }
  };

  const handleCreateFitYByXItem = (item: FitYByXAnalysisEditorItem) => {
    applicationRuntime.execute(
      {
        type: "analysis.create",
        input: {
          analysisKind: "fitYByX",
          sourceDatasetId: item.sourceDatasetId,
          draft: {
            name: item.name.trim() || undefined,
            response: item.response,
            factor: item.factor,
            confidenceLevel: item.confidenceLevel,
            graph: item.graph,
          },
        },
      },
      { kind: "ui" },
    ).then((result) => {
      setShowFitYByXDialog(false);
      setRenamingId(result.data.item.id);
      setRenameValue(result.data.item.name);
    }).catch((error) => {
      alert(String(error));
    });
  };

  const handleCreateReport = async () => {
    if (readOnly) return;
    const result = await applicationRuntime.execute(
      {
        type: "report.create",
        input: {},
      },
      { kind: "ui" },
    );
    setRenamingId(result.data.item.id);
    setRenameValue(result.data.item.name);
  };

  const handleCreateAnalysisSample = async () => {
    if (readOnly) return;
    const tableName = allocateProjectBasename(
      "DIM1 Sample",
      ".sptb",
      datasets.map((dataset) => dataset.name),
    );
    const analysisName = allocateProjectBasename(
      "DIM1 Analysis",
      ".span",
      analysisItems.map((analysis) => analysis.name),
    );

    let createdDatasetId: string | null = null;
    try {
      const sample = createAnalysisSample(112, 200);
      const dataset = await dataService.createTableFromRows({
        name: tableName,
        columnNames: [ANALYSIS_SAMPLE_COLUMN],
        columnTypes: ["DOUBLE"],
        rows: sample.rows,
      });
      createdDatasetId = dataset.id;
      await refreshDatasets();
      await applicationRuntime.execute(
        {
          type: "analysis.create",
          input: {
            analysisKind: "distribution",
            sourceDatasetId: dataset.id,
            draft: {
              name: analysisName,
              responses: [{ name: ANALYSIS_SAMPLE_COLUMN, type: "continuous" }],
              weight: null,
              frequency: null,
              by: [],
              nestedSubgroup: null,
              analysis: createDefaultDistributionAnalysisConfig(),
              graphs: createDefaultDistributionGraphs({ name: ANALYSIS_SAMPLE_COLUMN, type: "continuous" }),
            },
          },
        },
        { kind: "ui" },
      );
    } catch (error) {
      if (createdDatasetId) {
        try {
          await dataService.deleteDataset(createdDatasetId);
          await refreshDatasets();
        } catch {
        }
      }
      alert(t("alert.analysisSampleFailed", {
        defaultValue: "Failed to create sample analysis: {{message}}",
        message: String(error),
      }));
    }
  };

  const handleCreateDistribution = async () => {
    if (readOnly) return;
    if (!activeDatasetId) {
      alert(t("alert.selectDatasetFirst"));
      return;
    }
    const requestedDatasetId = activeDatasetId;
    const requestEpoch = distributionCreateRequestEpochRef.current + 1;
    distributionCreateRequestEpochRef.current = requestEpoch;
    try {
      const [columns, displayProps] = await Promise.all([
        dataService.getColumns(activeDatasetId),
        dataService.getColumnDisplayProps(activeDatasetId),
      ]);
      const currentDataState = useDataStore.getState();
      if (!shouldApplyDistributionCreateMetadataLoad({
        requestedDatasetId,
        requestEpoch,
        currentRequestEpoch: distributionCreateRequestEpochRef.current,
        activeDatasetId: currentDataState.activeDatasetId,
        availableDatasetIds: currentDataState.datasets.map((dataset) => dataset.id),
      })) {
        return;
      }
      setDistributionColumns(buildDistributionFieldInfo(columns, displayProps));
      setShowDistributionDialog(true);
    } catch (error) {
      alert(t("distribution.loadFieldsFailed", {
        defaultValue: "Failed to load fields: {{message}}",
        message: String(error),
      }));
    }
  };

  const handleEditAnalysisInputs = async (id: string) => {
    if (readOnly) return;
    const analysis = analysisItems.find((item) => item.id === id);
    if (!analysis) return;
    const dataset = datasets.find((item) => item.id === analysis.source.datasetId);
    if (!dataset) return;
    const requestedAnalysisId = id;
    const requestedDatasetId = dataset.id;
    const requestEpoch = distributionEditRequestEpochRef.current + 1;
    distributionEditRequestEpochRef.current = requestEpoch;
    if (analysis.analysisKind === "fitYByX" || analysis.analysisKind === "hypothesisTest") {
      setEditingAnalysisId(id);
      return;
    }
    try {
      const [columns, displayProps] = await Promise.all([
        dataService.getColumns(dataset.id),
        dataService.getColumnDisplayProps(dataset.id),
      ]);
      const currentDataState = useDataStore.getState();
      const currentAnalyses = useAnalysisStore.getState().items.map((item) => ({
        id: item.id,
        sourceDatasetId: item.source.datasetId,
      }));
      if (!shouldApplyDistributionEditMetadataLoad({
        requestedAnalysisId,
        requestedDatasetId,
        requestEpoch,
        currentRequestEpoch: distributionEditRequestEpochRef.current,
        availableDatasetIds: currentDataState.datasets.map((item) => item.id),
        analyses: currentAnalyses,
      })) {
        return;
      }
      setAnalysisEditorColumns(buildDistributionFieldInfo(columns, displayProps));
      setEditingAnalysisId(id);
    } catch (error) {
      alert(t("distribution.loadFieldsFailed", {
        defaultValue: "Failed to load fields: {{message}}",
        message: String(error),
      }));
    }
  };

  const handleUpdateDistributionAnalysisInputs = (editing: AnalysisDocument, submitted: DistributionItem) => {
    if (readOnly) return;
    if (editing.analysisKind !== "distribution") return;
    applicationRuntime.execute(
      {
        type: "analysis.update",
        input: {
          analysisId: editing.id,
          analysisKind: "distribution",
          expectedConfigRevision: editing.configRevision,
          draft: {
            responses: submitted.responses,
            weight: submitted.weight,
            frequency: submitted.frequency,
            by: submitted.by,
            nestedSubgroup: submitted.nestedSubgroup,
            analysis: submitted.analysis,
            graphs: submitted.graphs,
          },
        },
      },
      { kind: "ui" },
    ).then(() => {
      setEditingAnalysisId(null);
    }).catch((error) => {
      alert(String(error));
    });
  };

  const handleManageDistributionProperties = useCallback((request: DistributionManagePropertiesRequest) => {
    setShowDistributionDialog(false);
    setEditingAnalysisId(null);
    setPropertyManagerRequest({
      requestId: crypto.randomUUID(),
      datasetId: request.datasetId,
      colIndices: request.colIndices,
      extraKinds: ["spec"],
    });
    activateWorkspaceDocument("dataset", request.datasetId);
  }, [activateWorkspaceDocument]);

  const handlePropertyManagerRequestHandled = useCallback((requestId: string) => {
    setPropertyManagerRequest((current) => (current?.requestId === requestId ? null : current));
  }, []);

  const handleUpdateFitYByXAnalysisInputs = (
    editing: FitYByXAnalysisDocument,
    submitted: FitYByXAnalysisEditorItem,
  ) => {
    if (readOnly) return;
    applicationRuntime.execute(
      {
        type: "analysis.update",
        input: {
          analysisId: editing.id,
          analysisKind: "fitYByX",
          expectedConfigRevision: editing.configRevision,
          draft: {
            response: submitted.response,
            factor: submitted.factor,
            confidenceLevel: submitted.confidenceLevel,
            graph: submitted.graph,
          },
        },
      },
      { kind: "ui" },
    ).then(() => {
      setEditingAnalysisId(null);
    }).catch((error) => {
      alert(String(error));
    });
  };

  const handleUpdateFitModelAnalysisInputs = (
    editing: FitModelAnalysisDocument,
    submitted: FitModelCreateDefinition,
  ) => {
    if (readOnly) return;
    applicationRuntime.execute(
      {
        type: "analysis.update",
        input: {
          analysisId: editing.id,
          analysisKind: "fitModel",
          expectedConfigRevision: editing.configRevision,
          draft: {
            response: submitted.response,
            construct: submitted.construct,
            terms: submitted.terms,
            centeringMethod: submitted.centeringMethod,
            confidenceLevel: editing.definition.confidenceLevel,
          },
        },
      },
      { kind: "ui" },
    ).then(() => {
      setEditingAnalysisId(null);
    }).catch((error) => {
      alert(String(error));
    });
  };

  const handleUpdateHypothesisTestAnalysisInputs = (
    editing: HypothesisTestAnalysisDocument,
    submitted: HypothesisTestAnalysisEditorItem,
  ) => {
    if (readOnly) return;
    applicationRuntime.execute(
      {
        type: "analysis.update",
        input: {
          analysisId: editing.id,
          analysisKind: "hypothesisTest",
          expectedConfigRevision: editing.configRevision,
          draft: {
            definition: submitted.definition,
            presentation: submitted.presentation,
          },
        },
      },
      { kind: "ui" },
    ).then(() => {
      setEditingAnalysisId(null);
    }).catch((error) => {
      alert(String(error));
    });
  };

  const handleCreateDistributionItem = (item: DistributionItem) => {
    if (readOnly) return;
    applicationRuntime.execute(
      {
        type: "analysis.create",
        input: {
          analysisKind: "distribution",
          sourceDatasetId: item.sourceDatasetId,
          draft: {
            name: item.name.trim() || undefined,
            responses: item.responses,
            weight: item.weight,
            frequency: item.frequency,
            by: item.by,
            nestedSubgroup: item.nestedSubgroup,
            analysis: item.analysis,
            graphs: item.graphs,
          },
        },
      },
      { kind: "ui" },
    ).then((result) => {
      setShowDistributionDialog(false);
      setRenamingId(result.data.item.id);
      setRenameValue(result.data.item.name);
    }).catch((error) => {
      alert(String(error));
    });
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
      const resolved = resolveProjectBasename(trimmed, "graph", gb.name);
      if (resolved.error !== null) {
        alert(resolved.error);
        return;
      }
      const basename = resolved.basename;
      if (basename !== gb.name) {
        renameGraphBuilder(id, basename);
        markDirty();
        recordAction(t("history.renameGraph", { old: gb.name, new: basename }));
      }
      setRenamingId(null);
      return;
    }
    const nativeGraph = useGraphBuilderNewStore.getState().items.find((item) => item.id === id);
    if (nativeGraph) {
      const resolved = resolveProjectBasename(trimmed, "graphNew", nativeGraph.name);
      if (resolved.error !== null) {
        alert(resolved.error);
        return;
      }
      if (resolved.basename !== nativeGraph.name) {
        useGraphBuilderNewStore.getState().renameItem(id, resolved.basename);
        recordAction(t("history.renameGraph", { old: nativeGraph.name, new: resolved.basename }));
      }
      setRenamingId(null);
      return;
    }
    const tabulate = useTabulateStore.getState().items.find((it) => it.id === id);
    if (tabulate) {
      const resolved = resolveProjectBasename(trimmed, "tabulate", tabulate.name);
      if (resolved.error !== null) {
        alert(resolved.error);
        return;
      }
      const basename = resolved.basename;
      if (basename !== tabulate.name) {
        renameTabulate(id, basename);
        markDirty();
        recordAction(t("history.renameTabulate", { old: tabulate.name, new: basename }));
      }
      setRenamingId(null);
      return;
    }
    const report = useReportStore.getState().items.find((it) => it.id === id);
    if (report) {
      await flushPendingReportHistory();
      const resolved = resolveProjectBasename(trimmed, "report", report.name);
      if (resolved.error !== null) {
        alert(resolved.error);
        return;
      }
      const basename = resolved.basename;
      if (basename !== report.name) {
        renameReport(id, basename);
        markDirty();
        recordAction(t("history.renameReport", { old: report.name, new: basename }));
      }
      setRenamingId(null);
      return;
    }
    const analysis = useAnalysisStore.getState().items.find((it) => it.id === id);
    if (analysis) {
      const resolved = resolveProjectBasename(trimmed, "analysis", analysis.name);
      if (resolved.error !== null) {
        alert(resolved.error);
        return;
      }
      const basename = resolved.basename;
      if (basename !== analysis.name) {
        updateAnalysis(id, { name: basename, updatedAt: new Date().toISOString() });
        markDirty();
        recordAction(t("history.renameAnalysis", { old: analysis.name, new: basename }));
      }
      setRenamingId(null);
      return;
    }
    const oldName = datasets.find((d) => d.id === id)?.name;
    if (!oldName) {
      setRenamingId(null);
      return;
    }
    const resolved = resolveProjectBasename(trimmed, "table", oldName);
    if (resolved.error !== null) {
      alert(resolved.error);
      return;
    }
    const basename = resolved.basename;
    if (basename !== oldName) {
      try {
        await dataService.renameDataset(id, basename);
        await refreshDatasets();
        markDirty();
        recordAction(t("history.renameTable", { old: oldName, new: basename }));
      } catch (error) {
        alert(t("alert.renameTableFailed", {
          defaultValue: "Rename table failed: ",
        }) + String(error));
      }
    }
    setRenamingId(null);
  };

  const handleDeleteGraphBuilder = (id: string) => {
    const it = useGraphBuilderStore.getState().items.find((x) => x.id === id);
    deleteGraphBuilder(id);
    if (activeGraphBuilderId === id) clearWorkspaceDocumentSelection();
    markDirty();
    if (it) recordAction(t("history.deleteGraph", { name: it.name }));
  };

  const handleDeleteGraphBuilderNew = (id: string) => {
    if (readOnly) return;
    const item = useGraphBuilderNewStore.getState().items.find((candidate) => candidate.id === id);
    if (!item) return;
    useGraphBuilderNewStore.getState().deleteItem(id);
    fsSetGraphNewFolder(id, null);
    if (activeGraphBuilderNewId === id) setActiveGraphBuilderNewId(null);
    recordAction(t("history.deleteGraph", { name: item.name }));
  };

  const handleDeleteTableTransform = (id: string) => {
    if (readOnly) return;
    const item = useTableTransformStore.getState().definitions.find((entry) => entry.id === id);
    deleteTableTransform(id);
    if (activeTableTransformId === id) clearWorkspaceDocumentSelection();
    markDirty();
    if (item) recordAction(t("history.deleteTableTransform", { name: item.name }));
  };

  const handleDeleteTabulate = (id: string) => {
    const item = useTabulateStore.getState().items.find((entry) => entry.id === id);
    deleteTabulate(id);
    if (activeTabulateId === id) clearWorkspaceDocumentSelection();
    markDirty();
    if (item) recordAction(t("history.deleteTabulate", { name: item.name }));
  };

  const handleDeleteReport = async (id: string) => {
    const item = useReportStore.getState().items.find((entry) => entry.id === id);
    await flushPendingReportHistory();
    deleteReport(id);
    if (activeReportId === id) await clearWorkspaceDocumentSelection();
    markDirty();
    if (item) recordAction(t("history.deleteReport", { name: item.name }));
  };

  const handleDeleteAnalysis = (id: string) => {
    if (readOnly) return;
    const item = useAnalysisStore.getState().items.find((entry) => entry.id === id);
    deleteAnalysis(id);
    if (activeAnalysisId === id) clearWorkspaceDocumentSelection();
    markDirty();
    if (item) recordAction(t("history.deleteAnalysis", { name: item.name }));
  };

  const handleDeleteDataset = async (id: string) => {
    const name = datasets.find((d) => d.id === id)?.name ?? id;
    const activeAnalysis = activeAnalysisId
      ? useAnalysisStore.getState().items.find((item) => item.id === activeAnalysisId)
      : null;
    const retainedActiveAnalysisId = getRetainedActiveAnalysisIdAfterDatasetDeletion({
      deletedDatasetId: id,
      activeAnalysis: activeAnalysis ?? null,
    });
    const selectionAfterDelete = resolveSelectionAfterDatasetDeletion({
      selection: useWorkspaceSelectionStore.getState().selection,
      deletedDatasetId: id,
      graphItems: useGraphBuilderStore.getState().items,
      retainedActiveAnalysisId,
    });
    await dataService.deleteDataset(id);
    removeDatasetFilters(id);
    removeDatasetViewport(id);
    // 联动删除引用此数据表的图表
    deleteGraphBuildersByDataset(id);
    const nativeDependents = useGraphBuilderNewStore.getState().items.filter((item) => item.datasetId === id);
    useGraphBuilderNewStore.getState().deleteByDataset(id);
    for (const item of nativeDependents) fsSetGraphNewFolder(item.id, null);
    if (nativeDependents.some((item) => item.id === activeGraphBuilderNewId)) setActiveGraphBuilderNewId(null);
    await applyWorkspaceDocumentSelection(selectionAfterDelete);
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
      openDataLink(selected as string);
    }
  };

  const importSelectedSqlite = async (selections: SqliteImportSelection[]): Promise<ImportSummary> => {
    const summary = await importDataLinkSelection(selections);
    if (summary.status === "completed" && summary.imported.length > 0) {
      await refreshDatasets();
      markDirty();
      const fileName = sqliteDataLinkPath?.split(/[\\/]/).pop() ?? "SQLite";
      recordAction(t("history.importSqlite", { file: fileName }));
    }
    return summary;
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
      activateWorkspaceDocument("dataset", result.id);
      markDirty();
    } catch (e) {
      alert(t("alert.importTableFailed") + String(e));
    } finally {
      setBusyMessage(null);
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
      activateWorkspaceDocument("graph", id);
      markDirty();
    } catch (e) {
      alert(t("alert.importGraphFailed") + String(e));
    }
  };

  const handleSave = async (saveAs = false) => {
    try {
      await flushPendingReportHistory();
      await createWorkspaceCommandHandlers({
        t,
        getProjectFilePath: () => saveAs ? undefined : project?.filePath,
        getProjectRevision: () => useProjectStore.getState().projectRevision,
        isSaving: () => saving,
        isReadOnly: () => readOnly,
        requestSaveProjectPath: async () => {
          const selectedFilePath = await save({
            title: t("welcome.saveProjectDialog"),
            defaultPath: project?.filePath || "Untitled Project.spprj",
            filters: [{ name: "StatsPlayground Project", extensions: ["spprj"] }],
          });
          return typeof selectedFilePath === "string" ? selectedFilePath : null;
        },
        executeCommand: applicationRuntime.execute.bind(applicationRuntime),
        showToast,
      }).saveProject();
    } catch (error) {
      alert(`${t("menu.save")}: ${String(error)}`);
    }
  };
  handleSaveRef.current = handleSave;

  const handleSaveWorkflowSelection = async (name: string, nodeIds: string[]) => {
    if (readOnly) return;
    try {
      const currentLineageGraph = buildProjectDependencyGraph({
        datasets: useDataStore.getState().datasets,
        tableTransforms: useTableTransformStore.getState().definitions,
        tableTransformBindings: useTableTransformStore.getState().bindings,
        graphs: useGraphBuilderStore.getState().items,
        analyses: useAnalysisStore.getState().items,
        tabulates: useTabulateStore.getState().items,
        reports: useReportStore.getState().items,
      });
      const initiallySelected = new Set(nodeIds);
      const selectedInputArtifactIds = new Set(
        currentLineageGraph.edges
          .filter((edge) => edge.kind === "consumes"
            && initiallySelected.has(edge.source.nodeId)
            && initiallySelected.has(edge.target.nodeId))
          .map((edge) => edge.source.nodeId),
      );
      const selectedNodeIds = nodeIds.filter((nodeId) => !selectedInputArtifactIds.has(nodeId));
      const selectedNodeIdSet = new Set(selectedNodeIds);
      const selectedEdgeIds = currentLineageGraph.edges
        .filter((edge) => selectedNodeIdSet.has(edge.source.nodeId)
          && selectedNodeIdSet.has(edge.target.nodeId))
        .map((edge) => edge.id);
      const externalInputIds = new Set(
        currentLineageGraph.edges
          .filter((edge) => edge.kind === "consumes"
            && selectedNodeIdSet.has(edge.target.nodeId)
            && !selectedNodeIdSet.has(edge.source.nodeId))
          .map((edge) => edge.source.nodeId),
      );
      const tableSchemas = await Promise.all([...externalInputIds].map(async (artifactNodeId) => {
        const node = currentLineageGraph.nodes.find((candidate) => candidate.id === artifactNodeId);
        if (!node || node.nodeType !== "artifact" || node.artifactKind !== "table") {
          throw new Error(`Workflow input ${artifactNodeId} is not a table`);
        }
        const [columns, displayProps] = await Promise.all([
          dataService.getColumns(node.documentRef.id),
          dataService.getColumnDisplayProps(node.documentRef.id),
        ]);
        return {
          artifactNodeId,
          columns: mergeWorkflowTableColumns(columns, displayProps),
        };
      }));
      const workflow = await projectService.extractWorkflow({
        workflowId: `workflow-${crypto.randomUUID()}`,
        name,
        formatVersion: "1",
        revision: 1,
        graph: currentLineageGraph,
        selectedNodeIds,
        selectedEdgeIds,
        tableSchemas,
        operationColumnRequirements: deriveWorkflowOperationColumnRequirements(
          currentLineageGraph,
          selectedNodeIds,
        ),
      });
      addWorkflow(workflow);
      setActiveWorkflowViewId(workflow.id);
      markDirty();
    } catch (error) {
      alert(t("workflow.saveFailed", {
        defaultValue: "Failed to save workflow: {{message}}",
        message: String(error),
      }));
    }
  };

  const handleRunWorkflow = async (
    workflow: (typeof workflows)[number],
    bindings: Record<string, string>,
  ) => {
    const previousRuns = useWorkflowStore.getState().workflowRuns
      .filter((run) => run.workflowId === workflow.id);
    const latestBindings = [...previousRuns]
      .reverse()
      .find((run) => run.workflowRevision === workflow.revision)
      ?.outputBindings;
    const outputBindings = workflow.outputDeclarations.map((declaration) => ({
      declarationId: declaration.id,
      artifactDocumentId: latestBindings
        ?.find((binding) => binding.declarationId === declaration.id)
        ?.artifactDocumentId
        ?? `${workflow.id}-${declaration.id}`,
    }));
    const inputBindings = workflow.inputSlots.map((slot) => ({
      slotId: slot.id,
      tableDocumentId: bindings[slot.id] ?? "",
    }));
    setBusyMessage(t("workflow.running", { defaultValue: "Running workflow..." }));
    try {
      const packet = await projectService.runWorkflow({
        workflow,
        inputBindings,
        outputBindings,
        seed: 0,
        previousRuns,
      });
      const tableOutputIds = workflow.outputDeclarations
        .filter((declaration) => declaration.artifactKind === "table")
        .map((declaration) => outputBindings
          .find((binding) => binding.declarationId === declaration.id)!
          .artifactDocumentId);
      await applyWorkflowRunCommit(packet, {
        datasetIds: [
          ...useDataStore.getState().datasets.map((dataset) => dataset.id),
          ...tableOutputIds,
        ],
        refreshDatasets,
        markDirty,
      });
      if (packet.run.status === "succeeded") {
        await projectService.acknowledgeWorkflowCommit(packet.commitId);
      }
    } finally {
      setBusyMessage(null);
    }
  };

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

  const handleDownloadUpdate = async () => {
    if (!availableUpdate) return;
    try {
      await openUpdateUrl(availableUpdate.downloadUrl);
      dismissUpdate();
    } catch {
      showToast(t("update.openFailed", { defaultValue: "Unable to open the update download." }), 3000);
    }
  };

  const handleCloseProject = async () => {
    if (useProjectStore.getState().readOnly) return;
    if (useProjectStore.getState().dirty && !window.confirm(t("workspace.discardUnsavedChanges"))) return;
    await flushPendingReportHistory();
    await clearWorkspaceDocumentSelection();
    setDirty(false);
    resetRevision();
    resetHistory();
    resetGraphBuilders();
    resetGraphBuildersNew();
    resetReports();
    resetAnalyses();
    resetTabulates();
    resetWorkflows();
    resetTableTransforms();
    resetDatasetFilters();
    resetTableViewports();
    fsReset();
    await initProject();
    await refreshDatasets();
    tableCounter.current = 0;
  };

  const handleOpenAnother = async () => {
    if (useProjectStore.getState().readOnly) return;
    const selected = await open({
      title: t("welcome.openProjectDialog"),
      filters: [{ name: "StatsPlayground Project", extensions: ["spprj"] }],
      multiple: false,
    });
    if (selected) {
      if (useProjectStore.getState().readOnly) return;
      if (useProjectStore.getState().dirty && !window.confirm(t("workspace.discardUnsavedChanges"))) return;
      await flushPendingReportHistory();
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
        loadDatasetFiltersFromProject(result.datasetFilters);
        const analysisProjectPayload = hydrateAnalysisProjectPayload({
          analyses: result.analyses ?? [],
          analysisFolders: result.analysisFolders ?? {},
          distributions: result.distributions ?? [],
          distributionFolders: result.distributionFolders ?? {},
          fitYByX: (result.fitYByX ?? []) as FitYByXItem[],
          fitYByXFolders: result.fitYByXFolders ?? {},
          fitModels: result.fitModels ?? [],
          fitModelFolders: result.fitModelFolders ?? {},
        });
        await clearWorkspaceDocumentSelection();
        resetHistory();
        resetGraphBuilders();
        resetGraphBuildersNew();
        resetReports();
        resetAnalyses();
        resetTabulates();
        resetWorkflows();
        resetTableTransforms();
        resetTableViewports();
        await refreshDatasets();
        if (result.datasetFilterMigrationConflicts.length > 0) {
          const datasetNames = new Map(
            useDataStore.getState().datasets.map((dataset) => [dataset.id, dataset.name]),
          );
          const names = result.datasetFilterMigrationConflicts
            .map((datasetId) => datasetNames.get(datasetId) ?? datasetId)
            .join(", ");
          showToast(t("workspace.datasetFilterMigrationConflict", { names }), 5000);
        }
        tableCounter.current = 0;
        const { loadFromProject } = useHistoryStore.getState();
        loadFromProject(
          result.history as HistoryEntry[],
          result.snapshots as NamedSnapshot[],
          result.historyCurrentIdx,
        );
        // Restore graph builders
        loadGraphBuildersNewFromProject(result.graphBuildersNew ?? []);
        if (result.graphBuilders && result.graphBuilders.length > 0) {
          loadGraphBuildersFromProject(result.graphBuilders as GraphBuilderItem[]);
        }
        loadReportsFromProject((result.reports ?? []) as ReportItem[]);
        loadAnalyses(analysisProjectPayload.analyses as AnalysisDocument[]);
        loadTabulatesFromProject((result.tabulates ?? []) as TabulateItem[]);
        loadWorkflowsFromProject({
          workflows: result.workflows ?? [],
          logicalFolders: result.logicalFolders ?? [],
          workflowRuns: result.workflowRuns ?? [],
          lineageGraph: result.lineageGraph ?? {
            id: "project-lineage",
            name: "Project lineage",
            graphVersion: 0,
            graphHash: "",
            nodes: [],
            edges: [],
          },
        });
        loadTableTransforms(
          result.tableTransforms ?? [],
          result.tableTransformBindings ?? [],
        );
        for (const packet of result.recoveredWorkflowPackets ?? []) {
          await applyWorkflowRunCommit(packet, {
            datasetIds: useDataStore.getState().datasets.map((dataset) => dataset.id),
            refreshDatasets,
            markDirty,
          });
          await projectService.acknowledgeWorkflowCommit(packet.commitId);
        }
        // Restore folder tree + table/graph→folder assignments. We do this
        // after datasets/graphs are loaded so a subsequent prune pass keeps
        // assignments in sync with currently-existing items.
        fsLoadFromProject({
          folders: result.folders ?? [],
          tableFolders: result.tableFolders ?? {},
          graphFolders: result.graphFolders ?? {},
          graphNewFolders: result.graphNewFolders ?? {},
          fitYByXFolders: {},
          fitModelFolders: {},
          reportFolders: result.reportFolders ?? {},
          tabulateFolders: result.tabulateFolders ?? {},
          distributionFolders: {},
          analysisFolders: analysisProjectPayload.analysisFolders,
        });
        if (shouldMarkAnalysisMigrationDirty(analysisProjectPayload.migratedCount)) {
          markDirty();
        }
        if (result.documentNameMigrations.length > 0) {
          showToast(
            t("workspace.documentNameMigrations", { count: result.documentNameMigrations.length }),
            4000,
          );
        } else if (result.requiresMigration) {
          showToast(
            t("workspace.projectRequiresMigration"),
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

  const singleExportBaseName = useCallback((plan: TableExportPlan): string => {
    const datasetId = plan.datasetIds[0];
    if (!datasetId) {
      return "export";
    }
    const archivePath = plan.archivePaths[datasetId];
    if (archivePath) {
      const parts = archivePath.split("/");
      const leaf = parts[parts.length - 1];
      if (leaf) {
        return leaf;
      }
    }
    return datasets.find((dataset) => dataset.id === datasetId)?.name ?? "export";
  }, [datasets]);

  const tableExportPickerTitle = useCallback((format: TableExportPlan["format"]): string => {
    const defaultTitle = format === "csv"
      ? "Export tables as CSV"
      : format === "sqlite"
        ? "Export tables as SQLite"
        : "Export tables as SPTB";
    return t(`tableExport.pickerTitle.${format}`, { defaultValue: defaultTitle });
  }, [t]);

  const handleExportTables = async (plan: TableExportPlan) => {
    let outputPath: string | null = null;
    const pickerTitle = tableExportPickerTitle(plan.format);

    if (plan.mode === "zip") {
      const selectedDirectory = await open({ directory: true, multiple: false, title: pickerTitle });
      if (typeof selectedDirectory !== "string") {
        return false;
      }
      outputPath = await join(selectedDirectory, plan.suggestedFilename);
    } else {
      const defaultPath = plan.mode === "sqlite-subset"
        ? `${(project?.name ?? "export").trim() || "export"}.db`
        : `${singleExportBaseName(plan)}.${plan.format}`;
      const filters = plan.format === "csv"
        ? [{ name: "CSV", extensions: ["csv"] }]
        : plan.format === "sqlite"
          ? [{ name: "SQLite", extensions: ["db", "sqlite", "sqlite3"] }]
          : [{ name: "StatsPlayground Table", extensions: ["sptb"] }];
      const selectedFile = await save({
        title: pickerTitle,
        defaultPath,
        filters,
      });
      if (typeof selectedFile !== "string") {
        return false;
      }
      outputPath = selectedFile;
    }

    if (plan.format === "csv") {
      if (plan.mode === "single-file") {
        return createWorkspaceCommandHandlers({
          t,
          getProjectFilePath: () => project?.filePath,
          getProjectRevision: () => useProjectStore.getState().projectRevision,
          isSaving: () => saving,
          isReadOnly: () => readOnly,
          executeCommand: applicationRuntime.execute.bind(applicationRuntime),
          authorizeCsvExportRoot: ioService.authorizeCsvExportRoot,
          revokeCsvExportRoot: ioService.revokeCsvExportRoot,
          listCommandRequests: mcpManagementService.listCommandRequests,
          confirmCommandRequest: mcpManagementService.confirmCommandRequest,
          confirmOverwrite: () => window.confirm(t("common.confirmOverwrite", { defaultValue: "Overwrite the existing file?" })),
          waitForCommandConfirmation,
        }).exportCsv(plan, outputPath);
      }
      await ioService.exportCsvZipSubset(outputPath, plan.datasetIds, plan.archivePaths);
      return true;
    }

    if (plan.format === "sqlite") {
      await ioService.exportSqliteSubset(outputPath, plan.datasetIds, plan.sqliteNames);
      return true;
    }

    if (plan.mode === "single-file") {
      await projectService.exportTable(plan.datasetIds[0]!, outputPath);
      return true;
    }

    await projectService.exportTablesSptbZip(plan.datasetIds, outputPath, plan.archivePaths);
    return true;
  };

  const waitForCommandConfirmation = async (requestId: string, commandPromise: Promise<unknown>) => {
    return waitForWorkspaceCommandConfirmation(requestId, commandPromise, {
      listCommandRequests: mcpManagementService.listCommandRequests,
      waitForAnimationFrame: () => new Promise<void>((resolve) => {
        window.requestAnimationFrame(() => resolve());
      }),
    });
  };

  const handleCreateSnapshot = async () => {
    try {
      await createWorkspaceCommandHandlers({
        t,
        getProjectFilePath: () => project?.filePath,
        getProjectRevision: () => useProjectStore.getState().projectRevision,
        isSaving: () => saving,
        isReadOnly: () => readOnly,
        executeCommand: applicationRuntime.execute.bind(applicationRuntime),
        listen,
        setBusyMessage,
      }).createSnapshot();
    } finally {
    }
  };

  const handleSnapshotContextMenu = (menu: SnapshotMenuData) => {
    setSnapMenu(menu);
    setConfirmDeleteSnapId(null);
  };

  // ---- Folder mutation helpers wired to the side-panel UI ----------------

  /** Prompt-less "New folder" handler. Creates a folder under `parent` with a
   *  default localized name; the user can immediately rename it via F2 or by
   *  double-clicking. */
  const handleCreateFolder = (parent: string | null) => {
    if (readOnly) return;
    const baseName = t("folder.defaultName", { defaultValue: "New Folder" });
    let newPath: string;
    try {
      newPath = fsCreateFolder(parent, baseName);
    } catch (error) {
      if (!(error instanceof ProjectNameValidationError)) throw error;
      alert(invalidProjectNameMessage(error.code));
      return;
    }
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
      alert(invalidProjectNameMessage(err));
      return;
    }
    let newPath: string | null;
    try {
      newPath = fsRenameFolder(oldPath, newBase);
    } catch (error) {
      if (!(error instanceof ProjectNameValidationError)) throw error;
      alert(invalidProjectNameMessage(error.code));
      return;
    }
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
    | { kind: "graphNew"; id: string }
    | { kind: "report"; id: string }
    | { kind: "analysis"; id: string }
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
    try {
      if (payload.kind === "table") fsSetTableFolder(payload.id, target);
      else if (payload.kind === "graph") fsSetGraphFolder(payload.id, target);
      else if (payload.kind === "graphNew") fsSetGraphNewFolder(payload.id, target);
      else if (payload.kind === "report") fsSetReportFolder(payload.id, target);
      else if (payload.kind === "analysis") fsSetAnalysisFolder(payload.id, target);
      else if (payload.kind === "tabulate") fsSetTabulateFolder(payload.id, target);
      else if (payload.kind === "folder") fsMoveFolder(payload.path, target);
    } catch (error) {
      if (!(error instanceof ProjectNameValidationError)) throw error;
      alert(invalidProjectNameMessage(error.code));
      return;
    }
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
  // Memoize on the folder maps and live documents so we only rebuild when something actually changed.
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
    const tableTransformsByParent = new Map<string, typeof tableTransforms>();
    tableTransformsByParent.set(ROOT, tableTransforms);
    // Graphs per parent path.
    const graphsByParent = new Map<string, GraphBuilderItem[]>();
    for (const gb of graphBuilders) {
      const p = graphFolders[gb.id] ?? ROOT;
      const arr = graphsByParent.get(p) ?? [];
      arr.push(gb);
      graphsByParent.set(p, arr);
    }
    const graphsNewByParent = new Map<string, typeof graphBuildersNew>();
    for (const item of graphBuildersNew) {
      const parent = graphNewFolders[item.id] ?? ROOT;
      const children = graphsNewByParent.get(parent) ?? [];
      children.push(item);
      graphsNewByParent.set(parent, children);
    }
    const reportsByParent = new Map<string, ReportItem[]>();
    for (const item of reportItems) {
      const p = reportFolders[item.id] ?? ROOT;
      const arr = reportsByParent.get(p) ?? [];
      arr.push(item);
      reportsByParent.set(p, arr);
    }
    const analysesByParent = new Map<string, AnalysisDocument[]>();
    for (const item of analysisItems) {
      const p = analysisFolders[item.id] ?? ROOT;
      const arr = analysesByParent.get(p) ?? [];
      arr.push(item);
      analysesByParent.set(p, arr);
    }
    const tabulatesByParent = new Map<string, TabulateItem[]>();
    for (const item of tabulates) {
      const p = tabulateFolders[item.id] ?? ROOT;
      const arr = tabulatesByParent.get(p) ?? [];
      arr.push(item);
      tabulatesByParent.set(p, arr);
    }
    return { ROOT, childFolders, tablesByParent, tableTransformsByParent, graphsByParent, graphsNewByParent, reportsByParent, analysesByParent, tabulatesByParent };
  }, [folders, tableFolders, graphFolders, graphNewFolders, reportFolders, analysisFolders, tabulateFolders, datasets, tableTransforms, graphBuilders, graphBuildersNew, reportItems, analysisItems, tabulates]);

  /** Recursively render one folder level. */
  const renderFolderLevel = (parent: string | null, depth: number): React.ReactNode[] => {
    const ROOT = tree.ROOT;
    const key = parent ?? ROOT;
    const out: React.ReactNode[] = [];
    const folderChildren = tree.childFolders.get(key) ?? [];
    const tableChildren = tree.tablesByParent.get(key) ?? [];
    const transformChildren = tree.tableTransformsByParent.get(key) ?? [];
    const graphChildren = tree.graphsByParent.get(key) ?? [];
    const graphNewChildren = tree.graphsNewByParent.get(key) ?? [];
    const reportChildren = tree.reportsByParent.get(key) ?? [];
    const analysisChildren = tree.analysesByParent.get(key) ?? [];
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
            activateWorkspaceDocument("dataset", ds.id);
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
            <span className="ds-rename-shell">
              <input
                ref={renameInputRef}
                className="ds-rename-input"
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onBlur={() => void handleRenameSubmit(ds.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleRenameSubmit(ds.id);
                  if (e.key === "Escape") setRenamingId(null);
                }}
                onClick={(e) => e.stopPropagation()}
                autoFocus
              />
              <span className="ds-fixed-ext">{projectFileExtension("table")}</span>
            </span>
          ) : (
            <span className="ds-name">{withProjectExtension(ds.name, "table")}</span>
          )}
          <span className="ds-info">{ds.rowCount}×{ds.colCount}</span>
        </div>,
      );
    }
    for (const transform of transformChildren) {
      const binding = tableTransformBindings.find((item) => item.definitionId === transform.id);
      out.push(
        <div
          key={`table-transform:${transform.id}`}
          className={`dataset-item ${activeTableTransformId === transform.id ? "active" : ""}`}
          style={{ paddingLeft: 8 + depth * 12 + 12 }}
          onClick={() => activateWorkspaceDocument("tableTransform", transform.id)}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setCtxMenu({ kind: "tableTransform", id: transform.id, x: event.clientX, y: event.clientY });
          }}
        >
          <i className="ds-icon fa-solid fa-shuffle" aria-hidden="true" />
          <span className="ds-name">{withProjectExtension(transform.name, "tableTransform")}</span>
          <span className="ds-info gb-source-tag">{binding?.lastRun?.status ?? transform.operation.kind}</span>
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
            activateWorkspaceDocument("graph", gb.id);
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
            <span className="ds-rename-shell">
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
              <span className="ds-fixed-ext">{projectFileExtension("graph")}</span>
            </span>
          ) : (
            <span className="ds-name">{withProjectExtension(gb.name, "graph")}</span>
          )}
          <span className="ds-info gb-source-tag">
            {sourceDs ? sourceDs.name : t("workspace.datasourceMissing")}
          </span>
        </div>,
      );
    }
    for (const item of graphNewChildren) {
      const source = datasets.find((dataset) => dataset.id === item.datasetId);
      out.push(
        <div
          key={`graphNew:${item.id}`}
          data-testid={`graph-new-document-${item.id}`}
          className={`dataset-item ${activeGraphBuilderNewId === item.id ? "active" : ""}`}
          style={{ paddingLeft: 8 + depth * 12 + 12 }}
          draggable={!readOnly}
          onDragStart={(event) => handleDragStart(event, { kind: "graphNew", id: item.id })}
          onClick={() => handleOpenGraphBuilderNew(item.id)}
          onDoubleClick={() => {
            if (readOnly) return;
            setRenamingId(item.id);
            setRenameValue(item.name);
          }}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setCtxMenu({ kind: "graphNew", id: item.id, x: event.clientX, y: event.clientY });
          }}
          title={source ? t("workspace.datasourceLabel", { name: source.name }) : t("workspace.datasourceDeleted")}
        >
          <i className="ds-icon fa-solid fa-chart-line" aria-hidden="true" />
          {renamingId === item.id ? (
            <span className="ds-rename-shell">
              <input
                ref={renameInputRef}
                className="ds-rename-input"
                value={renameValue}
                onChange={(event) => setRenameValue(event.target.value)}
                onBlur={() => void handleRenameSubmit(item.id)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void handleRenameSubmit(item.id);
                  if (event.key === "Escape") setRenamingId(null);
                }}
                onClick={(event) => event.stopPropagation()}
                autoFocus
              />
              <span className="ds-fixed-ext">{projectFileExtension("graphNew")}</span>
            </span>
          ) : (
            <span className="ds-name">{withProjectExtension(item.name, "graphNew")}</span>
          )}
          <span className="ds-info gb-source-tag">{source?.name ?? t("workspace.datasourceMissing")}</span>
        </div>,
      );
    }
    for (const item of reportChildren) {
      out.push(
        <div
          key={`report:${item.id}`}
          className={`dataset-item ${activeReportId === item.id ? "active" : ""}`}
          style={{ paddingLeft: 8 + depth * 12 + 12 }}
          draggable={!readOnly}
          onDragStart={(e) => handleDragStart(e, { kind: "report", id: item.id })}
          onClick={() => {
            activateWorkspaceDocument("report", item.id);
          }}
          onDoubleClick={() => {
            if (readOnly) return;
            setRenamingId(item.id);
            setRenameValue(item.name);
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setCtxMenu({ kind: "report", id: item.id, x: e.clientX, y: e.clientY });
          }}
        >
          <i className="ds-icon fa-solid fa-file-lines" aria-hidden="true" />
          {renamingId === item.id ? (
            <span className="ds-rename-shell">
              <input
                ref={renameInputRef}
                className="ds-rename-input"
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onBlur={() => handleRenameSubmit(item.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleRenameSubmit(item.id);
                  if (e.key === "Escape") setRenamingId(null);
                }}
                onClick={(e) => e.stopPropagation()}
                autoFocus
              />
              <span className="ds-fixed-ext">{projectFileExtension("report")}</span>
            </span>
          ) : (
            <span className="ds-name">{withProjectExtension(item.name, "report")}</span>
          )}
        </div>,
      );
    }
    for (const item of analysisChildren) {
      const sourceDs = datasets.find((dataset) => dataset.id === item.source.datasetId);
      out.push(
        <div
          key={`analysis:${item.id}`}
          className={`dataset-item ${activeAnalysisId === item.id ? "active" : ""}`}
          style={{ paddingLeft: 8 + depth * 12 + 12 }}
          draggable={!readOnly}
          onDragStart={(event) => handleDragStart(event, { kind: "analysis", id: item.id })}
          onClick={() => {
            activateWorkspaceDocument("analysis", item.id);
          }}
          onDoubleClick={() => {
            if (readOnly) return;
            setRenamingId(item.id);
            setRenameValue(item.name);
          }}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setCtxMenu({ kind: "analysis", id: item.id, x: event.clientX, y: event.clientY });
          }}
          title={sourceDs ? t("workspace.datasourceLabel", { name: sourceDs.name }) : t("workspace.analysisSourceMissing")}
        >
          <i className="ds-icon fa-solid fa-magnifying-glass-chart" aria-hidden="true" />
          {renamingId === item.id ? (
            <span className="ds-rename-shell">
              <input
                ref={renameInputRef}
                className="ds-rename-input"
                value={renameValue}
                onChange={(event) => setRenameValue(event.target.value)}
                onBlur={() => handleRenameSubmit(item.id)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") handleRenameSubmit(item.id);
                  if (event.key === "Escape") setRenamingId(null);
                }}
                onClick={(event) => event.stopPropagation()}
                autoFocus
              />
              <span className="ds-fixed-ext">{projectFileExtension("analysis")}</span>
            </span>
          ) : (
            <span className="ds-name">{withProjectExtension(item.name, "analysis")}</span>
          )}
          <span className="ds-info gb-source-tag">
            {sourceDs ? sourceDs.name : t("workspace.analysisSourceMissing")}
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
            activateWorkspaceDocument("tabulate", item.id);
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
            <span className="ds-rename-shell">
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
              <span className="ds-fixed-ext">{projectFileExtension("tabulate")}</span>
            </span>
          ) : (
            <span className="ds-name">{withProjectExtension(item.name, "tabulate")}</span>
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
              <div className={`menu-item${readOnly ? " menu-item-disabled" : ""}`} onClick={readOnly ? undefined : handleCloseProject}>{t("welcome.newProject")}</div>
              <div className={`menu-item${saving ? " menu-item-disabled" : ""}`} onClick={saving ? undefined : () => void handleSave()}>{t("menu.save")}<span className="menu-shortcut">{modKey}S</span></div>
              <div className={`menu-item${saving ? " menu-item-disabled" : ""}`} onClick={saving ? undefined : () => void handleSave(true)}>{t("menu.saveAs")}</div>
              <div className="menu-sep" />
              <div className={`menu-item${readOnly ? " menu-item-disabled" : ""}`} onClick={readOnly ? undefined : () => setShowPostgresDataLink(true)}>{t("menu.dataLink")}</div>
              <div className="menu-sep" />
              <div className="menu-item" onClick={() => setShowPrefs(true)}>{t("menu.preferences")}<span className="menu-shortcut">{modKey},</span></div>
              <div className="menu-sep" />
              <div className={`menu-item${readOnly ? " menu-item-disabled" : ""}`} onClick={readOnly ? undefined : handleOpenAnother}>{t("menu.openProject")}<span className="menu-shortcut">{modKey}O</span></div>
              <div className={`menu-item${readOnly ? " menu-item-disabled" : ""}`} onClick={readOnly ? undefined : handleCloseProject}>{t("menu.closeProject")}</div>
            </MenuDropdown>
            <MenuDropdown label={t("menu.table")}>
              <div className={`menu-item${readOnly ? " menu-item-disabled" : ""}`} onClick={readOnly ? undefined : handleCreateTable}>{t("menu.newTable")}<span className="menu-shortcut">{modKey}N</span></div>
              <div
                className={`menu-item${readOnly || datasets.length === 0 ? " menu-item-disabled" : ""}`}
                onClick={readOnly || datasets.length === 0 ? undefined : () => setShowTableTransformDialog(true)}
              >
                {t("menu.transform", { defaultValue: "Transform..." })}
              </div>
              <div
                className={`menu-item${activeDatasetId && !readOnly ? "" : " menu-item-disabled"}`}
                onClick={activeDatasetId && !readOnly ? handleCreateTabulate : undefined}
              >
                {t("menu.tabulate")}
              </div>
              <div className={`menu-item${readOnly ? " menu-item-disabled" : ""}`} onClick={readOnly ? undefined : (() => setShowSqlQuery(true))}>{t("menu.sqlQuery")}</div>
              <div className="menu-sep" />
              <div className={`menu-item${readOnly ? " menu-item-disabled" : ""}`} onClick={readOnly ? undefined : handleImportTableSptb}>{t("menu.importSptb")}</div>
              <div className={`menu-item${readOnly ? " menu-item-disabled" : ""}`} onClick={readOnly ? undefined : handleImportCsv}>{t("menu.importCsv")}</div>
              <div className={`menu-item${readOnly ? " menu-item-disabled" : ""}`} onClick={readOnly ? undefined : handleImportSqlite}>{t("menu.importSqlite")}</div>
              <div className="menu-sep" />
              <div className={`menu-item${datasets.length === 0 ? " menu-item-disabled" : ""}`} onClick={datasets.length === 0 ? undefined : (() => setShowTableExport(true))}>{t("menu.exportTables", { defaultValue: "Export Tables..." })}</div>
            </MenuDropdown>
            <MenuDropdown label={t("menu.graph")}>
              <div className={`menu-item${readOnly ? " menu-item-disabled" : ""}`} onClick={readOnly ? undefined : handleCreateGraphBuilder}>{t("menu.newGraph")}</div>
              <div
                className={`menu-item${activeDatasetId && !readOnly ? "" : " menu-item-disabled"}`}
                onClick={activeDatasetId && !readOnly ? handleCreateGraphBuilderNew : undefined}
                onKeyDown={activeDatasetId && !readOnly ? (event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    handleCreateGraphBuilderNew();
                  }
                } : undefined}
                role="menuitem"
                tabIndex={activeDatasetId && !readOnly ? 0 : -1}
              >
                {t("menu.massiveDataGraph")}
              </div>
              <div className="menu-sep" />
              <div className={`menu-item${readOnly ? " menu-item-disabled" : ""}`} onClick={readOnly ? undefined : handleImportGraphSpgh}>{t("menu.importSpgh")}</div>
            </MenuDropdown>
            <MenuDropdown label={t("menu.analyze")}>
              <div
                className={`menu-item${readOnly ? " menu-item-disabled" : ""}`}
                onClick={readOnly ? undefined : handleCreateAnalysisSample}
              >
                {t("menu.analysisSample")}
              </div>
              <div className="menu-sep" />
              <div
                className={`menu-item${activeDatasetId && !readOnly ? "" : " menu-item-disabled"}`}
                onClick={activeDatasetId && !readOnly ? handleCreateFitYByX : undefined}
              >
                {t("menu.fitYByX")}
              </div>
              <div
                className={`menu-item${activeDatasetId && !readOnly ? "" : " menu-item-disabled"}`}
                onClick={activeDatasetId && !readOnly ? handleCreateFitModel : undefined}
              >
                {t("menu.fitModel")}
              </div>
              <div
                className={`menu-item${activeDatasetId && !readOnly ? "" : " menu-item-disabled"}`}
                onClick={activeDatasetId && !readOnly ? handleCreateDistribution : undefined}
              >
                {t("menu.distribution")}
              </div>
              <div
                className={`menu-item${activeDatasetId && !readOnly ? "" : " menu-item-disabled"}`}
                onClick={activeDatasetId && !readOnly ? handleCreateHypothesisTest : undefined}
              >
                {t("menu.hypothesisTest", { defaultValue: "Hypothesis Test" })}
              </div>
            </MenuDropdown>
            <MenuDropdown label={t("menu.report")}>
              <div className={`menu-item${readOnly ? " menu-item-disabled" : ""}`} onClick={readOnly ? undefined : handleCreateReport}>{t("menu.newReport")}</div>
            </MenuDropdown>
            <MenuDropdown label={t("menu.ai", { defaultValue: "AI" })}>
              <div className="menu-item" onClick={() => {
                applyWorkspaceAiNavigation(openWorkspaceAiServer({ activeTab, activeAiSubview }), {
                  setActiveTab,
                  setActiveAiSubview,
                });
              }}>{t("menu.mcpServer", { defaultValue: "MCP Server..." })}</div>
              <div className="menu-item" onClick={() => {
                applyWorkspaceAiNavigation(openWorkspaceAiSkills({ activeTab, activeAiSubview }), {
                  setActiveTab,
                  setActiveAiSubview,
                });
              }}>{t("menu.skills", { defaultValue: "Skills..." })}</div>
            </MenuDropdown>
            <MenuDropdown label={t("menu.help")}>
              <div className="menu-item" onClick={() => setHelpDialog(true)}>{t("menu.about")}</div>
            </MenuDropdown>
          </MenuBar>
        </div>
        <div className="menu-spacer" />
        <button
          className={`menu-bar-snapshot${dirty ? " menu-bar-snapshot-dirty" : ""}`}
          disabled={readOnly}
          onClick={handleCreateSnapshot}
          title={t("workspace.createSnapshotTitle")}
        >
          <i className="fa-solid fa-camera" aria-hidden="true" />
        </button>
        <button
          className={`menu-bar-save${dirty ? " menu-bar-save-dirty" : ""}`}
          disabled={saving}
          onClick={() => void handleSave()}
          title={t("common.saveWith", { key: modKey })}
        >
          <i className="fa-solid fa-floppy-disk" aria-hidden="true" />
        </button>
      </div>

      {/* Workspace */}
      <WorkspaceFrame
        activityBar={(
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
          <button
            className={`activity-btn${activeTab === "workflow" ? " activity-btn-active" : ""}`}
            onClick={() => setActiveTab("workflow")}
            title={t("workflow.title", { defaultValue: "Workflow" })}
            aria-label={t("workflow.title", { defaultValue: "Workflow" })}
          >
            <i className="fa-solid fa-diagram-project" aria-hidden="true" />
          </button>
          <button
            className={`activity-btn${activeTab === "ai" ? " activity-btn-active" : ""}`}
            onClick={() => {
              applyWorkspaceAiNavigation(openWorkspaceAiServer({ activeTab, activeAiSubview }), {
                setActiveTab,
                setActiveAiSubview,
              });
            }}
            title={t("menu.ai", { defaultValue: "AI" })}
            aria-label={t("menu.ai", { defaultValue: "AI" })}
          >
            <i className="fa-solid fa-robot" aria-hidden="true" />
          </button>
          </div>
        )}
        sidePanel={(
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
                {datasets.length === 0 && graphBuilders.length === 0 && graphBuildersNew.length === 0 && reportItems.length === 0 && analysisItems.length === 0 && tabulates.length === 0 && folders.length === 0 ? (
                  <div className="empty-hint">{t("common.noContent")}</div>
                ) : (
                  renderFolderLevel(null, 0)
                )}
              </div>
            </>
          ) : activeTab === "workflow" ? (
            <WorkflowPanel
              lineageGraph={projectLineageGraph}
              workflows={workflows}
              workflowRuns={workflowRuns}
              selectedId={activeWorkflowViewId}
              onSelect={setActiveWorkflowViewId}
            />
          ) : activeTab === "ai" ? (
            <>
              <div className="panel-header">
                <h3>{t("menu.ai", { defaultValue: "AI" })}</h3>
              </div>
              <div className="ai-nav-list">
                <button
                  type="button"
                  className={`ai-nav-btn${activeAiSubview === "server" ? " ai-nav-btn-active" : ""}`}
                  onClick={() => setActiveAiSubview("server")}
                >
                  <span>MCP Server</span>
                  <i className="fa-solid fa-plug" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className={`ai-nav-btn${activeAiSubview === "skills" ? " ai-nav-btn-active" : ""}`}
                  onClick={() => setActiveAiSubview("skills")}
                >
                  <span>Skills</span>
                  <i className="fa-solid fa-wand-magic-sparkles" aria-hidden="true" />
                </button>
              </div>
            </>
          ) : (
            <HistoryPanel
              setBusyMessage={setBusyMessage}
              onSnapshotMenu={handleSnapshotContextMenu}
              snapRenameRef={snapRenameRef}
            />
          )}
          </div>
        )}
      >
        <div className="main-area">
          {activeTab === "ai" ? (
            <AiActivityView
              subview={activeAiSubview}
              onSelectSubview={setActiveAiSubview}
            />
          ) : activeTab === "workflow" ? (
            <WorkflowView
              lineageGraph={projectLineageGraph}
              workflow={workflows.find((workflow) => workflow.id === activeWorkflowViewId)}
              datasets={datasets}
              suggestedWorkflowName={`Workflow ${workflows.length + 1}`}
              onSaveSelection={readOnly ? undefined : handleSaveWorkflowSelection}
              onRun={readOnly ? undefined : (bindings) => {
                const workflow = workflows.find((entry) => entry.id === activeWorkflowViewId);
                if (!workflow) throw new Error("Workflow is not available");
                return handleRunWorkflow(workflow, bindings);
              }}
            />
          ) : activeGraphBuilderNewId ? (
            (() => {
              const session = graphBuilderNewSessions.find((candidate) => candidate.id === activeGraphBuilderNewId);
              const dataset = datasets.find((candidate) => candidate.id === session?.datasetId);
              return (
                <GraphBuilderNewView
                  sessionId={activeGraphBuilderNewId}
                  dataset={dataset}
                  onClose={() => {
                    closeGraphBuilderNew(activeGraphBuilderNewId);
                    setActiveGraphBuilderNewId(null);
                  }}
                />
              );
            })()
          ) : activeAnalysisId ? (
            (() => {
              const item = analysisItems.find((entry) => entry.id === activeAnalysisId);
              if (!item) {
                return <div className="main-content"><div className="workspace-empty"><p>{t("workspace.analysisMissing")}</p></div></div>;
              }
              const ds = datasets.find((dataset) => dataset.id === item.source.datasetId);
              return (
                <AnalysisView item={item} dataset={ds}
                  canEditInputs={!readOnly && ds != null}
                  onEditInputs={() => void handleEditAnalysisInputs(item.id)}
                  onGraphConfigChange={readOnly ? undefined : (role, graph) => {
                    const current = useAnalysisStore.getState().items.find((entry) => entry.id === item.id) ?? item;
                    if (current.analysisKind === "distribution") {
                      void applicationRuntime.execute(
                        {
                          type: "analysis.update",
                          input: {
                            analysisId: current.id,
                            analysisKind: "distribution",
                            expectedConfigRevision: current.configRevision,
                            draft: {
                              responses: current.definition.responses,
                              weight: current.definition.weight,
                              frequency: current.definition.frequency,
                              by: current.definition.by,
                              nestedSubgroup: current.definition.nestedSubgroup,
                              analysis: current.definition.analysis,
                              graphs: { ...current.definition.graphs, [role]: graph },
                            },
                          },
                        },
                        { kind: "ui" },
                      ).catch((error) => {
                        alert(String(error));
                      });
                      return;
                    }
                    if (current.analysisKind === "fitYByX") {
                      void applicationRuntime.execute(
                        {
                          type: "analysis.update",
                          input: {
                            analysisId: current.id,
                            analysisKind: "fitYByX",
                            expectedConfigRevision: current.configRevision,
                            draft: {
                              response: current.definition.response,
                              factor: current.definition.factor,
                              confidenceLevel: current.definition.confidenceLevel,
                              graph,
                            },
                          },
                        },
                        { kind: "ui" },
                      ).catch((error) => {
                        alert(String(error));
                      });
                    }
                  }}
                  onDefinitionChange={readOnly ? undefined : (patch) => {
                    if (item.analysisKind !== "fitModel" || patch.definition?.kind !== "fitModel") {
                      return;
                    }
                    void applicationRuntime.execute(
                      {
                        type: "analysis.update",
                        input: {
                          analysisId: item.id,
                          analysisKind: "fitModel",
                          expectedConfigRevision: item.configRevision,
                          draft: {
                            response: patch.definition.response,
                            construct: patch.definition.construct,
                            terms: patch.definition.terms,
                            centeringMethod: patch.definition.centeringMethod,
                            confidenceLevel: patch.definition.confidenceLevel,
                          },
                        },
                      },
                      { kind: "ui" },
                    ).catch((error) => {
                      alert(String(error));
                    });
                  }}
                  onDatasetChanged={async () => {
                    markDirty();
                    await refreshDatasets();
                  }}
                />
              );
            })()
          ) : activeTabulateId ? (
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
                  existingDatasetNames={datasets.map((entry) => entry.name)}
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
          ) : activeReportId ? (
            (() => {
              const item = reportItems.find((entry) => entry.id === activeReportId);
              if (!item) {
                return <div className="main-content"><div className="workspace-empty"><p>{t("workspace.reportMissing")}</p></div></div>;
              }
              return (
                <ReportView
                  item={item}
                  tableOptions={datasets.map((dataset) => ({ id: dataset.id, name: dataset.name }))}
                  graphOptions={graphBuilders.map((graph) => ({ id: graph.id, name: graph.name }))}
                  fitYByXOptions={fitYByXAnalysisItems.map((analysis) => ({ id: analysis.id, name: analysis.name }))}
                  hypothesisTestOptions={hypothesisTestAnalysisItems.map((analysis) => ({ id: analysis.id, name: analysis.name }))}
                  tabulateOptions={tabulates.map((analysis) => ({ id: analysis.id, name: analysis.name }))}
                  distributionOptions={distributionAnalysisItems.map((analysis) => ({ id: analysis.id, name: analysis.name }))}
                  onMarkdownChange={(markdown) => handleReportMarkdownChange(item.id, markdown)}
                  readOnly={readOnly}
                />
              );
            })()
          ) : activeTableTransformId ? (
            (() => {
              const definition = tableTransforms.find((item) => item.id === activeTableTransformId);
              const binding = tableTransformBindings.find((item) => item.definitionId === activeTableTransformId);
              if (!definition || !binding) {
                return <div className="main-content"><div className="workspace-empty"><p>{t("tableTransform.missing", { defaultValue: "Table transform no longer exists" })}</p></div></div>;
              }
              return (
                <TableTransformView
                  definition={definition}
                  binding={binding}
                  datasets={datasets}
                  readOnly={readOnly}
                  onRebind={async (role, tableDocumentId) => {
                    await rebindTableTransform(definition.id, role, tableDocumentId);
                    await refreshDatasets();
                    setTableKey((key) => key + 1);
                    invalidateData();
                    markDirty();
                  }}
                  onRerun={async () => {
                    await applicationRuntime.execute(
                      {
                        type: "tableTransform.run",
                        input: { transformId: definition.id },
                      },
                      { kind: "ui" },
                    );
                    setTableKey((key) => key + 1);
                    invalidateData();
                  }}
                  onOpenOutput={(tableDocumentId) => activateWorkspaceDocument("dataset", tableDocumentId)}
                />
              );
            })()
          ) : activeDatasetId ? (
            <DataTableView
              key={`${activeDatasetId}:${tableKey}`}
              datasetId={activeDatasetId}
              propertyManagerRequest={propertyManagerRequest}
              onPropertyManagerRequestHandled={handlePropertyManagerRequestHandled}
              onColumnRenamed={(oldName, newName, sqlType) => {
                migrateLegacyGraphColumnName(activeDatasetId, oldName, newName, sqlType);
                renameDatasetFilterColumn(activeDatasetId, oldName, newName);
              }}
            />
          ) : (
            <div className="main-content">
              <div className="workspace-empty">
                <p>{t("workspace.selectOrCreate")}</p>
              </div>
            </div>
          )}
        </div>
      </WorkspaceFrame>

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
        {statusInfo?.tableCacheDiagnostics && (
          <span>
            {statusInfo.tableCacheDiagnostics.cacheHit == null
              ? t("workspace.tableCache.pending", { defaultValue: "Cache pending" })
              : statusInfo.tableCacheDiagnostics.cacheHit
                ? t("workspace.tableCache.hit", { defaultValue: "Cache hit" })
                : t("workspace.tableCache.miss", { defaultValue: "Cache miss" })}
            {statusInfo.tableCacheDiagnostics.diagnosticJsonEncodeMs == null
              ? ""
              : ` · ${t("workspace.tableCache.encodeProxy", { defaultValue: "Diagnostic JSON encode" })} ${statusInfo.tableCacheDiagnostics.diagnosticJsonEncodeMs.toFixed(3)} ms`}
            {statusInfo.tableCacheDiagnostics.postReceivePaintMs == null
              ? ""
              : ` · ${t("workspace.tableCache.postReceivePaint", { defaultValue: "Post-receive paint" })} ${statusInfo.tableCacheDiagnostics.postReceivePaintMs.toFixed(3)} ms`}
            {statusInfo.tableCacheDiagnostics.diagnosticJsonBytes == null
              ? ""
              : ` · ${t("workspace.tableCache.responseBytes", { defaultValue: "Diagnostic JSON bytes" })} ${formatStatusBytes(statusInfo.tableCacheDiagnostics.diagnosticJsonBytes)}`}
            {` · ${statusInfo.tableCacheDiagnostics.retainedRows.toLocaleString()} ${t("workspace.tableCache.rows", { defaultValue: "rows" })}`}
            {` · ${statusInfo.tableCacheDiagnostics.entryCount.toLocaleString()} ${t("workspace.tableCache.entries", { defaultValue: "entries" })}`}
            {` · ${formatStatusBytes(statusInfo.tableCacheDiagnostics.estimatedBytes)}`}
          </span>
        )}
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

      {showPostgresDataLink && (
        <PostgresDataLinkDialog
          existingDatasetNames={datasets.map((dataset) => dataset.name)}
          onClose={() => setShowPostgresDataLink(false)}
          onImported={async (targetName, connector) => {
            markDirty();
            await refreshDatasets();
            const imported = useDataStore
              .getState()
              .datasets.find((dataset) => dataset.name.toLowerCase() === targetName.toLowerCase());
            if (imported) setActiveDataset(imported.id);
            recordAction(connector === "mysql"
              ? t("history.importMysql", { name: targetName, defaultValue: "Import MySQL snapshot: {{name}}" })
              : t("history.importPostgres", { name: targetName }));
          }}
        />
      )}

      {sqliteDataLinkPath && (
        <SqliteDataLinkDialog
          filePath={sqliteDataLinkPath}
          existingDatasetNames={datasets.map((dataset) => dataset.name)}
          onClose={closeDataLink}
          onImport={importSelectedSqlite}
        />
      )}

      <UpdateDialogs
        helpOpen={helpDialog}
        currentVersion={APP_VERSION}
        status={updateStatus}
        update={availableUpdate}
        onCheck={() => checkForUpdate("manual")}
        onCloseHelp={() => setHelpDialog(false)}
        onIgnore={dismissUpdate}
        onDownload={() => void handleDownloadUpdate()}
      />

      {showTableExport && (
        <TableExportDialog
          datasets={datasets}
          tableFolders={tableFolders}
          projectName={project?.name ?? "export"}
          onExport={handleExportTables}
          onClose={() => setShowTableExport(false)}
        />
      )}

      {showTableTransformDialog && (
        <TableOpsDialog
          datasets={datasets}
          activeDatasetId={activeDatasetId}
          onClose={() => setShowTableTransformDialog(false)}
          onSubmit={async (draft) => {
            await applicationRuntime.execute(
              {
                type: "tableTransform.create",
                input: { draft },
              },
              { kind: "ui" },
            );
            invalidateData();
          }}
        />
      )}

      {showSqlQuery && (
        <SqlQueryDialog
          datasets={datasets}
          tableFolders={tableFolders}
          onClose={() => setShowSqlQuery(false)}
          onCreateTable={async ({ sql, name }) => {
            await applicationRuntime.execute(
              {
                type: "sql.createTable",
                input: {
                  sql,
                  name,
                },
              },
              { kind: "ui" },
            );
            setShowSqlQuery(false);
          }}
        />
      )}

      {showFitYByXDialog && activeDatasetId && (
        <FitYByXRoleDialog
          mode="create"
          dataset={datasets.find((dataset) => dataset.id === activeDatasetId)!}
          defaultName={nextFitYByXAnalysisName(analysisItems)}
          onCancel={() => setShowFitYByXDialog(false)}
          onCreate={handleCreateFitYByXItem}
        />
      )}

      {showFitModelDialog && activeDatasetId && (
        <FitModelRoleDialog
          dataset={datasets.find((dataset) => dataset.id === activeDatasetId)!}
          prefill={fitModelPrefill}
          onCancel={() => {
            setShowFitModelDialog(false);
            setFitModelPrefill(null);
          }}
          onCreateDefinition={handleCreateFitModelItem}
        />
      )}

      {showHypothesisTestDialog && activeDatasetId && (
        <HypothesisTestDialog
          mode="create"
          dataset={datasets.find((dataset) => dataset.id === activeDatasetId)!}
          defaultName={nextHypothesisTestAnalysisName(analysisItems)}
          onCancel={() => setShowHypothesisTestDialog(false)}
          onSubmit={handleCreateHypothesisTestItem}
        />
      )}

      {showDistributionDialog && activeDatasetId && (
        <DistributionDialog
          open={showDistributionDialog}
          datasetId={activeDatasetId}
          columns={distributionColumns}
          defaultName={nextDistributionAnalysisName(analysisItems)}
          onManageProperties={handleManageDistributionProperties}
          onCancel={() => setShowDistributionDialog(false)}
          onSubmit={handleCreateDistributionItem}
        />
      )}

      {editingAnalysisId && (() => {
        const editingAnalysis = analysisItems.find((item) => item.id === editingAnalysisId);
        const dataset = editingAnalysis
          ? datasets.find((item) => item.id === editingAnalysis.source.datasetId)
          : undefined;
        if (!editingAnalysis || !dataset) return null;
        if (editingAnalysis.analysisKind === "fitYByX") {
          return (
            <FitYByXRoleDialog
              mode="edit"
              dataset={dataset}
              defaultName={editingAnalysis.name}
              initialValue={toAnalysisEditorItem(editingAnalysis)}
              onCancel={() => setEditingAnalysisId(null)}
              onCreate={(submitted) => handleUpdateFitYByXAnalysisInputs(editingAnalysis, submitted)}
            />
          );
        }
        if (editingAnalysis.analysisKind === "fitModel") {
          const editorItem = toAnalysisEditorItem(editingAnalysis);
          return (
            <FitModelRoleDialog
              dataset={dataset}
              initialDefinition={editorItem}
              onCancel={() => setEditingAnalysisId(null)}
              onCreateDefinition={(submitted) => handleUpdateFitModelAnalysisInputs(editingAnalysis, submitted)}
            />
          );
        }
        if (editingAnalysis.analysisKind === "hypothesisTest") {
          return (
            <HypothesisTestDialog
              mode="edit"
              dataset={dataset}
              defaultName={editingAnalysis.name}
              initialValue={toAnalysisEditorItem(editingAnalysis)}
              onCancel={() => setEditingAnalysisId(null)}
              onSubmit={(_name, submitted) => handleUpdateHypothesisTestAnalysisInputs(editingAnalysis, submitted)}
            />
          );
        }
        return (
          <DistributionDialog
            open
            datasetId={editingAnalysis.source.datasetId}
            columns={analysisEditorColumns}
            defaultName={editingAnalysis.name}
            initialItem={toAnalysisEditorItem(editingAnalysis)}
            onManageProperties={handleManageDistributionProperties}
            onCancel={() => setEditingAnalysisId(null)}
            onSubmit={(submitted) => handleUpdateDistributionAnalysisInputs(editingAnalysis, submitted)}
          />
        );
      })()}

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
            <div style={{ marginTop: 16, textAlign: "right" }}>
              <button className="btn-secondary" onClick={cancelActiveImport} disabled={cancellingImport || !activeImportRequestId}>
                {cancellingImport ? t("workspace.cancellingImport") : t("workspace.cancelImport")}
              </button>
            </div>
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
                  activateWorkspaceDocument("dataset", id);
                  setCtxMenu(null);
                })}>{t("common.rename")}</div>
                <div className="sp-ctx-sep" />
                <div className={`sp-ctx-item sp-ctx-danger${readOnly ? " sp-ctx-item-disabled" : ""}`} onClick={readOnly ? undefined : (() => { handleDeleteDataset(id); setCtxMenu(null); })}>{t("common.delete")}</div>
              </>
            );
          })()}
          {ctxMenu.kind === "tableTransform" && (() => {
            const id = ctxMenu.id;
            const transform = tableTransforms.find((item) => item.id === id);
            if (!transform) return null;
            return (
              <div
                className={`sp-ctx-item sp-ctx-danger${readOnly ? " sp-ctx-item-disabled" : ""}`}
                onClick={readOnly ? undefined : (() => {
                  handleDeleteTableTransform(id);
                  setCtxMenu(null);
                })}
              >
                {t("common.delete")}
              </div>
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
                  activateWorkspaceDocument("graph", id);
                  setCtxMenu(null);
                })}>{t("common.rename")}</div>
                <div className="sp-ctx-sep" />
                <div className={`sp-ctx-item sp-ctx-danger${readOnly ? " sp-ctx-item-disabled" : ""}`} onClick={readOnly ? undefined : (() => { handleDeleteGraphBuilder(id); setCtxMenu(null); })}>{t("common.delete")}</div>
              </>
            );
          })()}
          {ctxMenu.kind === "graphNew" && (() => {
            const item = graphBuildersNew.find((candidate) => candidate.id === ctxMenu.id);
            if (!item) return null;
            return (
              <>
                <div className={`sp-ctx-item${readOnly ? " sp-ctx-item-disabled" : ""}`} onClick={readOnly ? undefined : (() => {
                  setRenamingId(item.id);
                  setRenameValue(item.name);
                  setCtxMenu(null);
                })}>{t("common.rename")}</div>
                <div className="sp-ctx-sep" />
                <div className={`sp-ctx-item sp-ctx-danger${readOnly ? " sp-ctx-item-disabled" : ""}`} onClick={readOnly ? undefined : (() => {
                  handleDeleteGraphBuilderNew(item.id);
                  setCtxMenu(null);
                })}>{t("common.delete")}</div>
              </>
            );
          })()}
          {ctxMenu.kind === "report" && (() => {
            const id = ctxMenu.id;
            const item = reportItems.find((entry) => entry.id === id);
            if (!item) return null;
            return (
              <>
                <div className={`sp-ctx-item${readOnly ? " sp-ctx-item-disabled" : ""}`} onClick={readOnly ? undefined : (() => {
                  setRenamingId(id);
                  setRenameValue(item.name);
                  activateWorkspaceDocument("report", id);
                  setCtxMenu(null);
                })}>{t("common.rename")}</div>
                <div className="sp-ctx-sep" />
                <div className={`sp-ctx-item sp-ctx-danger${readOnly ? " sp-ctx-item-disabled" : ""}`} onClick={readOnly ? undefined : (() => { handleDeleteReport(id); setCtxMenu(null); })}>{t("common.delete")}</div>
              </>
            );
          })()}
          {ctxMenu.kind === "analysis" && (() => {
            const id = ctxMenu.id;
            const item = analysisItems.find((entry) => entry.id === id);
            if (!item) return null;
            return (
              <>
                <div className={`sp-ctx-item${readOnly ? " sp-ctx-item-disabled" : ""}`} onClick={readOnly ? undefined : (() => {
                  setRenamingId(id);
                  setRenameValue(item.name);
                  activateWorkspaceDocument("analysis", id);
                  setCtxMenu(null);
                })}>{t("common.rename")}</div>
                <div className="sp-ctx-sep" />
                <div className={`sp-ctx-item sp-ctx-danger${readOnly ? " sp-ctx-item-disabled" : ""}`} onClick={readOnly ? undefined : (() => { handleDeleteAnalysis(id); setCtxMenu(null); })}>{t("common.delete")}</div>
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
                  activateWorkspaceDocument("tabulate", id);
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
