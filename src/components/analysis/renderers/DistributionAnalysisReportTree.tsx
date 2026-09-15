import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import {
  createDistributionGraphBuilderConfig,
  createProcessCapabilityGraphBuilderConfig,
} from "@/components/analysis/distributionCompositeGraph";
import {
  AnalysisFrame,
  AnalysisGraph,
  AnalysisStack,
  AnalysisText,
} from "@/components/analysis/presentation";
import type { GraphRuntimeProps } from "@/components/graphBuilder/GraphRuntime";
import { createEmbeddedGraphItem } from "@/components/graphBuilder/graphBuilderMode";
import {
  getDistributionResponseCompositeGraphFrame,
  getProcessCapabilityGraphFrame,
} from "@/graphCore/distributionAdapter";
import type { FieldRef } from "@/graphCore/types";
import type { DistributionAnalysisDocument } from "@/types/analysis";
import type { DatasetMeta } from "@/types/data";
import type {
  DistributionGroupResult,
  DistributionReportResponse,
  DistributionYResultV1,
} from "@/types/distribution";

import {
  DistributionResponseReport,
  formatDistributionGroupLabel,
} from "@/components/distribution/DistributionReport";

export interface DistributionAnalysisReportTreeProps {
  item: DistributionAnalysisDocument;
  dataset: DatasetMeta;
  result: DistributionReportResponse;
  onOpenAxisSettings?: () => void;
  onAxisRangeChange?: (axis: "x" | "y", min: number, max: number) => void;
  renderGraph?: (props: GraphRuntimeProps, mode: "builder" | "builder-custom") => ReactNode;
}

export function DistributionAnalysisReportTree({
  item,
  dataset,
  result,
  onOpenAxisSettings,
  onAxisRangeChange,
  renderGraph,
}: DistributionAnalysisReportTreeProps) {
  const { t } = useTranslation();
  const allowLegacyOverallFallback = shouldAllowLegacyOverallFallback(item, result);
  const groups = item.definition.by.length > 0
    ? result.groups
    : result.groups[0]
      ? [result.groups[0]]
      : [];

  return (
    <AnalysisStack
      data-analysis-document
      data-analysis-kind="distribution"
      data-analysis-tree="response"
    >
      {item.definition.by.length > 0
        ? groups.map((group) => (
            <AnalysisFrame
              key={getGroupIdentity(group)}
              title={formatDistributionGroupLabel(group, t)}
              defaultExpanded
            >
              <AnalysisStack>
                {getOrderedResponseEntries(item.definition.responses, group).map(({ field, result: responseResult }) => (
                  <ResponseFrame
                    key={`${getGroupIdentity(group)}:${responseResult?.yColumn.columnId ?? field.columnId ?? field.name}`}
                    item={item}
                    dataset={dataset}
                    response={result}
                    group={group}
                    responseField={field}
                    responseResult={responseResult}
                    defaultExpanded
                    allowLegacyOverallFallback={allowLegacyOverallFallback}
                    onOpenAxisSettings={onOpenAxisSettings}
                    onAxisRangeChange={onAxisRangeChange}
                    renderGraph={renderGraph}
                  />
                ))}
              </AnalysisStack>
            </AnalysisFrame>
          ))
        : groups.flatMap((group) => getOrderedResponseEntries(item.definition.responses, group).map(({ field, result: responseResult }) => (
            <ResponseFrame
              key={`${getGroupIdentity(group)}:${responseResult?.yColumn.columnId ?? field.columnId ?? field.name}`}
              item={item}
              dataset={dataset}
              response={result}
              group={group}
              responseField={field}
              responseResult={responseResult}
              defaultExpanded
              allowLegacyOverallFallback={allowLegacyOverallFallback}
              onOpenAxisSettings={onOpenAxisSettings}
              onAxisRangeChange={onAxisRangeChange}
              renderGraph={renderGraph}
            />
          )))}
    </AnalysisStack>
  );
}

function ResponseFrame({
  item,
  dataset,
  response,
  group,
  responseField,
  responseResult,
  defaultExpanded,
  allowLegacyOverallFallback,
  onOpenAxisSettings,
  onAxisRangeChange,
  renderGraph,
}: {
  item: DistributionAnalysisDocument;
  dataset: DatasetMeta;
  response: DistributionReportResponse;
  group: DistributionGroupResult;
  responseField: FieldRef;
  responseResult: DistributionYResultV1 | null;
  defaultExpanded: boolean;
  allowLegacyOverallFallback: boolean;
  onOpenAxisSettings?: () => void;
  onAxisRangeChange?: (axis: "x" | "y", min: number, max: number) => void;
  renderGraph?: DistributionAnalysisReportTreeProps["renderGraph"];
}) {
  const { t } = useTranslation();
  const groupIdentity = getGroupIdentity(group);
  const responseIdentity = responseResult?.yColumn.columnId ?? responseField.columnId ?? responseField.name;
  const responseName = responseResult?.yName ?? responseField.name;
  const persistedResponse = item.definition.responses[0] ?? responseField;

  return (
    <AnalysisFrame
      title={responseField.name}
      defaultExpanded={defaultExpanded}
      data-analysis-surface="response"
    >
      <AnalysisStack>
        {responseResult
          ? (
            <>
              <AnalysisGraph
                title={t("graph.distribution", { defaultValue: "Distribution" })}
                graphRole="distributionComposite"
                data-analysis-block="graph"
                contentClassName="analysis-graph-distribution"
                strategy={{
                  mode: "builder",
                  runtimeProps: {
                    item: createEmbeddedGraphItem({
                      id: `analysis-graph:${item.id}:${encodeURIComponent(groupIdentity)}:${responseIdentity}:distributionComposite`,
                      name: `${responseField.name} Distribution`,
                      sourceDatasetId: item.source.datasetId,
                      config: createDistributionGraphBuilderConfig(
                        item.definition.graphs.overview,
                        item.definition.graphs.boxPlot,
                        [responseField],
                        persistedResponse,
                      ),
                      createdAt: item.createdAt,
                    }),
                    dataset,
                    panelLayout: "fit",
                    externalDataState: {
                      status: "ready",
                      frame: getDistributionResponseCompositeGraphFrame(response, {
                        sourceColumn: responseResult.yColumn.columnId,
                        seriesName: responseName,
                      }, group, {
                        allowLegacyOverallFallback,
                      }),
                      error: null,
                    },
                    onYAxisDblClick: onOpenAxisSettings,
                    onAxisRangeChange,
                  },
                }}
                renderGraph={renderGraph}
              />
              <DistributionResponseReport
                result={responseResult}
                renderProcessCapabilityGraph={(capability) => capability.chartData ? (
                  <AnalysisGraph
                    title={t("distribution.report.processCapability", { defaultValue: "Process Capability" })}
                    graphRole="processCapability"
                    data-analysis-block="graph"
                    contentClassName="analysis-graph-distribution"
                    strategy={{
                      mode: "builder",
                      runtimeProps: {
                        item: createEmbeddedGraphItem({
                          id: `analysis-graph:${item.id}:${encodeURIComponent(groupIdentity)}:${responseIdentity}:processCapability`,
                          name: `${responseField.name} Process Capability`,
                          sourceDatasetId: item.source.datasetId,
                          config: createProcessCapabilityGraphBuilderConfig(
                            item.definition.graphs.overview,
                            responseField,
                            persistedResponse,
                            capability.chartData,
                          ),
                          createdAt: item.createdAt,
                        }),
                        dataset,
                        panelLayout: "fit",
                        externalDataState: {
                          status: "ready",
                          frame: getProcessCapabilityGraphFrame(capability, {
                            datasetId: item.source.datasetId,
                            generation: dataset.generation,
                            responseColumn: responseResult.yColumn.columnId,
                          }),
                          error: null,
                        },
                      },
                    }}
                    renderGraph={renderGraph}
                  />
                ) : null}
              />
            </>
            )
          : <AnalysisText>{t("distribution.graph.unavailable", { defaultValue: "Graph unavailable for this response." })}</AnalysisText>}
      </AnalysisStack>
    </AnalysisFrame>
  );
}

function getOrderedResponseEntries(
  responseFields: FieldRef[],
  group: DistributionGroupResult,
): Array<{ field: FieldRef; result: DistributionYResultV1 | null }> {
  const unresolved = [...group.yResults];
  return responseFields.map((field) => {
    const exactIndex = unresolved.findIndex((result) => result.yColumn.columnId === field.columnId);
    if (exactIndex >= 0) {
      const [result] = unresolved.splice(exactIndex, 1);
      return { field, result: result ?? null };
    }

    const nameMatches = unresolved.filter((result) => result.yName === field.name);
    if (nameMatches.length === 1) {
      const matched = nameMatches[0]!;
      unresolved.splice(unresolved.indexOf(matched), 1);
      return { field, result: matched };
    }

    return { field, result: null };
  });
}

function getGroupIdentity(group: DistributionGroupResult): string {
  return group.groupKey.length === 0 ? "overall" : JSON.stringify(group.groupKey);
}

function shouldAllowLegacyOverallFallback(
  item: DistributionAnalysisDocument,
  result: DistributionReportResponse,
): boolean {
  return item.definition.responses.length === 1
    && result.groups.length > 0
    && result.groups.every((group) => group.yResults.length === 1);
}