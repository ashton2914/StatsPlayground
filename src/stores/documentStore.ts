interface NamedDocument {
  name: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function createNamedDocumentHelpers(prefix: string) {
  const namePattern = new RegExp(`^${escapeRegExp(prefix)} (\\d+)$`);

  function maxSuffix(items: readonly NamedDocument[]): number {
    return items.reduce((maximum, item) => {
      const match = item.name.match(namePattern);
      if (!match) {
        return maximum;
      }
      return Math.max(maximum, Number.parseInt(match[1], 10));
    }, 0);
  }

  function nextName(counter: number): string {
    return `${prefix} ${counter + 1}`;
  }

  return { maxSuffix, nextName };
}

export function updateDocumentById<T extends { id: string }>(
  items: readonly T[],
  id: string,
  updater: (item: T) => T,
): T[] {
  return items.map((item) => (item.id === id ? updater(item) : item));
}

export function removeDocumentById<T extends { id: string }>(
  items: readonly T[],
  id: string,
): T[] {
  return items.filter((item) => item.id !== id);
}
export type PersistedDocumentKind = "graph" | "graphNew" | "analysis" | "report" | "tabulate" | "workflow" | "transform";
export interface PersistedNamedDocument { id: string; name: string }
type DocumentMutationSink = (kind: PersistedDocumentKind, before: readonly PersistedNamedDocument[], after: readonly PersistedNamedDocument[]) => void;
let documentMutationSink: DocumentMutationSink | null = null;
let projectionDepth = 0;

export function installDocumentMutationSink(sink: DocumentMutationSink): () => void {
  if (documentMutationSink) throw new Error("A project document persistence session is already active");
  documentMutationSink = sink;
  return () => { if (documentMutationSink === sink) documentMutationSink = null; };
}

export function isPersistenceProjection(): boolean { return projectionDepth > 0; }

/** Projection scopes are synchronous so a pending fetch cannot suppress user edits. */
export function withoutDocumentPersistence<T>(apply: () => T): T {
  projectionDepth++;
  try { return apply(); }
  finally { projectionDepth--; }
}

export function createPersistedDocumentSetter<T>(
  kind: PersistedDocumentKind,
  rawSet: import("zustand/vanilla").StoreApi<T>["setState"],
  get: () => T,
  documents: (state: T) => readonly PersistedNamedDocument[],
): import("zustand/vanilla").StoreApi<T>["setState"] {
  type Update = T | Partial<T> | ((state: T) => T | Partial<T>);
  return ((update: Update, replace?: boolean) => {
    const apply = rawSet as (update: Update, replace?: boolean) => void;
    if (!documentMutationSink || projectionDepth > 0) { apply(update, replace); return; }
    const before = documents(get());
    apply(update, replace);
    const after = documents(get());
    if (before !== after) documentMutationSink(kind, before, after);
  }) as import("zustand/vanilla").StoreApi<T>["setState"];
}

let documentNameInventory: ((kinds: readonly PersistedDocumentKind[]) => string[]) | null = null;

export function installDocumentNameInventory(read: NonNullable<typeof documentNameInventory>): () => void {
  if (documentNameInventory) throw new Error("A project name inventory is already active");
  documentNameInventory = read;
  return () => { if (documentNameInventory === read) documentNameInventory = null; };
}

export function projectDocumentNames(kinds: readonly PersistedDocumentKind[], loaded: Iterable<string>): string[] {
  return [...new Set([...(documentNameInventory?.(kinds) ?? []), ...loaded])];
}
