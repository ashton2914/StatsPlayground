export function resolveStoredUpdatePreference(value: string | null): boolean {
  if (value === "false") {
    return false;
  }
  return true;
}