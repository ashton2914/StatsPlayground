import { projectDocumentNames, createPersistedDocumentSetter, withoutDocumentPersistence } from "./documentStore";
import { defaultLineOptions } from "@/components/graphBuilder/shared/graphLayerOptionContracts";
import { createGraphNewLayer, migratedGraphNewLayers, normalizeGraphNewLayers, legacyRenderOptions } from "@/components/graphBuilderNew/graphNewLayers";
import type { GridLineStyle, RefLineStyle, RefLineX, RefLineY, YAxisConfig } from "@/graphCore/types";
import type { GraphNewLayer } from "@/types/graphBuilderNew";
import { create } from "zustand";

import { useProjectStore } from "@/stores/useProjectStore";
import type {
  GraphBuilderNewCamera,
  GraphBuilderNewDocument,
  GraphBuilderNewSession,
  GraphNewRawMode,
  GraphNewXMode,
  PersistedGraphBuilderNewDocument,
} from "@/types/graphBuilderNew";
import { assertProjectMutable } from "@/utils/saveReadOnly";
import { allocateProjectBasename, ProjectNameValidationError, validateNativeGraphBasename } from "@/utils/projectFileNaming";

const GROUP_ID = /^sha256:[0-9a-f]{64}$/;

interface GraphBuilderNewStore {
  items: GraphBuilderNewDocument[];
  sessions: GraphBuilderNewSession[];
  open: (datasetId: string, datasetGeneration: number) => string;
  reopen: (id: string, datasetGeneration: number) => string | null;
  renameItem: (id: string, name: string) => void;
  deleteItem: (id: string) => void;
  deleteByDataset: (datasetId: string) => void;
  loadFromProject: (items: PersistedGraphBuilderNewDocument[]) => void;
  reset: () => void;
  setCamera: (id: string, camera: GraphBuilderNewCamera | null) => void;
  setColumns: (
    id: string,
    xColumnId: string | null,
    yColumnId: string | null,
  ) => void;
  setOverlay: (id: string, overlayColumnId: string | null) => void;
  setHiddenOverlayGroups: (id: string, ids: string[]) => void;
  close: (id: string) => void;
  addLayer: (id: string, kind: GraphNewLayer["kind"]) => void;
  removeLayer: (id: string, layerId: string) => void;
  setLayerOptions: (id: string, layerId: string, patch: Record<string, unknown>) => void;
  setMean: (id: string, showMean: boolean) => void;
  setModes: (id: string, xMode: GraphNewXMode, rawMode: GraphNewRawMode) => void;
  setXAxisConfig: (id: string, config: YAxisConfig | undefined) => void;
  setYAxisConfig: (id: string, config: YAxisConfig | undefined) => void;
  setRefLinesX: (id: string, lines: RefLineX[]) => void;
  setRefLinesY: (id: string, lines: RefLineY[]) => void;
  setAutoSpecLinesX: (id: string, enabled: boolean) => void;
  setAutoSpecLinesY: (id: string, enabled: boolean) => void;
}

function copyCamera(camera: GraphBuilderNewCamera | null): GraphBuilderNewCamera | null {
  if (camera === null) return null;
  const { xMin, xMax, yMin, yMax } = camera;
  if (![xMin, xMax, yMin, yMax].every(Number.isFinite) || xMin >= xMax || yMin >= yMax) {
    throw new Error("graph_new_invalid_camera");
  }
  return { xMin, xMax, yMin, yMax };
}

function normalizeHiddenOverlayGroupIds(
  overlayColumnId: string | null,
  hiddenOverlayGroupIds: readonly string[],
): string[] {
  const ids = [...hiddenOverlayGroupIds];
  ids.sort();
  if (ids.length > 64
    || new Set(ids).size !== ids.length
    || ids.some((id) => !GROUP_ID.test(id))
    || (!overlayColumnId && ids.length > 0)) {
    throw new Error("graph_new_invalid_overlay_state");
  }
  return ids;
}

const VALID_LINE_STYLES: ReadonlySet<RefLineStyle> = new Set(["solid", "dashed", "dotted"]);

function normalizeGridLineStyle(style: GridLineStyle | undefined): GridLineStyle | undefined {
  if (!style || typeof style !== "object") return undefined;
  const out: GridLineStyle = {};
  if (typeof style.color === "string" && style.color.trim()) out.color = style.color.trim();
  if (typeof style.width === "number" && Number.isFinite(style.width) && style.width > 0) {
    out.width = Math.max(0.5, Math.min(5, style.width));
  }
  if (style.style && VALID_LINE_STYLES.has(style.style)) out.style = style.style;
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeAxisConfig(config: YAxisConfig | undefined): YAxisConfig | undefined {
  if (!config || typeof config !== "object") return undefined;
  const out: YAxisConfig = {};
  if (typeof config.min === "number" && Number.isFinite(config.min)) out.min = config.min;
  if (typeof config.max === "number" && Number.isFinite(config.max)) out.max = config.max;
  if (typeof config.tickInterval === "number" && Number.isFinite(config.tickInterval) && config.tickInterval > 0) {
    out.tickInterval = config.tickInterval;
  }
  if (typeof config.decimals === "number" && Number.isFinite(config.decimals)) {
    out.decimals = Math.max(0, Math.min(10, Math.round(config.decimals)));
  }
  if (config.inverse === true) out.inverse = true;
  if (typeof config.minorTickCount === "number" && Number.isFinite(config.minorTickCount)) {
    const count = Math.max(0, Math.min(20, Math.round(config.minorTickCount)));
    if (count > 0) out.minorTickCount = count;
  }
  if (typeof config.showAxisLine === "boolean") out.showAxisLine = config.showAxisLine;
  if (config.tickPosition === "inside" || config.tickPosition === "outside") out.tickPosition = config.tickPosition;
  if (typeof config.showMajorGrid === "boolean") out.showMajorGrid = config.showMajorGrid;
  if (typeof config.showMinorGrid === "boolean") out.showMinorGrid = config.showMinorGrid;
  const majorGridStyle = normalizeGridLineStyle(config.majorGridStyle);
  if (majorGridStyle) out.majorGridStyle = majorGridStyle;
  const minorGridStyle = normalizeGridLineStyle(config.minorGridStyle);
  if (minorGridStyle) out.minorGridStyle = minorGridStyle;
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeRefLinesX(lines: readonly RefLineX[] | undefined): RefLineX[] | undefined {
  if (!Array.isArray(lines) || lines.length === 0) return undefined;
  const out: RefLineX[] = [];
  for (const line of lines) {
    if (!line || typeof line !== "object" || typeof line.id !== "string" || !line.id.trim()) continue;
    if (typeof line.x !== "number" || !Number.isFinite(line.x)) continue;
    out.push({
      id: line.id,
      x: line.x,
      label: typeof line.label === "string" ? line.label : "",
      style: VALID_LINE_STYLES.has(line.style) ? line.style : "dashed",
      color: typeof line.color === "string" && line.color.trim() ? line.color.trim() : "#E60000",
      width: typeof line.width === "number" && Number.isFinite(line.width) && line.width > 0 ? Math.min(10, line.width) : 1,
    });
  }
  return out.length > 0 ? out : undefined;
}

function normalizeRefLinesY(lines: readonly RefLineY[] | undefined): RefLineY[] | undefined {
  if (!Array.isArray(lines) || lines.length === 0) return undefined;
  const out: RefLineY[] = [];
  for (const line of lines) {
    if (!line || typeof line !== "object" || typeof line.id !== "string" || !line.id.trim()) continue;
    if (typeof line.y !== "number" || !Number.isFinite(line.y)) continue;
    out.push({
      id: line.id,
      y: line.y,
      label: typeof line.label === "string" ? line.label : "",
      style: VALID_LINE_STYLES.has(line.style) ? line.style : "dashed",
      color: typeof line.color === "string" && line.color.trim() ? line.color.trim() : "#E60000",
      width: typeof line.width === "number" && Number.isFinite(line.width) && line.width > 0 ? Math.min(10, line.width) : 1,
    });
  }
  return out.length > 0 ? out : undefined;
}

export function normalizeGraphNewDocument(
  item: PersistedGraphBuilderNewDocument,
): GraphBuilderNewDocument {
  if (item.version !== 1 && item.version !== 2 && item.version !== 3) {
    throw new Error("graph_new_unsupported_document_version");
  }
  const overlayColumnId = item.version !== 1 ? item.overlayColumnId : null;
  const hiddenOverlayGroupIds = normalizeHiddenOverlayGroupIds(
    overlayColumnId,
    item.version !== 1 ? item.hiddenOverlayGroupIds : [],
  );
  const v3 = item.version === 3 ? item : undefined;
  const xAxisConfig = normalizeAxisConfig(v3?.xAxisConfig);
  const yAxisConfig = normalizeAxisConfig(v3?.yAxisConfig);
  const refLinesX = normalizeRefLinesX(v3?.refLinesX);
  const refLinesY = normalizeRefLinesY(v3?.refLinesY);
  const autoSpecLinesX = v3?.autoSpecLinesX === true ? true : undefined;
  const autoSpecLinesY = v3?.autoSpecLinesY === true ? true : undefined;
  return {
    version: 3,
    layers: migratedGraphNewLayers(item),
    overlayColumnId,
    hiddenOverlayGroupIds,
    id: item.id,
    name: item.name,
    datasetId: item.datasetId,
    xColumnId: item.xColumnId, yColumnId: item.yColumnId,
    xMode: item.xMode, camera: copyCamera(item.camera),
    ...(xAxisConfig ? { xAxisConfig } : {}),
    ...(yAxisConfig ? { yAxisConfig } : {}),
    ...(refLinesX ? { refLinesX } : {}),
    ...(refLinesY ? { refLinesY } : {}),
    ...(autoSpecLinesX ? { autoSpecLinesX } : {}),
    ...(autoSpecLinesY ? { autoSpecLinesY } : {}),
  };
}

export const useGraphBuilderNewStore = create<GraphBuilderNewStore>((rawSet, get) => {
  const set = createPersistedDocumentSetter("graphNew", rawSet, get, (state) => state.items);

  let runtimeEpoch = 0;
  const update = (id: string, change: (item: GraphBuilderNewDocument) => Partial<GraphBuilderNewDocument>) => {
    const item = get().items.find((candidate) => candidate.id === id);
    if (!item) return;
    const patch = change(item);
    if (Object.entries(patch).every(([key, value]) => Object.is(item[key as keyof GraphBuilderNewDocument], value))) return;
    assertProjectMutable(useProjectStore.getState().readOnly);
    set((state) => ({
      items: state.items.map((candidate) => candidate.id === id ? { ...candidate, ...patch } : candidate),
      sessions: state.sessions.map((session) => session.id === id ? { ...session, ...patch, ...legacyRenderOptions(patch.layers ?? session.layers) } : session),
    }));
    useProjectStore.getState().markDirty();
  };
  const remove = (matches: (item: GraphBuilderNewDocument) => boolean) => {
    const ids = new Set(get().items.filter(matches).map(({ id }) => id));
    if (ids.size === 0) return;
    assertProjectMutable(useProjectStore.getState().readOnly);
    set((state) => ({
      items: state.items.filter((item) => !ids.has(item.id)),
      sessions: state.sessions.filter((session) => !ids.has(session.id)),
    }));
    useProjectStore.getState().markDirty();
  };
  return {
    items: [], sessions: [],
    open: (datasetId, datasetGeneration) => {
      assertProjectMutable(useProjectStore.getState().readOnly);
      const names = new Set(projectDocumentNames(["graphNew"], get().items.map(item => item.name)).map(name => name.trim().normalize("NFC").toLowerCase()));
      let number = 1;
      while (names.has(`graph builder-new ${number}`)) number += 1;
      const documentId = crypto.randomUUID();
      const item: GraphBuilderNewDocument = {
        version: 3, layers: [createGraphNewLayer("points")], id: documentId, name: `Graph Builder-new ${number}`, datasetId,
        xColumnId: null, yColumnId: null, overlayColumnId: null, hiddenOverlayGroupIds: [],
        xMode: "auto", camera: null,
      };
      set((state) => ({ items: [...state.items, item], sessions: [...state.sessions, { ...item, ...legacyRenderOptions(item.layers), transportId: crypto.randomUUID(), datasetGeneration, runtimeEpoch: ++runtimeEpoch }] }));
      useProjectStore.getState().markDirty();
      return item.id;
    },
    reopen: (id, datasetGeneration) => {
      const item = get().items.find((candidate) => candidate.id === id);
      if (!item) return null;
      const existing = get().sessions.find((session) => session.id === id);
      if (existing?.datasetGeneration === datasetGeneration) return id;
      set((state) => ({ sessions: [...state.sessions.filter((session) => session.id !== id), { ...item, ...legacyRenderOptions(item.layers), transportId: crypto.randomUUID(), datasetGeneration, runtimeEpoch: ++runtimeEpoch }] }));
      return id;
    },
    close: (id) => {
      if (!get().sessions.some((session) => session.id === id)) return;
      set((state) => ({ sessions: state.sessions.filter((session) => session.id !== id) }));
    },
    renameItem: (id, name) => update(id, (item) => {
      const error = validateNativeGraphBasename(name);
      if (error) throw new ProjectNameValidationError(error);
      const allocated = allocateProjectBasename(`${name}.spgn`, ".spgn", projectDocumentNames(["graphNew"], get().items.map(candidate => candidate.name)), item.name);
      const allocatedError = validateNativeGraphBasename(allocated);
      if (allocatedError) throw new ProjectNameValidationError(allocatedError);
      return { name: allocated };
    }),
    deleteItem: (id) => remove((item) => item.id === id),
    deleteByDataset: (datasetId) => remove((item) => item.datasetId === datasetId),
    loadFromProject: (items) => withoutDocumentPersistence(() => {
      const copies = items.map(normalizeGraphNewDocument);
      if (new Set(copies.map(({ id }) => id)).size !== copies.length) throw new Error("graph_new_duplicate_document_id");
      set({ items: copies, sessions: [] });
    }),
    reset: () => withoutDocumentPersistence(() => set({ items: [], sessions: [] })),
    setColumns: (id, xColumnId, yColumnId) => update(id, (item) => ({
      xColumnId, yColumnId,
      xMode: item.xColumnId === xColumnId ? item.xMode : "auto",
      camera: item.xColumnId === xColumnId && item.yColumnId === yColumnId ? item.camera : null,
    })),
    setOverlay: (id, overlayColumnId) => {
      const item = get().items.find((candidate) => candidate.id === id);
      if (!item || item.overlayColumnId === overlayColumnId) return;
      assertProjectMutable(useProjectStore.getState().readOnly);
      set((state) => ({
        items: state.items.map((candidate) => candidate.id === id
          ? { ...candidate, overlayColumnId, hiddenOverlayGroupIds: [] }
          : candidate),
        sessions: state.sessions.map((session) => session.id === id
          ? { ...session, overlayColumnId, hiddenOverlayGroupIds: [] }
          : session),
      }));
      useProjectStore.getState().markDirty();
    },
    setHiddenOverlayGroups: (id, ids) => {
      const item = get().items.find((candidate) => candidate.id === id);
      if (!item) return;
      const hiddenOverlayGroupIds = normalizeHiddenOverlayGroupIds(item.overlayColumnId, ids);
      if (hiddenOverlayGroupIds.length === item.hiddenOverlayGroupIds.length
        && hiddenOverlayGroupIds.every((value, index) => value === item.hiddenOverlayGroupIds[index])) {
        return;
      }
      assertProjectMutable(useProjectStore.getState().readOnly);
      set((state) => ({
        items: state.items.map((candidate) => candidate.id === id
          ? { ...candidate, hiddenOverlayGroupIds: [...hiddenOverlayGroupIds] }
          : candidate),
        sessions: state.sessions.map((session) => session.id === id
          ? { ...session, hiddenOverlayGroupIds: [...hiddenOverlayGroupIds] }
          : session),
      }));
      useProjectStore.getState().markDirty();
    },
    addLayer: (id, kind) => update(id, (item) => {
      if (item.layers.some((layer) => layer.kind === kind)) return {};
      return { layers: [...item.layers, createGraphNewLayer(kind)] };
    }),
    removeLayer: (id, layerId) => update(id, (item) => ({ layers: item.layers.some((layer) => layer.id === layerId) ? item.layers.filter((layer) => layer.id !== layerId) : item.layers })),
    setLayerOptions: (id, layerId, patch) => update(id, (item) => {
      const layers = normalizeGraphNewLayers(item.layers.map((layer) => layer.id === layerId ? { ...layer, options: { ...layer.options, ...patch } } : layer));
      return { layers: JSON.stringify(layers) === JSON.stringify(item.layers) ? item.layers : layers };
    }),
    // Deprecated callers are adapted into layers; v3 documents and rendering use layers only.
    setMean: (id, showMean) => update(id, (item) => {
      if (legacyRenderOptions(item.layers).showMean === showMean) return {};
      const layers = item.layers.filter((layer) => layer.kind === "points" || layer.options.summaryStat !== "mean");
      if (showMean) layers.push({ ...createGraphNewLayer("line", `${id}:compat-mean`), options: { ...defaultLineOptions(), errorInterval: "none" } } as GraphNewLayer);
      return { layers };
    }),
    setModes: (id, xMode, rawMode) => update(id, (item) => item.xMode === xMode && legacyRenderOptions(item.layers).rawMode === rawMode ? {} : ({ xMode, layers: migratedGraphNewLayers({ ...item, version: 2, rawMode, showMean: legacyRenderOptions(item.layers).showMean }), camera: item.xMode === xMode ? item.camera : null })),
    setCamera: (id, camera) => update(id, (item) => {
      const next = copyCamera(camera);
      const same = item.camera === null ? next === null : next !== null
        && item.camera.xMin === next.xMin && item.camera.xMax === next.xMax
        && item.camera.yMin === next.yMin && item.camera.yMax === next.yMax;
      return { camera: same ? item.camera : next };
    }),
    setXAxisConfig: (id, config) => update(id, (item) => {
      const next = normalizeAxisConfig(config);
      return { xAxisConfig: JSON.stringify(next) === JSON.stringify(item.xAxisConfig) ? item.xAxisConfig : next };
    }),
    setYAxisConfig: (id, config) => update(id, (item) => {
      const next = normalizeAxisConfig(config);
      return { yAxisConfig: JSON.stringify(next) === JSON.stringify(item.yAxisConfig) ? item.yAxisConfig : next };
    }),
    setRefLinesX: (id, lines) => update(id, (item) => {
      const next = normalizeRefLinesX(lines);
      return { refLinesX: JSON.stringify(next) === JSON.stringify(item.refLinesX) ? item.refLinesX : next };
    }),
    setRefLinesY: (id, lines) => update(id, (item) => {
      const next = normalizeRefLinesY(lines);
      return { refLinesY: JSON.stringify(next) === JSON.stringify(item.refLinesY) ? item.refLinesY : next };
    }),
    setAutoSpecLinesX: (id, enabled) => update(id, () => ({ autoSpecLinesX: enabled ? true : undefined })),
    setAutoSpecLinesY: (id, enabled) => update(id, () => ({ autoSpecLinesY: enabled ? true : undefined })),
  };
});
// Preserve documents across development module replacement; rebuild transports so
// late native work from the previous module cannot update the restored session.
export function restoreGraphNewHotState(snapshot: { items: PersistedGraphBuilderNewDocument[]; sessions: { id: string; datasetGeneration: number }[] }) {
  useGraphBuilderNewStore.getState().loadFromProject(snapshot.items);
  for (const session of snapshot.sessions) useGraphBuilderNewStore.getState().reopen(session.id, session.datasetGeneration);
}
if (import.meta.hot) {
  const snapshot = import.meta.hot.data.graphNewState;
  if (snapshot) restoreGraphNewHotState(snapshot);
  import.meta.hot.dispose((data) => {
    const { items, sessions } = useGraphBuilderNewStore.getState();
    data.graphNewState = { items, sessions };
  });
}
