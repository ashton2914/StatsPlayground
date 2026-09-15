import { createStore, type StoreApi } from "zustand/vanilla";
import { useStore } from "zustand";

import {
  createEmptyWorkspaceDocumentSelection,
  selectWorkspaceDocument,
  type WorkspaceDocumentKind,
  type WorkspaceDocumentSelection,
} from "@/components/analysis/analysisWorkspaceLifecycle";

export interface WorkspaceSelectionState {
  selection: WorkspaceDocumentSelection;
  activate: (kind: WorkspaceDocumentKind, id: string) => void;
  clear: () => void;
  load: (selection: WorkspaceDocumentSelection) => void;
}

export type WorkspaceSelectionStoreState = WorkspaceSelectionState;

export function createWorkspaceSelectionStore(): StoreApi<WorkspaceSelectionStoreState> {
  return createStore<WorkspaceSelectionStoreState>((set) => ({
    selection: createEmptyWorkspaceDocumentSelection(),
    activate: (kind, id) => {
      set({ selection: selectWorkspaceDocument(kind, id) });
    },
    clear: () => {
      set({ selection: createEmptyWorkspaceDocumentSelection() });
    },
    load: (selection) => {
      set({ selection: structuredClone(selection) });
    },
  }));
}

const workspaceSelectionStore = createWorkspaceSelectionStore();

export const useWorkspaceSelectionStore = Object.assign(
  <T>(selector: (state: WorkspaceSelectionState) => T): T => useStore(workspaceSelectionStore, selector),
  workspaceSelectionStore,
) as StoreApi<WorkspaceSelectionStoreState> & (<T>(selector: (state: WorkspaceSelectionState) => T) => T);