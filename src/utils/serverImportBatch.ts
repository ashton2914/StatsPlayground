import type { SourceObjectRef } from "../types/dataLink";

export interface ServerImportItem {
  key: string;
  object: SourceObjectRef;
  targetName: string;
  selected: boolean;
  status: "pending" | "importing" | "completed" | "failed";
  rows?: number;
  message?: string;
}

export function createServerImportItems(objects: SourceObjectRef[], existingNames: string[]): ServerImportItem[] {
  const used = new Set(existingNames.map((name) => name.trim().toLowerCase()));
  return objects.map((object) => {
    let targetName = object.name;
    let suffix = 2;
    while (used.has(targetName.toLowerCase())) targetName = `${object.name}_${suffix++}`;
    used.add(targetName.toLowerCase());
    return { key: JSON.stringify([object.catalog, object.schema, object.name, object.objectType]), object, targetName, selected: false, status: "pending" };
  });
}

export function hasServerImportNameConflict(items: ServerImportItem[], existingNames: string[]): boolean {
  const used = new Set(existingNames.map((name) => name.trim().toLowerCase()));
  for (const item of items.filter((item) => item.selected && item.status !== "completed")) {
    const name = item.targetName.trim().toLowerCase();
    if (!name || used.has(name)) return true;
    used.add(name);
  }
  return false;
}

export async function runServerImportBatch(
  items: ServerImportItem[],
  importItem: (item: ServerImportItem) => Promise<number>,
  onImported: (name: string) => Promise<void>,
  update: (key: string, patch: Partial<ServerImportItem>) => void,
  shouldStop: () => boolean,
  errorMessage: (error: unknown) => string,
): Promise<void> {
  for (const item of items.filter((item) => item.selected && item.status !== "completed")) {
    if (shouldStop()) break;
    update(item.key, { status: "importing", message: undefined });
    try {
      const rows = await importItem({ ...item, targetName: item.targetName.trim() });
      update(item.key, { status: "completed", rows, selected: false });
    } catch (error) {
      update(item.key, { status: "failed", message: errorMessage(error) });
      continue;
    }
    try {
      await onImported(item.targetName.trim());
    } catch (error) {
      update(item.key, { message: errorMessage(error) });
    }
  }
}
