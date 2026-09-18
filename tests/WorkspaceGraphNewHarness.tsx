import { useEffect, useState } from "react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";

import { Workspace } from "../src/components/Workspace";
import { createDefaultGraph2DState, createDefaultGraph3DState, createDefaultMultivariateGraphState } from "../src/components/graphBuilder/graphBuilderMode";
import i18n from "../src/i18n";
import { dataService } from "../src/services/dataService";
import { graphNewService } from "../src/services/graphNewService";
import type { SaveProjectRequest } from "../src/services/projectService";
import { useDataStore } from "../src/stores/useDataStore";
import { useFolderStore } from "../src/stores/useFolderStore";
import { useGraphBuilderNewStore } from "../src/stores/useGraphBuilderNewStore";
import { useGraphBuilderStore } from "../src/stores/useGraphBuilderStore";
import { useProjectStore } from "../src/stores/useProjectStore";
import type { GraphBuilderNewDocument } from "../src/types/graphBuilderNew";
import type { DatasetMeta } from "../src/types/data";

const dataset: DatasetMeta = { id: "source", name: "Measurements", sourcePath: null, sourceType: "manual", rowCount: 2, colCount: 2, generation: 7, createdAt: "2026-09-18", updatedAt: "2026-09-18" };
const project = { name: "Persistence", filePath: "", createdAt: "2026-09-18" };
const documents: GraphBuilderNewDocument[] = [
  { version: 1, id: "native-one", name: "First", datasetId: "source", xColumnId: "x", yColumnId: "y", showMean: false, xMode: "numeric", rawMode: "line", camera: { xMin: 25, xMax: 75, yMin: 25, yMax: 75 } },
  { version: 1, id: "native-two", name: "Second", datasetId: "source", xColumnId: "y", yColumnId: "x", showMean: true, xMode: "duration", rawMode: "pointsLine", camera: null },
];

export function WorkspaceGraphNewHarness({ missingOnly = false, legacyFolders = false }: { missingOnly?: boolean; legacyFolders?: boolean }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const previousData = useDataStore.getState();
    const previousProject = useProjectStore.getState();
    const previousFolder = useFolderStore.getState();
    const previousNative = useGraphBuilderNewStore.getState();
    const previousLegacy = useGraphBuilderStore.getState();
    const previousRender = graphNewService.render;
    const previousWindow = dataService.queryTableWindow;
    let currentDatasets = missingOnly ? [] : [dataset];
    let saved: SaveProjectRequest | null = null;
    let saveCount = 0;
    let currentFilePath = project.filePath;
    const savePaths: string[] = [];
    let failSave = false;
    let holdSave = false;
    let releaseSave: (() => void) | null = null;
    let legacyOpen = false;
    let openFailure: string | null = null;
    let missingField = false;
    const commands: string[] = [];
    const renderRequests: unknown[] = [];
    mockIPC(async (command, args: any) => {
      commands.push(command);
      if (command === "plugin:dialog|save") return "/virtual/persistence.spprj";
      if (command === "plugin:dialog|open") return "/virtual/persistence.spprj";
      if (command === "list_datasets") return currentDatasets;
      if (command === "get_dataset_generation") return currentDatasets[0]?.generation ?? 0;
      if (command === "get_column_descriptors") return [
        { columnId: "x", name: "X", sqlType: "DOUBLE" },
        ...missingField ? [] : [{ columnId: "y", name: "Y", sqlType: "DOUBLE" }],
      ];
      if (command === "get_columns") return [{ colIndex: 0, colName: "X", colType: "DOUBLE", role: "continuous", missingCount: 0 }, { colIndex: 1, colName: "Y", colType: "DOUBLE", role: "continuous", missingCount: 0 }];
      if (command === "get_column_display_props") return [];
      if (command === "save_project") {
        if (holdSave) await new Promise<void>((resolve) => { releaseSave = resolve; });
        if (failSave) throw new Error("injected_save_failure");
        saved = structuredClone(args.request);
        saveCount += 1;
        currentFilePath = args.request.filePath ?? currentFilePath;
        savePaths.push(currentFilePath);
        return { ...project, filePath: currentFilePath };
      }
      if (command === "init_project") { currentDatasets = []; return project; }
      if (command === "open_project") {
        if (openFailure) throw new Error(openFailure);
        currentDatasets = missingOnly ? [] : [{ ...dataset, generation: 23 }];
        const payload = structuredClone(saved ?? {});
        if (legacyOpen) { delete payload.graphBuildersNew; delete payload.graphNewFolders; }
        return { ...payload, project: { ...project, filePath: "/virtual/persistence.spprj" }, snapshots: [], datasetFilterMigrationConflicts: [], documentNameMigrations: [], datasetNameMigrations: [], requiresMigration: false };
      }
      if (command === "delete_dataset") { currentDatasets = currentDatasets.filter((item) => item.id !== args.datasetId); return null; }
      if (command === "graph_new_close" || command === "graph_new_cancel") return null;
      throw new Error(`Unexpected Workspace IPC: ${command}`);
    }, { shouldMockEvents: true });
    dataService.queryTableWindow = async (request) => ({ columns: ["__rowid__", "X", "Y"], columnTypes: ["BIGINT", "DOUBLE", "DOUBLE"], rows: [[1, 1, 2], [2, 2, 3]], totalRows: 2, start: request.start, generation: request.generation });
    graphNewService.render = (request, handlers) => {
      renderRequests.push(request);
      let cancelled = false;
      let presented = false;
      const width = Math.ceil(request.width * request.devicePixelRatio);
      const height = Math.ceil(request.height * request.devicePixelRatio);
      const completion = new Promise<any>((resolve) => setTimeout(() => {
        const pixels = new Uint8Array(width * height * 4).fill(255);
        for (let offset = Math.floor(height / 3) * width * 4; offset < Math.floor(height / 2) * width * 4; offset += 4) {
          pixels[offset] = 31; pixels[offset + 1] = 111; pixels[offset + 2] = 235;
        }
        handlers.onFrame({ header: { ...request, width, height, frameId: 1, format: "rgba8", byteLength: pixels.length, readbackCompletedAtUnixMicros: 1 }, payload: pixels.buffer });
        resolve({ requestId: request.requestId, processedRows: 2, finiteRows: 2, excludedNonFiniteRows: 0, selectedMarks: 2, exactVisible: true, visibleRows: 2,
          meanAvailable: true, meanGroups: request.showMean ? 2 : null, meanVisible: request.showMean, rawMode: request.rawMode, rawLineAvailable: true, rawLineSegments: 1,
          xAxis: { kind: "numeric", utc: false, ticks: [] }, width, height, cameraDomain: request.cameraDomain ?? { xMin: 0, xMax: 100, yMin: 0, yMax: 100 },
          plotRect: { x: 64, y: 16, width: width - 80, height: height - 48 }, buildMs: 1, renderMs: 1, readbackMs: 1, sourceProjectionQueryCount: 1, renderGenerationCheckCount: 4 });
      }, 20));
      return { completion, canPresent: () => !cancelled && !presented, markPresented: () => { presented = true; }, cancel: async () => { cancelled = true; }, snapshot: () => ({ maximumQueueDepth: 1, droppedSupersededFrames: 0, rejectedFrames: 0, presentedFrames: Number(presented), pendingFrameId: null }) };
    };
    useProjectStore.setState({ project, dirty: false, readOnly: false, saving: false, saveError: null });
    useDataStore.setState({ datasets: currentDatasets, activeDatasetId: null, statusInfo: null });
    useFolderStore.getState().reset();
    if (legacyFolders) useFolderStore.getState().loadFromProject({ folders: ["CON", "Charts/Inner"], tableFolders: {}, graphFolders: {}, tabulateFolders: {}, fitYByXFolders: {} });
    useFolderStore.setState({ collapsed: {} });
    useGraphBuilderNewStore.getState().loadFromProject(missingOnly ? [{ ...documents[0], datasetId: "missing-source" }] : documents);
    useGraphBuilderStore.getState().loadFromProject(missingOnly ? [] : [{ id: "legacy", name: "Legacy", sourceDatasetId: "source", mode: "2d", modeStates: { twoD: createDefaultGraph2DState(), threeD: createDefaultGraph3DState(), multivariate: createDefaultMultivariateGraphState() }, createdAt: "2026-09-18" }]);
    (window as any).__workspacePersistence = {
      snapshot: () => ({ documents: useGraphBuilderNewStore.getState().items, sessions: useGraphBuilderNewStore.getState().sessions, folders: useFolderStore.getState().graphNewFolders, folderPaths: useFolderStore.getState().folders, datasets: useDataStore.getState().datasets, project: useProjectStore.getState().project, legacy: useGraphBuilderStore.getState().items, dirty: useProjectStore.getState().dirty, readOnly: useProjectStore.getState().readOnly, saved, saveCount, commands, renderRequests }),
      failOpen: (message: string) => { openFailure = message; },
      savePaths: () => savePaths,
      language: (language: string) => i18n.changeLanguage(language),
      failSave: (value: boolean) => { failSave = value; },
      holdSave: () => { holdSave = true; },
      releaseSave: () => { holdSave = false; releaseSave?.(); },
      legacyOpen: () => { legacyOpen = true; },
      missingField: () => { missingField = true; },
    };
    void i18n.changeLanguage("en").then(() => setReady(true));
    return () => {
      useGraphBuilderNewStore.getState().reset();
      clearMocks();
      graphNewService.render = previousRender;
      dataService.queryTableWindow = previousWindow;
      useDataStore.setState(previousData, true);
      useProjectStore.setState(previousProject, true);
      useFolderStore.setState(previousFolder, true);
      useGraphBuilderNewStore.setState(previousNative, true);
      useGraphBuilderStore.setState(previousLegacy, true);
      delete (window as any).__workspacePersistence;
    };
  }, [missingOnly, legacyFolders]);
  return ready ? <Workspace /> : null;
}