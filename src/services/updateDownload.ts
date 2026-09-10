import { openUrl } from "@tauri-apps/plugin-opener";

import { isTrustedUpdateUrl } from "./updateUrlCore";

export function validateUpdateUrl(value: string): string {
  if (!isTrustedUpdateUrl(value)) {
    throw new Error("Untrusted update URL");
  }
  return new URL(value).toString();
}

export async function openUpdateUrl(value: string): Promise<void> {
  await openUrl(validateUpdateUrl(value));
}