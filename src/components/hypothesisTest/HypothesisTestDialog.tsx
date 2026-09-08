import { useEffect, useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { HypothesisTestAnalysisEditorItem } from "@/components/analysis/adapters";
import { inferFieldType, type FieldRef } from "@/graphCore/types";
import { dataService } from "@/services/dataService";
import type { DatasetMeta } from "@/types/data";
import type {
  HypothesisTestAnalysisDefinition,
  HypothesisTestMethodId,
  HypothesisTestRoles,
} from "@/types/hypothesisTest";

import {
  compatibleHypothesisTestMethods,
  validateHypothesisTestDefinition,
} from "./hypothesisTestConfig";
import "./hypothesisTest.css";

interface HypothesisTestDialogProps {
  mode: "create" | "edit";
  dataset: DatasetMeta;
  defaultName: string;
  initialValue?: HypothesisTestAnalysisEditorItem;
  onCancel: () => void;
  onSubmit: (name: string, value: HypothesisTestAnalysisEditorItem) => void;
}

const METHOD_NAMES: Record<HypothesisTestMethodId, string> = {
  studentTwoSampleT: "Student two-sample t",
  welchTwoSampleT: "Welch two-sample t",
  mannWhitneyU: "Mann-Whitney U",
  oneWayAnova: "One-way ANOVA",
  welchAnova: "Welch ANOVA",
  kruskalWallis: "Kruskal-Wallis",
  pairedT: "Paired t",
  wilcoxonSignedRank: "Wilcoxon signed-rank",
  randomizedBlockAnova: "Randomized-block ANOVA",
  friedman: "Friedman",
};

function defaultDefinition(fields: FieldRef[]): HypothesisTestAnalysisDefinition | null {
  const response = fields.find((field) => field.type === "continuous");
  const condition = fields.find((field) => field.type === "nominal" || field.type === "ordinal");
  if (!response || !condition) return null;
  return {
    kind: "hypothesisTest",
    roles: { layout: "long", response, condition, subject: null },
    studyDesign: "independent",
    selectionMode: "automatic",
    manualSelection: null,
    alternative: "twoSided",
    alpha: 0.05,
    confidenceLevel: 0.95,
    levelOrder: [],
    referenceLevel: null,
    postHoc: "automatic",
    selectorVersion: "1",
  };
}

export function HypothesisTestDialog({
  mode,
  dataset,
  defaultName,
  initialValue,
  onCancel,
  onSubmit,
}: HypothesisTestDialogProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const [name, setName] = useState(defaultName);
  const [fields, setFields] = useState<FieldRef[]>([]);
  const [definition, setDefinition] = useState<HypothesisTestAnalysisDefinition | null>(
    initialValue ? structuredClone(initialValue.definition) : null,
  );
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    dataService.getColumns(dataset.id).then((columns) => {
      if (!active) return;
      const nextFields = columns.map(([fieldName, sqlType]) => ({
        name: fieldName,
        type: inferFieldType(sqlType),
      }));
      setFields(nextFields);
      setDefinition((current) => current ?? defaultDefinition(nextFields));
      setLoading(false);
    }).catch((error: unknown) => {
      if (!active) return;
      setLoadError(String(error));
      setLoading(false);
    });
    return () => { active = false; };
  }, [dataset.id]);

  const validation = useMemo(
    () => definition ? validateHypothesisTestDefinition(definition) : null,
    [definition],
  );
  const compatibility = useMemo(
    () => definition ? compatibleHypothesisTestMethods(definition) : [],
    [definition],
  );
  const setRoles = (roles: HypothesisTestRoles) => {
    setDefinition((current) => current ? { ...current, roles } : current);
  };
  const switchLayout = (layout: "long" | "wide") => {
    if (!definition || definition.roles.layout === layout) return;
    if (layout === "wide") {
      setRoles({
        layout: "wide",
        measurements: fields.filter((field) => field.type === "continuous").slice(0, 2),
        subject: null,
      });
      return;
    }
    const response = fields.find((field) => field.type === "continuous");
    const condition = fields.find((field) => field.type === "nominal" || field.type === "ordinal");
    if (response && condition) setRoles({ layout: "long", response, condition, subject: null });
  };
  const fieldByName = (fieldName: string) => fields.find((field) => field.name === fieldName);
  const categoricalFields = fields.filter((field) => field.type === "nominal" || field.type === "ordinal");
  const continuousFields = fields.filter((field) => field.type === "continuous");

  return (
    <div className="sp-dialog-overlay" onMouseDown={onCancel}>
      <div
        className="sp-dialog sp-dialog-wide sp-hypothesis-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="sp-dialog-title" id={titleId}>
          {t("hypothesisTest.title", { defaultValue: "Hypothesis Test" })}
        </div>
        <div className="sp-dialog-body sp-hypothesis-dialog-body">
          <label className="sp-dialog-field">
            <span className="sp-dialog-label">{t("hypothesisTest.analysisName", { defaultValue: "Analysis name" })}</span>
            <input className="sp-dialog-input" value={name} disabled={mode === "edit"} onChange={(event) => setName(event.target.value)} />
          </label>

          {loading ? <p>{t("workspace.loading", { defaultValue: "Loading..." })}</p> : null}
          {loadError ? <p role="alert">{loadError}</p> : null}
          {definition ? (
            <>
              <fieldset className="sp-hypothesis-group">
                <legend>{t("hypothesisTest.layout.label", { defaultValue: "Data layout" })}</legend>
                <div className="sp-hypothesis-segments">
                  {(["long", "wide"] as const).map((layout) => (
                    <button key={layout} type="button" aria-pressed={definition.roles.layout === layout} onClick={() => switchLayout(layout)}>
                      {t(`hypothesisTest.layout.${layout}`, { defaultValue: layout === "long" ? "Long" : "Wide" })}
                    </button>
                  ))}
                </div>
              </fieldset>

              <div className="sp-hypothesis-role-grid">
                {definition.roles.layout === "long" ? (
                  <>
                    <label>{t("hypothesisTest.response", { defaultValue: "Response" })}
                      <select value={definition.roles.response.name} onChange={(event) => {
                        const response = fieldByName(event.target.value);
                        if (response && definition.roles.layout === "long") setRoles({ ...definition.roles, response });
                      }}>{continuousFields.map((field) => <option key={field.name}>{field.name}</option>)}</select>
                    </label>
                    <label>{t("hypothesisTest.condition", { defaultValue: "Condition" })}
                      <select value={definition.roles.condition.name} onChange={(event) => {
                        const condition = fieldByName(event.target.value);
                        if (condition && definition.roles.layout === "long") setRoles({ ...definition.roles, condition });
                      }}>{categoricalFields.map((field) => <option key={field.name}>{field.name}</option>)}</select>
                    </label>
                  </>
                ) : (
                  <label>{t("hypothesisTest.measurements", { defaultValue: "Measurements" })}
                    <select multiple value={definition.roles.measurements.map((field) => field.name)} onChange={(event) => {
                      if (definition.roles.layout !== "wide") return;
                      const selected = new Set(Array.from(event.currentTarget.selectedOptions, (option) => option.value));
                      setRoles({ ...definition.roles, measurements: continuousFields.filter((field) => selected.has(field.name)) });
                    }}>{continuousFields.map((field) => <option key={field.name}>{field.name}</option>)}</select>
                  </label>
                )}
                <label>{t("hypothesisTest.subject", { defaultValue: "Subject / block ID" })}
                  <select value={definition.roles.subject?.name ?? ""} onChange={(event) => {
                    const subject = event.target.value ? fieldByName(event.target.value) ?? null : null;
                    setRoles({ ...definition.roles, subject } as HypothesisTestRoles);
                  }}>
                    <option value="">{t("common.none", { defaultValue: "None" })}</option>
                    {fields.map((field) => <option key={field.name}>{field.name}</option>)}
                  </select>
                </label>
              </div>

              <fieldset className="sp-hypothesis-group">
                <legend>{t("hypothesisTest.studyDesign.label", { defaultValue: "Study design" })}</legend>
                <div className="sp-hypothesis-segments">
                  {(["independent", "pairedOrBlocked"] as const).map((studyDesign) => (
                    <button key={studyDesign} type="button" aria-pressed={definition.studyDesign === studyDesign} onClick={() => setDefinition({ ...definition, studyDesign, manualSelection: null })}>
                      {studyDesign === "independent" ? "Independent" : "Paired or blocked"}
                    </button>
                  ))}
                </div>
              </fieldset>

              <fieldset className="sp-hypothesis-group">
                <legend>{t("hypothesisTest.selectionMode.label", { defaultValue: "Method selection" })}</legend>
                <div className="sp-hypothesis-segments">
                  {(["automatic", "guided", "manual"] as const).map((selectionMode) => (
                    <button key={selectionMode} type="button" aria-pressed={definition.selectionMode === selectionMode} onClick={() => setDefinition({ ...definition, selectionMode, manualSelection: null })}>
                      {selectionMode[0].toUpperCase() + selectionMode.slice(1)}
                    </button>
                  ))}
                </div>
              </fieldset>

              {definition.selectionMode !== "automatic" ? (
                <label className="sp-dialog-field">{t("hypothesisTest.method", { defaultValue: "Method" })}
                  <select value={definition.manualSelection?.methodId ?? ""} onChange={(event) => setDefinition({
                    ...definition,
                    manualSelection: event.target.value ? { methodId: event.target.value as HypothesisTestMethodId, reason: null } : null,
                  })}>
                    <option value="">{t("hypothesisTest.chooseMethod", { defaultValue: "Choose a method" })}</option>
                    {compatibility.map((entry) => (
                      <option key={entry.methodId} value={entry.methodId} disabled={!entry.compatible}>
                        {METHOD_NAMES[entry.methodId]}{entry.compatible ? "" : ` - ${entry.reasonCode}`}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}

              <div className="sp-hypothesis-options-grid">
                <label>Alpha<input type="number" min="0" max="1" step="0.01" value={definition.alpha} onChange={(event) => setDefinition({ ...definition, alpha: Number(event.target.value) })} /></label>
                <label>{t("distribution.confidenceLevel", { defaultValue: "Confidence level" })}<input type="number" min="0" max="1" step="0.01" value={definition.confidenceLevel} onChange={(event) => setDefinition({ ...definition, confidenceLevel: Number(event.target.value) })} /></label>
                <label>{t("hypothesisTest.alternative", { defaultValue: "Alternative" })}
                  <select value={definition.alternative} onChange={(event) => setDefinition({ ...definition, alternative: event.target.value as HypothesisTestAnalysisDefinition["alternative"] })}>
                    <option value="twoSided">Two-sided</option><option value="less">Less</option><option value="greater">Greater</option>
                  </select>
                </label>
                <label>{t("hypothesisTest.postHoc", { defaultValue: "Post-hoc" })}
                  <select value={definition.postHoc} onChange={(event) => setDefinition({ ...definition, postHoc: event.target.value as "automatic" | "off" })}>
                    <option value="automatic">Automatic</option><option value="off">Off</option>
                  </select>
                </label>
              </div>
              <label className="sp-dialog-field">{t("hypothesisTest.levelOrder", { defaultValue: "Level order (comma-separated)" })}
                <input className="sp-dialog-input" value={definition.levelOrder.join(", ")} onChange={(event) => setDefinition({
                  ...definition,
                  levelOrder: event.target.value.split(",").map((value) => value.trim()).filter(Boolean),
                  referenceLevel: null,
                })} />
              </label>
              {validation && !validation.ok ? <p className="sp-hypothesis-error" role="alert">{validation.code}</p> : null}
            </>
          ) : !loading ? <p role="alert">A continuous response and categorical condition are required.</p> : null}
        </div>
        <div className="sp-dialog-actions">
          <button type="button" onClick={onCancel}>{t("common.cancel", { defaultValue: "Cancel" })}</button>
          <button type="button" disabled={!definition || validation?.ok !== true || !name.trim()} onClick={() => {
            if (!definition || validation?.ok !== true) return;
            onSubmit(name.trim(), {
              definition: structuredClone(definition),
              presentation: initialValue?.presentation ?? {
                schemaVersion: 1,
                layout: "hypothesis-test-v1",
                activeResultTab: "results",
                collapsedSections: [],
                graphs: { showRawData: true, showIntervals: true, showDiagnostics: true },
                tableSort: null,
              },
            });
          }}>{mode === "create" ? t("common.create", { defaultValue: "Create" }) : t("common.apply", { defaultValue: "Apply" })}</button>
        </div>
      </div>
    </div>
  );
}