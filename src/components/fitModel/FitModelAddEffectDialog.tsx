import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { FitModelTerm } from "@/types/fitModel";

import {
  addFitModelInteractionEffect,
  type FitModelAddEffectError,
} from "./fitModelAddEffect";

export interface FitModelAddEffectDialogProps {
  predictorNames: readonly string[];
  terms: readonly FitModelTerm[];
  onConfirm: (terms: FitModelTerm[]) => void;
  onCancel: () => void;
}

export function FitModelAddEffectDialog({
  predictorNames,
  terms,
  onConfirm,
  onCancel,
}: FitModelAddEffectDialogProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const instructionsId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const firstCheckboxRef = useRef<HTMLInputElement>(null);
  const [selectedNames, setSelectedNames] = useState<string[]>([]);
  const [error, setError] = useState<FitModelAddEffectError | null>(null);
  const preview = useMemo(
    () => [...selectedNames].sort((left, right) => left.localeCompare(right)).join("*"),
    [selectedNames],
  );

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    firstCheckboxRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
        "button:not([disabled]), input:not([disabled])",
      ) ?? []);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previouslyFocused?.focus();
    };
  }, [onCancel]);

  const togglePredictor = (predictorName: string, checked: boolean) => {
    setSelectedNames((current) => checked
      ? [...current, predictorName]
      : current.filter((candidate) => candidate !== predictorName));
    setError(null);
  };

  const handleConfirm = () => {
    const result = addFitModelInteractionEffect(terms, selectedNames);
    if (!result.ok) {
      setError(result.reason);
      return;
    }
    onConfirm(result.terms);
  };

  return (
    <div className="sp-dialog-overlay" role="presentation" onMouseDown={onCancel}>
      <div
        ref={dialogRef}
        className="sp-dialog sp-fit-model-add-effect-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={instructionsId}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="sp-dialog-header">
          <h2 id={titleId}>
            {t("fitModel.report.addEffect.title", { defaultValue: "Add Effect" })}
          </h2>
        </div>
        <div className="sp-dialog-body sp-fit-model-add-effect-body">
          <p id={instructionsId} className="sp-fit-model-add-effect-instructions">
            {t("fitModel.report.addEffect.instructions", {
              defaultValue: "Select two or more predictors to add one interaction effect.",
            })}
          </p>
          <div className="sp-fit-model-add-effect-grid">
            {predictorNames.map((predictorName, index) => (
              <label className="sp-fit-model-add-effect-option" key={predictorName}>
                <input
                  ref={index === 0 ? firstCheckboxRef : undefined}
                  type="checkbox"
                  checked={selectedNames.includes(predictorName)}
                  onChange={(event) => togglePredictor(predictorName, event.target.checked)}
                />
                <span>{predictorName}</span>
              </label>
            ))}
          </div>
          <p className="sp-fit-model-add-effect-preview">
            <strong>
              {t("fitModel.report.addEffect.preview", { defaultValue: "Effect preview" })}:
            </strong>{" "}
            {preview || t("fitModel.report.addEffect.previewEmpty", { defaultValue: "Select predictors" })}
          </p>
          {error ? (
            <p className="sp-fit-model-add-effect-error" role="alert">
              {t(`fitModel.report.addEffect.validation.${error}`)}
            </p>
          ) : null}
        </div>
        <div className="sp-dialog-actions">
          <button type="button" onClick={onCancel}>
            {t("fitModel.report.addEffect.cancel", { defaultValue: "Cancel" })}
          </button>
          <button type="button" onClick={handleConfirm}>
            {t("fitModel.report.addEffect.confirm", { defaultValue: "Add Effect" })}
          </button>
        </div>
      </div>
    </div>
  );
}
