import { create } from "zustand";
import { getCurrentWindow } from "@tauri-apps/api/window";

export type ThemeMode = "light" | "dark" | "system";

interface ThemeState {
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
}

const STORAGE_KEY = "sp-theme-mode";

function getStoredMode(): ThemeMode {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === "light" || stored === "dark" || stored === "system") return stored;
  return "system";
}

function getEffectiveTheme(mode: ThemeMode): "light" | "dark" {
  if (mode === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return mode;
}

/** Sync the native OS title bar color to the app theme so the menu bar
 *  blends with the system caption (Windows/Linux). On macOS this also
 *  affects red/yellow/green button hover hint colors. */
function syncWindowTheme(mode: ThemeMode) {
  const effective = mode === "system" ? null : mode;
  try {
    // null tells the OS to follow system; otherwise force light/dark caption.
    getCurrentWindow().setTheme(effective).catch(() => {
      // Non-Tauri context (e.g. browser dev) — ignore.
    });
  } catch {
    // Component tests and plain browser contexts do not expose a Tauri window.
  }
}

function applyTheme(mode: ThemeMode) {
  const effective = getEffectiveTheme(mode);
  document.documentElement.setAttribute("data-theme", effective);
  syncWindowTheme(mode);
}

export const useThemeStore = create<ThemeState>((set) => ({
  mode: getStoredMode(),
  setMode: (mode) => {
    localStorage.setItem(STORAGE_KEY, mode);
    applyTheme(mode);
    set({ mode });
  },
}));

if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
  applyTheme(getStoredMode());

  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    const mode = useThemeStore.getState().mode;
    if (mode === "system") {
      applyTheme("system");
    }
  });
}
