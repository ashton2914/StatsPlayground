import { useTranslation } from "react-i18next";

import {
  AnalysisFrame,
  AnalysisStack,
  AnalysisTable,
  AnalysisText,
} from "@/components/analysis/presentation";
import type {
  DistributionGroupResult,
  DistributionGroupValueV1,
  DistributionReportBlock,
} from "@/types/distribution";

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
    <AnalysisStack data-testid="distribution-report">
      {groups.map((group, groupIndex) => (
        <GroupSection
          key={groupIdentity(group)}
          group={group}
          groupIndex={groupIndex}
          defaultOpen={groupIndex === 0}
        />
      ))}
      {standaloneBlocks.length > 0 && (
        <AnalysisFrame title="Report">
          <AnalysisStack>
            {standaloneBlocks.filter(hasReportContent).map((block) => (
              <ReportBlock key={block.blockId} block={block} />
            ))}
          </AnalysisStack>
        </AnalysisFrame>
      )}
    </AnalysisStack>
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
    <AnalysisFrame
      title={label}
      data-testid={`distribution-group-${groupIndex}`}
      defaultExpanded={defaultOpen}
    >
      <AnalysisStack>
        {group.yResults.map((result, yIndex) => {
          const summaryBlock = result.blocks.find((block) => block.summaryData);
          return (
            <AnalysisFrame title={result.yName} key={result.yColumn.columnId} defaultExpanded={yIndex === 0}>
              <AnalysisStack>
                <AnalysisTable
                  title={t("distribution.report.quantiles")}
                  width="wide"
                  columns={[
                    { key: "probability", label: t("distribution.report.probability"), rowHeader: true },
                    { key: "label", label: t("distribution.report.label") },
                    { key: "value", label: t("distribution.report.value"), numeric: true },
                  ]}
                  rows={result.quantiles.map((quantile) => ({
                    key: String(quantile.probability),
                    cells: [
                      formatProbability(quantile.probability),
                      quantileLabel(quantile.probability, t),
                      formatNumber(quantile.value),
                    ],
                  }))}
                />
                {summaryBlock?.summaryData && <SummaryDataTables summaryData={summaryBlock.summaryData} />}
                {result.blocks
                  .filter((block) => block !== summaryBlock && hasReportContent(block))
                  .map((block) => <ReportBlock key={block.blockId} block={block} />)}
              </AnalysisStack>
            </AnalysisFrame>
          );
        })}
      </AnalysisStack>
    </AnalysisFrame>
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
    <AnalysisFrame title={blockTitle} data-testid={`distribution-report-block-${block.blockId}`}>
      <AnalysisStack>
      {compatibilityStatus && (
        <AnalysisText>
          {t(`distribution.compatibility.${compatibilityStatus}`)}
        </AnalysisText>
      )}
      {block.status !== "available" && block.reasonCode && (
        <AnalysisText data-testid={`distribution-report-unavailable-${block.blockId}`}>
          {t("distribution.report.unavailableReason", { reason: block.reasonCode })}
        </AnalysisText>
      )}
      {block.summaryData && <SummaryDataTables summaryData={block.summaryData} />}
      {block.distributionFitData && <ContinuousFitReport data={block.distributionFitData} />}
      {block.distributionFitComparisonData && (
        <ContinuousFitComparisonReport data={block.distributionFitComparisonData} />
      )}
      {block.capabilityData && <ProcessCapabilityReport data={block.capabilityData} />}
      </AnalysisStack>
    </AnalysisFrame>
  );
}

function SummaryDataTables({
  summaryData,
}: {
  summaryData: NonNullable<DistributionReportBlock["summaryData"]>;
}) {
  const { t } = useTranslation();
  return (
    <AnalysisStack>
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
    </AnalysisStack>
  );
}

function SummaryTable({ title, rows }: { title: string; rows: Array<[string, number | string | null]> }) {
  const { t } = useTranslation();
  return (
    <AnalysisTable
      title={title}
      width="compact"
      columns={[
        { key: "metric", label: t("distribution.report.metric", { defaultValue: "Metric" }), rowHeader: true },
        { key: "value", label: t("distribution.report.value"), numeric: true },
      ]}
      rows={rows.map(([label, value]) => ({
        key: label,
        cells: [
          t(`distribution.statistics.${label}`),
          typeof value === "number" ? formatNumber(value) : value ?? "-",
        ],
      }))}
    />
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
  return value.toLocaleString(undefined, { maximumSignificantDigits: 10 });
}
