export type ThemeMode = "light" | "dark" | "system";

export function resolveStoredThemeMode(stored: string | null): ThemeMode {
  if (stored === "light" || stored === "dark" || stored === "system") return stored;
  return "light";
}
