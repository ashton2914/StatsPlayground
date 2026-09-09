import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";

import { dataLinkService } from "@/services/dataLinkService";
import type {
  ImportProgress,
  ImportSummary,
  PreviewResult,
  SourceObject,
  SqliteImportSelection,
} from "@/types/dataLink";

export type DataLinkConflictStrategy = "rename" | "append" | "skip";

interface ImportProgressEvent {
  table_name: string;
  table_index: number;
  table_total: number;
  rows_done: number;
  rows_total: number;
}

interface DataLinkStore {
  filePath: string | null;
  objects: SourceObject[];
  selectedName: string | null;
  preview: PreviewResult | null;
  selectedTables: Set<string>;
  targetNames: Record<string, string>;
  conflictStrategy: DataLinkConflictStrategy;
  loadingObjects: boolean;
  loadingPreview: boolean;
  importing: boolean;
  cancelling: boolean;
  requestId: string | null;
  progress: ImportProgress | null;
  summary: ImportSummary | null;
  error: string | null;
  open: (filePath: string) => void;
  close: () => void;
  loadObjects: (existingDatasetNames: string[]) => Promise<void>;
  selectObject: (objectName: string) => Promise<void>;
  applyConflictStrategy: (strategy: DataLinkConflictStrategy, existingDatasetNames: string[]) => void;
  toggleTable: (objectName: string, selected: boolean, existingDatasetNames: string[]) => void;
  setTargetName: (objectName: string, targetName: string) => void;
  setError: (error: string | null) => void;
  importSelected: (selections: SqliteImportSelection[]) => Promise<ImportSummary>;
  cancelImport: () => Promise<void>;
}

const initialState = {
  filePath: null,
  objects: [],
  selectedName: null,
  preview: null,
  selectedTables: new Set<string>(),
  targetNames: {},
  conflictStrategy: "rename" as DataLinkConflictStrategy,
  loadingObjects: false,
  loadingPreview: false,
  importing: false,
  cancelling: false,
  requestId: null,
  progress: null,
  summary: null,
  error: null,
};

function uniqueTargetName(sourceName: string, reservedNames: Set<string>): string {
  if (!reservedNames.has(sourceName.toLowerCase())) return sourceName;
  let suffix = 2;
  while (reservedNames.has(`${sourceName} (${suffix})`.toLowerCase())) suffix += 1;
  return `${sourceName} (${suffix})`;
}

function selectionForStrategy(
  objects: SourceObject[],
  strategy: DataLinkConflictStrategy,
  existingDatasetNames: string[],
) {
  const existingNames = new Set(existingDatasetNames.map((name) => name.toLowerCase()));
  const reservedNames = new Set(existingNames);
  const selectedTables = new Set<string>();
  const targetNames: Record<string, string> = {};
  for (const object of objects) {
    if (object.objectType !== "table") continue;
    const conflicts = existingNames.has(object.name.toLowerCase());
    if (strategy === "skip" && conflicts) {
      targetNames[object.name] = object.name;
      continue;
    }
    const targetName = strategy === "rename"
      ? uniqueTargetName(object.name, reservedNames)
      : object.name;
    selectedTables.add(object.name);
    targetNames[object.name] = targetName;
    reservedNames.add(targetName.toLowerCase());
  }
  return { selectedTables, targetNames };
}

export const useDataLinkStore = create<DataLinkStore>((set, get) => ({
  ...initialState,

  open: (filePath) => set({ ...initialState, filePath }),

  close: () => {
    if (!get().importing) set({ ...initialState });
  },

  loadObjects: async (existingDatasetNames) => {
    const filePath = get().filePath;
    if (!filePath) return;
    set({ loadingObjects: true, error: null, summary: null });
    try {
      const objects = await dataLinkService.listSqliteObjects(filePath);
      if (get().filePath !== filePath) return;
      const selection = selectionForStrategy(objects, "rename", existingDatasetNames);
      set({
        objects,
        selectedName: objects[0]?.name ?? null,
        conflictStrategy: "rename",
        ...selection,
      });
      if (objects[0]) await get().selectObject(objects[0].name);
    } catch (error) {
      if (get().filePath === filePath) set({ error: String(error) });
    } finally {
      if (get().filePath === filePath) set({ loadingObjects: false });
    }
  },

  selectObject: async (objectName) => {
    const filePath = get().filePath;
    if (!filePath) return;
    set({ selectedName: objectName, preview: null, loadingPreview: true, error: null });
    try {
      const preview = await dataLinkService.previewSqliteObject(filePath, objectName);
      if (get().filePath === filePath && get().selectedName === objectName) set({ preview });
    } catch (error) {
      if (get().filePath === filePath && get().selectedName === objectName) {
        set({ error: String(error) });
      }
    } finally {
      if (get().filePath === filePath && get().selectedName === objectName) {
        set({ loadingPreview: false });
      }
    }
  },

  applyConflictStrategy: (conflictStrategy, existingDatasetNames) => {
    set({
      conflictStrategy,
      ...selectionForStrategy(get().objects, conflictStrategy, existingDatasetNames),
      error: null,
    });
  },

  toggleTable: (objectName, selected, existingDatasetNames) => {
    const selectedTables = new Set(get().selectedTables);
    const targetNames = { ...get().targetNames };
    if (selected) {
      selectedTables.add(objectName);
      if (!targetNames[objectName]) {
        const reservedNames = new Set([
          ...existingDatasetNames.map((name) => name.toLowerCase()),
          ...Object.values(targetNames).map((name) => name.toLowerCase()),
        ]);
        targetNames[objectName] = uniqueTargetName(objectName, reservedNames);
      }
    } else {
      selectedTables.delete(objectName);
    }
    set({ selectedTables, targetNames, error: null });
  },

  setTargetName: (objectName, targetName) => set({
    targetNames: { ...get().targetNames, [objectName]: targetName },
    error: null,
  }),

  setError: (error) => set({ error }),

  importSelected: async (selections) => {
    const filePath = get().filePath;
    if (!filePath) throw new Error("SQLite DataLink is not open");
    const requestId = crypto.randomUUID();
    set({
      importing: true,
      cancelling: false,
      requestId,
      summary: null,
      error: null,
      progress: { tableName: "", tableIndex: 0, tableTotal: 0, rowsDone: 0, rowsTotal: 0 },
    });
    let unlisten: (() => void) | null = null;
    try {
      unlisten = await listen<ImportProgressEvent>("import-progress", (event) => {
        set({
          progress: {
            tableName: event.payload.table_name,
            tableIndex: event.payload.table_index,
            tableTotal: event.payload.table_total,
            rowsDone: event.payload.rows_done,
            rowsTotal: event.payload.rows_total,
          },
        });
      });
      const summary = await dataLinkService.importSelectedSqlite(filePath, requestId, selections);
      set({ summary });
      return summary;
    } catch (error) {
      set({ error: String(error) });
      throw error;
    } finally {
      unlisten?.();
      set({ importing: false, cancelling: false, requestId: null, progress: null });
    }
  },

  cancelImport: async () => {
    const { importing, cancelling, requestId } = get();
    if (!importing || cancelling || !requestId) return;
    set({ cancelling: true });
    try {
      await dataLinkService.cancelSqliteImport(requestId);
    } catch (error) {
      set({ cancelling: false, error: String(error) });
    }
  },
}));
