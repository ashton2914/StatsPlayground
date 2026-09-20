import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { AnalysisFrame } from "@/components/analysis/presentation/AnalysisFrame";
import { AnalysisGraph } from "@/components/analysis/presentation/AnalysisGraph";
import { AnalysisStack } from "@/components/analysis/presentation/AnalysisStack";
import { AnalysisText } from "@/components/analysis/presentation/AnalysisText";
import {
  buildFitModelLeverageOption,
  type FitModelLeverageChartLabels,
} from "@/graphCore/fitModelAdapter";
import type {
  FitModelEffectTest,
  FitModelLeveragePlot as FitModelLeveragePlotResult,
} from "@/types/fitModel";

import { FitModelDiagnosticChart } from "./FitModelDiagnosticChart";
import {
  reconcileLeverageTermId,
  selectDefaultLeverageTermId,
} from "./fitModelReportModel";

export interface FitModelLeveragePlotProps {
  effectTests: readonly FitModelEffectTest[];
  leveragePlots: readonly FitModelLeveragePlotResult[];
  responseLabel: string;
  chartLabels: FitModelLeverageChartLabels;
}

export function FitModelLeveragePlot({
  effectTests,
  leveragePlots,
  responseLabel,
  chartLabels,
}: FitModelLeveragePlotProps) {
  const { t } = useTranslation();
  const [selectedTermId, setSelectedTermId] = useState<string | null>(
    () => selectDefaultLeverageTermId(effectTests),
  );

  useEffect(() => {
    setSelectedTermId((current) => reconcileLeverageTermId(current, leveragePlots));
  }, [effectTests, leveragePlots]);

  const selectedPlot = leveragePlots.find((plot) => plot.termId === selectedTermId) ?? null;
  const title = t("fitModel.report.section.leveragePlot", { defaultValue: "Leverage Plot" });
  const option = useMemo(() => selectedPlot && !selectedPlot.reason
    ? buildFitModelLeverageOption({
        title: selectedPlot.termLabel,
        responseName: responseLabel,
        plot: selectedPlot,
        labels: chartLabels,
      })
    : null, [chartLabels, responseLabel, selectedPlot]);
  const selectedReason = selectedPlot?.reason;
  const reasonText = selectedReason
    ? t(`fitModel.report.reason.${selectedReason}`, { defaultValue: selectedReason })
    : t("fitModel.report.leverageUnavailable", { defaultValue: "No estimable effect is available." });

  return (
    <AnalysisFrame title={title} data-analysis-block="report">
      <AnalysisStack>
        <label className="sp-fit-model-leverage-selector">
          <span>{t("fitModel.report.effect", { defaultValue: "Effect" })}</span>
          <select
            aria-label={t("fitModel.report.effect", { defaultValue: "Effect" })}
            value={selectedTermId ?? ""}
            onChange={(event) => setSelectedTermId(event.currentTarget.value || null)}
          >
            {selectedTermId === null ? <option value="">{reasonText}</option> : null}
            {effectTests.map((effect) => (
              <option key={effect.termId} value={effect.termId}>{effect.termLabel}</option>
            ))}
          </select>
        </label>
        {option && selectedPlot ? (
          <AnalysisGraph
            title={selectedPlot.termLabel}
            graphRole="leveragePlot"
            frameClassName="sp-fit-model-analysis-graph-leverage"
            strategy={{
              mode: "custom",
              render: () => (
                <FitModelDiagnosticChart
                  title={`${title}: ${selectedPlot.termLabel}`}
                  chartKind="leveragePlot"
                  option={option}
                />
              ),
            }}
          />
        ) : (
          <AnalysisText>{reasonText}</AnalysisText>
        )}
      </AnalysisStack>
    </AnalysisFrame>
  );
}
