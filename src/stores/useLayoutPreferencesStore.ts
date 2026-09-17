import { create } from "zustand";

export const LAYOUT_PANEL_IDS = [
  "workspace.sidebar",
  "analysis.summary",
  "tabulate.fields",
  "tabulate.configuration",
  "graphBuilder.filter",
  "graphBuilder.leftRail",
  "graphBuilder.rightRail",
  "graphBuilder.leftStack",
  "table.filter",
  "table.columns",
  "history.stack",
] as const;

export type LayoutPanelId = (typeof LAYOUT_PANEL_IDS)[number];

export type LayoutPreferences = Partial<Record<LayoutPanelId, number>>;

interface LayoutPreferencesDocument {
  version: 1;
  sizes: LayoutPreferences;
}

interface LayoutPreferencesState {
  sizes: LayoutPreferences;
  setPanelSize: (id: LayoutPanelId, value: number) => void;
  resetPanelSize: (id: LayoutPanelId) => void;
}

const STORAGE_KEY = "sp-layout-preferences-v1";

function isLayoutPanelId(value: string): value is LayoutPanelId {
  return (LAYOUT_PANEL_IDS as readonly string[]).includes(value);
}

function getLocalStorage(): Storage | undefined {
  return typeof localStorage === "undefined" ? undefined : localStorage;
}

function persistLayoutPreferences(sizes: LayoutPreferences) {
  const storage = getLocalStorage();
  if (!storage) return;
  storage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, sizes } satisfies LayoutPreferencesDocument));
}

function cloneSizes(sizes: LayoutPreferences): LayoutPreferences {
  return { ...sizes };
}

export function readLayoutPreferences(storage: Storage | null | undefined): LayoutPreferences {
  if (!storage) return {};

  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return {};

    const parsed = JSON.parse(raw) as Partial<LayoutPreferencesDocument> | null;
    if (!parsed || parsed.version !== 1 || typeof parsed.sizes !== "object" || parsed.sizes === null) {
      return {};
    }

    const sizes: LayoutPreferences = {};
    for (const [key, value] of Object.entries(parsed.sizes as Record<string, unknown>)) {
      if (!isLayoutPanelId(key) || typeof value !== "number" || !Number.isFinite(value)) continue;
      sizes[key] = value;
    }

    return sizes;
  } catch {
    return {};
  }
}

const initialSizes = readLayoutPreferences(getLocalStorage());

export const useLayoutPreferencesStore = create<LayoutPreferencesState>((set, get) => ({
  sizes: initialSizes,
  setPanelSize: (id, value) => {
    set((state) => ({ sizes: { ...state.sizes, [id]: value } }));
    try {
      persistLayoutPreferences(get().sizes);
    } catch {
      // Persistence failures are intentionally non-fatal.
    }
  },
  resetPanelSize: (id) => {
    set((state) => {
      const nextSizes = cloneSizes(state.sizes);
      delete nextSizes[id];
      return { sizes: nextSizes };
    });
    try {
      persistLayoutPreferences(get().sizes);
    } catch {
      // Persistence failures are intentionally non-fatal.
    }
  },
}));