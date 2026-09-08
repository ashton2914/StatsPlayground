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