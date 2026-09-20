import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { AnalysisButton } from "@/components/analysis/presentation/AnalysisButton";
import { AnalysisFrame } from "@/components/analysis/presentation/AnalysisFrame";
import { AnalysisStack } from "@/components/analysis/presentation/AnalysisStack";
import {
  AnalysisTable,
  type AnalysisTableColumn,
  type AnalysisTableRow,
} from "@/components/analysis/presentation/AnalysisTable";
import { buildEffectSummaryOption } from "@/graphCore/fitModelAdapter";

import { FitModelDiagnosticChart } from "./FitModelDiagnosticChart";
import {
  formatFitModelReportPValue,
  formatFitModelReportValue,
  type FitModelEffectRow,
} from "./fitModelReportModel";

export interface FitModelEffectSummaryProps {
  effects: readonly FitModelEffectRow[];
  onAddEffect?: () => void;
  onRemoveTerm: (termId: string) => void;
  onUndoRemove: (() => void) | null;
  undefinedValue?: string;
}

export function FitModelEffectSummary({
  effects,
  onAddEffect,
  onRemoveTerm,
  onUndoRemove,
  undefinedValue = "\u2014",
}: FitModelEffectSummaryProps) {
  const { t } = useTranslation();
  const title = t("fitModel.report.section.effectSummary", { defaultValue: "Effect Summary" });
  const option = useMemo(() => buildEffectSummaryOption({
    title,
    effects,
    labels: {
      logWorthAxisName: t("fitModel.report.chart.axis.logWorth", { defaultValue: "LogWorth" }),
      effectAxisName: t("fitModel.report.chart.axis.effect", { defaultValue: "Effect" }),
      effectSeriesName: t("fitModel.report.chart.series.logWorth", { defaultValue: "LogWorth" }),
      significanceReferenceName: t("fitModel.report.chart.reference.significance", { defaultValue: "p = 0.05" }),
      tooltipXLabel: t("fitModel.report.chart.tooltip.logWorth", { defaultValue: "LogWorth" }),
      tooltipYLabel: t("fitModel.report.chart.tooltip.effect", { defaultValue: "Effect" }),
    },
  }), [effects, t, title]);
  const columns: AnalysisTableColumn[] = [
    { key: "term", label: t("fitModel.report.column.term", { defaultValue: "Term" }) },
    { key: "pValue", label: t("fitModel.report.column.pValue", { defaultValue: "p-Value" }), numeric: true },
    { key: "logWorth", label: t("fitModel.report.column.logWorth", { defaultValue: "LogWorth" }), numeric: true },
  ];
  const rows: AnalysisTableRow[] = effects.map((effect) => ({
    key: effect.termId,
    cells: [
      effect.termLabel,
      formatFitModelReportPValue(effect.pValue, undefinedValue),
      formatFitModelReportValue(effect.logWorth, undefinedValue),
    ],
  }));

  return (
    <AnalysisFrame
      title={title}
      data-analysis-block="report"
      headerActions={(
        <AnalysisStack direction="horizontal">
          {onAddEffect ? (
            <AnalysisButton onClick={onAddEffect}>
              {t("fitModel.report.add", { defaultValue: "Add" })}
            </AnalysisButton>
          ) : null}
          {onUndoRemove ? (
            <AnalysisButton onClick={onUndoRemove}>
              {t("fitModel.report.undo", { defaultValue: "Undo" })}
            </AnalysisButton>
          ) : null}
        </AnalysisStack>
      )}
    >
      <AnalysisStack>
        <AnalysisTable
          title={t("fitModel.report.effects", { defaultValue: "Effects" })}
          ariaLabel={t("fitModel.report.effects", { defaultValue: "Effects" })}
          framed={false}
          width="wide"
          columns={columns}
          rows={rows}
          getRowActions={(effectRow) => [{
            key: "remove",
            label: t("fitModel.report.remove", { defaultValue: "Remove" }),
            tone: "danger",
            onInvoke: () => onRemoveTerm(effectRow.key),
          }]}
        />
        <div className="sp-fit-model-analysis-graph-effect-summary" data-graph-role="effectSummary">
          <FitModelDiagnosticChart
            title={title}
            chartKind="effectSummary"
            option={option}
          />
        </div>
      </AnalysisStack>
    </AnalysisFrame>
  );
}
