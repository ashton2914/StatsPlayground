import { useEffect, useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { inferFieldType, type FieldRef } from "@/graphCore/types";
import { dataService } from "@/services/dataService";
import type { FitYByXAnalysisEditorItem } from "@/components/analysis/adapters/fitYByXAnalysisAdapter";
import type { ColumnDisplayProps, ColumnMeta, DatasetMeta } from "@/types/data";
import type { FitYByXItem } from "@/types/fitYByX";

import {
  assignFitYByXField,
  canCreateFitYByX,
  clearFitYByXField,
  createFitYByXDialogState,
  filterFitYByXFields,
  type FitYByXFieldInfo,
} from "./fitYByXDialogState";
import {
  createFitYByXItem,
  type FitYByXRole,
  type FitYByXValidationError,
  deriveFitYByXPersonality,
  validateFitYByXRoles,
} from "./fitYByXConfig";
import {
  FIT_Y_BY_X_DRAG_MIME,
  FitYByXRoleZone,
  type FitYByXDragPayload,
  type FitYByXRoleZoneItem,
} from "./FitYByXRoleZone";

export interface FitYByXRoleDialogProps {
  mode: "create" | "edit";
  dataset: DatasetMeta;
  defaultName: string;
  initialValue?: FitYByXAnalysisEditorItem;
  onCancel: () => void;
  onCreate: (item: FitYByXAnalysisEditorItem) => void;
}

export function FitYByXRoleDialog({
  mode,
  dataset,
  defaultName,
  initialValue,
  onCancel,
  onCreate,
}: FitYByXRoleDialogProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const [draft, setDraft] = useState(() => createDialogState(defaultName, initialValue));
  const [confidenceLevel, setConfidenceLevel] = useState(initialValue?.confidenceLevel ?? 0.95);
  const [fields, setFields] = useState<FitYByXFieldInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  useEffect(() => {
    setDraft(createDialogState(defaultName, initialValue));
    setConfidenceLevel(initialValue?.confidenceLevel ?? 0.95);
  }, [defaultName, dataset.id, initialValue]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError(null);

    Promise.all([
      dataService.getColumns(dataset.id),
      dataService.getColumnDisplayProps(dataset.id).catch(() => []),
    ])
      .then(([columns, displayProps]) => {
        if (!active) {
          return;
        }
        setFields(buildFitYByXFieldInfoList(columns, displayProps));
        setLoading(false);
      })
      .catch((reason: unknown) => {
        if (!active) {
          return;
        }
        setFields([]);
        setLoading(false);
        setLoadError(String(reason));
      });

    return () => {
      active = false;
    };
  }, [dataset.id]);

  const visibleFields = useMemo(
    () => filterFitYByXFields(fields, search),
    [fields, search],
  );
  const fieldsByName = useMemo(
    () => new Map(fields.map((field) => [field.name, field])),
    [fields],
  );
  const assignmentValidation = useMemo(
    () => validateFitYByXRoles({ response: draft.response, factor: draft.factor }),
    [draft.factor, draft.response],
  );
  const validationMessage = useMemo(() => {
    if (draft.validationError == null) {
      return null;
    }
    return validationErrorText(t, draft.validationError);
  }, [draft.validationError, t]);
  const helpMessage = assignmentValidation.ok
    ? null
    : assignmentValidation.error === "missingResponse"
      ? t("fitYByX.assignResponseHelp", { defaultValue: "Assign a continuous response field for Y." })
      : t("fitYByX.assignFactorHelp", { defaultValue: "Assign a continuous, nominal, or ordinal field for X." });
  const confidenceValid = Number.isFinite(confidenceLevel)
    && confidenceLevel > 0
    && confidenceLevel < 1;
  const createDisabled = loading || !canCreateFitYByX(draft) || !confidenceValid;

  const responseItem = toRoleZoneItem(draft.response, fieldsByName);
  const factorItem = toFactorRoleZoneItem(draft.factor, fieldsByName, t);
  const assignedNames = new Set(
    [draft.response?.name, draft.factor?.name].filter((name): name is string => !!name),
  );

  const handleAssign = (role: FitYByXRole, field: FitYByXFieldInfo) => {
    setDraft((current) => assignFitYByXField(current, role, field));
  };

  const handleDropPayload = (role: FitYByXRole, payload: FitYByXDragPayload) => {
    const field = fieldsByName.get(payload.fieldName);
    if (!field) {
      return;
    }
    handleAssign(role, field);
  };

  const handleCreate = () => {
    if (createDisabled || !draft.response || !draft.factor) {
      return;
    }
    const item: FitYByXItem = mode === "edit" && initialValue
      ? {
          ...initialValue,
          response: draft.response,
          factor: draft.factor,
          personality: deriveFitYByXPersonality(draft.factor),
        }
      : createFitYByXItem({
          id: crypto.randomUUID(),
          name: draft.name.trim(),
          sourceDatasetId: dataset.id,
          response: draft.response,
          factor: draft.factor,
          createdAt: new Date().toISOString(),
        });
    onCreate({ ...item, confidenceLevel });
  };

  return (
    <div className="sp-dialog-overlay" onMouseDown={onCancel}>
      <div
        className="sp-dialog sp-dialog-wide sp-fit-y-by-x-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="sp-dialog-title" id={titleId}>
          {t("fitYByX.dialogTitle", { defaultValue: "Fit Y by X" })}
        </div>

        <div className="sp-dialog-body sp-fit-y-by-x-dialog-body">
          <div className="sp-dialog-field">
            <label className="sp-dialog-label" htmlFor={`${titleId}-name`}>
              {t("fitYByX.analysisName", { defaultValue: "Analysis name" })}
            </label>
            <input
              id={`${titleId}-name`}
              className="sp-dialog-input"
              value={draft.name}
              disabled={mode === "edit"}
              onChange={(event) => {
                const name = event.target.value;
                setDraft((current) => ({ ...current, name }));
              }}
              placeholder={t("fitYByX.analysisNamePlaceholder", { defaultValue: "Fit Y by X" })}
            />
          </div>

          <div className="sp-dialog-field">
            <label className="sp-dialog-label" htmlFor={`${titleId}-confidence`}>
              {t("distribution.confidenceLevel", { defaultValue: "Confidence level" })}
            </label>
            <input
              id={`${titleId}-confidence`}
              className="sp-dialog-input"
              type="number"
              min="0"
              max="1"
              step="0.01"
              value={confidenceLevel}
              onChange={(event) => setConfidenceLevel(Number(event.target.value))}
              aria-invalid={!confidenceValid}
            />
          </div>

          <div className="sp-fit-y-by-x-dialog-grid">
            <section className="sp-tabulate-panel sp-fit-y-by-x-fields-panel" aria-label={t("fitYByX.availableFields", { defaultValue: "Available fields" })}>
              <div className="sp-panel-header">
                <div className="sp-tabulate-heading-copy">
                  <span className="sp-panel-header-title">{t("fitYByX.availableFields", { defaultValue: "Available fields" })}</span>
                  <span className="sp-tabulate-source-label" title={dataset.name}>
                    {t("workspace.datasourceLabel", { defaultValue: "Source: {{name}}", name: dataset.name })}
                  </span>
                </div>
              </div>

              <div className="sp-tabulate-field-toolbar">
                <label className="sp-tabulate-search" aria-label={t("fitYByX.searchFields", { defaultValue: "Search fields" })}>
                  <i className="fa-solid fa-magnifying-glass" aria-hidden="true" />
                  <input
                    type="search"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder={t("fitYByX.searchFields", { defaultValue: "Search fields" })}
                    aria-label={t("fitYByX.searchAvailableFields", { defaultValue: "Search available fields" })}
                  />
                </label>
              </div>

              <div className="sp-cols-panel-list" role="list" aria-busy={loading}>
                {loading ? <div className="sp-tabulate-empty-note">{t("fitYByX.loadingFields", { defaultValue: "Loading fields…" })}</div> : null}
                {!loading && visibleFields.length === 0 ? (
                  <div className="sp-tabulate-empty-note">
                    {fields.length === 0
                      ? t("fitYByX.noFieldsAvailable", { defaultValue: "No fields available for this source." })
                      : t("fitYByX.noFieldsMatchSearch", { defaultValue: "No fields match the current search." })}
                  </div>
                ) : null}
                {!loading
                  ? visibleFields.map((field) => {
                      const assigned = assignedNames.has(field.name);
                      return (
                        <div
                          key={field.name}
                          role="listitem"
                          tabIndex={0}
                          draggable
                          className={`sp-cols-panel-item sp-fit-y-by-x-field${assigned ? " sp-cols-panel-item-selected" : ""}`}
                          title={`${field.name} (${field.sqlType}, ${field.modelingRole})`}
                          onDragStart={(event) => {
                            event.dataTransfer.effectAllowed = "copyMove";
                            event.dataTransfer.setData(
                              FIT_Y_BY_X_DRAG_MIME,
                              JSON.stringify({ fieldName: field.name }),
                            );
                          }}
                          onKeyDown={(event) => {
                            const key = event.key.toLowerCase();
                            if (key === "y") {
                              event.preventDefault();
                              handleAssign("response", field);
                            } else if (key === "x") {
                              event.preventDefault();
                              handleAssign("factor", field);
                            }
                          }}
                        >
                          <div className="sp-fit-y-by-x-field-copy">
                            <span className="sp-cols-panel-item-type">{field.sqlType}</span>
                            <span className="sp-cols-panel-item-name">{field.name}</span>
                            <span className="sp-cols-panel-item-extras">{field.modelingRole}</span>
                          </div>

                          <div className="sp-fit-y-by-x-field-actions">
                            <button
                              type="button"
                              className="sp-tabulate-inline-button"
                              onClick={() => handleAssign("response", field)}
                              aria-label={t("fitYByX.assignResponseLabel", {
                                defaultValue: "Assign {{field}} as response",
                                field: field.name,
                              })}
                              title={t("fitYByX.assignResponse", { defaultValue: "Assign as Y" })}
                            >
                              Y
                            </button>
                            <button
                              type="button"
                              className="sp-tabulate-inline-button"
                              onClick={() => handleAssign("factor", field)}
                              aria-label={t("fitYByX.assignFactorLabel", {
                                defaultValue: "Assign {{field}} as factor",
                                field: field.name,
                              })}
                              title={t("fitYByX.assignFactor", { defaultValue: "Assign as X" })}
                            >
                              X
                            </button>
                          </div>
                        </div>
                      );
                    })
                  : null}
              </div>
            </section>

            <div className="sp-fit-y-by-x-roles-column">
              <FitYByXRoleZone
                role="response"
                title={t("fitYByX.response", { defaultValue: "Response (Y)" })}
                subtitle={t("fitYByX.responseHint", { defaultValue: "Continuous" })}
                emptyHint={t("fitYByX.responseEmpty", { defaultValue: "Drop or assign one continuous field." })}
                item={responseItem}
                onDropPayload={handleDropPayload}
                onClear={() => setDraft((current) => clearFitYByXField(current, "response"))}
              />

              <FitYByXRoleZone
                role="factor"
                title={t("fitYByX.factor", { defaultValue: "Factor (X)" })}
                subtitle={t("fitYByX.factorHint", { defaultValue: "Continuous, nominal, or ordinal" })}
                emptyHint={t("fitYByX.factorEmpty", { defaultValue: "Drop or assign one continuous, nominal, or ordinal field." })}
                item={factorItem}
                onDropPayload={handleDropPayload}
                onClear={() => setDraft((current) => clearFitYByXField(current, "factor"))}
              />

              {helpMessage ? <div className="sp-fit-y-by-x-help">{helpMessage}</div> : null}
            </div>
          </div>

          {loadError ? <div className="sp-tabulate-inline-error">{loadError}</div> : null}
          {validationMessage ? <div className="sp-dialog-error" role="alert">{validationMessage}</div> : null}
        </div>

        <div className="sp-dialog-actions">
          <button
            type="button"
            className="sp-dialog-btn sp-dialog-btn-primary"
            onClick={handleCreate}
            disabled={createDisabled}
          >
            {mode === "edit"
              ? t("common.update", { defaultValue: "Update" })
              : t("fitYByX.create", { defaultValue: "Create" })}
          </button>
          <button type="button" className="sp-dialog-btn" onClick={onCancel}>
            {t("common.cancel", { defaultValue: "Cancel" })}
          </button>
        </div>
      </div>
    </div>
  );
}

function buildFitYByXFieldInfoList(
  columns: ReadonlyArray<readonly [string, string]>,
  displayProps: readonly ColumnDisplayProps[],
): FitYByXFieldInfo[] {
  const propsByIndex = new Map(displayProps.map((entry) => [entry.colIndex, entry]));
  return columns.map(([name, sqlType], index) => {
    return deriveFitYByXFieldInfo({
      colIndex: index,
      colName: name,
      colType: sqlType,
      role: "continuous",
      missingCount: 0,
    }, propsByIndex.get(index));
  });
}

export function deriveFitYByXFieldInfo(
  column: ColumnMeta,
  displayProps?: ColumnDisplayProps,
): FitYByXFieldInfo {
  const modelingRole = deriveModelingRole(column.colType, displayProps);
  return {
    name: column.colName,
    sqlType: column.colType,
    modelingRole: toModelingRoleLabel(modelingRole),
    field: {
      name: column.colName,
      type: modelingRole,
    },
  };
}

function deriveModelingRole(sqlType: string, displayProps?: ColumnDisplayProps): FieldRef["type"] {
  if (hasValueOrder(displayProps)) {
    return "ordinal";
  }
  const inferred = inferFieldType(sqlType);
  if (inferred === "continuous" || inferred === "datetime") {
    return inferred;
  }
  return "nominal";
}

function hasValueOrder(displayProps?: ColumnDisplayProps): boolean {
  const node = displayProps?.extras?.valueOrder as { values?: unknown } | undefined;
  return Array.isArray(node?.values) && node.values.length > 0;
}

function toModelingRoleLabel(role: FieldRef["type"]): FitYByXFieldInfo["modelingRole"] {
  if (role === "continuous") return "Continuous";
  if (role === "ordinal") return "Ordinal";
  if (role === "datetime") return "Datetime";
  return "Nominal";
}

function toRoleZoneItem(
  field: FieldRef | undefined,
  fieldsByName: ReadonlyMap<string, FitYByXFieldInfo>,
): FitYByXRoleZoneItem | null {
  if (!field) {
    return null;
  }
  const match = fieldsByName.get(field.name);
  return {
    name: field.name,
    hint: match ? `${match.sqlType} · ${match.modelingRole}` : field.type,
  };
}

function toFactorRoleZoneItem(
  field: FieldRef | undefined,
  fieldsByName: ReadonlyMap<string, FitYByXFieldInfo>,
  t: ReturnType<typeof useTranslation>["t"],
): FitYByXRoleZoneItem | null {
  const item = toRoleZoneItem(field, fieldsByName);
  if (!item || !field) {
    return item;
  }

  const personality = deriveFitYByXPersonality(field);
  const personalityLabel = t(`fitYByX.personality.${personality}`, {
    defaultValue: personality === "bivariate" ? "Bivariate" : "Oneway",
  });

  return {
    ...item,
    hint: `${item.hint} · ${personalityLabel}`,
  };
}

function validationErrorText(
  t: ReturnType<typeof useTranslation>["t"],
  error: FitYByXValidationError,
): string {
  switch (error) {
    case "duplicateRole":
      return t("fitYByX.duplicateRole", { defaultValue: "Response and factor must use different columns." });
    case "invalidFactor":
      return t("fitYByX.invalidFactor", { defaultValue: "Factor must be continuous, nominal, or ordinal." });
    case "invalidResponse":
      return t("fitYByX.invalidResponse", { defaultValue: "Response must be continuous." });
    case "missingFactor":
      return t("fitYByX.missingFactor", { defaultValue: "Choose a factor field." });
    case "missingResponse":
      return t("fitYByX.missingResponse", { defaultValue: "Choose a response field." });
  }
}

function createDialogState(
  defaultName: string,
  initialValue?: FitYByXAnalysisEditorItem,
) {
  if (!initialValue) return createFitYByXDialogState(defaultName);
  return {
    name: initialValue.name,
    response: structuredClone(initialValue.response),
    factor: structuredClone(initialValue.factor),
    validationError: null,
  };
}