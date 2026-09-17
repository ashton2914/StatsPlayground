import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  createCalculatedColumnAutocompleteEntries,
  reduceCalculatedColumnEditorState,
  type CalculatedColumnEditorState,
} from "@/components/calculatedColumnEditorState";
import { dataService } from "@/services/dataService";
import type {
  CalculatedColumnDiagnostic,
  CalculatedColumnMutationResult,
  CalculatedColumnStatus,
  ColumnDescriptor,
  UpsertCalculatedColumnRequest,
} from "@/types/data";

type CalculatedColumnDialogMode = "create" | "edit" | "convertExisting";

interface CalculatedColumnDialogProps {
  datasetId: string;
  mode: CalculatedColumnDialogMode;
  generation: number;
  descriptors: ColumnDescriptor[];
  initialOutputName: string;
  initialFormulaText: string;
  initialAtIndex: number | null;
  initialOutputColumnId: string | null;
  initialFormulaId: string | null;
  downstreamNames: string[];
  onClose: () => void;
  onApplied: (result: CalculatedColumnMutationResult, request: UpsertCalculatedColumnRequest) => Promise<void> | void;
}

const OUTPUT_TYPE_LABELS: Record<string, string> = {
  boolean: "BOOLEAN",
  continuous: "DOUBLE",
  integer: "INTEGER",
  null: "NULL",
  text: "VARCHAR",
  unknown: "UNKNOWN",
};

const CONTEXTUAL_DIAGNOSTIC_CODES = new Set([
  "missingFormulaId",
  "missingOutputColumnId",
  "missingColumnIdMapEntry",
  "duplicateOutputColumnId",
  "dependencyMismatch",
  "fingerprintMismatch",
]);

const SAFE_CONTEXT_KEYS = ["safeMessage", "userMessage", "context", "detail", "reason"] as const;
const NESTED_CONTEXT_KEYS = ["details", "error", "cause", "diagnostic"] as const;

function hasBlockingDiagnostics(diagnostics: CalculatedColumnDiagnostic[]): boolean {
  return diagnostics.some((diagnostic) => diagnostic.level === "error");
}

function statusTone(status: CalculatedColumnStatus | "pending"): "ready" | "warning" | "error" | "muted" {
  switch (status) {
    case "ready":
      return "ready";
    case "pending":
      return "muted";
    case "draft":
    case "disabled":
      return "warning";
    case "broken":
      return "error";
    case "unsupported":
      return "muted";
    default:
      return "muted";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseStructuredPayload(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return value;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function sanitizeContextText(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    return null;
  }
  if (/^[A-Za-z0-9_.-]+(?:\|[A-Za-z0-9_.-]+)+$/.test(trimmed)) {
    return null;
  }
  return trimmed;
}

function extractSafeContext(value: unknown, allowPlainString = false): string | null {
  if (value instanceof Error) {
    return extractSafeContext(value.message, false);
  }
  if (typeof value === "string") {
    const parsed = parseStructuredPayload(value);
    if (parsed !== value) {
      return extractSafeContext(parsed, false);
    }
    return allowPlainString ? sanitizeContextText(value) : null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const context = extractSafeContext(item, allowPlainString);
      if (context) return context;
    }
    return null;
  }
  if (!isRecord(value)) {
    return null;
  }
  for (const key of SAFE_CONTEXT_KEYS) {
    const context = extractSafeContext(value[key], true);
    if (context) return context;
  }
  for (const key of NESTED_CONTEXT_KEYS) {
    const context = extractSafeContext(value[key], false);
    if (context) return context;
  }
  return null;
}

function serializeDiagnosticPayload(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return "";
  }
}

function formatDiagnosticMessage(
  t: ReturnType<typeof useTranslation>["t"],
  code: string,
  params: Record<string, string>,
  safeContext?: string | null,
): string {
  if (safeContext) {
    return t(`dataTable.calculatedColumn.diagnostics.${code}.withContext`, {
      ...params,
      context: safeContext,
      defaultValue: t(`dataTable.calculatedColumn.diagnostics.${code}.message`, params),
    });
  }
  return t(`dataTable.calculatedColumn.diagnostics.${code}.message`, params);
}

function formatValidationErrorMessage(
  t: ReturnType<typeof useTranslation>["t"],
  error: unknown,
): string {
  const safeContext = extractSafeContext(error);
  return formatDiagnosticMessage(t, "validationFailed", {}, safeContext);
}

function diagnosticDetail(
  t: ReturnType<typeof useTranslation>["t"],
  diagnostic: CalculatedColumnDiagnostic,
  descriptorNameById: Map<string, string>,
): string {
  const parts = diagnostic.message.split("|");
  switch (diagnostic.code) {
    case "missing_dependency":
      return formatDiagnosticMessage(t, "missing_dependency", {
        output: parts[1] ?? "",
        dependency: parts[2] ?? descriptorNameById.get(diagnostic.relatedColumnIds?.[0] ?? "") ?? diagnostic.relatedColumnIds?.[0] ?? "",
      });
    case "unsupported_function":
      return formatDiagnosticMessage(t, "unsupported_function", {
        functionName: parts[1] ?? "",
      });
    case "validationFailed":
      return formatDiagnosticMessage(t, "validationFailed", {}, extractSafeContext(diagnostic.message));
    case "formula_dependency_in_use":
      return formatDiagnosticMessage(t, "formula_dependency_in_use", {
        name: parts[1] ?? "",
        path: (parts[2] ?? "").split(">").join(" -> "),
      });
    case "missingFormulaId":
    case "missingOutputColumnId":
    case "missingColumnIdMapEntry":
    case "duplicateOutputColumnId":
    case "dependencyMismatch":
    case "fingerprintMismatch":
      return formatDiagnosticMessage(t, diagnostic.code, {}, extractSafeContext(diagnostic.message));
    case "cyclicDependency":
    case "missingDependencyColumns":
      return formatDiagnosticMessage(t, diagnostic.code, {
        columns: (diagnostic.relatedColumnIds ?? [])
          .map((columnId) => descriptorNameById.get(columnId) ?? columnId)
          .join(" -> "),
      });
    default:
      return formatDiagnosticMessage(t, "unknown", {}, extractSafeContext(diagnostic.message));
  }
}

function diagnosticLabel(t: ReturnType<typeof useTranslation>["t"], diagnostic: CalculatedColumnDiagnostic): string {
  const code = CONTEXTUAL_DIAGNOSTIC_CODES.has(diagnostic.code)
    || diagnostic.code === "missing_dependency"
    || diagnostic.code === "unsupported_function"
    || diagnostic.code === "validationFailed"
    || diagnostic.code === "cyclicDependency"
    || diagnostic.code === "missingDependencyColumns"
    || diagnostic.code === "formula_dependency_in_use"
      ? diagnostic.code
      : "unknown";
  return t(`dataTable.calculatedColumn.diagnostics.${code}.label`, {
    defaultValue: t("dataTable.calculatedColumn.diagnostics.unknown.label"),
  });
}

export function CalculatedColumnDialog({
  datasetId,
  mode,
  generation,
  descriptors,
  initialOutputName,
  initialFormulaText,
  initialAtIndex,
  initialOutputColumnId,
  initialFormulaId,
  downstreamNames,
  onClose,
  onApplied,
}: CalculatedColumnDialogProps) {
  const { t } = useTranslation();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const requestSeqRef = useRef(0);
  const [outputName, setOutputName] = useState(initialOutputName);
  const [searchText, setSearchText] = useState("");
  const [validatedKey, setValidatedKey] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [validationRevision, setValidationRevision] = useState(0);
  const [requiresRevalidation, setRequiresRevalidation] = useState(false);
  const [validating, setValidating] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [lastStatus, setLastStatus] = useState<CalculatedColumnStatus | "pending">("pending");
  const [inferredOutputType, setInferredOutputType] = useState<keyof typeof OUTPUT_TYPE_LABELS>("unknown");
  const [warningCount, setWarningCount] = useState({
    total: 0,
    expression: 0,
    dependencyGraph: 0,
    validation: 0,
  });
  const [definitionDependencyIds, setDefinitionDependencyIds] = useState<string[]>([]);
  const [diagnostics, setDiagnostics] = useState<CalculatedColumnDiagnostic[]>([]);
  const [editorState, dispatch] = useReducer(
    reduceCalculatedColumnEditorState,
    undefined,
    (): CalculatedColumnEditorState => ({
      generation,
      draftText: initialFormulaText,
      validatedText: null,
      validatedGeneration: null,
      validationStatus: "pending",
      diagnostics: [],
      pendingSubmit: false,
    }),
  );

  const descriptorNameById = useMemo(
    () => new Map(descriptors.map((descriptor) => [descriptor.columnId, descriptor.name])),
    [descriptors],
  );
  const validationKey = `${outputName.trim()}\u0000${editorState.draftText}`;
  const actionKey = mode === "convertExisting" ? "convertExisting" : mode === "edit" ? "edit" : "create";
  const dialogTitle = t(`dataTable.calculatedColumn.actions.${actionKey}`);
  const autocompleteEntries = useMemo(
    () => createCalculatedColumnAutocompleteEntries(
      descriptors,
      searchText,
      (key) => t(`dataTable.calculatedColumn.functions.${key}.detail`, { defaultValue: key }),
    ),
    [descriptors, searchText, t],
  );
  const dependencyNames = useMemo(
    () => definitionDependencyIds.map((columnId) => descriptorNameById.get(columnId) ?? columnId),
    [definitionDependencyIds, descriptorNameById],
  );
  const canApply =
    outputName.trim().length > 0
    && editorState.draftText.trim().length > 0
    && validatedKey === validationKey
    && editorState.validatedText === editorState.draftText
    && editorState.validatedGeneration === generation
    && !hasBlockingDiagnostics(diagnostics)
    && !validating
    && !submitting;
  const validationIsStale = requiresRevalidation;

  useEffect(() => {
    if (editorState.generation !== generation) {
      dispatch({ type: "generationChanged", generation });
      setValidatedKey(null);
      setRequiresRevalidation(true);
    }
  }, [editorState.generation, generation]);

  useEffect(() => {
    if (!outputName.trim() || !editorState.draftText.trim()) {
      setValidatedKey(null);
      setValidationError(null);
      setDiagnostics([]);
      setDefinitionDependencyIds([]);
      setWarningCount({ total: 0, expression: 0, dependencyGraph: 0, validation: 0 });
      setLastStatus("pending");
      setInferredOutputType("unknown");
      return;
    }

    const seq = requestSeqRef.current + 1;
    requestSeqRef.current = seq;
    const timeout = window.setTimeout(() => {
      setValidating(true);
      void dataService.validateCalculatedColumn({
        datasetId,
        outputName: outputName.trim(),
        formulaText: editorState.draftText,
        atIndex: initialAtIndex,
        outputColumnId: initialOutputColumnId,
        formulaId: initialFormulaId,
        expectedGeneration: generation,
      }).then((result) => {
        if (requestSeqRef.current !== seq) return;
        setValidating(false);
        dispatch({
          type: "validationApplied",
          validatedText: editorState.draftText,
          validatedGeneration: generation,
          validationStatus: result.status,
          diagnostics: result.diagnostics ?? [],
        });
        setValidatedKey(validationKey);
        setDiagnostics(result.diagnostics ?? []);
        setDefinitionDependencyIds(result.definition.dependencyColumnIds);
        setWarningCount(result.warningCount);
        setLastStatus(result.status);
        setInferredOutputType(result.definition.inferredOutputType);
        setValidationError(null);
      }).catch((error) => {
        if (requestSeqRef.current !== seq) return;
        const renderedValidationError = formatValidationErrorMessage(t, error);
        const diagnosticPayload = serializeDiagnosticPayload(error);
        setValidating(false);
        dispatch({
          type: "validationApplied",
          validatedText: editorState.draftText,
          validatedGeneration: generation,
          validationStatus: "broken",
          diagnostics: [{
            level: "error",
            code: "validationFailed",
            message: diagnosticPayload,
          }],
        });
        setValidatedKey(null);
        setDiagnostics([{ level: "error", code: "validationFailed", message: diagnosticPayload }]);
        setDefinitionDependencyIds([]);
        setWarningCount({ total: 0, expression: 0, dependencyGraph: 0, validation: 0 });
        setLastStatus("broken");
        setInferredOutputType("unknown");
        setValidationError(renderedValidationError);
      });
    }, 150);

    return () => {
      window.clearTimeout(timeout);
      if (requestSeqRef.current === seq) {
        setValidating(false);
      }
    };
  }, [
    datasetId,
    descriptors,
    editorState.draftText,
    initialAtIndex,
    initialFormulaId,
    initialOutputColumnId,
    outputName,
    t,
    validationRevision,
    validationKey,
  ]);

  const handleRevalidate = () => {
    if (!outputName.trim() || !editorState.draftText.trim()) return;
    setValidatedKey(null);
    setValidationError(null);
    setLastStatus("pending");
    setRequiresRevalidation(false);
    setValidationRevision((value) => value + 1);
  };

  const insertAutocomplete = (text: string) => {
    const textarea = textareaRef.current;
    if (!textarea) {
      dispatch({ type: "draftChanged", draftText: `${editorState.draftText}${text}` });
      return;
    }
    const start = textarea.selectionStart ?? editorState.draftText.length;
    const end = textarea.selectionEnd ?? editorState.draftText.length;
    const nextText = `${editorState.draftText.slice(0, start)}${text}${editorState.draftText.slice(end)}`;
    dispatch({ type: "draftChanged", draftText: nextText });
    queueMicrotask(() => {
      textarea.focus();
      const caret = start + text.length;
      textarea.setSelectionRange(caret, caret);
    });
  };

  const handleApply = async () => {
    if (!canApply) return;
    const request: UpsertCalculatedColumnRequest = {
      datasetId,
      outputName: outputName.trim(),
      formulaText: editorState.draftText,
      atIndex: initialAtIndex,
      outputColumnId: initialOutputColumnId,
      formulaId: initialFormulaId,
      expectedGeneration: generation,
    };
    setSubmitting(true);
    try {
      const result = await dataService.upsertCalculatedColumn(request);
      await onApplied(result, request);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="sp-dialog-overlay" onMouseDown={submitting ? undefined : onClose}>
      <div
        className="sp-dialog sp-dialog-wide sp-calculated-column-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={dialogTitle}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="sp-dialog-title sp-calculated-column-header">
          <div>
            <div className="sp-calculated-column-title-row">
              <i className="fa-solid fa-calculator" aria-hidden="true" />
              <span>{dialogTitle}</span>
            </div>
            <div className="sp-calculated-column-subtitle">{t("dataTable.calculatedColumn.subtitle")}</div>
          </div>
          <button
            type="button"
            className="sp-dialog-btn"
            onClick={onClose}
            disabled={submitting}
            aria-label={t("common.cancel")}
          >
            <i className="fa-solid fa-xmark" aria-hidden="true" />
          </button>
        </div>
        <div className="sp-dialog-body sp-calculated-column-body">
          <div className="sp-calculated-column-main">
            <label className="sp-dialog-label" htmlFor="calculated-column-output-name">
              {t("dataTable.calculatedColumn.fields.outputName")}
            </label>
            <input
              id="calculated-column-output-name"
              className="sp-dialog-input"
              value={outputName}
              onChange={(event) => {
                setOutputName(event.target.value);
                setValidatedKey(null);
              }}
            />
            <label className="sp-dialog-label" htmlFor="calculated-column-formula">
              {t("dataTable.calculatedColumn.fields.formula")}
            </label>
            <textarea
              id="calculated-column-formula"
              ref={textareaRef}
              className="sp-dialog-input sp-calculated-column-textarea"
              value={editorState.draftText}
              onChange={(event) => {
                setValidatedKey(null);
                dispatch({ type: "draftChanged", draftText: event.target.value });
              }}
              spellCheck={false}
              rows={6}
            />
            <div className="sp-calculated-column-summary-row">
              <span className={`sp-calculated-column-status is-${statusTone(lastStatus)}`}>
                {t(`dataTable.calculatedColumn.status.${lastStatus}`, { defaultValue: lastStatus })}
              </span>
              <span>{t("dataTable.calculatedColumn.outputType", {
                type: OUTPUT_TYPE_LABELS[inferredOutputType],
              })}</span>
              <span>{t("dataTable.calculatedColumn.warningCount", { count: warningCount.total })}</span>
            </div>
            <div className="sp-calculated-column-summary-row">
              <span>{t("dataTable.calculatedColumn.warningLabels.expression", { count: warningCount.expression })}</span>
              <span>{t("dataTable.calculatedColumn.warningLabels.dependencyGraph", { count: warningCount.dependencyGraph })}</span>
              <span>{t("dataTable.calculatedColumn.warningLabels.validation", { count: warningCount.validation })}</span>
            </div>
            {validationIsStale && (
              <div className="sp-calculated-column-banner is-warning">
                <i className="fa-solid fa-rotate" aria-hidden="true" />
                <span>{t("dataTable.calculatedColumn.staleValidation")}</span>
                <button
                  type="button"
                  className="sp-dialog-btn"
                  onClick={handleRevalidate}
                  disabled={submitting || validating || !outputName.trim() || !editorState.draftText.trim()}
                >
                  {t("dataTable.calculatedColumn.actions.revalidate")}
                </button>
              </div>
            )}
            {validationError && (
              <div className="sp-calculated-column-banner is-error" role="alert">
                <i className="fa-solid fa-triangle-exclamation" aria-hidden="true" />
                <span>{validationError}</span>
              </div>
            )}
          </div>
          <div className="sp-calculated-column-side">
            <label className="sp-dialog-label" htmlFor="calculated-column-search">
              {t("dataTable.calculatedColumn.fields.search")}
            </label>
            <input
              id="calculated-column-search"
              className="sp-dialog-input"
              value={searchText}
              onChange={(event) => setSearchText(event.target.value)}
            />
            <div className="sp-calculated-column-autocomplete" role="list" aria-label={t("dataTable.calculatedColumn.fields.search")}>
              {autocompleteEntries.length === 0 ? (
                <div className="sp-calculated-column-empty">{t("dataTable.calculatedColumn.zeroMatch")}</div>
              ) : autocompleteEntries.map((entry) => (
                <button
                  key={`${entry.kind}:${entry.columnId ?? entry.label}`}
                  type="button"
                  className="sp-calculated-column-entry"
                  onClick={() => insertAutocomplete(entry.insertText)}
                >
                  <span className="sp-calculated-column-entry-label">{entry.label}</span>
                  <span className="sp-calculated-column-entry-detail">{entry.detail}</span>
                </button>
              ))}
            </div>
            <div className="sp-calculated-column-meta">
              <div>
                <div className="sp-calculated-column-meta-title">{t("dataTable.calculatedColumn.fields.dependencies")}</div>
                <div className="sp-calculated-column-chip-list">
                  {dependencyNames.length === 0 ? <span className="sp-calculated-column-empty">{t("common.empty")}</span> : dependencyNames.map((name) => (
                    <span key={name} className="sp-calculated-column-chip">{name}</span>
                  ))}
                </div>
              </div>
              <div>
                <div className="sp-calculated-column-meta-title">{t("dataTable.calculatedColumn.fields.downstream")}</div>
                <div className="sp-calculated-column-chip-list">
                  {downstreamNames.length === 0 ? <span className="sp-calculated-column-empty">{t("common.empty")}</span> : downstreamNames.map((name) => (
                    <span key={name} className="sp-calculated-column-chip">{name}</span>
                  ))}
                </div>
              </div>
              <div>
                <div className="sp-calculated-column-meta-title">{t("dataTable.calculatedColumn.fields.diagnostics")}</div>
                <ul className="sp-calculated-column-diagnostics">
                  {diagnostics.length === 0 ? <li className="sp-calculated-column-empty">{t("common.empty")}</li> : diagnostics.map((diagnostic, index) => (
                    <li key={`${diagnostic.code}:${index}`} className={`sp-calculated-column-diagnostic is-${diagnostic.level}`}>
                      <span>{diagnosticLabel(t, diagnostic)}</span>
                      <span>{diagnosticDetail(t, diagnostic, descriptorNameById)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        </div>
        <div className="sp-dialog-actions sp-calculated-column-actions">
          <button className="sp-dialog-btn" onClick={onClose} disabled={submitting}>{t("common.cancel")}</button>
          <button className="sp-dialog-btn sp-dialog-btn-primary" onClick={handleApply} disabled={!canApply}>
            {t("common.apply")}
          </button>
        </div>
      </div>
    </div>
  );
}