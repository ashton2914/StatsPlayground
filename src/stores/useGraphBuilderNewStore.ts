import { defaultLineOptions } from "@/components/graphBuilder/shared/graphLayerOptionContracts";
import { createGraphNewLayer, migratedGraphNewLayers, normalizeGraphNewLayers, legacyRenderOptions } from "@/components/graphBuilderNew/graphNewLayers";
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
  setXMode: (id: string, xMode: GraphNewXMode) => void;
  setModes: (id: string, xMode: GraphNewXMode, rawMode: GraphNewRawMode) => void;
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

function normalizeDocument(
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
  };
}

export const useGraphBuilderNewStore = create<GraphBuilderNewStore>((set, get) => {
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
      const names = new Set(get().items.map(({ name }) => name.trim().normalize("NFC").toLowerCase()));
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
      const allocated = allocateProjectBasename(`${name}.spgn`, ".spgn", get().items.map((candidate) => candidate.name), item.name);
      const allocatedError = validateNativeGraphBasename(allocated);
      if (allocatedError) throw new ProjectNameValidationError(allocatedError);
      return { name: allocated };
    }),
    deleteItem: (id) => remove((item) => item.id === id),
    deleteByDataset: (datasetId) => remove((item) => item.datasetId === datasetId),
    loadFromProject: (items) => {
      const copies = items.map(normalizeDocument);
      if (new Set(copies.map(({ id }) => id)).size !== copies.length) throw new Error("graph_new_duplicate_document_id");
      set({ items: copies, sessions: [] });
    },
    reset: () => set({ items: [], sessions: [] }),
    setColumns: (id, xColumnId, yColumnId) => update(id, (item) => ({
      xColumnId, yColumnId, camera: item.xColumnId === xColumnId && item.yColumnId === yColumnId ? item.camera : null,
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
      const xMode = kind === "timeSeries" && item.xMode !== "time" && item.xMode !== "duration" ? "time" : item.xMode;
      return { layers: [...item.layers, createGraphNewLayer(kind)], xMode, camera: xMode === item.xMode ? item.camera : null };
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
    setXMode: (id, xMode) => update(id, (item) => ({ xMode, camera: item.xMode === xMode ? item.camera : null })),
    setModes: (id, xMode, rawMode) => update(id, (item) => item.xMode === xMode && legacyRenderOptions(item.layers).rawMode === rawMode ? {} : ({ xMode, layers: migratedGraphNewLayers({ ...item, version: 2, rawMode, showMean: legacyRenderOptions(item.layers).showMean }), camera: item.xMode === xMode ? item.camera : null })),
    setCamera: (id, camera) => update(id, (item) => {
      const next = copyCamera(camera);
      const same = item.camera === null ? next === null : next !== null
        && item.camera.xMin === next.xMin && item.camera.xMax === next.xMax
        && item.camera.yMin === next.yMin && item.camera.yMax === next.yMax;
      return { camera: same ? item.camera : next };
    }),
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
