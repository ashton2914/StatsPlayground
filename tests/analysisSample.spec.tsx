import { expect, test } from "@playwright/experimental-ct-react";

import {
  createAnalysisSample,
  createAnalysisSampleGraph,
  createAnalysisSampleReport,
} from "../src/components/analysis/analysisSample";
import type { DatasetMeta } from "../src/types/data";
import { ReportViewHarness } from "./reportViewHarness";

test("renders the complete DIM1 sample analysis layout", async ({ mount }) => {
  const createdAt = "2026-09-03T00:00:00.000Z";
  const dataset: DatasetMeta = {
    id: "analysis-sample-table",
    name: "DIM1 Sample",
    sourcePath: null,
    sourceType: "manual",
    rowCount: 200,
    colCount: 1,
    createdAt,
    updatedAt: createdAt,
  };
  const graph = createAnalysisSampleGraph({
    datasetId: dataset.id,
    graphId: "analysis-sample-graph",
    graphName: "DIM1 Distribution",
    createdAt,
  });
  const report = createAnalysisSampleReport({
    reportId: "analysis-sample-report",
    reportName: "DIM1 Analysis",
    graphId: graph.id,
    sample: createAnalysisSample(112, 200),
    createdAt,
  });

  const component = await mount(
    <ReportViewHarness
      initialMarkdown={report.markdown}
      datasets={[dataset]}
      graphs={[graph]}
      graphMode="stub"
    />,
  );
  const preview = component.locator(".sp-report-preview");

  await expect(preview.locator("h1")).toHaveText("DIM1");
  await expect(preview.getByText("Graph:DIM1 Distribution:DIM1 Sample")).toBeVisible();
  await expect(preview.getByText("This sample demonstrates the standard analysis layout.")).toBeVisible();
  await expect(preview.locator("h2")).toHaveText(["Quantiles", "Summary Statistics"]);
  await expect(preview.locator("table")).toHaveCount(2);
  await expect(preview.locator("table").first()).toContainText("Median");
  await expect(preview.locator("table").last()).toContainText("Std Dev");
});