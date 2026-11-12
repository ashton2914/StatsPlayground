import { create } from "zustand";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { resolveStoredThemeMode, type ThemeMode } from "./themeMode";

export type { ThemeMode } from "./themeMode";

interface ThemeState {
  mode: ThemeMode;
  effectiveTheme: "light" | "dark";
  setMode: (mode: ThemeMode) => void;
}

const STORAGE_KEY = "sp-theme-mode";
const systemTheme = typeof window !== "undefined" && typeof window.matchMedia === "function"
  ? window.matchMedia("(prefers-color-scheme: dark)")
  : null;

function getStoredMode(): ThemeMode {
  return resolveStoredThemeMode(typeof localStorage === "undefined" ? null : localStorage.getItem(STORAGE_KEY));
}

function getEffectiveTheme(mode: ThemeMode): "light" | "dark" {
  if (mode === "system") {
    return systemTheme?.matches ? "dark" : "light";
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

function applyTheme(mode: ThemeMode, effective: "light" | "dark") {
  document.documentElement.setAttribute("data-theme", effective);
  syncWindowTheme(mode);
}

const storedMode = getStoredMode();

export const useThemeStore = create<ThemeState>((set) => ({
  mode: storedMode,
  effectiveTheme: getEffectiveTheme(storedMode),
  setMode: (mode) => {
    localStorage.setItem(STORAGE_KEY, mode);
    const effectiveTheme = getEffectiveTheme(mode);
    applyTheme(mode, effectiveTheme);
    set({ mode, effectiveTheme });
  },
}));

if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
  applyTheme(storedMode, useThemeStore.getState().effectiveTheme);

  systemTheme?.addEventListener("change", () => {
    const mode = useThemeStore.getState().mode;
    if (mode === "system") {
      const effectiveTheme = getEffectiveTheme(mode);
      applyTheme(mode, effectiveTheme);
      useThemeStore.setState({ effectiveTheme });
    }
  });
}
