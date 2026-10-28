import type { ProjectLineageGraph } from "../types/workflow";
import type { StoreApi } from "zustand/vanilla";
import { isPersistenceProjection } from "../stores/documentStore";

export const DIRECTORY_MAP_KEYS = ["tableFolders", "graphFolders", "graphNewFolders", "tabulateFolders", "fitYByXFolders", "fitModelFolders", "reportFolders", "distributionFolders", "analysisFolders"] as const;
export type DirectoryProjection = { folders: string[] } & Record<typeof DIRECTORY_MAP_KEYS[number], Record<string, string>>;
export type ProjectRecordMutation =
  | { kind: "directory"; before: DirectoryProjection; after: DirectoryProjection }
  | { kind: "removeTransform"; id: string; lineage: ProjectLineageGraph }
  | { kind: "settings"; settings: Array<{ key: string; value: unknown }> };
let sink: ((mutation: ProjectRecordMutation) => void) | null = null;
export function installProjectRecordMutationSink(next: (mutation: ProjectRecordMutation) => void): () => void {
  if (sink) throw new Error("A project record persistence session is already active");
  sink = next;
  return () => { if (sink === next) sink = null; };
}

export function emitProjectRecordMutation(mutation: ProjectRecordMutation): void {
  if (!isPersistenceProjection()) sink?.(mutation);
}

/** Explicit action setter: no subscriptions or serialization of runtime state. */
export function createPersistedRecordSetter<T>(
  rawSet: StoreApi<T>["setState"], get: () => T,
  mutation: (before: T, after: T) => ProjectRecordMutation | null,
): StoreApi<T>["setState"] {
  type Update = T | Partial<T> | ((state: T) => T | Partial<T>);
  return ((update: Update, replace?: boolean) => {
    const apply = rawSet as (update: Update, replace?: boolean) => void;
    if (!sink || isPersistenceProjection()) { apply(update, replace); return; }
    const before = get();
    apply(update, replace);
    const next = mutation(before, get());
    if (next) sink(next);
  }) as StoreApi<T>["setState"];
}

export function directoryMutation(before: DirectoryProjection, after: DirectoryProjection): ProjectRecordMutation | null {
  if (before.folders === after.folders && DIRECTORY_MAP_KEYS.every((key) => before[key] === after[key])) return null;
  return { kind: "directory", before, after };
}
