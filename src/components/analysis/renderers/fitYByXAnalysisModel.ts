import type { AnalysisTableColumn, AnalysisTableRow } from "@/components/analysis/presentation/AnalysisTable";
import type { AnalysisExecutionState } from "@/components/analysis/useAnalysisExecution";
import type { FitYByXAnalysisDocument } from "@/types/analysis";
import type {
  FitYByXAnovaRow,
  FitYByXBivariateResult,
  FitYByXEstimateRow,
  FitYByXNotComputableResult,
  FitYByXOnewayGroupSummary,
  FitYByXOnewayResult,
} from "@/types/fitYByX";

export type FitYByXAnalysisTranslate = (
  key: string,
  values?: Record<string, string | number | null | undefined>,
) => string;

export interface FitYByXAnalysisReportSectionModel {
  key: string;
  title: string;
  columns: AnalysisTableColumn[];
  rows: AnalysisTableRow[];
  width?: "compact" | "standard" | "wide";
}

export interface FitYByXAnalysisReportModel {
  alert?: boolean;
  summary: {
    personality: string;
    usedRows: string;
    excludedRows: string;
  };
  sections: FitYByXAnalysisReportSectionModel[];
}

const UNDEFINED_VALUE = "—";

function translateOrFallback(
  translate: FitYByXAnalysisTranslate,
  key: string,
  fallback: string,
): string {
  const value = translate(key);
  return value === key ? fallback : value;
}

export function formatFitYByXAnalysisValue(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return UNDEFINED_VALUE;
  if (value === 0) return "0";
  return Number.parseFloat(value.toPrecision(6)).toString();
}

export function formatFitYByXAnalysisPValue(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return UNDEFINED_VALUE;
  if (value > 0 && value < 0.0001) return "<0.0001";
  return value.toFixed(4);
}

function formatCount(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : UNDEFINED_VALUE;
}

function column(key: string, label: string, numeric = false, rowHeader = false): AnalysisTableColumn {
  return { key, label, numeric, rowHeader };
}

function label(
  translate: FitYByXAnalysisTranslate,
  scope: "source" | "term",
  value: string,
): string {
  return translateOrFallback(translate, `fitYByX.report.${scope}.${value}`, value);
}

function statusSection(
  key: string,
  message: string,
  translate: FitYByXAnalysisTranslate,
): FitYByXAnalysisReportSectionModel {
  return {
    key,
    title: translateOrFallback(translate, "fitYByX.report.section.status", "Status"),
    columns: [
      column("metric", translateOrFallback(translate, "fitYByX.report.column.metric", "Metric"), false, true),
      column("value", translateOrFallback(translate, "fitYByX.report.column.value", "Value")),
    ],
    rows: [{ key, cells: [translateOrFallback(translate, "fitYByX.report.column.metric", "Metric"), message] }],
    width: "compact",
  };
}

function labeledValueSection(
  key: string,
  title: string,
  rows: Array<{ key: string; label: string; value: string; numeric?: boolean }>,
  translate: FitYByXAnalysisTranslate,
): FitYByXAnalysisReportSectionModel {
  return {
    key,
    title,
    columns: [
      column("metric", translateOrFallback(translate, "fitYByX.report.column.metric", "Metric"), false, true),
      column("value", translateOrFallback(translate, "fitYByX.report.column.value", "Value"), rows.some((row) => row.numeric)),
    ],
    rows: rows.map((row) => ({ key: row.key, cells: [row.label, row.value] })),
    width: "compact",
  };
}

function anovaSection(
  key: string,
  title: string,
  rows: FitYByXAnovaRow[],
  translate: FitYByXAnalysisTranslate,
): FitYByXAnalysisReportSectionModel {
  return {
    key,
    title,
    columns: [
      column("source", translateOrFallback(translate, "fitYByX.report.column.source", "Source"), false, true),
      column("degreesOfFreedom", translateOrFallback(translate, "fitYByX.report.column.degreesOfFreedom", "DF"), true),
      column("sumOfSquares", translateOrFallback(translate, "fitYByX.report.column.sumOfSquares", "Sum of Squares"), true),
      column("meanSquare", translateOrFallback(translate, "fitYByX.report.column.meanSquare", "Mean Square"), true),
      column("fRatio", translateOrFallback(translate, "fitYByX.report.column.fRatio", "F Ratio"), true),
      column("pValue", translateOrFallback(translate, "fitYByX.report.column.pValue", "Prob > F"), true),
    ],
    rows: rows.map((row) => ({
      key: `${key}:${row.source}`,
      cells: [
        label(translate, "source", row.source),
        formatCount(row.degreesOfFreedom),
        formatFitYByXAnalysisValue(row.sumOfSquares),
        formatFitYByXAnalysisValue(row.meanSquare),
        formatFitYByXAnalysisValue(row.fRatio),
        formatFitYByXAnalysisPValue(row.pValue),
      ],
    })),
    width: "wide",
  };
}

function fittedEquation(
  document: FitYByXAnalysisDocument,
  result: FitYByXBivariateResult,
  translate: FitYByXAnalysisTranslate,
): string {
  const equation = translate("fitYByX.report.summaryOfFit.equationTemplate", {
    response: document.definition.response.name,
    intercept: formatFitYByXAnalysisValue(result.intercept),
    slope: formatFitYByXAnalysisValue(result.slope),
    factor: document.definition.factor.name,
  });
  return equation.replace(/\+\s+-/g, "- ");
}

function summaryOfFitSection(
  document: FitYByXAnalysisDocument,
  result: FitYByXBivariateResult,
  translate: FitYByXAnalysisTranslate,
): FitYByXAnalysisReportSectionModel {
  return labeledValueSection(
    "summaryOfFit",
    translateOrFallback(translate, "fitYByX.report.section.summaryOfFit", "Summary of Fit"),
    [
      { key: "fittedEquation", label: translateOrFallback(translate, "fitYByX.report.summaryOfFit.fittedEquation", "Fitted Equation"), value: fittedEquation(document, result, translate) },
      { key: "rSquared", label: translateOrFallback(translate, "fitYByX.report.summaryOfFit.rSquared", "RSquare"), value: formatFitYByXAnalysisValue(result.summaryOfFit.rSquared), numeric: true },
      { key: "adjustedRSquared", label: translateOrFallback(translate, "fitYByX.report.summaryOfFit.adjustedRSquared", "RSquare Adj"), value: formatFitYByXAnalysisValue(result.summaryOfFit.adjustedRSquared), numeric: true },
      { key: "rootMeanSquareError", label: translateOrFallback(translate, "fitYByX.report.summaryOfFit.rootMeanSquareError", "Root Mean Square Error"), value: formatFitYByXAnalysisValue(result.summaryOfFit.rootMeanSquareError), numeric: true },
      { key: "meanOfResponse", label: translateOrFallback(translate, "fitYByX.report.summaryOfFit.meanOfResponse", "Mean of Response"), value: formatFitYByXAnalysisValue(result.summaryOfFit.meanOfResponse), numeric: true },
      { key: "observationCount", label: translateOrFallback(translate, "fitYByX.report.summaryOfFit.observationCount", "Observations"), value: formatCount(result.summaryOfFit.observationCount), numeric: true },
    ],
    translate,
  );
}

function lackOfFitSection(
  result: FitYByXBivariateResult,
  translate: FitYByXAnalysisTranslate,
): FitYByXAnalysisReportSectionModel {
  const title = translateOrFallback(translate, "fitYByX.report.section.lackOfFit", "Lack of Fit");
  if (result.lackOfFit.state === "available") {
    return anovaSection("lackOfFit", title, result.lackOfFit.rows, translate);
  }
  return {
    ...statusSection(
      "lackOfFit",
      translateOrFallback(translate, "fitYByX.report.lackOfFit.notIdentifiable", "Lack of fit is not identifiable."),
      translate,
    ),
    title,
  };
}

function parameterEstimatesSection(
  rows: FitYByXEstimateRow[],
  translate: FitYByXAnalysisTranslate,
): FitYByXAnalysisReportSectionModel {
  return {
    key: "parameterEstimates",
    title: translateOrFallback(translate, "fitYByX.report.section.parameterEstimates", "Parameter Estimates"),
    columns: [
      column("term", translateOrFallback(translate, "fitYByX.report.column.term", "Term"), false, true),
      column("estimate", translateOrFallback(translate, "fitYByX.report.column.estimate", "Estimate"), true),
      column("standardError", translateOrFallback(translate, "fitYByX.report.column.standardError", "Std Error"), true),
      column("tRatio", translateOrFallback(translate, "fitYByX.report.column.tRatio", "t Ratio"), true),
      column("pValue", translateOrFallback(translate, "fitYByX.report.column.pValue", "Prob > |t|"), true),
      column("lowerConfidenceLimit", translateOrFallback(translate, "fitYByX.report.column.lowerConfidenceLimit", "Lower 95%"), true),
      column("upperConfidenceLimit", translateOrFallback(translate, "fitYByX.report.column.upperConfidenceLimit", "Upper 95%"), true),
    ],
    rows: rows.map((row) => ({
      key: `estimate:${row.term}`,
      cells: [
        label(translate, "term", row.term),
        formatFitYByXAnalysisValue(row.estimate),
        formatFitYByXAnalysisValue(row.standardError),
        formatFitYByXAnalysisValue(row.tRatio),
        formatFitYByXAnalysisPValue(row.pValue),
        formatFitYByXAnalysisValue(row.lowerConfidenceLimit),
        formatFitYByXAnalysisValue(row.upperConfidenceLimit),
      ],
    })),
    width: "wide",
  };
}

function groupSummarySection(
  rows: FitYByXOnewayGroupSummary[],
  translate: FitYByXAnalysisTranslate,
): FitYByXAnalysisReportSectionModel {
  return {
    key: "groupSummary",
    title: translateOrFallback(translate, "fitYByX.report.section.groupSummary", "Group Summary"),
    columns: [
      column("group", translateOrFallback(translate, "fitYByX.report.column.group", "Group"), false, true),
      column("count", translateOrFallback(translate, "fitYByX.report.column.count", "Count"), true),
      column("mean", translateOrFallback(translate, "fitYByX.report.column.mean", "Mean"), true),
      column("standardDeviation", translateOrFallback(translate, "fitYByX.report.column.standardDeviation", "Std Dev"), true),
      column("standardError", translateOrFallback(translate, "fitYByX.report.column.standardError", "Std Error"), true),
      column("lowerConfidenceLimit", translateOrFallback(translate, "fitYByX.report.column.lowerConfidenceLimit", "Lower 95%"), true),
      column("upperConfidenceLimit", translateOrFallback(translate, "fitYByX.report.column.upperConfidenceLimit", "Upper 95%"), true),
    ],
    rows: rows.map((row) => ({
      key: `group:${row.group}`,
      cells: [
        row.group,
        formatCount(row.count),
        formatFitYByXAnalysisValue(row.mean),
        formatFitYByXAnalysisValue(row.standardDeviation),
        formatFitYByXAnalysisValue(row.standardError),
        formatFitYByXAnalysisValue(row.lowerConfidenceLimit),
        formatFitYByXAnalysisValue(row.upperConfidenceLimit),
      ],
    })),
    width: "wide",
  };
}

function effectSizeSection(
  result: FitYByXOnewayResult,
  translate: FitYByXAnalysisTranslate,
): FitYByXAnalysisReportSectionModel {
  return labeledValueSection(
    "effectSize",
    translateOrFallback(translate, "fitYByX.report.section.effectSize", "Effect Size"),
    [
      { key: "etaSquared", label: translateOrFallback(translate, "fitYByX.report.effectSize.etaSquared", "Eta Squared"), value: formatFitYByXAnalysisValue(result.effectSizes.etaSquared), numeric: true },
      { key: "omegaSquared", label: translateOrFallback(translate, "fitYByX.report.effectSize.omegaSquared", "Omega Squared"), value: formatFitYByXAnalysisValue(result.effectSizes.omegaSquared), numeric: true },
    ],
    translate,
  );
}

function notComputableSection(
  result: FitYByXNotComputableResult,
  translate: FitYByXAnalysisTranslate,
): FitYByXAnalysisReportSectionModel {
  return labeledValueSection(
    "notComputable",
    translateOrFallback(translate, "fitYByX.report.notComputable", "Not Computable"),
    [
      { key: "reason", label: translateOrFallback(translate, "fitYByX.report.reasonLabel", "Reason"), value: translate(`fitYByX.report.reason.${result.reason}`) },
      { key: "usedRows", label: translateOrFallback(translate, "fitYByX.report.usedRows", "Used Rows"), value: formatCount(result.usedRows), numeric: true },
      { key: "excludedRows", label: translateOrFallback(translate, "fitYByX.report.excludedRows", "Excluded Rows"), value: formatCount(result.excludedRows), numeric: true },
    ],
    translate,
  );
}

export function createFitYByXAnalysisReportModel(input: {
  document: FitYByXAnalysisDocument;
  state: AnalysisExecutionState;
  datasetMissing: boolean;
  translate: FitYByXAnalysisTranslate;
}): FitYByXAnalysisReportModel {
  const { document, state, datasetMissing, translate } = input;
  const summary = {
    personality: translate(`fitYByX.personality.${document.definition.personality}`),
    usedRows: UNDEFINED_VALUE,
    excludedRows: UNDEFINED_VALUE,
  };

  if (datasetMissing) {
    return { summary, sections: [statusSection("sourceMissing", translate("fitYByX.sourceMissing"), translate)] };
  }
  if (state.status === "idle" || state.status === "loading") {
    return { summary, sections: [statusSection("loading", translate("fitYByX.report.loading"), translate)] };
  }
  if (state.status === "error") {
    return {
      alert: true,
      summary,
      sections: [statusSection("error", `${translate("fitYByX.report.error")}: ${state.error}`, translate)],
    };
  }
  if (state.analysisKind !== "fitYByX") {
    return { summary, sections: [statusSection("error", translate("fitYByX.report.error"), translate)] };
  }

  const result = state.result.result;
  const resultSummary = {
    personality: translate(`fitYByX.personality.${result.kind === "notComputable" ? result.personality : result.kind}`),
    usedRows: formatCount(result.usedRows),
    excludedRows: formatCount(result.excludedRows),
  };

  if (result.kind === "bivariate") {
    return {
      summary: resultSummary,
      sections: [
        summaryOfFitSection(document, result, translate),
        lackOfFitSection(result, translate),
        anovaSection("analysisOfVariance", translateOrFallback(translate, "fitYByX.report.section.analysisOfVariance", "Analysis of Variance"), result.anova, translate),
        parameterEstimatesSection(result.parameterEstimates, translate),
      ],
    };
  }
  if (result.kind === "oneway") {
    return {
      summary: resultSummary,
      sections: [
        groupSummarySection(result.groupSummaries, translate),
        anovaSection("analysisOfVariance", translateOrFallback(translate, "fitYByX.report.section.analysisOfVariance", "Analysis of Variance"), result.anova, translate),
        effectSizeSection(result, translate),
      ],
    };
  }
  return { summary: resultSummary, sections: [notComputableSection(result, translate)] };
}
