import { create } from "zustand";

import {
  canonicalizeFitModelTerms,
  fitModelTermIdentityKey,
  FitModelValidationError,
  validateFitModelDefinition,
} from "@/components/fitModel/fitModelConfig";
import type { FieldRef } from "@/graphCore";
import { useProjectStore } from "@/stores/useProjectStore";
import type { FitModelConstruct, FitModelItem, FitModelLoadIssue, FitModelTerm } from "@/types/fitModel";
import { assertProjectMutable } from "@/utils/saveReadOnly";

interface FitModelStore {
  items: FitModelItem[];
  counter: number;
  migrationWarnings: string[];
  addItem: (item: FitModelItem) => void;
  updateItem: (id: string, patch: Partial<FitModelItem>) => void;
  renameItem: (id: string, name: string) => void;
  updateDefinition: (
    id: string,
    patch: {
      terms: readonly FitModelTerm[];
      centeringMethod: FitModelItem["centeringMethod"];
    },
  ) => void;
  deleteItem: (id: string) => void;
  deleteByDataset: (datasetId: string) => void;
  loadFromProject: (items: unknown[]) => void;
  reset: () => void;
  nextName: () => string;
}

const FIT_MODEL_NAME_RE = /^Fit Model (\d+)$/;

function maxFitModelSuffix(items: readonly FitModelItem[]): number {
  return items.reduce((maxValue, item) => {
    const match = item.name.match(FIT_MODEL_NAME_RE);
    if (!match) {
      return maxValue;
    }
    return Math.max(maxValue, Number.parseInt(match[1], 10));
  }, 0);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function cloneResponse(value: FieldRef): FieldRef {
  return { name: value.name, type: value.type };
}

function cloneTerms(terms: readonly FitModelTerm[]): FitModelTerm[] {
  return terms.map((term) => {
    if (term.kind === "main") {
      return { kind: "main", columnNames: [term.columnNames[0]] };
    }
    if (term.kind === "power") {
      return { kind: "power", columnNames: [term.columnNames[0]], exponent: 2 };
    }
    return {
      kind: "interaction",
      columnNames: [...term.columnNames] as [string, string, ...string[]],
    };
  });
}

function cloneConstruct(construct: FitModelConstruct): FitModelConstruct {
  if (construct.kind === "factorialToDegree") {
    return { kind: "factorialToDegree", degree: construct.degree };
  }
  return { kind: construct.kind };
}

function sanitizeItem(item: FitModelItem): FitModelItem {
  const validation = validateFitModelDefinition({
    response: item.response,
    terms: item.terms,
  });
  if (!validation.ok) {
    throw new FitModelValidationError(validation);
  }

  return {
    id: item.id,
    name: item.name,
    sourceDatasetId: item.sourceDatasetId,
    response: cloneResponse(item.response),
    construct: cloneConstruct(item.construct),
    terms: cloneTerms(canonicalizeFitModelTerms(item.terms)),
    centeringMethod: item.centeringMethod,
    createdAt: item.createdAt,
    loadIssue: item.loadIssue
      ? { code: item.loadIssue.code, detail: item.loadIssue.detail }
      : undefined,
  };
}

function cloneLoadIssue(value: FitModelLoadIssue): FitModelLoadIssue {
  return {
    code: value.code,
    detail: value.detail,
  };
}

function sanitizeOrPreserveItem(item: FitModelItem): FitModelItem {
  if (item.loadIssue) {
    return {
      id: item.id,
      name: item.name,
      sourceDatasetId: item.sourceDatasetId,
      response: cloneResponse(item.response),
      construct: cloneConstruct(item.construct),
      terms: cloneTerms(canonicalizeFitModelTerms(item.terms)),
      centeringMethod: item.centeringMethod,
      createdAt: item.createdAt,
      loadIssue: cloneLoadIssue(item.loadIssue),
    };
  }

  return sanitizeItem(item);
}

function serializeValidationDetail(error: Exclude<ReturnType<typeof validateFitModelDefinition>, { ok: true }>): string {
  const parts: string[] = [error.reason];
  if (error.columnName) {
    parts.push(`column:${error.columnName}`);
  }
  if (error.termKey) {
    parts.push(`term:${error.termKey}`);
  }
  if (error.termKind) {
    parts.push(`kind:${error.termKind}`);
  }
  return parts.join(";");
}

function parseTerm(value: unknown): FitModelTerm | null {
  if (!isObject(value)) return null;
  const kind = value.kind;
  const columnNames = value.columnNames;
  if ((kind !== "main" && kind !== "interaction" && kind !== "power") || !Array.isArray(columnNames)) {
    return null;
  }
  if (!columnNames.every((entry) => typeof entry === "string")) {
    return null;
  }

  if (kind === "main") {
    if (columnNames.length !== 1) {
      return null;
    }
    return {
      kind: "main",
      columnNames: [columnNames[0]],
    };
  }

  if (kind === "power") {
    if (columnNames.length !== 1 || value.exponent !== 2) {
      return null;
    }
    return {
      kind: "power",
      columnNames: [columnNames[0]],
      exponent: 2,
    };
  }

  if (columnNames.length < 2) {
    return null;
  }
  if (new Set(columnNames).size !== columnNames.length) {
    return null;
  }

  return {
    kind: "interaction",
    columnNames: [...columnNames] as [string, string, ...string[]],
  };
}

function parseConstruct(value: unknown): {
  construct: FitModelConstruct;
  migratedFromMissing: boolean;
  invalid: boolean;
} {
  if (value === undefined) {
    return {
      construct: { kind: "manual" },
      migratedFromMissing: true,
      invalid: false,
    };
  }

  if (!isObject(value) || typeof value.kind !== "string") {
    return { construct: { kind: "manual" }, migratedFromMissing: false, invalid: true };
  }

  const kind = value.kind;
  if (kind === "manual" || kind === "fullFactorial" || kind === "responseSurface") {
    return {
      construct: { kind },
      migratedFromMissing: false,
      invalid: false,
    };
  }

  if (kind === "factorialToDegree") {
    const degree = value.degree;
    if (typeof degree === "number" && Number.isInteger(degree) && degree >= 1) {
      return {
        construct: { kind: "factorialToDegree", degree },
        migratedFromMissing: false,
        invalid: false,
      };
    }
  }

  return { construct: { kind: "manual" }, migratedFromMissing: false, invalid: true };
}

function normalizeLoadedFitModel(value: unknown): {
  item: FitModelItem | null;
  warnings: string[];
} {
  if (!isObject(value)) return { item: null, warnings: [] };

  const id = value.id;
  const name = value.name;
  const sourceDatasetId = value.sourceDatasetId;
  const createdAt = value.createdAt;

  if (typeof id !== "string" || typeof name !== "string" || typeof sourceDatasetId !== "string" || typeof createdAt !== "string") {
    return { item: null, warnings: [] };
  }

  const response = value.response;
  const construct = value.construct;
  const terms = value.terms;
  const centeringMethod = value.centeringMethod;

  const loadIssueDetails: string[] = [];

  let normalizedResponse: FieldRef = { name: "", type: "continuous" };
  if (isObject(response) && typeof response.name === "string" && (response.type === "continuous" || response.type === "ordinal" || response.type === "nominal")) {
    normalizedResponse = { name: response.name, type: response.type };
  } else {
    loadIssueDetails.push("invalidResponseShape");
  }

  const parsedConstruct = parseConstruct(construct);
  if (parsedConstruct.invalid) {
    loadIssueDetails.push("invalidConstruct");
  }

  const parsedTerms: FitModelTerm[] = [];
  if (Array.isArray(terms)) {
    for (let index = 0; index < terms.length; index += 1) {
      const parsed = parseTerm(terms[index]);
      if (!parsed) {
        loadIssueDetails.push(`invalidTerm:${index}`);
        continue;
      }
      parsedTerms.push(parsed);
    }
  } else {
    loadIssueDetails.push("invalidTermsShape");
  }

  const normalizedCenteringMethod = centeringMethod === "mean" ? "mean" : "none";
  if (centeringMethod !== "none" && centeringMethod !== "mean") {
    loadIssueDetails.push("invalidCenteringMethod");
  }

  const canonicalTerms = canonicalizeFitModelTerms(parsedTerms);
  const dedupedTerms: FitModelTerm[] = [];
  const seen = new Set<string>();
  const warnings: string[] = [];
  for (const term of canonicalTerms) {
    const key = fitModelTermIdentityKey(term);
    if (seen.has(key)) {
      warnings.push(`Dropped duplicate Fit Model term ${key} while loading ${id}.`);
      continue;
    }
    seen.add(key);
    dedupedTerms.push(term);
  }

  const candidate: FitModelItem = {
    id,
    name,
    sourceDatasetId,
    response: normalizedResponse,
    construct: parsedConstruct.construct,
    terms: dedupedTerms,
    centeringMethod: normalizedCenteringMethod,
    createdAt,
  };

  try {
    if (loadIssueDetails.length > 0) {
      return {
        item: sanitizeOrPreserveItem({
          ...candidate,
          loadIssue: {
            code: "invalidPersistedDefinition",
            detail: loadIssueDetails.join(";"),
          },
        }),
        warnings,
      };
    }

    return { item: sanitizeItem(candidate), warnings };
  } catch (error) {
    if (error instanceof FitModelValidationError) {
      return {
        item: sanitizeOrPreserveItem({
          ...candidate,
          loadIssue: {
            code: "invalidPersistedDefinition",
            detail: serializeValidationDetail(error.result),
          },
        }),
        warnings,
      };
    }
    throw error;
  }
}

function nextCounterValue(items: readonly FitModelItem[]): number {
  return Math.max(1, maxFitModelSuffix(items) + 1);
}

export const useFitModelStore = create<FitModelStore>((set, get) => ({
  items: [],
  counter: 1,
  migrationWarnings: [],
  addItem: (item) => {
    assertProjectMutable(useProjectStore.getState().readOnly);
    const normalized = sanitizeOrPreserveItem(item);
    set((state) => ({
      items: [...state.items, normalized],
      counter: Math.max(state.counter, nextCounterValue([normalized])),
    }));
  },
  updateItem: (id, patch) => {
    assertProjectMutable(useProjectStore.getState().readOnly);
    set((state) => {
      const items = state.items.map((item) => {
        if (item.id !== id) {
          return item;
        }

        const next: FitModelItem = {
          id: typeof patch.id === "string" ? patch.id : item.id,
          name: typeof patch.name === "string" ? patch.name : item.name,
          sourceDatasetId: typeof patch.sourceDatasetId === "string" ? patch.sourceDatasetId : item.sourceDatasetId,
          response: patch.response ? cloneResponse(patch.response) : cloneResponse(item.response),
          construct: patch.construct ? cloneConstruct(patch.construct) : cloneConstruct(item.construct),
          terms: patch.terms ? cloneTerms(canonicalizeFitModelTerms(patch.terms)) : cloneTerms(item.terms),
          centeringMethod: patch.centeringMethod ?? item.centeringMethod,
          createdAt: typeof patch.createdAt === "string" ? patch.createdAt : item.createdAt,
          loadIssue: patch.loadIssue ?? item.loadIssue,
        };

        return sanitizeOrPreserveItem(next);
      });

      return {
        items,
        counter: Math.max(state.counter, nextCounterValue(items)),
      };
    });
  },
  renameItem: (id, name) => {
    assertProjectMutable(useProjectStore.getState().readOnly);
    const trimmed = name.trim();
    if (!trimmed) return;
    set((state) => {
      const items = state.items.map((item) => {
        if (item.id !== id) {
          return item;
        }
        return sanitizeOrPreserveItem({ ...item, name: trimmed });
      });
      return {
        items,
        counter: Math.max(state.counter, nextCounterValue(items)),
      };
    });
  },
  updateDefinition: (id, patch) => {
    assertProjectMutable(useProjectStore.getState().readOnly);
    set((state) => {
      const items = state.items.map((item) => {
        if (item.id !== id) {
          return item;
        }

        const next: FitModelItem = {
          ...item,
          terms: cloneTerms(canonicalizeFitModelTerms(patch.terms)),
          centeringMethod: patch.centeringMethod,
        };

        return sanitizeOrPreserveItem(next);
      });

      return {
        items,
        counter: Math.max(state.counter, nextCounterValue(items)),
      };
    });
  },
  deleteItem: (id) => {
    assertProjectMutable(useProjectStore.getState().readOnly);
    set((state) => ({ items: state.items.filter((item) => item.id !== id) }));
  },
  deleteByDataset: (datasetId) => {
    assertProjectMutable(useProjectStore.getState().readOnly);
    set((state) => ({ items: state.items.filter((item) => item.sourceDatasetId !== datasetId) }));
  },
  loadFromProject: (items) => set(() => {
    const normalized: FitModelItem[] = [];
    const migrationWarnings: string[] = [];
    for (const value of items) {
      const next = normalizeLoadedFitModel(value);
      if (!next.item) {
        continue;
      }
      normalized.push(next.item);
      migrationWarnings.push(...next.warnings);
    }
    return {
      items: normalized,
      counter: nextCounterValue(normalized),
      migrationWarnings,
    };
  }),
  reset: () => set({ items: [], counter: 1, migrationWarnings: [] }),
  nextName: () => {
    assertProjectMutable(useProjectStore.getState().readOnly);
    const nextCounter = get().counter;
    set({ counter: nextCounter + 1 });
    return `Fit Model ${nextCounter}`;
  },
}));