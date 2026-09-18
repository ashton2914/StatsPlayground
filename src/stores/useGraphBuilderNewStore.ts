import { create } from "zustand";

import { useProjectStore } from "@/stores/useProjectStore";
import type { GraphBuilderNewCamera, GraphBuilderNewDocument, GraphBuilderNewSession, GraphNewRawMode, GraphNewXMode } from "@/types/graphBuilderNew";
import { assertProjectMutable } from "@/utils/saveReadOnly";
import { allocateProjectBasename, ProjectNameValidationError, validateNativeGraphBasename } from "@/utils/projectFileNaming";

interface GraphBuilderNewStore {
  items: GraphBuilderNewDocument[];
  sessions: GraphBuilderNewSession[];
  open: (datasetId: string, datasetGeneration: number) => string;
  reopen: (id: string, datasetGeneration: number) => string | null;
  renameItem: (id: string, name: string) => void;
  deleteItem: (id: string) => void;
  deleteByDataset: (datasetId: string) => void;
  loadFromProject: (items: GraphBuilderNewDocument[]) => void;
  reset: () => void;
  setCamera: (id: string, camera: GraphBuilderNewCamera | null) => void;
  setColumns: (
    id: string,
    xColumnId: string | null,
    yColumnId: string | null,
  ) => void;
  close: (id: string) => void;
  setMean: (id: string, showMean: boolean) => void;
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

function copyDocument(item: GraphBuilderNewDocument): GraphBuilderNewDocument {
  if (item.version !== 1) throw new Error("graph_new_unsupported_document_version");
  return {
    version: 1, id: item.id, name: item.name, datasetId: item.datasetId,
    xColumnId: item.xColumnId, yColumnId: item.yColumnId, showMean: item.showMean,
    xMode: item.xMode, rawMode: item.rawMode, camera: copyCamera(item.camera),
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
      sessions: state.sessions.map((session) => session.id === id ? { ...session, ...patch } : session),
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
      const item: GraphBuilderNewDocument = {
        version: 1, id: crypto.randomUUID(), name: `Graph Builder-new ${number}`, datasetId,
        xColumnId: null, yColumnId: null, showMean: true, xMode: "auto", rawMode: "scatter", camera: null,
      };
      set((state) => ({ items: [...state.items, item], sessions: [...state.sessions, { ...item, transportId: crypto.randomUUID(), datasetGeneration, runtimeEpoch: ++runtimeEpoch }] }));
      useProjectStore.getState().markDirty();
      return item.id;
    },
    reopen: (id, datasetGeneration) => {
      const item = get().items.find((candidate) => candidate.id === id);
      if (!item) return null;
      const existing = get().sessions.find((session) => session.id === id);
      if (existing?.datasetGeneration === datasetGeneration) return id;
      set((state) => ({ sessions: [...state.sessions.filter((session) => session.id !== id), { ...item, transportId: crypto.randomUUID(), datasetGeneration, runtimeEpoch: ++runtimeEpoch }] }));
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
      const copies = items.map(copyDocument);
      if (new Set(copies.map(({ id }) => id)).size !== copies.length) throw new Error("graph_new_duplicate_document_id");
      set({ items: copies, sessions: [] });
    },
    reset: () => set({ items: [], sessions: [] }),
    setColumns: (id, xColumnId, yColumnId) => update(id, (item) => ({
      xColumnId, yColumnId, camera: item.xColumnId === xColumnId && item.yColumnId === yColumnId ? item.camera : null,
    })),
    setMean: (id, showMean) => update(id, () => ({ showMean })),
    setModes: (id, xMode, rawMode) => update(id, (item) => ({ xMode, rawMode, camera: item.xMode === xMode ? item.camera : null })),
    setCamera: (id, camera) => update(id, (item) => {
      const next = copyCamera(camera);
      const same = item.camera === null ? next === null : next !== null
        && item.camera.xMin === next.xMin && item.camera.xMax === next.xMax
        && item.camera.yMin === next.yMin && item.camera.yMax === next.yMax;
      return { camera: same ? item.camera : next };
    }),
  };
});