import type {
  CalculatedColumnDiagnostic,
  CalculatedColumnStatus,
  ColumnDescriptor,
} from "@/types/data";

export interface CalculatedColumnAutocompleteEntry {
  kind: "column" | "function";
  label: string;
  insertText: string;
  detail: string;
  columnId?: string;
}

type CalculatedFunctionKey = "abs" | "coalesce" | "if" | "max" | "min" | "round";

export interface CalculatedColumnEditorState {
  generation: number;
  draftText: string;
  validatedText: string | null;
  validatedGeneration: number | null;
  validationStatus: "pending" | CalculatedColumnStatus;
  diagnostics: CalculatedColumnDiagnostic[];
  pendingSubmit: boolean;
}

export type CalculatedColumnEditorAction =
  | { type: "draftChanged"; draftText: string }
  | {
      type: "validationApplied";
      validatedText: string;
      validatedGeneration: number;
      validationStatus: CalculatedColumnStatus;
      diagnostics: CalculatedColumnDiagnostic[];
    }
  | { type: "generationChanged"; generation: number };

const FUNCTION_CATALOG: Array<{ key: CalculatedFunctionKey; label: string; insertText: string }> = [
  { key: "abs", label: "abs", insertText: "ABS()" },
  { key: "coalesce", label: "coalesce", insertText: "COALESCE()" },
  { key: "if", label: "if", insertText: "IF()" },
  { key: "max", label: "max", insertText: "MAX()" },
  { key: "min", label: "min", insertText: "MIN()" },
  { key: "round", label: "round", insertText: "ROUND()" },
];

const DEFAULT_FUNCTION_DETAILS: Record<CalculatedFunctionKey, string> = {
  abs: "Numeric absolute value",
  coalesce: "First non-null value",
  if: "Conditional branch",
  max: "Row-wise maximum",
  min: "Row-wise minimum",
  round: "Round numeric value",
};

function defaultFunctionDetail(key: CalculatedFunctionKey): string {
  return DEFAULT_FUNCTION_DETAILS[key];
}

export function reduceCalculatedColumnEditorState(
  state: CalculatedColumnEditorState,
  action: CalculatedColumnEditorAction,
): CalculatedColumnEditorState {
  switch (action.type) {
    case "draftChanged":
      return {
        ...state,
        draftText: action.draftText,
        pendingSubmit: false,
      };
    case "validationApplied":
      return {
        ...state,
        validatedText: action.validatedText,
        validatedGeneration: action.validatedGeneration,
        validationStatus: action.validationStatus,
        diagnostics: action.diagnostics,
        pendingSubmit: false,
      };
    case "generationChanged":
      return {
        ...state,
        generation: action.generation,
        validatedText: null,
        validatedGeneration: null,
        validationStatus: "pending",
        diagnostics: [],
        pendingSubmit: false,
      };
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}

function escapeColumnName(name: string): string {
  return `[${name.split("]").join("]]")}]`;
}

function buildEntries(
  descriptors: ColumnDescriptor[],
  getFunctionDetail: (key: CalculatedFunctionKey) => string,
): CalculatedColumnAutocompleteEntry[] {
  const columnEntries = descriptors.map((descriptor) => ({
    kind: "column" as const,
    label: descriptor.name,
    insertText: escapeColumnName(descriptor.name),
    detail: descriptor.sqlType,
    columnId: descriptor.columnId,
  }));

  const functionEntries = FUNCTION_CATALOG.map((entry) => ({
    kind: "function" as const,
    label: entry.label,
    insertText: entry.insertText,
    detail: getFunctionDetail(entry.key),
  }));

  return [...columnEntries, ...functionEntries];
}

export function createCalculatedColumnAutocompleteEntries(
  descriptors: ColumnDescriptor[],
  filterText = "",
  getFunctionDetail: (key: CalculatedFunctionKey) => string = defaultFunctionDetail,
): CalculatedColumnAutocompleteEntry[] {
  const entries = buildEntries(descriptors, getFunctionDetail);
  const normalizedFilter = filterText.trim().toLowerCase();
  if (!normalizedFilter) {
    return entries;
  }

  const filtered = entries.filter((entry) => {
    const haystacks = [entry.label, entry.insertText, entry.detail];
    return haystacks.some((value) => value.toLowerCase().includes(normalizedFilter));
  });

  return filtered;
}