import { useTranslation } from "react-i18next";

import { AnalysisStack, AnalysisTable } from "@/components/analysis/presentation";
import type {
  CapabilityTypedValueV1,
  ProcessCapabilityDataV1,
  ProcessCapabilityIntervalV1,
} from "@/types/distribution";

export function ProcessCapabilityReport({ data }: { data: ProcessCapabilityDataV1 }) {
  const { t } = useTranslation();
  const specificationRows = [
    ["lsl", data.specification.lsl],
    ["target", data.specification.target],
    ["usl", data.specification.usl],
  ] as const;
  const summaryRows = [
    ["n", data.processSummary.n],
    ["mean", data.processSummary.mean],
    ["movingRangeAverage", data.processSummary.movingRangeAverage],
    ["withinSigma", data.processSummary.withinSigma],
    ["overallSigma", data.processSummary.overallSigma],
  ] as const;
  const withinRows = [
    ["cp", data.indices.cp],
    ["cpk", data.indices.cpk],
    ["cpl", data.indices.cpl],
    ["cpu", data.indices.cpu],
    ["cpmWithin", data.indices.cpmWithin],
  ] as const;
  const overallRows = [
    ["pp", data.indices.pp],
    ["ppk", data.indices.ppk],
    ["ppl", data.indices.ppl],
    ["ppu", data.indices.ppu],
    ["cpmOverall", data.indices.cpmOverall],
  ] as const;

  return (
    <AnalysisStack>
      <AnalysisTable
        title={t("distribution.capability.specification")}
        width="compact"
        columns={metricValueColumns(t)}
        rows={specificationRows.map(([label, value]) => ({
          key: label,
          cells: [label.toUpperCase(), formatNumber(value)],
        }))}
      />
      <AnalysisTable
        title={t("distribution.capability.processSummary")}
        width="compact"
        columns={metricValueColumns(t)}
        rows={[
          ...summaryRows.map(([label, value]) => ({
            key: label,
            cells: [t(`distribution.capability.${label}`), formatNumber(value)],
          })),
          {
            key: "stabilityIndex",
            cells: [
              t("distribution.capability.stabilityIndex"),
              formatCapabilityValue(data.processSummary.stabilityIndex.value, t),
            ],
          },
        ]}
      />
      <IndexTable title={t("distribution.capability.within")} rows={withinRows} intervals={data.intervals} />
      <IndexTable title={t("distribution.capability.overall")} rows={overallRows} intervals={data.intervals} />
      <NonconformanceTable data={data.nonconformance} />
      {data.warnings.map((warning) => (
        <p className="distribution-capability-warning" key={warning}>{t(warning)}</p>
      ))}
    </AnalysisStack>
  );
}

function IndexTable({
  title,
  rows,
  intervals,
}: {
  title: string;
  rows: ReadonlyArray<readonly [string, CapabilityTypedValueV1]>;
  intervals: ProcessCapabilityDataV1["intervals"];
}) {
  const { t } = useTranslation();
  const confidencePercent = new Intl.NumberFormat(undefined, {
    style: "percent",
    maximumFractionDigits: 2,
  }).format(intervals.confidenceLevel);
  return (
    <AnalysisTable
      title={title}
      width="wide"
      columns={[
        { key: "index", label: t("distribution.capability.index") },
        { key: "estimate", label: t("distribution.capability.estimate"), numeric: true },
        { key: "lower", label: t("distribution.capability.lowerConfidence", { confidencePercent }), numeric: true },
        { key: "upper", label: t("distribution.capability.upperConfidence", { confidencePercent }), numeric: true },
      ]}
      rows={rows.map(([label, value]) => {
        const interval = intervalFor(label, intervals);
        return {
          key: label,
          cells: [
            label.startsWith("cpm") ? "cpm" : label,
            formatCapabilityValue(value, t),
            formatCapabilityValue(interval.lower, t),
            formatCapabilityValue(interval.upper, t),
          ],
        };
      })}
    />
  );
}

function intervalFor(
  label: string,
  intervals: ProcessCapabilityDataV1["intervals"],
): ProcessCapabilityIntervalV1 {
  type IntervalKey = Exclude<keyof typeof intervals, "confidenceLevel" | "provenance">;
  return intervals[label as IntervalKey];
}

function NonconformanceTable({ data }: { data: ProcessCapabilityDataV1["nonconformance"] }) {
  const { t } = useTranslation();
  const rows = [
    ["below", data.observed.below, data.expectedWithin.below, data.expectedOverall.below],
    ["above", data.observed.above, data.expectedWithin.above, data.expectedOverall.above],
    ["total", data.observed.total, data.expectedWithin.total, data.expectedOverall.total],
  ] as const;
  return (
    <AnalysisTable
      title={t("distribution.capability.nonconformance")}
      width="wide"
      columns={[
        { key: "portion", label: t("distribution.capability.portion") },
        { key: "observed", label: t("distribution.capability.observedPercent"), numeric: true },
        { key: "within", label: t("distribution.capability.expectedWithinPercent"), numeric: true },
        { key: "overall", label: t("distribution.capability.expectedOverallPercent"), numeric: true },
      ]}
      rows={rows.map(([tail, observed, expectedWithin, expectedOverall]) => ({
        key: tail,
        cells: [
          t(`distribution.capability.${tail}`),
          formatPercentage(observed.proportion, t),
          formatPercentage(expectedWithin.proportion, t),
          formatPercentage(expectedOverall.proportion, t),
        ],
      }))}
    />
  );
}

function metricValueColumns(t: (key: string, values?: Record<string, unknown>) => string) {
  return [
    { key: "metric", label: t("distribution.report.metric", { defaultValue: "Metric" }) },
    { key: "value", label: t("distribution.report.value"), numeric: true },
  ];
}

function formatCapabilityValue(
  value: CapabilityTypedValueV1,
  t: (key: string) => string,
): string {
  if (value.state === "available" && value.value !== null) {
    return value.value.toLocaleString(undefined, {
      minimumFractionDigits: 3,
      maximumFractionDigits: 3,
    });
  }
  return t(`distribution.capability.states.${value.state}`);
}

function formatPercentage(
  value: CapabilityTypedValueV1,
  t: (key: string) => string,
): string {
  if (value.state === "available" && value.value !== null) {
    const percentage = (value.value * 100).toLocaleString(undefined, {
      maximumFractionDigits: 4,
    });
    return `${percentage}%`;
  }
  return t(`distribution.capability.states.${value.state}`);
}

function formatNumber(value: number | null): string {
  return value === null ? "—" : value.toLocaleString(undefined, { maximumSignificantDigits: 8 });
}
