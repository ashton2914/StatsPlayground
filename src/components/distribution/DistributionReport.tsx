import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import {
  AnalysisFrame,
  AnalysisStack,
  AnalysisTable,
  AnalysisText,
} from "@/components/analysis/presentation";
import { Select } from "@/components/ui";
import { distributionFitColor } from "@/graphCore/distributionFitStyle";
import {
  getDistributionFitSelectionKey,
  getDistributionGroupName,
  type DistributionFitSelections,
} from "@/graphCore/distributionAdapter";
import { getGraphTheme } from "@/graphCore/theme";
import type {
  DistributionGroupResult,
  DistributionGroupValueV1,
  ContinuousDistributionIdV1,
  DistributionReportBlock,
  DistributionReportBlockV1,
  DistributionYResultV1,
  ProcessCapabilityDataV1,
} from "@/types/distribution";

import { ContinuousFitComparisonReport, ContinuousFitReport } from "./ContinuousFitReport";
import { ProcessCapabilityReport } from "./ProcessCapabilityReport";

interface DistributionReportProps {
  groups: DistributionGroupResult[];
  reportBlocks: DistributionReportBlock[];
  selectedFitDistributionIds?: DistributionFitSelections;
  onSelectedFitDistributionIdChange?: (
    selectionKey: string,
    distributionId: ContinuousDistributionIdV1,
  ) => void;
}

export interface DistributionResponseReportProps {
  result: DistributionYResultV1;
  renderProcessCapabilityGraph?: (data: ProcessCapabilityDataV1) => ReactNode;
  selectedFitDistributionId?: ContinuousDistributionIdV1;
  onSelectedFitDistributionIdChange?: (distributionId: ContinuousDistributionIdV1) => void;
}

type ReportBlockLike = DistributionReportBlock | DistributionReportBlockV1;

export function formatDistributionGroupLabel(
  group: DistributionGroupResult,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  return group.groupKey.length === 0
    ? t("distribution.report.overall")
    : group.groupKey.map((value, index) => {
        const formatted = formatGroupValue(value, t("distribution.report.missing"));
        const name = group.groupNames?.[index];
        return name ? `${name} = ${formatted}` : formatted;
      }).join(" / ");
}

export function DistributionReport({
  groups,
  reportBlocks,
  selectedFitDistributionIds,
  onSelectedFitDistributionIdChange,
}: DistributionReportProps) {
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
          selectedFitDistributionIds={selectedFitDistributionIds}
          onSelectedFitDistributionIdChange={onSelectedFitDistributionIdChange}
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
  selectedFitDistributionIds,
  onSelectedFitDistributionIdChange,
}: {
  group: DistributionGroupResult;
  groupIndex: number;
  defaultOpen: boolean;
  selectedFitDistributionIds?: DistributionFitSelections;
  onSelectedFitDistributionIdChange?: DistributionReportProps["onSelectedFitDistributionIdChange"];
}) {
  const { t } = useTranslation();
  const label = formatDistributionGroupLabel(group, t);

  return (
    <AnalysisFrame
      title={label}
      data-testid={`distribution-group-${groupIndex}`}
      defaultExpanded={defaultOpen}
    >
      <AnalysisStack>
        {group.yResults.map((result, yIndex) => {
          const groupName = getDistributionGroupName(group);
          const seriesName = groupName === "Overall" ? result.yName : `${result.yName} | ${groupName}`;
          const selectionKey = getDistributionFitSelectionKey(result.yColumn.columnId, seriesName);
          return (
            <AnalysisFrame title={result.yName} key={result.yColumn.columnId} defaultExpanded={yIndex === 0}>
              <DistributionResponseReport
                result={result}
                selectedFitDistributionId={selectedFitDistributionIds?.[selectionKey]}
                onSelectedFitDistributionIdChange={onSelectedFitDistributionIdChange
                  ? (distributionId) => onSelectedFitDistributionIdChange(selectionKey, distributionId)
                  : undefined}
              />
            </AnalysisFrame>
          );
        })}
      </AnalysisStack>
    </AnalysisFrame>
  );
}

export function DistributionResponseReport({
  result,
  renderProcessCapabilityGraph,
  selectedFitDistributionId,
  onSelectedFitDistributionIdChange,
}: DistributionResponseReportProps) {
  const { t } = useTranslation();
  const summaryBlock = result.blocks.find((block) => block.summaryData);
  const fitBlocks = result.blocks.filter((block) => block.distributionFitData);
  const firstFitDistributionId = fitBlocks[0]?.distributionFitData?.distributionId;
  const [internalFitDistributionId, setInternalFitDistributionId] = useState(firstFitDistributionId);
  const activeFitDistributionId = fitBlocks.some(
    (block) => block.distributionFitData?.distributionId === selectedFitDistributionId,
  )
    ? selectedFitDistributionId
    : fitBlocks.some((block) => block.distributionFitData?.distributionId === internalFitDistributionId)
      ? internalFitDistributionId
      : firstFitDistributionId;
  const activeFitBlock = fitBlocks.find(
    (block) => block.distributionFitData?.distributionId === activeFitDistributionId,
  );

  const selectFit = (distributionId: ContinuousDistributionIdV1) => {
    setInternalFitDistributionId(distributionId);
    onSelectedFitDistributionIdChange?.(distributionId);
  };

  return (
    <AnalysisStack>
      <AnalysisFrame title={t("distribution.report.overall")} data-analysis-surface="overall">
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
        </AnalysisStack>
      </AnalysisFrame>
      {activeFitBlock?.distributionFitData && (
        <AnalysisFrame
          title={t("distribution.report.continuousFit")}
          data-testid="distribution-continuous-fit"
          data-analysis-surface="continuousFit"
          headerActions={fitBlocks.length > 1 ? (
            <Select
              aria-label={t("distribution.fit.selectorAria", { defaultValue: "Continuous Fit distribution" })}
              className="distribution-fit-model-select"
              value={activeFitBlock.distributionFitData.distributionId}
              onChange={(event) => selectFit(event.currentTarget.value as ContinuousDistributionIdV1)}
            >
              {fitBlocks.map((block) => {
                const fitData = block.distributionFitData!;
                return (
                  <option key={fitData.distributionId} value={fitData.distributionId}>
                    {t(`distribution.fit.distributions.${fitData.distributionId}`, {
                      defaultValue: fitData.distributionId,
                    })}
                  </option>
                );
              })}
            </Select>
          ) : undefined}
        >
          <FitBlockContent block={activeFitBlock} />
        </AnalysisFrame>
      )}
      {result.blocks
        .filter((block) => block !== summaryBlock && !block.distributionFitData && hasReportContent(block))
        .map((block) => (
          <ReportBlock
            key={block.blockId}
            block={block}
            renderProcessCapabilityGraph={renderProcessCapabilityGraph}
          />
        ))}
    </AnalysisStack>
  );
}

export function ReportBlock({
  block,
  renderProcessCapabilityGraph,
}: {
  block: ReportBlockLike;
  renderProcessCapabilityGraph?: (data: ProcessCapabilityDataV1) => ReactNode;
}) {
  const { t } = useTranslation();
  const blockTitle = block.distributionFitData
    ? `${t(block.titleKey)} - ${t(`distribution.fit.distributions.${block.distributionFitData.distributionId}`, {
      defaultValue: block.distributionFitData.distributionId,
    })}`
    : t(block.titleKey);

  return (
    <AnalysisFrame
      title={blockTitle}
      data-testid={`distribution-report-block-${block.blockId}`}
      data-analysis-surface={getReportSurfaceKind(block)}
    >
      <FitBlockContent block={block} blockTitle={blockTitle} renderProcessCapabilityGraph={renderProcessCapabilityGraph} />
    </AnalysisFrame>
  );
}

function FitBlockContent({
  block,
  blockTitle,
  renderProcessCapabilityGraph,
}: {
  block: ReportBlockLike;
  blockTitle?: string;
  renderProcessCapabilityGraph?: (data: ProcessCapabilityDataV1) => ReactNode;
}) {
  const { t } = useTranslation();
  const compatibilityStatus = getCompatibilityStatus(block);
  const reasonCode = getBlockReasonCode(block);
  const fitTitle = blockTitle ?? (block.distributionFitData
    ? `${t(block.titleKey)} - ${t(`distribution.fit.distributions.${block.distributionFitData.distributionId}`, {
      defaultValue: block.distributionFitData.distributionId,
    })}`
    : t(block.titleKey));

  return (
    <AnalysisStack>
      {block.distributionFitData && (
        <AnalysisText data-testid={`distribution-fit-report-title-${block.blockId}`}>
          <span
            className="distribution-fit-report-swatch"
            aria-hidden="true"
            style={{
              backgroundColor: distributionFitColor(
                block.distributionFitData.distributionId,
                getGraphTheme().categorical,
              ),
            }}
          />
          <span className="distribution-fit-report-label">{fitTitle}</span>
        </AnalysisText>
      )}
      {compatibilityStatus && (
        <AnalysisText>
          {t(`distribution.compatibility.${compatibilityStatus}`)}
        </AnalysisText>
      )}
      {block.status !== "available" && reasonCode && (
        <AnalysisText data-testid={`distribution-report-unavailable-${block.blockId}`}>
          {t("distribution.report.unavailableReason", { reason: reasonCode })}
        </AnalysisText>
      )}
      {block.summaryData && <SummaryDataTables summaryData={block.summaryData} />}
      {block.distributionFitData && <ContinuousFitReport data={block.distributionFitData} />}
      {block.distributionFitComparisonData && (
        <ContinuousFitComparisonReport data={block.distributionFitComparisonData} />
      )}
      {block.capabilityData && renderProcessCapabilityGraph?.(block.capabilityData)}
      {block.capabilityData && <ProcessCapabilityReport data={block.capabilityData} />}
    </AnalysisStack>
  );
}

function SummaryDataTables({
  summaryData,
}: {
  summaryData: NonNullable<DistributionReportBlock["summaryData"]>;
}) {
  const { t } = useTranslation();
  return (
    <SummaryTable
      title={t("distribution.report.summaryStatistics")}
      confidenceLevel={summaryData.confidenceLevel ?? 0.95}
      rows={[
        ["n", summaryData.n],
        ["nMissing", summaryData.nMissing],
        ["mean", summaryData.mean],
        ["median", summaryData.median],
        ["stdDev", summaryData.stdDev],
        ["stdError", summaryData.stdError],
        ["meanCiLower", summaryData.meanCiLower],
        ["meanCiUpper", summaryData.meanCiUpper],
      ]}
    />
  );
}

function SummaryTable({ title, rows, confidenceLevel }: { title: string; rows: Array<[string, number | string | null]>; confidenceLevel: number }) {
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
          t(`distribution.statistics.${label}`, { confidence: `${Number((confidenceLevel * 100).toFixed(6))}%` }),
          typeof value === "number" ? formatNumber(value) : value ?? "-",
        ],
      }))}
    />
  );
}

function hasReportContent(block: ReportBlockLike): boolean {
  return block.status !== "available"
    || !!block.summaryData
    || !!block.capabilityData
    || !!block.distributionFitData
    || !!block.distributionFitComparisonData;
}

function getCompatibilityStatus(
  block: ReportBlockLike,
): "intentionalDifference" | "compatibilityPending" | null {
  const status = block.chartData?.provenance.compatibilityStatus;
  return status === "intentionalDifference" || status === "compatibilityPending"
    ? status
    : null;
}

function getBlockReasonCode(block: ReportBlockLike): string | null {
  return "reasonCode" in block ? block.reasonCode : null;
}

function getReportSurfaceKind(block: ReportBlockLike): string {
  if (block.distributionFitData) return "continuousFit";
  if (block.distributionFitComparisonData) return "fitComparison";
  if (block.capabilityData) return "processCapability";
  if (block.summaryData) return "summary";
  return block.kind;
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
