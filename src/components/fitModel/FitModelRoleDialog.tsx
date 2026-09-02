import { useEffect, useId, useMemo, useRef, useState, type DragEvent } from "react";
import { useTranslation } from "react-i18next";

import { fitModelParameterCount } from "@/components/fitModel/fitModelConfig";
import { MAX_FIT_MODEL_TERMS, countFactorialTerms } from "@/components/fitModel/fitModelConstruct";
import { dataService } from "@/services/dataService";
import type { ColumnDisplayProps, DatasetMeta } from "@/types/data";
import type { FitModelConstruct, FitModelTerm } from "@/types/fitModel";

import {
  beginFitModelFieldLoad,
  FIT_MODEL_DIALOG_FIELD_DRAG_MIME,
  canCreateFitModel,
  createAssignResponseAction,
  createFitModelSubmitCoordinator,
  createFitModelSubmitState,
  createFitModelDropAction,
  createFitModelDraft,
  createFitModelFieldLoadSnapshot,
  createToggleMainEffectAction,
  filterFitModelFields,
  hasFitModelDragType,
  readFitModelDragPayload,
  reduceFitModelDraft,
  resolveFitModelFieldLoadError,
  resolveFitModelFieldLoadSuccess,
  termsFromDraft,
  toFitModelFieldInfo,
  type FitModelCreateDefinition,
  type FitModelDialogMessage,
  type FitModelFieldInfo,
} from "./fitModelDialogState";

export interface FitModelRoleDialogProps {
  dataset: DatasetMeta;
  onCreateDefinition: (definition: FitModelCreateDefinition) => void | Promise<void>;
  onCancel: () => void;
}

export function FitModelRoleDialog({ dataset, onCreateDefinition, onCancel }: FitModelRoleDialogProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const validationId = `${titleId}-validation`;
  const [draft, setDraft] = useState(() => createFitModelDraft());
  const [loadSnapshot, setLoadSnapshot] = useState(() => createFitModelFieldLoadSnapshot());
  const [retryGeneration, setRetryGeneration] = useState(0);
  const [responseDragOver, setResponseDragOver] = useState(false);
  const [mainEffectsDragOver, setMainEffectsDragOver] = useState(false);
  const [search, setSearch] = useState("");
  const [termSearch, setTermSearch] = useState("");
  const [submitState, setSubmitState] = useState(() => createFitModelSubmitState());
  const mountedRef = useRef(true);
  const onCreateDefinitionRef = useRef(onCreateDefinition);
  const submitCoordinatorRef = useRef(createFitModelSubmitCoordinator((definition) => onCreateDefinitionRef.current(definition)));

  const fields = loadSnapshot.fields;
  const loading = loadSnapshot.loading;
  const loadError = loadSnapshot.error;

  useEffect(() => () => {
    mountedRef.current = false;
  }, []);

  useEffect(() => {
    onCreateDefinitionRef.current = onCreateDefinition;
  }, [onCreateDefinition]);

  useEffect(() => {
    setDraft(createFitModelDraft());
    setSubmitState(createFitModelSubmitState());
  }, [dataset.id]);

  useEffect(() => {
    let active = true;
    let generation = 0;
    setLoadSnapshot((current) => {
      const next = beginFitModelFieldLoad(current);
      generation = next.generation;
      return next;
    });

    Promise.all([
      dataService.getColumns(dataset.id),
      dataService.getColumnDisplayProps(dataset.id).catch(() => []),
    ])
      .then(([columns, displayProps]) => {
        if (!active) {
          return;
        }
        setLoadSnapshot((current) => resolveFitModelFieldLoadSuccess(
          current,
          generation,
          buildFitModelFieldInfoList(columns, displayProps),
        ));
      })
      .catch((reason: unknown) => {
        if (!active) {
          return;
        }
        setLoadSnapshot((current) => resolveFitModelFieldLoadError(current, generation, reason));
      });

    return () => {
      active = false;
    };
  }, [dataset.id, retryGeneration]);

  const visibleFields = useMemo(
    () => filterFitModelFields(fields, search),
    [fields, search],
  );

  const terms = useMemo(() => termsFromDraft(draft), [draft]);
  const parameterCount = useMemo(() => fitModelParameterCount(terms), [terms]);
  const validationText = useMemo(() => toValidationText(draft.validationMessage, t), [draft.validationMessage, t]);
  const predictorCount = draft.predictors.length;
  const projectedTermCount = useMemo(
    () => estimateConstructTermCount(draft.construct, predictorCount, terms.length),
    [draft.construct, predictorCount, terms.length],
  );
  const overTermLimit = projectedTermCount > MAX_FIT_MODEL_TERMS;
  const createDisabled = loading || submitState.creating || overTermLimit || !canCreateFitModel(draft);
  const createErrorText = submitState.createError
    ? t("fitModel.dialog.createError", {
      defaultValue: "Failed to create Fit Model: {{message}}",
      message: submitState.createError,
    })
    : null;

  const assignedMainNames = new Set(draft.predictors.map((field) => field.name));
  const fieldsByName = useMemo(
    () => new Map(fields.map((field) => [field.name, field])),
    [fields],
  );
  const visibleTerms = useMemo(() => filterTerms(terms, termSearch), [terms, termSearch]);

  const handleCreate = async () => {
    if (createDisabled || !draft.response) {
      return;
    }

    const definition: FitModelCreateDefinition = {
      response: { ...draft.response },
      construct: draft.construct,
      terms,
      centeringMethod: draft.centeringMethod,
    };

    const submitPromise = submitCoordinatorRef.current.submit(definition);
    setSubmitState(submitCoordinatorRef.current.getState());
    await submitPromise;
    if (mountedRef.current) {
      setSubmitState(submitCoordinatorRef.current.getState());
    }
  };

  const handleDropAssignment = (zone: "response" | "mainEffects", event: DragEvent<HTMLElement>) => {
    const payload = readFitModelDragPayload(event.dataTransfer);
    setResponseDragOver(false);
    setMainEffectsDragOver(false);
    if (!payload) {
      return;
    }

    const action = createFitModelDropAction(zone, payload, fieldsByName);
    if (!action) {
      return;
    }

    event.preventDefault();
    setDraft((current) => reduceFitModelDraft(current, action));
  };

  return (
    <div className="sp-dialog-overlay" onMouseDown={onCancel}>
      <div
        className="sp-dialog sp-dialog-wide sp-fit-model-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={validationText ? validationId : undefined}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="sp-dialog-title" id={titleId}>
          {t("fitModel.dialog.title", { defaultValue: "Fit Model" })}
        </div>

        <div className="sp-dialog-body sp-fit-model-dialog-body">
          <div className="sp-fit-model-dialog-grid">
            <section className="sp-tabulate-panel sp-fit-model-fields-panel" aria-label={t("fitModel.dialog.availableFields", { defaultValue: "Available fields" })}>
              <div className="sp-panel-header">
                <div className="sp-tabulate-heading-copy">
                  <span className="sp-panel-header-title">{t("fitModel.dialog.availableFields", { defaultValue: "Available fields" })}</span>
                  <span className="sp-tabulate-source-label" title={dataset.name}>
                    {t("workspace.datasourceLabel", { defaultValue: "Source: {{name}}", name: dataset.name })}
                  </span>
                </div>
              </div>

              <div className="sp-tabulate-field-toolbar">
                <label className="sp-tabulate-search" aria-label={t("fitModel.dialog.searchFields", { defaultValue: "Search fields" })}>
                  <i className="fa-solid fa-magnifying-glass" aria-hidden="true" />
                  <input
                    type="search"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder={t("fitModel.dialog.searchFields", { defaultValue: "Search fields" })}
                    aria-label={t("fitModel.dialog.searchAvailableFields", { defaultValue: "Search available fields" })}
                  />
                </label>
              </div>

              <div className="sp-cols-panel-list" role="list" aria-busy={loading}>
                {loading ? <div className="sp-tabulate-empty-note">{t("fitModel.dialog.loadingFields", { defaultValue: "Loading fields…" })}</div> : null}
                {!loading && visibleFields.length === 0 ? (
                  <div className="sp-tabulate-empty-note">
                    {fields.length === 0
                      ? t("fitModel.dialog.noFields", { defaultValue: "No fields available for this source." })
                      : t("fitModel.dialog.noMatch", { defaultValue: "No fields match the current search." })}
                  </div>
                ) : null}
                {!loading
                  ? visibleFields.map((field) => {
                      const assignedResponse = draft.response?.name === field.name;
                      const assignedMain = assignedMainNames.has(field.name);
                      const assigned = assignedResponse || assignedMain;
                      const continuous = field.field.type === "continuous";
                      return (
                        <div
                          key={field.name}
                          role="listitem"
                          tabIndex={0}
                          draggable
                          className={`sp-cols-panel-item sp-fit-model-field${assigned ? " sp-cols-panel-item-selected" : ""}`}
                          title={`${field.name} (${field.sqlType}, ${field.modelingRole})`}
                          onDragStart={(event) => {
                            event.dataTransfer.effectAllowed = "copyMove";
                            event.dataTransfer.setData(
                              FIT_MODEL_DIALOG_FIELD_DRAG_MIME,
                              JSON.stringify({ fieldName: field.name }),
                            );
                          }}
                          onKeyDown={(event) => {
                            const key = event.key.toLowerCase();
                            if (key === "y") {
                              event.preventDefault();
                              setDraft((current) => reduceFitModelDraft(current, createAssignResponseAction(field)));
                            } else if (key === "m") {
                              event.preventDefault();
                              setDraft((current) => reduceFitModelDraft(current, createToggleMainEffectAction(field)));
                            }
                          }}
                        >
                          <div className="sp-fit-model-field-copy">
                            <span className="sp-cols-panel-item-type">{field.sqlType}</span>
                            <span className="sp-cols-panel-item-name">{field.name}</span>
                            <span className="sp-cols-panel-item-extras">{field.modelingRole}</span>
                          </div>

                          <div className="sp-fit-model-field-actions">
                            <button
                              type="button"
                              className="sp-tabulate-inline-button"
                              onClick={() => setDraft((current) => reduceFitModelDraft(current, createAssignResponseAction(field)))}
                              disabled={!continuous}
                              aria-label={t("fitModel.dialog.assignResponseLabel", {
                                defaultValue: "Assign {{field}} as response",
                                field: field.name,
                              })}
                              title={t("fitModel.dialog.assignResponse", { defaultValue: "Assign as Y" })}
                            >
                              Y
                            </button>
                            <button
                              type="button"
                              className="sp-tabulate-inline-button"
                              onClick={() => setDraft((current) => reduceFitModelDraft(current, createToggleMainEffectAction(field)))}
                              disabled={!continuous}
                              aria-label={t("fitModel.dialog.assignMainLabel", {
                                defaultValue: "Toggle {{field}} as main effect",
                                field: field.name,
                              })}
                              title={t("fitModel.dialog.assignMain", { defaultValue: "Toggle Main" })}
                            >
                              M
                            </button>
                          </div>
                        </div>
                      );
                    })
                  : null}
              </div>
            </section>

            <div className="sp-fit-model-roles-column">
              <section
                className={`sp-tabulate-zone sp-fit-model-zone${responseDragOver ? " is-drop-target" : ""}`}
                aria-label={t("fitModel.dialog.response", { defaultValue: "Response" })}
                onDragOver={(event) => {
                  if (!hasFitModelDragType(event.dataTransfer.types)) {
                    return;
                  }
                  event.preventDefault();
                  setResponseDragOver(true);
                }}
                onDragLeave={() => setResponseDragOver(false)}
                onDrop={(event) => handleDropAssignment("response", event)}
              >
                <div className="sp-panel-header">
                  <span className="sp-panel-header-title">{t("fitModel.response", { defaultValue: "Y, Response" })}</span>
                  <span className="sp-tabulate-header-hint">{t("fitModel.dialog.continuousOnly", { defaultValue: "Continuous" })}</span>
                </div>
                <div className="sp-tabulate-zone-body" role="list">
                  {!draft.response ? (
                    <div className="sp-tabulate-empty-note">{t("fitModel.dialog.responseEmpty", { defaultValue: "Drop or assign one continuous response field." })}</div>
                  ) : (
                    <div role="listitem" className="sp-tabulate-zone-item">
                      <div className="sp-tabulate-zone-copy">
                        <span className="sp-tabulate-zone-label">{draft.response.name}</span>
                        <span className="sp-tabulate-zone-hint">{t("fitModel.dialog.responseHint", { defaultValue: "Continuous" })}</span>
                      </div>
                      <div className="sp-tabulate-zone-actions">
                        <button
                          type="button"
                          className="sp-tabulate-inline-button"
                          onClick={() => setDraft((current) => reduceFitModelDraft(current, { type: "clearResponse" }))}
                          aria-label={t("fitModel.dialog.clearResponse", {
                            defaultValue: "Clear response {{field}}",
                            field: draft.response.name,
                          })}
                        >
                          <i className="fa-solid fa-xmark" aria-hidden="true" />
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </section>

              <section
                className={`sp-tabulate-zone sp-fit-model-zone${mainEffectsDragOver ? " is-drop-target" : ""}`}
                aria-label={t("fitModel.dialog.mainEffects", { defaultValue: "Main Effects" })}
                onDragOver={(event) => {
                  if (!hasFitModelDragType(event.dataTransfer.types)) {
                    return;
                  }
                  event.preventDefault();
                  setMainEffectsDragOver(true);
                }}
                onDragLeave={() => setMainEffectsDragOver(false)}
                onDrop={(event) => handleDropAssignment("mainEffects", event)}
              >
                <div className="sp-panel-header">
                  <span className="sp-panel-header-title">{t("fitModel.dialog.mainEffects", { defaultValue: "Main Effects" })}</span>
                  <span className="sp-tabulate-header-hint">{t("fitModel.dialog.continuousOnly", { defaultValue: "Continuous" })}</span>
                </div>
                <div className="sp-tabulate-zone-body" role="list">
                  {draft.predictors.length === 0 ? (
                    <div className="sp-tabulate-empty-note">{t("fitModel.dialog.mainEffectsEmpty", { defaultValue: "Select one or more continuous predictors." })}</div>
                  ) : draft.predictors.map((field) => (
                    <div key={field.name} role="listitem" className="sp-tabulate-zone-item">
                      <div className="sp-tabulate-zone-copy">
                        <span className="sp-tabulate-zone-label">{field.name}</span>
                      </div>
                      <div className="sp-tabulate-zone-actions">
                        <button
                          type="button"
                          className="sp-tabulate-inline-button"
                          onClick={() => setDraft((current) => reduceFitModelDraft(current, createToggleMainEffectAction(
                            fieldsByName.get(field.name) ?? {
                              name: field.name,
                              sqlType: "",
                              modelingRole: "Continuous",
                              field,
                            },
                          )))}
                          aria-label={t("fitModel.dialog.removeMainEffect", {
                            defaultValue: "Remove main effect {{field}}",
                            field: field.name,
                          })}
                        >
                          <i className="fa-solid fa-xmark" aria-hidden="true" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </section>

              <section className="sp-tabulate-zone sp-fit-model-zone" aria-label={t("fitModel.dialog.construct", { defaultValue: "Construct" })}>
                <div className="sp-panel-header">
                  <span className="sp-panel-header-title">{t("fitModel.dialog.construct", { defaultValue: "Construct" })}</span>
                  <span className="sp-tabulate-header-hint">
                    {t("fitModel.dialog.termCount", {
                      defaultValue: "{{count}} / 256 terms",
                      count: terms.length,
                    })}
                  </span>
                </div>

                <div className="sp-fit-model-construct-segmented" role="group" aria-label={t("fitModel.dialog.construct", { defaultValue: "Construct" })}>
                  <button
                    type="button"
                    className={`sp-dialog-btn${draft.construct.kind === "fullFactorial" ? " sp-dialog-btn-primary" : ""}`}
                    onClick={() => setDraft((current) => reduceFitModelDraft(current, {
                      type: "setConstruct",
                      construct: { kind: "fullFactorial" },
                    }))}
                  >
                    {t("fitModel.dialog.constructFullFactorial", { defaultValue: "Full Factorial" })}
                  </button>
                  <button
                    type="button"
                    className={`sp-dialog-btn${draft.construct.kind === "factorialToDegree" ? " sp-dialog-btn-primary" : ""}`}
                    onClick={() => setDraft((current) => reduceFitModelDraft(current, {
                      type: "setConstruct",
                      construct: { kind: "factorialToDegree", degree: 2 },
                    }))}
                  >
                    {t("fitModel.dialog.constructFactorial", { defaultValue: "Factorial to Degree" })}
                  </button>
                  <button
                    type="button"
                    className={`sp-dialog-btn${draft.construct.kind === "responseSurface" ? " sp-dialog-btn-primary" : ""}`}
                    onClick={() => setDraft((current) => reduceFitModelDraft(current, {
                      type: "setConstruct",
                      construct: { kind: "responseSurface" },
                    }))}
                  >
                    {t("fitModel.dialog.constructResponseSurface", { defaultValue: "Response Surface" })}
                  </button>
                </div>

                {draft.construct.kind === "factorialToDegree" ? (
                  <div className="sp-fit-model-degree-input-row">
                    <label className="sp-fit-model-degree-input-label" htmlFor={`${titleId}-construct-degree`}>
                      {t("fitModel.dialog.degreeInputLabel", { defaultValue: "Degree" })}
                    </label>
                    <input
                      id={`${titleId}-construct-degree`}
                      type="number"
                      min={1}
                      max={Math.max(1, predictorCount)}
                      step={1}
                      value={draft.construct.degree}
                      onChange={(event) => {
                        const nextDegree = Number.parseInt(event.target.value, 10);
                        if (!Number.isFinite(nextDegree)) {
                          return;
                        }
                        setDraft((current) => reduceFitModelDraft(current, {
                          type: "setConstruct",
                          construct: { kind: "factorialToDegree", degree: nextDegree },
                        }));
                      }}
                    />
                  </div>
                ) : null}

                {overTermLimit ? (
                  <div className="sp-tabulate-inline-error" role="alert">
                    {t("fitModel.dialog.tooManyTermsFormula", {
                      defaultValue: "Construct has {{count}} terms, exceeding 256. {{formula}}",
                      count: projectedTermCount,
                      formula: describeConstructFormula(draft.construct, predictorCount),
                    })}
                  </div>
                ) : null}

                <div className="sp-fit-model-macro-actions">
                  <label className="sp-fit-model-centering-toggle">
                    <input
                      type="checkbox"
                      checked={draft.centeringMethod === "mean"}
                      disabled={!terms.some((term) => term.kind === "interaction")}
                      onChange={(event) => setDraft((current) => reduceFitModelDraft(current, {
                        type: "setCenteringMethod",
                        centeringMethod: event.target.checked ? "mean" : "none",
                      }))}
                    />
                    {t("fitModel.dialog.centerInteractions", { defaultValue: "Center Interactions" })}
                  </label>
                </div>
              </section>

              <section className="sp-tabulate-zone sp-fit-model-zone" aria-label={t("fitModel.dialog.currentTerms", { defaultValue: "Current Model Terms" })}>
                <div className="sp-panel-header">
                  <span className="sp-panel-header-title">{t("fitModel.dialog.currentTerms", { defaultValue: "Current Model Terms" })}</span>
                  <span className="sp-tabulate-header-hint">
                    {t("fitModel.dialog.parameterCount", {
                      defaultValue: "Parameters: {{count}}",
                      count: parameterCount,
                    })}
                  </span>
                </div>

                <div className="sp-tabulate-field-toolbar">
                  <label className="sp-tabulate-search" aria-label={t("fitModel.dialog.searchTerms", { defaultValue: "Search terms" })}>
                    <i className="fa-solid fa-magnifying-glass" aria-hidden="true" />
                    <input
                      type="search"
                      value={termSearch}
                      onChange={(event) => setTermSearch(event.target.value)}
                      placeholder={t("fitModel.dialog.searchTerms", { defaultValue: "Search terms" })}
                      aria-label={t("fitModel.dialog.searchTerms", { defaultValue: "Search terms" })}
                    />
                  </label>
                </div>

                <div className="sp-tabulate-zone-body" role="list">
                  {terms.length === 0 ? (
                    <div className="sp-tabulate-empty-note">{t("fitModel.dialog.termsEmpty", { defaultValue: "No model terms selected." })}</div>
                  ) : visibleTerms.length === 0 ? (
                    <div className="sp-tabulate-empty-note">{t("fitModel.dialog.noTermMatch", { defaultValue: "No terms match the current search." })}</div>
                  ) : visibleTerms.map((term) => {
                    const termLabel = labelForTerm(term);
                    return (
                      <div key={`${term.kind}:${termLabel}`} role="listitem" className="sp-tabulate-zone-item">
                        <div className="sp-tabulate-zone-copy">
                          <span className="sp-tabulate-zone-label">{termLabel}</span>
                          <span className="sp-tabulate-zone-hint">
                            {term.kind === "main"
                              ? t("fitModel.dialog.termKindMain", { defaultValue: "Main" })
                              : term.kind === "power"
                                ? t("fitModel.dialog.termKindPower", { defaultValue: "Power" })
                                : t("fitModel.dialog.termKindInteraction", { defaultValue: "Interaction" })}
                          </span>
                        </div>
                        <div className="sp-tabulate-zone-actions">
                          <button
                            type="button"
                            className="sp-tabulate-inline-button"
                            onClick={() => setDraft((current) => reduceFitModelDraft(current, {
                              type: "removeTerm",
                              term,
                            }))}
                            aria-label={t("fitModel.dialog.removeTerm", {
                              defaultValue: "Remove term {{term}}",
                              term: termLabel,
                            })}
                          >
                            <i className="fa-solid fa-xmark" aria-hidden="true" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            </div>
          </div>

          {loadError ? (
            <div className="sp-tabulate-inline-error" role="alert">
              <span>{loadError}</span>
              <button
                type="button"
                className="sp-tabulate-inline-button"
                onClick={() => setRetryGeneration((current) => current + 1)}
              >
                {t("common.retry", { defaultValue: "Retry" })}
              </button>
            </div>
          ) : null}
          {createErrorText ? <div className="sp-dialog-error" role="alert">{createErrorText}</div> : null}
          {validationText ? <div id={validationId} className="sp-dialog-error" role="alert">{validationText}</div> : null}
        </div>

        <div className="sp-dialog-actions">
          <button
            type="button"
            className="sp-dialog-btn sp-dialog-btn-primary"
            onClick={handleCreate}
            disabled={createDisabled}
          >
            {t("fitModel.dialog.create", { defaultValue: "Create" })}
          </button>
          <button type="button" className="sp-dialog-btn" onClick={onCancel}>
            {t("common.cancel", { defaultValue: "Cancel" })}
          </button>
        </div>
      </div>
    </div>
  );
}

function buildFitModelFieldInfoList(
  columns: ReadonlyArray<readonly [string, string]>,
  displayProps: readonly ColumnDisplayProps[],
): FitModelFieldInfo[] {
  const propsByIndex = new Map(displayProps.map((entry) => [entry.colIndex, entry]));
  return columns.map(([name, sqlType], index) => toFitModelFieldInfo(name, sqlType, propsByIndex.get(index)));
}

function toValidationText(
  message: FitModelDialogMessage | null,
  t: ReturnType<typeof useTranslation>["t"],
): string | null {
  if (!message) {
    return null;
  }

  if (message.code === "responseCollision") {
    return t("fitModel.dialog.validation.responseCollision", {
      defaultValue: "Response column cannot also be a model term.",
    });
  }

  if (message.code === "mainRequiredByInteraction") {
    return t("fitModel.dialog.validation.mainRequiredByInteraction", {
      defaultValue: "Remove interactions first: {{terms}}",
      terms: (message.interactionLabels ?? []).join(", "),
    });
  }

  if (message.code === "lastMainEffect") {
    return t("fitModel.dialog.validation.lastMainEffect", {
      defaultValue: "Model requires at least one main effect.",
    });
  }

  if (message.code === "nonContinuousField") {
    return t("fitModel.dialog.validation.nonContinuousField", {
      defaultValue: "Only continuous fields are available for response and model terms.",
    });
  }

  if (message.code === "tooManyTerms") {
    return t("fitModel.dialog.validation.tooManyTerms", {
      defaultValue: "Model has too many terms (max 256).",
      detail: message.detail ?? "",
    });
  }

  return t("fitModel.dialog.validation.invalidInteraction", {
    defaultValue: "Interaction must reference two different selected main effects.",
  });
}

function labelForTerm(term: FitModelTerm): string {
  if (term.kind === "main") {
    return term.columnNames[0];
  }
  if (term.kind === "power") {
    return `${term.columnNames[0]}^2`;
  }
  return term.columnNames.join("*");
}

function filterTerms(terms: readonly FitModelTerm[], query: string): FitModelTerm[] {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return [...terms];
  }
  return terms.filter((term) => {
    const label = labelForTerm(term).toLowerCase();
    return label.includes(needle) || term.kind.toLowerCase().includes(needle);
  });
}

function estimateConstructTermCount(construct: FitModelConstruct, predictorCount: number, manualCount: number): number {
  const p = Math.max(0, predictorCount);
  if (construct.kind === "manual") {
    return manualCount;
  }
  if (construct.kind === "responseSurface") {
    return (2 * p) + ((p * (p - 1)) / 2);
  }
  if (construct.kind === "fullFactorial") {
    return countFactorialTerms(p, p);
  }
  return countFactorialTerms(p, Math.min(p, Math.max(1, Math.trunc(construct.degree))));
}

function describeConstructFormula(construct: FitModelConstruct, predictorCount: number): string {
  const p = Math.max(0, predictorCount);
  if (construct.kind === "responseSurface") {
    return `2*${p} + C(${p},2)`;
  }
  if (construct.kind === "fullFactorial") {
    return `sum C(${p},k), k=1..${p}`;
  }
  if (construct.kind === "factorialToDegree") {
    const degree = Math.min(p, Math.max(1, Math.trunc(construct.degree)));
    return `sum C(${p},k), k=1..${degree}`;
  }
  return `${p}`;
}
