import { useTranslation } from "react-i18next";

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
    <div className="distribution-capability-report">
      <div className="distribution-capability-summary">
        <table className="sp-fit-y-by-x-report-table">
          <caption>{t("distribution.capability.specification")}</caption>
          <tbody>
            {specificationRows.map(([label, value]) => (
              <tr key={label}>
                <th scope="row">{label.toUpperCase()}</th>
                <td>{formatNumber(value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <table className="sp-fit-y-by-x-report-table">
          <caption>{t("distribution.capability.processSummary")}</caption>
          <tbody>
            {summaryRows.map(([label, value]) => (
              <tr key={label}>
                <th scope="row">{t(`distribution.capability.${label}`)}</th>
                <td>{formatNumber(value)}</td>
              </tr>
            ))}
            <tr>
              <th scope="row">{t("distribution.capability.stabilityIndex")}</th>
              <td>{formatCapabilityValue(data.processSummary.stabilityIndex.value, t)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div className="distribution-capability-indices">
        <IndexTable
          title={t("distribution.capability.within")}
          rows={withinRows}
          intervals={data.intervals}
        />
        <IndexTable
          title={t("distribution.capability.overall")}
          rows={overallRows}
          intervals={data.intervals}
        />
      </div>
      <NonconformanceTable data={data.nonconformance} />
      {data.warnings.map((warning) => (
        <p className="distribution-capability-warning" key={warning}>{t(warning)}</p>
      ))}
    </div>
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
    <table className="sp-fit-y-by-x-report-table">
      <caption>{title}</caption>
      <thead>
        <tr>
          <th scope="col">{t("distribution.capability.index")}</th>
          <th scope="col">{t("distribution.capability.estimate")}</th>
          <th scope="col">{t("distribution.capability.lowerConfidence", { confidencePercent })}</th>
          <th scope="col">{t("distribution.capability.upperConfidence", { confidencePercent })}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([label, value]) => {
          const interval = intervalFor(label, intervals);
          return (
          <tr key={label}>
            <th scope="row">{label.startsWith("cpm") ? "cpm" : label}</th>
            <td>{formatCapabilityValue(value, t)}</td>
            <td>{formatCapabilityValue(interval.lower, t)}</td>
            <td>{formatCapabilityValue(interval.upper, t)}</td>
          </tr>
          );
        })}
      </tbody>
    </table>
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
    <table className="sp-fit-y-by-x-report-table distribution-nonconformance-table">
      <caption>{t("distribution.capability.nonconformance")}</caption>
      <thead>
        <tr>
          <th scope="col">{t("distribution.capability.portion")}</th>
          <th scope="col">{t("distribution.capability.observedPercent")}</th>
          <th scope="col">{t("distribution.capability.expectedWithinPercent")}</th>
          <th scope="col">{t("distribution.capability.expectedOverallPercent")}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([tail, observed, expectedWithin, expectedOverall]) => (
          <tr key={tail}>
            <th scope="row">{t(`distribution.capability.${tail}`)}</th>
            <td>{formatPercentage(observed.proportion, t)}</td>
            <td>{formatPercentage(expectedWithin.proportion, t)}</td>
            <td>{formatPercentage(expectedOverall.proportion, t)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
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
