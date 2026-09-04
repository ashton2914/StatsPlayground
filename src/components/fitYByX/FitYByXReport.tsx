import { useTranslation } from "react-i18next";

import type {
  FitYByXAnovaRow,
  FitYByXBivariateResult,
  FitYByXEstimateRow,
  FitYByXItem,
  FitYByXNotComputableReason,
  FitYByXNotComputableResult,
  FitYByXOnewayGroupSummary,
  FitYByXOnewayResult,
  FitYByXSummaryOfFit,
} from "@/types/fitYByX";

import "../reportTable.css";

import type { FitYByXReportState } from "./useFitYByXReport";

type TranslateValues = Record<string, string | number | null | undefined>;
type Translate = (key: string, values?: TranslateValues) => string;

export interface FitYByXReportRowModel {
  key: string;
  values: string[];
  numericColumns?: number[];
}

export interface FitYByXReportSectionModel {
  key: string;
  title: string;
  open: boolean;
  columns: string[];
  rows: FitYByXReportRowModel[];
}

export interface FitYByXReportViewModel {
  summary: {
    personality: string;
    usedRows: string;
    excludedRows: string;
  };
  sections: FitYByXReportSectionModel[];
}

export interface FitYByXReportViewModelOptions {
  item: FitYByXItem;
  state: FitYByXReportState;
  t: Translate;
  datasetMissing: boolean;
}

export interface FitYByXReportProps {
  item: FitYByXItem;
  state: FitYByXReportState;
  datasetMissing: boolean;
}

const DEFAULT_UNDEFINED_VALUE = "—";

function resolveUndefinedValueLabel(t: Translate): string {
  const localized = t("fitYByX.report.undefinedValue");
  return localized === "fitYByX.report.undefinedValue"
    ? DEFAULT_UNDEFINED_VALUE
    : localized;
}

export function formatFitYByXReportValue(
  value: number | null | undefined,
  undefinedValue = DEFAULT_UNDEFINED_VALUE,
): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefinedValue;
  }

  if (value === 0) {
    return "0";
  }

  return Number.parseFloat(value.toPrecision(6)).toString();
}

export function formatFitYByXReportPValue(
  value: number | null | undefined,
  undefinedValue = DEFAULT_UNDEFINED_VALUE,
): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefinedValue;
  }

  if (value > 0 && value < 0.0001) {
    return "<0.0001";
  }

  return value.toFixed(4);
}

function formatCount(value: number | null | undefined, undefinedValue = DEFAULT_UNDEFINED_VALUE): string {
  return typeof value === "number" && Number.isFinite(value)
    ? String(value)
    : undefinedValue;
}

function createLabeledValueSection(
  key: string,
  title: string,
  rows: Array<{ key: string; label: string; value: string; numericColumns?: number[] | null }>,
  t: Translate,
): FitYByXReportSectionModel {
  return {
    key,
    title,
    open: true,
    columns: [
      t("fitYByX.report.column.metric"),
      t("fitYByX.report.column.value"),
    ],
    rows: rows.map((row) => {
      const labeledRow: FitYByXReportRowModel = {
        key: row.key,
        values: [row.label, row.value],
      };

      if (row.numericColumns === null) {
        return labeledRow;
      }

      return {
        ...labeledRow,
        numericColumns: row.numericColumns ?? [1],
      };
    }),
  };
}

function createAnovaSection(
  key: string,
  title: string,
  rows: FitYByXAnovaRow[],
  t: Translate,
  undefinedValue: string,
): FitYByXReportSectionModel {
  return {
    key,
    title,
    open: true,
    columns: [
      t("fitYByX.report.column.source"),
      t("fitYByX.report.column.degreesOfFreedom"),
      t("fitYByX.report.column.sumOfSquares"),
      t("fitYByX.report.column.meanSquare"),
      t("fitYByX.report.column.fRatio"),
      t("fitYByX.report.column.pValue"),
    ],
    rows: rows.map((row) => ({
      key: `${key}:${row.source}`,
      values: [
        translateStableReportLabel("source", row.source, t),
        formatCount(row.degreesOfFreedom, undefinedValue),
        formatFitYByXReportValue(row.sumOfSquares, undefinedValue),
        formatFitYByXReportValue(row.meanSquare, undefinedValue),
        formatFitYByXReportValue(row.fRatio, undefinedValue),
        formatFitYByXReportPValue(row.pValue, undefinedValue),
      ],
      numericColumns: [1, 2, 3, 4, 5],
    })),
  };
}

function formatSignedEquation(
  responseName: string,
  factorName: string,
  intercept: number,
  slope: number,
  t: Translate,
  undefinedValue: string,
): string {
  const interceptLabel = formatFitYByXReportValue(intercept, undefinedValue);
  const slopeLabel = formatFitYByXReportValue(slope, undefinedValue);

  if (interceptLabel === undefinedValue || slopeLabel === undefinedValue) {
    return undefinedValue;
  }

  return t("fitYByX.report.summaryOfFit.equationTemplate", {
    response: responseName,
    intercept: interceptLabel,
    slope: slopeLabel,
    factor: factorName,
  }).replace(/\+\s+-/g, "- ");
}

function translateStableReportLabel(
  scope: "source" | "term",
  label: string,
  t: Translate,
): string {
  const localized = t(`fitYByX.report.${scope}.${label}`);
  return localized === `fitYByX.report.${scope}.${label}` ? label : localized;
}

function createSummaryOfFitSection(
  item: FitYByXItem,
  result: FitYByXBivariateResult,
  summaryOfFit: FitYByXSummaryOfFit,
  t: Translate,
  undefinedValue: string,
): FitYByXReportSectionModel {
  return createLabeledValueSection(
    "summaryOfFit",
    t("fitYByX.report.section.summaryOfFit"),
    [
      {
        key: "fittedEquation",
        label: t("fitYByX.report.summaryOfFit.fittedEquation"),
        numericColumns: null,
        value: formatSignedEquation(
          item.response.name,
          item.factor.name,
          result.intercept,
          result.slope,
          t,
          undefinedValue,
        ),
      },
      {
        key: "rSquared",
        label: t("fitYByX.report.summaryOfFit.rSquared"),
        value: formatFitYByXReportValue(summaryOfFit.rSquared, undefinedValue),
      },
      {
        key: "adjustedRSquared",
        label: t("fitYByX.report.summaryOfFit.adjustedRSquared"),
        value: formatFitYByXReportValue(summaryOfFit.adjustedRSquared, undefinedValue),
      },
      {
        key: "rootMeanSquareError",
        label: t("fitYByX.report.summaryOfFit.rootMeanSquareError"),
        value: formatFitYByXReportValue(summaryOfFit.rootMeanSquareError, undefinedValue),
      },
      {
        key: "meanOfResponse",
        label: t("fitYByX.report.summaryOfFit.meanOfResponse"),
        value: formatFitYByXReportValue(summaryOfFit.meanOfResponse, undefinedValue),
      },
      {
        key: "observationCount",
        label: t("fitYByX.report.summaryOfFit.observationCount"),
        value: formatCount(summaryOfFit.observationCount, undefinedValue),
      },
    ],
    t,
  );
}

function createLackOfFitSection(
  result: FitYByXBivariateResult,
  t: Translate,
  undefinedValue: string,
): FitYByXReportSectionModel {
  if (result.lackOfFit.state === "available") {
    return createAnovaSection(
      "lackOfFit",
      t("fitYByX.report.section.lackOfFit"),
      result.lackOfFit.rows,
      t,
      undefinedValue,
    );
  }

  return {
    key: "lackOfFit",
    title: t("fitYByX.report.section.lackOfFit"),
    open: true,
    columns: [t("fitYByX.report.column.metric")],
    rows: [
      {
        key: "lackOfFit:notIdentifiable",
        values: [t("fitYByX.report.lackOfFit.notIdentifiable")],
      },
    ],
  };
}

function createParameterEstimatesSection(
  rows: FitYByXEstimateRow[],
  t: Translate,
  undefinedValue: string,
): FitYByXReportSectionModel {
  return {
    key: "parameterEstimates",
    title: t("fitYByX.report.section.parameterEstimates"),
    open: true,
    columns: [
      t("fitYByX.report.column.term"),
      t("fitYByX.report.column.estimate"),
      t("fitYByX.report.column.standardError"),
      t("fitYByX.report.column.tRatio"),
      t("fitYByX.report.column.pValue"),
      t("fitYByX.report.column.lowerConfidenceLimit"),
      t("fitYByX.report.column.upperConfidenceLimit"),
    ],
    rows: rows.map((row) => ({
      key: `estimate:${row.term}`,
      values: [
        translateStableReportLabel("term", row.term, t),
        formatFitYByXReportValue(row.estimate, undefinedValue),
        formatFitYByXReportValue(row.standardError, undefinedValue),
        formatFitYByXReportValue(row.tRatio, undefinedValue),
        formatFitYByXReportPValue(row.pValue, undefinedValue),
        formatFitYByXReportValue(row.lowerConfidenceLimit, undefinedValue),
        formatFitYByXReportValue(row.upperConfidenceLimit, undefinedValue),
      ],
      numericColumns: [1, 2, 3, 4, 5, 6],
    })),
  };
}

function createGroupSummarySection(
  rows: FitYByXOnewayGroupSummary[],
  t: Translate,
  undefinedValue: string,
): FitYByXReportSectionModel {
  return {
    key: "groupSummary",
    title: t("fitYByX.report.section.groupSummary"),
    open: true,
    columns: [
      t("fitYByX.report.column.group"),
      t("fitYByX.report.column.count"),
      t("fitYByX.report.column.mean"),
      t("fitYByX.report.column.standardDeviation"),
      t("fitYByX.report.column.standardError"),
      t("fitYByX.report.column.lowerConfidenceLimit"),
      t("fitYByX.report.column.upperConfidenceLimit"),
    ],
    rows: rows.map((row) => ({
      key: `group:${row.group}`,
      values: [
        row.group,
        formatCount(row.count, undefinedValue),
        formatFitYByXReportValue(row.mean, undefinedValue),
        formatFitYByXReportValue(row.standardDeviation, undefinedValue),
        formatFitYByXReportValue(row.standardError, undefinedValue),
        formatFitYByXReportValue(row.lowerConfidenceLimit, undefinedValue),
        formatFitYByXReportValue(row.upperConfidenceLimit, undefinedValue),
      ],
      numericColumns: [1, 2, 3, 4, 5, 6],
    })),
  };
}

function createEffectSizeSection(
  result: FitYByXOnewayResult,
  t: Translate,
  undefinedValue: string,
): FitYByXReportSectionModel {
  return createLabeledValueSection(
    "effectSize",
    t("fitYByX.report.section.effectSize"),
    [
      {
        key: "etaSquared",
        label: t("fitYByX.report.effectSize.etaSquared"),
        value: formatFitYByXReportValue(result.effectSizes.etaSquared, undefinedValue),
      },
      {
        key: "omegaSquared",
        label: t("fitYByX.report.effectSize.omegaSquared"),
        value: formatFitYByXReportValue(result.effectSizes.omegaSquared, undefinedValue),
      },
    ],
    t,
  );
}

function createNotComputableSection(
  result: FitYByXNotComputableResult,
  t: Translate,
): FitYByXReportSectionModel {
  return createLabeledValueSection(
    "notComputable",
    t("fitYByX.report.notComputable"),
    [
      {
        key: "reason",
        label: t("fitYByX.report.reasonLabel"),
        value: t(`fitYByX.report.reason.${result.reason}`),
      },
      {
        key: "usedRows",
        label: t("fitYByX.report.usedRows"),
        value: formatCount(result.usedRows),
      },
      {
        key: "excludedRows",
        label: t("fitYByX.report.excludedRows"),
        value: formatCount(result.excludedRows),
      },
    ],
    t,
  );
}

function createStatusSection(
  key: string,
  message: string,
  t: Translate,
): FitYByXReportSectionModel {
  return createLabeledValueSection(
    key,
    t("fitYByX.report.section.status"),
    [{ key, label: t("fitYByX.report.column.metric"), value: message }],
    t,
  );
}

function createBivariateSections(
  item: FitYByXItem,
  result: FitYByXBivariateResult,
  t: Translate,
  undefinedValue: string,
): FitYByXReportSectionModel[] {
  return [
    createSummaryOfFitSection(item, result, result.summaryOfFit, t, undefinedValue),
    createLackOfFitSection(result, t, undefinedValue),
    createAnovaSection(
      "analysisOfVariance",
      t("fitYByX.report.section.analysisOfVariance"),
      result.anova,
      t,
      undefinedValue,
    ),
    createParameterEstimatesSection(result.parameterEstimates, t, undefinedValue),
  ];
}

function createOnewaySections(
  result: FitYByXOnewayResult,
  t: Translate,
  undefinedValue: string,
): FitYByXReportSectionModel[] {
  return [
    createGroupSummarySection(result.groupSummaries, t, undefinedValue),
    createAnovaSection(
      "analysisOfVariance",
      t("fitYByX.report.section.analysisOfVariance"),
      result.anova,
      t,
      undefinedValue,
    ),
    createEffectSizeSection(result, t, undefinedValue),
  ];
}

function createReasonLabel(reason: FitYByXNotComputableReason, t: Translate): string {
  return t(`fitYByX.report.reason.${reason}`);
}

export function createFitYByXReportViewModel(
  options: FitYByXReportViewModelOptions,
): FitYByXReportViewModel {
  const { item, state, t, datasetMissing } = options;
  const undefinedValue = resolveUndefinedValueLabel(t);
  const summary = {
    personality: t(`fitYByX.personality.${item.personality}`),
    usedRows: undefinedValue,
    excludedRows: undefinedValue,
  };

  if (datasetMissing) {
    return {
      summary,
      sections: [createStatusSection("sourceMissing", t("fitYByX.sourceMissing"), t)],
    };
  }

  if (state.status === "idle" || state.status === "loading") {
    return {
      summary,
      sections: [createStatusSection("loading", t("fitYByX.report.loading"), t)],
    };
  }

  if (state.status === "error") {
    return {
      summary,
      sections: [createStatusSection("error", `${t("fitYByX.report.error")}: ${state.error}`, t)],
    };
  }

  summary.usedRows = formatCount(state.result.usedRows, undefinedValue);
  summary.excludedRows = formatCount(state.result.excludedRows, undefinedValue);

  switch (state.result.kind) {
    case "bivariate":
      return {
        summary,
        sections: createBivariateSections(item, state.result, t, undefinedValue),
      };
    case "oneway":
      return {
        summary,
        sections: createOnewaySections(state.result, t, undefinedValue),
      };
    case "notComputable":
      return {
        summary: {
          ...summary,
          personality: t(`fitYByX.personality.${state.result.personality}`),
        },
        sections: [createNotComputableSection(state.result, t)],
      };
    default:
      return {
        summary,
        sections: [createStatusSection("error", createReasonLabel("insufficientValidRows", t), t)],
      };
  }
}

export function FitYByXReport({ item, state, datasetMissing }: FitYByXReportProps) {
  const { t } = useTranslation();
  const model = createFitYByXReportViewModel({
    item,
    state,
    t: (key, values) => t(key, values),
    datasetMissing,
  });

  const summaryItems = [
    { key: "personality", label: t("fitYByX.report.personality"), value: model.summary.personality },
    { key: "usedRows", label: t("fitYByX.report.usedRows"), value: model.summary.usedRows },
    { key: "excludedRows", label: t("fitYByX.report.excludedRows"), value: model.summary.excludedRows },
  ];

  return (
    <section className="sp-fit-y-by-x-report-panel" aria-labelledby={`fit-y-by-x-report-${item.id}`}>
      <div className="sp-panel-header">
        <span id={`fit-y-by-x-report-${item.id}`} className="sp-panel-header-title">{t("fitYByX.report.title")}</span>
      </div>

      <div className="sp-fit-y-by-x-report-body">
        <dl className="sp-fit-y-by-x-report-summary" aria-label={t("fitYByX.report.title")}>
          {summaryItems.map((entry) => (
            <div key={entry.key} className="sp-fit-y-by-x-report-summary-item">
              <dt className="sp-fit-y-by-x-report-summary-label">{entry.label}</dt>
              <dd className="sp-fit-y-by-x-report-summary-value">{entry.value}</dd>
            </div>
          ))}
        </dl>

        <div className="sp-fit-y-by-x-report-sections">
          {model.sections.map((section) => (
            <details key={section.key} className="sp-fit-y-by-x-report-section" open={section.open}>
              <summary className="sp-fit-y-by-x-report-section-summary">{section.title}</summary>
              <div className="sp-fit-y-by-x-report-table-wrap">
                <table className="sp-fit-y-by-x-report-table" aria-label={section.title}>
                  <colgroup>
                    {section.columns.map((column, index) => {
                      const columnClass = index === 0
                        ? "sp-fit-y-by-x-report-column-label"
                        : section.columns.length === 2
                          ? "sp-fit-y-by-x-report-column-value-wide"
                          : "sp-fit-y-by-x-report-column-value";
                      return <col key={column} className={columnClass} />;
                    })}
                  </colgroup>
                  <thead>
                    <tr>
                      {section.columns.map((column) => (
                        <th key={column} scope="col">{column}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {section.rows.map((row) => (
                      <tr key={row.key}>
                        {row.values.map((value, index) => {
                          const numeric = row.numericColumns?.includes(index) ?? false;
                          return (
                            <td key={`${row.key}:${index}`} className={numeric ? "sp-fit-y-by-x-report-cell-numeric" : undefined}>
                              {value}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}