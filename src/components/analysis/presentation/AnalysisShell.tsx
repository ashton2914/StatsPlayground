import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

export interface AnalysisSummaryEntry {
  key: string;
  label: ReactNode;
  value: ReactNode;
}

export interface AnalysisShellProps {
  title: ReactNode;
  sourceName: ReactNode;
  summary: AnalysisSummaryEntry[];
  canEditInputs: boolean;
  onEditInputs?: () => void;
  children: ReactNode;
}

export function AnalysisShell({
  title,
  sourceName,
  summary,
  canEditInputs,
  onEditInputs,
  children,
}: AnalysisShellProps) {
  const { t } = useTranslation();

  return (
    <div className="analysis-shell">
      <aside className="analysis-shell-info">
        <div className="analysis-shell-titlebar">{title}</div>
        <div className="analysis-shell-info-body">
          <div className="analysis-shell-source">
            <span>{t("workspace.datasourceLabel", { defaultValue: "Source: {{name}}", name: sourceName })}</span>
          </div>
          <dl className="analysis-shell-summary">
            {summary.map((entry) => (
              <div className="analysis-shell-summary-row" key={entry.key}>
                <dt>{entry.label}</dt>
                <dd>{entry.value}</dd>
              </div>
            ))}
          </dl>
          <button
            className="analysis-shell-edit-inputs"
            disabled={!canEditInputs}
            type="button"
            onClick={onEditInputs}
          >
            <i aria-hidden="true" className="fa-solid fa-sliders" />
            <span>{t("workspace.editInputs", { defaultValue: "Edit Inputs" })}</span>
          </button>
        </div>
      </aside>
      <main className="analysis-shell-results">{children}</main>
    </div>
  );
}