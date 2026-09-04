import { expect, test } from "@playwright/experimental-ct-react";

import { createDistributionItem } from "../../src/components/distribution/distributionConfig";
import * as distributionViewModule from "../../src/components/distribution/DistributionView";
import type { ChartElement } from "../../src/graphCore/types";
import { DISTRIBUTION_GRAPH_ELEMENT_IDS } from "../../src/types/graphData";

import { DistributionViewStory } from "./DistributionViewStory";

const field = { name: "value", type: "continuous" as const };
const currentItem = createDistributionItem({
  id: "distribution-1", name: "Distribution 1", sourceDatasetId: "dataset-1",
  responses: [field], weight: null, frequency: null, by: [],
  columns: [{ name: "value", sqlType: "DOUBLE", integerCompatible: false, field }],
  createdAt: "2026-01-01T00:00:00.000Z",
});

test("builds the four Distribution graphs as embedded GraphRuntime items", () => {
  const graphs = distributionViewModule.materializeDistributionGraphItems(currentItem);

  for (const graph of Object.values(graphs)) {
    expect(graph.sourceDatasetId).toBe("dataset-1");
    expect(graph.mode).toBe("2d");
    expect(graph.modeStates.twoD.encoding.x).toEqual(field);
    expect(graph.sampling).toEqual({ mode: "full" });
  }
});

test("binds backend packet IDs to each graph role", () => {
  const graphs = distributionViewModule.materializeDistributionGraphItems(currentItem);
  const elementIds = (role: keyof typeof graphs) => {
    const ids: Array<string | undefined> = [];
    for (const element of graphs[role].modeStates.twoD.elements as ChartElement[]) {
      ids.push(element.options?.elementId as string | undefined);
    }
    return ids;
  };

  expect(elementIds("overview")).toEqual([
    DISTRIBUTION_GRAPH_ELEMENT_IDS.overviewHistogram,
    DISTRIBUTION_GRAPH_ELEMENT_IDS.overviewFittedCurves,
  ]);
  expect(elementIds("boxPlot")).toEqual([DISTRIBUTION_GRAPH_ELEMENT_IDS.boxPlot]);
  expect(elementIds("ecdf")).toEqual([DISTRIBUTION_GRAPH_ELEMENT_IDS.ecdf]);
  expect(elementIds("normalQuantile")).toEqual([
    DISTRIBUTION_GRAPH_ELEMENT_IDS.normalQuantilePoints,
    DISTRIBUTION_GRAPH_ELEMENT_IDS.normalQuantileReference,
    DISTRIBUTION_GRAPH_ELEMENT_IDS.normalQuantileLower,
    DISTRIBUTION_GRAPH_ELEMENT_IDS.normalQuantileUpper,
  ]);
});

test("renders all four external frames without graph-data streaming", async ({ mount, page }) => {
  await page.evaluate(() => {
    const calls: string[] = [];
    Object.assign(window, {
      __distributionInvokeCalls: calls,
      __TAURI_INTERNALS__: {
        metadata: { currentWindow: { label: "main" } },
        invoke: async (command: string, args: { request?: { datasetId: string; generation: number } } = {}) => {
          calls.push(command);
          if (command === "get_dataset_generation") return 7;
          if (command === "get_columns") return [["value", "DOUBLE"]];
          if (command === "get_column_display_props") return [];
          if (command === "compute_distribution_report") {
            const request = args.request ?? { datasetId: "dataset-1", generation: 7 };
            const frame = (role: string) => ({
              requestId: `distribution:${role}`,
              datasetId: request.datasetId,
              generation: request.generation,
              sourceRows: 0,
              processedRows: 0,
              sampling: { mode: "full" },
              dictionaries: {},
              extents: {},
              rawChunks: [],
              aggregates: [],
              rawPointDisposition: { status: "empty", validRows: 0, budget: 8_000 },
            });
            return {
              datasetId: request.datasetId,
              generation: request.generation,
              groups: [],
              reportBlocks: [],
              graphFrames: {
                overview: frame("overview"),
                boxPlot: frame("boxPlot"),
                ecdf: frame("ecdf"),
                normalQuantile: frame("normalQuantile"),
              },
            };
          }
          throw new Error(`unexpected command: ${command}`);
        },
      },
    });
  });
  const component = await mount(<DistributionViewStory item={currentItem} dataset={{
    id: "dataset-1",
    name: "Dataset 1",
    sourcePath: null,
    sourceType: "manual",
    rowCount: 0,
    colCount: 1,
    generation: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }} />);

  for (const role of ["overview", "boxPlot", "ecdf", "normalQuantile"]) {
    await expect(component.locator(`[data-graph-role="${role}"] canvas`)).toHaveCount(1);
  }
  await expect.poll(() => page.evaluate(() => (
    (window as Window & { __distributionInvokeCalls?: string[] }).__distributionInvokeCalls ?? []
  ))).toContain("compute_distribution_report");
  const calls = await page.evaluate(() => (
    (window as Window & { __distributionInvokeCalls?: string[] }).__distributionInvokeCalls ?? []
  ));
  expect(calls).not.toContain("stream_graph_data");
});
