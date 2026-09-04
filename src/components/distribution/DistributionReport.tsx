import { useTranslation } from "react-i18next";

import type {
  DistributionGroupResult,
  DistributionGroupValueV1,
  DistributionReportBlock,
} from "@/types/distribution";

import "../reportTable.css";

import { ContinuousFitComparisonReport, ContinuousFitReport } from "./ContinuousFitReport";
import { ProcessCapabilityReport } from "./ProcessCapabilityReport";

interface DistributionReportProps {
  groups: DistributionGroupResult[];
  reportBlocks: DistributionReportBlock[];
}

export function DistributionReport({ groups, reportBlocks }: DistributionReportProps) {
  const nestedBlockIds = new Set(
    groups.flatMap((group) => group.yResults.flatMap((result) => result.blocks.map((block) => block.blockId))),
  );
  const standaloneBlocks = reportBlocks.filter((block) => !nestedBlockIds.has(block.blockId));

  return (
    <div className="distribution-report-tree">
      {groups.map((group, groupIndex) => (
        <GroupSection
          key={groupIdentity(group)}
          group={group}
          groupIndex={groupIndex}
          defaultOpen={groupIndex === 0}
        />
      ))}
      {standaloneBlocks.length > 0 && (
        <details className="distribution-report-group">
          <summary className="distribution-group-heading">Report</summary>
          <div className="distribution-group-content">
            {standaloneBlocks.filter(hasReportContent).map((block) => (
              <ReportBlock key={block.blockId} block={block} />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function GroupSection({
  group,
  groupIndex,
  defaultOpen,
}: {
  group: DistributionGroupResult;
  groupIndex: number;
  defaultOpen: boolean;
}) {
  const { t } = useTranslation();
  const label = group.groupKey.length === 0
    ? t("distribution.report.overall")
    : group.groupKey.map((value, index) => {
        const formatted = formatGroupValue(value, t("distribution.report.missing"));
        const name = group.groupNames?.[index];
        return name ? `${name} = ${formatted}` : formatted;
      }).join(" / ");

  return (
    <details
      className="distribution-report-group"
      data-testid={`distribution-group-${groupIndex}`}
      open={defaultOpen}
    >
      <summary className="distribution-group-heading">{label}</summary>
      <div className="distribution-group-content">
        {group.yResults.map((result, yIndex) => {
          const summaryBlock = result.blocks.find((block) => block.summaryData);
          return (
            <details className="distribution-y-section" key={result.yColumn.columnId} open={yIndex === 0}>
              <summary className="distribution-y-heading">{result.yName}</summary>
              <div className="distribution-y-content">
                <section className="distribution-report-block distribution-table-pair">
                  <div>
                    <h3>{t("distribution.report.quantiles")}</h3>
                    <table className="sp-fit-y-by-x-report-table distribution-quantile-table">
                      <thead>
                        <tr>
                          <th>{t("distribution.report.probability")}</th>
                          <th>{t("distribution.report.label")}</th>
                          <th>{t("distribution.report.value")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {result.quantiles.map((quantile) => (
                          <tr key={quantile.probability}>
                            <th scope="row">{formatProbability(quantile.probability)}</th>
                            <td>{quantileLabel(quantile.probability, t)}</td>
                            <td>{formatNumber(quantile.value)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {summaryBlock?.summaryData && (
                    <div>
                      <h3>{t("distribution.report.summary")}</h3>
                      <SummaryDataTables summaryData={summaryBlock.summaryData} />
                    </div>
                  )}
                </section>
                {result.blocks
                  .filter((block) => block !== summaryBlock && hasReportContent(block))
                  .map((block) => <ReportBlock key={block.blockId} block={block} />)}
              </div>
            </details>
          );
        })}
      </div>
    </details>
  );
}

export function ReportBlock({ block }: { block: DistributionReportBlock }) {
  const { t } = useTranslation();
  const compatibilityStatus = getCompatibilityStatus(block);
  const blockTitle = block.distributionFitData
    ? `${t(block.titleKey)} - ${t(`distribution.fit.distributions.${block.distributionFitData.distributionId}`, {
      defaultValue: block.distributionFitData.distributionId,
    })}`
    : t(block.titleKey);

  return (
    <section className="distribution-report-block" data-testid={`distribution-report-block-${block.blockId}`}>
      <h3>{blockTitle}</h3>
      {compatibilityStatus && (
        <p className="distribution-compatibility-status">
          {t(`distribution.compatibility.${compatibilityStatus}`)}
        </p>
      )}
      {block.status !== "available" && block.reasonCode && (
        <p className="distribution-report-unavailable" data-testid={`distribution-report-unavailable-${block.blockId}`}>
          {t("distribution.report.unavailableReason", { reason: block.reasonCode })}
        </p>
      )}
      {block.summaryData && <SummaryDataTables summaryData={block.summaryData} />}
      {block.distributionFitData && <ContinuousFitReport data={block.distributionFitData} />}
      {block.distributionFitComparisonData && (
        <ContinuousFitComparisonReport data={block.distributionFitComparisonData} />
      )}
      {block.capabilityData && <ProcessCapabilityReport data={block.capabilityData} />}
    </section>
  );
}

function SummaryDataTables({
  summaryData,
}: {
  summaryData: NonNullable<DistributionReportBlock["summaryData"]>;
}) {
  const { t } = useTranslation();
  return (
    <div className="distribution-summary-tables">
      <SummaryTable title={t("distribution.report.location")} rows={[
        ["n", summaryData.n], ["nMissing", summaryData.nMissing],
        ["mean", summaryData.mean], ["median", summaryData.median],
        ["mode", summaryData.modeIsUnique
          ? summaryData.primaryMode
          : t("distribution.statistics.noUniqueMode")], ["minimum", summaryData.minimum],
        ["maximum", summaryData.maximum],
      ]} />
      <SummaryTable title={t("distribution.report.variation")} rows={[
        ["stdDev", summaryData.stdDev], ["stdError", summaryData.stdError],
        ["meanCiLower", summaryData.meanCiLower], ["meanCiUpper", summaryData.meanCiUpper],
        ["range", summaryData.range], ["iqr", summaryData.iqr], ["mad", summaryData.mad],
      ]} />
    </div>
  );
}

function SummaryTable({ title, rows }: { title: string; rows: Array<[string, number | string | null]> }) {
  const { t } = useTranslation();
  return (
    <table className="sp-fit-y-by-x-report-table distribution-summary-table">
      <caption>{title}</caption>
      <tbody>
        {rows.map(([label, value]) => (
          <tr key={label}>
            <th scope="row">{t(`distribution.statistics.${label}`)}</th>
            <td>{typeof value === "number" ? formatNumber(value) : value ?? "-"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function hasReportContent(block: DistributionReportBlock): boolean {
  return block.status !== "available"
    || !!block.summaryData
    || !!block.capabilityData
    || !!block.distributionFitData
    || !!block.distributionFitComparisonData;
}

function getCompatibilityStatus(
  block: DistributionReportBlock,
): "intentionalDifference" | "compatibilityPending" | null {
  const status = block.chartData?.provenance.compatibilityStatus;
  return status === "intentionalDifference" || status === "compatibilityPending"
    ? status
    : null;
}

function quantileLabel(probability: number, t: (key: string) => string): string {
  if (probability === 0) return t("distribution.statistics.minimum");
  if (probability === 0.25) return "Q1";
  if (probability === 0.5) return t("distribution.statistics.median");
  if (probability === 0.75) return "Q3";
  if (probability === 1) return t("distribution.statistics.maximum");
  return "";
}

function groupIdentity(group: DistributionGroupResult): string {
  return group.groupKey.length === 0 ? "overall" : JSON.stringify(group.groupKey);
}

function formatGroupValue(value: DistributionGroupValueV1, missing: string): string {
  switch (value.kind) {
    case "missing": return missing;
    case "dateTime": return new Date(value.utcMillis).toLocaleString();
    case "boolean": return String(value.value);
    case "number": return formatNumber(value.value);
    case "text": return value.value;
  }
}

function formatProbability(probability: number): string {
  return `${Number.parseFloat((probability * 100).toFixed(3))}%`;
}

function formatNumber(value: number): string {
  return value.toLocaleString(undefined, { maximumSignificantDigits: 8 });
}
