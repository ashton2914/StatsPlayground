import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type {
  FitModelFittedResult,
  FitModelInferenceReason,
  FitModelSavedMetric,
} from "@/types/fitModel";

export const FIT_MODEL_SAVED_METRICS: FitModelSavedMetric[] = [
  "predicted",
  "residual",
  "studentizedResidual",
  "leverage",
  "cooksDistance",
  "meanConfidenceLower",
  "meanConfidenceUpper",
  "predictionLower",
  "predictionUpper",
];

export const DEFAULT_FIT_MODEL_SAVED_METRICS: FitModelSavedMetric[] =
  FIT_MODEL_SAVED_METRICS.slice(0, 5);

export function getFitModelSavedMetricAvailability(
  result: FitModelFittedResult,
): Record<FitModelSavedMetric, boolean> {
  const availableMetrics = new Set(result.availableSavedMetrics);
  return Object.fromEntries(
    FIT_MODEL_SAVED_METRICS.map((metric) => [metric, availableMetrics.has(metric)]),
  ) as Record<FitModelSavedMetric, boolean>;
}

export function getFitModelSavedMetricUnavailableReason(
  result: FitModelFittedResult,
  metric: FitModelSavedMetric,
): FitModelInferenceReason | null {
  if (result.availableSavedMetrics.includes(metric)) {
    return null;
  }

  return result.diagnostics.qqReason ?? "inferenceNotEstimable";
}

export interface FitModelSaveColumnsDialogProps {
  open: boolean;
  result: FitModelFittedResult;
  pending: boolean;
  error: string | null;
  onClose: () => void;
  onSave: (metrics: FitModelSavedMetric[]) => void | Promise<void>;
}

export function FitModelSaveColumnsDialog({
  open,
  result,
  pending,
  error,
  onClose,
  onSave,
}: FitModelSaveColumnsDialogProps) {
  const { t } = useTranslation();
  const availability = getFitModelSavedMetricAvailability(result);
  const [selected, setSelected] = useState<FitModelSavedMetric[]>([]);
  const firstAvailableMetric = FIT_MODEL_SAVED_METRICS.find((metric) => availability[metric]);
  const dialogRef = useRef<HTMLDivElement>(null);
  const firstMetricRef = useRef<HTMLInputElement>(null);
  const onCloseRef = useRef(onClose);
  const pendingRef = useRef(pending);
  onCloseRef.current = onClose;
  pendingRef.current = pending;

  useEffect(() => {
    if (!open) return;
    setSelected(DEFAULT_FIT_MODEL_SAVED_METRICS.filter((metric) => availability[metric]));
  }, [open, result]);

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    firstMetricRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Tab") {
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
        return;
      }
      if (event.key === "Escape" && !pendingRef.current) {
        event.preventDefault();
        onCloseRef.current();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previouslyFocused?.focus();
    };
  }, [open]);

  if (!open) return null;

  const toggleMetric = (metric: FitModelSavedMetric, checked: boolean) => {
    setSelected((current) => checked
      ? [...current, metric]
      : current.filter((candidate) => candidate !== metric));
  };

  return (
    <div className="sp-dialog-overlay" role="presentation">
      <div
        ref={dialogRef}
        className="sp-dialog sp-fit-model-save-columns-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="fit-model-save-columns-title"
        aria-describedby={error ? "fit-model-save-columns-error" : undefined}
      >
        <div className="sp-dialog-header">
          <h2 id="fit-model-save-columns-title">
            {t("fitModel.report.saveColumns.title", { defaultValue: "Save Columns" })}
          </h2>
        </div>
        <div className="sp-dialog-body sp-fit-model-save-columns-body">
          {FIT_MODEL_SAVED_METRICS.map((metric) => {
            const unavailableReason = getFitModelSavedMetricUnavailableReason(result, metric);
            return (
              <label
                className={`sp-fit-model-save-metric${availability[metric] ? "" : " is-disabled"}`}
                key={metric}
              >
                <input
                  ref={metric === firstAvailableMetric ? firstMetricRef : undefined}
                  type="checkbox"
                  checked={selected.includes(metric)}
                  disabled={pending || !availability[metric]}
                  onChange={(event) => toggleMetric(metric, event.target.checked)}
                />
                <span>{t(`fitModel.report.saveColumns.metric.${metric}`, { defaultValue: metric })}</span>
                {unavailableReason ? (
                  <span className="sp-fit-model-save-unavailable">
                    {t(`fitModel.report.reason.${unavailableReason}`, { defaultValue: unavailableReason })}
                  </span>
                ) : null}
              </label>
            );
          })}
          {error ? (
            <p id="fit-model-save-columns-error" className="sp-fit-model-save-error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
        <div className="sp-dialog-actions">
          <button type="button" onClick={onClose} disabled={pending}>
            {t("fitModel.report.saveColumns.cancel", { defaultValue: "Cancel" })}
          </button>
          <button
            type="button"
            onClick={() => void onSave(selected)}
            disabled={pending || selected.length === 0}
          >
            {pending
              ? t("fitModel.report.saveColumns.saving", { defaultValue: "Saving..." })
              : t("fitModel.report.saveColumns.save", { defaultValue: "Save" })}
          </button>
        </div>
      </div>
    </div>
  );
}
